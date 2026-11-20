#!/usr/bin/env bun
/**
 * The ci-doctor's diff guard: refuses a diff that buys green by weakening a
 * test, and refuses one that edits CI configuration at all.
 *
 * The doctor's remit is narrow on purpose. It may make a flaky test reliable
 * and a slow test fast; it may not make a failing test stop asserting, stop
 * running, or wait longer until the flake hides. Those three moves all turn a
 * red build green without fixing anything, and the second one — an edit to the
 * pipeline rather than to the test — removes the signal for every branch at
 * once. A sentence in the doctor's prompt is not enough: the executor guard
 * exists because `rafa #1108` ran the command its brief forbade (see
 * `guard.ts`), and the same reasoning applies here.
 *
 * The rules are the project's, read from `ciDoctor.fixScope` and
 * `ciDoctor.neverTouch`; the defaults below are loggd's. A refusal is a
 * finding, in this repo's validator shape: an array of problem strings, empty
 * means the diff may land (`triage/validate.ts`, `project-config.ts`).
 *
 * This file lives beside `guard.ts` and is under the same rule: it is mounted
 * into the executor's sandbox, so it imports nothing from the rest of the
 * harness and touches neither the filesystem nor `git`. Everything it needs —
 * the diff text, the config, the revert to compare against — is passed in.
 *
 * felipearos/ralph#152
 */

/** One line of a hunk, in the diff's own three-way vocabulary. */
export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

/** One `@@` hunk. `newStart` is the first line number on the new side. */
export interface DiffHunk {
  newStart: number;
  oldStart: number;
  lines: DiffLine[];
}

/** One file's changes. `path` is the new path, or the old one for a deletion. */
export interface DiffFile {
  path: string;
  oldPath: string;
  hunks: DiffHunk[];
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  /** `old mode`/`new mode` and the binary payload: not hunks, but changes. */
  metadata: string[];
}

/** Which paths the doctor may edit, and which it may never edit. */
export interface DiffGuardConfig {
  fixScope: string[];
  neverTouch: string[];
  /** The hard ceiling for one test's timeout, whatever the evidence says. */
  testTimeoutCeilingMs: number;
  /** The hard ceiling for one hook's timeout. */
  hookTimeoutCeilingMs: number;
}

/** loggd's fix scope, from felipearos/ralph#152. */
export const DEFAULT_FIX_SCOPE: readonly string[] = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/__tests__/**",
  "src/test/**",
];

/** Paths no diff may touch, revert or not: the CI's own configuration. */
export const DEFAULT_NEVER_TOUCH: readonly string[] = [
  ".buildkite/**",
  ".mergify.yml",
  ".github/**",
  ".ralph/**",
  "scripts/buildkite-*",
];

/** How far above the measured worst case a new bound may sit. */
export const TIMEOUT_EVIDENCE_FACTOR = 3;
/** The ceiling for one test, whatever the evidence says. */
export const DEFAULT_TEST_TIMEOUT_CEILING_MS = 30_000;
/** The ceiling for one hook: a whole-tree walk legitimately costs more. */
export const DEFAULT_HOOK_TIMEOUT_CEILING_MS = 120_000;

export const DEFAULT_DIFF_GUARD_CONFIG: DiffGuardConfig = {
  fixScope: [...DEFAULT_FIX_SCOPE],
  neverTouch: [...DEFAULT_NEVER_TOUCH],
  testTimeoutCeilingMs: DEFAULT_TEST_TIMEOUT_CEILING_MS,
  hookTimeoutCeilingMs: DEFAULT_HOOK_TIMEOUT_CEILING_MS,
};

