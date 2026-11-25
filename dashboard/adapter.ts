/**
 * The runtime adapter — the one seam that knows ralph.
 *
 * Everything the GUI needs from the Ralph runtime crosses this module as a
 * typed view model. The command names, the flags, the environment variables and
 * the JSON shapes live here and nowhere else, so the tool can be lifted out of
 * this repository as a move rather than a rewrite, and so a change in the CLI
 * output lands as one explicit error instead of a wrong panel.
 *
 * The JSON is a *contract*: it is narrowed and validated field by field and a
 * drifted or malformed shape throws `RalphContractError`. It is never coerced —
 * a `loopStatus` the code cannot name is a bug in the pairing, not a value to
 * guess at. A CLI that merely could not run is a different fact, and only the
 * per-worktree reads (observe, usage, the journal) degrade to absent on it, so
 * one broken checkout does not take the whole dashboard down.
 *
 * Read-only by construction: the commands it names are `loop-state status
 * --json`, `observe --json`, `project-config --json [--at origin/<base>]`, `usage.py --json
 * --no-record`, `timeline.ts --json`, `runner-failure.ts status --json`, and
 * `git ls-tree` / `git cat-file` against the harness's
 * `origin/main`, and a regression test pins that command surface. There is no
 * write path to reach for.
 *
 * It spawns nothing itself: every one of those commands is a declared
 * `CliSurface` run through the CLI reader (`./cli-read`) over the injected
 * executor, so parsing, failure classification and the degrade policy are
 * decided there once rather than at each call site.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { readCiHealth } from "./ci-health";
import { createCliReader, createTtlCache, RalphContractError, RalphUnavailableError, type CliSurface } from "./cli-read";
import { createProcessExecutor, type Executor } from "./executor";
import { blobBase, foldLearnings, HARNESS_FILE, type LearningsFileRead } from "./learnings";
import {
  ACTOR_STAGES,
  ACTOR_STATES,
  BLOCK_KINDS,
  JOURNAL_BLOCK_KINDS,
  ISSUE_STATES,
  LIVENESSES,
  LOOP_ROLES,
  LOOP_STATUSES,
  PARK_CONDITION_KINDS,
  PHASES,
  STAGES,
  STATE_PROBLEMS,
  STOP_KINDS,
  WORKTREE_STATUSES,
  type ActivityView,
  type ActorStage,
  type ActorState,
  type ActorView,
  type BlockKind,
  type JournalBlockKind,
  type ParkCondition,
  type ParkConditionKind,
  type ParkReason,
  type Env,
  type IssueHistoryView,
  type IssueState,
  type GithubClaimView,
  type LearningsRead,
  type LeaseView,
  type JournalEntryView,
  type Liveness,
  type LocalSnapshot,
  type LoopStateView,
  type LoopStatus,
  type Phase,
  FAILURE_VISIBILITIES,
  type FailureVisibility,
  type PresenceView,
  type Reconciliation,
  type RosterLoop,
  rosterNames,
  type RunnerFailureView,
  type RunnerFailuresView,
  type TimelineView,
  type RuntimeClaims,
  type RuntimeLoop,
  type FrontierRead,
  FOLLOWING_STATES,
  FOLLOWING_WOULD_BE,
  type FollowingRead,
  type FollowingView,
  type FollowingWatchView,
  verifiers,
  type FrontierTreeGroup,
  type FrontierTreeNode,
  type FrontierView,
  type PullState,
  type PullStatusView,
  TRIAGE_BUCKETS,
  TRIAGE_MAX_WRITES_DEFAULT,
  triagers,
  type TriageActivityView,
  type TriageBucket,
  TREE_STATES,
  HUMAN_REASONS,
  type HumanReason,
  type TreeState,
  type RuntimeSnapshot,
  type Stage,
  type StateProblem,
  type StopKind,
  type StopReason,
  type TokenUsage,
  type UsageView,
  type WorktreeStatus,
  type TrackerLinkView,
} from "./contracts";

/**
 * The entire command surface of the adapter.
 *
 * Exported so a regression test can assert it: read-only means these exact
 * argv shapes and nothing else. `observe` is invoked with `RALPH_OBSERVER_ROOT`
 * per worktree; `loop-state` with `RALPH_STATE_ROOT` per configured root.
 * `usage.py` runs in the loop's worktree for its recorded run and session, and
 * `--no-record` is what makes it a read: without it every refresh would append
 * a ledger row and advance the step baseline. The journal is two git reads
 * against the harness checkout, never a fetch.
 */
export const COMMAND_SURFACE = {
  loopState: { contract: "loop-state", script: "loop-state.ts", args: ["status", "--json"] },
  observe: { contract: "observe", script: "observe.ts", args: ["--json"] },
  // The lease store, read-only, under `RALPH_STATE_ROOT` like `loop-state`.
  claims: { contract: "claim-lease", script: "claim-lease.ts", args: ["status", "--json"] },
  // GitHub's half of a claim — the `<loop>-wip` label — from the root checkout.
  github: {
    contract: "gh",
    command: "gh",
    args: ["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,labels"],
  },
  // The same list on a project whose tickets live in Linear or Jira (#339),
  // through the project's tracker, in the shape `gh` answers.
  trackerIssues: { contract: "tracker", script: "tracker.ts", args: ["list", "--json", "--limit", "1000"] },
  // Where each ticket's PR stands, for the backlog's PR chips: the open PRs
  // with their checks, and the recently merged ones. Both read-only lists.
  pullsOpen: {
    contract: "gh-pulls",
    command: "gh",
    args: [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,isDraft,closingIssuesReferences,statusCheckRollup",
    ],
  },
  pullsMerged: {
    contract: "gh-pulls",
    command: "gh",
    args: ["pr", "list", "--state", "merged", "--limit", "300", "--json", "number,closingIssuesReferences,mergedAt"],
  },
  projectConfig: { contract: "project-config", script: "project-config.ts", args: ["--json"] },
  usage: { contract: "usage", script: "usage.py", args: ["--json", "--no-record"] },
  // The ref and directory follow per project: `origin/main` of the harness, or
  // `origin/<journal.branch>` of the project's own repository.
  journalList: { contract: "journal", command: "git", args: ["ls-tree", "--name-only"] },
  journalRead: { contract: "journal", command: "git", args: ["cat-file", "--batch"] },
  // The learnings files, from the same harness `origin/main` as the journal,
  // plus the remote that says where to link them. Both read-only.
  learningsShow: { contract: "learnings", command: "git", args: ["show"] },
  learningsRemote: { contract: "learnings", command: "git", args: ["remote", "get-url", "origin"] },
  // One worktree's recent activity, under `RALPH_TIMELINE_ROOT`, for the loop's run.
  timeline: { contract: "timeline", script: "timeline.ts", args: ["--json"] },
  // The failure ledger's read half, under `RALPH_PROJECT`, for the loop's run.
  runnerFailure: { contract: "runner-failure", script: "runner-failure.ts", args: ["status", "--json"] },
  // The backlog as the loops see it, from a root checkout. `--dry-run` is
  // what makes it a read: the flag parser refuses `--json` without it.
  frontier: { contract: "frontier", script: join("frontier", "next-tasks.ts"), args: ["--dry-run", "--json"] },
  // The verifier's watch store as the Following view, under `RALPH_PROJECT`.
  // The script only reads: no lock, no write, a missing store is empty.
  following: { contract: "verifier-following", script: join("verifier", "following.ts"), args: ["--json"] },
} as const;

/** How long one frontier read is served before the tracker is asked again. */
export const FRONTIER_TTL_MS = 60_000;

/**
 * `frontier/github-rate-limit.ts:retryPolicy`'s budget. Set to 0 for the
 * dashboard's read, so a throttled census fails at once with its reason.
 */
export const FRONTIER_RETRY_BUDGET_ENV = "RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS";

/** Scopes the timeline and runner-failure reads to one run. */
const RUN_FLAG = "--run";

/**
 * Points `project-config --json` at a git ref (`git show <ref>:.ralph/config.json`):
 * the roster is read from `origin/<baseBranch>`, never the main checkout's
 * working tree, which is the operator's and may be stale or dirty.
 */
const REF_FLAG = "--at";

/** How long a working-tree fallback for the base's config is served before the base is tried again. */
const CONFIG_FALLBACK_RETRY_MS = 60_000;

/** The project config, relative to a checkout. */
const PROJECT_CONFIG_PATH = join(".ralph", "config.json");

/** The environment variables this adapter sets — the second half of the surface. */
export const ADAPTER_ENV = {
  loopStateRoot: "RALPH_STATE_ROOT",
  observerRoot: "RALPH_OBSERVER_ROOT",
  project: "RALPH_PROJECT",
  runId: "RALPH_RUN_ID",
  session: "RALPH_SESSION_ID",
  journalDir: "RALPH_JOURNAL_DIR",
  timelineRoot: "RALPH_TIMELINE_ROOT",
  // Cleared, never set: an inherited redirect would read some other ledger.
  failureLog: "RALPH_RUNNER_FAILURE_LOG",
} as const;

/** The per-worktree records and record directories the adapter reads directly, without running a CLI. */
const RECORD_PATHS = {
  ledger: join(".ralph", "logs", "usage-ledger.tsv"),
  /** The directory where `triage/ledger.ts` appends one JSONL file per unit. */
  triageLedgerDir: join(".ralph", "logs"),
} as const;

/** `triage-apply-<unit>.jsonl`, as `triage/ledger.ts:ledgerPath` names them. */
const TRIAGE_LEDGER = /^triage-apply-\d+\.jsonl$/;

/** The window `writesLastHour` counts over: a trailing hour, not the clock's. */
const TRIAGE_WRITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The cap a triage plan is validated against. Read rather than set, so it is
 * not in `ADAPTER_ENV`.
 *
 * Read from the DASHBOARD's environment. Nothing in the harness exports it
 * into a loop, so in practice both processes see it unset and both resolve the
 * same documented default; where a host does set it for one process only, the
 * panel shows this host's value, which is why the contract field says so.
 */
const TRIAGE_MAX_WRITES_ENV = "RALPH_TRIAGE_MAX_WRITES";

/**
 * The cap a plan validated in this environment would be held to.
 *
 * Mirrors `triage/validate.ts:positiveEnv` exactly, including its fallback:
 * unset, empty and anything that is not a positive integer all mean the
 * default, because that is what the validator would apply. So this is never
 * null — the cap is always knowable from the variable, and reporting nothing
 * for an unset variable would blank the number in every deployment, since
 * nothing in the harness sets it (the README documents the default instead).
 *
 * `TriageActivityView.maxWrites` is still nullable, for the different case the
 * projection owns: a loop whose triage the runtime never read at all.
 */
