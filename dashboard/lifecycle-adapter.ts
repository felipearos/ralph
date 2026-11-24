/**
 * The lifecycle side of the runtime adapter: `start.sh`, the supervisor's
 * liveness, and what a restart would leave behind in the worktree.
 *
 * A sibling of `control-adapter.ts`, and for the same reason: this is the only
 * code above the process boundary that names `start.sh`, the `loop-state`
 * liveness read, the git commands a checkout report runs, or the claim-lease
 * file's shape. `lifecycle.ts` above it builds nothing and spawns nothing: it
 * asks for a start, a liveness or a checkout report, and the adapter runs the
 * commands through its own injected `Executor`, guarded so no read ever
 * rejects, and narrows what came back.
 *
 * Everything here reads. `start.sh` is the one invocation that changes
 * anything, and what it changes is guarded by its own worktree-local lock. The
 * git commands are `status`, `symbolic-ref`, `rev-parse` and `log`; nothing resets,
 * checks out, cleans or stashes, because a checkout a restart finds dirty or
 * mid-ticket is recovery work to report, not a mess to repair.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { ADAPTER_ENV, COMMAND_SURFACE, defaultBunPath, isRecord, narrowSnapshot } from "./adapter";
import type { Env, Liveness, LoopEvent, StopReason } from "./contracts";
import { guarded, type ExecResult, type Executor, type Invocation } from "./control-adapter";

/**
 * The lifecycle command surface — a closed list, asserted by a test.
 *
 * `start` is the existing starter, run in the loop's worktree. `supervisor` is
 * the same read-only `loop-state status --json` the observer uses; its
 * per-worktree `supervisor` liveness is matched by argv and cwd in `/proc`, so
 * it answers "is this worktree's supervisor still running" without anybody
 * trusting a pid file. `start.resume` is the variable Resume work sets, which
 * tells `ralph.sh` to leave HEAD where the interrupted iteration left it
 * rather than fast-forward a clean checkout; `start.resume.issue` names the
 * interrupted ticket, the one lapsed claim the resumed run may pick back up.
 * `checkout.unpushed` lists the
 * commits on HEAD that no remote-tracking ref has: work a reset would lose.
 */
export const LIFECYCLE_SURFACE = {
  start: { script: "start.sh", resume: { env: "RALPH_RESUME_WORK", value: "1", issue: "RALPH_RESUME_ISSUE" } },
  supervisor: COMMAND_SURFACE.loopState,
  checkout: {
    command: "git",
    status: ["status", "--porcelain"],
    branch: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    commonDir: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    unpushed: ["log", "--format=%h %s", "--max-count=50", "HEAD", "--not", "--remotes"],
  },
  /** The claim-lease store, in Git's common directory, as `claim-lease.ts` keeps it. */
  leaseStore: "ralph-claim-leases.json",
  /** Where `claim-lease.ts` falls back to when there is no Git common directory. */
  leaseStoreFallback: ".ralph-claim-leases.json",
} as const;

/**
 * Per-run variables a new supervisor must not inherit from whoever started it.
 *
 * `ralph.sh` keeps `RALPH_RUN_ID` when it is already set, so a dashboard that
 * happened to run inside a loop's environment would start a supervisor under
 * the OLD run — and the control record keeps a confirmed stop for the run it
 * belongs to, so that supervisor would exit on the stop that restart had just
 * carried out.
 */
const INHERITED_RUN_ENV = ["RALPH_RUN_ID", "RALPH_SUPERVISOR_PID", ADAPTER_ENV.loopStateRoot] as const;

/** The project variable `project.sh` honours before it looks at the cwd. */
const PROJECT_ENV = "RALPH_PROJECT";

export const START_OUTCOMES = ["started", "already-running", "failed"] as const;
export type StartOutcome = (typeof START_OUTCOMES)[number];

/** What `start.sh` answered, narrowed from its status and stdout. */
export interface StartReport {
  outcome: StartOutcome;
  /** The supervisor's pid, when `start.sh` named one. */
  pid: number | null;
  why: string;
}

export interface SupervisorReport {
  liveness: Liveness;
  why: string;
}

