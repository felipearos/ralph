/**
 * The project's eval runs (#801), from the page's side of the process
 * boundary: the harness's `experiments.ts` owns the run directories, their
 * reports and how a run is launched, and this module names its four verbs
 * and narrows what they print. Nothing here imports ralph TypeScript.
 *
 * It owns the executor behind `guarded()`, so a timeout, a missing `bun` or
 * an executor that rejects reads as a view with a `problem`, never a 500.
 * The CLI runs in the project's registered checkout, whose experiment logs
 * hold the runs.
 *
 * The test set (#856) is `evals-set.ts`'s: its view, one case's curation for
 * the edit form, and the four writes. Those writes wait on `gh` and the
 * journal's lock, so they run under a longer timeout than the reads, still
 * inside the local server's idle timeout.
 *
 * The suggestions (#858) are `evals-set.ts suggest`'s: merged PRs ranked by
 * how the loop struggled on them, read through `gh` and the tracker.
 *
 * The recommended-runs inbox (#872) is `evals-inbox.ts`'s: its list, and the
 * add, start and dismiss that change it. Its rows carry a plan's counts and
 * the recommender's reason, never the plan.
 *
 * The improver (#873) is `evals-improve.ts propose`'s, always detached: one
 * model session takes minutes, and its proposal lands in the inbox.
 *
 * The improver's proposals (#874) are `evals-proposals.ts list`'s: each one's
 * goal, kind, status and verdict, never its content, overlay or a diff.
 */
import { join, resolve } from "node:path";

import { defaultBunPath, isRecord } from "./adapter";
import type {
  Env, EvalAccuracyTallyView, EvalAxis, EvalCalibrationSuggestionView, EvalCalibrationVerdictView, EvalGoalVerdictView, EvalGuardrailConditionView, EvalGuardrailVerdictView, EvalJudgeAccuracyView, EvalPatchesView, EvalRunView, EvalNoiseStatusView, EvalSetCaseDetail, EvalSetGrader, EvalSaturationView, EvalSetRowView, EvalSetView, EvalSetWriteResult, EvalsView, EvalStartResult, EvalStopResult,
  EvalSuggestionsView, EvalSuggestionView, EvalInboxRowView, EvalInboxView, EvalInboxWriteResult, EvalImproveResult, EvalOpenPrResult,
  EvalProposalRowView, EvalProposalSuggestionView, EvalProposalsView,
} from "./contracts";
import { EVAL_AXES } from "./contracts";
import { guarded, type ExecResult, type Executor } from "./executor";

export const EVALS_SURFACE = {
  script: "experiments.ts",
  runs: ["runs", "--json"],
  start: ["start", "--json"],
  patches: ["patches", "--json"],
  stop: (run: string) => ["stop", run, "--json"],
  patch: (run: string, ticket: string, arm: string) => ["patch", run, ticket, arm],
} as const;

export const EVALS_SET_SURFACE = {
  script: "evals-set.ts",
  view: ["view"],
  show: (id: string) => ["show", id],
  add: (body: EvalSetAddBody) => [
    "add", "--repo", body.repo, ...body.prs.flatMap((pr) => ["--pr", String(pr)]), "--reason", body.reason,
    ...(body.tags ?? []).flatMap((tag) => ["--tag", tag]), ...(body.notes === undefined ? [] : ["--notes", body.notes]), "--by", "dashboard",
  ],
  edit: (body: EvalSetEditBody) => [
    "edit", body.case,
    ...(body.tags === undefined ? [] : body.tags.length === 0 ? ["--no-tags"] : body.tags.flatMap((tag) => ["--tag", tag])),
    ...(body.notes === undefined ? [] : ["--notes", body.notes]),
  ],
  retire: (id: string) => ["retire", id],
  keep: (id: string) => ["keep", id],
  check: (body: EvalSetCheckBody) => [
    "check", "--case", body.case, ...("test" in body ? ["--test", body.test] : ["--command", body.command]),
    "--timeout", String(EVALS_SET_CHECK_RUN_SECONDS), "--by", "dashboard",
  ],
  calibrate: (body: EvalSetCalibrateBody) => [
    "calibrate", "--case", body.case, "--arm", body.arms[0], "--arm", body.arms[1],
    "--axis", body.axis, "--prefer", body.preferred, "--reason", body.reason, "--by", "dashboard",
  ],
  suggest: ["suggest"],
} as const;

export const EVALS_INBOX_SURFACE = {
  script: "evals-inbox.ts",
  list: ["list"],
  // The plan goes on stdin, as `experiments.ts start --json` takes it; the
  // recommender is the CLI's default, the operator running the dashboard.
  add: (reason: string) => ["add", "--reason", reason],
  start: (id: string) => ["start", id],
  dismiss: (id: string) => ["dismiss", id],
} as const;

export const EVALS_PROPOSALS_SURFACE = {
  script: "evals-proposals.ts",
  // List also advances the proposals, so a promising subset run earns its
  // full-set run on this read. The project is named, not left to git.
  list: (project: string) => ["list", "--project", project],
  // The proposal id is held to EVAL_PROPOSAL_ID_SHAPE by the route, so it is never flag-like.
  openPr: (proposal: string, project: string) => ["open-pr", proposal, "--project", project],
} as const;

/**
 * Open-pr fetches and pushes a branch and calls `gh` twice in the harness
 * repo, each bounded by the CLI at 120 s; the exec's default would cut it
 * mid-push. 240 s still fits inside `server.ts`'s 255 s `idleTimeout`, as the
 * set writes do.
 */
export const EVALS_PROPOSAL_OPEN_PR_TIMEOUT_MS = 240_000;

export const EVALS_IMPROVE_SURFACE = {
  script: "evals-improve.ts",
  // --detach: the model session takes minutes and the exec waits 30 s, so the
  // CLI checks the run, starts itself in the background and answers at once.
  propose: (run: string, goal: "quality" | "cost") => ["propose", "--run", run, "--goal", goal, "--detach"],
} as const;

/** The reason an add from the page carries when the operator gave none. */
export const EVAL_INBOX_DEFAULT_REASON = "Added from the Run screen";