function positiveEnv(raw: string | undefined): number {
  const parsed = Number(raw?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : TRIAGE_MAX_WRITES_DEFAULT;
}

/** How many of the newest journal files are read per project, across every loop. */
export const JOURNAL_WINDOW = 100;

// The CLI failure vocabulary lives with the CLI read module; re-exported so
// every existing importer of the adapter keeps working.
export { RalphContractError, RalphUnavailableError } from "./cli-read";

export interface RalphAdapterConfig {
  /** Absolute directory holding the ralph CLI scripts (`loop-state.ts`, `observe.ts`). */
  cliDir: string;
  /** Absolute repo/checkout roots to enumerate. */
  roots: readonly string[];
  /** Bun executable. Defaults to the running Bun, or `bun` on PATH under a test runner. */
  bunPath?: string;
  /** Python executable for `usage.py`. Defaults to `python3` on PATH. */
  pythonPath?: string;
  /** The harness checkout whose `origin/main` holds the journal. Defaults to `cliDir`. */
  journalHome?: string;
  /** Extra environment for the child processes (merged over `process.env`). */
  env?: Env;
  /** Per-invocation timeout. The status snapshot can walk several worktrees. */
  timeoutMs?: number;
  /**
   * The project's registry id, which keys its tracker credential on this host
   * (#339). Absent: the tracker CLI derives it from the checkout, as a loop does.
   */
  projectId?: string;
  /**
   * How long a frontier read is reused, in milliseconds. The read is a whole
   * tracker census and the shell polls every few seconds, so it is the one
   * thing the adapter remembers between calls; the Following read shares it.
   * Defaults to `FRONTIER_TTL_MS`.
   */
  frontierTtlMs?: number;
  /**
   * Runs the frontier, Following and PR-status reads. Tests inject a recording
   * executor; production defaults to the process executor, so wiring is unchanged.
   */
  exec?: Executor;
  /**
   * The clock those reads' TTLs and `readAt` stamps are taken from. Tests inject
   * a fixed clock; production defaults to the wall clock.
   */
  now?: () => number;
}

export interface RalphAdapter {
  read(): Promise<RuntimeSnapshot>;
}

/**
 * The local read: the roster and each worktree's loop state, from
 * `project-config --json --at origin/<base>` (re-read only when the base's ref
 * or the checkout's config changes) and `loop-state
 * status --json`. It never runs `gh` or a per-loop read, so it is cheap
 * enough for the projects the operator is not looking at.
 */
export interface LocalReader {
  readLocal(): Promise<LocalSnapshot>;
}

/** The Bun that runs the CLI scripts: the running one, or `bun` under a test runner. */
export const defaultBunPath = (): string =>
  (process.versions as Record<string, string | undefined>).bun ? process.execPath : "bun";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

function fail(contract: string, path: string, message: string): never {
  throw new RalphContractError(contract, `${path} ${message}`);
}

function asRecord(contract: string, path: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail(contract, path, `expected an object, got ${describe(value)}`);
  return value;
}

function string(contract: string, path: string, value: unknown): string {
  if (typeof value !== "string") fail(contract, path, `expected a string, got ${describe(value)}`);
  return value;
}

function nullableString(contract: string, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return string(contract, path, value);
}

function nullableNumber(contract: string, path: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(contract, path, `expected a number, got ${describe(value)}`);
  }
  return value;
}

function number(contract: string, path: string, value: unknown): number {
  const parsed = nullableNumber(contract, path, value);
  if (parsed === null) fail(contract, path, `expected a number, got ${describe(value)}`);
  return parsed;
}

function count(contract: string, path: string, value: unknown): number {
  const parsed = number(contract, path, value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(contract, path, `expected a non-negative integer, got ${parsed}`);
  }
  return parsed;
}

function oneOf<T extends string>(
  contract: string,
  path: string,
  value: unknown,
  allowed: readonly T[],
): T {
  const text = string(contract, path, value);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(contract, path, `expected one of ${allowed.join(", ")}, got '${text}'`);
  }
  return text as T;
}

const iteration = (contract: string, path: string, value: unknown): LoopStateView["iteration"] => {
  if (value === null || value === undefined) return null;
  const raw = asRecord(contract, path, value);
  const index = nullableNumber(contract, `${path}.index`, raw.index);
  if (index === null) fail(contract, `${path}.index`, "expected a number");
  return { index, max: nullableNumber(contract, `${path}.max`, raw.max) };
};

function loopState(contract: string, path: string, value: unknown): LoopStateView {
  const raw = asRecord(contract, path, value);
  const version = nullableNumber(contract, `${path}.version`, raw.version);
  if (version !== 1) fail(contract, `${path}.version`, `expected 1, got ${String(version)}`);
  const owner = asRecord(contract, `${path}.owner`, raw.owner);
  const lastEventRaw = raw.lastEvent;
  const lastEvent =
    lastEventRaw === null || lastEventRaw === undefined
      ? null
      : (() => {
          const event = asRecord(contract, `${path}.lastEvent`, lastEventRaw);
          const detail = nullableString(contract, `${path}.lastEvent.detail`, event.detail);
          return {
            name: string(contract, `${path}.lastEvent.name`, event.name),
            at: string(contract, `${path}.lastEvent.at`, event.at),
            ...(detail === null ? {} : { detail }),
          };
        })();
  const stopRaw = raw.stopReason;
  const stopReason: StopReason | null =
    stopRaw === null || stopRaw === undefined
      ? null
      : (() => {
          const stop = asRecord(contract, `${path}.stopReason`, stopRaw);
          return {
            kind: oneOf<StopKind>(contract, `${path}.stopReason.kind`, stop.kind, STOP_KINDS),
            why: string(contract, `${path}.stopReason.why`, stop.why),
            at: string(contract, `${path}.stopReason.at`, stop.at),
            // Newer than the record (#6) and only advisory: a malformed value is
            // left out rather than failing the loop's record, so the reconciler
            // falls back to keeping the loop stopped (house rule 1).
            ...(typeof stop.signal === "string" && stop.signal !== "" ? { signal: stop.signal } : {}),
            ...(typeof stop.self === "boolean" ? { self: stop.self } : {}),
          };
        })();
  return {
    version: 1,
    run: string(contract, `${path}.run`, raw.run),
    owner: {
      loop: string(contract, `${path}.owner.loop`, owner.loop),
      pid: nullableNumber(contract, `${path}.owner.pid`, owner.pid),
      host: string(contract, `${path}.owner.host`, owner.host),
    },
    worktree: string(contract, `${path}.worktree`, raw.worktree),
    branch: nullableString(contract, `${path}.branch`, raw.branch),
    stage: oneOf<Stage>(contract, `${path}.stage`, raw.stage, STAGES),
    iteration: iteration(contract, `${path}.iteration`, raw.iteration),
    heartbeat: string(contract, `${path}.heartbeat`, raw.heartbeat),
    lastEvent,
    stopReason,
    ...(typeof raw.session === "string" && raw.session.trim() !== "" ? { session: raw.session.trim() } : {}),
    // Optional and newer than the record: a value this build does not know is
    // left out rather than failing the whole loop's record.
    ...(typeof raw.phase === "string" && (PHASES as readonly string[]).includes(raw.phase)
      ? { phase: raw.phase as Phase }
      : {}),
    ...(typeof raw.resumedAt === "string" && (PHASES as readonly string[]).includes(raw.resumedAt)
      ? { resumedAt: raw.resumedAt as Phase }
      : {}),
    ...(typeof raw.lastIterationEndAt === "string" && !Number.isNaN(Date.parse(raw.lastIterationEndAt))
      ? { lastIterationEndAt: raw.lastIterationEndAt }
      : {}),
  };
}

/** Narrow `loop-state status --json` — the machine-wide snapshot. */
export function narrowSnapshot(
  value: unknown,
): { self: string; loops: RawLoopReport[]; reconciliation: Reconciliation } {
  const contract = "loop-state";
  const raw = asRecord(contract, "$", value);
  const loopsRaw = raw.loops;
  if (!Array.isArray(loopsRaw)) fail(contract, "$.loops", `expected an array, got ${describe(loopsRaw)}`);
  const loops = loopsRaw.map((entry, index) => narrowLoopReport(entry, `$.loops[${index}]`));
  const reconciliation = asRecord(contract, "$.reconciliation", raw.reconciliation);
  return {
    self: string(contract, "$.self", raw.self),
    loops,
    reconciliation: {
      orphaned: stringArray(contract, "$.reconciliation.orphaned", reconciliation.orphaned),
      prunable: stringArray(contract, "$.reconciliation.prunable", reconciliation.prunable),
    },
  };
}

function stringArray(contract: string, path: string, value: unknown): string[] {
  if (!Array.isArray(value)) fail(contract, path, `expected an array, got ${describe(value)}`);
  return value.map((item, index) => string(contract, `${path}[${index}]`, item));
}

export interface RawLoopReport {
  worktree: string;
  worktreeStatus: WorktreeStatus;
  loopStatus: LoopStatus;
  branch: string | null;
  state: LoopStateView | null;
  stateProblem: StateProblem;
  supervisor: Liveness;
}

function narrowLoopReport(value: unknown, path: string): RawLoopReport {
  const contract = "loop-state";
  const raw = asRecord(contract, path, value);
  const problemRaw = raw.stateProblem;
  const stateProblem: StateProblem =
    problemRaw === null || problemRaw === undefined
      ? null
      : oneOf(contract, `${path}.stateProblem`, problemRaw, STATE_PROBLEMS);
  return {
    worktree: string(contract, `${path}.worktree`, raw.worktree),
    worktreeStatus: oneOf<WorktreeStatus>(
      contract,
      `${path}.worktreeStatus`,
      raw.worktreeStatus,
      WORKTREE_STATUSES,
    ),
    loopStatus: oneOf<LoopStatus>(contract, `${path}.loopStatus`, raw.loopStatus, LOOP_STATUSES),
    branch: nullableString(contract, `${path}.branch`, raw.branch),
    state:
      raw.state === null || raw.state === undefined
        ? null
        : loopState(contract, `${path}.state`, raw.state),
    stateProblem,
    supervisor: oneOf<Liveness>(contract, `${path}.supervisor`, raw.supervisor, LIVENESSES),
  };
}

function array(contract: string, path: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) fail(contract, path, `expected an array, got ${describe(value)}`);
  return value;
}

function boolean(contract: string, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") fail(contract, path, `expected a boolean, got ${describe(value)}`);
  return value;
}

function actorView(contract: string, path: string, value: unknown): ActorView {
  const raw = asRecord(contract, path, value);
  return {
    stage: oneOf<ActorStage>(contract, `${path}.stage`, raw.stage, ACTOR_STAGES),
    state: oneOf<ActorState>(contract, `${path}.state`, raw.state, ACTOR_STATES),
    invocation: nullableString(contract, `${path}.invocation`, raw.invocation),
    runner: nullableString(contract, `${path}.runner`, raw.runner),
    model: nullableString(contract, `${path}.model`, raw.model),
    startedAt: nullableString(contract, `${path}.startedAt`, raw.startedAt),
    endedAt: nullableString(contract, `${path}.endedAt`, raw.endedAt),
    lastAction: nullableString(contract, `${path}.lastAction`, raw.lastAction),
    activityAt: nullableString(contract, `${path}.activityAt`, raw.activityAt),
  };
}

function activityView(contract: string, path: string, value: unknown): ActivityView {
  const raw = asRecord(contract, path, value);
  return {
    stage: string(contract, `${path}.stage`, raw.stage),
    label: string(contract, `${path}.label`, raw.label),
    at: string(contract, `${path}.at`, raw.at),
    iteration: nullableNumber(contract, `${path}.iteration`, raw.iteration),
    run: nullableString(contract, `${path}.run`, raw.run),
  };
}

function issueHistoryView(contract: string, path: string, value: unknown): IssueHistoryView {
  const raw = asRecord(contract, path, value);
  const issue = nullableNumber(contract, `${path}.issue`, raw.issue);
  if (issue === null) fail(contract, `${path}.issue`, "expected a number");
  return {
    issue,
    state: oneOf<IssueState>(contract, `${path}.state`, raw.state, ISSUE_STATES),
    pr: nullableNumber(contract, `${path}.pr`, raw.pr),
    draft: boolean(contract, `${path}.draft`, raw.draft),
    title: nullableString(contract, `${path}.title`, raw.title),
    detail: nullableString(contract, `${path}.detail`, raw.detail),
    block:
      raw.block === null
        ? null
        : oneOf<JournalBlockKind>(contract, `${path}.block`, raw.block, JOURNAL_BLOCK_KINDS),
    at: string(contract, `${path}.at`, raw.at),
  };
}

/** Narrow `observe --json` — one worktree's live presence. */
export function narrowPresence(value: unknown): PresenceView {
  const contract = "observe";
  const raw = asRecord(contract, "$", value);
  const step = raw.step === null || raw.step === undefined ? null : asRecord(contract, "$.step", raw.step);
  const phase = asRecord(contract, "$.phase", raw.phase);
  return {
    loop: string(contract, "$.loop", raw.loop),
    run: nullableString(contract, "$.run", raw.run),
    status: oneOf(contract, "$.status", raw.status, LOOP_STATUSES),
    supervisor: oneOf(contract, "$.supervisor", raw.supervisor, LIVENESSES),
    issue: nullableNumber(contract, "$.issue", raw.issue),
    branch: nullableString(contract, "$.branch", raw.branch),
    iteration: iteration(contract, "$.iteration", raw.iteration),
    observedAt: string(contract, "$.observedAt", raw.observedAt),
    issues: array(contract, "$.issues", raw.issues).map((item, index) =>
      issueHistoryView(contract, `$.issues[${index}]`, item),
    ),
    actors: array(contract, "$.actors", raw.actors).map((item, index) =>
      actorView(contract, `$.actors[${index}]`, item),
    ),
    recent: array(contract, "$.recent", raw.recent).map((item, index) =>
      activityView(contract, `$.recent[${index}]`, item),
    ),
    failureReason: nullableString(contract, "$.failureReason", raw.failureReason),
    step:
      step === null
        ? null
        : { stage: string(contract, "$.step.stage", step.stage), action: string(contract, "$.step.action", step.action) },
    phase: {
      index: number(contract, "$.phase.index", phase.index),
      total: number(contract, "$.phase.total", phase.total),
      label: string(contract, "$.phase.label", phase.label),
    },
    warning: nullableString(contract, "$.warning", raw.warning),
  };
}