/** Strips the `a/` or `b/` git adds, and the quoting it adds for odd names. */
function stripPrefix(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"') && path.length > 1) path = path.slice(1, -1);
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

/**
 * The files a unified diff changes. Anything before the first `diff --git` is
 * ignored, so `git show`'s commit message and `git format-patch`'s headers
 * both parse.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const close = (): void => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the trailing newline, not an empty context line
  for (const line of lines) {
    const header = /^diff --git (.+?) (\S+)$/.exec(line);
    if (header) {
      close();
      const path = stripPrefix(header[2] ?? "");
      file = { path, oldPath: stripPrefix(header[1] ?? ""), hunks: [], added: false, deleted: false, renamed: false, binary: false, metadata: [] };
      continue;
    }
    if (!file) continue;

    if (line.startsWith("rename from ")) {
      file.oldPath = stripPrefix(line.slice("rename from ".length));
      file.renamed = true;
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = stripPrefix(line.slice("rename to ".length));
      file.renamed = true;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      file.metadata.push(line);
      continue;
    }
    if (/^(old|new) mode /.test(line)) {
      file.metadata.push(line);
      continue;
    }
    // A binary payload's base85 body, so two different ones cannot share a
    // signature and smuggle a replacement into an otherwise-genuine revert.
    if (file.binary && hunk === null && line.trim() !== "" && !line.startsWith("diff ") && !line.startsWith("index ")) {
      file.metadata.push(line);
      continue;
    }
    // Only before the first `@@` of this file entry. Inside a hunk, a line
    // beginning `--- ` or `+++ ` is CONTENT — a removed SQL comment, or a
    // nested diff — and reading it as a header both rewrites the path and
    // drops the rest of the hunk, which is a way through the guard.
    if (hunk === null && line.startsWith("--- ")) {
      const old = stripPrefix(line.slice(4));
      if (old === "/dev/null") file.added = true;
      else file.oldPath = old;
      continue;
    }
    if (hunk === null && line.startsWith("+++ ")) {
      const now = stripPrefix(line.slice(4));
      if (now === "/dev/null") file.deleted = true;
      else file.path = now;
      continue;
    }

    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      hunk = { oldStart: Number(at[1]), newStart: Number(at[2]), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    const kind = line[0];
    if (kind === "+" || kind === "-" || kind === " ") hunk.lines.push({ kind, text: line.slice(1) });
    else if (line === "") hunk.lines.push({ kind: " ", text: "" });
    else hunk = null; // anything else ends the hunk (trailing `--` of a mail patch, etc.)
  }
  close();

  // A deletion's `path` is `/dev/null`; the file it deletes is the old one.
  for (const entry of files) if (entry.deleted) entry.path = entry.oldPath;
  return files;
}

/**
 * A glob as a RegExp, compiled segment by segment.
 *
 * `*` matches within one path segment; `**` spans any number of them. A
 * trailing `/**` also matches the bare directory, so `.buildkite/**` refuses
 * the directory itself and not only what is under it.
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      if (!last) {
        source += "(?:[^/]*/)*";
        return;
      }
      source = source.endsWith("/") ? source.slice(0, -1) : source;
      source += source === "" ? ".*" : "(?:/.*)?";
      return;
    }
    source += segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`);
}

const globCache = new Map<string, RegExp>();

/** Whether `path` (repo-relative, `/`-separated) matches `pattern`. */
export function matchesGlob(pattern: string, path: string): boolean {
  let compiled = globCache.get(pattern);
  if (!compiled) {
    compiled = globToRegExp(pattern);
    globCache.set(pattern, compiled);
  }
  return compiled.test(path);
}

const matchesAny = (patterns: readonly string[], path: string): boolean =>
  patterns.some((pattern) => matchesGlob(pattern, path));

/** Every distinct path a file entry touches: a rename touches two. */
function pathsOf(file: DiffFile): string[] {
  const paths = [file.path];
  if (file.oldPath && file.oldPath !== file.path && file.oldPath !== "/dev/null") paths.push(file.oldPath);
  return paths;
}

/**
 * Where the diff is allowed to be at all.
 *
 * `exactRevert` is the auto-revert path's exception: a diff byte-identical to
 * `git revert <culprit>` on the same base may leave the fix scope, because it
 * is not the doctor's own writing. It buys nothing against `neverTouch`, which
 * is refused either way — a revert of a pipeline change is still a pipeline
 * change, and the doctor is not the one to make it.
 */
export function scopeProblems(
  files: readonly DiffFile[],
  config: DiffGuardConfig,
  options: { exactRevert: boolean },
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const path of pathsOf(file)) {
      if (matchesAny(config.neverTouch, path)) {
        problems.push(`${path}: CI configuration is never the doctor's to edit (matches neverTouch).`);
        continue;
      }
      if (options.exactRevert) continue;
      if (!matchesAny(config.fixScope, path)) {
        problems.push(`${path}: outside the doctor's fix scope (${config.fixScope.join(", ")}).`);
      }
    }
  }
  return problems;
}

/**
 * Everything that is code on a line: comments removed.
 *
 * A continuation line of a block comment is blanked, but a line that CLOSES
 * one is not: the code after the closing marker still runs, and blanking
 * every line opening with an asterisk made that a cloak the other rules went
 * blind on.
 */