/** What the add route hands the adapter: `parseEvalSetAdd`'s result. */
export interface EvalSetAddBody { repo: string; prs: number[]; reason: string; tags?: string[]; notes?: string }
/** What the edit route hands the adapter: `parseEvalSetEdit`'s result. */
export interface EvalSetEditBody { case: string; tags?: string[]; notes?: string }
/** What the check route hands the adapter: `parseEvalSetCheck`'s result. */
export type EvalSetCheckBody = { case: string; test: string } | { case: string; command: string };
/** What the calibrate route hands the adapter: `parseEvalSetCalibrate`'s result (#876). */
export interface EvalSetCalibrateBody { case: string; arms: [string, string]; axis: EvalAxis; preferred: string; reason: string }

/**
 * A write samples its PRs through `gh`, then waits for the journal lock. Both
 * must fit inside `server.ts`'s 255 s `idleTimeout`, or the page is told the
 * write failed while it still commits: the lock wait is cut to 120 s and the
 * whole write to 240 s, as the other long executors in `compose.ts` are.
 */
export const EVALS_SET_WRITE_TIMEOUT_MS = 240_000;
export const EVALS_SET_LOCK_WAIT_SECONDS = 120;
/**
 * A check runs on the base and on the reference, each a setup and the check
 * itself, each of the four bounded by `--timeout`, before it takes the lock
 * and writes. All of it must fit the 240 s exec bound, or the page answers a
 * timeout instead of the CLI's reason: 4 × 45 s, a 20 s lock wait (a check
 * waits less than the other writes), and some 40 s for the clone and the
 * commit. A check slower than that is refused as an error, and a SIGTERM at
 * the bound stops it and writes nothing.
 */
export const EVALS_SET_CHECK_RUN_SECONDS = 45;
export const EVALS_SET_CHECK_LOCK_WAIT_SECONDS = 20;

/**
 * `suggest` lists the project's merged PRs and their reviews through `gh` and
 * reads the tracker, so it runs past the default read timeout; 120 s still
 * fits inside `server.ts`'s 255 s `idleTimeout`.
 */
export const EVALS_SUGGEST_TIMEOUT_MS = 120_000;

/**
 * The route never waits on that run for long. The bridge renews its lease
 * (45 s) only between ticks and reads every due key of a tick together, so a
 * read that waits on `gh` would stall every project's push. The route answers
 * the last result at once and refreshes it behind; with none yet, it waits at
 * most this long and then answers `pending`.
 */
export const EVALS_SUGGEST_WAIT_MS = 15_000;

/** How long a result is served before a read starts the next run: merged PRs move slowly. */
export const EVALS_SUGGEST_FRESH_MS = 10 * 60_000;

export interface EvalsAdapter {
  runs(): Promise<EvalsView>;
  /** Every patch the project lets the bridge relay; empty unless it opted in. */
  patches(): Promise<EvalPatchesView>;
  start(plan: Record<string, unknown>): Promise<EvalStartResult>;
  stop(run: string): Promise<EvalStopResult>;
  /** A trial's patch; null with why when there is none. */
  patch(run: string, ticket: string, arm: string): Promise<{ ok: true; text: string } | { ok: false; why: string }>;
  /** The test set, narrowed field by field: it is relayed to the remote store. */
  set(): Promise<EvalSetView>;
  /** One case's curation for the edit form; null with why when there is none. */
  setCase(id: string): Promise<{ ok: true; case: EvalSetCaseDetail } | { ok: false; why: string }>;
  setAdd(body: EvalSetAddBody): Promise<EvalSetWriteResult>;
  setEdit(body: EvalSetEditBody): Promise<EvalSetWriteResult>;
  setRetire(id: string): Promise<EvalSetWriteResult>;
  /** Keep a saturated case (#860): it stays active and its saturation window restarts. */
  setKeep(id: string): Promise<EvalSetWriteResult>;
  /** Attach an operator check; a success carries only the case id and commit back. */
  setCheck(body: EvalSetCheckBody): Promise<EvalSetWriteResult>;
  /** Record an operator's calibration verdict on a case (#876): which of two arms was better on one axis, and why. */
  setCalibrate(body: EvalSetCalibrateBody): Promise<EvalSetWriteResult>;
  /** Merged PRs worth adding as cases, narrowed field by field: they are relayed to the remote store. */
  suggestions(): Promise<EvalSuggestionsView>;
  /** The recommended runs (#872), narrowed field by field: they are relayed to the remote store. */
  inbox(): Promise<EvalInboxView>;
  /** Recommend a plan into the inbox; a plan that would not run is the CLI's refusal. */
  inboxAdd(body: { plan: Record<string, unknown>; reason?: string }): Promise<EvalInboxWriteResult>;
  /** Start an entry's plan; the CLI removes the entry once the run started. */
  inboxStart(id: string): Promise<EvalInboxWriteResult>;
  inboxDismiss(id: string): Promise<EvalInboxWriteResult>;
  /** The improver's proposals (#874), narrowed field by field: they are relayed to the remote store. */
  proposals(): Promise<EvalProposalsView>;
  /** Start the improver on a finished run (#873), detached; a run it cannot read is the CLI's refusal. */
  improvePropose(body: { run: string; goal: "quality" | "cost" }): Promise<EvalImproveResult>;
  /** Open the PR a passed proposal stands for (#875), or answer the one open; a proposal that did not pass is the CLI's refusal. */
  openProposalPr(body: { proposal: string }): Promise<EvalOpenPrResult>;
}

export interface EvalsAdapterConfig {
  cliDir: string;
  root: string;
  bunPath?: string;
  env?: Env;
  exec: Executor;
  /** Milliseconds now; tests move it to age the suggestions. */
  now?: () => number;
}

const EMPTY: Omit<EvalsView, "problem"> = { runs: [], lineups: [], clerks: [], clerkRepos: [], defaults: { panel: [], trialMinutes: 90, repeats: 2, noiseFloorArms: 3 }, history: { trialSeconds: null, trialTokens: null, trials: 0 }, relayPatches: false };

const why = (result: ExecResult, verb: string): string => {
  const said = result.stderr.trim().split("\n").filter(Boolean).at(-1)?.replace(/^experiments: (Error: )?/, "");
  return said || `experiments.ts ${verb} ${result.status === null ? "did not run" : `exited ${result.status}`} without saying why`;
};

/**
 * `evals-set.ts`'s refusal, verbatim: its last `evals-set: ` line with the
 * prefix stripped. A usage error prints the usage after that line, so the
 * last line alone would be the usage, not the reason.
 */
const setWhy = (result: ExecResult, verb: string): string => {
  const lines = result.stderr.trim().split("\n").filter(Boolean);
  const said = ([...lines].reverse().find((line) => line.startsWith("evals-set: ")) ?? lines.at(-1))?.replace(/^evals-set: (Error: )?/, "");
  return said || `evals-set.ts ${verb} ${result.status === null ? "did not run" : `exited ${result.status}`} without saying why`;
};