/**
 * One worktree's durable record and its supervisor's liveness, from the single
 * `loop-state status --json` read.
 *
 * `recorded` is its own field because `stopReason: null` means two different
 * things: a loop that is mid-iteration, and a worktree that has no record at
 * all. Nothing may restart the second — it was never started here.
 */
export interface LoopStateReport {
  liveness: Liveness;
  /** The ending the loop chose, when its record names one. */
  stopReason: StopReason | null;
  /** The run the record belongs to, and the loop it names; null without a record. */
  run: string | null;
  loop: string | null;
  /** The supervisor the record names, so a restart's reason can say which process is gone. */
  pid: number | null;
  /** True when a durable record was read for this worktree. */
  recorded: boolean;
  /**
   * The event that stopped or last moved the loop, when the record has one.
   * The stop kind alone cannot tell an operator's orderly stop (also `failed`,
   * see controls.ts ORDERLY_STOP_KINDS) from a loop that died on a transient
   * fault; the event that wrote it can.
   */
  lastEvent?: LoopEvent;
  /**
   * When the loop last finished an iteration, across runs, when the record has
   * one — how long a stopped loop has gone without finishing any work.
   */
  lastIterationEndAt?: string;
  why: string;
}

/** A claim lease held for this worktree. */
export interface ClaimView {
  issue: number;
  run: string;
  loop: string;
  branch: string | null;
}

/** What a restart would leave in the worktree — reported, never repaired. */
export interface CheckoutReport {
  worktree: string;
  branch: string | null;
  /** False when `git status` could not be read; `dirty` then says nothing. */
  readable: boolean;
  dirty: boolean;
  /** `git status --porcelain` lines, verbatim. */
  changes: string[];
  claims: ClaimView[];
  /** A claim is held for this worktree: a ticket is in flight here. */
  midTicket: boolean;
  /** Commits on HEAD no remote-tracking ref has, as `<sha> <subject>`; null when git could not say. */
  unpushed: string[] | null;
}

export interface CheckoutResults {
  status: ExecResult;
  branch: ExecResult;
  commonDir: ExecResult;
  unpushed: ExecResult;
}

/**
 * The lifecycle surface one loop's worktree offers. Every operation here
 * RESOLVES to its failure answer rather than rejecting — a failed start, an
 * `unknown` liveness, an unreadable checkout — because restart, Resume work
 * and the reconciler carry no catch of their own and rely on it.
 */
export interface LifecycleAdapter {
  /** The loop's worktree: the configured root, resolved. */
  readonly worktree: string;
  /**
   * Run `start.sh` in the loop's worktree. `resume` starts it to pick up
   * interrupted work: HEAD is not moved, and the claim on `resume.issue`, if
   * any, is picked back up even past its lease.
   */
  start(options?: { resume?: { issue: number | null } }): Promise<StartReport>;
  /** Read the supervisor's liveness for the configured root, read-only. */
  supervisor(): Promise<SupervisorReport>;
  /** The same read, with the record's ending and run beside the liveness. */
  loopState(): Promise<LoopStateReport>;
  /** Run the read-only git calls a checkout report is built from, and read the claims. */
  checkout(): Promise<CheckoutReport>;
}

export interface LifecycleAdapterConfig {
  /** Absolute directory holding the ralph CLI scripts. */
  cliDir: string;
  /** The configured repo/checkout root: the loop's worktree. */
  root: string;
  bunPath?: string;
  env?: Env;
  /** The starter to run; defaults to `start.sh` in `cliDir`. */
  startScript?: string;
  /** Runs every command; wrapped in `guarded` so a throw is a failed result, never a rejection. */
  exec: Executor;
}

/** Two spellings of one directory: `loop-state` and `git` may resolve symlinks differently. */
export const samePath = (left: string, right: string): boolean => {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(left) === real(right);
};

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * Narrow `start.sh`'s answer.
 *
 * Its two successes are both exit 0 and differ only in what they say, so they
 * are read off stdout: "already running" is the worktree lock's idempotent
 * no-op, and "Started Ralph supervisor (pid N)" is a new supervisor. Anything
 * non-zero is a start that did not happen, with `start.sh`'s own reason.
 */
