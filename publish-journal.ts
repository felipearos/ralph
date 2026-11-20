#!/usr/bin/env bun
/**
 * Publish one iteration's journal entry into the HARNESS repository — or, for a
 * project whose config names `journal.branch`, onto that branch of the
 * project's own repository (see `journal-home.ts`; same lock, same retries,
 * written with plumbing instead of the shared worktree).
 *
 * Journals used to travel through a journal-only pull request on the project,
 * gated on the project's required checks. The harness is its own repository
 * now, and journals belong to it (`<journal.dir>/` per project), so publishing
 * is a direct, serialised push to the harness repo's `main`:
 *
 *   1. The iteration writes its entry as a draft inside the project worktree:
 *      `.ralph/logs/journal-draft-<UTC ts>-<issue>-<session>.md`.
 *   2. This publisher takes a machine-wide lock (every loop shares one harness
 *      checkout and one publishing worktree), works in a harness-owned git
 *      worktree detached at `origin/main`, commits exactly that one file as
 *      `chore(<loop>): journal <project> #<n>`, and pushes `HEAD:main`.
 *   3. A rejected push (another loop landed first) is retried on a fresh
 *      `origin/main`, at most five attempts in all. On success the draft is
 *      deleted; on failure it stays, so nothing is lost.
 *
 * It never touches the project checkout's git state — only the draft file.
 *
 * The same script also publishes LEARNINGS, which are the other half of what a
 * loop leaves behind: the journal is the raw history, the learnings file is the
 * short, current list of what to know. They share this script rather than
 * getting their own because they need the very same three things — the
 * machine-wide lock, the harness-owned worktree, and the retry on a fresh
 * `origin/main` — and a second implementation of those would be a second thing
 * to get right.
 *
 * Learnings differ from journals in one way that matters. A journal entry is a
 * new file that no other writer can collide with, so a rejected push only has
 * to be re-applied. A learnings file is SHARED and read-modify-write, so every
 * attempt re-reads the file from the freshly detached `origin/main` and redoes
 * the edit there. Re-applying a diff computed against the stale copy is exactly
 * how the other loop's entry would be lost.
 *
 * Usage:
 *   bun "$RALPH_HOME/publish-journal.ts" --draft <path> --issue <n|none>
 *   bun "$RALPH_HOME/publish-journal.ts" --learning <draft> --scope project|harness
 *   bun "$RALPH_HOME/publish-journal.ts" --revise <draft> --scope project|harness
 *   bun "$RALPH_HOME/publish-journal.ts" --close <slug> --pr <n> --scope project|harness
 *
 * Overrides (tests, unusual setups):
 *   RALPH_JOURNAL_HOME           the harness repo to publish into (default RALPH_HOME)
 *   RALPH_JOURNAL_BRANCH         `journal.branch` as exported; empty = the harness
 *   RALPH_JOURNAL_WORKTREE       the publishing worktree (default ~/.ralph/journal-wt)
 *   RALPH_JOURNAL_LOCK           the lock file (default ~/.ralph/journal.lock)
 *   RALPH_FINDINGS_RECORD        the host's record of filed findings (default ~/.ralph/findings.json)
 *   RALPH_JOURNAL_LOCK_SECONDS   how long to wait for the lock (default 120)
 *   RALPH_JOURNAL_COMMAND_TIMEOUT_MS  bound on each git command (default 60000)
 *   RALPH_JOURNAL_DIR, RALPH_PROJECT_DISPLAY_NAME  instead of .ralph/config.json
 *   RALPH_LEARNINGS_FILE         the project's learnings path (empty = opted out)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loopRoster } from "./frontier/next-tasks";
import { harnessChangeRefusal, pendingFinding, promoteFinding } from "./findings";
import { redact } from "./runner-failure";
import { addEntry, closeEntry, findEntry, HARNESS_FILE, reviseEntry, SLUG, seenAgain, slugOf } from "./learnings";
import { projectFile } from "./learnings-read";
import { harnessLocation, journalLocation } from "./journal-home";
import { LOGS_RELATIVE_DIR, projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_LOCK_SECONDS = 120;
/** `flock -E`: the exit status that means "the lock was not acquired in time". */
export const LOCK_TIMEOUT_STATUS = 75;