function integer(contract: string, path: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(contract, path, `expected an integer, got ${describe(value)}`);
  }
  return value;
}

/** Narrow `claim-lease status --json` — every lease in the store. */
export function narrowLeases(value: unknown): LeaseView[] {
  const contract = "claim-lease";
  const raw = asRecord(contract, "$", value);
  const version = nullableNumber(contract, "$.version", raw.version);
  if (version !== 1) fail(contract, "$.version", `expected 1, got ${String(version)}`);
  if (!Array.isArray(raw.leases)) fail(contract, "$.leases", `expected an array, got ${describe(raw.leases)}`);
  return raw.leases.map((entry, index) => {
    const path = `$.leases[${index}]`;
    const lease = asRecord(contract, path, entry);
    return {
      issue: integer(contract, `${path}.issue`, lease.issue),
      run: string(contract, `${path}.run`, lease.run),
      loop: string(contract, `${path}.loop`, lease.loop),
      owner: string(contract, `${path}.owner`, lease.owner),
      host: string(contract, `${path}.host`, lease.host),
      worktree: string(contract, `${path}.worktree`, lease.worktree),
      branch: nullableString(contract, `${path}.branch`, lease.branch),
      claimedAt: string(contract, `${path}.claimedAt`, lease.claimedAt),
      heartbeatAt: string(contract, `${path}.heartbeatAt`, lease.heartbeatAt),
      expiresAt: string(contract, `${path}.expiresAt`, lease.expiresAt),
    };
  });
}

/** A loop's claim label, as `frontier/next-tasks.ts` writes it. */
const claimLabelOf = (loop: string): string => `${loop}-wip`;

/** A check that ended in a way a person has to look at; CANCELLED and SKIPPED are not. */
const RED_CHECK = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/**
 * One open PR's standing from its check rollup. A rollup entry is either a
 * check run (`status` + `conclusion`) or a commit status (`state`). Red wins
 * over everything, because a red PR in the queue is about to be thrown out of
 * it; then the merge queue's own check, which only runs once the PR is green;
 * then anything still running.
 */
export function pullState(rollup: readonly unknown[]): PullState {
  const checks = rollup.flatMap((entry) =>
    entry !== null && typeof entry === "object" ? [entry as Record<string, unknown>] : [],
  );
  if (checks.length === 0) return "open";
  const name = (check: Record<string, unknown>): string => String(check.name ?? check.context ?? "");
  const ended = (check: Record<string, unknown>): boolean =>
    check.state !== undefined ? check.state !== "PENDING" && check.state !== "EXPECTED" : check.status === "COMPLETED";
  const result = (check: Record<string, unknown>): string => String(check.conclusion ?? check.state ?? "");
  if (checks.some((check) => ended(check) && RED_CHECK.has(result(check)))) return "failing";
  const queue = checks.filter((check) => /merge queue/i.test(name(check)));
  if (queue.some((check) => !ended(check))) return "queued";
  if (checks.some((check) => !queue.includes(check) && !ended(check))) return "testing";
  return "green";
}

/**
 * Narrow `gh pr list` (open, then merged) to one status per ticket. A PR
 * closes the tickets its `closingIssuesReferences` names; both lists come
 * newest first, so the first PR seen for a ticket is its newest, and an open
 * one is read before any merged one.
 */
export function narrowPullStatuses(open: unknown, merged: unknown): PullStatusView[] {
  const contract = "gh-pulls";
  const statuses = new Map<number, PullStatusView>();
  const each = (
    value: unknown,
    list: string,
    status: (pr: Record<string, unknown>, path: string) => Omit<PullStatusView, "issue" | "pr">,
  ) => {
    if (!Array.isArray(value)) fail(contract, list, `expected an array, got ${describe(value)}`);
    value.forEach((entry, index) => {
      const path = `${list}[${index}]`;
      const pr = asRecord(contract, path, entry);
      const number = integer(contract, `${path}.number`, pr.number);
      const closes = Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : [];
      const standing = status(pr, path);
      closes.forEach((reference, at) => {
        const issue = integer(contract, `${path}.closingIssuesReferences[${at}].number`, asRecord(contract, path, reference).number);
        if (!statuses.has(issue)) statuses.set(issue, { issue, pr: number, ...standing });
      });
    });
  };
  each(open, "$open", (pr) => ({
    state: pullState(Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []),
    draft: pr.isDraft === true,
    mergedAt: null,
  }));
  each(merged, "$merged", (pr) => ({
    state: "merged",
    draft: false,
    mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : null,
  }));
  return [...statuses.values()].sort((a, b) => a.issue - b.issue);
}

/**
 * Narrow `gh issue list --json number,title,labels` to the roster's claims.
 *
 * One claim per roster loop whose label an issue carries; queue, stuck and
 * foreign labels are not claims. The label convention is resolved here so the
 * aggregation only ever sees a loop name.
 */
export function narrowGithubClaims(value: unknown, roster: readonly string[]): GithubClaimView[] {
  const contract = "gh";
  if (!Array.isArray(value)) fail(contract, "$", `expected an array, got ${describe(value)}`);
  return value.flatMap((entry, index) => {
    const path = `$[${index}]`;
    const issue = asRecord(contract, path, entry);
    const number = integer(contract, `${path}.number`, issue.number);
    const title = string(contract, `${path}.title`, issue.title);
    if (!Array.isArray(issue.labels)) {
      fail(contract, `${path}.labels`, `expected an array, got ${describe(issue.labels)}`);
    }
    const labels = issue.labels.map((label, at) =>
      string(contract, `${path}.labels[${at}].name`, asRecord(contract, `${path}.labels[${at}]`, label).name),
    );
    return roster
      .filter((loop) => labels.includes(claimLabelOf(loop)))
      .map((loop) => ({ issue: number, title, loop }));
  });
}

/** Narrow `frontier/next-tasks.ts --dry-run --json` to the backlog view. */
export function narrowFrontier(value: unknown): FrontierView {
  const contract = "frontier";
  const raw = asRecord(contract, "$", value);
  const list = (path: string, entries: unknown): unknown[] => {
    if (!Array.isArray(entries)) fail(contract, path, `expected an array, got ${describe(entries)}`);
    return entries;
  };
  const ticket = (path: string, entry: unknown): { number: number; title: string; rest: Record<string, unknown> } => {
    const record = asRecord(contract, path, entry);
    return {
      number: integer(contract, `${path}.number`, record.number),
      title: string(contract, `${path}.title`, record.title),
      rest: record,
    };
  };
  const numbers = (path: string, entries: unknown): number[] =>
    list(path, entries).map((n, at) => integer(contract, `${path}[${at}]`, n));
  return {
    ready: list("$.ready", raw.ready).map((entry, index) => {
      const path = `$.ready[${index}]`;
      const group = asRecord(contract, path, entry);
      const spec = group.spec === null ? null : ticket(`${path}.spec`, group.spec);
      return {
        spec: spec === null ? null : { number: spec.number, title: spec.title },
        staffingGroup: nullableString(contract, `${path}.staffingGroup`, group.staffingGroup),
        waiting: count(contract, `${path}.waiting`, group.waiting),
        tickets: list(`${path}.tickets`, group.tickets).map((member, at) => {
          const t = ticket(`${path}.tickets[${at}]`, member);
          return {
            number: t.number,
            title: t.title,
            frees: count(contract, `${path}.tickets[${at}].frees`, t.rest.frees),
            stuck: nullableString(contract, `${path}.tickets[${at}].stuck`, t.rest.stuck),
          };
        }),
      };
    }),
    occupied: list("$.occupied", raw.occupied).map((entry, index) => {
      const t = ticket(`$.occupied[${index}]`, entry);
      return { number: t.number, title: t.title, heldBy: integer(contract, `$.occupied[${index}].heldBy`, t.rest.heldBy) };
    }),
    specs: list("$.specs", raw.specs).map((entry, index) => {
      const t = ticket(`$.specs[${index}]`, entry);
      return { number: t.number, title: t.title, children: count(contract, `$.specs[${index}].children`, t.rest.children) };
    }),
    inFlight: list("$.inFlight", raw.inFlight).map((entry, index) => {
      const path = `$.inFlight[${index}]`;
      const t = ticket(path, entry);
      return {
        number: t.number,
        title: t.title,
        loop: nullableString(contract, `${path}.loop`, t.rest.loop),
        claim: string(contract, `${path}.claim`, t.rest.claim),
        queued: typeof t.rest.queued === "boolean" ? t.rest.queued : fail(contract, `${path}.queued`, "expected a boolean"),
      };
    }),
    blocked: list("$.blocked", raw.blocked).map((entry, index) => {
      const path = `$.blocked[${index}]`;
      const t = ticket(path, entry);
      return {
        number: t.number,
        title: t.title,
        blockers: numbers(`${path}.blockers`, t.rest.blockers),
        stuck: nullableString(contract, `${path}.stuck`, t.rest.stuck),
      };
    }),
    gates: list("$.gates", raw.gates).map((entry, index) => {
      const t = ticket(`$.gates[${index}]`, entry);
      return { number: t.number, title: t.title };
    }),
    stuck: list("$.stuck", raw.stuck).map((entry, index) => {
      const t = ticket(`$.stuck[${index}]`, entry);
      return { number: t.number, title: t.title, label: string(contract, `$.stuck[${index}].label`, t.rest.label) };
    }),
    tree: list("$.tree", raw.tree).map((entry, index) => treeGroup(contract, `$.tree[${index}]`, entry)),
    untriaged: list("$.untriaged", raw.untriaged).map((entry, index) => {
      const t = ticket(`$.untriaged[${index}]`, entry);
      return { number: t.number, title: t.title };
    }),
    stuckReasons: list("$.stuckReasons", raw.stuckReasons).map((entry, index) => {
      const path = `$.stuckReasons[${index}]`;
      const { number, title, rest: record } = ticket(path, entry);
      return {
        number,
        title,
        kind: oneOf<BlockKind>(contract, `${path}.kind`, record.kind, BLOCK_KINDS),
        reason: nullableString(contract, `${path}.reason`, record.reason),
        pr: record.pr === null ? null : integer(contract, `${path}.pr`, record.pr),
        migration: nullableString(contract, `${path}.migration`, record.migration),
        at: nullableString(contract, `${path}.at`, record.at),
        // Absent from a frontier that predates #776 — it runs from the
        // harness's `origin/main`, which can lag the dashboard — so missing
        // reads as no park rather than as a broken read.
        park:
          record.park === undefined || record.park === null
            ? null
            : parkReasonOf(contract, `${path}.park`, record.park),
      };
    }),
    triage: ((): Record<TriageBucket, number> => {
      const counts = asRecord(contract, "$.triage", raw.triage);
      return Object.fromEntries(
        TRIAGE_BUCKETS.map((bucket) => [bucket, count(contract, `$.triage.${bucket}`, counts[bucket])]),
      ) as Record<TriageBucket, number>;
    })(),
    // Absent from a frontier that predates it — the script runs from the
    // harness's `origin/main`, which can lag the dashboard — so missing reads
    // as nothing waiting on the operator rather than as a broken read.
    human:
      raw.human === undefined
        ? []
        : list("$.human", raw.human).map((entry, index) => {
            const path = `$.human[${index}]`;
            const t = ticket(path, entry);
            return { number: t.number, title: t.title, reason: humanReasonOf(contract, `${path}.reason`, t.rest.reason) };
          }),
    // Absent from a frontier that predates it, for the same lag as `human`:
    // missing reads as nothing dropped rather than as a broken read.
    dropped:
      raw.dropped === undefined
        ? []
        : list("$.dropped", raw.dropped).map((entry, index) => {
            const path = `$.dropped[${index}]`;
            const t = ticket(path, entry);
            return {
              number: t.number,
              title: t.title,
              references: list(`${path}.references`, t.rest.references).map((ref, at) => {
                const refPath = `${path}.references[${at}]`;
                const record = asRecord(contract, refPath, ref);
                return {
                  heading: string(contract, `${refPath}.heading`, record.heading),
                  reference: string(contract, `${refPath}.reference`, record.reference),
                  reason: string(contract, `${refPath}.reason`, record.reason),
                };
              }),
            };
          }),
  };
}

