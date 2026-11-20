/**
 * One temp directory per `bun run test` run, instead of one per test file.
 *
 * On 2026-10-07 `/tmp` (tmpfs, ~1M inodes) reached 99% of its inodes and a
 * pre-push run died with `ENOSPC` (#271). The suite was the source: 112 files
 * call `mkdtemp`, and `test-config-home.setup.ts` leaked one directory per
 * test file — vitest's forks pool gives every file a process of its own — so
 * about 170 per run, across every loop's gate, every pre-push hook and CI, all
 * on this one host. Nothing removed them.
 *
 * The fix is a redirect rather than 113 cleanups. `os.tmpdir()` reads `TMPDIR`
 * on every call, and vitest's forks pool spawns its workers *after*
 * `globalSetup`'s `setup()` returns — so one assignment there moves every
 * `mkdtemp` in the suite, and every child process a test spawns, inside a
 * single run root that `teardown()` removes. `delegate.sh` and `inspect.sh`
 * pass `TMPDIR` through their env allowlists, so even the scrubbed-environment
 * children land inside it — except inside the bubblewrap sandbox, which pins
 * `TMPDIR=/tmp` over a `--tmpfs /tmp` of its own, so nothing escapes from there
 * either.
 *
 * These helpers are pure and import no vitest, so `test-tmp.test.ts` can cover
 * them; `test-tmp.global.ts` is the thin module vitest loads.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The prefix every run root carries. `removeRunRoot` refuses anything else. */
export const RUN_ROOT_PREFIX = "ralph-test-run-";

/**
 * Where the run root goes: `TMPDIR` as the process was started with, before
 * any redirect, or `/tmp`.
 *
 * Deliberately not `os.tmpdir()`: once `setup()` has run, that returns the run
 * root itself, and `teardown()` would then check the root against its own path
 * instead of against its parent. `os.tmpdir()` also honours `TMP` and `TEMP`,
 * which this does not — harmless, because `setup()` assigns `TMPDIR`, and that
 * is the one `os.tmpdir()` prefers.
 */
export function realTmpRoot(env: NodeJS.ProcessEnv): string {
  const raw = env.TMPDIR?.trim();
  if (!raw) return "/tmp";
  // A relative `TMPDIR` would put the run root in the process's cwd — this
  // checkout — and `removeRunRoot`'s parent check would pass while it sat
  // there. `/tmp` is a better answer than a directory in the repository.
  if (!raw.startsWith("/")) return "/tmp";
  // Trailing slashes have to go: `removeRunRoot` compares `dirname(root)` with
  // this, and `/tmp/` would never match. `"/"` and `"//"` trim to nothing, so
  // they fall back to the root directory rather than to "", which would have
  // put the run root in the process's cwd — i.e. in this checkout.
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * The stamp in a run root's name: `20261007T183215`, second-resolution UTC.
 *
 * Only two things read it — a human looking at a stale root, and
 * `reapStaleRoots`, which goes by mtime rather than by this — so it is for
 * legibility, and the pid is what actually keeps two runs apart.
 */
export function runStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

/** The run root's basename. The pid keeps two runs on one host apart. */
export function runRootName(stamp: string, pid: number): string {
  return `${RUN_ROOT_PREFIX}${stamp}-${pid}`;
}

/** Create `<parent>/<name>` (and `parent` if missing); returns the full path. */
export function createRunRoot(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * How many directories one run may leave inside its root before `teardown()`
 * calls it a leak.
 *
 * The root is removed either way, so this is not about the host's inodes after
 * the run — it is about the run itself: 46,044 directories accumulated because
 * nobody noticed a suite making one per file, and a per-run census is the one
 * measurement that notices. It counts only the root's direct children, so the
 * noise from other loops sharing this host — which is what ruled out counting
 * the host's `/tmp` — cannot reach it.
 *
 * Measured: a healthy full run (180 files, 4540 tests) leaves 12. The cap is
 * set so that the failure that actually happened trips it — a suite or setup
 * file leaking one directory per test file lands around 190 — while leaving an
 * order of magnitude of slack for suites that grow.
 */
export const LEAK_CAP = 150;

/** The run root's direct children: what the run left behind for teardown. */
export function leftovers(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/**
 * The census verdict: `null` when the run cleaned up well enough, otherwise the
 * failure to report.
 *
 * It names the prefixes it found, not just a count. A count alone says "217,
 * cap 150" and sends the next person back to re-run with the census on and race
 * the teardown to see what leaked; the prefixes say which suite to look at.
 */
export function leakReport(names: readonly string[], cap = LEAK_CAP): string | null {
  if (names.length <= cap) return null;
  const byPrefix = new Map<string, number>();
  for (const name of names) {
    const prefix = /^(.*?-)[^-]*$/.exec(name)?.[1] ?? name;
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  const worst = [...byPrefix]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([prefix, count]) => `  ${count}\t${prefix}*`);
  return [
    `this run left ${names.length} entries in its temp root (cap ${cap}).`,
    "They were removed with the root, so the host is fine — but a suite is",
    "making temp directories it never cleans up. The commonest were:",
    ...worst,
    'Use `scratchDir("prefix-")` from ./test-scratch, which removes one when the',
    "test finishes (#271).",
  ].join("\n");
}

/**
 * Remove run roots an earlier run abandoned.
 *
 * `teardown()` cannot run when a run is killed — and the incident in #271 was
 * exactly that, a run dying with `ENOSPC`. Without this, one `^C` leaks as much
 * as a whole pre-fix run did, for good. Anything older than `maxAgeMs` is
 * another run's corpse, not a live sibling: a run that takes three hours does
 * not exist here (a full suite is about 160 seconds). Returns what it removed.
 */
export function reapStaleRoots(realTmp: string, now: number, maxAgeMs: number): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(realTmp);
  } catch {
    return [];
  }
  const reaped: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) continue;
    const root = join(realTmp, name);
    try {
      if (now - statSync(root).mtimeMs < maxAgeMs) continue;
      removeRunRoot(root, realTmp);
      reaped.push(root);
    } catch {
      // Another run's root, a permission we do not have, a directory that went
      // away under us: none of that is this run's problem to report.
    }
  }
  return reaped;
}

