#!/usr/bin/env bun
/**
 * A local stand-in for GitHub's `gh` CLI, for trials that must never reach
 * GitHub.
 *
 * A sandboxed trial (issue #526, spec #525) runs a real iteration against a
 * throwaway repository whose `origin` is a local bare repo. Everything the
 * prompts and the supervisor do through `gh pr ...` has to land somewhere,
 * and that somewhere must not be GitHub: a trial that opened, labelled or
 * merged a real PR would be a loop acting on a project nobody asked it to
 * touch. So the trial puts {@link FAKE_GH_BIN} first on PATH and every PR call
 * lands in a per-trial JSON state file instead. It is also meant to replace
 * the ad-hoc `gh` stubs in `end-to-end.test.ts`, which each fake one answer.
 *
 * It fails closed. An origin that is a URL rather than a local directory, a
 * subcommand or flag it does not implement, and every `pr merge` exit 1: a
 * fake that pretended to succeed would let a trial "pass" on work that never
 * happened. The one exception is `auth status`, answered as logged in on the
 * `fake-gh.invalid` host with no state file, so `preflight.ts`'s
 * github-credentials check reads the fake as ready. It spawns `git`, `sh` (the hook commands) and `bun` (its own hook
 * runner), and never `gh`, not even by full path.
 *
 *   FAKE_GH_STATE=<file> [FAKE_GH_REPO=owner/name] [FAKE_GH_LOGIN=login]
 *   [FAKE_GH_ORIGIN=<bare repo dir>] [FAKE_GH_CHECKS_CMD=<sh command>]
 *   [FAKE_GH_FINDINGS_CMD=<sh command>] [FAKE_GH_HOOKS_SYNC=1]
 *   [FAKE_GH_REVIEW_ROUNDS=<n>] [FAKE_GH_REVIEWER=login]
 *   [FAKE_GH_FAIL=<subcommand>:<times>:<stderr>] fake-gh/gh <args...>
 *
 * Each new head of a PR's branch runs the two optional hook commands once:
 * one prints the head's checks, the other review findings. They run in a
 * detached runner, because they are a project's gates and take minutes while
 * `pr-wait.ts` kills a `gh pr view` after 30 s. Each finding becomes a review
 * thread by FAKE_GH_REVIEWER, which the real `review-threads.ts` reads and
 * answers through the few `gh api` paths it uses. While the findings command
 * runs, a `fake-gh/review` check is in progress, as the Claude review is a
 * check run on GitHub: CI never reads done before the threads are posted.
 *
 * FAKE_GH_REVIEW_ROUNDS caps a PR's review rounds, as the projects that run
 * the Claude PR review cap them in their prompts. Once that many of its heads
 * were reviewed to a result (clean or with findings) or are still under
 * review, a new head runs no findings command and its `fake-gh/review` is
 * NEUTRAL with the reason, so CI neither waits on it nor reads red. A value
 * that is not a positive integer is refused, as a bad FAKE_GH_ORIGIN is: a
 * trial that silently ran uncapped would test the wrong thing. A findings command that exits 3 reports the review unavailable: the
 * head is unreviewed, not clean and not failed, its check NEUTRAL with the
 * command's last stderr line, and it does not count as a round.
 *
 * FAKE_GH_FAIL makes one subcommand fail on demand, so a test can drive a
 * caller's throttle handling (GitHub answering `API rate limit already
 * exceeded` while quota remains, #658) without reaching GitHub. The
 * subcommand is the first two words, `repo view` or `pr list`, or `api
 * <endpoint>` such as `api graphql`, matched on the endpoint argument wherever
 * gh's flags put it. The first <times> calls of it (a non-negative integer, or
 * `always`/`*` for every call) print <stderr> verbatim and exit 1 without
 * touching the state; later calls behave normally. Each `gh` call is a new
 * process, so the count lives in `<state>.fail-count` beside the state file,
 * inside the trial root its teardown removes. `0` is accepted and fails
 * nothing, so a test can switch the setting off without unsetting it. A
 * malformed value is refused, as a bad FAKE_GH_ORIGIN is: a trial that
 * silently never failed would test nothing.
 *
 * A head is noticed when a gh call reads its PR, so two pushes between reads
 * run the hooks only for the latter. That is CI-like: the latest head is the
 * one that gets judged.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The shim directory: `PATH=${FAKE_GH_BIN}:${PATH}` makes `gh` this fake. */
export const FAKE_GH_BIN = fileURLToPath(new URL("./fake-gh", import.meta.url));

const DEFAULT_REPO = "trial/sandbox";
const DEFAULT_LOGIN = "ralph-trial";
/** The host `auth status` claims a login on: never github.com, so nothing reads it as a real credential. */
const FAKE_HOST = "fake-gh.invalid";
/** The client repos' Claude PR review posts as this app. */
const DEFAULT_REVIEWER = "revision-claude";

interface Comment {
  author: { login: string };
  body: string;
  createdAt: string;
  url: string;
}

type Conclusion = "SUCCESS" | "FAILURE" | "NEUTRAL" | "SKIPPED" | "CANCELLED" | "TIMED_OUT";

const CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "FAILURE", "NEUTRAL", "SKIPPED", "CANCELLED", "TIMED_OUT"]);
const FAILING: ReadonlySet<string> = new Set(["FAILURE", "CANCELLED", "TIMED_OUT"]);

/** One check as the checks command printed it. */
interface StoredCheck {
  name: string;
  conclusion: Conclusion;
  detailsUrl?: string;
  summary?: string;
  /** The tests this check forgave because the trial's base already failed them (`base-red.ts`, #579). */
  baseRed?: string[];
}

/** One review finding, kept field for field: each becomes a review thread. */
interface Finding {
  path: string;
  line: number | null;
  priority: "P1" | "P2" | "P3" | null;
  title: string;
  body: string;
}

/**
 * One head sha the fake has seen, and what its hooks produced. Everything
 * past `seenAt` is optional: a head that ran no hooks has none of it.
 */
interface Head {
  sha: string;
  seenAt: string;
  /** `none`: no hook configured. `failed`: the runner died; never re-run. */
  hooks?: "none" | "running" | "done" | "failed";
  runnerPid?: number | null;
  error?: string | null;
  checksCmd?: string | null;
  findingsCmd?: string | null;
  /** null while a configured checks command has not finished. */
  checks?: StoredCheck[] | null;
  checksCompletedAt?: string | null;
  findings?: Finding[] | null;
  findingsError?: string | null;
  findingsCompletedAt?: string | null;
  /** Why the findings command never ran: the PR's review round cap was reached. */
  reviewSkipped?: string | null;
  /** Why the findings command could not review (it exited 3): the head is unreviewed. */
  reviewUnavailable?: string | null;
}

/** One comment of a review thread; the first is the finding, the rest replies. */
interface ReviewComment {
  databaseId: number;
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

/**
 * A review thread, tied to the head whose findings opened it. `isOutdated` is
 * not stored: it is computed against the PR's current head on every read.
 */
interface StoredThread {
  id: number;
  headSha: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  comments: ReviewComment[];
}

interface PullRequest {
  number: number;
  title: string;
  body: string;
  base: string;
  head: string;
  headRefOid: string;
  draft: boolean;
  labels: string[];
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  closedAt: string | null;
  author: string;
  comments: Comment[];
  heads: Head[];
  reviewThreads: StoredThread[];
}

interface MergeAttempt {
  at: string;
  /** The PR number the selector resolved to; null when nothing resolved. */
  pr: number | null;
  argv: string[];
}

interface State {
  version: 1;
  repo: string;
  nextNumber: number;
  /** The next comment or thread id: one counter, so no two ever collide. */
  nextId: number;
  prs: PullRequest[];
  mergeAttempts: MergeAttempt[];
}

/** A refusal: printed as `fake gh: <message>` and exit 1. */
class Refusal extends Error {}

interface Context {
  env: NodeJS.ProcessEnv;
  cwd: string;
  argv: string[];
  repo: string;
  login: string;
  statePath: string;
  out: string[];
  exitCode: number;
  /**
   * The hook runner: it waits long for the lock, because a lost write is a
   * lost gate result, and never creates the trial's directory, which a
   * teardown may have removed under it.
   */
  runner: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

// ---------------------------------------------------------------------------
// git

function git(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? "").trim() };
}

/**
 * The trial's origin, as a local directory. Fails closed: a URL, or a path
 * that is not there, means the trial may be wired to GitHub, and a fake PR
 * against it would hide that.
 */
