#!/usr/bin/env bun
/**
 * Entry point for the frontier — `bun "$RALPH_HOME/frontier/next.ts" -- …`,
 * run from inside a project worktree. It runs the HARNESS's frontier tool
 * (pinned to the harness repo's `origin/main`) against the PROJECT the command
 * was launched from: the code comes from RALPH_HOME's git, the cwd — and so
 * every `gh` call and the loop identity — is the project's.
 *
 * `next-tasks.ts` reports on the GitHub issue graph and reads nothing from the
 * working tree, so its answer should not depend on the checkout. It did: the
 * script is a repo file, so a worktree parked on a feature branch ran whatever
 * version that branch was cut from, and silently printed the old tool's answer
 * with no sign that it was stale.
 *
 * So the source is pinned to `origin/main` rather than taken from the checkout.
 * The pin yields in three cases, because a pin that cannot be overridden just
 * moves the staleness onto whoever is improving the tool:
 *   - `--local`, the explicit escape.
 *   - Uncommitted edits to `next-tasks.ts`.
 *   - Commits touching `next-tasks.ts` that `origin/main` does not have — a
 *     branch developing the tool. Committing your work must not be what makes
 *     the launcher start ignoring it. A merely stale branch has no such
 *     commits, since it is behind rather than ahead, so it stays pinned.
 *
 * The pin is only as current as this file: a branch cut before this landed
 * still runs its own `next-tasks.ts`, because its package.json does not point
 * here yet. Nothing can fix that from inside the repo — but this file is a
 * launcher with no reason to change, and the payload beside it is the part
 * that does.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { RALPH_HOME, projectRoot } from "../paths";

const PAYLOAD = "frontier/next-tasks.ts";
const LOCAL_FLAG = "--local";

export type Source = "local" | "pinned";

export interface SourceState {
  /** `--local` was passed. */
  forcedLocal: boolean;
  /** The checkout is working on the payload: uncommitted edits, or commits ahead. */
  developingPayload: boolean;
  /** The `origin/main` copy was successfully read. */
  pinnedAvailable: boolean;
}

/**
 * Which copy to run. Split out because the precedence is the whole contract:
 * an explicit flag wins, then work in progress on the tool, then the pin — and
 * a failed fetch degrades to the checkout rather than to nothing, since a stale
 * frontier is worth more than no frontier when the network is down.
 */
export function chooseSource(state: SourceState): Source {
  if (state.forcedLocal || state.developingPayload) return "local";
  return state.pinnedAvailable ? "pinned" : "local";
}

/**
 * `--local` is consumed here; everything else belongs to the payload. A
 * leading `--` is the separator an operator types (`next.ts -- --dry-run`,
 * as `bun run next -- …` used to need) and is dropped rather than handed to a
 * payload that rejects unknown flags.
 */
export function splitArgs(argv: string[]): { forcedLocal: boolean; rest: string[] } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  return {
    forcedLocal: args.includes(LOCAL_FLAG),
    rest: args.filter((arg) => arg !== LOCAL_FLAG),
  };
}

/** Why the checkout won, phrased for someone who expected the pin. */
export function explain(source: Source, state: SourceState): string | null {
  if (source === "pinned") return null;
  if (state.forcedLocal) return `running the checked-out ${PAYLOAD} (${LOCAL_FLAG})`;
  if (state.developingPayload) {
    return `running the checked-out ${PAYLOAD} (this branch changes it)`;
  }
  return `could not read ${PAYLOAD} from origin/main; running the checked-out copy`;
}

/**
 * A child killed by a signal reports no exit code. Collapsing that to 1 would
 * report an interrupted run as an ordinary failure, so use the shell's
 * convention instead.
 */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

