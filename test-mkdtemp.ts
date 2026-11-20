/**
 * A test source that makes a temp directory has to remove it.
 *
 * `/tmp` here is a tmpfs with about a million inodes, and on 2026-10-07 the
 * suite took it to 99% of them: 112 files call `mkdtemp`, nothing removed what
 * they made, and the loops' gates, the pre-push hook and CI all run on this one
 * host (#271). `test-tmp.global.ts` now bounds the damage to a single run root
 * it deletes, but that only works while every directory lands *inside* it, and
 * a run that makes 46,000 directories before teardown can still exhaust the
 * inodes on its own. So this guard keeps the habit: use `scratchDir` from
 * `test-scratch.ts`, or clean up in the same file.
 *
 * The check is the one #271 asked for and is deliberately textual, not a type
 * or AST analysis: a test source that makes a temp directory and names no
 * removal anywhere in the file is an offence. Comments and string literals are
 * stripped first, so a suite that *writes* a fixture suite as a string — half a
 * dozen here do — is judged on its own code. What it cannot see is a file that
 * removes three of its four directories; `test-tmp.global.ts`'s per-run census
 * is the half of the guard that catches that, by counting what the run actually
 * left. Between them: this one fails a new suite with no cleanup at all, which
 * is what happened, and the census fails one whose cleanup misses enough to
 * matter.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Directories never walked: not ours, or not source vitest runs. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "journal", "logs", ".ralph", "dist"]);

/**
 * What makes a file a test source: a suite, a setup file, a globalSetup module,
 * or a helper those import. #271 names "a test, a setup file or a test helper",
 * and a helper is where a new leak would otherwise hide — `dashboard/fixtures.ts`
 * and `lineup/fixtures.ts` both make temp directories.
 */
const TEST_PATTERNS = [/\.test\.ts$/, /\.setup\.ts$/, /\.global\.ts$/, /(^|\/)fixtures\.ts$/, /(^|\/)test-[^/]+\.ts$/];

/**
 * The guard's own machinery, exempt by name: these are the files that implement
 * `mkdtemp` and its removal, so judging them by a text search over themselves
 * says nothing.
 */
const EXEMPT = new Set(["test-tmp.ts", "test-scratch.ts", "test-mkdtemp.ts"]);

/**
 * Anything that creates a temp directory.
 *
 * `mkdirSync(join(tmpdir(), …))` counts as well as `mkdtemp*`: it is the shape
 * a file reaches for when it wants a predictable name, and the first fix for
 * #271's own setup file used it — which would have left the guard blind to the
 * very file the ticket blames.
 */