function code(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*")) return "";
  if (/^\*(?![/])/.test(trimmed)) return "";
  // Find the comment in a copy with the strings masked out, then cut the
  // ORIGINAL there. `it("GET http://x", …, 600000)` is not a commented line,
  // and treating it as one hid the bound at the end of it.
  const masked = maskStrings(text);
  const block = masked.indexOf("*/");
  const head = block === -1 ? text : text.slice(block + 2);
  const maskedHead = block === -1 ? masked : masked.slice(block + 2);
  const line = maskedHead.indexOf("//");
  return (line === -1 ? head : head.slice(0, line)).replace(/\/\*.*?\*\//g, " ");
}

/** The same text with every string literal's contents blanked, length kept. */
function maskStrings(text: string): string {
  return text
    .replace(/"(?:[^"\\]|\\.)*"/g, (match) => `"${" ".repeat(Math.max(0, match.length - 2))}"`)
    .replace(/'(?:[^'\\]|\\.)*'/g, (match) => `'${" ".repeat(Math.max(0, match.length - 2))}'`)
    .replace(/`(?:[^`\\]|\\.)*`/g, (match) => `\`${" ".repeat(Math.max(0, match.length - 2))}\``);
}

/**
 * The same, with string literals blanked.
 *
 * What a line SAYS about `.only` is not what it does: a hint string reading
 * "pass it.only to focus" is not a weakener, and counting it refuses correct
 * code. Used for the token scans; the `exclude` reader needs the strings and
 * reads `code` instead.
 */
function codeWithoutStrings(text: string): string {
  return maskStrings(code(text));
}

const sideOf = (hunks: readonly DiffHunk[], side: "+" | "-", read: (text: string) => string = codeWithoutStrings): string[] =>
  hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === side).map((line) => read(line.text)));
const added = (file: DiffFile): string[] => sideOf(file.hunks, "+");
const removed = (file: DiffFile): string[] => sideOf(file.hunks, "-");

const occurrences = (lines: readonly string[], pattern: RegExp): number =>
  lines.reduce((total, line) => total + (line.match(pattern)?.length ?? 0), 0);

/**
 * The ways a test stops testing without anyone deleting it.
 *
 * Each is counted net — added occurrences less removed ones — so moving a line
 * or reindenting a block is not a refusal, and only a diff that leaves more of
 * them behind than it found is.
 */