/** `evals-inbox.ts`'s refusal: its last `evals-inbox: ` line with the prefix stripped, as `setWhy` reads the set's. */
const inboxWhy = (result: ExecResult, verb: string): string => {
  const lines = result.stderr.trim().split("\n").filter(Boolean);
  const said = ([...lines].reverse().find((line) => line.startsWith("evals-inbox: ")) ?? lines.at(-1))?.replace(/^evals-inbox: (Error: )?/, "");
  return said || `evals-inbox.ts ${verb} ${result.status === null ? "did not run" : `exited ${result.status}`} without saying why`;
};

/** `evals-improve.ts`'s refusal: its last `evals-improve: ` line with the prefix stripped; a usage error prints the usage after it. */
const improveWhy = (result: ExecResult): string => {
  const lines = result.stderr.trim().split("\n").filter(Boolean);
  const said = ([...lines].reverse().find((line) => line.startsWith("evals-improve: ")) ?? lines.at(-1))?.replace(/^evals-improve: (Error: )?/, "");
  return said || `evals-improve.ts propose ${result.status === null ? "did not run" : `exited ${result.status}`} without saying why`;
};

const parse = (result: ExecResult): unknown => {
  try { return JSON.parse(result.stdout); } catch { return null; }
};

const GUARDRAIL_GOALS: readonly EvalGoalVerdictView["goal"][] = ["quality", "cost"];

/** One condition, copied field by field; null when a field is off. */
function guardrailCondition(value: unknown): EvalGuardrailConditionView | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pass !== "boolean" || typeof value.reason !== "string") return null;
  return { id: value.id, pass: value.pass, reason: value.reason };
}

/** One goal's verdict, copied field by field; null when a field or any of its conditions is off. */
function goalVerdict(value: unknown): EvalGoalVerdictView | null {
  if (!isRecord(value) || !GUARDRAIL_GOALS.includes(value.goal as EvalGoalVerdictView["goal"]) || typeof value.pass !== "boolean" || !Array.isArray(value.conditions)) return null;
  const conditions = (value.conditions as unknown[]).map(guardrailCondition);
  if (conditions.some((condition) => condition === null)) return null;
  return { goal: value.goal as EvalGoalVerdictView["goal"], pass: value.pass, conditions: conditions as EvalGuardrailConditionView[] };
}

/**
 * A run's guardrail verdict (#871), copied field by field like the noise
 * status: the runs view is relayed to the remote store. One missing (an
 * older harness, a run with no verdict) or that does not parse is null,
 * never a partial verdict: a goal whose conditions were dropped could read
 * as a pass it never earned.
 */
function guardrailVerdict(value: unknown): EvalGuardrailVerdictView | null {
  if (!isRecord(value) || typeof value.baseline !== "string" || typeof value.proposal !== "string" || !Array.isArray(value.goals)) return null;
  const goals = (value.goals as unknown[]).map(goalVerdict);
  if (goals.some((goal) => goal === null)) return null;
  return { baseline: value.baseline, proposal: value.proposal, goals: goals as EvalGoalVerdictView[] };
}

/** One tally, copied field by field; null when a field is off or agree exceeds total. */
function accuracyTally(value: unknown): EvalAccuracyTallyView | null {
  if (!isRecord(value) || !count(value.agree) || !count(value.total) || value.agree > value.total) return null;
  const accuracy = value.accuracy;
  if (accuracy !== null && !(typeof accuracy === "number" && Number.isFinite(accuracy))) return null;
  return { agree: value.agree, total: value.total, accuracy };
}

/**
 * A run's judge accuracy (#877), copied field by field like the guardrail
 * verdict: the runs view is relayed to the remote store. One missing (an
 * older harness, a run off the set) or with any part that does not parse is
 * null, never a partial tally: an axis dropped would read as uncalibrated.
 */
function judgeAccuracy(value: unknown): EvalJudgeAccuracyView | null {
  if (!isRecord(value) || !isRecord(value.axes) || !count(value.contested)) return null;
  const overall = accuracyTally(value.overall);
  if (overall === null) return null;
  const axes = {} as Record<EvalAxis, EvalAccuracyTallyView>;
  for (const axis of EVAL_AXES) {
    const tally = accuracyTally(value.axes[axis]);
    if (tally === null) return null;
    axes[axis] = tally;
  }
  return { overall, axes, contested: value.contested };
}

