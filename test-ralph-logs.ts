/**
 * The suite's own `.ralph/` must come back from a test run unchanged.
 *
 * `bun run test` runs as a loop's `test` gate, with the loop's worktree as cwd.
 * `test-ralph-env.setup.ts` strips `RALPH_PROJECT` from every test process, so
 * `projectRoot()` falls through to `git rev-parse --show-toplevel` — this
 * checkout. A suite that drives a harness script without an explicit scratch
 * project therefore writes into `<repo>/.ralph/logs`: by 2026-10-05 this
 * worktree held 1439 leaked `inspect.sh` lock files and 3783 `inspect-*`
 * artifacts, and `notifications.jsonl` there is the dashboard's live feed, so a
 * test run can raise a false alert about the real loop. `.gitignore`'s
 * `/.ralph/*` hides all of it from `git status`, which is why the guard walks
 * the filesystem instead.
 *
 * The one subtlety is that a worktree with a *running* supervisor has its
 * `.ralph/logs` changing underneath the run through no fault of the suite.
 * `liveLoopPaths` is what separates the two, and it is deliberately inert
 * without a harness identity in the environment: in CI, and in any fresh
 * worktree, nothing is excused and every path is watched.
 *
 * The operator is the other live writer. The dashboard drops its commands into
 * `.ralph/control/inbox/` whenever it likes, gate or no gate — on PR #401 a
 * `stop` for the very run being gated landed mid-suite, and 5597 green tests
 * failed on it (#481). `liveOperatorCommands` excuses such a command, under the
 * same rule: only with an identity, and only when the command is addressed to
 * that live loop. A command for another run or loop, or one that does not even
 * parse, is what a test leaking into the inbox looks like.
 *
 * What it compares is a path's size and mtime, not its contents: at ~16k files
 * hashing the tree twice per run is not worth a rewrite that happens to keep
 * the length inside one mtime tick.
 */
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { CONTROL_DIR_RELATIVE_PATH, CONTROL_INBOX_RELATIVE_PATH } from "./control-inbox";
import { STATE_RELATIVE_DIR } from "./paths";

/** One path in a snapshot: its size and mtime, enough to spot a rewrite. */
type Entry = { readonly size: number; readonly mtimeMs: number };

/** A tree snapshot, keyed by path relative to the snapshot root. */
export type Snapshot = ReadonlyMap<string, Entry>;

/** What happened to one path between two snapshots. */
export type Change = { readonly path: string; readonly kind: "added" | "changed" | "removed" };

/** A directory, which registers only as added or removed — never as changed. */
const DIRECTORY: Entry = { size: 0, mtimeMs: 0 };

/** How many offending paths `describeChanges` names before it counts the rest. */
const NAMED_PATHS = 20;

/**
 * Supervisor-owned files, at the exact path the supervisor writes them.
 *
 * Deliberately short, and anchored rather than matched by basename: `inspect-*`,
 * `locks/`, `opencode-db/`, `notifications.jsonl`, `push-notifications.json`,
 * `runner-failures.jsonl`, `codex-thread-*` and `host-lease-*` are the pollution
 * this guard exists to catch and must stay detectable, and a `state.json` leaked
 * into `logs/opencode-db/` is not the supervisor's.
 */
const SUPERVISOR_FILES = [
  "logs/supervisor.lock",
  "logs/supervisor.pid",
  "logs/loop.stdout",
  "logs/state.json",
  "logs/controls.json",
  "logs/backoff.json",
  "logs/usage-ledger.tsv",
  "logs/budget-strikes.tsv",
] as const;

/** Supervisor-owned name prefixes, all of them directly under `logs/`. */
const SUPERVISOR_PREFIXES = [
  "logs/usage-state-",
  "logs/heartbeat-",
  "logs/handoff-pr-",
  // `ralph.sh` names a turn's logs by timestamp and pid, not by run id, so the
  // identity cannot reach them (`ralph.sh:967-969`, `:1117-1119`). They are
  // appended to all through the gate, this very run included.
  "logs/iter-",
  "logs/signals-orchestrator-",
] as const;

/**
 * Supervisor-owned directories.
 *
 * The phase-control ledger is `.ralph/logs/phases/<issue>.jsonl` (`ralph.sh:1034`),
 * appended by the live loop at every phase boundary and named by issue, so no
 * identity can match it either.
 */
const SUPERVISOR_DIRS = ["logs/phases"] as const;