export function parseStart(result: ExecResult): StartReport {
  if (result.status !== 0) {
    const why =
      firstLine(result.stderr) || firstLine(result.stdout) || `start.sh exited ${String(result.status)}`;
    return { outcome: "failed", pid: null, why };
  }
  const already = /already running(?: \(pid (\d+)\))?/.exec(result.stdout);
  if (already !== null) {
    return {
      outcome: "already-running",
      pid: already[1] === undefined ? null : Number(already[1]),
      why: firstLine(result.stdout),
    };
  }
  const started = /Started Ralph supervisor \(pid (\d+)\)/.exec(result.stdout);
  return {
    outcome: "started",
    pid: started?.[1] === undefined ? null : Number(started[1]),
    why: firstLine(result.stdout) || "started",
  };
}

/**
 * Narrow one worktree's record and its supervisor's liveness out of
 * `loop-state status --json`.
 *
 * Every failure is `unknown`, never `dead`: a restart that read "could not
 * tell" as "gone" would start a second supervisor beside a live one. A failure
 * is `recorded: false` for the same reason the other way round — nothing may
 * be inferred from a record that was not read.
 */
export function parseLoopState(result: ExecResult, worktree: string): LoopStateReport {
  const unknown = (why: string): LoopStateReport => ({
    liveness: "unknown",
    stopReason: null,
    run: null,
    loop: null,
    pid: null,
    recorded: false,
    why,
  });
  if (result.status !== 0) {
    return unknown(`loop-state could not run: ${firstLine(result.stderr) || String(result.status)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return unknown("loop-state did not return JSON");
  }
  let snapshot: ReturnType<typeof narrowSnapshot>;
  try {
    snapshot = narrowSnapshot(value);
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
  const report = snapshot.loops.find((loop) => samePath(loop.worktree, worktree));
  if (report === undefined) {
    return unknown(`loop-state reported no worktree at ${worktree}`);
  }
  return {
    liveness: report.supervisor,
    stopReason: report.state?.stopReason ?? null,
    run: report.state?.run ?? null,
    loop: report.state?.owner.loop ?? null,
    pid: report.state?.owner.pid ?? null,
    recorded: report.state !== null,
    // Absent rather than null when the record lacks them, so a report built
    // without either reads the same as one from an older record.
    ...(report.state?.lastEvent ? { lastEvent: report.state.lastEvent } : {}),
    ...(report.state?.lastIterationEndAt === undefined
      ? {}
      : { lastIterationEndAt: report.state.lastIterationEndAt }),
    why: `supervisor ${report.supervisor}`,
  };
}

/**
 * The liveness alone, for the callers that ask nothing else. Derived from the
 * reading above rather than from a second one of its own: two narrowings of
 * one command's answer are two things that can come to disagree.
 */
export function parseSupervisor(result: ExecResult, worktree: string): SupervisorReport {
  const { liveness, why } = parseLoopState(result, worktree);
  return { liveness, why };
}

const readLeases = (path: string, worktree: string): ClaimView[] => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.leases)) return [];
  const claims: ClaimView[] = [];
  for (const lease of Object.values(value.leases)) {
    if (!isRecord(lease) || typeof lease.worktree !== "string" || !samePath(lease.worktree, worktree)) continue;
    if (typeof lease.issue !== "number" || !Number.isSafeInteger(lease.issue)) continue;
    claims.push({
      issue: lease.issue,
      run: typeof lease.run === "string" ? lease.run : "",
      loop: typeof lease.loop === "string" ? lease.loop : "",
      branch: typeof lease.branch === "string" ? lease.branch : null,
    });
  }
  return claims.sort((a, b) => a.issue - b.issue);
};

/** Narrow the checkout's read-only git answers and the claims held for it. */
export function parseCheckout(results: CheckoutResults, worktree: string): CheckoutReport {
  const readable = results.status.status === 0;
  const changes = readable
    ? results.status.stdout.split("\n").filter((line) => line.trim() !== "")
    : [];
  const branch = results.branch.status === 0 ? results.branch.stdout.trim() || null : null;
  const common = results.commonDir.status === 0 ? results.commonDir.stdout.trim() : "";
  const leasePath =
    common === ""
      ? join(worktree, LIFECYCLE_SURFACE.leaseStoreFallback)
      : join(common, LIFECYCLE_SURFACE.leaseStore);
  const claims = readLeases(leasePath, worktree);
  return {
    worktree,
    branch,
    readable,
    dirty: changes.length > 0,
    changes,
    claims,
    midTicket: claims.length > 0,
    unpushed:
      results.unpushed.status === 0
        ? results.unpushed.stdout.split("\n").filter((line) => line.trim() !== "")
        : null,
  };
}

/** Build the lifecycle adapter over one configured root and harness CLI directory. */
export function createRalphLifecycleAdapter(config: LifecycleAdapterConfig): LifecycleAdapter {
  const cliDir = resolve(config.cliDir);
  const worktree = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const baseEnv: Env = { ...process.env, ...config.env };
  const startScript = resolve(config.startScript ?? join(cliDir, LIFECYCLE_SURFACE.start.script));

  const resume = LIFECYCLE_SURFACE.start.resume;
  const startEnv = (resuming: { issue: number | null } | undefined): Env => {
    const env: Env = { ...baseEnv };
    for (const name of INHERITED_RUN_ENV) delete env[name];
    // Only a Resume work asks to keep HEAD or names a ticket; an inherited one must not.
    delete env[resume.env];
    delete env[resume.issue];
    // `project.sh` prefers RALPH_PROJECT over the cwd. The server's own
    // environment may name a different loop's project, and a start anchored
    // there would start the wrong loop, so the configured root is named.
    env[PROJECT_ENV] = worktree;
    if (resuming !== undefined) {
      env[resume.env] = resume.value;
      if (resuming.issue !== null) env[resume.issue] = String(resuming.issue);
    }
    return env;
  };

  const git = (args: readonly string[]): Invocation => ({
    command: LIFECYCLE_SURFACE.checkout.command,
    args: [...args],
    cwd: worktree,
    env: baseEnv,
  });

  const exec = guarded(config.exec);
  const startInvocation = (options: { resume?: { issue: number | null } } = {}): Invocation => ({
    command: startScript,
    args: [],
    cwd: worktree,
    env: startEnv(options.resume),
  });
  const supervisorInvocation = (): Invocation => ({
    command: bunPath,
    args: [join(cliDir, LIFECYCLE_SURFACE.supervisor.script), ...LIFECYCLE_SURFACE.supervisor.args],
    cwd: worktree,
    env: { ...baseEnv, [ADAPTER_ENV.loopStateRoot]: worktree },
  });

  return {
    worktree,
    start: async (options = {}) => parseStart(await exec(startInvocation(options))),
    supervisor: async () => parseSupervisor(await exec(supervisorInvocation()), worktree),
    loopState: async () => parseLoopState(await exec(supervisorInvocation()), worktree),
    // One after another, not in parallel: the reads are cheap, and a fixed
    // order keeps what a recording executor sees the same on every run.
    checkout: async () => {
      const status = await exec(git(LIFECYCLE_SURFACE.checkout.status));
      const branch = await exec(git(LIFECYCLE_SURFACE.checkout.branch));
      const commonDir = await exec(git(LIFECYCLE_SURFACE.checkout.commonDir));
      const unpushed = await exec(git(LIFECYCLE_SURFACE.checkout.unpushed));
      return parseCheckout({ status, branch, commonDir, unpushed }, worktree);
    },
  };
}

/**
 * The host's boot time from `/proc/stat`'s `btime` line, in epoch
 * milliseconds, or null when it cannot be read. Never throws: a boot time
 * nobody could read only means a shutdown's stop is not restarted.
 * The reconciler is handed it (#6) rather than reading the host itself.
 */
export function readBootTimeMs(read: () => string = () => readFileSync("/proc/stat", "utf8")): number | null {
  try {
    const match = /^btime (\d+)$/m.exec(read());
    if (match === null) return null;
    const ms = Number(match[1]) * 1000;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