/**
 * Narrow `verifier/following.ts --json` to the Following view. A wrong top
 * level or version is drift; one watch whose state or held-back verdict this
 * dashboard does not know is dropped instead, so a newer CLI's addition costs
 * that row, not the panel — as `ci-health.ts` treats its cases.
 */
export function narrowFollowing(value: unknown): FollowingView {
  const contract = "verifier-following";
  const raw = asRecord(contract, "$", value);
  if (raw.version !== 1) fail(contract, "$.version", `expected 1, got ${describe(raw.version)}`);
  if (!Array.isArray(raw.watches)) fail(contract, "$.watches", `expected an array, got ${describe(raw.watches)}`);
  const known = <T extends string>(allowed: readonly T[], text: unknown): text is T =>
    typeof text === "string" && (allowed as readonly string[]).includes(text);
  const watches: FollowingWatchView[] = [];
  raw.watches.forEach((entry, index) => {
    const path = `$.watches[${index}]`;
    const watch = asRecord(contract, path, entry);
    if (!known(FOLLOWING_STATES, watch.state)) return;
    const list = (key: string): Record<string, unknown>[] => {
      const items = watch[key];
      if (!Array.isArray(items)) fail(contract, `${path}.${key}`, `expected an array, got ${describe(items)}`);
      return items.map((item, at) => asRecord(contract, `${path}.${key}[${at}]`, item));
    };
    const wouldBeRaw = list("wouldBe");
    if (!wouldBeRaw.every((item) => known(FOLLOWING_WOULD_BE, item.verdict))) return;
    const number = (key: string, at: Record<string, unknown>, where: string): number => {
      const n = at[key];
      if (typeof n !== "number" || !Number.isFinite(n)) fail(contract, `${where}.${key}`, `expected a number, got ${describe(n)}`);
      return n;
    };
    const next = watch.nextCheckIn === null ? null : asRecord(contract, `${path}.nextCheckIn`, watch.nextCheckIn);
    const verdict = watch.verdict === null ? null : asRecord(contract, `${path}.verdict`, watch.verdict);
    watches.push({
      pr: integer(contract, `${path}.pr`, watch.pr),
      ticket: integer(contract, `${path}.ticket`, watch.ticket),
      ticketRef: string(contract, `${path}.ticketRef`, watch.ticketRef),
      mode: string(contract, `${path}.mode`, watch.mode),
      round: integer(contract, `${path}.round`, watch.round),
      mergedAt: string(contract, `${path}.mergedAt`, watch.mergedAt),
      deployedAt: string(contract, `${path}.deployedAt`, watch.deployedAt),
      deployUrl: nullableString(contract, `${path}.deployUrl`, watch.deployUrl),
      openedAt: string(contract, `${path}.openedAt`, watch.openedAt),
      state: watch.state,
      nextCheckIn:
        next === null
          ? null
          : {
              offsetHours: number("offsetHours", next, `${path}.nextCheckIn`),
              dueAt: string(contract, `${path}.nextCheckIn.dueAt`, next.dueAt),
            },
      checkInsDone: integer(contract, `${path}.checkInsDone`, watch.checkInsDone),
      checkInsTotal: integer(contract, `${path}.checkInsTotal`, watch.checkInsTotal),
      verdict:
        verdict === null
          ? null
          : {
              verdict: string(contract, `${path}.verdict.verdict`, verdict.verdict),
              reason: string(contract, `${path}.verdict.reason`, verdict.reason),
              act:
                typeof verdict.act === "boolean" ? verdict.act : fail(contract, `${path}.verdict.act`, "expected a boolean"),
              wouldHaveBeen: nullableString(contract, `${path}.verdict.wouldHaveBeen`, verdict.wouldHaveBeen),
            },
      wouldBe: wouldBeRaw.map((item, at) => ({
        verdict: item.verdict as FollowingWatchView["wouldBe"][number]["verdict"],
        reason: string(contract, `${path}.wouldBe[${at}].reason`, item.reason),
        at: item.at === null ? null : number("at", item, `${path}.wouldBe[${at}]`),
      })),
      notVerifiableLive: list("notVerifiableLive").map((item, at) => ({
        criterion: string(contract, `${path}.notVerifiableLive[${at}].criterion`, item.criterion),
        detail: nullableString(contract, `${path}.notVerifiableLive[${at}].detail`, item.detail),
      })),
    });
  });
  return { version: 1, watches };
}

function parkConditionOf(contract: string, path: string, value: unknown): ParkCondition {
  const raw = asRecord(contract, path, value);
  const kind = oneOf<ParkConditionKind>(contract, `${path}.kind`, raw.kind, PARK_CONDITION_KINDS);
  switch (kind) {
    case "reference":
      return { kind, ref: string(contract, `${path}.ref`, raw.ref) };
    case "check":
      return {
        kind,
        name: string(contract, `${path}.name`, raw.name),
        on: oneOf<"pr" | "main">(contract, `${path}.on`, raw.on, ["pr", "main"]),
      };
    case "step":
      return { kind, check: string(contract, `${path}.check`, raw.check), step: string(contract, `${path}.step`, raw.step) };
    case "label-removed":
      return { kind, label: string(contract, `${path}.label`, raw.label) };
  }
}

function parkReasonOf(contract: string, path: string, value: unknown): ParkReason {
  const raw = asRecord(contract, path, value);
  return {
    loop: string(contract, `${path}.loop`, raw.loop),
    label: string(contract, `${path}.label`, raw.label),
    pr: raw.pr === null ? null : integer(contract, `${path}.pr`, raw.pr),
    summary: string(contract, `${path}.summary`, raw.summary),
    condition: parkConditionOf(contract, `${path}.condition`, raw.condition),
    since: string(contract, `${path}.since`, raw.since),
    budgetUntil: string(contract, `${path}.budgetUntil`, raw.budgetUntil),
    remainingSeconds: count(contract, `${path}.remainingSeconds`, raw.remainingSeconds),
    expired: boolean(contract, `${path}.expired`, raw.expired),
    escalatedAt: nullableString(contract, `${path}.escalatedAt`, raw.escalatedAt),
  };
}

function humanReasonOf(contract: string, path: string, value: unknown): HumanReason {
  return oneOf<HumanReason>(contract, path, value, HUMAN_REASONS);
}

function treeState(contract: string, path: string, value: unknown): TreeState {
  if (typeof value === "string" && (TREE_STATES as readonly string[]).includes(value)) return value as TreeState;
  return fail(contract, path, `expected one of ${TREE_STATES.join(", ")}, got ${describe(value)}`);
}

function integers(contract: string, path: string, value: unknown): number[] {
  if (!Array.isArray(value)) fail(contract, path, `expected an array, got ${describe(value)}`);
  return value.map((n, at) => integer(contract, `${path}[${at}]`, n));
}

function treeNode(contract: string, path: string, value: unknown): FrontierTreeNode {
  const raw = asRecord(contract, path, value);
  if (!Array.isArray(raw.children)) fail(contract, `${path}.children`, `expected an array, got ${describe(raw.children)}`);
  return {
    number: integer(contract, `${path}.number`, raw.number),
    title: string(contract, `${path}.title`, raw.title),
    state: treeState(contract, `${path}.state`, raw.state),
    stuck: nullableString(contract, `${path}.stuck`, raw.stuck),
    detail: nullableString(contract, `${path}.detail`, raw.detail),
    otherBlockers: integers(contract, `${path}.otherBlockers`, raw.otherBlockers),
    heldBy: raw.heldBy === null ? null : integer(contract, `${path}.heldBy`, raw.heldBy),
    frees: count(contract, `${path}.frees`, raw.frees),
    human: raw.human === undefined || raw.human === null ? null : humanReasonOf(contract, `${path}.human`, raw.human),
    children: raw.children.map((child, at) => treeNode(contract, `${path}.children[${at}]`, child)),
  };
}

function treeGroup(contract: string, path: string, value: unknown): FrontierTreeGroup {
  const raw = asRecord(contract, path, value);
  if (!Array.isArray(raw.roots)) fail(contract, `${path}.roots`, `expected an array, got ${describe(raw.roots)}`);
  let spec: FrontierTreeGroup["spec"] = null;
  if (raw.spec !== null) {
    const record = asRecord(contract, `${path}.spec`, raw.spec);
    spec = {
      number: integer(contract, `${path}.spec.number`, record.number),
      title: nullableString(contract, `${path}.spec.title`, record.title),
      state: record.state === null ? null : treeState(contract, `${path}.spec.state`, record.state),
      detail: nullableString(contract, `${path}.spec.detail`, record.detail),
      stuck: nullableString(contract, `${path}.spec.stuck`, record.stuck),
      blockers: integers(contract, `${path}.spec.blockers`, record.blockers),
    };
  }
  return {
    spec,
    under: raw.under === null ? null : integer(contract, `${path}.under`, raw.under),
    subSpecs: integers(contract, `${path}.subSpecs`, raw.subSpecs),
    total: count(contract, `${path}.total`, raw.total),
    complete: boolean(contract, `${path}.complete`, raw.complete),
    specStillOpen: boolean(contract, `${path}.specStillOpen`, raw.specStillOpen),
    roots: raw.roots.map((root, at) => treeNode(contract, `${path}.roots[${at}]`, root)),
  };
}

function tokenUsage(contract: string, path: string, value: unknown): TokenUsage {
  const raw = asRecord(contract, path, value);
  return {
    input: count(contract, `${path}.input`, raw.input),
    output: count(contract, `${path}.output`, raw.output),
    cache5m: count(contract, `${path}.cache_5m`, raw.cache_5m),
    cache1h: count(contract, `${path}.cache_1h`, raw.cache_1h),
    cacheRead: count(contract, `${path}.cache_read`, raw.cache_read),
    inputTotal: count(contract, `${path}.input_total`, raw.input_total),
  };
}

/**
 * Narrow `usage.py --json` — one session's iteration, run and context scopes.
 *
 * The `step` scope is validated by nothing here and not carried: under
 * `--no-record` it is the delta since the loop's last report, not a step the
 * loop took. A context percentage without a known window is the CLI's `0`
 * placeholder, so it is carried as null rather than as a measurement.
 */
export function narrowUsage(value: unknown): UsageView {
  const contract = "usage";
  const raw = asRecord(contract, "$", value);
  const iterationRaw = asRecord(contract, "$.iteration", raw.iteration);
  const models = asRecord(contract, "$.iteration.models", iterationRaw.models);
  const run = asRecord(contract, "$.run", raw.run);
  const context = asRecord(contract, "$.context", raw.context);
  const window = nullableNumber(contract, "$.context.window", context.window);
  const percent = number(contract, "$.context.percent", context.percent);
  return {
    session: string(contract, "$.session", raw.session),
    runId: string(contract, "$.run_id", raw.run_id),
    iteration: {
      turns: count(contract, "$.iteration.turns", iterationRaw.turns),
      elapsedSeconds: nullableNumber(contract, "$.iteration.elapsed_seconds", iterationRaw.elapsed_seconds),
      usage: tokenUsage(contract, "$.iteration.usage", iterationRaw.usage),
      models: Object.entries(models).map(([model, usage]) => ({
        model,
        usage: tokenUsage(contract, `$.iteration.models.${model}`, usage),
      })),
    },
    run: {
      steps: count(contract, "$.run.steps", run.steps),
      usage: tokenUsage(contract, "$.run.usage", run.usage),
    },
    context: {
      model: nullableString(contract, "$.context.model", context.model),
      tokens: count(contract, "$.context.tokens", context.tokens),
      window,
      percent: window === null ? null : percent,
    },
  };
}

/**
 * Narrow `timeline.ts --json` — one worktree's activity for the loop's run.
 *
 * The version is the contract's own guard: timeline bumps it only for a shape
 * a reader cannot absorb. `exists: false` is carried, not collapsed, so the
 * projection can tell an absent timeline from an empty one.
 */