/** Every file and directory under `root`, recursively. A missing root is empty. */
export function snapshotTree(root: string): Snapshot {
  try {
    readdirSync(root);
  } catch (error) {
    // Only a *missing* root is an empty tree. Anything else — a permission
    // error, say — would snapshot as empty before and after, report no changes
    // and pass the run, which is the decorative guard this one exists not to be.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const found = new Map<string, Entry>();
  walk(root, "", found);
  return found;
}

function walk(dir: string, prefix: string, into: Map<string, Entry>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory the live loop removed mid-walk is not this run's doing. The
    // root itself was checked above, where silence would hide a real fault.
    return;
  }
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // Never descend a symlink: it could leave the tree entirely. It counts as
    // one entry, like a file.
    if (entry.isDirectory()) {
      // Recorded as well as walked, so a leftover empty `locks/` or
      // `opencode-db/` — both named in #199's evidence — is a change too.
      into.set(path, DIRECTORY);
      walk(join(dir, entry.name), path, into);
      continue;
    }
    try {
      const stat = statSync(join(dir, entry.name), { throwIfNoEntry: true });
      into.set(path, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Rotated or unlinked between the readdir and the stat; skip the entry
      // rather than failing the whole snapshot.
    }
  }
}

/** The changes from `before` to `after`, `ignore`d paths dropped, sorted by path. */
export function diffTrees(
  before: Snapshot,
  after: Snapshot,
  ignore: (path: string) => boolean = () => false,
): Change[] {
  const changes: Change[] = [];
  for (const [path, entry] of after) {
    if (ignore(path)) continue;
    const was = before.get(path);
    if (was === undefined) changes.push({ path, kind: "added" });
    else if (was.size !== entry.size || was.mtimeMs !== entry.mtimeMs) changes.push({ path, kind: "changed" });
  }
  for (const path of before.keys()) {
    if (ignore(path)) continue;
    if (!after.has(path)) changes.push({ path, kind: "removed" });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A predicate matching the paths a LIVE loop writes.
 *
 * Built from the harness identity in `env`, which the caller reads before
 * `test-ralph-env.setup.ts` scrubs it. **With no identity it matches nothing**:
 * a fresh worktree and CI are where "a full run leaves `.ralph/` unchanged" is
 * judged, and there every one of these names is a suite's doing. A supervisor
 * running under some *other* run id is not excused either — only the live one
 * is, which is what keeps a fixture-started supervisor detectable.
 */
export function liveLoopPaths(
  env: Record<string, string | undefined> = process.env,
): (path: string) => boolean {
  // An empty value would make `includes` match every path, so drop it here
  // rather than at every call.
  const ids = [env.RALPH_RUN_ID, env.RALPH_SESSION_ID]
    .map((id) => id?.trim() ?? "")
    .filter((id) => id !== "");
  if (ids.length === 0) return () => false;
  return (path) => {
    if (ids.some((id) => path.includes(id))) return true;
    if (SUPERVISOR_FILES.some((file) => path === file)) return true;
    if (SUPERVISOR_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
    return SUPERVISOR_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
  };
}

/** The control paths relative to `.ralph`, which is what a snapshot is keyed by. */
const CONTROL_DIR = posix.relative(STATE_RELATIVE_DIR, CONTROL_DIR_RELATIVE_PATH);
const CONTROL_INBOX = posix.relative(STATE_RELATIVE_DIR, CONTROL_INBOX_RELATIVE_PATH);

/** What a writer leaves behind with its first command (`ensureControlDir`). */
const CONTROL_STRUCTURE: readonly string[] = [CONTROL_DIR, CONTROL_INBOX, `${CONTROL_DIR}/.gitignore`];

/** A writer's dotted temp file, renamed over `<id>.json` once whole. */
const INBOX_TEMP = /^\.[^/]+\.json\.\d+\.tmp$/;

/** A delivered command file, directly in the inbox. */
const INBOX_COMMAND = /^[^/.][^/]*\.json$/;

/**
 * A predicate matching the operator's commands to the LIVE loop under `root`,
 * the checkout's `.ralph`.
 *
 * The supervisor polls the inbox only between turns, never mid-gate, so a
 * command still sitting there at teardown is one the dashboard wrote during the
 * run; only the inbox and the structure its writer creates are excused, never
 * `processed/`. A command is judged by its content, read lazily when the
 * predicate is asked: a well-formed command (`version` 1, a string `id` and
 * `command`) addressed to the live `RALPH_RUN_ID`, or — with no run — to the
 * live `RALPH_LOOP_NAME`. There is no default loop name: `ralph.sh` always
 * exports one, and guessing would excuse a leaked fixture command for `ralph`.
 * With no run id it matches nothing, as `liveLoopPaths` does. Only the run id
 * counts here, not the session id `liveLoopPaths` also accepts, because a
 * command's `run` names a run and `ralph.sh` exports one for every iteration.
 */
export function liveOperatorCommands(
  root: string,
  env: Record<string, string | undefined> = process.env,
): (path: string) => boolean {
  const run = env.RALPH_RUN_ID?.trim() ?? "";
  if (run === "") return () => false;
  const loop = env.RALPH_LOOP_NAME?.trim() ?? "";
  return (path) => {
    if (CONTROL_STRUCTURE.includes(path)) return true;
    if (!path.startsWith(`${CONTROL_INBOX}/`)) return false;
    const name = path.slice(CONTROL_INBOX.length + 1);
    if (INBOX_TEMP.test(name)) return true;
    if (!INBOX_COMMAND.test(name)) return false;
    let command: unknown;
    try {
      command = JSON.parse(readFileSync(join(root, path), "utf8"));
    } catch {
      // Unreadable or unparseable — gone, or not a command the dashboard wrote.
      return false;
    }
    if (typeof command !== "object" || command === null || Array.isArray(command)) return false;
    const { version, id, command: verb, run: to, loop: named } = command as Record<string, unknown>;
    if (version !== 1 || typeof id !== "string" || typeof verb !== "string") return false;
    if (typeof to === "string" && to !== "") return to === run;
    if (to !== undefined && to !== null && to !== "") return false;
    return loop !== "" && named === loop;
  };
}

/**
 * The trees a run must leave alone inside the harness checkout `repo`, each
 * with the predicate that says which of its paths are somebody else's.
 *
 * `fixtures/loggd/.ralph` is in there because five suites point `RALPH_PROJECT`
 * at it, and unlike `<repo>/.ralph` it is tracked — a write there is a diff. No
 * supervisor has ever run in it, so nothing there is excused: `ignore` is the
 * live-loop predicate for the checkout's own tree and nothing for the fixture.
 * It is handed the checkout's root, because the operator's commands are judged
 * by reading them there.
 */
export function guardedRoots(
  repo: string,
  ignore: (root: string) => (path: string) => boolean,
): { root: string; ignore: (path: string) => boolean }[] {
  const root = join(repo, STATE_RELATIVE_DIR);
  return [
    { root, ignore: ignore(root) },
    { root: join(repo, "fixtures", "loggd", STATE_RELATIVE_DIR), ignore: () => false },
  ];
}

/** A snapshot of each guarded root, keyed by the root's absolute path. */
export function snapshotRoots(roots: readonly { root: string }[]): Map<string, Snapshot> {
  return new Map(roots.map(({ root }) => [root, snapshotTree(root)]));
}

/** What each root gained, lost or had rewritten since `before`; clean roots omitted. */
export function offences(
  before: ReadonlyMap<string, Snapshot>,
  roots: readonly { root: string; ignore: (path: string) => boolean }[],
): Map<string, Change[]> {
  const found = new Map<string, Change[]>();
  for (const { root, ignore } of roots) {
    const snapshot = before.get(root);
    if (snapshot === undefined) continue;
    const changes = diffTrees(snapshot, snapshotTree(root), ignore);
    if (changes.length > 0) found.set(root, changes);
  }
  return found;
}

/** A failure message naming the offending paths, and what to do about them. */
export function describeChanges(root: string, changes: readonly Change[]): string {
  const named = changes
    .slice(0, NAMED_PATHS)
    .map((change) => `  ${change.kind.padEnd(7)} ${change.path}`)
    .join("\n");
  const rest = changes.length > NAMED_PATHS ? `\n  … and ${changes.length - NAMED_PATHS} more` : "";
  return [
    `This run changed ${changes.length} path(s) under ${root}:`,
    `${named}${rest}`,
    "",
    "That directory is the checkout's own harness state — when a loop runs this",
    "suite as its gate, it is the LIVE loop's. A suite that drives a harness",
    "script must pass an explicit scratch project (both `RALPH_PROJECT` and",
    "`cwd`), never the repo it runs in.",
  ].join("\n");
}