/** The runs view, narrowed to what the page draws: a print it cannot read is a `problem`, never a throw. */
export function parseEvalsOutput(result: ExecResult): EvalsView {
  if (result.status !== 0) return { ...EMPTY, problem: why(result, "runs") };
  const value = parse(result);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runs)) {
    return { ...EMPTY, problem: `experiments.ts runs printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
  }
  const defaults = isRecord(value.defaults) ? value.defaults : {};
  const history = isRecord(value.history) ? value.history : {};
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    // The harness wrote these with the same contract; only the envelope is checked here,
    // except the guardrail verdict and the judge accuracy, which are copied field by field.
    runs: value.runs.filter((run): run is EvalRunView => isRecord(run) && typeof run.id === "string" && Array.isArray(run.cases))
      .map((run) => ({ ...run, guardrails: guardrailVerdict(run.guardrails), judgeAccuracy: judgeAccuracy(run.judgeAccuracy) })),
    lineups: Array.isArray(value.lineups) ? value.lineups.filter((name): name is string => typeof name === "string") : [],
    clerks: Array.isArray(value.clerks) ? value.clerks.filter((name): name is string => typeof name === "string") : [],
    clerkRepos: Array.isArray(value.clerkRepos) ? value.clerkRepos.filter((repo): repo is string => typeof repo === "string") : [],
    defaults: {
      panel: Array.isArray(defaults.panel) ? defaults.panel.filter((judge): judge is EvalsView["defaults"]["panel"][number] =>
        isRecord(judge) && (judge.runner === "claude" || judge.runner === "codex") && typeof judge.model === "string" && typeof judge.name === "string") : [],
      trialMinutes: num(defaults.trialMinutes) ?? 90,
      repeats: num(defaults.repeats) ?? 2,
      // The harness's own default arms (eval-noise-floor.ts), for an older harness that never prints it.
      noiseFloorArms: num(defaults.noiseFloorArms) ?? 3,
    },
    history: { trialSeconds: num(history.trialSeconds), trialTokens: num(history.trialTokens), trials: num(history.trials) ?? 0 },
    // Only an explicit true opens patches remotely: an older harness that never prints it relays nothing.
    relayPatches: value.relayPatches === true,
    problem: null,
  };
}

/**
 * The relayable patches, narrowed. It fails closed: any doubt about the print
 * (a non-zero exit, an unexpected shape) reads as disabled with no patch text,
 * since this is what leaves the host for the remote store.
 */
export function parseEvalPatchesOutput(result: ExecResult): EvalPatchesView {
  const closed = (problem: string): EvalPatchesView => ({ enabled: false, patches: [], omitted: 0, problem });
  if (result.status !== 0) return closed(why(result, "patches"));
  const value = parse(result);
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.patches)) {
    return closed(`experiments.ts patches printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}`);
  }
  if (!value.enabled) return { enabled: false, patches: [], omitted: 0, problem: null };
  const patches: EvalPatchesView["patches"] = [];
  for (const entry of value.patches as unknown[]) {
    if (
      isRecord(entry) && typeof entry.run === "string" && typeof entry.case === "string" && typeof entry.arm === "string" &&
      typeof entry.text === "string" && typeof entry.truncated === "boolean"
    ) {
      patches.push({ run: entry.run, case: entry.case, arm: entry.arm, text: entry.text, truncated: entry.truncated });
    }
  }
  const omitted = typeof value.omitted === "number" && Number.isFinite(value.omitted) ? value.omitted : 0;
  return { enabled: true, patches, omitted, problem: null };
}

const GRADERS: readonly EvalSetGrader[] = ["held-out tests", "check", "gates"];
const CASE_STATUSES: readonly EvalSetRowView["status"][] = ["active", "saturated", "retired"];
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * A row's saturation (#860), copied field by field like the rest of it. One
 * missing (an older harness) or that does not parse is null: the page never
 * flags a case saturated on a field it could not read.
 */
function saturation(value: unknown): EvalSaturationView | null {
  if (!isRecord(value) || typeof value.saturated !== "boolean" || !count(value.passes) || !count(value.window)) return null;
  return { saturated: value.saturated, passes: value.passes, window: value.window };
}

const isAxis = (value: unknown): value is EvalAxis => EVAL_AXES.includes(value as EvalAxis);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** One calibration verdict (#876), copied field by field; null when it does not parse, so the row drops it. */
function calibrationVerdict(value: unknown): EvalCalibrationVerdictView | null {
  if (!isRecord(value)) return null;
  const { arms, axis, preferred, reason, by, at } = value;
  if (!Array.isArray(arms) || arms.length !== 2 || !arms.every(nonEmpty) || arms[0] === arms[1]) return null;
  const [first, second] = arms as [string, string];
  if (!isAxis(axis) || (preferred !== first && preferred !== second) || !nonEmpty(reason) || !nonEmpty(by) || !nonEmpty(at)) return null;
  return { arms: [first, second], axis, preferred, reason, by, at };
}

/** A row's verdicts (#876): only a list is read, and an entry that does not parse is dropped rather than drawn as a guess. */
function calibrationVerdicts(value: unknown): EvalCalibrationVerdictView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(calibrationVerdict).filter((verdict): verdict is EvalCalibrationVerdictView => verdict !== null);
}

/**
 * One calibration suggestion (#876), copied field by field: suggestions are
 * relayed on every project. A contested entry that does not parse is dropped;
 * a suggestion left with none is dropped too, since it would ask about nothing.
 */
function calibrationSuggestion(value: unknown): EvalCalibrationSuggestionView | null {
  if (!isRecord(value)) return null;
  const { id, title, contested, run, calibrations } = value;
  if (typeof id !== "string" || typeof title !== "string" || typeof run !== "string" || !count(calibrations) || !Array.isArray(contested)) return null;
  const axes = contested.flatMap((entry) => {
    if (!isRecord(entry) || !isAxis(entry.axis)) return [];
    const arms = strings(entry.arms);
    return arms === null ? [] : [{ axis: entry.axis, arms }];
  });
  if (axes.length === 0) return null;
  return { id, title, contested: axes, run, calibrations };
}

/** The set's suggestions (#876): missing (a harness older than #876) or not a list is none. */
function calibrationSuggestions(value: unknown): EvalCalibrationSuggestionView[] {
  if (!Array.isArray(value)) return [];
  return value.map(calibrationSuggestion).filter((suggestion): suggestion is EvalCalibrationSuggestionView => suggestion !== null);
}

/** One row, copied field by field so nothing undeclared reaches the remote store; null when a required field is off. */
function setRow(value: unknown, details: boolean): EvalSetRowView | null {
  if (!isRecord(value)) return null;
  const { id, repo, prs, title, tags, graders, status, addedAt, addedBy, lastRun } = value;
  const tagList = strings(tags);
  if (
    typeof id !== "string" || typeof repo !== "string" || typeof title !== "string" || typeof addedAt !== "string" || typeof addedBy !== "string" ||
    !Array.isArray(prs) || !prs.every((pr) => typeof pr === "number" && Number.isSafeInteger(pr)) || tagList === null || !Array.isArray(graders) ||
    !CASE_STATUSES.includes(status as EvalSetRowView["status"])
  ) return null;
  const run = isRecord(lastRun) && typeof lastRun.run === "string" && typeof lastRun.startedAt === "string" ? { run: lastRun.run, startedAt: lastRun.startedAt } : null;
  // The verdicts carry the operator's reasons, so they are read only with details on; the count always.
  const calibration = details ? calibrationVerdicts(value.calibration) : undefined;
  return {
    id, repo, prs: [...(prs as number[])], title, tags: tagList,
    // A grader kind this page does not know is dropped, not drawn as a guess.
    graders: graders.filter((grader): grader is EvalSetGrader => GRADERS.includes(grader as EvalSetGrader)),
    status: status as EvalSetRowView["status"], addedAt, addedBy, lastRun: run,
    saturation: saturation(value.saturation),
    calibrations: count(value.calibrations) ? value.calibrations : 0,
    ...(details && typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(details && typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(calibration === undefined ? {} : { calibration }),
  };
}

/** No floor: what an older harness, or a status that does not parse, reads as. 0.2 is eval-noise-floor.ts's default stale share. */
const NO_FLOOR: EvalNoiseStatusView = { state: "missing", floor: null, drift: null, staleShare: 0.2 };
const FLOOR_STATES: readonly EvalNoiseStatusView["state"][] = ["fresh", "stale", "missing"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const spreadValue = (value: unknown): number | null | undefined => (value === null ? null : finite(value) ? value : undefined);

/**
 * The set's noise-floor status, copied field by field like the rows: it is
 * relayed to the remote store. One that does not parse is no floor, so the
 * page never vouches for a floor it could not read.
 */
function noiseStatus(value: unknown): EvalNoiseStatusView {
  if (!isRecord(value) || !FLOOR_STATES.includes(value.state as EvalNoiseStatusView["state"]) || !finite(value.staleShare)) return NO_FLOOR;
  const state = value.state as EvalNoiseStatusView["state"];
  if (state === "missing") return { ...NO_FLOOR, staleShare: value.staleShare };
  const { floor, drift } = value;
  if (!isRecord(floor) || !isRecord(floor.spread) || !isRecord(drift)) return NO_FLOOR;
  const objective = spreadValue(floor.spread.objective);
  const judge = spreadValue(floor.spread.judge);
  if (
    typeof floor.version !== "string" || typeof floor.measuredAt !== "string" || typeof floor.runId !== "string" || objective === undefined || judge === undefined ||
    !finite(drift.added) || !finite(drift.retired) || !finite(drift.share)
  ) return NO_FLOOR;
  return {
    state,
    floor: { version: floor.version, measuredAt: floor.measuredAt, runId: floor.runId, spread: { objective, judge } },
    drift: { added: drift.added, retired: drift.retired, share: drift.share },
    staleShare: value.staleShare,
  };
}

/** The test-set view: a print it cannot read is a `problem`, never a throw. */
export function parseEvalSetOutput(result: ExecResult): EvalSetView {
  const empty = (problem: string): EvalSetView => ({ version: null, details: false, cases: [], noiseFloor: NO_FLOOR, calibrationSuggestions: [], problem });
  if (result.status !== 0) return empty(setWhy(result, "view"));
  const value = parse(result);
  if (!isRecord(value) || (value.version !== null && typeof value.version !== "string") || typeof value.details !== "boolean" || !Array.isArray(value.cases)) {
    return empty(`evals-set.ts view printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}`);
  }
  const details = value.details === true;
  const cases = (value.cases as unknown[]).map((row) => setRow(row, details)).filter((row): row is EvalSetRowView => row !== null);
  return {
    version: value.version as string | null, details, cases, noiseFloor: noiseStatus(value.noiseFloor),
    calibrationSuggestions: calibrationSuggestions(value.calibrationSuggestions), problem: null,
  };
}

/** One suggestion, copied field by field so nothing undeclared reaches the remote store; null when a required field is off. */
function suggestionRow(value: unknown): EvalSuggestionView | null {
  if (!isRecord(value)) return null;
  const { repo, pr, title, url, mergedAt, tickets, score, reasons } = value;
  if (
    typeof repo !== "string" || typeof pr !== "number" || !Number.isSafeInteger(pr) || typeof title !== "string" || typeof url !== "string" ||
    typeof mergedAt !== "string"
  ) return null;
  return {
    repo, pr, title, url, mergedAt,
    tickets: Array.isArray(tickets) ? tickets.filter((ticket): ticket is number => typeof ticket === "number" && Number.isSafeInteger(ticket)) : [],
    score: typeof score === "number" && Number.isFinite(score) ? score : 0,
    // A signal this page does not know is kept as its text: the text says it plainly either way.
    reasons: Array.isArray(reasons)
      ? reasons.filter((reason) => isRecord(reason) && typeof reason.signal === "string" && typeof reason.text === "string")
        .map((reason) => ({ signal: reason.signal as string, text: reason.text as string }))
      : [],
  };
}

/** The suggestions: a print it cannot read is a `problem`, never a throw. */
export function parseEvalSuggestionsOutput(result: ExecResult): EvalSuggestionsView {
  const empty = (problem: string): EvalSuggestionsView => ({ version: null, suggestions: [], missing: [], problem });
  if (result.status !== 0) return empty(setWhy(result, "suggest"));
  const value = parse(result);
  if (!isRecord(value) || (value.version !== null && typeof value.version !== "string") || !Array.isArray(value.suggestions)) {
    return empty(`evals-set.ts suggest printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}`);
  }
  const suggestions = (value.suggestions as unknown[]).map(suggestionRow).filter((row): row is EvalSuggestionView => row !== null);
  const missing = Array.isArray(value.missing)
    ? (value.missing as unknown[]).filter((entry) => isRecord(entry) && typeof entry.source === "string" && typeof entry.why === "string")
      .map((entry) => ({ source: (entry as Record<string, unknown>).source as string, why: (entry as Record<string, unknown>).why as string }))
    : [];
  return { version: value.version as string | null, suggestions, missing, problem: null };
}

/**
 * One inbox row, copied field by field so nothing undeclared reaches the
 * remote store: a plan, a diff or a path the CLI printed beside it is left
 * behind. Null when a required field is off; the list drops it.
 */
function inboxRow(value: unknown): EvalInboxRowView | null {
  if (!isRecord(value)) return null;
  const { id, source, arms, repeats, trials, recommendedBy, reason, addedAt } = value;
  const armList = strings(arms);
  if (
    typeof id !== "string" || typeof source !== "string" || armList === null || !count(repeats) ||
    (trials !== null && !count(trials)) || !isRecord(recommendedBy) ||
    (recommendedBy.kind !== "agent" && recommendedBy.kind !== "person") || typeof recommendedBy.name !== "string" ||
    typeof reason !== "string" || typeof addedAt !== "string"
  ) return null;
  return {
    id, source, arms: armList, repeats, trials: trials as number | null,
    recommendedBy: { kind: recommendedBy.kind, name: recommendedBy.name }, reason, addedAt,
  };
}

/** The inbox: a print it cannot read is a `problem`, never a throw. */
export function parseEvalInboxOutput(result: ExecResult): EvalInboxView {
  if (result.status !== 0) return { entries: [], problem: inboxWhy(result, "list") };
  const value = parse(result);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return { entries: [], problem: `evals-inbox.ts list printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
  }
  return { entries: (value.entries as unknown[]).map(inboxRow).filter((row): row is EvalInboxRowView => row !== null), problem: null };
}