export const DRAFT_NAME = /^journal-draft-(\d{8}T\d{6}Z)-([0-9]+|none)-([A-Za-z0-9-]{1,40})\.md$/;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** `env` is added to the inherited one: the plumbing path needs a private `GIT_INDEX_FILE`. */
export type GitRunner = (args: string[], env?: Record<string, string>) => CommandResult;

export interface PublishOptions {
  /** The draft file, absolute or relative to the caller's cwd. */
  draft: string;
  /** `<n>` or `none`; must agree with the draft's name. */
  issue: string;
  loop: string;
  /** The project root the draft must live under (in `.ralph/logs`). */
  project: string;
  /** From the project config: `displayName` and `journal.dir`. */
  displayName: string;
  journalDir: string;
  /** The repository to publish into: the harness, or the project with `journal.branch`. */
  home: string;
  /** The harness-owned publishing worktree. Unused on a project-side branch. */
  worktree: string;
  /** Set for `journal.branch`: publish to this branch of `home` instead of the harness's main. */
  branch?: string;
  maxAttempts?: number;
  /** Test seam: runs after the commit is made, immediately before each push. */
  beforePush?: (attempt: number) => void;
  git?: GitRunner;
}

export interface PublishResult {
  path: string;
  sha: string;
  attempts: number;
  alreadyPublished: boolean;
}

const commandTimeout = (): number => {
  const configured = Number(process.env.RALPH_JOURNAL_COMMAND_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COMMAND_TIMEOUT_MS;
};

/** A git environment that can neither prompt nor be redirected by an inherited repo. */
const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[name];
  return env;
};

export const defaultGit: GitRunner = (args, extra) => {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: commandTimeout(),
    killSignal: "SIGTERM",
    env: { ...gitEnv(), ...extra },
  });
  return {
    status: result.status ?? 124,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
};

const why = (result: CommandResult): string =>
  result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;

/** Validate the draft and derive the published file name from it. */
export function validateDraft(options: Pick<PublishOptions, "draft" | "issue" | "project">): {
  path: string;
  name: string;
  issue: string;
} {
  const path = resolve(options.draft);
  const logs = resolve(options.project, LOGS_RELATIVE_DIR);
  const rel = relative(logs, path);
  if (rel === "" || rel.startsWith("..") || rel.includes("/")) {
    throw new Error(`the draft must be a file directly inside ${logs}: ${options.draft}`);
  }
  const match = DRAFT_NAME.exec(basename(path));
  if (!match) {
    throw new Error(
      `the draft must be named journal-draft-<YYYYMMDDTHHMMSSZ>-<issue|none>-<session>.md: ${basename(path)}`,
    );
  }
  if (!/^(?:[0-9]+|none)$/.test(options.issue)) throw new Error(`--issue must be a number or 'none'; got '${options.issue}'`);
  if (match[2] !== options.issue) {
    throw new Error(`--issue ${options.issue} does not match the draft's issue '${match[2]}'`);
  }
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`the draft is missing or empty: ${path}`);
  }
  return { path, name: basename(path).slice("journal-draft-".length), issue: options.issue };
}