/**
 * Remove a scratch directory that a child process may still be writing into.
 *
 * A plain recursive `rmSync` lists a directory, unlinks what it saw, then
 * `rmdir`s it; a child that lands one more file in between (a CLI a test
 * spawned, a supervisor still handling its SIGTERM) turns teardown into
 * `ENOTEMPTY`. On a loaded host that child is slow enough to happen (#187), so
 * retry with a short pause instead of failing the suite on its cleanup. The
 * loop is explicit: `rmSync`'s own `maxRetries` did not rescue `ENOTEMPTY`
 * under the Node that runs this suite.
 *
 * It lives here, beside `removeRunRoot`, rather than in `test-scratch.ts`,
 * because it is a plain filesystem retry and must stay free of vitest —
 * `dashboard/fixtures.ts` re-exports it for the callers that have always had it
 * from there, and `dashboard/fixtures-teardown.test.ts` is its suite. `attempts`
 * is named rather than positional so that `.forEach(removeScratchDir)` cannot
 * pass the index as the retry budget, which is how it came to throw on the
 * first `ENOTEMPTY` instead of retrying thirty times.
 */
export function removeScratchDir(dir: string, { attempts = 30 }: { attempts?: number } = {}): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== "ENOTEMPTY" && code !== "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Remove a run root, recursively.
 *
 * This is the suite's only destructive setup call, so it is fenced: `root` has
 * to be a direct child of `realTmp` and its name has to carry
 * {@link RUN_ROOT_PREFIX}. A bug in the caller then deletes nothing — not
 * `/tmp`, not a sibling run's root, not an operator's directory.
 */
export function removeRunRoot(root: string, realTmp: string): void {
  if (dirname(root) !== realTmp) {
    throw new Error(`refusing to remove ${root}: not a direct child of ${realTmp}`);
  }
  if (!basename(root).startsWith(RUN_ROOT_PREFIX)) {
    throw new Error(`refusing to remove ${root}: name does not start with ${RUN_ROOT_PREFIX}`);
  }
  rmSync(root, { recursive: true, force: true });
}