/** `evals-proposals.ts`'s refusal: its last `evals-proposals: ` line with the prefix stripped, as `inboxWhy` reads the inbox's. */
const proposalsWhy = (result: ExecResult, verb = "list"): string => {
  const lines = result.stderr.trim().split("\n").filter(Boolean);
  const said = ([...lines].reverse().find((line) => line.startsWith("evals-proposals: ")) ?? lines.at(-1))?.replace(/^evals-proposals: (Error: )?/, "");
  return said || `evals-proposals.ts ${verb} ${result.status === null ? "did not run" : `exited ${result.status}`} without saying why`;
};

const PROPOSAL_KINDS: readonly EvalProposalRowView["kind"][] = [
  "prompt-overlay", "lineup", "judge-prompt", "analyst-prompt", "case", "check", "retire-suggestion",
];
const PROPOSAL_STATUSES: readonly EvalProposalRowView["status"][] = [
  "proposed", "subset-run", "full-run", "passed", "failed", "suggested", "confirmed",
];
const runId = (value: unknown): value is string | null => value === null || typeof value === "string";

/** A proposal's verdict, copied field by field; undefined when it does not parse, never a partial verdict. */
function proposalVerdict(value: unknown): EvalProposalRowView["verdict"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.pass !== "boolean" || !Array.isArray(value.conditions)) return undefined;
  const conditions = (value.conditions as unknown[]).map(guardrailCondition);
  if (conditions.some((condition) => condition === null)) return undefined;
  return { pass: value.pass, conditions: conditions as EvalGuardrailConditionView[] };
}

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * A test-set proposal's suggestion, copied field by field and only when it
 * matches the row's kind; undefined when off, so the row stays without it.
 */