export function narrowTimeline(value: unknown): TimelineView {
  const contract = "timeline";
  const raw = asRecord(contract, "$", value);
  const version = nullableNumber(contract, "$.version", raw.version);
  if (version !== 1) fail(contract, "$.version", `expected 1, got ${String(version)}`);
  return {
    exists: boolean(contract, "$.exists", raw.exists),
    path: nullableString(contract, "$.path", raw.path),
    activities: array(contract, "$.activities", raw.activities).map((entry, index) => {
      const path = `$.activities[${index}]`;
      const activity = asRecord(contract, path, entry);
      return {
        stage: oneOf<ActorStage>(contract, `${path}.stage`, activity.stage, ACTOR_STAGES),
        label: string(contract, `${path}.label`, activity.label),
        at: string(contract, `${path}.at`, activity.at),
        iteration: nullableNumber(contract, `${path}.iteration`, activity.iteration),
        run: nullableString(contract, `${path}.run`, activity.run),
      };
    }),
  };
}

/** A signal list's evidence, each entry validated as the runtime writes it. */
function evidenceOf(contract: string, path: string, value: unknown): string[] {
  return array(contract, path, value).map((entry, index) => {
    const signal = asRecord(contract, `${path}[${index}]`, entry);
    string(contract, `${path}[${index}].kind`, signal.kind);
    return string(contract, `${path}[${index}].evidence`, signal.evidence);
  });
}

function runnerFailure(contract: string, path: string, value: unknown): RunnerFailureView {
  const raw = asRecord(contract, path, value);
  const version = nullableNumber(contract, `${path}.version`, raw.version);
  if (version !== 1) fail(contract, `${path}.version`, `expected 1, got ${String(version)}`);
  const attempt = asRecord(contract, `${path}.attempt`, raw.attempt);
  return {
    at: string(contract, `${path}.at`, raw.at),
    loop: string(contract, `${path}.loop`, raw.loop),
    run: nullableString(contract, `${path}.run`, raw.run),
    iteration: nullableNumber(contract, `${path}.attempt.iteration`, attempt.iteration),
    stage: string(contract, `${path}.stage`, raw.stage),
    runner: nullableString(contract, `${path}.runner`, raw.runner),
    model: nullableString(contract, `${path}.model`, raw.model),
    issue: nullableNumber(contract, `${path}.issue`, raw.issue),
    exitCode: integer(contract, `${path}.exitCode`, raw.exitCode),
    kind: string(contract, `${path}.kind`, raw.kind),
    summary: string(contract, `${path}.summary`, raw.summary),
    visibility: oneOf<FailureVisibility>(contract, `${path}.visibility`, raw.visibility, FAILURE_VISIBILITIES),
    evidence: evidenceOf(contract, `${path}.signals`, raw.signals),
    note: nullableString(contract, `${path}.note`, raw.note),
  };
}

/**
 * Narrow `runner-failure.ts status --json` — the settled failures for a run.
 *
 * `inFlight` is validated so its drift is loud too, but not carried: it is not
 * scoped to a run, and a panel reports what the run's record settled.
 */
export function narrowRunnerFailures(value: unknown): RunnerFailuresView {
  const contract = "runner-failure";
  const raw = asRecord(contract, "$", value);
  array(contract, "$.inFlight", raw.inFlight).forEach((entry, index) => {
    const path = `$.inFlight[${index}]`;
    const pending = asRecord(contract, path, entry);
    string(contract, `${path}.file`, pending.file);
    evidenceOf(contract, `${path}.signals`, pending.signals);
  });
  return {
    settled: array(contract, "$.settled", raw.settled).map((entry, index) =>
      runnerFailure(contract, `$.settled[${index}]`, entry),
    ),
  };
}

/** Narrow `project-config --json` to the one field the dashboard reads. */
export function narrowJournalDir(value: unknown): string {
  const contract = "project-config";
  const raw = asRecord(contract, "$", value);
  const journal = asRecord(contract, "$.journal", raw.journal);
  return string(contract, "$.journal.dir", journal.dir);
}

/** `journal.branch`, or null when the project publishes into the harness. */
export function narrowJournalBranch(value: unknown): string | null {
  const contract = "project-config";
  const raw = asRecord(contract, "$", value);
  const journal = asRecord(contract, "$.journal", raw.journal);
  return journal.branch === undefined ? null : string(contract, "$.journal.branch", journal.branch);
}

/**
 * `learnings.file` from the project config, or null when the project opted out.
 *
 * `parseProjectConfig` has already resolved the default from `journal.dir`, so
 * this never re-derives it: two derivations of one path is how the panel would
 * come to show a file nothing writes.
 */
export function narrowLearningsFile(value: unknown): string | false {
  const contract = "project-config";
  const raw = asRecord(contract, "$", value);
  // `false`, not null: null is `learningsFor`'s "the config could not be
  // read", and a project that deliberately opted out is not an unknown.
  if (raw.learnings === false) return false;
  const learnings = asRecord(contract, "$.learnings", raw.learnings);
  return string(contract, "$.learnings.file", learnings.file);
}

const ENTRY_PATH = /\/\d{8}T\d{6}Z-[^/]*\.md$/;
const ENTRY_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(\d+|none)-/;
const ENTRY_LOOP = /\bLoop:\s*\*\*([^*\s]+)\*\*/i;
const ENTRY_TITLE = /^#\s+(.+?)\s*$/m;
const ENTRY_OUTCOME = /^\*\*Outcome:\s*(.+?)\.?\*\*/m;

/**
 * One journal entry, from its file name and body.
 *
 * The name carries the time and the issue (`none` when the iteration picked
 * nothing); the body carries the heading, the `**Outcome:**` line and the loop
 * that signed it — the same lines `status.sh` and `observe.ts` read. Markdown
 * is not a contract, so nothing here throws: what the entry does not say is
 * null.
 */
export function narrowJournalEntry(name: string, body: string): JournalEntryView {
  const stamp = ENTRY_NAME.exec(name);
  return {
    name,
    at: stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z` : null,
    issue: stamp && stamp[7] !== "none" ? Number(stamp[7]) : null,
    loop: ENTRY_LOOP.exec(body)?.[1]?.toLowerCase() ?? null,
    title: ENTRY_TITLE.exec(body)?.[1] ?? null,
    outcome: ENTRY_OUTCOME.exec(body)?.[1]?.trim() ?? null,
  };
}

/**
 * Split `git cat-file --batch` output back into entries.
 *
 * Each object is `<oid> blob <size>\n<size bytes>\n`, and the size is in
 * bytes, so the split is done on the encoded output rather than on characters.
 * A path that vanished between the listing and the read is `missing` and
 * skipped; anything else unexpected is an unreadable journal.
 */
export function parseJournalBatch(paths: readonly string[], stdout: string): JournalEntryView[] {
  const bytes = Buffer.from(stdout, "utf8");
  const unreadable = (): never => {
    throw new RalphUnavailableError("git cat-file --batch", "unexpected batch output");
  };
  const entries: JournalEntryView[] = [];
  let offset = 0;
  for (const path of paths) {
    const end = bytes.indexOf(0x0a, offset);
    if (end === -1) unreadable();
    const header = bytes.subarray(offset, end).toString("utf8");
    offset = end + 1;
    if (header.endsWith(" missing")) continue;
    const size = /^\S+ blob (\d+)$/.exec(header)?.[1];
    if (size === undefined || offset + Number(size) > bytes.length) unreadable();
    const body = bytes.subarray(offset, offset + Number(size)).toString("utf8");
    offset += Number(size) + 1;
    entries.push(narrowJournalEntry(path.slice(path.lastIndexOf("/") + 1), body));
  }
  return entries;
}

const SESSION_DETAIL = /^session (\S+)$/;

/**
 * The session this loop's usage is read for, from the loop's own records.
 *
 * `ralph.sh` records `session <uuid>` on `iteration-start`; later events
 * replace that detail, and the record keeps the iteration's session beside it
 * for the rest of the run. Neither: null. `usage.py` would otherwise pick the
 * newest transcript in the checkout, which may be an operator's own session
 * rather than the loop's.
 */
export function recordedSession(state: LoopStateView): string | null {
  const fromDetail = SESSION_DETAIL.exec(state.lastEvent?.detail ?? "")?.[1];
  return fromDetail ?? state.session ?? null;
}

/**
 * Narrow `project-config --json` to the project's roster: its `roster`, in
 * order. The harness fills the roster for a config that names none yet, so a
 * missing or empty one here is drift, not a project without loops.
 *
 * `$.roster` rather than `$.loops` because the config spells an entry either
 * as a bare name or as an object naming a role, and `project-config` has
 * already resolved the two forms into one. A role this side of the seam does
 * not know is drift in the same way an unknown loop status is: the dashboard
 * would otherwise show a triager as a coder, panels and all.
 */
export function narrowRoster(value: unknown): RosterLoop[] {
  const contract = "project-config";
  const raw = asRecord(contract, "$", value);
  const path = "$.roster";
  if (!Array.isArray(raw.roster)) fail(contract, path, `expected an array, got ${describe(raw.roster)}`);
  const roster = raw.roster.map((item, index): RosterLoop => {
    const at = `${path}[${index}]`;
    const entry = asRecord(contract, at, item);
    return { name: string(contract, `${at}.name`, entry.name), role: oneOf(contract, `${at}.role`, entry.role, LOOP_ROLES) };
  });
  if (roster.length === 0) throw new RalphContractError(contract, `${path} names no loops`);
  return roster;
}

/** Read `.ralph/loop-name`, the other place a loop records its identity. */
export function readLoopName(worktree: string): string | null {
  try {
    const name = readFileSync(join(worktree, ".ralph", "loop-name"), "utf8").trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

const GITHUB_REMOTE = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/** A GitHub remote in any of its spellings (https, token-bearing https, ssh) as its web URL. */
export function githubRepoUrl(remote: string | null): string | null {
  const match = remote?.match(GITHUB_REMOTE);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** The `url` of `[remote "origin"]` in a git config file. */
function originUrl(config: string): string | null {
  let inOrigin = false;
  for (const line of config.split("\n")) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    const url = inOrigin ? line.match(/^\s*url\s*=\s*(.+?)\s*$/) : null;
    if (url) return url[1]!;
  }
  return null;
}

/**
 * The git dir a checkout's config and refs live in, found by reading files
 * rather than by running git, so the command surface stays the pinned
 * read-only one. A linked worktree's `.git` is a file naming its private git
 * dir, whose `commondir` points at the shared one. Null when there is none.
 */
export function commonGitDir(worktree: string): string | null {
  try {
    let gitDir = join(worktree, ".git");
    if (statSync(gitDir).isFile()) {
      const pointer = readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (pointer === undefined) return null;
      gitDir = resolve(worktree, pointer);
      try {
        gitDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // No commondir: the git dir holds its own config.
      }
    }
    return gitDir;
  } catch {
    return null;
  }
}

/** The GitHub repo a checkout publishes to, from its git config. */
/** The tracker kind a `project-config --json` answer names; GitHub when it names none or is unreadable. */
export function trackerKindOf(config: unknown): "github" | "linear" | "jira" | "local" {
  const kind = isRecord(config) && isRecord(config.tracker) ? config.tracker.kind : undefined;
  // A sandbox's local tracker (#527) holds its claims in its file, not on GitHub.
  return kind === "linear" || kind === "jira" || kind === "local" ? kind : "github";
}

/**
 * Where a project's ticket numbers link and how they are spelt, from its
 * config's `tracker` block (#339). GitHub's issues link under the repo's web
 * URL; a Linear ticket under its workspace, a Jira one under its site.
 */
export function trackerLinkFor(config: unknown, repoUrl: string | null): TrackerLinkView {
  const block = isRecord(config) && isRecord(config.tracker) ? config.tracker : {};
  const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  if (block.kind === "linear" && text(block.team) !== null) {
    const team = text(block.team)!;
    const workspace = text(block.workspace);
    return { kind: "linear", prefix: `${team}-`, link: workspace === null ? null : `https://linear.app/${workspace}/issue/${team}-{n}` };
  }
  if (block.kind === "jira" && text(block.project) !== null) {
    const project = text(block.project)!;
    const site = text(block.site);
    return { kind: "jira", prefix: `${project}-`, link: site === null ? null : `https://${site}/browse/${project}-{n}` };
  }
  // A sandbox's local tracker (#527) is a file on the host: its tickets have no page.
  if (block.kind === "local" && text(block.key) !== null) {
    const key = text(block.key)!;
    return { kind: "local", prefix: `${key}-`, link: null };
  }
  return { kind: "github", prefix: "#", link: repoUrl === null ? null : `${repoUrl}/issues/{n}` };
}