function originDir(ctx: Context): string {
  let raw = ctx.env.FAKE_GH_ORIGIN;
  if (raw === undefined || raw === "") {
    const remote = git(["-C", ctx.cwd, "remote", "get-url", "origin"]);
    if (!remote.ok || remote.stdout === "") throw new Refusal("origin is not local: no FAKE_GH_ORIGIN and no `origin` remote");
    raw = remote.stdout;
  }
  if (raw.startsWith("file://")) raw = raw.slice("file://".length);
  if (raw.includes("://") || /^[^/]*@[^:/]+:/.test(raw)) throw new Refusal(`origin is not local: ${raw}`);
  const dir = resolve(ctx.cwd, raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Refusal(`origin is not local: ${raw} does not exist`);
  return dir;
}

function originSha(origin: string, branch: string): string | null {
  const result = git(["--git-dir", origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

/** The bare origin's HEAD branch, when it exists; `main` otherwise. */
function defaultBranch(origin: string): string {
  const head = git(["--git-dir", origin, "symbolic-ref", "--short", "HEAD"]);
  return head.ok && head.stdout !== "" && originSha(origin, head.stdout) !== null ? head.stdout : "main";
}

function currentBranch(ctx: Context): string | null {
  const result = git(["-C", ctx.cwd, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

// ---------------------------------------------------------------------------
// state: read-modify-write under a lock, written atomically

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else, so it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The pid a stale lock was left by, or null when it is not stale. A lock with
 * no pid file yet is fresh (taken between mkdir and write) unless it is old;
 * then it is stale with pid 0.
 */
function stalePid(lock: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(lock, "pid"), "utf8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0) return pidAlive(pid) ? null : pid;
  } catch {
    // No pid file: judged by age below.
  }
  try {
    return Date.now() - statSync(lock).mtimeMs > 5_000 ? 0 : null;
  } catch {
    return null;
  }
}

function lockPid(dir: string): number {
  try {
    const pid = Number.parseInt(readFileSync(join(dir, "pid"), "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * Break a stale lock by renaming it aside, never by removing it in place: of
 * two waiters that both judged it stale, only one rename succeeds, so the
 * other cannot remove the fresh lock the first has meanwhile taken.
 */
function breakStaleLock(lock: string, dead: number): void {
  const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, aside);
  } catch {
    // ENOENT: another waiter broke it first; the caller retries.
    return;
  }
  if (lockPid(aside) === dead) {
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  // The lock was re-taken between the judgement and the rename: hand it back.
  if (!existsSync(lock)) {
    try {
      renameSync(aside, lock);
    } catch {
      // Lost to a third waiter; the holder's own cleanup is all that is left.
    }
  }
}

/**
 * Run `fn` holding `<state>.lock`. Readers take it too, so a reader never
 * sees a half-written file even on a filesystem where rename is not atomic.
 */
function withLock<T>(statePath: string, fn: () => T, options: { waitMs?: number; createDir?: boolean } = {}): T {
  const lock = `${statePath}.lock`;
  const waitMs = options.waitMs ?? 10_000;
  if (options.createDir !== false) mkdirSync(dirname(statePath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let backoff = 5;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Refusal(`state directory ${dirname(statePath)} is gone: the trial was torn down`);
      if (code !== "EEXIST") throw error;
    }
    const dead = stalePid(lock);
    if (dead !== null) {
      breakStaleLock(lock, dead);
      continue;
    }
    if (Date.now() >= deadline) throw new Refusal(`state lock ${lock} still held after ${Math.round(waitMs / 1000)}s`);
    sleepMs(backoff);
    backoff = Math.min(backoff * 2, 100);
  }
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** The lock as `ctx` takes it: the runner waits 120 s and creates nothing. */
function lockFor<T>(ctx: Context, fn: () => T): T {
  return withLock(ctx.statePath, fn, ctx.runner ? { waitMs: 120_000, createDir: false } : {});
}

function readState(ctx: Context): State {
  // The runner must never write a fresh state file into a torn-down trial.
  if (!existsSync(ctx.statePath) && ctx.runner) throw new Refusal(`state file ${ctx.statePath} is gone: the trial was torn down`);
  if (!existsSync(ctx.statePath)) return { version: 1, repo: ctx.repo, nextNumber: 1, nextId: 1, prs: [], mergeAttempts: [] };
  let parsed: State;
  try {
    parsed = JSON.parse(readFileSync(ctx.statePath, "utf8")) as State;
  } catch (error) {
    throw new Refusal(`state file ${ctx.statePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.prs)) throw new Refusal(`state file ${ctx.statePath} is not a version 1 fake gh state`);
  return parsed;
}

function writeState(ctx: Context, state: State): void {
  const temp = `${ctx.statePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, ctx.statePath);
}

function readOnly<T>(ctx: Context, fn: (state: State) => T): T {
  return lockFor(ctx, () => fn(readState(ctx)));
}

function update<T>(ctx: Context, fn: (state: State) => T): T {
  return lockFor(ctx, () => {
    const state = readState(ctx);
    const result = fn(state);
    writeState(ctx, state);
    return result;
  });
}

// ---------------------------------------------------------------------------
// head sync and hooks

const SELF = fileURLToPath(import.meta.url);
const RUNNER_DIED = "hook runner died";

/** A head whose hooks run inline, after the sync's lock is released. */
interface Launch {
  number: number;
  sha: string;
  env: NodeJS.ProcessEnv;
}

function findHead(state: State, number: number, sha: string): Head | undefined {
  return state.prs.find((p) => p.number === number)?.heads.find((h) => h.sha === sha);
}

function hookLog(statePath: string, number: number, sha: string): string {
  const dir = `${statePath}.hooks`;
  mkdirSync(dir, { recursive: true });
  return join(dir, `${number}-${sha}.log`);
}

/**
 * Whether a runner pid still runs. A zombie counts as dead: a killed runner
 * whose reaper has not collected it yet still answers `kill -0`.
 */
function runnerAlive(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    // No /proc (not Linux): trust kill -0.
    return true;
  }
}

/** Record a dead runner as failed. Its commands are never re-run, so each still runs once per head. */
function failHooks(head: Head, error: string): void {
  head.hooks = "failed";
  head.error = error;
  if (head.checksCmd && head.checks == null) {
    head.checks = [{ name: "fake-gh/hooks", conclusion: "FAILURE", summary: error }];
    head.checksCompletedAt = now();
  }
  if (head.findingsCmd && head.findings == null && head.findingsError == null && head.reviewUnavailable == null) {
    head.findingsError = error;
    head.findingsCompletedAt = now();
  }
}

/**
 * Kill every hook runner recorded on a running head, by process group so its
 * hook commands go too, and mark those heads failed. For a sandbox's
 * teardown: a runner must not outlive its trial. Returns how many it killed.
 */
export function stopHookRunners(statePath: string): number {
  if (!existsSync(statePath)) return 0;
  return withLock(statePath, () => {
    const ctx = { statePath, runner: false } as Context;
    const state = readState(ctx);
    let killed = 0;
    for (const pr of state.prs) {
      for (const head of pr.heads) {
        if (head.hooks !== "running" || typeof head.runnerPid !== "number") continue;
        try {
          process.kill(-head.runnerPid, "SIGKILL");
          killed += 1;
        } catch {
          // Already gone; still marked failed below.
        }
        failHooks(head, "stopped");
      }
    }
    writeState(ctx, state);
    return killed;
  });
}

/** FAKE_GH_REVIEW_ROUNDS: null when unset; anything but a positive integer is refused. */
function reviewRounds(ctx: Context): number | null {
  const raw = ctx.env.FAKE_GH_REVIEW_ROUNDS;
  if (raw === undefined || raw === "") return null;
  if (!/^[1-9]\d*$/.test(raw)) throw new Refusal(`FAKE_GH_REVIEW_ROUNDS must be a positive integer, not ${raw}`);
  return Number(raw);
}

/** A head whose findings command is still running: no result, no error, not unavailable. */
function reviewRunning(head: Head): boolean {
  return !!head.findingsCmd && head.hooks === "running" && head.findings == null && head.findingsError == null && head.reviewUnavailable == null;
}

/**
 * Start `head`'s hooks. Detached by default, so the gh call that saw the head
 * returns at once; the runner pid is recorded under the same lock, so a later
 * sync can tell a dead runner from a slow one. FAKE_GH_HOOKS_SYNC=1 queues
 * them in `inline` instead, for tests that want the result on the next line.
 */
function startHooks(ctx: Context, pr: PullRequest, head: Head, origin: string, baseSha: string | null, inline: Launch[]): void {
  const cap = reviewRounds(ctx);
  head.checksCmd = ctx.env.FAKE_GH_CHECKS_CMD || null;
  head.findingsCmd = ctx.env.FAKE_GH_FINDINGS_CMD || null;
  head.checks = null;
  head.findings = null;
  head.findingsError = null;
  head.findingsCompletedAt = null;
  head.reviewSkipped = null;
  head.reviewUnavailable = null;
  // Heads reviewed to a result are rounds, and so is a head whose review is
  // still running: it will be one, and two pushes inside a slow review must
  // not both slip under the cap. A capped or unavailable head was never
  // reviewed, and a failed one never produced a review either.
  const rounds = pr.heads.filter((h) => h !== head && (h.findings != null || reviewRunning(h))).length;
  if (head.findingsCmd !== null && cap !== null && rounds >= cap) {
    head.findingsCmd = null;
    head.reviewSkipped = `round cap ${cap} reached`;
    head.findingsCompletedAt = now();
  }
  head.checksCompletedAt = null;
  head.error = null;
  head.runnerPid = null;
  if (head.checksCmd === null && head.findingsCmd === null) {
    head.hooks = "none";
    return;
  }
  head.hooks = "running";
  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    FAKE_GH_PR: String(pr.number),
    FAKE_GH_HEAD_SHA: head.sha,
    FAKE_GH_HEAD_REF: pr.head,
    FAKE_GH_BASE_REF: pr.base,
    FAKE_GH_BASE_SHA: baseSha ?? "",
    FAKE_GH_ORIGIN: origin,
    FAKE_GH_REPO: ctx.repo,
  };
  if (ctx.env.FAKE_GH_HOOKS_SYNC === "1") {
    head.runnerPid = process.pid;
    inline.push({ number: pr.number, sha: head.sha, env });
    return;
  }
  const log = openSync(hookLog(ctx.statePath, pr.number, head.sha), "a");
  try {
    const child = spawn(process.execPath, [SELF, "__run-hooks", ctx.statePath, String(pr.number), head.sha], {
      cwd: ctx.cwd,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    // A spawn failure surfaces as an event after this call returns; without a
    // listener it would crash the gh call instead of failing the hooks.
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) failHooks(head, "could not start the hook runner");
    else head.runnerPid = child.pid;
  } finally {
    closeSync(log);
  }
}

/**
 * Bring `pr` up to origin: a new sha on its head branch is a new head, with
 * its own hooks. A closed PR keeps what it had; so does a PR whose branch was
 * deleted from origin. `shas` holds origin's branch tips, read before the
 * lock was taken, so no git runs while other gh calls wait on it.
 */
function syncPr(ctx: Context, pr: PullRequest, inline: Launch[], origin: string, shas: Map<string, string | null>): boolean {
  if (pr.state !== "OPEN") return false;
  let changed = false;
  for (const head of pr.heads) {
    if (head.hooks === "running" && typeof head.runnerPid === "number" && !runnerAlive(head.runnerPid)) {
      failHooks(head, RUNNER_DIED);
      changed = true;
    }
  }
  const sha = shas.get(pr.head) ?? null;
  if (sha === null || sha === pr.heads.at(-1)?.sha) return changed;
  const head: Head = { sha, seenAt: now() };
  pr.heads.push(head);
  pr.headRefOid = sha;
  startHooks(ctx, pr, head, origin, shas.get(pr.base) ?? null, inline);
  return true;
}

/** Sync the PRs `pick` chooses, writing the state only when something moved. */
function syncPrs(ctx: Context, pick: (state: State) => PullRequest[]): void {
  const branches = readOnly(ctx, (state) => pick(state).filter((p) => p.state === "OPEN").flatMap((p) => [p.head, p.base]));
  if (branches.length === 0) return;
  const origin = originDir(ctx);
  const shas = new Map([...new Set(branches)].map((b) => [b, originSha(origin, b)] as const));
  const inline: Launch[] = [];
  lockFor(ctx, () => {
    const state = readState(ctx);
    let changed = false;
    for (const pr of pick(state)) changed = syncPr(ctx, pr, inline, origin, shas) || changed;
    if (changed) writeState(ctx, state);
  });
  runLaunches(ctx, inline);
}

/**
 * A selector with "the current branch" made explicit, so that `git` runs
 * before the lock rather than under it.
 */
function resolveSelector(ctx: Context, selector: string | undefined): string {
  if (selector !== undefined) return selector;
  const branch = currentBranch(ctx);
  if (branch === null) throw new Refusal("could not determine current branch: not on any branch");
  return branch;
}

function syncOne(ctx: Context, selector: string | undefined): void {
  const resolved = resolveSelector(ctx, selector);
  syncPrs(ctx, (state) => [findPr(ctx, state, resolved)]);
}

function runLaunches(ctx: Context, launches: Launch[]): void {
  for (const launch of launches) runHooks(ctx, launch.number, launch.sha, launch.env, ctx.cwd);
}

interface HookRun {
  ok: boolean;
  stdout: string;
  error: string;
  /** The exit status; null when the command never ran or died by a signal. */
  status: number | null;
  /** The last non-empty stderr line, the reason a findings command gives for exit 3. */
  lastStderr: string;
}

/** The exit status that means "the review could not run", as `local-review.ts --fake-gh-findings` uses it. */
const FINDINGS_UNAVAILABLE = 3;

function lastLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";
}

/**
 * One hook command via `sh -c`, its stderr into the head's log, never the gh
 * call's. Only the findings command captures it (`captureStderr`), for the
 * last line an unavailable review gives as its reason: a captured stderr is a
 * pipe, and a gate that leaves a background process holding it (a leaked dev
 * server) would keep the run from ever ending. A checks command writes
 * straight to the log, as its gates run `>&2`.
 */
function runHook(command: string, env: NodeJS.ProcessEnv, cwd: string, log: number, captureStderr: boolean): HookRun {
  const result = spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", captureStderr ? "pipe" : log], maxBuffer: 64 * 1024 * 1024 });
  const stderr = result.stderr ?? "";
  if (stderr !== "") writeSync(log, stderr);
  const lastStderr = lastLine(stderr);
  if (result.error) return { ok: false, stdout: "", error: result.error.message, status: null, lastStderr };
  if (result.status !== 0) return { ok: false, stdout: result.stdout ?? "", error: `exited ${result.status ?? result.signal}`, status: result.status, lastStderr };
  return { ok: true, stdout: result.stdout ?? "", error: "", status: 0, lastStderr };
}

/** {@link runHook} without blocking, so the runner can wait on both commands at once. */
function runHookAsync(command: string, env: NodeJS.ProcessEnv, cwd: string, log: number, captureStderr: boolean): Promise<HookRun> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", captureStderr ? "pipe" : log] });
    const chunks: Buffer[] = [];
    // Only the tail is kept: the log has the rest, and the reason is the last line.
    let tail = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      writeSync(log, chunk);
      tail = (tail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (error) => done({ ok: false, stdout: "", error: error.message, status: null, lastStderr: lastLine(tail) }));
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      const lastStderr = lastLine(tail);
      done(code === 0 ? { ok: true, stdout, error: "", status: 0, lastStderr } : { ok: false, stdout, error: `exited ${code ?? signal}`, status: code, lastStderr });
    });
  });
}

function parseHookJson(run: HookRun): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (!run.ok) return { ok: false, error: run.error };
  let value: unknown;
  try {
    value = JSON.parse(run.stdout);
  } catch (error) {
    return { ok: false, error: `unparseable stdout: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(value)) return { ok: false, error: "stdout is not a JSON array" };
  return { ok: true, value };
}

/**
 * The checks command's result. A failure is one FAILURE check, never "no
 * checks": a gate that crashed must not read as a project without gates.
 */
function checksFrom(run: HookRun): StoredCheck[] {
  const fail = (summary: string): StoredCheck[] => [{ name: "fake-gh/checks", conclusion: "FAILURE", summary }];
  const parsed = parseHookJson(run);
  if (!parsed.ok) return fail(`checks command failed: ${parsed.error}`);
  const checks: StoredCheck[] = [];
  for (const [i, raw] of parsed.value.entries()) {
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { name, conclusion, detailsUrl, summary, baseRed } = entry;
    if (typeof name !== "string" || name === "" || typeof conclusion !== "string" || !CONCLUSIONS.has(conclusion)) {
      return fail(`checks command printed entry ${i} without a valid name and conclusion`);
    }
    const check: StoredCheck = { name, conclusion: conclusion as Conclusion };
    if (typeof detailsUrl === "string") check.detailsUrl = detailsUrl;
    if (typeof summary === "string") check.summary = summary;
    // Kept only as a list of test names: anything else is dropped, and the check still counts.
    if (Array.isArray(baseRed) && baseRed.every((test) => typeof test === "string")) check.baseRed = baseRed as string[];
    checks.push(check);
  }
  return checks;
}

const PRIORITIES: ReadonlySet<unknown> = new Set(["P1", "P2", "P3", null]);
const BADGE_COLOURS: Record<string, string> = { P1: "red", P2: "orange", P3: "yellow" };

/**
 * The findings command's entries, validated whole: one bad entry rejects them
 * all, so a malformed review never half-posts its threads.
 */
function findingsFrom(value: unknown[]): { ok: true; findings: Finding[] } | { ok: false; error: string } {
  const findings: Finding[] = [];
  for (const [i, raw] of value.entries()) {
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { path, line, priority, title, body } = entry;
    if (
      typeof path !== "string" ||
      path === "" ||
      !(line === null || Number.isInteger(line)) ||
      !PRIORITIES.has(priority) ||
      typeof title !== "string" ||
      typeof body !== "string"
    ) {
      return { ok: false, error: `entry ${i} is not a valid finding: it needs a path, an integer or null line, a P1-P3 or null priority, a title and a body` };
    }
    findings.push({ path, line: line as number | null, priority: priority as Finding["priority"], title, body });
  }
  return { ok: true, findings };
}

/** Every id in the state file, comment or thread, comes from this one counter. */
function allocateId(state: State): number {
  const id = state.nextId;
  state.nextId = id + 1;
  return id;
}

/** A conversation comment's id, which its url carries. */
function issueCommentId(comment: Comment): number {
  return Number(/#issuecomment-(\d+)$/.exec(comment.url)?.[1] ?? 0);
}

function reviewComment(ctx: Context, state: State, pr: PullRequest, author: string, body: string): ReviewComment {
  const databaseId = allocateId(state);
  return { databaseId, author, body, url: `${prUrl(ctx.repo, pr.number)}#discussion_r${databaseId}`, createdAt: now() };
}

/**
 * One thread per finding, in the format the Claude PR review posts: the
 * shields.io badge with its alt text empty, then the bold title and the body.
 */
function postThreads(ctx: Context, state: State, number: number, sha: string, findings: Finding[]): void {
  const pr = state.prs.find((p) => p.number === number);
  if (pr === undefined) return;
  const reviewer = ctx.env.FAKE_GH_REVIEWER || DEFAULT_REVIEWER;
  for (const finding of findings) {
    const badge = finding.priority === null ? "" : `![](https://img.shields.io/badge/${finding.priority}-${BADGE_COLOURS[finding.priority]}?style=flat) `;
    const body = `${badge}**${finding.title}**\n\n${finding.body}`;
    const id = allocateId(state);
    pr.reviewThreads.push({ id, headSha: sha, path: finding.path, line: finding.line, isResolved: false, comments: [reviewComment(ctx, state, pr, reviewer, body)] });
  }
}

/** Only a head still running takes a result: one marked failed meanwhile keeps its verdict. */
function record(ctx: Context, number: number, sha: string, fn: (h: Head, state: State) => void): void {
  update(ctx, (state) => {
    const h = findHead(state, number, sha);
    if (h?.hooks === "running") fn(h, state);
  });
}

function recordChecks(ctx: Context, number: number, sha: string, run: HookRun): void {
  const checks = checksFrom(run);
  record(ctx, number, sha, (h) => {
    h.checks = checks;
    h.checksCompletedAt = now();
  });
}

/**
 * The threads post under the same lock that stores the findings, so no
 * reader sees `fake-gh/review` completed before its threads exist. Exit 3 is
 * an unreviewed head: no findings, no threads, and no failure either.
 */
function recordFindings(ctx: Context, number: number, sha: string, run: HookRun): void {
  const parsed = parseHookJson(run);
  const valid = parsed.ok ? findingsFrom(parsed.value) : parsed;
  record(ctx, number, sha, (h, state) => {
    if (run.status === FINDINGS_UNAVAILABLE) {
      h.reviewUnavailable = run.lastStderr || `findings command reported unavailable (exit ${FINDINGS_UNAVAILABLE})`;
    } else if (valid.ok) {
      h.findings = valid.findings;
      postThreads(ctx, state, number, sha, valid.findings);
    } else h.findingsError = `findings command failed: ${valid.error}`;
    h.findingsCompletedAt = now();
  });
}

function finishHooks(ctx: Context, number: number, sha: string): void {
  record(ctx, number, sha, (h) => {
    h.hooks = "done";
  });
}

/**
 * Run `<pr>@<sha>`'s hooks inline (FAKE_GH_HOOKS_SYNC=1): checks, then
 * findings. The lock is held only to read the head and to write each result,
 * never while a command runs.
 */
function runHooks(ctx: Context, number: number, sha: string, env: NodeJS.ProcessEnv, cwd: string): void {
  const head = readOnly(ctx, (state) => findHead(state, number, sha));
  if (head === undefined || head.hooks !== "running") return;
  const log = openSync(hookLog(ctx.statePath, number, sha), "a");
  try {
    if (head.checksCmd) recordChecks(ctx, number, sha, runHook(head.checksCmd, env, cwd, log, false));
    if (head.findingsCmd) recordFindings(ctx, number, sha, runHook(head.findingsCmd, env, cwd, log, true));
    finishHooks(ctx, number, sha);
  } finally {
    closeSync(log);
  }
}

/**
 * The detached runner: both commands at once, each recorded as it finishes,
 * as a project's CI and its review run side by side on GitHub.
 */
async function runHooksDetached(ctx: Context, number: number, sha: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const head = readOnly(ctx, (state) => findHead(state, number, sha));
  if (head === undefined || head.hooks !== "running") return;
  const log = openSync(hookLog(ctx.statePath, number, sha), "a");
  try {
    const { checksCmd, findingsCmd } = head;
    await Promise.all([
      checksCmd ? runHookAsync(checksCmd, env, cwd, log, false).then((run) => recordChecks(ctx, number, sha, run)) : undefined,
      findingsCmd ? runHookAsync(findingsCmd, env, cwd, log, true).then((run) => recordFindings(ctx, number, sha, run)) : undefined,
    ]);
    finishHooks(ctx, number, sha);
  } finally {
    closeSync(log);
  }
}

/** The CURRENT head, whose checks every surface reports. */
function currentHead(pr: PullRequest): Head | undefined {
  return pr.heads.find((h) => h.sha === pr.headRefOid);
}

interface CheckRun {
  __typename: "CheckRun";
  name: string;
  status: "COMPLETED" | "IN_PROGRESS";
  conclusion: Conclusion | null;
  detailsUrl: string;
  startedAt: string;
  completedAt: string | null;
  summary: string;
}

/**
 * The current head's checks. A checks command still running is one
 * IN_PROGRESS check, so `judgeCi` waits instead of reading "no checks"; a
 * findings command is the `fake-gh/review` check, so CI never reads done
 * while the review is still being written.
 */
function checkRuns(pr: PullRequest): CheckRun[] {
  const head = currentHead(pr);
  if (head === undefined) return [];
  const runs: CheckRun[] = [];
  if (head.checksCmd && head.checks == null) {
    runs.push({ __typename: "CheckRun", name: "fake-gh/checks", status: "IN_PROGRESS", conclusion: null, detailsUrl: "", startedAt: head.seenAt, completedAt: null, summary: "" });
  } else if (head.checksCmd && head.checks) {
    runs.push(
      ...head.checks.map((c): CheckRun => ({
        __typename: "CheckRun",
        name: c.name,
        status: "COMPLETED",
        conclusion: c.conclusion,
        detailsUrl: c.detailsUrl ?? "",
        startedAt: head.seenAt,
        completedAt: head.checksCompletedAt ?? head.seenAt,
        summary: c.summary ?? "",
      })),
    );
  }
  if (head.findingsCmd || head.reviewSkipped) {
    // A capped or unavailable review is NEUTRAL, which pr-wait reads as a
    // skip: it must neither hold the wait nor read as red.
    const neutral = head.reviewSkipped ?? head.reviewUnavailable ?? null;
    const done = head.findings != null || head.findingsError != null || neutral !== null;
    runs.push({
      __typename: "CheckRun",
      name: "fake-gh/review",
      status: done ? "COMPLETED" : "IN_PROGRESS",
      conclusion: done ? (head.findingsError != null ? "FAILURE" : neutral !== null ? "NEUTRAL" : "SUCCESS") : null,
      detailsUrl: "",
      startedAt: head.seenAt,
      completedAt: done ? (head.findingsCompletedAt ?? head.seenAt) : null,
      summary: head.findingsError ?? neutral ?? "",
    });
  }
  return runs;
}

function rollup(pr: PullRequest): Omit<CheckRun, "summary">[] {
  return checkRuns(pr).map(({ summary: _summary, ...run }) => run);
}

/** Whether base and head conflict, by a merge in the bare origin that writes no ref. */
function conflicting(ctx: Context, pr: PullRequest): boolean {
  const origin = originDir(ctx);
  const base = originSha(origin, pr.base);
  if (base === null) return false;
  // merge-tree exits 0 when clean and 1 on a conflict. Anything else (a git
  // too old for --write-tree, a missing object) is no evidence either way, and
  // reading it as clean would let a conflicting PR look mergeable.
  const result = spawnSync("git", ["--git-dir", origin, "merge-tree", "--write-tree", base, pr.headRefOid], { encoding: "utf8", timeout: 30_000 });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Refusal(`git merge-tree exited ${result.status ?? result.signal ?? result.error?.message}: ${(result.stderr ?? "").trim()}`);
}

function mergeStateStatus(ctx: Context, pr: PullRequest): string {
  if (conflicting(ctx, pr)) return "DIRTY";
  const blocked = checkRuns(pr).some((c) => c.status !== "COMPLETED" || (c.conclusion !== null && FAILING.has(c.conclusion)));
  return blocked ? "BLOCKED" : "CLEAN";
}

// ---------------------------------------------------------------------------
// flags

interface FlagSpec {
  /** Canonical long name, without dashes. */
  name: string;
  short?: string;
  kind: "value" | "list" | "bool";
}

interface Parsed {
  positional: string[];
  values: Map<string, string>;
  lists: Map<string, string[]>;
  bools: Set<string>;
}

const REPO_FLAG: FlagSpec = { name: "repo", short: "R", kind: "value" };

/**
 * Parse `args` against `specs`. An unknown flag is refused rather than
 * ignored: a flag silently dropped is a fake pretending to have done it.
 */
function parseFlags(ctx: Context, args: string[], specs: FlagSpec[]): Parsed {
  const parsed: Parsed = { positional: [], values: new Map(), lists: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-") || arg === "-") {
      parsed.positional.push(arg);
      continue;
    }
    let key = arg;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      key = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const spec = specs.find((s) => key === `--${s.name}` || (s.short !== undefined && key === `-${s.short}`));
    if (spec === undefined) throw unsupported(ctx);
    if (spec.kind === "bool") {
      if (inline !== undefined) throw unsupported(ctx);
      parsed.bools.add(spec.name);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new Refusal(`flag needs an argument: ${key}`);
    if (spec.kind === "value") parsed.values.set(spec.name, value);
    else {
      const list = parsed.lists.get(spec.name) ?? [];
      list.push(...value.split(",").map((v) => v.trim()).filter((v) => v !== ""));
      parsed.lists.set(spec.name, list);
    }
  }
  return parsed;
}

function unsupported(ctx: Context): Refusal {
  return new Refusal(`unsupported: gh ${ctx.argv.join(" ")}`);
}

function checkRepo(ctx: Context, parsed: Parsed): void {
  const repo = parsed.values.get("repo");
  if (repo !== undefined && repo !== ctx.repo) throw new Refusal(`--repo ${repo} is not the fake's repo ${ctx.repo}`);
}

function readBody(parsed: Parsed, ctx: Context): string | undefined {
  const file = parsed.values.get("body-file");
  if (file !== undefined) return readFileSync(file === "-" ? 0 : resolve(ctx.cwd, file), "utf8");
  return parsed.values.get("body");
}

// ---------------------------------------------------------------------------
// --json and --jq

const PR_FIELDS: Record<string, (pr: PullRequest, ctx: Context) => unknown> = {
  number: (pr) => pr.number,
  title: (pr) => pr.title,
  body: (pr) => pr.body,
  state: (pr) => pr.state,
  url: (pr, ctx) => prUrl(ctx.repo, pr.number),
  isDraft: (pr) => pr.draft,
  author: (pr) => ({ login: pr.author }),
  headRefName: (pr) => pr.head,
  headRefOid: (pr) => pr.headRefOid,
  baseRefName: (pr) => pr.base,
  labels: (pr) => pr.labels.map((name) => ({ name })),
  // Nothing merges in a trial.
  mergedAt: () => null,
  closedAt: (pr) => pr.closedAt,
  createdAt: (pr) => pr.createdAt,
  comments: (pr) => pr.comments,
  mergeable: (pr, ctx) => (conflicting(ctx, pr) ? "CONFLICTING" : "MERGEABLE"),
  mergeStateStatus: (pr, ctx) => mergeStateStatus(ctx, pr),
  statusCheckRollup: (pr) => rollup(pr),
  reviewDecision: () => "",
};

function fieldList(raw: string, known: Record<string, unknown>): string[] {
  const fields = raw.split(",").map((f) => f.trim()).filter((f) => f !== "");
  for (const field of fields) {
    if (!Object.hasOwn(known, field)) throw new Refusal(`Unknown JSON field: "${field}"`);
  }
  return fields;
}

function project(pr: PullRequest, ctx: Context, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = PR_FIELDS[field]?.(pr, ctx);
  return out;
}

type JqStep = { kind: "field"; name: string } | { kind: "each" } | { kind: "index"; index: number };

/**
 * The `--jq` subset the prompts use: `.`, `.a.b`, `.[]`, `.[N]` and chains of
 * them. Done here rather than by spawning `jq`, so the fake adds no binary
 * to what it spawns; anything outside the subset is refused, not guessed at.
 */
function parseJq(expr: string): JqStep[] {
  const source = expr.trim();
  if (source === ".") return [];
  const steps: JqStep[] = [];
  const token = /^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\.?\[\]|\.?\[(\d+)\])/;
  let rest = source;
  if (!rest.startsWith(".")) throw new Refusal(`unsupported --jq expression: ${expr}`);
  while (rest !== "") {
    const match = token.exec(rest);
    if (match === null) throw new Refusal(`unsupported --jq expression: ${expr}`);
    if (match[1] !== undefined) steps.push({ kind: "field", name: match[1] });
    else if (match[2] !== undefined) steps.push({ kind: "index", index: Number(match[2]) });
    else steps.push({ kind: "each" });
    rest = rest.slice(match[0].length);
    // `.[]` may only open the chain; later brackets follow a name without a dot.
    if (rest.startsWith(".[")) throw new Refusal(`unsupported --jq expression: ${expr}`);
  }
  return steps;
}

function runJq(expr: string, input: unknown): unknown[] {
  let stream: unknown[] = [input];
  for (const step of parseJq(expr)) {
    const next: unknown[] = [];
    for (const value of stream) {
      if (step.kind === "field") {
        if (value === null) next.push(null);
        else if (typeof value === "object" && !Array.isArray(value)) next.push((value as Record<string, unknown>)[step.name] ?? null);
        else throw new Refusal(`jq: cannot index ${Array.isArray(value) ? "array" : typeof value} with "${step.name}"`);
      } else if (step.kind === "index") {
        if (value === null) next.push(null);
        else if (Array.isArray(value)) next.push(value[step.index] ?? null);
        else throw new Refusal(`jq: cannot index ${typeof value} with number`);
      } else if (Array.isArray(value)) next.push(...value);
      else if (typeof value === "object" && value !== null) next.push(...Object.values(value));
      else throw new Refusal(`jq: cannot iterate over ${value === null ? "null" : typeof value}`);
    }
    stream = next;
  }
  return stream;
}

/** Print like gh: `--jq` results one per line, strings raw; else pretty JSON. */
function emitJson(ctx: Context, value: unknown, jq: string | undefined): void {
  if (jq === undefined) {
    ctx.out.push(JSON.stringify(value, null, 2));
    return;
  }
  for (const result of runJq(jq, value)) ctx.out.push(typeof result === "string" ? result : JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// PR selection

/**
 * Resolve a selector the way gh does: a number, a PR url, or a head branch;
 * no selector means the PR whose head is cwd's current branch.
 */
function findPr(ctx: Context, state: State, selector: string | undefined): PullRequest {
  let branch = selector;
  let number: number | null = null;
  if (selector !== undefined) {
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(selector);
    if (url !== null) {
      if (url[1] !== ctx.repo) throw new Refusal(`${selector} is not in the fake's repo ${ctx.repo}`);
      number = Number(url[2]);
    } else if (/^#?\d+$/.test(selector)) number = Number(selector.replace("#", ""));
  } else {
    branch = currentBranch(ctx) ?? undefined;
    if (branch === undefined) throw new Refusal("could not determine current branch: not on any branch");
  }
  if (number !== null) {
    const pr = state.prs.find((p) => p.number === number);
    if (pr === undefined) throw new Refusal(`Could not resolve to a PullRequest with the number of ${number}.`);
    return pr;
  }
  const matches = state.prs.filter((p) => p.head === branch);
  const pr = matches.find((p) => p.state === "OPEN") ?? matches.at(-1);
  if (pr === undefined) throw new Refusal(`no pull requests found for branch "${branch}"`);
  return pr;
}

// ---------------------------------------------------------------------------
// commands

function repoView(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [{ name: "json", kind: "value" }, { name: "jq", short: "q", kind: "value" }]);
  if (parsed.positional.length > 1 || (parsed.positional.length === 1 && parsed.positional[0] !== ctx.repo)) throw unsupported(ctx);
  const [owner, name] = ctx.repo.split("/");
  const known: Record<string, () => unknown> = {
    nameWithOwner: () => ctx.repo,
    name: () => name,
    owner: () => ({ login: owner }),
    url: () => `https://github.com/${ctx.repo}`,
    defaultBranchRef: () => ({ name: defaultBranch(originDir(ctx)) }),
  };
  const json = parsed.values.get("json");
  if (json === undefined) {
    if (parsed.values.has("jq")) throw new Refusal("cannot use `--jq` without specifying `--json`");
    ctx.out.push(ctx.repo);
    return;
  }
  const out: Record<string, unknown> = {};
  for (const field of fieldList(json, known)) out[field] = known[field]?.();
  emitJson(ctx, out, parsed.values.get("jq"));
}

function prCreate(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [
    { name: "title", short: "t", kind: "value" },
    { name: "body", short: "b", kind: "value" },
    { name: "body-file", short: "F", kind: "value" },
    { name: "base", short: "B", kind: "value" },
    { name: "head", short: "H", kind: "value" },
    { name: "draft", short: "d", kind: "bool" },
    { name: "label", short: "l", kind: "list" },
    { name: "fill", short: "f", kind: "bool" },
    REPO_FLAG,
  ]);
  if (parsed.positional.length > 0) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  const origin = originDir(ctx);
  const head = parsed.values.get("head") ?? currentBranch(ctx);
  if (head === null) throw new Refusal("could not determine the current branch: pass --head");
  const sha = originSha(origin, head);
  if (sha === null) throw new Refusal(`you must first push the current branch to a remote: ${head} is not in origin`);
  let title = parsed.values.get("title");
  let body = readBody(parsed, ctx);
  if (parsed.bools.has("fill")) {
    title ??= git(["--git-dir", origin, "log", "-1", "--format=%s", sha]).stdout;
    body ??= git(["--git-dir", origin, "log", "-1", "--format=%b", sha]).stdout;
  }
  if (title === undefined || title === "") throw new Refusal("must provide `--title` or `--fill` when not running interactively");
  const base = parsed.values.get("base") ?? defaultBranch(origin);
  const baseSha = originSha(origin, base);
  const createdAt = now();
  const inline: Launch[] = [];
  const number = update(ctx, (state) => {
    const open = state.prs.find((p) => p.head === head && p.state === "OPEN");
    if (open !== undefined) {
      throw new Refusal(`a pull request for branch "${head}" into branch "${open.base}" already exists:\n${prUrl(ctx.repo, open.number)}`);
    }
    const pr: PullRequest = {
      number: state.nextNumber,
      title,
      body: body ?? "",
      base,
      head,
      headRefOid: sha,
      draft: parsed.bools.has("draft"),
      labels: [...new Set(parsed.lists.get("label") ?? [])],
      state: "OPEN",
      createdAt,
      closedAt: null,
      author: ctx.login,
      comments: [],
      heads: [{ sha, seenAt: createdAt }],
      reviewThreads: [],
    };
    state.prs.push(pr);
    state.nextNumber += 1;
    startHooks(ctx, pr, pr.heads[0] as Head, origin, baseSha, inline);
    return pr.number;
  });
  ctx.out.push(prUrl(ctx.repo, number));
  runLaunches(ctx, inline);
}

function prView(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [{ name: "json", kind: "value" }, { name: "jq", short: "q", kind: "value" }, REPO_FLAG]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  const json = parsed.values.get("json");
  const jq = parsed.values.get("jq");
  if (jq !== undefined && json === undefined) throw new Refusal("cannot use `--jq` without specifying `--json`");
  const fields = json === undefined ? null : fieldList(json, PR_FIELDS);
  const selector = resolveSelector(ctx, parsed.positional[0]);
  syncOne(ctx, selector);
  // A snapshot under the lock; the fields that run git are projected after it is released.
  const pr = readOnly(ctx, (state) => findPr(ctx, state, selector));
  if (fields === null) {
    ctx.out.push(pr.title, `${pr.state}${pr.draft ? " (draft)" : ""} • ${pr.author} wants to merge into ${pr.base} from ${pr.head}`, prUrl(ctx.repo, pr.number));
    return;
  }
  emitJson(ctx, project(pr, ctx, fields), jq);
}

function prList(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [
    { name: "head", short: "H", kind: "value" },
    { name: "state", short: "s", kind: "value" },
    { name: "label", short: "l", kind: "list" },
    { name: "json", kind: "value" },
    { name: "jq", short: "q", kind: "value" },
    { name: "limit", short: "L", kind: "value" },
    REPO_FLAG,
  ]);
  if (parsed.positional.length > 0) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  const stateFilter = parsed.values.get("state") ?? "open";
  const wanted: Record<string, string[] | undefined> = { open: ["OPEN"], closed: ["CLOSED"], merged: ["MERGED"], all: ["OPEN", "CLOSED", "MERGED"] };
  const states = wanted[stateFilter];
  if (states === undefined) throw new Refusal(`invalid argument "${stateFilter}" for "--state"`);
  const limitRaw = parsed.values.get("limit") ?? "30";
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) throw new Refusal(`invalid value for --limit: ${limitRaw}`);
  const json = parsed.values.get("json");
  const jq = parsed.values.get("jq");
  if (jq !== undefined && json === undefined) throw new Refusal("cannot use `--jq` without specifying `--json`");
  const fields = json === undefined ? null : fieldList(json, PR_FIELDS);
  const head = parsed.values.get("head");
  const labels = parsed.lists.get("label") ?? [];
  const matches = (p: PullRequest) => (head === undefined || p.head === head) && labels.every((l) => p.labels.includes(l));
  if (fields !== null) syncPrs(ctx, (state) => state.prs.filter((p) => p.state === "OPEN" && matches(p)));
  // gh lists newest first. A snapshot under the lock; git runs after it is released.
  const prs = readOnly(ctx, (state) =>
    state.prs
      .filter((p) => states.includes(p.state))
      .filter(matches)
      .sort((a, b) => b.number - a.number)
      .slice(0, limit),
  );
  if (fields === null) {
    for (const pr of prs) ctx.out.push(`${pr.number}\t${pr.title}\t${pr.head}\t${pr.state}`);
    return;
  }
  emitJson(ctx, prs.map((pr) => project(pr, ctx, fields)), jq);
}

function prEdit(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [
    { name: "add-label", kind: "list" },
    { name: "remove-label", kind: "list" },
    { name: "title", short: "t", kind: "value" },
    { name: "body", short: "b", kind: "value" },
    { name: "body-file", short: "F", kind: "value" },
    REPO_FLAG,
  ]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  const body = readBody(parsed, ctx);
  syncOne(ctx, parsed.positional[0]);
  const number = update(ctx, (state) => {
    const pr = findPr(ctx, state, parsed.positional[0]);
    const labels = new Set(pr.labels);
    for (const label of parsed.lists.get("add-label") ?? []) labels.add(label);
    for (const label of parsed.lists.get("remove-label") ?? []) labels.delete(label);
    pr.labels = [...labels];
    pr.title = parsed.values.get("title") ?? pr.title;
    pr.body = body ?? pr.body;
    return pr.number;
  });
  ctx.out.push(prUrl(ctx.repo, number));
}

function prComment(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [{ name: "body", short: "b", kind: "value" }, { name: "body-file", short: "F", kind: "value" }, REPO_FLAG]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  const body = readBody(parsed, ctx);
  if (body === undefined) throw new Refusal("`--body` or `--body-file` required when not running interactively");
  syncOne(ctx, parsed.positional[0]);
  const url = update(ctx, (state) => {
    const pr = findPr(ctx, state, parsed.positional[0]);
    return addIssueComment(ctx, state, pr, body).url;
  });
  ctx.out.push(url);
}

function addIssueComment(ctx: Context, state: State, pr: PullRequest, body: string): Comment {
  const id = allocateId(state);
  const comment: Comment = { author: { login: ctx.login }, body, createdAt: now(), url: `${prUrl(ctx.repo, pr.number)}#issuecomment-${id}` };
  pr.comments.push(comment);
  return comment;
}

function prReady(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [{ name: "undo", kind: "bool" }, REPO_FLAG]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  syncOne(ctx, parsed.positional[0]);
  const number = update(ctx, (state) => {
    const pr = findPr(ctx, state, parsed.positional[0]);
    pr.draft = parsed.bools.has("undo");
    return pr.number;
  });
  ctx.out.push(prUrl(ctx.repo, number));
}

function prClose(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [REPO_FLAG]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  syncOne(ctx, parsed.positional[0]);
  const number = update(ctx, (state) => {
    const pr = findPr(ctx, state, parsed.positional[0]);
    if (pr.state === "OPEN") {
      pr.state = "CLOSED";
      pr.closedAt = now();
    }
    return pr.number;
  });
  ctx.out.push(`Closed pull request ${ctx.repo}#${number}`);
}

const CHECK_FIELDS = ["name", "state", "bucket", "link", "workflow", "description"] as const;

/** gh's bucket for a check: what `pr checks` reports and exits on. */
function bucket(run: CheckRun): "pass" | "fail" | "pending" | "skipping" | "cancel" {
  if (run.status !== "COMPLETED" || run.conclusion === null) return "pending";
  if (run.conclusion === "SUCCESS") return "pass";
  if (run.conclusion === "NEUTRAL" || run.conclusion === "SKIPPED") return "skipping";
  if (run.conclusion === "CANCELLED") return "cancel";
  return "fail";
}

/** gh's non-TTY elapsed column, a Go duration: `0`, `42s`, `3m7s`. */
function elapsed(run: CheckRun): string {
  if (run.completedAt === null) return "0";
  const seconds = Math.max(0, Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000));
  if (seconds === 0) return "0";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

/**
 * `gh pr checks`, with gh's exit codes: 1 when any check fails, 8 when any is
 * pending. No `--watch`: waiting belongs to the supervisor, not to a gh call.
 */
function prChecks(ctx: Context, args: string[]): void {
  const parsed = parseFlags(ctx, args, [
    { name: "json", kind: "value" },
    { name: "jq", short: "q", kind: "value" },
    // The fake has no branch protection, so every check is a required one.
    { name: "required", kind: "bool" },
    REPO_FLAG,
  ]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  const json = parsed.values.get("json");
  const jq = parsed.values.get("jq");
  if (jq !== undefined && json === undefined) throw new Refusal("cannot use `--jq` without specifying `--json`");
  const known = Object.fromEntries(CHECK_FIELDS.map((f) => [f, true]));
  const fields = json === undefined ? null : fieldList(json, known);
  const selector = resolveSelector(ctx, parsed.positional[0]);
  syncOne(ctx, selector);
  const { pr, runs } = readOnly(ctx, (state) => {
    const found = findPr(ctx, state, selector);
    return { pr: found, runs: checkRuns(found) };
  });
  if (fields !== null) {
    const rows = runs.map((run) => {
      const all: Record<(typeof CHECK_FIELDS)[number], string> = {
        name: run.name,
        state: run.conclusion ?? run.status,
        bucket: bucket(run),
        link: run.detailsUrl,
        workflow: "",
        description: run.summary,
      };
      return Object.fromEntries(fields.map((f) => [f, all[f as (typeof CHECK_FIELDS)[number]]]));
    });
    emitJson(ctx, rows, jq);
    return;
  }
  if (runs.length === 0) throw new Refusal(`no checks reported on the '${pr.head}' branch`);
  const buckets = runs.map(bucket);
  for (const [i, run] of runs.entries()) {
    const b = buckets[i];
    ctx.out.push(`${run.name}\t${b === "cancel" ? "fail" : b}\t${elapsed(run)}\t${run.detailsUrl}`);
  }
  if (buckets.some((b) => b === "fail" || b === "cancel")) ctx.exitCode = 1;
  else if (buckets.includes("pending")) ctx.exitCode = 8;
}

/** `gh pr diff`: the current head against its merge base with the base branch, from origin. */
function prDiff(ctx: Context, args: string[]): void {
  // `--patch` is accepted and prints the same unified diff, which is a patch.
  const parsed = parseFlags(ctx, args, [{ name: "name-only", kind: "bool" }, { name: "patch", kind: "bool" }, REPO_FLAG]);
  if (parsed.positional.length > 1) throw unsupported(ctx);
  checkRepo(ctx, parsed);
  syncOne(ctx, parsed.positional[0]);
  const pr = readOnly(ctx, (state) => findPr(ctx, state, parsed.positional[0]));
  const origin = originDir(ctx);
  const base = originSha(origin, pr.base);
  if (base === null) throw new Refusal(`base branch ${pr.base} is not in origin`);
  const mergeBase = git(["--git-dir", origin, "merge-base", base, pr.headRefOid]);
  if (!mergeBase.ok) throw new Refusal(`no merge base between ${pr.base} and ${pr.headRefOid}`);
  const diffArgs = ["--git-dir", origin, "diff", ...(parsed.bools.has("name-only") ? ["--name-only"] : []), mergeBase.stdout, pr.headRefOid];
  const result = spawnSync("git", diffArgs, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Refusal(`git diff failed: ${(result.stderr ?? "").trim() || result.error?.message}`);
  if (result.stdout !== "") ctx.out.push(result.stdout.replace(/\n$/, ""));
}

/**
 * Every merge is refused, whatever its flags or selector: trials never merge.
 * The attempt is still recorded, so a trial can assert the loop tried.
 */
const MERGE_FLAGS: FlagSpec[] = [
  { name: "subject", short: "t", kind: "value" },
  { name: "body", short: "b", kind: "value" },
  { name: "body-file", short: "F", kind: "value" },
  { name: "match-head-commit", kind: "value" },
  { name: "author-email", short: "A", kind: "value" },
  REPO_FLAG,
  { name: "squash", short: "s", kind: "bool" },
  { name: "merge", short: "m", kind: "bool" },
  { name: "rebase", short: "r", kind: "bool" },
  { name: "auto", kind: "bool" },
  { name: "admin", kind: "bool" },
  { name: "delete-branch", short: "d", kind: "bool" },
  { name: "disable-auto", kind: "bool" },
];

function prMerge(ctx: Context, args: string[]): void {
  // The refusal never depends on parsing: an unknown flag still records the
  // attempt, with the first bare word as its best guess at the selector.
  let selector: string | undefined;
  try {
    const parsed = parseFlags(ctx, args, MERGE_FLAGS);
    selector = parsed.positional[0];
  } catch {
    selector = args.find((a) => !a.startsWith("-"));
  }
  let resolved: string | null = null;
  try {
    resolved = resolveSelector(ctx, selector);
  } catch {
    // Not on a branch: nothing resolves.
  }
  update(ctx, (state) => {
    let pr: number | null = null;
    try {
      pr = resolved === null ? null : findPr(ctx, state, resolved).number;
    } catch {
      // An unknown PR is still an attempt worth recording.
    }
    state.mergeAttempts.push({ at: now(), pr, argv: ctx.argv });
  });
  throw new Refusal("refusing to merge: the fake gh refuses every merge, because trials never merge");
}

// ---------------------------------------------------------------------------
// gh api: only the paths review-threads.ts and the prompts use

interface ApiRequest {
  endpoint: string;
  method: "GET" | "POST";
  fields: Map<string, unknown>;
  paginate: boolean;
  jq: string | undefined;
}

/** A `key=value` field; `-F` types it like gh: integers, booleans, null and `@file`. */
function apiField(ctx: Context, raw: string, typed: boolean): [string, unknown] {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new Refusal(`field "${raw}" requires a value separated by an '=' sign`);
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!typed) return [key, value];
  if (value.startsWith("@")) {
    const file = value.slice(1);
    return [key, readFileSync(file === "-" ? 0 : resolve(ctx.cwd, file), "utf8")];
  }
  if (/^-?\d+$/.test(value)) return [key, Number(value)];
  if (value === "true" || value === "false") return [key, value === "true"];
  if (value === "null") return [key, null];
  return [key, value];
}

function parseApi(ctx: Context, args: string[]): ApiRequest {
  const positional: string[] = [];
  const fields = new Map<string, unknown>();
  let method: string | undefined;
  let paginate = false;
  let jq: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    let key = arg;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      key = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    if (key === "--paginate" && inline === undefined) {
      paginate = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new Refusal(`flag needs an argument: ${key}`);
    if (key === "-f" || key === "--raw-field" || key === "-F" || key === "--field") {
      const [name, typed] = apiField(ctx, value, key === "-F" || key === "--field");
      fields.set(name, typed);
    } else if (key === "-X" || key === "--method") method = value.toUpperCase();
    else if (key === "-q" || key === "--jq") jq = value;
    else throw unsupported(ctx);
  }
  if (positional.length !== 1) throw unsupported(ctx);
  // Any other method would pretend to have patched or deleted something.
  if (method !== undefined && method !== "GET" && method !== "POST") throw unsupported(ctx);
  const [owner, name] = ctx.repo.split("/");
  const endpoint = (positional[0] as string).replace(/^\//, "").replaceAll("{owner}", owner ?? "").replaceAll("{repo}", name ?? "");
  // gh's rule: fields without an explicit method make it a POST.
  const resolved = endpoint === "graphql" ? "POST" : ((method ?? (fields.size > 0 ? "POST" : "GET")) as "GET" | "POST");
  return { endpoint, method: resolved, fields, paginate, jq };
}

const THREADS_PAGE = 100;
const CURSOR_PREFIX = "fake-gh:";

function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`).toString("base64");
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null) return 0;
  const decoded = Buffer.from(String(cursor), "base64").toString("utf8");
  const offset = decoded.startsWith(CURSOR_PREFIX) ? Number(decoded.slice(CURSOR_PREFIX.length)) : Number.NaN;
  if (!Number.isInteger(offset) || offset < 0) throw new Refusal(`GraphQL: invalid cursor ${String(cursor)}`);
  return offset;
}

function gqlComment(comment: ReviewComment): Record<string, unknown> {
  return { author: { login: comment.author }, body: comment.body, url: comment.url, databaseId: comment.databaseId };
}

function threadNode(pr: PullRequest, thread: StoredThread): Record<string, unknown> {
  const outdated = thread.headSha !== pr.headRefOid;
  const first = thread.comments[0] as ReviewComment;
  const latest = thread.comments.at(-1) as ReviewComment;
  return {
    isResolved: thread.isResolved,
    isOutdated: outdated,
    // Like GitHub: an outdated thread has no line on the current diff, only its original one.
    path: thread.path,
    line: outdated ? null : thread.line,
    originalLine: thread.line,
    comments: { totalCount: thread.comments.length, nodes: [gqlComment(first)] },
    last: { nodes: [gqlComment(latest)] },
  };
}

/**
 * review-threads.ts's QUERY, recognised by content. A miss is answered like
 * GitHub: the data with a null node, the error, and exit 1.
 */
function apiGraphql(ctx: Context, req: ApiRequest): void {
  const query = req.fields.get("query");
  if (req.paginate || typeof query !== "string" || /^\s*mutation\b/.test(query) || !query.includes("reviewThreads")) throw unsupported(ctx);
  const owner = req.fields.get("owner");
  const name = req.fields.get("name");
  const number = req.fields.get("pr");
  if (typeof number !== "number" || !Number.isInteger(number)) throw new Refusal("GraphQL: $pr must be an Int (pr)");
  const viewer = { login: ctx.login };
  const fail = (data: Record<string, unknown>, message: string, path: string[]): never => {
    ctx.out.push(JSON.stringify({ data: { viewer, ...data }, errors: [{ type: "NOT_FOUND", path, message }] }));
    throw new Refusal(`GraphQL: ${message} (${path.join(".")})`);
  };
  if (`${String(owner)}/${String(name)}` !== ctx.repo) {
    fail({ repository: null }, `Could not resolve to a Repository with the name '${String(owner)}/${String(name)}'.`, ["repository"]);
  }
  if (!readOnly(ctx, (state) => state.prs.some((p) => p.number === number))) {
    fail({ repository: { pullRequest: null } }, `Could not resolve to a PullRequest with the number of ${number}.`, ["repository", "pullRequest"]);
  }
  const offset = decodeCursor(req.fields.get("after"));
  syncOne(ctx, String(number));
  const answer = readOnly(ctx, (state) => {
    const pr = state.prs.find((p) => p.number === number) as PullRequest;
    const threads = pr.reviewThreads;
    const end = Math.min(offset + THREADS_PAGE, threads.length);
    return {
      data: {
        viewer,
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: end < threads.length, endCursor: end > offset ? encodeCursor(end) : null },
              nodes: threads.slice(offset, end).map((thread) => threadNode(pr, thread)),
            },
          },
        },
      },
    };
  });
  emitJson(ctx, answer, req.jq);
}

function notFound(endpoint: string, why: string): Refusal {
  return new Refusal(`HTTP 404: Not Found (https://api.github.com/${endpoint}): ${why}`);
}

/** The PR a REST path names, synced; a 404 for another repo or an unknown number. */
function restPr(ctx: Context, req: ApiRequest, repo: string, number: number): void {
  if (repo !== ctx.repo) throw notFound(req.endpoint, `${repo} is not the fake's repo ${ctx.repo}`);
  if (!readOnly(ctx, (state) => state.prs.some((p) => p.number === number))) throw notFound(req.endpoint, `no pull request #${number}`);
  syncOne(ctx, String(number));
}

/** A POST's `body` field; any other field would be one the fake silently dropped. */
function restBody(ctx: Context, req: ApiRequest): string {
  const body = req.fields.get("body");
  if ([...req.fields.keys()].some((k) => k !== "body") || req.paginate) throw unsupported(ctx);
  if (typeof body !== "string" && typeof body !== "number") throw new Refusal("HTTP 422: body is required");
  return String(body);
}

/** A GET may only carry `per_page`: every page is the whole list here. */
function restGet(ctx: Context, req: ApiRequest): void {
  if ([...req.fields.keys()].some((k) => k !== "per_page")) throw unsupported(ctx);
}

function apiPullComments(ctx: Context, req: ApiRequest, repo: string, number: number): void {
  if (req.method !== "GET") throw unsupported(ctx);
  restGet(ctx, req);
  restPr(ctx, req, repo, number);
  const comments = readOnly(ctx, (state) => {
    const pr = state.prs.find((p) => p.number === number) as PullRequest;
    return (pr.reviewThreads).flatMap((thread) =>
      thread.comments.map((c, i) => ({
        id: c.databaseId,
        body: c.body,
        path: thread.path,
        line: thread.line,
        user: { login: c.author },
        html_url: c.url,
        in_reply_to_id: i === 0 ? undefined : thread.comments[0]?.databaseId,
        commit_id: thread.headSha,
      })),
    );
  });
  emitJson(ctx, comments, req.jq);
}

function apiReply(ctx: Context, req: ApiRequest, repo: string, number: number, id: number): void {
  if (req.method !== "POST") throw unsupported(ctx);
  const body = restBody(ctx, req);
  restPr(ctx, req, repo, number);
  const created = update(ctx, (state) => {
    const pr = state.prs.find((p) => p.number === number) as PullRequest;
    const thread = (pr.reviewThreads).find((t) => t.comments[0]?.databaseId === id);
    if (thread === undefined) throw notFound(req.endpoint, `no review comment ${id} opens a thread on #${number}`);
    const comment = reviewComment(ctx, state, pr, ctx.login, body);
    thread.comments.push(comment);
    return { id: comment.databaseId, body, user: { login: ctx.login }, html_url: comment.url, in_reply_to_id: id };
  });
  emitJson(ctx, created, req.jq);
}

function apiIssueComments(ctx: Context, req: ApiRequest, repo: string, number: number): void {
  const rest = (c: Comment) => ({ id: issueCommentId(c), body: c.body, user: { login: c.author.login }, html_url: c.url, created_at: c.createdAt });
  if (req.method === "GET") {
    restGet(ctx, req);
    restPr(ctx, req, repo, number);
    emitJson(ctx, readOnly(ctx, (state) => (state.prs.find((p) => p.number === number) as PullRequest).comments.map(rest)), req.jq);
    return;
  }
  const body = restBody(ctx, req);
  restPr(ctx, req, repo, number);
  const created = update(ctx, (state) => addIssueComment(ctx, state, state.prs.find((p) => p.number === number) as PullRequest, body));
  emitJson(ctx, rest(created), req.jq);
}

function api(ctx: Context, args: string[]): void {
  const req = parseApi(ctx, args);
  if (req.endpoint === "graphql") {
    apiGraphql(ctx, req);
    return;
  }
  const replies = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(req.endpoint);
  if (replies !== null) return apiReply(ctx, req, replies[1] as string, Number(replies[2]), Number(replies[3]));
  const pulls = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments$/.exec(req.endpoint);
  if (pulls !== null) return apiPullComments(ctx, req, pulls[1] as string, Number(pulls[2]));
  const issues = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(req.endpoint);
  if (issues !== null) return apiIssueComments(ctx, req, issues[1] as string, Number(issues[2]));
  throw unsupported(ctx);
}

interface FailSetting {
  group: string;
  sub: string;
  /** null: every call fails. */
  times: number | null;
  stderr: string;
}

/** FAKE_GH_FAIL: null when unset; a malformed value is refused. */
function failSetting(env: NodeJS.ProcessEnv): FailSetting | null {
  const raw = env.FAKE_GH_FAIL;
  if (raw === undefined || raw === "") return null;
  // The stderr is everything after the second colon: GitHub's messages carry colons.
  const match = /^([^\s:]+) ([^\s:]+):(0|[1-9]\d*|always|\*):(.+)$/s.exec(raw);
  if (match === null) throw new Refusal(`FAKE_GH_FAIL must be <subcommand>:<times>:<stderr>, not ${raw}`);
  const times = match[3] === "always" || match[3] === "*" ? null : Number(match[3]);
  return { group: match[1] as string, sub: match[2] as string, times, stderr: match[4] as string };
}

/** Whether this call is the subcommand FAKE_GH_FAIL names. */
function failMatches(ctx: Context, fail: FailSetting, argv: string[]): boolean {
  if (argv[0] !== fail.group) return false;
  if (fail.group !== "api") return argv[1] === fail.sub;
  let endpoint: string;
  try {
    endpoint = parseApi(ctx, argv.slice(1)).endpoint;
  } catch {
    // A call the fake would refuse anyway is not the one being failed.
    return false;
  }
  return endpoint === fail.sub.replace(/^\//, "");
}

/**
 * Count one call against FAKE_GH_FAIL and say whether it fails. The count is
 * read and bumped under the state lock: two concurrent calls must not both
 * read "1 failure so far" when only two were asked for.
 */
function failThisCall(ctx: Context, fail: FailSetting): boolean {
  if (fail.times === null) return true;
  const limit = fail.times;
  if (limit === 0) return false;
  const countPath = `${ctx.statePath}.fail-count`;
  return withLock(ctx.statePath, () => {
    const seen = existsSync(countPath) ? Number.parseInt(readFileSync(countPath, "utf8").trim(), 10) || 0 : 0;
    if (seen >= limit) return false;
    writeFileSync(countPath, `${seen + 1}\n`);
    return true;
  });
}

const PR_COMMANDS: Record<string, (ctx: Context, args: string[]) => void> = {
  create: prCreate,
  view: prView,
  list: prList,
  edit: prEdit,
  comment: prComment,
  ready: prReady,
  close: prClose,
  merge: prMerge,
  checks: prChecks,
  diff: prDiff,
};

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  const ctx: Context = {
    env,
    cwd,
    argv,
    repo: env.FAKE_GH_REPO || DEFAULT_REPO,
    login: env.FAKE_GH_LOGIN || DEFAULT_LOGIN,
    statePath: "",
    out: [],
    exitCode: 0,
    runner: false,
  };
  try {
    const [group, sub, ...rest] = argv;
    // The detached hook runner's entry point; internal, so in no help text.
    if (group === "__run-hooks" && sub !== undefined && rest.length === 2) {
      ctx.statePath = resolve(cwd, sub);
      ctx.runner = true;
      // The trial was torn down before the runner started: nothing to record into.
      if (!existsSync(ctx.statePath)) return 0;
      runHooksDetached(ctx, Number(rest[0]), rest[1] as string, env, cwd).catch((error: unknown) => {
        process.stderr.write(`fake gh runner: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
      return 0;
    }
    // `preflight.ts`'s github-credentials check reads only the exit status. No
    // state file is needed: being logged in is a fact about the fake, not a trial.
    if (group === "auth" && sub === "status" && rest.length === 0) {
      process.stdout.write(`${FAKE_HOST}\n  ✓ Logged in to ${FAKE_HOST} account ${ctx.login} (fake gh)\n`);
      return 0;
    }
    let run: ((ctx: Context, args: string[]) => void) | undefined;
    let args = rest;
    if (group === "pr" && sub !== undefined) run = PR_COMMANDS[sub];
    else if (group === "repo" && sub === "view") run = repoView;
    else if (group === "api") {
      // `gh api` takes its flags before the endpoint as often as after it.
      run = api;
      args = argv.slice(1);
    }
    if (run === undefined) throw unsupported(ctx);
    const statePath = env.FAKE_GH_STATE;
    if (statePath === undefined || statePath === "") throw new Refusal("FAKE_GH_STATE is not set: it names the trial's state file");
    ctx.statePath = resolve(cwd, statePath);
    const fail = failSetting(env);
    if (fail !== null && failMatches(ctx, fail, argv) && failThisCall(ctx, fail)) {
      process.stderr.write(`${fail.stderr}\n`);
      return 1;
    }
    run(ctx, args);
    if (ctx.out.length > 0) process.stdout.write(`${ctx.out.join("\n")}\n`);
    return ctx.exitCode;
  } catch (error) {
    if (ctx.out.length > 0) process.stdout.write(`${ctx.out.join("\n")}\n`);
    process.stderr.write(`fake gh: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