function proposalSuggestion(value: unknown, kind: EvalProposalRowView["kind"]): EvalProposalSuggestionView | undefined {
  if (!isRecord(value) || value.kind !== kind) return undefined;
  if (kind === "case") {
    const { repo, prs, reason, tags } = value;
    if (
      typeof repo !== "string" || typeof reason !== "string" || !stringList(tags) || !Array.isArray(prs) || prs.length === 0 ||
      !prs.every((pr) => Number.isInteger(pr) && (pr as number) > 0)
    ) return undefined;
    return { kind, repo, prs: [...(prs as number[])], reason, tags: [...tags] };
  }
  if (kind === "check") {
    const { case: id, test, command } = value;
    // A test file only: a suggestion naming a command would put a model-written command one Confirm away from the host.
    if (typeof id !== "string" || typeof test !== "string" || command !== undefined) return undefined;
    return { kind, case: id, test };
  }
  if (kind === "retire-suggestion") {
    const { case: id, reason } = value;
    if (typeof id !== "string" || typeof reason !== "string") return undefined;
    return { kind, case: id, reason };
  }
  return undefined;
}

/**
 * One proposal row, copied field by field so nothing undeclared reaches the
 * remote store: content, an overlay path, files, a plan or a diff the CLI
 * printed beside it is left behind. Rationale, answers, a test-set target
 * and its suggestion are copied only when present and the print says the
 * project relays patches (`details`), so a CLI that over-shares on a
 * summary-only project still relays a summary.
 * Null when a required field is off; the list drops it.
 */
function proposalRow(value: unknown, details: boolean): EvalProposalRowView | null {
  if (!isRecord(value)) return null;
  const { id, run, goal, kind, status, reason, createdAt, runs, rationale, answers } = value;
  const verdict = proposalVerdict(value.verdict);
  if (
    typeof id !== "string" || typeof run !== "string" || !GUARDRAIL_GOALS.includes(goal as EvalProposalRowView["goal"]) ||
    !PROPOSAL_KINDS.includes(kind as EvalProposalRowView["kind"]) || !PROPOSAL_STATUSES.includes(status as EvalProposalRowView["status"]) ||
    verdict === undefined || (reason !== null && typeof reason !== "string") || typeof createdAt !== "string" ||
    !isRecord(runs) || !runId(runs.subset) || !runId(runs.full)
  ) return null;
  const row: EvalProposalRowView = {
    id, run, goal: goal as EvalProposalRowView["goal"], kind: kind as EvalProposalRowView["kind"], status: status as EvalProposalRowView["status"],
    verdict, reason: reason as string | null, createdAt, runs: { subset: runs.subset, full: runs.full },
  };
  if (!details) return row;
  if (typeof rationale === "string") row.rationale = rationale;
  if (Array.isArray(answers)) {
    row.answers = (answers as unknown[])
      .filter((answer): answer is Record<string, unknown> =>
        isRecord(answer) && typeof answer.knob === "string" && typeof answer.target === "string" && typeof answer.change === "string")
      .map((answer) => ({ knob: answer.knob as string, target: answer.target as string, change: answer.change as string }));
  }
  if (typeof value.target === "string") row.target = value.target;
  // A malformed suggestion is dropped, not the row: the operator still sees the proposal, without a Confirm.
  const suggestion = proposalSuggestion(value.suggestion, row.kind);
  if (suggestion !== undefined) row.suggestion = suggestion;
  return row;
}

/** The proposals: a print it cannot read is a `problem`, never a throw. */
export function parseEvalProposalsOutput(result: ExecResult): EvalProposalsView {
  const failed = (problem: string): EvalProposalsView => ({ details: false, proposals: [], problems: [], problem });
  if (result.status !== 0) return failed(proposalsWhy(result));
  const value = parse(result);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.proposals)) {
    return failed(`evals-proposals.ts list printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}`);
  }
  // Only an explicit true says the rows may carry details, as relayPatches is read.
  const details = value.details === true;
  return {
    details,
    proposals: (value.proposals as unknown[]).map((row) => proposalRow(row, details)).filter((row): row is EvalProposalRowView => row !== null),
    problems: Array.isArray(value.problems) ? (value.problems as unknown[]).filter((problem): problem is string => typeof problem === "string") : [],
    problem: null,
  };
}

/**
 * An open-pr's print as the page's result, copied field by field so nothing
 * else the CLI printed is relayed; a non-zero exit is its refusal, already
 * redacted by the CLI as every `evals-proposals` error is.
 */