export function readRepoUrl(worktree: string): string | null {
  const gitDir = commonGitDir(worktree);
  if (gitDir === null) return null;
  try {
    return githubRepoUrl(originUrl(readFileSync(join(gitDir, "config"), "utf8")));
  } catch {
    return null;
  }
}

/** A branch name safe to join into a ref path: no `..`, no leading dash or slash. */
const BRANCH_NAME = /^(?![-/])(?!.*\.\.)[\w./-]+$/;

/**
 * The branch a project's committed config is read from, found without git:
 * `baseBranch` in the checkout's `.ralph/config.json` (the field `ralph.sh`
 * exports as `RALPH_BASE_BRANCH`), else what `origin/HEAD` points at, else
 * `main`. Only this one field comes from the working tree: a stale or dirty
 * checkout still names its base, and the rest is read from that base.
 */
export function readBaseBranch(root: string, gitDir: string | null): string {
  const named = baseBranchIn(configCheckout(root, gitDir)) ?? baseBranchIn(root);
  if (named !== null) return named;
  if (gitDir !== null) {
    // The main checkout may sit on a branch without the config (a project set
    // up on a non-default base, worked from its own branch). A loop worktree
    // of the same repository carries it: the first one, in name order, that
    // names a base.
    for (const checkout of linkedCheckouts(gitDir)) {
      const base = baseBranchIn(checkout);
      if (base !== null) return base;
    }
    try {
      const head = /^ref:\s*refs\/remotes\/origin\/(\S+)\s*$/.exec(
        readFileSync(join(gitDir, "refs", "remotes", "origin", "HEAD"), "utf8"),
      )?.[1];
      if (head !== undefined && BRANCH_NAME.test(head)) return head;
    } catch {
      // No origin/HEAD: the default below.
    }
  }
  return "main";
}

/**
 * The checkout whose `.ralph/config.json` stands for the project: the main
 * checkout's when it has one, else the first linked worktree's, in name order.
 * Either way the config must list one of the loops whose worktrees live in
 * this repository (their `.ralph/loop-name`), when any do.
 *
 * Two projects can share a repository on different bases: one app's Linear
 * loops on an integration branch and bruno's config on `dev`, from a clone of its own. Once the main checkout pulls `dev` it holds
 * bruno's config, and taking it would show the Linear loops a roster of
 * `bruno` read from the wrong base. A config naming none of this repository's
 * loops is another project's, so a worktree whose config does name them wins.
 *
 * The main checkout may sit on a branch without the config (a project set up
 * on a non-default base, worked from its own branch: a base on an
 * integration branch, main checkout on `dev`). Its loop
 * worktrees carry it, and every read that needs the config as a file — the
 * frontier, the agents page — takes it from there instead of failing with
 * ENOENT. No checkout with a config leaves `root`, so the error stays the one
 * the operator already knows.
 */
export function configCheckout(root: string, gitDir: string | null = commonGitDir(root)): string {
  if (gitDir === null) return root;
  const checkouts = [root, ...linkedCheckouts(gitDir).filter((checkout) => checkout !== root)];
  const configured = checkouts.filter((checkout) => existsSync(join(checkout, PROJECT_CONFIG_PATH)));
  const here = new Set(checkouts.map(readLoopName).filter((name): name is string => name !== null));
  const ours = here.size === 0 ? undefined : configured.find((checkout) => configLoopNames(checkout).some((name) => here.has(name)));
  return ours ?? configured[0] ?? root;
}

/** The loop names a checkout's `.ralph/config.json` lists, bare or as `{ name }`; none when unreadable. */
function configLoopNames(checkout: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(checkout, PROJECT_CONFIG_PATH), "utf8"));
    const loops = isRecord(raw) && Array.isArray(raw.loops) ? raw.loops : [];
    return loops.flatMap((entry: unknown) => {
      const name = typeof entry === "string" ? entry : isRecord(entry) ? entry.name : undefined;
      return typeof name === "string" ? [name] : [];
    });
  } catch {
    return [];
  }
}

/** The linked worktrees of a repository, in name order; pruned or unreadable ones left out. */
function linkedCheckouts(gitDir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(gitDir, "worktrees")).sort();
  } catch {
    // No linked worktrees.
  }
  return names.flatMap((name) => {
    try {
      return [resolve(readFileSync(join(gitDir, "worktrees", name, "gitdir"), "utf8").trim(), "..")];
    } catch {
      return [];
    }
  });
}

/** The `baseBranch` a checkout's own `.ralph/config.json` names, or null. */
function baseBranchIn(root: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, PROJECT_CONFIG_PATH), "utf8"));
    const base = isRecord(raw) ? raw.baseBranch : undefined;
    if (typeof base === "string" && BRANCH_NAME.test(base)) return base;
  } catch {
    // No readable config here.
  }
  return null;
}

/** `mtime:size` of a file, or `absent`: a change stamp that costs one stat. */
function statStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

/**
 * Whether `origin/<base>` exists in a git dir, as a loose ref or in
 * `packed-refs`, where a fresh clone keeps its remote refs.
 */