async function git(args: string[], cwd?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function succeeds(args: string[], cwd: string): Promise<boolean> {
  return (await gitOrNull(args, cwd)) !== null;
}

/** git output, or null if the command failed. Every call site here is optional. */
async function gitOrNull(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Is this checkout working on the payload? Pure, because this is the judgement
 * the launcher exists to make and the git plumbing around it is not testable.
 *
 * Identical content short-circuits: after a squash merge the branch keeps its
 * own commit forever, so `origin/main..HEAD` never empties and a history-only
 * test would strand that branch on its local copy for good. If the two files
 * agree there is nothing to protect either way.
 */
export function isDeveloping(state: {
  identical: boolean;
  dirty: boolean;
  aheadCommits: boolean;
}): boolean {
  if (state.identical) return false;
  return state.dirty || state.aheadCommits;
}

/**
 * The three observations `isDeveloping` needs. A failure of the ahead-check is
 * read as "ahead": it means origin/main is unreadable as a revision, and
 * running main's copy over work we cannot rule out is the worse mistake.
 */
async function observe(root: string, pinnedSource: string): Promise<{
  identical: boolean;
  dirty: boolean;
  aheadCommits: boolean;
}> {
  const localSource = await readFile(join(root, PAYLOAD), "utf8").catch(() => null);
  // `--quiet` exits non-zero on a difference; HEAD covers staged and unstaged.
  const dirty = !(await succeeds(["diff", "--quiet", "HEAD", "--", PAYLOAD], root));
  const ahead = await gitOrNull(["log", "--oneline", "origin/main..HEAD", "--", PAYLOAD], root);
  return {
    identical: localSource === pinnedSource,
    dirty,
    aheadCommits: ahead === null ? true : ahead.trim() !== "",
  };
}

/**
 * Every repo-relative module a source file imports.
 *
 * Matched rather than parsed, because the only thing needed here is which
 * files to fetch, and the shapes that carry one are few: `from "…"` covers
 * `import`/`export … from`, and the other two are a bare side-effect
 * `import "…"` and a dynamic `import("…")`. Bare specifiers are skipped —
 * `node:` builtins need nothing, and a package would need `node_modules`,
 * which is the limit noted on `materialise`.
 */
export function relativeImports(source: string): string[] {
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  const found = new Set<string>();
  for (const match of source.matchAll(specifier)) {
    const value = match[1];
    if (value !== undefined && value.startsWith(".")) found.add(value);
  }
  return [...found];
}

/**
 * A relative specifier resolved to the repo paths it could name, in the order
 * TypeScript would try them.
 *
 * Extensionless is the normal case in this repo (`../claim-lease`), and
 * the candidate list is what turns that back into a file git can be asked for.
 * Posix throughout: these are git paths, not filesystem paths.
 */
export function candidatePaths(importer: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base];
}

/**
 * The `origin/main` copy written somewhere bun can execute it — with the
 * modules it imports, at the paths it imports them by.
 *
 * The payload used to be written alone, as a flat `next-tasks.ts`, which held
 * for exactly as long as it imported nothing but `node:` builtins. #708 gave
 * it `../ralph/claim-lease`, and `bun run next` began failing with
 * `Cannot find module '../ralph/claim-lease'` — main's copy could not run at
 * all, while `--local` kept working, so the launcher looked fine from any
 * branch somebody was developing on.
 *
 * So the closure is walked and written at repo-relative paths, which is what
 * makes `../ralph/…` mean the same thing in the temp tree as in the checkout.
 * Every file comes from `origin/main` too: mixing a pinned payload with the
 * checkout's dependencies would reintroduce, one layer down, exactly the
 * staleness this launcher exists to remove.
 *
 * Bare package imports are still out of reach — the tree has no
 * `node_modules` above it — and the payload has none: it reports on the GitHub
 * issue graph through `gh` and node builtins. One appearing would fail loudly
 * here, in the same way this did.
 */
export async function materialise(
  source: string,
  read: (path: string) => Promise<string | null>,
): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ralph-next-"));
  const written = new Set<string>();

  const write = async (repoPath: string, contents: string): Promise<void> => {
    const target = join(dir, repoPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    // Marked written BEFORE recursing, which is what makes two modules that
    // import each other terminate rather than recurse until the stack gives
    // out. Marked after, the cycle never sees itself.
    written.add(repoPath);
    for (const specifier of relativeImports(contents)) {
      for (const candidate of candidatePaths(repoPath, specifier)) {
        // Both `break`s end the search for THIS specifier, and both mean the
        // same thing: it is resolved. Candidate order is fixed, so a candidate
        // already written is necessarily the same module some earlier importer
        // reached first — a diamond fetches its shared dependency once, not
        // once per importer.
        if (written.has(candidate)) break;
        const dependency = await read(candidate);
        if (dependency !== null) {
          await write(candidate, dependency);
          break;
        }
      }
    }
  };

  await write(PAYLOAD, source);
  return { dir, file: join(dir, PAYLOAD) };
}

function run(file: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    // The project is the cwd AND the environment's RALPH_PROJECT, so a pinned
    // payload running out of a temp directory still resolves the project (and
    // its `.ralph/loop-name` and config) rather than the temp tree.
    const child = spawn("bun", [file, ...args], {
      cwd,
      stdio: "inherit",
      // RALPH_HOME too: the payload finds the harness's `jav.json` through it,
      // since a pinned copy's own location is a temp directory.
      env: { ...process.env, RALPH_PROJECT: cwd, RALPH_HOME: process.env.RALPH_HOME?.trim() || RALPH_HOME },
    });
    child.on("close", (code, signal) => resolve(exitCodeFor(code, signal)));
  });
}

async function main(): Promise<void> {
  const { forcedLocal, rest } = splitArgs(process.argv.slice(2));
  // The pin is the harness's own history; the project is only where it runs.
  const root = RALPH_HOME;
  const project = projectRoot();

  // Best effort: an unreachable remote leaves the previous origin/main in
  // place, which is still closer to current than an arbitrary branch.
  if (!forcedLocal) await succeeds(["fetch", "--quiet", "origin", "main"], root);
  // Unreadable is its own state, not "developing": conflating them told the
  // user their branch edits the tool when the network was simply down.
  const pinnedSource = forcedLocal
    ? null
    : await gitOrNull(["show", `origin/main:${PAYLOAD}`], root);

  const developing =
    pinnedSource === null ? false : isDeveloping(await observe(root, pinnedSource));
  const pinned =
    pinnedSource === null || developing
      ? null
      : await materialise(pinnedSource, (path) => gitOrNull(["show", `origin/main:${path}`], root));

  const state: SourceState = {
    forcedLocal,
    developingPayload: developing,
    pinnedAvailable: pinnedSource !== null,
  };
  const source = chooseSource(state);

  const note = explain(source, state);
  if (note !== null) console.error(`\x1b[2m${note}\x1b[0m`);

  const target = source === "pinned" && pinned !== null ? pinned.file : join(root, PAYLOAD);
  try {
    process.exitCode = await run(target, rest, project);
  } finally {
    // The temp copy is disposable; leaving it behind on a crash or a Ctrl-C
    // would litter tmp with one directory per interrupted run.
    if (pinned !== null) await rm(pinned.dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // With git missing, a raw rejection would print a
    // stack trace for what is a one-line problem.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