export function parseEvalOpenPrOutput(result: ExecResult): EvalOpenPrResult {
  if (result.status !== 0) return { ok: false, why: proposalsWhy(result, "open-pr") };
  const value = parse(result);
  if (
    !isRecord(value) || value.version !== 1 || (value.kind !== "opened" && value.kind !== "exists") ||
    typeof value.number !== "number" || !Number.isInteger(value.number) || value.number <= 0 ||
    typeof value.url !== "string" || typeof value.proposal !== "string" || typeof value.autoMerge !== "boolean"
  ) {
    return { ok: false, why: `evals-proposals.ts open-pr printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
  }
  return { ok: true, kind: value.kind, number: value.number, url: value.url, proposal: value.proposal, autoMerge: value.autoMerge };
}

/**
 * An inbox write's print as the page's result; a non-zero exit is the CLI's
 * refusal. Add prints the entry, start the run and the entry it removed,
 * dismiss the entry it removed.
 */
export function parseEvalInboxWrite(result: ExecResult, verb: "add" | "start" | "dismiss"): EvalInboxWriteResult {
  if (result.status !== 0) return { ok: false, why: inboxWhy(result, verb) };
  const value = parse(result);
  const unexpected: EvalInboxWriteResult = { ok: false, why: `evals-inbox.ts ${verb} printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
  if (!isRecord(value) || value.version !== 1) return unexpected;
  if (verb === "add") {
    const entry = inboxRow(value.entry);
    return entry === null ? unexpected : { ok: true, entry };
  }
  if (typeof value.removed !== "string") return unexpected;
  if (verb === "dismiss") return { ok: true, removed: value.removed };
  const run = isRecord(value.run) ? value.run.id : null;
  return typeof run === "string" ? { ok: true, run, removed: value.removed } : unexpected;
}

/**
 * A detached propose's print as the page's result, copied field by field so
 * nothing else the CLI printed is relayed; a non-zero exit is its refusal.
 */
export function parseEvalImproveOutput(result: ExecResult): EvalImproveResult {
  if (result.status !== 0) return { ok: false, why: improveWhy(result) };
  const value = parse(result);
  if (
    !isRecord(value) || value.ok !== true || value.started !== true || typeof value.run !== "string" ||
    (value.goal !== "quality" && value.goal !== "cost")
  ) {
    return { ok: false, why: `evals-improve.ts propose printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
  }
  return { ok: true, started: true, run: value.run, goal: value.goal };
}

/**
 * `{sha, case}` from a write, as the page's result; a non-zero exit is the
 * CLI's refusal. Add, edit, retire and keep print the case itself; check prints
 * only its id, beside the two outcomes the page does not need.
 */
function parseEvalSetWrite(result: ExecResult, verb: string): EvalSetWriteResult {
  if (result.status !== 0) return { ok: false, why: setWhy(result, verb) };
  const value = parse(result);
  const id = !isRecord(value) ? null : isRecord(value.case) ? value.case.id : value.case;
  return isRecord(value) && typeof value.sha === "string" && typeof id === "string"
    ? { ok: true, id, sha: value.sha }
    : { ok: false, why: `evals-set.ts ${verb} printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
}

/**
 * The CLI reads a value that starts with `--` as a missing value and has no
 * `--flag=value` form, so such text is refused here rather than passed on to
 * be refused as a usage error, or worse, read as the next flag.
 */
function flagLike(body: { tags?: string[]; notes?: string; reason?: string; test?: string; command?: string }): string | null {
  if (body.reason?.startsWith("--")) return "the reason may not start with --";
  if (body.test?.startsWith("--")) return "the test path may not start with --";
  if (body.command?.startsWith("--")) return "the command may not start with --";
  if (body.notes?.startsWith("--")) return "the notes may not start with --";
  if (body.tags?.some((tag) => tag.startsWith("--"))) return "a tag may not start with --";
  return null;
}

export function createEvalsAdapter(config: EvalsAdapterConfig): EvalsAdapter {
  const root = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const env: Env = { ...process.env, ...config.env, RALPH_PROJECT: root };
  const exec = guarded(config.exec);
  const script = join(resolve(config.cliDir), EVALS_SURFACE.script);
  const run = (args: readonly string[], input?: string) =>
    exec({ command: bunPath, args: [script, ...args], cwd: root, env, ...(input === undefined ? {} : { input }) });
  // evals-set.ts finds the project from RALPH_PROJECT (paths.ts projectRoot), the same env the runs use.
  const setScript = join(resolve(config.cliDir), EVALS_SET_SURFACE.script);
  const setEnv: Env = { ...env, RALPH_EVALS_SET_LOCK_WAIT: String(EVALS_SET_LOCK_WAIT_SECONDS) };
  const runSet = (args: readonly string[], timeoutMs?: number) =>
    exec({ command: bunPath, args: [setScript, ...args], cwd: root, env: setEnv, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const write = (args: readonly string[]) => runSet(args, EVALS_SET_WRITE_TIMEOUT_MS);
  const checkEnv: Env = { ...env, RALPH_EVALS_SET_LOCK_WAIT: String(EVALS_SET_CHECK_LOCK_WAIT_SECONDS) };
  const runCheck = (args: readonly string[]) =>
    exec({ command: bunPath, args: [setScript, ...args], cwd: root, env: checkEnv, timeoutMs: EVALS_SET_WRITE_TIMEOUT_MS });
  const inboxScript = join(resolve(config.cliDir), EVALS_INBOX_SURFACE.script);
  // evals-inbox.ts finds the project from RALPH_PROJECT, as evals-set.ts does.
  const runInbox = (args: readonly string[], input?: string) =>
    exec({ command: bunPath, args: [inboxScript, ...args], cwd: root, env, ...(input === undefined ? {} : { input }) });
  const proposalsScript = join(resolve(config.cliDir), EVALS_PROPOSALS_SURFACE.script);
  // evals-improve.ts finds the project from RALPH_PROJECT, as evals-inbox.ts does.
  const improveScript = join(resolve(config.cliDir), EVALS_IMPROVE_SURFACE.script);
  const now = config.now ?? Date.now;
  // One suggest run at a time per project, its last answer served while the
  // next one runs: see EVALS_SUGGEST_WAIT_MS.
  let suggested: { at: number; view: EvalSuggestionsView } | null = null;
  let suggesting: Promise<EvalSuggestionsView> | null = null;
  // Bumped by every add: a run that started before an add read the set
  // without it, so its answer would bring the added PR back.
  let generation = 0;
  const refreshSuggestions = (): Promise<EvalSuggestionsView> => {
    const started = generation;
    suggesting ??= runSet(EVALS_SET_SURFACE.suggest, EVALS_SUGGEST_TIMEOUT_MS)
      .then(parseEvalSuggestionsOutput, (error: unknown) => parseEvalSuggestionsOutput({ status: null, stdout: "", stderr: String(error) }))
      .then((view) => {
        const last = suggested;
        if (started !== generation) {
          // Serve what we had (the add already dropped its PR from it), and
          // leave it stale so the next read starts a run that sees the add.
          suggested = { at: Number.NEGATIVE_INFINITY, view: last?.view ?? view };
          return suggested.view;
        }
        // A run that failed keeps the last good list on screen, with why it
        // could not be refreshed, rather than blanking it until the next run.
        const kept = view.problem !== null && last !== null && last.view.problem === null
          ? { ...last.view, problem: `Not refreshed: ${view.problem}` }
          : view;
        suggested = { at: now(), view: kept };
        return kept;
      })
      .finally(() => { suggesting = null; });
    return suggesting;
  };
  return {
    runs: async () => parseEvalsOutput(await run(EVALS_SURFACE.runs)),
    patches: async () => parseEvalPatchesOutput(await run(EVALS_SURFACE.patches)),
    async start(plan) {
      const result = await run(EVALS_SURFACE.start, JSON.stringify(plan));
      if (result.status !== 0) return { ok: false, why: why(result, "start") };
      const value = parse(result);
      const started = isRecord(value) && isRecord(value.run) ? value.run.id : null;
      return typeof started === "string" ? { ok: true, id: started } : { ok: false, why: `experiments.ts start printed no run: ${result.stdout.trim().slice(0, 200)}` };
    },
    async stop(id) {
      const result = await run(EVALS_SURFACE.stop(id));
      if (result.status !== 0) return { stopped: false, why: why(result, "stop") };
      const value = parse(result);
      return isRecord(value) && typeof value.stopped === "boolean"
        ? { stopped: value.stopped, why: typeof value.why === "string" ? value.why : null }
        : { stopped: false, why: `experiments.ts stop printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
    },
    async patch(id, ticket, arm) {
      const result = await run(EVALS_SURFACE.patch(id, ticket, arm));
      return result.status === 0 ? { ok: true, text: result.stdout } : { ok: false, why: why(result, "patch") };
    },
    set: async () => parseEvalSetOutput(await runSet(EVALS_SET_SURFACE.view)),
    async setCase(id) {
      const result = await runSet(EVALS_SET_SURFACE.show(id));
      if (result.status !== 0) return { ok: false, why: setWhy(result, "show") };
      const value = parse(result);
      const found = isRecord(value) && isRecord(value.case) ? value.case : null;
      const tags = strings(found?.tags);
      if (found === null || typeof found.id !== "string" || tags === null || typeof found.reason !== "string" || typeof found.notes !== "string") {
        return { ok: false, why: `evals-set.ts show printed an unexpected shape: ${result.stdout.trim().slice(0, 200)}` };
      }
      return { ok: true, case: { id: found.id, tags, reason: found.reason, notes: found.notes } };
    },
    async setAdd(body) {
      const refused = flagLike(body);
      if (refused !== null) return { ok: false, why: refused };
      const added = parseEvalSetWrite(await write(EVALS_SET_SURFACE.add(body)), "add");
      // The added PRs are held now: drop them from the served suggestions at
      // once, and age the rest so the next read starts a fresh run.
      if (added.ok) generation += 1;
      if (added.ok && suggested !== null) {
        const held = new Set(body.prs);
        const sameRepo = (repo: string) => repo.toLowerCase() === body.repo.toLowerCase();
        suggested = {
          at: Number.NEGATIVE_INFINITY,
          view: { ...suggested.view, suggestions: suggested.view.suggestions.filter((row) => !(sameRepo(row.repo) && held.has(row.pr))) },
        };
      }
      return added;
    },
    async setEdit(body) {
      const refused = flagLike(body);
      if (refused !== null) return { ok: false, why: refused };
      return parseEvalSetWrite(await write(EVALS_SET_SURFACE.edit(body)), "edit");
    },
    setRetire: async (id) => parseEvalSetWrite(await write(EVALS_SET_SURFACE.retire(id)), "retire"),
    setKeep: async (id) => parseEvalSetWrite(await write(EVALS_SET_SURFACE.keep(id)), "keep"),
    async setCheck(body) {
      const refused = flagLike(body);
      if (refused !== null) return { ok: false, why: refused };
      return parseEvalSetWrite(await runCheck(EVALS_SET_SURFACE.check(body)), "check");
    },
    async setCalibrate(body) {
      const refused = flagLike(body);
      if (refused !== null) return { ok: false, why: refused };
      return parseEvalSetWrite(await write(EVALS_SET_SURFACE.calibrate(body)), "calibrate");
    },
    inbox: async () => parseEvalInboxOutput(await runInbox(EVALS_INBOX_SURFACE.list)),
    async inboxAdd(body) {
      const reason = body.reason ?? EVAL_INBOX_DEFAULT_REASON;
      const refused = flagLike({ reason });
      if (refused !== null) return { ok: false, why: refused };
      return parseEvalInboxWrite(await runInbox(EVALS_INBOX_SURFACE.add(reason), JSON.stringify(body.plan)), "add");
    },
    inboxStart: async (id) => parseEvalInboxWrite(await runInbox(EVALS_INBOX_SURFACE.start(id)), "start"),
    inboxDismiss: async (id) => parseEvalInboxWrite(await runInbox(EVALS_INBOX_SURFACE.dismiss(id)), "dismiss"),
    proposals: async () => parseEvalProposalsOutput(
      await exec({ command: bunPath, args: [proposalsScript, ...EVALS_PROPOSALS_SURFACE.list(root)], cwd: root, env }),
    ),
    openProposalPr: async (body) => parseEvalOpenPrOutput(
      await exec({
        command: bunPath, args: [proposalsScript, ...EVALS_PROPOSALS_SURFACE.openPr(body.proposal, root)], cwd: root, env,
        timeoutMs: EVALS_PROPOSAL_OPEN_PR_TIMEOUT_MS,
      }),
    ),
    improvePropose: async (body) => parseEvalImproveOutput(
      await exec({ command: bunPath, args: [improveScript, ...EVALS_IMPROVE_SURFACE.propose(body.run, body.goal)], cwd: root, env }),
    ),
    async suggestions() {
      const last = suggested;
      if (last !== null && now() - last.at < EVALS_SUGGEST_FRESH_MS) return last.view;
      const fresh = refreshSuggestions();
      if (last !== null) return last.view;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Promise<EvalSuggestionsView>((resolve) => {
        timer = setTimeout(() => resolve({ version: null, suggestions: [], missing: [], problem: null, pending: true }), EVALS_SUGGEST_WAIT_MS);
      });
      try {
        return await Promise.race([fresh, pending]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