const WEAKENERS: readonly { label: string; pattern: RegExp }[] = [
  { label: "`.skip`", pattern: /\.skip\b/g },
  { label: "`.only`", pattern: /\.only\b/g },
  { label: "`.todo`", pattern: /\.todo\b/g },
  { label: "`.fails`", pattern: /\.fails\b/g },
  { label: "`.fixme`", pattern: /\.fixme\b/g },
  { label: "`skipIf`", pattern: /\bskipIf\b/g },
  { label: "`runIf`", pattern: /\brunIf\b/g },
  { label: "`xit`", pattern: /(^|[^.\w])xit\s*\(/g },
  { label: "`xdescribe`", pattern: /(^|[^.\w])xdescribe\s*\(/g },
  { label: "a retry count", pattern: /\bretr(?:y\s*:|ies\s*[:=(])/g },
];

/** An assertion call, however it is spelled. */
const ASSERTION = /(^|[^.\w])(expect|assert)\s*[(.]/g;
/** A test declaration: `it(`, `test(`, `it.each(`, and so on. */
const DECLARATION = /(^|[^.\w])(it|test)\s*(?:\.[A-Za-z$_][\w$]*)*\s*[(`]/g;

/** Whether this file configures a test runner, where `exclude` hides a suite. */
export function isTestConfig(path: string): boolean {
  return /(^|\/)(vitest|jest|playwright|vite)\.config\.[cm]?[jt]s$/.test(path);
}

/** A coverage threshold: the number a config drops to stop failing on coverage. */
const COVERAGE_THRESHOLD = /["']?\b(thresholds?|lines|functions|branches|statements)\b["']?\s*:\s*(-?[\d.]+)/g;

/**
 * The thresholds one side of a diff sets, keyed by name AND by which
 * occurrence of that name it is.
 *
 * A config commonly sets `lines:` twice — once globally and once per file —
 * and keying by the bare name let the second one overwrite the first, so
 * lowering one while leaving the other alone read as no change at all.
 */
function thresholdsIn(lines: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const line of lines) {
    for (const match of line.matchAll(COVERAGE_THRESHOLD)) {
      const name = match[1] as string;
      const value = Number(match[2]);
      if (!Number.isFinite(value)) continue;
      const nth = (seen.get(name) ?? 0) + 1;
      seen.set(name, nth);
      found.set(`${name}#${nth}`, value);
    }
  }
  return found;
}

/** `lines#2` reads as `lines` in a finding. */
const thresholdName = (key: string): string => key.split("#")[0] as string;

/**
 * Every way this diff makes a test assert less than it did.
 *
 * The doctor may make a flaky test reliable and a slow test fast. Each rule
 * here is a way to make a red build green while the thing the test was
 * watching stays broken: switching the test off, deleting its assertions,
 * deleting the test, excluding its file, or lowering the bar it has to clear.
 */
export function weakeningProblems(files: readonly DiffFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const plus = added(file);
    const minus = removed(file);

    // Per hunk, not per file: removing `.skip` from one test and adding it to
    // another in the same file nets to zero, and that is the move this rule
    // exists to catch. Net within the hunk still forgives a moved or
    // reindented line, which is all the net count was for.
    for (const { label, pattern } of WEAKENERS) {
      const net = file.hunks.reduce(
        (total, hunk) =>
          total + Math.max(0, occurrences(sideOf([hunk], "+"), pattern) - occurrences(sideOf([hunk], "-"), pattern)),
        0,
      );
      if (net > 0) {
        problems.push(`${file.path}: adds ${label} (${net} more than it removes, within one hunk) — a test that does not run is not a fix.`);
      }
    }

    const assertionsLost = occurrences(minus, ASSERTION) - occurrences(plus, ASSERTION);
    if (assertionsLost > 0) {
      problems.push(`${file.path}: deletes ${assertionsLost} assertion${assertionsLost === 1 ? "" : "s"} without replacing them.`);
    }

    const testsLost = occurrences(minus, DECLARATION) - occurrences(plus, DECLARATION);
    if (testsLost > 0) {
      problems.push(`${file.path}: deletes ${testsLost} test${testsLost === 1 ? "" : "s"} — the doctor fixes tests, it does not remove them.`);
    }
    if (file.deleted && /\.(test|spec)\.[jt]sx?$/.test(file.path)) {
      problems.push(`${file.path}: deletes a test file — the doctor fixes tests, it does not remove them.`);
    }

    if (!isTestConfig(file.path)) continue;
    if (excludesAdded(file) > 0) problems.push(`${file.path}: adds an \`exclude\` entry, which stops a suite running rather than fixing it.`);
    // Lowering the number is the ordinary way to drop a threshold; deleting
    // the line is the rarer one. Both are the same move. Read with the
    // strings intact, because a quoted key (`"lines": 90`) is still a key.
    const before = thresholdsIn(sideOf(file.hunks, "-", code));
    const after = thresholdsIn(sideOf(file.hunks, "+", code));
    for (const [name, was] of before) {
      const now = after.get(name);
      if (now === undefined) problems.push(`${file.path}: deletes the \`${thresholdName(name)}\` coverage threshold.`);
      else if (now < was) {
        problems.push(`${file.path}: drops the \`${thresholdName(name)}\` coverage threshold from ${was} to ${now}.`);
      }
    }
  }
  return problems;
}

/**
 * How many `exclude` entries the diff adds, net.
 *
 * An entry is either the key itself (`exclude: [...]`) or a bare string added
 * inside an `exclude` block already in the file — which is why this reads each
 * hunk in order and remembers whether the lines it is walking sit under one.
 */
function excludesAdded(file: DiffFile): number {
  let net = 0;
  for (const hunk of file.hunks) {
    let inExclude = false;
    for (const line of hunk.lines) {
      const text = code(line.text);
      if (/\bexclude\s*:/.test(text)) {
        inExclude = !/\]/.test(text.slice(text.indexOf("exclude")));
        net += line.kind === "+" ? 1 : line.kind === "-" ? -1 : 0;
        continue;
      }
      if (!inExclude) continue;
      if (/^\s*["'`]/.test(text)) net += line.kind === "+" ? 1 : line.kind === "-" ? -1 : 0;
      if (/\]/.test(text)) inExclude = false;
    }
  }
  return net;
}

/**
 * The measurement that buys a raised timeout, read from the PR body.
 *
 * A bound may only be raised on evidence, because the number on its own says
 * nothing: 60 s on a test that takes 400 ms in CI is a flake being waited out,
 * and 20 s on one that takes 12 s is a hang being bounded.
 */
export interface TimeoutEvidence {
  /** The worst duration this test or file was observed to take in CI, in ms. */
  worstCiMs: number;
  /**
   * The same, measured locally, in ms.
   *
   * It does not set the bound — the CI time does — but it is required, and
   * it is reported in the refusal, because it is what separates a slow test
   * from a starved host. A local time near the CI one says the test really
   * is that slow; one far below it says the CI host was busy, and the fix is
   * not a bigger number.
   */
  localMs: number;
}

/** A bound found on a line, and whether it bounds a test or a hook. */
interface Timeout {
  /** null when the bound is an expression this guard cannot evaluate. */
  ms: number | null;
  kind: "test" | "hook";
  text: string;
  source: string;
}

const HOOK_OPENER = /\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/;
const TEST_OPENER = /(^|[^.\w])(?:it|test|describe)\s*(?:\.[A-Za-z$_][\w$]*)*\s*[(`]/;
/**
 * A bound passed as the last argument of a call whose callback this line
 * CLOSES: `}, 120_000);`, `});`-style indentation included.
 *
 * The close is what makes it a bound. Matching any line that ends `, <n>)`
 * read `rows.slice(0, 10)` and `toBeCloseTo(0.1, 5)` as timeouts and refused
 * correct code; it also missed nothing, because a test's bound is always the
 * argument after its callback.
 */
const CLOSING_BOUND = /^\s*\}\s*\)?\s*,\s*(.+?)\s*\)\s*;?\s*$/;
/** The same bound on a one-line test: `it("x", () => {}, 5000);`. */
const INLINE_BOUND = /,\s*([^,()]+?)\s*\)\s*;?\s*$/;
/**
 * A bound on a line of its own, which is how prettier formats a long test
 * name: the arguments break, and the number ends up between the callback's
 * `},` and the call's `);`.
 */
const LONE_BOUND = /^\s*(\d[\d_]*|[A-Za-z$_][\w$]*)\s*,?\s*$/;
/** The line that closes the call, which is what makes a lone number a bound. */
const CALL_CLOSE = /^\s*\)\s*;?\s*$/;
/** A bound set by name in a config or an options object. */
const NAMED_BOUND = /\b(testTimeout|hookTimeout|timeout)\s*:\s*(\d[\d_]*)/g;

const numberOf = (literal: string): number | null => {
  const value = Number(literal.replace(/_/g, ""));
  return Number.isFinite(value) ? value : null;
};

/** `const WALK_TIMEOUT = 120_000;` — #1728 names its bound rather than inlining it. */
function constants(file: DiffFile): Map<string, number> {
  const known = new Map<string, number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "-") continue;
      const match = /\b(?:const|let|var)\s+([A-Za-z$_][\w$]*)\s*=\s*(\d[\d_]*)\s*;?\s*$/.exec(code(line.text));
      const value = match ? numberOf(match[2] ?? "") : null;
      if (match && value !== null) known.set(match[1] as string, value);
    }
  }
  return known;
}

/**
 * Whether an expression in the bound position could be a duration at all.
 *
 * The argument after a callback is not always a bound: `useEffect(fn, [])`'s
 * dependency array, vitest's `{ timeout: 5000 }` options object and the
 * fragment a nested `setTimeout(fn, 50)` leaves behind all sit there. None of
 * them is a number the guard should demand, and refusing them refused
 * ordinary test code — a `setTimeout` inside a promise is the commonest shape
 * in the flake fixes this guard exists to let through.
 */
function couldBeBound(expression: string): boolean {
  const trimmed = expression.trim();
  if (trimmed === "" || /[{}[\]:,]/.test(trimmed)) return false;
  if (!/^[\w$.\s*+()-]+$/.test(trimmed)) return false;
  let depth = 0;
  for (const char of trimmed) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The milliseconds an expression denotes, or null when this guard cannot say.
 *
 * Null is not "no bound" — it is "a bound I cannot check", which the caller
 * refuses. An imported `HUGE` reaches a ceiling the guard would otherwise
 * never see, and failing open on exactly the expression worth checking is the
 * wrong default. Products and sums of literals ARE evaluated, because
 * `60 * 1000 * 10` is how a long bound is usually written and naming the real
 * number in the refusal beats asking the author to restate it.
 */
function evaluateBound(expression: string, known: Map<string, number>): number | null {
  const trimmed = expression.trim();
  if (/^\d[\d_]*$/.test(trimmed)) return numberOf(trimmed);
  if (/^[A-Za-z$_][\w$]*$/.test(trimmed)) return known.get(trimmed) ?? null;
  if (/^[\d_\s*+]+$/.test(trimmed)) {
    const sum = trimmed.split("+").reduce((total, term) => {
      const product = term.split("*").reduce((carry, factor) => {
        const value = numberOf(factor.trim());
        return carry === null || value === null ? null : carry * value;
      }, 1 as number | null);
      return total === null || product === null ? null : total + product;
    }, 0 as number | null);
    return sum;
  }
  return null;
}

const indentOf = (text: string): number => /^[ \t]*/.exec(text)?.[0].length ?? 0;

/**
 * Which call a bound on `index` closes: a test, a hook, or something nested.
 *
 * A bound written as `}, 120_000)` is lines away from the call it closes, so
 * the nearest opener above it in the same hunk decides — which is why the
 * hunk's context lines are read and not only what the diff adds.
 *
 * Indentation settles the hard case. A `debounce(fn, 100)` or a `setTimeout`
 * inside a test body closes DEEPER than the test does, and reading its second
 * argument as the test's timeout refused the commonest shape in a flake fix.
 * So when an opener is visible and sits at a different indent, this line
 * closes something else and carries no bound ("other").
 *
 * When no opener is visible at all — the test's own `}, 120_000);` often
 * lands in a later hunk than its `it(`, as it does three times in loggd
 * #1728 — the bound is still judged, as a test's. Missing a real raise is
 * worse than judging one whose kind had to be assumed, and "test" is the
 * stricter of the two ceilings.
 */
function kindAt(lines: readonly DiffLine[], index: number): "test" | "hook" | "other" {
  const indent = indentOf(lines[index]?.text ?? "");
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = code(lines[at]?.text ?? "");
    const hook = HOOK_OPENER.test(text);
    if (!hook && !TEST_OPENER.test(text)) continue;
    if (indentOf(lines[at]?.text ?? "") !== indent) return "other";
    return hook ? "hook" : "test";
  }
  return "test";
}

/**
 * The line that closes the call this one is the last argument of, or -1.
 *
 * What turns a lone number into a bound rather than an array element: the
 * very next thing is the call's own `)`.
 */
function closesTheCall(lines: readonly DiffLine[], index: number): number {
  for (let at = index + 1; at < lines.length; at += 1) {
    const text = code(lines[at]?.text ?? "");
    if (text.trim() === "") continue;
    return CALL_CLOSE.test(text) ? at : -1;
  }
  return -1;
}

/** Every bound the lines of one hunk carry, on the side `side` selects. */
function boundsIn(hunk: DiffHunk, side: "+" | "-", known: Map<string, number>): Timeout[] {
  const found: Timeout[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.kind !== side) return;
    const text = code(line.text);

    const opener = HOOK_OPENER.test(text) || TEST_OPENER.test(text);
    const closing = CLOSING_BOUND.exec(text);
    const inline = opener ? INLINE_BOUND.exec(text) : null;
    const closeAt = closesTheCall(hunk.lines, index);
    const lone = closeAt === -1 ? null : LONE_BOUND.exec(text);
    const expression = closing?.[1] ?? inline?.[1] ?? lone?.[1];
    if (expression !== undefined && couldBeBound(expression)) {
      // An inline bound sits on the opener's own line, so it needs no search.
      // A lone bound is indented one level inside the call, so the line that
      // CLOSES the call is what shares the opener's indent, not this one.
      const kind =
        inline && !closing
          ? HOOK_OPENER.test(text)
            ? "hook"
            : "test"
          : kindAt(hunk.lines, lone && !closing ? closeAt : index);
      if (kind !== "other") {
        found.push({ ms: evaluateBound(expression, known), kind, text: text.trim(), source: expression.trim() });
      }
    }

    for (const named of text.matchAll(NAMED_BOUND)) {
      const ms = numberOf(named[2] ?? "");
      if (ms !== null) {
        found.push({ ms, kind: named[1] === "hookTimeout" ? "hook" : "test", text: text.trim(), source: named[2] ?? "" });
      }
    }
  });
  return found;
}

const ceilingOf = (kind: "test" | "hook", config: DiffGuardConfig): number =>
  kind === "hook" ? config.hookTimeoutCeilingMs : config.testTimeoutCeilingMs;

/**
 * Every timeout this diff raises further than its evidence allows.
 *
 * A raise is the one weakening move with a legitimate use — a whole-tree walk
 * needs more than the 5 s default, and bounding a hang is not hiding one — so
 * it is permitted rather than refused, on three conditions: the PR body
 * carries the measured CI and local times, the new bound is at most
 * `TIMEOUT_EVIDENCE_FACTOR`× the worst observed CI duration, and it stays
 * under the ceiling for its kind whatever the measurement says.
 *
 * Only the last of the three is a hard control. The doctor writes the PR
 * body, so the evidence is self-attested and the 3x rule binds only an
 * honest one; what it really buys is that a raise cannot be silent — the
 * number has to be written down, where a human reviewing the PR can see it
 * next to the bound it justifies. The ceiling is what binds a dishonest one.
 */
export function timeoutProblems(
  files: readonly DiffFile[],
  config: DiffGuardConfig,
  evidence: TimeoutEvidence | null,
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const known = constants(file);
    for (const hunk of file.hunks) {
      const before = boundsIn(hunk, "-", known);
      for (const bound of boundsIn(hunk, "+", known)) {
        const where = `${file.path}: \`${bound.text}\``;
        if (bound.ms === null) {
          // Unchanged: the same expression is on the minus side of this hunk,
          // so the diff only moved or reindented it. Refusing that would
          // refuse a reformat.
          if (before.some((old) => old.source === bound.source)) continue;
          problems.push(`${where} bounds a ${bound.kind} with \`${bound.source}\`, which is not a literal this guard can check — write the number.`);
          continue;
        }
        const previous = before
          .filter((old) => old.kind === bound.kind && old.ms !== null)
          .reduce<number | null>((worst, old) => (worst === null || (old.ms as number) > worst ? (old.ms as number) : worst), null);
        if (previous !== null && bound.ms <= previous) continue;

        const ceiling = ceilingOf(bound.kind, config);
        if (bound.ms > ceiling) {
          problems.push(`${where} raises a ${bound.kind} bound to ${bound.ms}ms, over the ${ceiling}ms ceiling for a ${bound.kind}.`);
          continue;
        }
        if (evidence === null) {
          problems.push(`${where} raises a ${bound.kind} bound to ${bound.ms}ms with no measured evidence — put the CI and local times in the PR body.`);
          continue;
        }
        const allowed = TIMEOUT_EVIDENCE_FACTOR * evidence.worstCiMs;
        if (bound.ms > allowed) {
          problems.push(
            `${where} raises a ${bound.kind} bound to ${bound.ms}ms, over ${TIMEOUT_EVIDENCE_FACTOR}× the worst observed CI duration (${evidence.worstCiMs}ms in CI, ${evidence.localMs}ms locally → at most ${allowed}ms).`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * A diff reduced to what two runs of `git revert` on the same base must share:
 * each file's path pair, each hunk's position on the old side, and every line
 * of every hunk — context lines included.
 *
 * Only the blob hashes of the `index` line are dropped, because those differ
 * between an applied revert and a generated one without the change differing.
 * The context stays in: without it the comparison is a multiset of changed
 * lines, and the same one-line edit at two different places in the file has
 * one signature — which would let an unrelated diff inherit the exception and
 * skip every rule after it.
 */
export function revertSignature(diff: string): string {
  return parseDiff(diff)
    .map((file) =>
      [
        `${file.oldPath}\u0000${file.path}`,
        ...file.metadata,
        ...file.hunks.flatMap((hunk) => [`@@${hunk.oldStart}`, ...hunk.lines.map((line) => line.kind + line.text)]),
      ].join("\n"),
    )
    .join("\n\u0001\n");
}

/** Everything the verdict depends on; nothing is read from the environment. */
export interface DiffGuardContext {
  /** The project's `ciDoctor` rules; anything omitted takes the default. */
  config?: Partial<DiffGuardConfig>;
  /** The measurement backing any raised timeout, from the PR body. */
  evidence?: TimeoutEvidence | null;
  /**
   * The text of `git revert <culprit>` on the same base, when the diff claims
   * to be that revert. Supplying it is what opens the fix-scope exception —
   * and if the diff is not that revert, saying so is itself a finding.
   *
   * Only a caller that GENERATED this from a sha may pass it. The exception
   * skips the weakening and timeout rules, so a caller free to name the
   * comparison can clear any diff by naming a copy of itself. That is why
   * `guard.ts diff`, whose caller is the executor, has no flag for it.
   */
  revert?: string | null;
}

/** The config with every default filled in. */
export function resolveConfig(partial: Partial<DiffGuardConfig> | undefined): DiffGuardConfig {
  return {
    fixScope: partial?.fixScope ?? [...DEFAULT_FIX_SCOPE],
    neverTouch: partial?.neverTouch ?? [...DEFAULT_NEVER_TOUCH],
    testTimeoutCeilingMs: partial?.testTimeoutCeilingMs ?? DEFAULT_TEST_TIMEOUT_CEILING_MS,
    hookTimeoutCeilingMs: partial?.hookTimeoutCeilingMs ?? DEFAULT_HOOK_TIMEOUT_CEILING_MS,
  };
}

/**
 * Whether the guard could read this diff at all — and a refusal when it could
 * not.
 *
 * The default on confusion has to be "refuse". A guard that returns no
 * findings for input it did not understand reports the same empty array as a
 * clean diff, and every unsupported form becomes a way through: a combined
 * diff (`diff --cc`, which git emits whenever the index has unmerged paths)
 * parses to no files at all.
 */
export function unreadableProblems(diff: string, files: readonly DiffFile[]): string[] {
  if (diff.trim() === "") return [];
  const problems: string[] = [];
  // A real header is at column zero; a hunk's own content always carries a
  // leading " ", "+" or "-".
  // From the first real header on: a commit message above it may quote
  // anything, and `git show` indents it by four spaces rather than none.
  const body = diff.slice(Math.max(0, diff.indexOf("diff --git")));
  const combined = /^diff --(?!git )\S*/m.exec(body) ?? /^@@@/m.exec(body);
  if (combined) {
    problems.push(`the diff is in a form this guard cannot read (\`${combined[0].trim()}\`) — give it a plain \`git diff\`.`);
  }
  if (files.length === 0 && problems.length === 0) {
    problems.push("the diff is not empty but names no files — this guard could not read it, so it cannot clear it.");
  }
  // `git diff --word-diff` is a plain `git diff` whose hunk bodies this
  // parser drops, leaving a file entry with no lines at all — which judged
  // clean. A rename or a mode change legitimately has none.
  for (const file of files) {
    if (file.binary || file.renamed) continue;
    if (file.hunks.length > 0 && file.hunks.every((hunk) => hunk.lines.length === 0)) {
      problems.push(`${file.path}: the hunks carry no readable lines — give this guard a plain \`git diff\`, not a word diff.`);
    }
  }
  return problems;
}

/**
 * Every rule this diff breaks. Empty means the doctor may land it.
 *
 * The repo's validator shape (`triage/validate.ts`, `project-config.ts`): a
 * refusal is a finding a human or a later phase can act on, not an exception.
 */
export function diffGuardProblems(diff: string, context: DiffGuardContext = {}): string[] {
  const config = resolveConfig(context.config);
  const files = parseDiff(diff);
  const revert = context.revert ?? null;
  const exactRevert = revert !== null && revertSignature(diff) === revertSignature(revert);

  const problems: string[] = [...unreadableProblems(diff, files)];
  if (problems.length > 0) return problems;
  if (revert !== null && !exactRevert) {
    problems.push("the diff is offered as a revert but is not byte-identical to `git revert` on this base.");
  }
  problems.push(...scopeProblems(files, config, { exactRevert }));
  // An exact revert is the culprit's own change backwards, so the rules about
  // what the doctor may write do not apply to it.
  if (exactRevert) return problems;
  problems.push(...weakeningProblems(files));
  problems.push(...timeoutProblems(files, config, context.evidence ?? null));
  return problems;
}

/**
 * The project's `ciDoctor` rules, read straight from `.ralph/config.json`.
 *
 * Read raw rather than through `project-config.ts`, which DOES validate the
 * block (#158): this file is mounted into the sandbox and may not import the
 * harness. So the validation is the operator's guarantee and this reader is
 * the sandbox's — an absent or malformed value takes the default, and a config
 * a project cannot parse is not this guard's to diagnose.
 */
export function readDiffGuardConfig(configPath: string | null, read: (path: string) => string): DiffGuardConfig {
  if (configPath === null) return resolveConfig(undefined);
  let block: Record<string, unknown> | undefined;
  try {
    block = (JSON.parse(read(configPath)) as { ciDoctor?: Record<string, unknown> }).ciDoctor;
  } catch {
    return resolveConfig(undefined);
  }
  const globs = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string") && value.length > 0 ? (value as string[]) : undefined;
  const ms = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  return resolveConfig({
    fixScope: globs(block?.fixScope),
    neverTouch: globs(block?.neverTouch),
    testTimeoutCeilingMs: ms(block?.testTimeoutCeilingMs),
    hookTimeoutCeilingMs: ms(block?.hookTimeoutCeilingMs),
  });
}

/**
 * The measured times a raised bound needs, read from the PR body.
 *
 * One line, in the form the doctor's prompt asks for:
 *   `timeout-evidence: ci=41s local=9s`
 * Seconds or milliseconds (`41s`, `41000ms`, a bare number is milliseconds).
 * Both numbers are required — a CI time alone says nothing about whether the
 * slowness is the test's or the host's.
 */
export function parseTimeoutEvidence(body: string): TimeoutEvidence | null {
  const line = /timeout-evidence:\s*ci\s*=\s*([\d.]+)(ms|s)?\s+local\s*=\s*([\d.]+)(ms|s)?/i.exec(body);
  if (!line) return null;
  const scale = (unit: string | undefined): number => (unit === "s" ? 1000 : 1);
  const worstCiMs = Number(line[1]) * scale(line[2]);
  const localMs = Number(line[3]) * scale(line[4]);
  if (!Number.isFinite(worstCiMs) || !Number.isFinite(localMs)) return null;
  return { worstCiMs, localMs };
}

/** What a refused diff exits with: `guard.ts`'s `REFUSED_EXIT`, kept in step. */
export const REFUSED_DIFF_EXIT = 10;

/** What a refusing diff guard prints, in `guard.ts`'s shape. */
export function diffRefusalMessage(problems: readonly string[]): string {
  return [
    `ralph ci-doctor diff guard: refused this diff (${problems.length} finding${problems.length === 1 ? "" : "s"}).`,
    ...problems.map((problem) => `  - ${problem}`),
    "  The doctor makes a flaky test reliable and a slow test fast. It does not switch a test off,",
    "  delete its assertions, exclude it, wait longer for it, or edit the pipeline — each of those",
    "  turns the build green while the thing the test watches stays broken.",
    "  A refusal is a finding: take the fix back to implement, or file it.",
  ].join("\n");
}