const MAKES_TEMP = /\bmkdtemp(Sync)?\s*\(|\bmkdir(Sync)?\s*\(\s*(join\s*\(\s*)?tmpdir\s*\(\s*\)/;

/**
 * Anything that removes one.
 *
 * The list is per file, not per call site: one `scratchDir` import clears a
 * file for every `mkdtemp` in it. `test-tmp.global.ts`'s census is what covers
 * the gap for anything made under the run root; a directory a suite makes
 * somewhere else entirely (`inspect.test.ts` makes one inside the checkout) is
 * watched by `test-ralph-logs.ts` instead.
 *
 * Removals only. An earlier cut of this also accepted a bare `afterAll(` or
 * `onTestFinished(`, on the theory that a file registering a hook is cleaning
 * something up — and that blessed `dashboard/server.test.ts`, which registers
 * an `afterAll` that kills children and leaks three `ralph-dashboard-config-*`
 * directories a run, one of the prefixes in #271's own table. `cleanupFixtures`
 * is not here either, for the same reason: it removes the roots
 * `dashboard/fixtures.ts` registered, never a directory the suite made itself.
 */
const CLEANS_UP = /\b(rmSync|rmdirSync|rimraf|scratchDir|fileScratchDir|removeScratchDir)\b|\brm(dir)?\s*\(/;

/**
 * A fixture helper that registers its directory for `cleanupFixtures` to drain.
 *
 * These make a temp directory as surely as `mkdtemp` does, just at one remove,
 * and nothing drains the list unless the suite says so — which is how nine
 * files came to leave `ralph-<label>-project-*` directories behind for the run,
 * `ralph-triage-apply-project-*` among them, a prefix with 4,381 leftovers in
 * #271's table.
 *
 * Matched on the IMPORT, not the call: `preflight.test.ts` has a local
 * `scratchProject` of its own that cleans up after itself, and a rule keyed on
 * the name alone would fail it for someone else's bug.
 */
const MAKES_FIXTURE = /import\s*\{[^}]*\b(scratchProject|rootWith)\b[^}]*\}\s*from/;

/** What drains that list. */
const DRAINS_FIXTURES = /\bcleanupFixtures\b/;

/** One file's path and contents. */
export interface Source {
  readonly path: string;
  readonly text: string;
}

/** Is `path` a test source this guard judges? */
export function isTestSource(path: string): boolean {
  if (EXEMPT.has(path)) return false;
  return TEST_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * One token of the things the patterns above must not see: a comment, or a
 * string or template literal.
 *
 * Matched in one left-to-right pass, so whichever delimiter OPENS first wins.
 * Stripping each kind in its own pass is what broke the first two cuts of this:
 * a backtick inside a double-quoted string (`dashboard/read-only.test.ts` has
 * one) opened a template that ran to the next real backtick, taking lines of
 * code with it — including, in four files here, the very `rmSync` that clears
 * them. Quoted literals stay within one line; templates genuinely span them.
 */
const LITERAL_OR_COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"/g;

/**
 * `text` with its comments and literals blanked out, so the patterns above see
 * code and nothing else — a suite that WRITES a fixture suite as a string, and
 * half a dozen here do, is judged on its own code.
 *
 * Crude by design: it does not parse. But it only ever removes text, so its
 * failure mode is a missed offence rather than a false one.
 */
export function codeOnly(text: string): string {
  return text.replace(LITERAL_OR_COMMENT, (token) => (token.startsWith("/") ? " " : '""'));
}

/** Every test source under `root`, with its contents, path relative to `root`. */
export function testSources(root: string): Source[] {
  const found: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      const path = relative(root, full);
      if (!entry.isFile() || !isTestSource(path)) continue;
      found.push({ path, text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return found;
}

/** A source that makes a temp directory, and what it failed to do about it. */
export interface Offence {
  readonly path: string;
  readonly reason: "no cleanup" | "no cleanupFixtures";
}

/** The sources that make a temp directory and name no way of removing one. */
export function mkdtempOffences(sources: readonly Source[]): Offence[] {
  const offences: Offence[] = [];
  for (const source of sources) {
    const code = codeOnly(source.text);
    if (MAKES_TEMP.test(code) && !CLEANS_UP.test(code)) {
      offences.push({ path: source.path, reason: "no cleanup" });
    } else if (MAKES_FIXTURE.test(code) && !DRAINS_FIXTURES.test(code)) {
      offences.push({ path: source.path, reason: "no cleanupFixtures" });
    }
  }
  return offences.sort((a, b) => a.path.localeCompare(b.path));
}

/** The failure message for `offences`, naming the fix rather than the rule. */
export function describeOffences(offences: readonly Offence[]): string {
  return [
    `${offences.length} test source(s) make a temp directory and never remove it:`,
    ...offences.map((offence) => `  ${offence.path} (${offence.reason})`),
    "",
    'Use `scratchDir("prefix-")` from ./test-scratch, which removes it when the',
    "test finishes, or remove it yourself in an afterAll/afterEach in the same",
    "file. A suite that calls `scratchProject` or `rootWith` registers its",
    "directory with the fixtures instead, so it needs an `afterAll` that calls",
    "`cleanupFixtures`. Leftovers accumulate across every run on this host and",
    "exhaust /tmp's inodes (#271).",
  ].join("\n");
}