/** The publishing worktree, created (or re-created after it vanished) at `origin/main`. */
export function ensureWorktree(home: string, worktree: string, git: GitRunner = defaultGit): void {
  if (existsSync(worktree)) {
    const inside = git(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const expected = git(["-C", home, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (inside.status === 0 && expected.status === 0 && inside.stdout.trim() === expected.stdout.trim()) return;
    throw new Error(`${worktree} exists but is not a worktree of ${home}; move it aside`);
  }
  // A registration whose directory was deleted blocks `worktree add` at that path.
  git(["-C", home, "worktree", "prune"]);
  const fetched = git(["-C", home, "fetch", "--quiet", "origin", "main"]);
  if (fetched.status !== 0) throw new Error(`could not fetch the harness origin: ${why(fetched)}`);
  mkdirSync(dirname(worktree), { recursive: true });
  const added = git(["-C", home, "worktree", "add", "--detach", worktree, "origin/main"]);
  if (added.status !== 0) throw new Error(`could not create the journal worktree: ${why(added)}`);
}

/**
 * One place a commit lands: the steps both publishers repeat each attempt.
 *
 * The harness keeps its shared publishing worktree, as it always has. A
 * project-side branch (`journal.branch`) is written with plumbing instead — a
 * private index and `commit-tree` — because a worktree of the PROJECT
 * repository would show up in `git worktree list`, which is exactly what the
 * loop-state panel and the dashboard read to find the project's loops.
 */
interface Target {
  /** `origin/<branch>` as the target reads it. */
  ref: string;
  /** The ref in an operator's words, for refusals. */
  label: string;
  /** Once, before the first attempt: the worktree or the branch must exist. */
  prepare(): void;
  /** Each attempt: fetch, and drop anything a killed publish left in `dir`. */
  refresh(dir: string): void;
  show(path: string): CommandResult;
  /** Commit `content` at `path` on top of the fresh ref; the files it touched. */
  commit(path: string, content: string, message: string): { sha: string; touched: string[] };
  push(sha: string): CommandResult;
  /** The fresh ref's commit. */
  tip(): string;
  /** Appended to every commit subject, e.g. ` [skip ci]`. */
  suffix: string;
}

function harnessTarget(home: string, worktree: string, git: GitRunner): Target {
  const wt = resolve(worktree);
  const must = (args: string[]): string => {
    const result = git(["-C", wt, ...args]);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${why(result)}`);
    return result.stdout;
  };
  return {
    ref: "origin/main",
    label: "the harness's origin/main",
    suffix: "",
    prepare: () => ensureWorktree(home, wt, git),
    refresh: (dir) => {
      must(["fetch", "--quiet", "origin", "main"]);
      must(["checkout", "--quiet", "--detach", "--force", "origin/main"]);
      // Only this tool's own directory can hold leftovers from a killed
      // publish; nothing else in the harness worktree is its to clean.
      git(["-C", wt, "clean", "-fdq", "--", dir]);
    },
    show: (path) => git(["-C", wt, "show", `origin/main:${path}`]),
    commit: (path, content, message) => {
      mkdirSync(join(wt, dirname(path)), { recursive: true });
      writeFileSync(join(wt, path), content);
      must(["add", "--", path]);
      must(["commit", "--quiet", "-m", message, "--", path]);
      const touched = must(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean);
      return { sha: must(["rev-parse", "HEAD"]).trim(), touched };
    },
    push: () => git(["-C", wt, "push", "--quiet", "origin", "HEAD:main"]),
    tip: () => must(["rev-parse", "origin/main"]).trim(),
  };
}

/**
 * The line the seed commit's README carries. The publisher refuses a branch
 * whose README lacks it: the branch is pushed to without review, and a typo
 * that named a real code branch must not get journal commits on top of it.
 */
export const JOURNAL_BRANCH_MARKER = "<!-- ralph:journal-branch -->";

/**
 * Turns off Vercel's git deployments for every commit on the branch. A
 * project deployed by Vercel would otherwise build a preview for each journal
 * push, and fail it, since the branch has no app in it.
 */
const SEED_FILES: Record<string, string> = {
  "README.md": `${JOURNAL_BRANCH_MARKER}\n# Ralph journal\n\nWhat Ralph's loops wrote about this project: one file per iteration under the journal directory, and the open learnings under \`learnings/\`. Pushed by \`publish-journal.ts\`; it shares no history with the code.\n`,
  "vercel.json": `${JSON.stringify({ git: { deploymentEnabled: false } }, null, 2)}\n`,
};

function branchTarget(home: string, branch: string, git: GitRunner): Target {
  const ref = `origin/${branch}`;
  const at = (args: string[], env?: Record<string, string>): CommandResult => git(["-C", home, ...args], env);
  const must = (args: string[], env?: Record<string, string>): string => {
    const result = at(args, env);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${why(result)}`);
    return result.stdout;
  };
  // An explicit refspec: a project clone may fetch only its base branch.
  const fetch = (): CommandResult => at(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/${ref}`]);

  /** A commit of `files` on top of `parent` (null: a root commit), built off to the side. */
  const build = (files: Record<string, string>, parent: string | null, message: string): string => {
    const scratch = mkdtempSync(join(tmpdir(), "ralph-journal-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      if (parent !== null) must(["read-tree", parent], env);
      let n = 0;
      for (const [path, content] of Object.entries(files)) {
        const file = join(scratch, `blob-${(n += 1)}`);
        writeFileSync(file, content);
        const blob = must(["hash-object", "-w", "--", file]).trim();
        must(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
      }
      const tree = must(["write-tree"], env).trim();
      return must(["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", message]).trim();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const guard = (): void => {
    const readme = at(["show", `${ref}:README.md`]);
    if (readme.status !== 0 || !readme.stdout.includes(JOURNAL_BRANCH_MARKER)) {
      throw new Error(`${branch} on ${home}'s origin is not a Ralph journal branch (its README lacks ${JOURNAL_BRANCH_MARKER}); refusing to push to it`);
    }
  };

  return {
    ref,
    label: `the project's ${ref}`,
    suffix: " [skip ci]",
    prepare: () => {
      if (fetch().status === 0) return guard();
      // Exit 2 is "no such ref": the branch has never been published. Anything
      // else (no network, no access) is a failure to report, not a reason to
      // create a branch that may well exist.
      const remote = at(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
      if (remote.status !== 2) throw new Error(`could not fetch ${branch} from ${home}'s origin: ${why(remote)}`);
      const seed = build(SEED_FILES, null, "chore(ralph): start the journal branch [skip ci]");
      // Not forced: if another host created it first, this is refused and the
      // fetch below picks theirs up.
      at(["push", "--quiet", "origin", `${seed}:refs/heads/${branch}`]);
      const fetched = fetch();
      if (fetched.status !== 0) throw new Error(`could not create ${branch} on ${home}'s origin: ${why(fetched)}`);
      guard();
    },
    refresh: () => {
      const fetched = fetch();
      if (fetched.status !== 0) throw new Error(`git fetch failed: ${why(fetched)}`);
    },
    show: (path) => at(["show", `${ref}:${path}`]),
    commit: (path, content, message) => {
      const sha = build({ [path]: content }, ref, message);
      const touched = must(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n").filter(Boolean);
      return { sha, touched };
    },
    push: (sha) => at(["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`]),
    tip: () => must(["rev-parse", ref]).trim(),
  };
}

const targetFor = (options: { home: string; worktree: string; branch?: string }, git: GitRunner): Target =>
  options.branch === undefined || options.branch === ""
    ? harnessTarget(options.home, options.worktree, git)
    : branchTarget(resolve(options.home), options.branch, git);

const safeLoop = (loop: string): string => {
  const roster = loopRoster();
  if (!roster.includes(loop)) {
    throw new Error(`RALPH_LOOP_NAME must be one of ${roster.join(", ")}; got '${loop}'`);
  }
  return loop;
};

export function commitSubject(loop: string, displayName: string, issue: string): string {
  return `chore(${loop}): journal ${displayName.toLowerCase()} #${issue}`;
}

export function publishJournal(options: PublishOptions): PublishResult {
  const git = options.git ?? defaultGit;
  const loop = safeLoop(options.loop);
  const draft = validateDraft(options);
  const journalDir = options.journalDir.replace(/\/+$/, "");
  const entry = `${journalDir}/${draft.name}`;
  const content = readFileSync(draft.path, "utf8");
  const max = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const target = targetFor(options, git);

  target.prepare();

  let lastRejection = "";
  for (let attempt = 1; attempt <= max; attempt += 1) {
    target.refresh(journalDir);

    const published = target.show(entry);
    if (published.status === 0) {
      if (published.stdout !== content) {
        throw new Error(`${entry} is already published on ${target.label} with different content; the draft is kept`);
      }
      const sha = target.tip();
      rmSync(draft.path, { force: true });
      return { path: entry, sha, attempts: attempt, alreadyPublished: true };
    }

    const { sha, touched } = target.commit(entry, content, commitSubject(loop, options.displayName, draft.issue) + target.suffix);
    if (touched.length !== 1 || touched[0] !== entry) {
      throw new Error(`the journal commit touches ${touched.join(", ") || "nothing"}, not exactly ${entry}`);
    }

    options.beforePush?.(attempt);
    const pushed = target.push(sha);
    if (pushed.status === 0) {
      rmSync(draft.path, { force: true });
      return { path: entry, sha, attempts: attempt, alreadyPublished: false };
    }
    // Rejected (most often: another loop landed first). The next attempt
    // starts again from the fresh ref and re-applies the one file, which is a
    // rebase of a single-file commit without a rebase's failure modes.
    lastRejection = why(pushed);
  }
  throw new Error(`the push was rejected ${max} times; the draft is kept. Last: ${lastRejection}`);
}

/** Built from `SLUG` so the name on disk and the key in the file cannot drift. */
export const LEARNING_DRAFT_NAME = new RegExp(
  `^learning-draft-(\\d{8}T\\d{6}Z)-(${SLUG.source.replace(/^\^/, "").replace(/\$$/, "")})\\.md$`,
);

/** Which file a learning lands in, and whose problem the fix is. */
export type LearningScope = "project" | "harness";

/**
 * Adding or repeating an entry, correcting one that is still open, or retiring
 * one a merged PR fixed.
 *
 * `revise` takes a draft rather than a slug and a body because the draft
 * contract is what ties the two together: the file name carries the slug, the
 * body carries it again, and `validateLearningDraft` refuses a disagreement —
 * so a correction cannot land against the wrong entry.
 */
export type LearningAction =
  | { kind: "entry"; draft: string }
  | { kind: "revise"; draft: string }
  | { kind: "close"; slug: string; pr: number };

export interface LearningOptions {
  action: LearningAction;
  scope: LearningScope;
  loop: string;
  /** The project root a draft must live under (in `.ralph/logs`). */
  project: string;
  /** From the project config: used in the commit subject for a project learning. */
  displayName: string;
  /** The learnings path inside `home`. */
  file: string;
  home: string;
  worktree: string;
  /** Set for a project learning under `journal.branch`: see `PublishOptions.branch`. */
  branch?: string;
  /** The date a `Seen again` line carries. Passed in so a test can pin it. */
  date: string;
  maxAttempts?: number;
  beforePush?: (attempt: number) => void;
  git?: GitRunner;
  /** Called under the publisher lock, against the freshly read entry. */
  promote?: (entry: import("./learnings").LearningEntry) => string;
  /**
   * Why this entry's finding must not be filed where `promote` would file it,
   * or null (see `harnessChangeRefusal`). Judged on the entry as the edit left
   * it, under the lock, so a sighting of an entry whose ticket exists is never
   * mistaken for a new one.
   */
  refuseFinding?: (entry: import("./learnings").LearningEntry) => string | null;
}

export interface LearningResult {
  path: string;
  sha: string;
  attempts: number;
  slug: string;
  /** What the edit turned out to be — the caller cannot know in advance. */
  outcome: "added" | "seen-again" | "revised" | "closed";
  /** True when the file already said this, so nothing was committed. */
  alreadyPublished?: boolean;
}

/** Validate a learning draft and read the slug its name and body must agree on. */
export function validateLearningDraft(draft: string, project: string): { path: string; slug: string; body: string } {
  const path = resolve(draft);
  const logs = resolve(project, LOGS_RELATIVE_DIR);
  const rel = relative(logs, path);
  if (rel === "" || rel.startsWith("..") || rel.includes("/")) {
    throw new Error(`the draft must be a file directly inside ${logs}: ${draft}`);
  }
  const match = LEARNING_DRAFT_NAME.exec(basename(path));
  if (!match) {
    throw new Error(`the draft must be named learning-draft-<YYYYMMDDTHHMMSSZ>-<slug>.md: ${basename(path)}`);
  }
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`the draft is missing or empty: ${path}`);
  }
  const body = readFileSync(path, "utf8");
  const named = match[2] as string;
  // Belt and braces: the name is what the commit subject says, the body is what
  // a later `--close` finds the entry by, so a disagreement would publish an
  // entry nobody can retire.
  const inBody = slugOf(body);
  if (inBody === null) {
    throw new Error(`the draft carries no '<!-- learning: ${named} -->' comment: ${basename(path)}`);
  }
  if (inBody !== named) {
    throw new Error(`the draft is named '${named}' but its body says '${inBody}'`);
  }
  return { path, slug: named, body };
}

/** A project's tracker kind, or null when its config cannot be read. */
function trackerKindOf(root: string): string | null {
  try {
    return loadProjectConfig(root).tracker.kind;
  } catch {
    return null;
  }
}

/** A project's configured repo, or null when its config cannot be read. */
function repoOf(root: string): string | null {
  try {
    return loadProjectConfig(root).repo;
  } catch {
    return null;
  }
}

/** The file a scope writes to, and the word its commit subject uses. */
export function learningTarget(
  scope: LearningScope,
  options: { project: string; env?: Record<string, string | undefined> },
): { file: string } {
  if (scope === "harness") return { file: HARNESS_FILE };
  const file = projectFile(options.project, options.env ?? process.env);
  if (file === "opted-out") {
    throw new Error(
      `this project has no learnings file ('learnings': false in .ralph/config.json); publish to --scope harness or turn it on`,
    );
  }
  if (file === "unreadable") {
    // Not the same refusal: sending an operator to a key that may not be in a
    // malformed config is how a five-minute fix becomes an hour.
    loadProjectConfig(options.project);
    throw new Error(`could not read this project's learnings path from .ralph/config.json`);
  }
  return { file };
}

export function learningSubject(loop: string, label: string, slug: string): string {
  return `chore(${loop}): learning ${label} ${slug}`;
}

/** A learnings file for a project that has none yet. */
function skeleton(file: string): string {
  const name = basename(file, ".md");
  return `# ${name} learnings\n\nLessons from running Ralph on ${name}. See \`README.md\` for how learnings are split.\n\n## Open: fix these\n`;
}

/**
 * Add, repeat or retire one learning, serialised behind the journal lock.
 *
 * The edit is redone inside every attempt, against the text just read from the
 * freshly detached `origin/main`, so two loops publishing at once both land:
 * the second one's retry sees the first one's entry and prepends beside it. A
 * diff computed once against a stale copy would drop whichever landed first.
 */
export function publishLearning(options: LearningOptions): LearningResult {
  const git = options.git ?? defaultGit;
  const loop = safeLoop(options.loop);
  const file = options.file;
  const label = options.scope === "harness" ? "harness" : options.displayName.toLowerCase();
  const draft =
    options.action.kind === "entry" || options.action.kind === "revise"
      ? validateLearningDraft(options.action.draft, options.project)
      : null;
  const slug = draft === null ? (options.action as { slug: string }).slug : draft.slug;
  if (!SLUG.test(slug)) {
    throw new Error(`'${slug}' is not a usable slug; use lowercase letters, digits and hyphens`);
  }
  const max = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const target = targetFor(options, git);

  target.prepare();

  let lastRejection = "";
  for (let attempt = 1; attempt <= max; attempt += 1) {
    target.refresh(dirname(file));

    // Read the file as the ref has it RIGHT NOW, and redo the edit here.
    const shown = target.show(file);
    if (shown.status !== 0 && options.action.kind !== "entry") {
      // A revise and a close both name an entry that must already be there; only
      // a new entry may create the file.
      throw new Error(
        `${file} is not on ${target.label}, so there is nothing to ${options.action.kind}`,
      );
    }
    const before = shown.status === 0 ? shown.stdout : skeleton(file);

    let after: string;
    let outcome: LearningResult["outcome"];
    if (options.action.kind === "close") {
      after = closeEntry(before, slug, options.action.pr);
      outcome = "closed";
    } else if (options.action.kind === "revise") {
      // No `Seen again` line: a revise corrects prose that has gone stale while
      // the problem is still open, which is not a new sighting.
      after = reviseEntry(before, slug, (draft as { body: string }).body);
      outcome = "revised";
    } else if (findEntry(before, slug) !== null) {
      after = seenAgain(before, slug, options.date);
      outcome = "seen-again";
    } else {
      after = addEntry(before, (draft as { body: string }).body);
      outcome = "added";
    }

    let refused: string | null = null;
    if (options.action.kind !== "close" && options.refuseFinding) {
      const entry = findEntry(after, slug);
      refused = entry === null ? null : options.refuseFinding(entry);
      // A new entry is refused outright, draft kept, so its author republishes
      // it under the right scope. An entry already in the file is not: the
      // other scope's file does not carry its slug, so a revision there would
      // fail and a sighting would duplicate it, and `findings.ts reconcile`
      // would stop on it every run. It publishes; its finding is not filed.
      if (refused !== null && outcome === "added") throw new Error(refused);
      if (refused !== null) console.error(`finding not filed: ${slug} — ${refused}`);
    }

    if (options.action.kind !== "close" && options.promote && refused === null) {
      const entry = findEntry(after, slug);
      if (entry !== null) {
        try {
          after = reviseEntry(after, slug, options.promote(entry));
        } catch (error) {
          // Publishing the evidence must still work during a GitHub outage.
          // The pending Fix field is retried at the next reconciliation.
          console.error(`finding not promoted: ${redact(String(error))}; learning kept for retry`);
        }
      }
    }

    if (after === before) {
      // The correction is already on main — two blocked loops drafting the same
      // one, or a retry of a run that pushed and then died before deleting its
      // draft. `git commit` would refuse an unchanged tree and the operator
      // would read a git error instead of the truth, so say the truth and treat
      // it as done, the way the journal treats an identical entry.
      const sha = target.tip();
      if (draft !== null) rmSync(draft.path, { force: true });
      return { path: file, sha, attempts: attempt, slug, outcome, alreadyPublished: true };
    }

    const { sha, touched } = target.commit(file, after, learningSubject(loop, label, slug) + target.suffix);
    if (touched.length !== 1 || touched[0] !== file) {
      throw new Error(`the learning commit touches ${touched.join(", ") || "nothing"}, not exactly ${file}`);
    }

    options.beforePush?.(attempt);
    const pushed = target.push(sha);
    if (pushed.status === 0) {
      if (draft !== null) rmSync(draft.path, { force: true });
      return { path: file, sha, attempts: attempt, slug, outcome };
    }
    lastRejection = why(pushed);
  }
  throw new Error(`the push was rejected ${max} times; the draft is kept. Last: ${lastRejection}`);
}

const flag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};

const lockSeconds = (): number => {
  const raw = Number(process.env.RALPH_JOURNAL_LOCK_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCK_SECONDS;
};

const USAGE = [
  "usage: publish-journal.ts --draft <path> --issue <n|none>",
  "       publish-journal.ts --learning <draft> --scope project|harness",
  "       publish-journal.ts --revise <draft> --scope project|harness",
  "       publish-journal.ts --close <slug> --pr <n> --scope project|harness",
].join("\n");

/**
 * Which of the three things this invocation is, by its flags alone.
 *
 * Decided before the lock, so a malformed command is refused without taking a
 * machine-wide lock first, and so the error prefix says "learning" rather than
 * "journal" when that is what failed. `--scope` and `--pr` are checked there
 * too, for the same reason.
 */
export function mode(args: string[]): "journal" | "learning" | "revise" | "close" | null {
  if (flag(args, "learning") !== undefined) return "learning";
  if (flag(args, "revise") !== undefined) return "revise";
  if (flag(args, "close") !== undefined) return "close";
  if (flag(args, "draft") !== undefined || flag(args, "issue") !== undefined) return "journal";
  return null;
}

/** `--pr`, refused unless it is a positive integer: it becomes a `#<n>` link. */
function prOf(args: string[]): number {
  const raw = flag(args, "pr") ?? "";
  if (!/^[0-9]+$/.test(raw) || Number(raw) === 0) {
    throw new Error(`--pr must be a pull request number; got '${raw}'`);
  }
  return Number(raw);
}

/** `--scope`, refused unless it is one of the two. */
function scopeOf(args: string[]): LearningScope {
  const scope = flag(args, "scope");
  if (scope !== "project" && scope !== "harness") {
    throw new Error(`--scope must be 'project' or 'harness'; got '${scope ?? ""}'`);
  }
  return scope;
}

function main(args: string[]): number {
  const kind = mode(args);
  if (kind === null) {
    console.error(USAGE);
    return 2;
  }
  if (kind === "journal" && (!flag(args, "draft") || !flag(args, "issue"))) {
    console.error(USAGE);
    return 2;
  }
  if (kind === "close" && !flag(args, "pr")) {
    console.error(USAGE);
    return 2;
  }
  // Validated HERE, ahead of the lock: a command that cannot run should not
  // first take a lock every loop on the machine is waiting behind.
  if (kind !== "journal") {
    scopeOf(args);
    if (kind === "close") prOf(args);
  }

  // Serialise every publisher on the machine: they share one worktree, and the
  // learnings files are shared outright. The lock is held by `flock` around a
  // re-exec of this same script, so every mode gets it without arranging to.
  if (process.env.RALPH_JOURNAL_LOCKED !== "1") {
    // `RALPH_FINDINGS_RECORD` (default `~/.ralph/findings.json`) is resolved the
    // same way, in findings.ts: the per-host record of filed finding tickets.
    const lock = resolve(process.env.RALPH_JOURNAL_LOCK?.trim() || join(homedir(), ".ralph", "journal.lock"));
    mkdirSync(dirname(lock), { recursive: true });
    const child = spawnSync(
      "flock",
      ["-w", String(lockSeconds()), "-E", String(LOCK_TIMEOUT_STATUS), lock, process.execPath, fileURLToPath(import.meta.url), ...args],
      { stdio: "inherit", env: { ...process.env, RALPH_JOURNAL_LOCKED: "1" } },
    );
    if (child.error) {
      console.error(`${kind === "journal" ? "journal" : "learning"} not published: could not run flock (${child.error.message}); the draft is kept`);
      return 1;
    }
    if (child.status === LOCK_TIMEOUT_STATUS) {
      console.error(
        `${kind === "journal" ? "journal" : "learning"} not published: ${lock} stayed locked for ${lockSeconds()}s; the draft is kept`,
      );
      return 1;
    }
    return child.status ?? 1;
  }

  const project = projectRoot();
  let journalDir = process.env.RALPH_JOURNAL_DIR?.trim() ?? "";
  let displayName = process.env.RALPH_PROJECT_DISPLAY_NAME?.trim() ?? "";
  if (journalDir === "" || displayName === "") {
    const config = loadProjectConfig(project);
    journalDir ||= config.journal.dir;
    displayName ||= config.displayName;
  }
  const loop = process.env.RALPH_LOOP_NAME?.trim() || "ralph";
  const home = resolve(harnessLocation().home);
  const worktree = resolve(process.env.RALPH_JOURNAL_WORKTREE?.trim() || join(homedir(), ".ralph", "journal-wt"));
  // `journal.branch` moves the journal and the PROJECT learnings to the
  // project's own repository; the harness learnings never move.
  const projectSide = journalLocation(project);
  const at = (scope: LearningScope | "journal"): { home: string; branch?: string } =>
    scope !== "harness" && projectSide.projectSide ? { home: resolve(projectSide.home), branch: projectSide.branch } : { home };

  if (kind !== "journal") {
    const scope = scopeOf(args);
    const target = learningTarget(scope, { project });
    const action: LearningAction =
      kind === "learning"
        ? { kind: "entry", draft: flag(args, "learning") as string }
        : kind === "revise"
          ? { kind: "revise", draft: flag(args, "revise") as string }
          : { kind: "close", slug: flag(args, "close") as string, pr: prOf(args) };
    const learning = publishLearning({
      action,
      scope,
      loop,
      project,
      displayName,
      file: target.file,
      ...at(scope),
      worktree,
      date: new Date().toISOString().slice(0, 10),
      // Findings run on GitHub projects alone, so a Linear or Jira project has
      // nothing to misroute. `RALPH_FINDINGS_DISABLED` does not lift it: a held
      // filing is filed later by reconcile, into the same wrong repository.
      refuseFinding: (entry) => {
        if (scope === "project" && trackerKindOf(project) !== "github") return null;
        return harnessChangeRefusal(entry, { scope, projectRepo: repoOf(project), harnessRepo: repoOf(home) });
      },
      promote: (entry) => {
        if (process.env.RALPH_FINDINGS_DISABLED === "1" || !pendingFinding(entry)) return entry.text;
        const config = loadProjectConfig(scope === "harness" ? home : project);
        // Findings file GitHub issues on the project's repo, so a project whose
        // tickets live in Linear or Jira keeps the learning and files nothing.
        if (config.tracker.kind !== "github") {
          console.error(`finding not filed: ${entry.slug} — findings run on GitHub issues only, and this project's tracker is ${config.tracker.kind}`);
          return entry.text;
        }
        const where = at(scope);
        if (where.branch !== undefined) {
          return promoteFinding(entry, { repo: config.repo, file: target.file, sourceRepo: config.repo, sourceBranch: where.branch });
        }
        const sourceRepo = loadProjectConfig(home).repo;
        return promoteFinding(entry, { repo: config.repo, file: target.file, sourceRepo });
      },
    });
    // The outcome kind leads, because the caller asked for an entry and may
    // have got a 'seen again' line on one that was already there.
    console.log(
      learning.alreadyPublished
        ? `learning already ${learning.outcome}: ${learning.slug} in ${learning.path} at ${learning.sha}`
        : `learning ${learning.outcome}: ${learning.slug} in ${learning.path} at ${learning.sha}${learning.attempts > 1 ? ` (attempt ${learning.attempts})` : ""}`,
    );
    return 0;
  }

  const result = publishJournal({
    draft: flag(args, "draft") as string,
    issue: flag(args, "issue") as string,
    loop,
    project,
    displayName,
    journalDir,
    ...at("journal"),
    worktree,
  });
  console.log(
    result.alreadyPublished
      ? `journal already published: ${result.path} at ${result.sha}`
      : `journal published: ${result.path} at ${result.sha}${result.attempts > 1 ? ` (attempt ${result.attempts})` : ""}`,
  );
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    process.exitCode = main(args);
  } catch (error) {
    const what = mode(args) === "journal" ? "journal" : "learning";
    console.error(`${what} not published: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