export function hasRemoteRef(gitDir: string, base: string): boolean {
  if (existsSync(join(gitDir, "refs", "remotes", "origin", base))) return true;
  try {
    const want = ` refs/remotes/origin/${base}`;
    return readFileSync(join(gitDir, "packed-refs"), "utf8")
      .split("\n")
      .some((line) => line.endsWith(want));
  } catch {
    return false;
  }
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

/**
 * Build an adapter over the configured runtime.
 *
 * Overlapping callers share one in-flight snapshot. Once it settles, the next
 * read gathers fresh loop state; only the frontier, and the Following view on
 * the same TTL, have a time-based cache.
 * Each adapter observes one project, so its frontier cache and its `gh` reads
 * are that project's: two projects never share or evict each other's census.
 */
export function createRalphAdapter(config: RalphAdapterConfig): RalphAdapter & LocalReader {
  const cliDir = resolve(config.cliDir);
  const roots = config.roots.map((root) => resolve(root));
  const bunPath = config.bunPath ?? defaultBunPath();
  const pythonPath = config.pythonPath ?? "python3";
  const journalHome = resolve(config.journalHome ?? cliDir);
  const timeout = config.timeoutMs ?? 30_000;
  const projectId = config.projectId;
  const baseEnv: Env = { ...process.env, ...config.env };
  const now = config.now ?? Date.now;
  const reader = createCliReader({
    exec: config.exec ?? createProcessExecutor({ timeoutMs: timeout }),
    now,
    bunPath,
    cliDir,
    timeoutMs: timeout,
  });

  // Declared once per adapter, like the frontier's below. Loop state is the
  // snapshot's backbone, so drift and an unrunnable CLI both stay loud.
  const loopStateSurface: CliSurface<ReturnType<typeof narrowSnapshot>> & { degrade: "loud" } = {
    ...COMMAND_SURFACE.loopState,
    narrow: narrowSnapshot,
    degrade: "loud",
  };
  const observeSurface: CliSurface<PresenceView> = {
    ...COMMAND_SURFACE.observe,
    narrow: narrowPresence,
    degrade: "unavailable",
  };
  // Narrowed by the caller: the stamp-cached config is read raw and narrowed
  // per field (roster, journal dir, learnings, tracker kind).
  const projectConfigSurface: CliSurface<unknown> & { degrade: "loud" } = {
    ...COMMAND_SURFACE.projectConfig,
    narrow: (value) => value,
    degrade: "loud",
  };
  const leasesSurface: CliSurface<LeaseView[]> = {
    ...COMMAND_SURFACE.claims,
    narrow: narrowLeases,
    degrade: "unavailable",
  };
  // Both claim lists are narrowed against the roster after the read, so the
  // surface stays one declaration rather than one per roster.
  const githubSurface: CliSurface<unknown> = {
    ...COMMAND_SURFACE.github,
    narrow: (value) => value,
    degrade: "unavailable",
  };
  const trackerIssuesSurface: CliSurface<unknown> = {
    ...COMMAND_SURFACE.trackerIssues,
    narrow: (value) => value,
    degrade: "unavailable",
  };
  // `usage.py` runs under the configured Python, not bun, so it is declared
  // as a command over the script's absolute path.
  const usageSurface: CliSurface<UsageView> = {
    contract: COMMAND_SURFACE.usage.contract,
    command: pythonPath,
    args: [join(cliDir, COMMAND_SURFACE.usage.script), ...COMMAND_SURFACE.usage.args],
    narrow: narrowUsage,
    degrade: "unavailable",
  };
  const timelineSurface: CliSurface<TimelineView> = {
    ...COMMAND_SURFACE.timeline,
    narrow: narrowTimeline,
    degrade: "unavailable",
  };
  // `runner-failure.ts` exits 0 even when it cannot run, reporting on stderr,
  // so a blank stdout is a CLI that did not run (null), not drifted JSON.
  const runnerFailureSurface: CliSurface<RunnerFailuresView | null> = {
    ...COMMAND_SURFACE.runnerFailure,
    parse: "text",
    narrow: (value) => {
      const text = String(value);
      if (text.trim() === "") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RalphContractError(COMMAND_SURFACE.runnerFailure.contract, "stdout was not JSON");
      }
      return narrowRunnerFailures(parsed);
    },
    degrade: "unavailable",
  };
  // The git reads against the harness checkout: `-C <journalHome>` must
  // precede the subcommand, so it is part of the declared argv.
  // `home` is the harness unless a project names `journal.branch`, which puts
  // its journal and project learnings in its own repository.
  const gitText = (
    surface: { contract: string; command: string; args: readonly string[] },
    degrade: "unavailable" | "any",
    home: string = journalHome,
  ): CliSurface<string> => ({
    contract: surface.contract,
    command: surface.command,
    args: ["-C", home, ...surface.args],
    parse: "text",
    narrow: (value) => String(value),
    degrade,
  });
  // A journal that could not be read is unknown (null); drift stays loud.
  const journalListSurface = (home: string) => gitText(COMMAND_SURFACE.journalList, "unavailable", home);
  const journalReadSurface = (home: string) => gitText(COMMAND_SURFACE.journalRead, "unavailable", home);
  // A learnings file missing from the ref is a non-zero `git show`, the normal
  // state of a project with no learning yet, so every failure is null here.
  const learningsShowSurface = (home: string = journalHome) => gitText(COMMAND_SURFACE.learningsShow, "any", home);
  const learningsRemoteSurface = (home: string = journalHome) => gitText(COMMAND_SURFACE.learningsRemote, "any", home);
  const gitEnv: Env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };

  /**
   * The project's committed config, as `project-config --json --at
   * origin/<baseBranch>` prints it: the source the supervisor and preflight
   * treat as authoritative, so the main checkout's branch and dirtiness do not
   * change the roster. The base's ref advances whenever any loop fetches, since
   * every worktree shares the repository's remote refs.
   *
   * No `origin/<baseBranch>` in the checkout, or a config that cannot be read
   * there (a project not yet set up on its base), falls back to the working
   * tree's config, which is what the dashboard read before.
   *
   * Re-read only when a stamp changes — the working tree's config (which names
   * the base) and the base's loose and packed refs — so a steady-state read is
   * a few `stat`s: the roster and the journal dir both come from here, the
   * snapshot is taken every few seconds and each project's health every 30.
   * A failed read is not kept.
   */
  const configCache = new Map<string, { stamp: string; value: Promise<unknown>; retryAt: number }>();
  const projectConfigFor = (root: string): Promise<unknown> => {
    const gitDir = commonGitDir(root);
    const base = readBaseBranch(root, gitDir);
    const stamp = [
      statStamp(join(root, PROJECT_CONFIG_PATH)),
      base,
      gitDir === null ? "no-git" : statStamp(join(gitDir, "refs", "remotes", "origin", base)),
      gitDir === null ? "no-git" : statStamp(join(gitDir, "packed-refs")),
    ].join("|");
    const cached = configCache.get(root);
    if (cached !== undefined && cached.stamp === stamp && Date.now() < cached.retryAt) return cached.value;
    const env: Env = { ...baseEnv, [ADAPTER_ENV.project]: root };
    const readAt = (extra: readonly string[]): Promise<unknown> =>
      reader.read(projectConfigSurface, { cwd: cliDir, env, args: extra });
    let fellBack = false;
    const value =
      gitDir !== null && hasRemoteRef(gitDir, base)
        ? readAt([REF_FLAG, `origin/${base}`]).catch(() => {
            fellBack = true;
            return readAt([]);
          })
        : readAt([]);
    const entry = { stamp, value, retryAt: Number.POSITIVE_INFINITY };
    configCache.set(root, entry);
    value.then(
      // A fallback may be a base read that timed out on a loaded host, so it is
      // kept for a while rather than until the refs move.
      () => {
        if (fellBack) entry.retryAt = Date.now() + CONFIG_FALLBACK_RETRY_MS;
      },
      // A failed read is not kept: the next snapshot asks again.
      () => {
        if (configCache.get(root) === entry) configCache.delete(root);
      },
    );
    return value;
  };

  /**
   * The roster is the project's: `loops` in its `.ralph/config.json` on
   * `origin/<baseBranch>`, read by running `project-config --json --at`
   * against the project's root — never by importing harness code. The full
   * snapshot and the health read both come through here, so they agree. A project whose config cannot be read has no
   * roster the dashboard could honestly show, so that is an explicit error.
   */
  const readRoster = async (): Promise<RosterLoop[]> => {
    const root = roots[0];
    if (root === undefined) return [];
    let value: unknown;
    try {
      value = await projectConfigFor(root);
    } catch (error) {
      // A deleted folder fails the config read exactly as one that never
      // opted in does; say which, so the rail does not call it "not set up".
      if (!existsSync(root)) throw new RalphContractError("roster", `the project folder ${root} does not exist`);
      const why = error instanceof RalphUnavailableError ? error.detail : (error as Error).message;
      throw new RalphContractError("roster", `cannot read the project config at ${root}: ${why}`);
    }
    return narrowRoster(value);
  };

  const loopStateFor = (root: string) =>
    reader.read(loopStateSurface, { cwd: cliDir, env: { ...baseEnv, [ADAPTER_ENV.loopStateRoot]: root } });

  /** A worktree whose observer could not run has no presence (null); drift stays loud. */
  const presenceFor = (worktree: string): Promise<PresenceView | null> =>
    reader.read(observeSurface, { cwd: cliDir, env: { ...baseEnv, [ADAPTER_ENV.observerRoot]: worktree } });

  /** A claim source that could not run is unknown (null); drift and bugs still throw. */
  const claimsFor = async (root: string, roster: readonly string[]): Promise<RuntimeClaims> => {
    const [leases, github] = await Promise.all([
      reader.read(leasesSurface, { cwd: cliDir, env: { ...baseEnv, [ADAPTER_ENV.loopStateRoot]: root } }),
      (async () => {
        // A Linear or Jira project's claims are on its own tracker; GitHub keeps `gh`.
        const kind = trackerKindOf(await projectConfigFor(root).catch(() => null));
        const issues =
          kind !== "github"
            ? await reader.read(trackerIssuesSurface, {
                cwd: cliDir,
                env: { ...baseEnv, [ADAPTER_ENV.project]: root, ...(projectId === undefined ? {} : { RALPH_PROJECT_ID: projectId }) },
              })
            : await reader.read(githubSurface, { cwd: root, env: baseEnv });
        // Narrowed against the roster here, outside the read: its drift throws.
        return issues === null ? null : narrowGithubClaims(issues, roster);
      })(),
    ]);
    return { leases, github };
  };

  const frontierTtl = config.frontierTtlMs ?? FRONTIER_TTL_MS;
  // Declared once per adapter: the reader caches by surface identity.
  // The frontier keeps today's policy — an unreadable census degrades, drift
  // throws — and is cached below together with its PR chips, not by the reader.
  const frontierSurface: CliSurface<FrontierView> = {
    ...COMMAND_SURFACE.frontier,
    narrow: narrowFrontier,
    degrade: "unavailable",
  };
  const followingSurface: CliSurface<FollowingView> = {
    ...COMMAND_SURFACE.following,
    narrow: narrowFollowing,
    degrade: "any",
    ttlMs: frontierTtl,
  };
  // Narrowed together by `narrowPullStatuses`, so each list passes through as is.
  const pullsOpenSurface: CliSurface<unknown> = { ...COMMAND_SURFACE.pullsOpen, narrow: (value) => value, degrade: "any" };
  const pullsMergedSurface: CliSurface<unknown> = { ...COMMAND_SURFACE.pullsMerged, narrow: (value) => value, degrade: "any" };

  /** The PR-status chips beside the backlog; any failure costs only the chips. */
  const pullsFor = async (root: string): Promise<PullStatusView[] | null> => {
    const call = { cwd: root, env: baseEnv };
    const [open, merged] = await Promise.all([reader.read(pullsOpenSurface, call), reader.read(pullsMergedSurface, call)]);
    if (open === null || merged === null) return null;
    try {
      return narrowPullStatuses(open, merged);
    } catch {
      return null;
    }
  };

  /**
   * The backlog, read from one root checkout — every root is a worktree of
   * the same repository, so any root's answer is the project's — and kept for
   * `frontierTtl` so the shell's polling never queues a census behind another.
   * A read in progress is shared by every caller that arrives before it
   * settles; a failed read is reported as unknown, with its reason, and is
   * retried on the next call after the TTL like any other. Drift rejects and
   * is not kept.
   */
  const frontierCache = createTtlCache<FrontierRead>({ ttlMs: frontierTtl, now });
  /**
   * The last census that read, per root. A refresh that fails — most often a
   * GitHub rate limit that lifts on its own — serves it again, marked stale
   * with the failure's reason, instead of blanking the backlog for the length
   * of the outage. Only a root that has never read shows the bare problem.
   */
  const lastGoodFrontier = new Map<string, FrontierRead>();
  const frontierFor = (root: string): Promise<FrontierRead> =>
    frontierCache.get(root, async () => {
      // Read beside the census, not after it, and never able to fail it: a
      // PR read that errors costs the chips, not the backlog.
      const [read, prs] = await Promise.all([
        // From the main checkout, so gh resolves the repo and no loop's
        // identity is picked up; the config from wherever one is. No
        // rate-limit patience: the script would sleep out a throttle past
        // this adapter's timeout and be killed with no reason printed, and
        // the TTL above already retries it every minute.
        reader.view(frontierSurface, {
          cwd: root,
          env: { ...baseEnv, [ADAPTER_ENV.project]: configCheckout(root), [FRONTIER_RETRY_BUDGET_ENV]: "0" },
        }),
        pullsFor(root),
      ]);
      if (read.view !== null) {
        const fresh: FrontierRead = { ...read, prs, failedAt: null };
        lastGoodFrontier.set(root, fresh);
        return fresh;
      }
      const last = lastGoodFrontier.get(root);
      if (last === undefined) return { ...read, prs, failedAt: null };
      // The PR chips are separate reads: keep this refresh's when they read.
      return { ...last, prs: prs ?? last.prs ?? null, problem: read.problem, failedAt: read.readAt };
    });

  /**
   * The verifier's Following view, on the frontier's TTL and with the same
   * in-flight sharing: the shell polls every few seconds and the store only
   * moves at check-ins hours apart. Unlike the frontier, EVERY failure
   * degrades, drift included — the panel is one corner of the project page,
   * and a CLI that fails or prints a shape this dashboard does not know must
   * cost that panel, with its reason, never the whole snapshot.
   */
  const followingFor = (root: string): Promise<FollowingRead> =>
    reader.view(followingSurface, { cwd: root, env: { ...baseEnv, [ADAPTER_ENV.project]: configCheckout(root) } });

  /** Across roots, one unreadable source makes that source unknown as a whole. */
  const mergeClaims = (all: RuntimeClaims[]): RuntimeClaims => {
    const merge = <T>(parts: (T[] | null)[]): T[] | null =>
      parts.some((part) => part === null) ? null : parts.flatMap((part) => part ?? []);
    return {
      leases: merge(all.map((claims) => claims.leases)),
      github: merge(all.map((claims) => claims.github)),
    };
  };

  /**
   * The loop's usage for its recorded run and session, or null.
   *
   * Run in the worktree because `usage.py` finds the transcript by the
   * directory Claude Code ran in. A ledger that does not exist leaves the run
   * scope unknown: `usage.py` would report this session alone as the run.
   */
  const usageFor = async (worktree: string, state: LoopStateView | null): Promise<UsageView | null> => {
    if (state === null) return null;
    const session = recordedSession(state);
    if (session === null) return null;
    const usage = await reader.read(usageSurface, {
      cwd: worktree,
      env: {
        ...baseEnv,
        [ADAPTER_ENV.project]: worktree,
        [ADAPTER_ENV.runId]: state.run,
        [ADAPTER_ENV.session]: session,
      },
    });
    if (usage === null) return null;
    return existsSync(join(worktree, RECORD_PATHS.ledger)) ? usage : { ...usage, run: null };
  };

  /**
   * What this worktree's triage apply ledgers say it has written in the last
   * hour, read straight off disk like the usage ledger — no CLI, nothing to
   * spawn.
   *
   * The parsing mirrors `triage/ledger.ts:readLedger`'s LINE-level tolerance —
   * this module may import no ralph TypeScript, and a torn last line is normal
   * because the writer appends AFTER the GitHub call, so a bad line is skipped
   * rather than thrown on. It deliberately DIVERGES on a file it cannot read:
   * `readLedger` returns `[]` ("missing means nothing applied, not an error"),
   * where here that is unknown rather than empty. The ledger undercounts a
   * killed process by one write, which `triage/ledger.ts` already calls a fast
   * path rather than the authority — a panel is the reader that can live with
   * that.
   *
   * `writesLastHour` is null only when the directory exists and could not be
   * read. A worktree with no ledger has written nothing, which is 0.
   */
  const triageWritesFor = (worktree: string, nowMs: number): number | null => {
    const dir = join(worktree, RECORD_PATHS.triageLedgerDir);
    if (!existsSync(dir)) return 0;
    const since = nowMs - TRIAGE_WRITE_WINDOW_MS;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((name) => TRIAGE_LEDGER.test(name))
        // A ledger is append-only, so one not written inside the window
        // provably holds no line inside it. This is exact, not a heuristic, and
        // it is what keeps the read bounded by the window rather than by the
        // directory: a triager accumulates one ledger per unit for ever, and
        // these directories already hold thousands of files, while the answer
        // only ever covers an hour.
        .filter((name) => {
          try {
            return statSync(join(dir, name)).mtimeMs >= since;
          } catch {
            return false;
          }
        });
    } catch {
      return null;
    }
    let writes = 0;
    for (const name of files) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        return null;
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as { result?: unknown; at?: unknown };
        if (record.result !== "applied" || typeof record.at !== "string") continue;
        const at = Date.parse(record.at);
        if (Number.isNaN(at) || at < since) continue;
        writes += 1;
      }
    }
    return writes;
  };

  /**
   * The triage activity for one worktree: its writes and the cap they are read
   * against. The units come from the journal, which the projection already
   * has, so they are filled in there rather than here.
   */
  const triageActivityFor = (worktree: string): TriageActivityView => ({
    writesLastHour: triageWritesFor(worktree, Date.now()),
    maxWrites: positiveEnv(baseEnv[TRIAGE_MAX_WRITES_ENV]),
    units: [],
  });

  /**
   * The loop's timeline for its recorded run, or null.
   *
   * No run, no read: an unscoped timeline is whichever iteration file is
   * newest, which may be another run's. A timeline that could not be read is
   * null; one with no matching file is `exists: false`.
   */
  const timelineFor = async (worktree: string, state: LoopStateView | null): Promise<TimelineView | null> => {
    if (state === null) return null;
    return reader.read(timelineSurface, {
      cwd: cliDir,
      env: { ...baseEnv, [ADAPTER_ENV.timelineRoot]: worktree },
      args: [RUN_FLAG, state.run],
    });
  };

  /**
   * The runner failures recorded for the loop's run, or null.
   *
   * `runner-failure.ts` exits 0 even when it cannot run, reporting on stderr,
   * so an empty stdout is a CLI that did not run rather than drifted JSON:
   * the surface's narrow reads it as null.
   */
  const runnerFailuresFor = async (
    worktree: string,
    state: LoopStateView | null,
  ): Promise<RunnerFailuresView | null> => {
    if (state === null) return null;
    const env: Env = { ...baseEnv, [ADAPTER_ENV.project]: worktree };
    delete env[ADAPTER_ENV.failureLog];
    return reader.read(runnerFailureSurface, { cwd: cliDir, env, args: [RUN_FLAG, state.run] });
  };

  /**
   * The stamp-cached config under the `unavailable` policy, for the reads that
   * degrade on it: the cache itself is loud, because the roster is read through
   * it, so this is the one place a config that could not run becomes unknown
   * (null). Drift, and a narrow's rejection after it, still throw.
   */
  const configUnlessUnavailable = (root: string): Promise<unknown> =>
    projectConfigFor(root).catch((error: unknown) => {
      if (error instanceof RalphUnavailableError) return null;
      throw error;
    });

  const journalDirFor = async (root: string): Promise<string | null> => {
    const override = baseEnv[ADAPTER_ENV.journalDir]?.trim();
    if (override) return override;
    const value = await configUnlessUnavailable(root);
    return value === null ? null : narrowJournalDir(value);
  };

  /**
   * The project's newest journal entries, from the harness's `origin/main` —
   * where every loop's publisher pushes. Never fetched here: the page refreshes
   * often, and a fetch is a network write to the remote-tracking refs.
   */
  /** The repository and ref holding `root`'s journal: the harness, or its `journal.branch`. */
  const journalPlaceFor = async (root: string): Promise<{ home: string; branch: string | null; ref: string }> => {
    const value = await configUnlessUnavailable(root);
    const branch = value === null ? null : narrowJournalBranch(value);
    return branch === null ? { home: journalHome, branch, ref: "origin/main" } : { home: root, branch, ref: `origin/${branch}` };
  };

  const journalFor = async (root: string): Promise<JournalEntryView[] | null> => {
    const dir = await journalDirFor(root);
    if (dir === null) return null;
    const place = await journalPlaceFor(root);
    const listing = await reader.read(journalListSurface(place.home), {
      cwd: cliDir,
      env: gitEnv,
      args: [place.ref, `${dir.replace(/\/+$/, "")}/`],
    });
    if (listing === null) return null;
    const paths = listing
      .split("\n")
      .filter((path) => ENTRY_PATH.test(path))
      .sort()
      .slice(-JOURNAL_WINDOW);
    if (paths.length === 0) return [];
    const batch = await reader.read(journalReadSurface(place.home), {
      cwd: cliDir,
      env: gitEnv,
      input: paths.map((path) => `${place.ref}:${path}\n`).join(""),
    });
    if (batch === null) return null;
    // Parsed here, not in the surface's narrow: a batch git printed but this
    // cannot split is an unreadable journal (null), where a narrow's throw
    // would be drift and fail the whole snapshot.
    try {
      return parseJournalBatch(paths, batch);
    } catch (error) {
      if (error instanceof RalphUnavailableError) return null;
      throw error;
    }
  };

  /**
   * The open learnings for this project and for the harness, from the harness's
   * `origin/main` — where every loop's publisher pushes them.
   *
   * Never fetched here, like the journal: the page refreshes often and a fetch
   * is a network write to the remote-tracking refs.
   *
   * A missing file is not a failure. `git show` exits non-zero for a path that
   * is not on the ref, and that is the normal state of a project nobody has
   * written a learning about yet, so it reads as `text: null` rather than
   * making the whole project page unknown.
   */
  const learningsFor = async (root: string): Promise<LearningsRead | null> => {
    const value = await configUnlessUnavailable(root);
    // The config itself is unreadable: the learnings are unknown, not empty.
    if (value === null) return null;
    const projectPath = narrowLearningsFile(value);
    const call = { cwd: cliDir, env: gitEnv };
    // A project that opted out still shows the harness's file: that read
    // succeeded, and what it found is the truth about Ralph's own list.
    const files: { scope: "project" | "harness"; file: string }[] = [
      ...(projectPath === false ? [] : [{ scope: "project" as const, file: projectPath }]),
      { scope: "harness" as const, file: HARNESS_FILE },
    ];
    const remote = await reader.read(learningsRemoteSurface(), call);
    const place = await journalPlaceFor(root);
    // A project file under `journal.branch` links to the project's repository.
    const projectBase =
      place.branch === null ? undefined : blobBase(await reader.read(learningsRemoteSurface(place.home), call), place.branch);
    const reads: LearningsFileRead[] = await Promise.all(
      files.map(async (entry) => {
        const own = entry.scope === "project" && place.branch !== null;
        return {
          ...entry,
          text: await reader.read(learningsShowSurface(own ? place.home : journalHome), {
            ...call,
            args: [`${own ? place.ref : "origin/main"}:${entry.file}`],
          }),
          ...(own ? { base: projectBase ?? null } : {}),
        };
      }),
    );
    // Every read failed, the remote included: that is not "nothing learned
    // yet", it is a harness checkout this process cannot read at all. A
    // successful remote read is the proof that git and the repository work, so
    // a file still missing after it really is absent.
    if (remote === null && reads.every((read) => read.text === null)) return null;
    return foldLearnings(reads, remote === null ? null : remote.trim());
  };

  const identify = (report: RawLoopReport, roster: readonly string[]): string | null => {
    const raw = report.state?.owner.loop ?? readLoopName(report.worktree);
    return raw !== null && roster.includes(raw) ? raw : null;
  };

  const readSnapshot = async (): Promise<RuntimeSnapshot> => {
    const roster = await readRoster();
    // Attribution only ever asks whether a name is on the roster, so the reads
    // below keep taking names and stay indifferent to roles. The one exception
    // is the triage ledgers, which only a triager has.
    const names = rosterNames(roster);
    const triagerNames = new Set(triagers(roster).map((entry) => entry.name));
    const hasVerifier = verifiers(roster).length > 0;
    const reconciliation: RuntimeSnapshot["reconciliation"] = { orphaned: [], prunable: [] };
    const seen = new Set<string>();
    const claims: RuntimeClaims[] = [];
    // Attach both branches immediately, including their rejection handlers.
    const [loops, frontier, following] = await Promise.all([
      (async () => {
        const loops: RuntimeLoop[] = [];
        for (const root of roots) {
          const [rootLoops, rootClaims] = await Promise.all([
            (async () => {
              const snapshot = await loopStateFor(root);
              for (const path of snapshot.reconciliation.orphaned) pushUnique(reconciliation.orphaned, path);
              for (const path of snapshot.reconciliation.prunable) pushUnique(reconciliation.prunable, path);
              const reports = snapshot.loops.filter((report) => {
                const key = resolve(report.worktree);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              let journal: Promise<JournalEntryView[] | null> | undefined;
              const readLoop = async (report: RawLoopReport): Promise<RuntimeLoop> => {
                const identity = identify(report, names);
                // Unrelated worktrees never get per-loop reads. Within a loop,
                // all sources are independent and can overlap the observer.
                const [presence, usage, timeline, runnerFailures, entries] = identity === null
                  ? [null, null, null, null, null] as const
                  : await Promise.all([
                      presenceFor(report.worktree),
                      usageFor(report.worktree, report.state),
                      timelineFor(report.worktree, report.state),
                      runnerFailuresFor(report.worktree, report.state),
                      journal ??= journalFor(root),
                    ]);
                return {
                  worktree: report.worktree,
                  identity,
                  loopStatus: report.loopStatus,
                  worktreeStatus: report.worktreeStatus,
                  branch: report.state?.branch ?? report.branch,
                  state: report.state,
                  stateProblem: report.stateProblem,
                  supervisor: report.supervisor,
                  presence,
                  repoUrl: identity !== null ? readRepoUrl(report.worktree) : null,
                  usage,
                  journal: entries,
                  timeline,
                  runnerFailures,
                  // Only a triager's ledgers are read: every other loop's
                  // `.ralph/logs` holds the same hundreds of files and none of
                  // them is an apply ledger, so a `readdir` per coder per poll
                  // would be work for a panel that is null anyway.
                  triage: triagerNames.has(identity ?? "") ? triageActivityFor(report.worktree) : null,
                };
              };
              const result: RuntimeLoop[] = [];
              // Bound process fan-out on machines with many registered loops,
              // retaining registry order and reading the journal once per root.
              for (let offset = 0; offset < reports.length; offset += 4) {
                result.push(...await Promise.all(reports.slice(offset, offset + 4).map(readLoop)));
              }
              return result;
            })(),
            claimsFor(root, names),
          ]);
          loops.push(...rootLoops);
          claims.push(rootClaims);
        }
        return loops;
      })(),
      roots.length > 0 ? frontierFor(roots[0]!) : null,
      // Only a project with a verifier has a store worth a process; it never
      // rejects, so it cannot take the snapshot down with it.
      hasVerifier && roots.length > 0 ? followingFor(roots[0]!) : null,
    ]);
    // The project's, not a loop's: the ci-health store lives in the git common
    // directory and every worktree of the project shares one. Unlike the
    // frontier beside it, it costs no census and no second process — three
    // filesystem reads of a JSON cache the scan prunes to a 72-hour window —
    // so it is not in `COMMAND_SURFACE`. It is the one uncached synchronous
    // read in a snapshot where the frontier has a time-based cache and usage
    // runs in a worker, which is a real trade and not a free one: measured
    // against a live store it is a few hundred KB and a couple of milliseconds
    // to read and parse, per poll. Worth revisiting if the window grows.
    // It is read whether or not the roster names a ci-doctor: the project
    // page's panel is about the project, and a project whose doctor is not
    // running still has a last known main colour.
    // Every root, not just the first: the store is the project's and one read
    // of it is enough, but #163's wait medians come from each coder
    // worktree's own `.ralph/logs`, which the first root cannot see.
    const ciHealth = roots.length > 0 ? readCiHealth(roots[0]!, Date.now(), roots) : null;
    // The files live in the harness, so they are read once per project from
    // `journalHome`, not per worktree. A failure reads as "not supplied".
    const learnings = roots.length > 0 ? await learningsFor(roots[0]!) : null;
    // Read off the config the roster already came from, so it costs nothing.
    const tracker =
      roots.length > 0 ? trackerLinkFor(await projectConfigFor(roots[0]!).catch(() => null), readRepoUrl(roots[0]!)) : null;
    return {
      roster,
      loops,
      reconciliation,
      claims: mergeClaims(claims),
      ...(frontier === null ? {} : { frontier }),
      ...(following === null ? {} : { following }),
      ...(ciHealth === null ? {} : { ciHealth }),
      ...(learnings === null ? {} : { learnings }),
      ...(tracker === null ? {} : { tracker }),
    };
  };

  /** Every root's loop state, each worktree once, with the loop it belongs to. */
  const readLocal = async (): Promise<LocalSnapshot> => {
    const roster = await readRoster();
    const names = rosterNames(roster);
    const seen = new Set<string>();
    const loops: LocalSnapshot["loops"] = [];
    for (const snapshot of await Promise.all(roots.map(loopStateFor))) {
      for (const report of snapshot.loops) {
        const key = resolve(report.worktree);
        if (seen.has(key)) continue;
        seen.add(key);
        loops.push({
          worktree: report.worktree,
          identity: identify(report, names),
          loopStatus: report.loopStatus,
          worktreeStatus: report.worktreeStatus,
          state: report.state,
          supervisor: report.supervisor,
        });
      }
    }
    return { roster, loops };
  };

  let pending: Promise<RuntimeSnapshot> | null = null;
  let pendingLocal: Promise<LocalSnapshot> | null = null;
  return {
    read(): Promise<RuntimeSnapshot> {
      pending ??= readSnapshot().finally(() => { pending = null; });
      return pending;
    },
    readLocal(): Promise<LocalSnapshot> {
      pendingLocal ??= readLocal().finally(() => { pendingLocal = null; });
      return pendingLocal;
    },
  };
}
