/**
 * The Evals tab's decisions (#801), pure so they are tested in node: the Run
 * form's state and the plan it sends, the estimate shown before a start, and
 * how a run's numbers are labelled. `evals.tsx` only draws.
 */
import type {
  EvalAccuracyTallyView,
  EvalArmGapView,
  EvalGoalVerdictView,
  EvalGuardrailConditionView,
  EvalJudgeAccuracyView,
  EvalArmResolutionView,
  EvalArmTotalView,
  EvalAxis,
  EvalAxisGapView,
  EvalCaseArmView,
  EvalAxisSpreadView,
  EvalCalibrationVerdictView,
  EvalCaseView,
  EvalNoiseSpreadView,
  EvalNoiseStatusView,
  EvalProposalRowView,
  EvalProposalStatus,
  EvalRepeatView,
  EvalRunView,
  EvalSetRowView,
  EvalSetView,
  EvalSuggestionsView,
  EvalSuggestionView,
  EvalsView,
} from "../contracts";
import { EVAL_AXES } from "../contracts";

export const EVAL_AXIS_LABELS: Record<EvalAxis, string> = {
  correctness: "Correct",
  scope: "Scope",
  tests: "Tests",
  maintainability: "Fit",
  review: "Review",
};

export interface ArmForm { name: string; lineup: string; overlay: string }
export interface JudgeForm { name: string; runner: "claude" | "codex"; model: string }
export interface RunForm {
  /** Where the cases come from: merged PRs, a clerk's person tickets (a backtest), or the project's test set. */
  source: "pr" | "clerk" | "set";
  prs: string;
  ticket: string;
  repo: string;
  clerk: string;
  /** How many of the clerk's person tickets to replay at most. */
  cap: number;
  /** `YYYY-MM-DD` as a date input gives it, or "" for no lower bound. */
  since: string;
  /** A clerk run's local checkout of each app repo it draws from: repo → path as typed. */
  checkouts: Record<string, string>;
  arms: ArmForm[];
  judges: JudgeForm[];
  repeats: number;
  trialMinutes: number;
  /** Which of the test set's cases a set run replays: every active one, those carrying a tag, or a hand-picked list. */
  setMode: "all" | "tags" | "subset";
  setTags: string[];
  /** Case ids; a stale one (gone or retired) is dropped by `selectSetCases`. */
  setCases: string[];
}

export const MAX_ARMS = 6;
export const MAX_CLERK_CAP = 50;

/** The form a new run opens with: two arms on the live lineup and the view's default panel. */
export function defaultForm(view: EvalsView | null): RunForm {
  return {
    source: "pr",
    prs: "",
    ticket: "",
    repo: "",
    clerk: view?.clerks?.[0] ?? "",
    cap: 10,
    since: "",
    checkouts: {},
    arms: [{ name: "live", lineup: "live", overlay: "" }, { name: "candidate", lineup: view?.lineups[0] ?? "live", overlay: "" }],
    judges: (view?.defaults.panel ?? [{ name: "opus", runner: "claude", model: "claude-opus-5-5" }]).map((judge) => ({ ...judge })),
    repeats: view?.defaults.repeats ?? 2,
    trialMinutes: view?.defaults.trialMinutes ?? 90,
    setMode: "all",
    setTags: [],
    setCases: [],
  };
}

/**
 * The test set's cases a set form selects, mirroring the harness's
 * `selectCases` (#854): a retired case never; a saturated one still does; a
 * tag filter passes a case carrying ANY listed tag; a subset passes only its
 * ids. The mode decides which list applies, so a list the other mode left
 * behind is not sent and does not count.
 */
export function selectSetCases(cases: readonly EvalSetRowView[], form: Pick<RunForm, "setMode" | "setTags" | "setCases">): EvalSetRowView[] {
  const live = cases.filter((entry) => entry.status !== "retired");
  if (form.setMode === "tags") {
    const tags = new Set(form.setTags);
    return live.filter((entry) => entry.tags.some((tag) => tags.has(tag)));
  }
  if (form.setMode === "subset") {
    const ids = new Set(form.setCases);
    return live.filter((entry) => ids.has(entry.id));
  }
  return live;
}

/** Every tag a non-retired case carries, sorted: the chips the By tag mode offers. */
export function setTagsOffered(cases: readonly EvalSetRowView[]): string[] {
  return [...new Set(cases.filter((entry) => entry.status !== "retired").flatMap((entry) => entry.tags))].sort();
}

/** The set's version as the page shows it: a short sha, or "uncommitted". */
export const setShortVersion = (version: string | null): string => (version === null ? "uncommitted" : version.slice(0, 7));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isArm = (value: unknown): value is ArmForm => isRecord(value) && typeof value.name === "string" && typeof value.lineup === "string" && typeof value.overlay === "string";
const isJudge = (value: unknown): value is JudgeForm =>
  isRecord(value) && typeof value.name === "string" && (value.runner === "claude" || value.runner === "codex") && typeof value.model === "string";

/**
 * A stored form merged over the fallback field by field: a field of the
 * wrong type or shape keeps the fallback's, so a form saved by an older page
 * (or garbage in localStorage) never breaks this one.
 */
export function restoreForm(stored: unknown, fallback: RunForm): RunForm {
  if (!isRecord(stored)) return fallback;
  const pick = <K extends keyof RunForm>(key: K, valid: (value: unknown) => boolean): RunForm[K] =>
    valid(stored[key]) ? (stored[key] as RunForm[K]) : fallback[key];
  const string = (value: unknown) => typeof value === "string";
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  return {
    source: pick("source", (value) => value === "pr" || value === "clerk" || value === "set"),
    prs: pick("prs", string),
    ticket: pick("ticket", string),
    repo: pick("repo", string),
    clerk: pick("clerk", string),
    cap: pick("cap", number),
    since: pick("since", string),
    checkouts: pick("checkouts", (value) => isRecord(value) && Object.values(value).every((path) => typeof path === "string")),
    arms: pick("arms", (value) => Array.isArray(value) && value.length > 0 && value.every(isArm)),
    judges: pick("judges", (value) => Array.isArray(value) && value.length > 0 && value.every(isJudge)),
    repeats: pick("repeats", number),
    trialMinutes: pick("trialMinutes", number),
    setMode: pick("setMode", (value) => value === "all" || value === "tags" || value === "subset"),
    setTags: pick("setTags", isStrings),
    setCases: pick("setCases", isStrings),
  };
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `12, #13 14` → [12, 13, 14]; null when anything else is in it. */
export function parsePrs(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean).map((part) => part.replace(/^#/, ""));
  if (parts.length === 0 || parts.some((part) => !/^[1-9]\d*$/.test(part))) return null;
  return [...new Set(parts.map(Number))];
}

/**
 * The plan the form sends, or the first thing wrong with it. Only what the
 * page can judge is judged here; whether it would run is the harness's
 * answer, which the start shows as a refusal.
 */
export function buildPlan(form: RunForm, clerkRepos: readonly string[] = [], set: EvalSetView | null = null): { ok: true; plan: Record<string, unknown> } | { ok: false; why: string } {
  if (form.source === "set") {
    if (set === null) return { ok: false, why: "The test set has not loaded yet." };
    if (set.problem !== null) return { ok: false, why: `The test set could not be read: ${set.problem}` };
    if (form.setMode === "tags" && form.setTags.length === 0) return { ok: false, why: "Pick at least one tag." };
    if (form.setMode === "subset" && form.setCases.length === 0) return { ok: false, why: "Pick at least one case." };
    const selected = selectSetCases(set.cases, form);
    if (selected.length === 0) return { ok: false, why: "The selection holds no case to run: a retired case never runs, and a picked one may be gone." };
    const shared = sharedPlan(form);
    if (!shared.ok) return shared;
    // Only the mode's own list is sent; a subset sends the ids still offered,
    // so the run starts exactly the cases the estimate counted.
    const source = form.setMode === "tags" ? { kind: "set", tags: form.setTags } : form.setMode === "subset" ? { kind: "set", cases: selected.map((entry) => entry.id) } : { kind: "set" };
    return { ok: true, plan: { source, ...shared.plan } };
  }
  if (form.source === "clerk") {
    // A clerk plan carries no `source` key: the harness reads `clerk` + `sample` as a backtest.
    const clerk = form.clerk.trim();
    if (clerk === "") return { ok: false, why: "Choose the clerk whose person tickets to replay." };
    if (!Number.isInteger(form.cap) || form.cap < 1 || form.cap > MAX_CLERK_CAP) return { ok: false, why: `The ticket cap is a whole number from 1 to ${MAX_CLERK_CAP}.` };
    const since = form.since.trim();
    if (since !== "" && !isDate(since)) return { ok: false, why: "Since is a date (YYYY-MM-DD); leave it empty for no lower bound." };
    // The harness clones a clerk run's trials from a local checkout of each
    // app repo the sample draws from, and refuses the plan without one.
    const sources: Record<string, string> = {};
    for (const repo of clerkRepos) {
      const path = (form.checkouts[repo] ?? "").trim();
      if (!path.startsWith("/")) return { ok: false, why: `Name an absolute path to a checkout of ${repo} on the machine.` };
      sources[repo] = path;
    }
    const shared = sharedPlan(form);
    if (!shared.ok) return shared;
    return { ok: true, plan: { clerk, sample: { cap: form.cap, ...(since === "" ? {} : { since: `${since}T00:00:00Z` }) }, ...(clerkRepos.length === 0 ? {} : { sources }), ...shared.plan } };
  }
  const prs = parsePrs(form.prs);
  if (prs === null) return { ok: false, why: "Name the merged PR numbers to replay, e.g. 2731 or 2731, 2740." };
  if (prs.length > 10) return { ok: false, why: "At most 10 PRs: one ticket's work." };
  const ticket = form.ticket.trim();
  if (ticket !== "" && !/^(?:#\d+|[A-Z][A-Z0-9_]*-\d+)$/.test(ticket)) return { ok: false, why: "The ticket is #<number> on GitHub or a key such as OA-12; leave it empty to use the issue the PR closes." };
  const shared = sharedPlan(form);
  if (!shared.ok) return shared;
  const repo = form.repo.trim();
  if (repo !== "" && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, why: "The repo is owner/name; leave it empty for the project's." };
  return {
    ok: true,
    plan: {
      source: { kind: "pr", prs, ...(ticket === "" ? {} : { ticket }), ...(repo === "" ? {} : { repo }) },
      ...shared.plan,
    },
  };
}

/** A real calendar date in `YYYY-MM-DD`, so `2026-02-30` is refused rather than sent. */
function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** The arms, repeats, caps and judge panel every plan carries, whatever its source. */
function sharedPlan(form: RunForm): { ok: true; plan: Record<string, unknown> } | { ok: false; why: string } {
  if (form.arms.length < 1) return { ok: false, why: "Add at least one arm." };
  if (form.arms.length > MAX_ARMS) return { ok: false, why: `At most ${MAX_ARMS} arms.` };
  const names = new Set<string>();
  for (const arm of form.arms) {
    if (!KEBAB.test(arm.name) || arm.name === "a") return { ok: false, why: `Arm "${arm.name}": a name in lowercase-kebab-case, not "a" (the reference's).` };
    if (names.has(arm.name)) return { ok: false, why: `Two arms are named ${arm.name}.` };
    names.add(arm.name);
    if (arm.overlay.trim() !== "" && !arm.overlay.trim().startsWith("/")) return { ok: false, why: `Arm ${arm.name}: the overlay is an absolute path to a directory of prompt files.` };
  }
  if (form.judges.length === 0) return { ok: false, why: "Add at least one judge." };
  const judges = new Set<string>();
  for (const judge of form.judges) {
    if (judge.model.trim() === "") return { ok: false, why: "Every judge names a model." };
    const name = judge.name.trim() || judge.model.trim();
    if (judges.has(name)) return { ok: false, why: `Two judges are named ${name}; name one.` };
    judges.add(name);
  }
  return {
    ok: true,
    plan: {
      arms: form.arms.map((arm) => ({ name: arm.name, lineup: arm.lineup, ...(arm.overlay.trim() === "" ? {} : { overlay: arm.overlay.trim() }) })),
      repeats: form.repeats,
      caps: { trialMinutes: form.trialMinutes },
      scoring: {
        judge: {
          panel: form.judges.map((judge) => ({ runner: judge.runner, model: judge.model.trim(), ...(judge.name.trim() === "" ? {} : { name: judge.name.trim() }) })),
        },
      },
    },
  };
}

/**
 * What a start will cost, before it is started: one trial per arm and case,
 * and up to `repeats` more each if the arms disagree. A PR plan is one case;
 * a clerk plan is up to `cap` tickets, so its counts are ceilings; a set plan
 * is exactly the cases it selects. Time is the project's median trial when it
 * has run any, else the cap; tokens only from history.
 */
export function estimate(form: RunForm, history: EvalsView["history"] | null, setCases: readonly EvalSetRowView[] = []): { text: string; trials: number; worst: number } {
  const clerk = form.source === "clerk";
  const set = form.source === "set";
  const cases = clerk ? form.cap : set ? selectSetCases(setCases, form).length : 1;
  const arms = form.arms.length;
  const trials = cases * arms;
  const worst = trials * (1 + form.repeats);
  const per = history?.trialSeconds ?? null;
  const hours = (count: number, seconds: number) => `${(count * seconds / 3600).toFixed(count * seconds >= 36_000 ? 0 : 1)} h`;
  const time = per === null
    ? `up to ${hours(trials, form.trialMinutes * 60)} (${hours(worst, form.trialMinutes * 60)} with repeats) at the ${form.trialMinutes}-minute cap`
    : `about ${hours(trials, per)} (${hours(worst, per)} with repeats), from this project's median trial`;
  const tokens = history?.trialTokens == null ? "" : `; about ${Math.round(trials * history.trialTokens / 1000).toLocaleString("en-US")}k tokens`;
  const judges = form.judges.length * cases;
  // The sample may hold fewer tickets than the cap, so a clerk's counts are "up to".
  const count = clerk
    ? `up to ${trials} trial${trials === 1 ? "" : "s"} (${cases} ticket${cases === 1 ? "" : "s"} × ${arms} arm${arms === 1 ? "" : "s"})`
    : set
    ? `${trials} trial${trials === 1 ? "" : "s"} (${cases} case${cases === 1 ? "" : "s"} × ${arms} arm${arms === 1 ? "" : "s"})`
    : `${trials} trial${trials === 1 ? "" : "s"}`;
  return {
    trials,
    worst,
    text: `${count}, up to ${worst} if the arms disagree: ${time}${tokens}. Then ${judges} judge call${judges === 1 ? "" : "s"} and one analyst call. Trials wait for the live loops' host lease and a Claude window under the usage guard.`,
  };
}

export const durationLabel = (seconds: number | null): string => {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const costLabel = (usd: number | null, partial = false): string =>
  usd === null ? "unknown" : `${partial ? "≥ " : ""}$${usd.toFixed(2)}`;

export const tokensLabel = (tokens: number | null): string =>
  tokens === null ? "—" : tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;

/**
 * What an inbox entry (#872) would use if started: its worst-case trials at
 * this project's median trial, tokens and time, as `estimate` reckons a form.
 * A set plan's trials are only known at start, and a project with no run yet
 * has no median to multiply.
 */
export function inboxCost(trials: number | null, history: EvalsView["history"] | null): string {
  if (trials === null) return "trials picked from the test set at start";
  const count = `up to ${trials} trial${trials === 1 ? "" : "s"}`;
  const parts = [
    history?.trialTokens == null ? null : `about ${tokensLabel(trials * history.trialTokens)} tokens`,
    history?.trialSeconds == null ? null : `about ${durationLabel(trials * history.trialSeconds)}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? `${count}; no run yet to estimate usage from` : `${count}: ${parts.join(", ")}, from this project's median trial`;
}

/** `a` is the merged PR; every other arm by its own name. */
export const armLabel = (arm: string, run: Pick<EvalCaseView, "reference">): string =>
  arm !== "a" ? arm : run.reference === "loop" ? "reference (loop)" : run.reference === "mixed" ? "reference" : "reference (person)";

/** A run's one-line source: `acme/app #12, #13`, the clerk it sampled, or the test set's version. */
export function sourceLabel(run: EvalRunView): string {
  if (run.source.kind === "clerk") return `clerk ${run.source.clerk}'s person tickets`;
  if (run.source.kind === "set") return `Test set ${setShortVersion(run.source.version)}`;
  return `${run.source.repo} ${run.source.prs.map((pr) => `#${pr}`).join(", ")}`;
}

/** A model with its runner named only when it is not the default one: `claude-opus-5-5`, `codex gpt-5.5`. */
const modelWithRunner = (runner: string, model: string): string => (runner === "claude" ? model : `${runner} ${model}`);

/** An arm's recorded resolution by own key: `constructor` is a valid arm name and must not read the prototype's. */
export function armResolutionFor(run: Pick<EvalRunView, "resolved">, arm: string): EvalArmResolutionView | undefined {
  const arms = run.resolved?.arms;
  return arms !== undefined && Object.hasOwn(arms, arm) ? arms[arm] : undefined;
}

/** An arm's resolved models on one line (#816): `coder claude-opus-5-5 (high) · executor codex gpt-5.5 · overlay 3f2a1b9c`. */
export function modelsLabel(resolution: EvalArmResolutionView | undefined): string | null {
  if (resolution === undefined) return null;
  const parts = resolution.stages.map((stage) => `${stage.stage} ${modelWithRunner(stage.runner, stage.model)}${stage.effort === null ? "" : ` (${stage.effort})`}`);
  if (resolution.overlayHash !== null) parts.push(`overlay ${resolution.overlayHash.slice(0, 8)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The run's panel and seed (#816): `Panel opus (claude-opus-5-5), gpt (codex gpt-5.5) · seed s-1`; null when it has neither. */
export function runConfigLabel(run: Pick<EvalRunView, "panel" | "resolved">): string | null {
  const parts: string[] = [];
  if (run.panel.length > 0) parts.push(`Panel ${run.panel.map((judge) => `${judge.name} (${modelWithRunner(judge.runner, judge.model)})`).join(", ")}`);
  const seed = run.resolved?.seed ?? null;
  if (seed !== null) parts.push(`seed ${seed}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

export type RunStatus = { label: string; tone: "live" | "ok" | "warn" | "muted" };

export function runStatus(run: EvalRunView): RunStatus {
  if (run.running) return { label: run.cases.length === 0 ? "Starting" : "Running", tone: "live" };
  if (run.problem !== null) return { label: "Stopped", tone: "warn" };
  if (run.finishedAt === null) return { label: "Stopped, resumable", tone: "warn" };
  if (run.stoppedBy === "batch-cap") return { label: "Hit the batch cap", tone: "warn" };
  return { label: "Finished", tone: "ok" };
}

/** Whether an arm's score on an axis is one the judge families contested. */
export const contestedFor = (entry: EvalCaseView, arm: string, axis: EvalAxis): boolean =>
  entry.contested.some((contested) => contested.axis === axis && contested.arms.includes(arm));

/** The panel's ranking as text, best first: `opus > reference = sonnet`. */
export function rankingLabel(entry: EvalCaseView): string | null {
  if (entry.ranking === null) return null;
  return entry.ranking.map((tier) => tier.map((arm) => armLabel(arm, entry)).join(" = ")).join(" > ");
}

const decimal = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/**
 * An arm's axis over its repeated trials (#821): `3.7 (3–4)`, the mean then its
 * range; the value alone with no spread. Undefined is a snapshot from a host
 * that predates #821 (the remote page can be newer than the bridge): a dash.
 */
export function spreadLabel(spread: EvalAxisSpreadView | null | undefined): string {
  if (spread == null) return "—";
  return spread.min === spread.max ? decimal(spread.mean) : `${decimal(spread.mean)} (${decimal(spread.min)}–${decimal(spread.max)})`;
}

/*
 * A test-set run's two scores (#855) are labelled apart and drawn in separate
 * cells: nothing here adds, averages or otherwise combines the objective
 * result with the judge score. Undefined is a snapshot from a host that
 * predates #855, read as absent.
 */

/** Whether the run's totals carry either score, so the page adds the Objective and Judge score columns. */
export const runHasGrades = (run: Pick<EvalRunView, "totals">): boolean =>
  run.totals.some((total) => total.objective != null || total.judge != null);

/** Whether the case carries a grade, so its arm table adds the Objective and Judge score columns. */
export const caseHasGrade = (entry: Pick<EvalCaseView, "grade">): boolean => entry.grade != null;

/** An arm's objective tally: `1/1`, `0/1 · 1 check pending`, or a dash with nothing graded or pending. */
export function objectiveTotalLabel(objective: EvalArmTotalView["objective"] | undefined): string {
  if (objective == null) return "—";
  const parts = [
    ...(objective.graded > 0 ? [`${objective.passed}/${objective.graded}`] : []),
    ...(objective.pending > 0 ? [`${objective.pending} ${objective.pending === 1 ? "check" : "checks"} pending`] : []),
  ];
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/** An arm's mean judge score and the cases it is over: `4.11 over 4 cases`; a dash with none. */
export function judgeTotalLabel(judge: EvalArmTotalView["judge"] | undefined): string {
  if (judge == null || judge.mean === null) return "—";
  return `${judge.mean.toFixed(2)} over ${judge.cases} ${judge.cases === 1 ? "case" : "cases"}`;
}

/** The case's grader as a small label: `tests`, `check`, `judge-only`, `judge-only · no evidence` (or `check · no evidence`); null with none. */
export function graderLabel(grade: EvalCaseView["grade"] | undefined): string | null {
  if (grade == null) return null;
  return grade.noEvidence ? `${grade.grader} · no evidence` : grade.grader;
}

/** One arm's objective result on a case, or a dash where it has none. */
export const objectiveLabel = (objective: EvalCaseArmView["objective"] | undefined): string => objective ?? "—";

/** One arm's judge score on a case to 2 decimals, as report.md prints it, or a dash where none scored it. */
export const judgeScoreLabel = (judge: EvalCaseArmView["judge"] | undefined): string => (judge == null ? "—" : judge.toFixed(2));

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** The first trial's verdict for a repeated arm (#821): its outcome and where the panel ranked it, `green-pr, tied 1st of 3`. */
export function firstTrialLabel(entry: Pick<EvalRepeatView, "first">): string {
  // Absent from a snapshot pushed before #821, as `spreadLabel` reads.
  const first = (entry.first as EvalRepeatView["first"] | undefined) ?? { outcome: null, rank: null };
  const rank = first.rank;
  return `${first.outcome ?? "—"}, ${rank === null ? "not judged" : `${rank.tied ? "tied " : ""}${ordinal(rank.position)} of ${rank.of}`}`;
}

/** One arm on the quality-vs-cost plot (#826). */
export interface QualityCostPoint {
  arm: string;
  /** The panel's mean score (1–5) over every judge, axis and case; null when no judge scored the arm. */
  quality: number | null;
  /** `quality` as a 0..1 fraction of the scale: (score - 1) / 4. */
  y: number | null;
  /** The held-out pass rate, 0..1; null when the arm has none. */
  heldOut: number | null;
  /** The held-out rate on the plot's 0..1 quality axis: equal to `heldOut`, named beside `y` so the drawing reads both marks alike. */
  heldOutY: number | null;
  heldOutLabel: string | null;
  /** In the plot's unit; null is UNKNOWN, never zero. */
  cost: number | null;
  costPartial: boolean;
  costLabel: string;
}

export interface QualityCostPlot {
  unit: "usd" | "tokens";
  xMax: number;
  /** False when no arm has a cost: the axis then has no scale worth ticking. */
  anyKnownCost: boolean;
  anyUnknownCost: boolean;
  points: QualityCostPoint[];
}

/** `"3/4"` → 0.75; null when absent, unparsable or out of nothing. */
function heldOutRate(heldOut: string | null): number | null {
  const match = heldOut === null ? null : /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(heldOut);
  if (match === null) return null;
  const pass = Number(match[1]);
  const total = Number(match[2]);
  return total === 0 || pass > total ? null : pass / total;
}

/**
 * Each arm of a finished run with quality against cost (#826). It reads only `run.totals` and
 * the per-case panel scores, so the plot shows the same numbers the tables do; an arm whose cost
 * is unknown keeps a null cost, because placing it at zero would draw it as the cheapest arm.
 */
export function qualityCostPlot(run: EvalRunView): QualityCostPlot | null {
  if (run.running || run.totals.length < 2) return null;
  const withCost = run.totals.filter((total) => total.costUsd !== null || total.tokens !== null);
  // Dollars only when every arm with a figure has dollars: mixing units on one axis would misplace arms.
  const unit = withCost.length > 0 && withCost.every((total) => total.costUsd !== null) ? "usd" : "tokens";
  const points = run.totals.map((total): QualityCostPoint => {
    const scores: number[] = [];
    for (const entry of run.cases) {
      for (const arm of entry.arms) {
        if (arm.arm !== total.arm) continue;
        for (const judge of arm.axes) {
          for (const score of Object.values(judge.scores)) if (score !== null) scores.push(score);
        }
      }
    }
    const quality = scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const heldOut = heldOutRate(total.heldOut);
    const cost = unit === "usd" ? total.costUsd : total.tokens;
    const costPartial = unit === "usd" && cost !== null && total.costPartial;
    return {
      arm: total.arm,
      quality,
      y: quality === null ? null : (quality - 1) / 4,
      heldOut,
      heldOutY: heldOut,
      heldOutLabel: total.heldOut,
      cost,
      costPartial,
      costLabel: cost === null ? "unknown" : unit === "usd" ? costLabel(cost, costPartial) : tokensLabel(cost),
    };
  });
  // A run nobody scored has nothing to plot on the quality axis: an empty frame says less than the tables.
  if (points.every((point) => point.y === null && point.heldOutY === null)) return null;
  const known = points.flatMap((point) => (point.cost === null ? [] : [point.cost]));
  const max = known.length === 0 ? 0 : Math.max(...known);
  return { unit, xMax: max > 0 ? max : 1, anyKnownCost: known.length > 0, anyUnknownCost: known.length < points.length, points };
}

/**
 * Whether a trial's Patch link opens: a patch is the project's code, so the
 * local page always opens it and the remote page only when the project set
 * `relayEvalPatches` and the bridge relays the patches to the hosted store.
 */
export const patchOpens = (remote: boolean, relayPatches: boolean): boolean => !remote || relayPatches;

// The Test set screen (#856).

/** `a, b ,, a` → ["a", "b"]: the tags a comma-separated field names, once each. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export interface CaseAddForm { repo: string; prs: string; reason: string; tags: string; notes: string }

/** The repo a new case opens on: the first one the set already holds, so a one-repo project types none. */
export const defaultCaseRepo = (view: Pick<EvalSetView, "cases"> | null): string => view?.cases[0]?.repo ?? "";

const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The add command's body, or the first thing wrong with the form. Whether the
 * PRs are merged and make a new case is `evals-set.ts add`'s answer, shown as
 * its refusal.
 */
export function buildCaseAdd(form: CaseAddForm): { ok: true; body: { repo: string; prs: number[]; reason: string; tags?: string[]; notes?: string } } | { ok: false; why: string } {
  const repo = form.repo.trim();
  if (!REPO_SHAPE.test(repo)) return { ok: false, why: "The repository is owner/name." };
  const prs = parsePrs(form.prs);
  if (prs === null) return { ok: false, why: "Name the merged PR numbers, e.g. 2731 or 2731, 2740." };
  const reason = form.reason.trim();
  if (reason === "") return { ok: false, why: "Say why this case belongs in the set." };
  const tags = parseTags(form.tags);
  const notes = form.notes.trim();
  return { ok: true, body: { repo, prs, reason, ...(tags.length === 0 ? {} : { tags }), ...(notes === "" ? {} : { notes }) } };
}

export interface CaseEditForm { tags: string; notes: string }

/** The edit form as it opens on a case: its tags as comma text and its notes, blank when unknown. */
export const caseEditForm = (current: { tags: string[]; notes?: string }): CaseEditForm => ({ tags: current.tags.join(", "), notes: current.notes ?? "" });

/**
 * The edit command's body: only the fields that changed. When the page does
 * not know the notes (a remote summary-only project), a blank notes field
 * means "leave them", so it is sent only when the operator typed something.
 */
export function buildCaseEdit(
  current: { id: string; tags: string[]; notes?: string },
  form: CaseEditForm,
  notesKnown: boolean,
): { ok: true; body: { case: string; tags?: string[]; notes?: string } } | { ok: false; why: "nothing changed" } {
  const tags = parseTags(form.tags);
  const tagsChanged = tags.join("\n") !== current.tags.join("\n");
  const notes = form.notes.trim();
  const notesChanged = notesKnown ? notes !== (current.notes ?? "").trim() : notes !== "";
  if (!tagsChanged && !notesChanged) return { ok: false, why: "nothing changed" };
  return { ok: true, body: { case: current.id, ...(tagsChanged ? { tags } : {}), ...(notesChanged ? { notes } : {}) } };
}

/** The attach-check form: a test file in the case's repo, or a shell command. */
export interface CaseCheckForm { kind: "test" | "command"; value: string }

/**
 * The attach-check command's body. It mirrors the server's rules (a relative
 * test path with no `..` segment, nothing starting with `--`) so the button
 * explains a refusal before a round trip that runs nothing.
 */
export function buildCaseCheck(
  id: string,
  form: CaseCheckForm,
): { ok: true; body: { case: string; test: string } | { case: string; command: string } } | { ok: false; why: string } {
  const value = form.value.trim();
  if (value === "") return { ok: false, why: form.kind === "test" ? "Name a test file." : "Name a command." };
  if (value.startsWith("--")) return { ok: false, why: form.kind === "test" ? "The test path may not start with --." : "The command may not start with --." };
  if (form.kind === "command") return { ok: true, body: { case: id, command: value } };
  if (value.startsWith("/")) return { ok: false, why: "The test path must be relative to the case's repository, not absolute." };
  if (value.split(/[\\/]/).includes("..")) return { ok: false, why: "The test path may not leave the case's repository with a .. segment." };
  return { ok: true, body: { case: id, test: value } };
}

/** `acme/app#12, #13`: the case's repository and PRs. */
export const caseLabel = (row: Pick<EvalSetRowView, "repo" | "prs">): string => `${row.repo}${row.prs.map((pr) => `#${pr}`).join(", ")}`;

/** The run that last sampled the case, and its day; "never" before any. */
export const lastRunLabel = (row: Pick<EvalSetRowView, "lastRun">): string =>
  row.lastRun === null ? "never" : `${row.lastRun.run} · ${row.lastRun.startedAt.slice(0, 10)}`;

/**
 * Why a case is suggested for retirement (#860): every arm passed it in its
 * last `window` set runs, so it no longer tells arms apart. Null when it is
 * not saturated, or already retired (nothing left to suggest).
 */
export function saturationNote(row: Pick<EvalSetRowView, "status"> & { saturation?: EvalSetRowView["saturation"] }): string | null {
  // A remote snapshot pushed by a dashboard older than #860 has no field at all: no flag, never a throw.
  if (row.status === "retired" || !row.saturation?.saturated) return null;
  const { window } = row.saturation;
  const runs = `${window} set run${window === 1 ? "" : "s"}`;
  return `Saturated: every arm passed it in its last ${runs}, so it no longer tells arms apart. Retire it, or keep it to clear this until ${window} more run${window === 1 ? "" : "s"}.`;
}

/** The header's set version: the commit's short sha, or that nothing is committed yet. */
export const setVersionLabel = (view: Pick<EvalSetView, "version">): string =>
  view.version === null ? "No case committed yet" : `Set version ${view.version.slice(0, 7)}`;

// The Suggestions screen (#858).

/** The longest reason the add form drafts: enough for every reason a ranker gives, short enough to edit. */
export const SUGGESTION_REASON_MAX = 280;

/**
 * The add form a suggestion opens: its repository and PR, and a reason drafted
 * from why it ranks, which the operator edits before committing it.
 */
export function suggestionAddForm(suggestion: Pick<EvalSuggestionView, "repo" | "pr" | "reasons">): Partial<CaseAddForm> {
  const drafted = suggestion.reasons.map((reason) => reason.text.trim()).filter(Boolean).join("; ");
  const reason = drafted.length <= SUGGESTION_REASON_MAX ? drafted : `${drafted.slice(0, SUGGESTION_REASON_MAX - 1).trimEnd()}…`;
  return { repo: suggestion.repo, prs: String(suggestion.pr), reason };
}

/** Which signals were not read and why, so a thin ranking says why it is thin; null when every source was read. */
export function missingLine(missing: EvalSuggestionsView["missing"]): string | null {
  if (missing.length === 0) return null;
  return `Not read: ${missing.map((entry) => `${entry.source} — ${entry.why}`).join("; ")}`;
}

/** `acme/app#2731`: the suggestion's PR. */
export const suggestionLabel = (suggestion: Pick<EvalSuggestionView, "repo" | "pr">): string => `${suggestion.repo}#${suggestion.pr}`;

/** The bounds of a noise-floor run's identical arms: a spread needs two, and a run holds at most `MAX_ARMS`. */
export const MIN_NOISE_FLOOR_ARMS = 2;

/**
 * No floor, as a page with no read shows it. 0.2 restates eval-noise-floor.ts's
 * DEFAULT_STALE_SHARE: the dashboard cannot import harness code.
 */
export const NO_NOISE_FLOOR: EvalNoiseStatusView = { state: "missing", floor: null, drift: null, staleShare: 0.2 };

/** The arm count the Measure noise floor card opens with: the project's `noiseFloorArms`, else 3 before the view is in. */
export const defaultNoiseFloorArms = (view: Pick<EvalsView, "defaults"> | null): number => view?.defaults?.noiseFloorArms ?? 3;

/**
 * The form a noise-floor run is: every active case of the set, `n`
 * identical arms on the live lineup with no overlay, and no repeats, since
 * the identical arms disagreeing is the measurement. Its panel and cap are
 * the view's defaults, so `estimate` counts it as the Run card would.
 */
export function noiseFloorForm(view: EvalsView | null, n: number): RunForm {
  const count = Number.isInteger(n) && n > 0 ? n : 0;
  return {
    ...defaultForm(view),
    source: "set",
    arms: Array.from({ length: count }, (_, i) => ({ name: `live-${i + 1}`, lineup: "live", overlay: "" })),
    repeats: 0,
    setMode: "all",
    setTags: [],
    setCases: [],
  };
}

/**
 * The plan Measure noise floor sends, or why not: the whole-set plan
 * `buildPlan` makes of `noiseFloorForm`, stamped with when the floor is
 * measured (passed in so it is testable). An `n` outside 2..MAX_ARMS is
 * refused here, as the harness would refuse it.
 */
export function noiseFloorPlan(view: EvalsView | null, set: EvalSetView | null, n: number, measuredAt: string): { ok: true; plan: Record<string, unknown> } | { ok: false; why: string } {
  if (!Number.isInteger(n) || n < MIN_NOISE_FLOOR_ARMS || n > MAX_ARMS) return { ok: false, why: `A noise floor runs ${MIN_NOISE_FLOOR_ARMS} to ${MAX_ARMS} identical arms.` };
  const built = buildPlan(noiseFloorForm(view, n), [], set);
  if (!built.ok) return built;
  return { ok: true, plan: { ...built.plan, noiseFloor: { measuredAt } } };
}

/** A spread as ±x, two decimals; "—" when there was nothing to compare. */
const plusMinus = (value: number | null): string => (value === null ? "—" : `±${value.toFixed(2)}`);

/** A floor's spread on both axes, objective and judge apart. */
export const noiseSpreadLabel = (spread: EvalNoiseSpreadView): string => `objective ${plusMinus(spread.objective)}, judge ${plusMinus(spread.judge)}`;

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** Whether the set's latest noise floor still describes it, in a sentence (the Test set card and a run's noise line). */
export function noiseStatusLabel(status: EvalNoiseStatusView | undefined, forRun = false): string {
  // Undefined is a snapshot from a host that predates #859, read as no floor.
  if (status == null || status.state === "missing" || status.floor === null) return "Not measured yet: gaps between arms are not judged";
  if (status.state === "stale") {
    const drift = status.drift ?? { added: 0, retired: 0, share: 0 };
    // A run's drift is counted against the cases it ran, so a slice of the set reads stale too.
    if (forRun) return `Stale for this run: it ran ${drift.added} case(s) the floor never measured and left out ${drift.retired} it did (${percent(drift.share)} of its cases, over ${percent(status.staleShare)})`;
    return `Stale: ${drift.added} added, ${drift.retired} retired since it was measured (${percent(drift.share)} of its cases, over ${percent(status.staleShare)})`;
  }
  return `Measured ${status.floor.measuredAt.slice(0, 10)} on ${setShortVersion(status.floor.version)}: ${noiseSpreadLabel(status.floor.spread)}`;
}

/**
 * One axis of an arm's gap against the floor: the signed gap and its
 * verdict. A stale or missing floor never says "beyond"; no gap is "—".
 */
export function gapLabel(axis: EvalAxisGapView): string {
  if (axis.gap === null) return "—";
  const gap = `${axis.gap > 0 ? "+" : ""}${axis.gap.toFixed(2)}`;
  if (axis.verdict === "beyond" || axis.verdict === "within") return `${gap} ${axis.verdict}`;
  if (axis.verdict === "stale") return `${gap} (floor stale)`;
  if (axis.verdict === "no-floor") return `${gap} (no floor)`;
  return gap;
}

/** One arm's gap line: `<arm> vs <vs>: objective … · judge …`. */
export const armGapLabel = (gap: EvalArmGapView): string => `${gap.arm} vs ${gap.vs}: objective ${gapLabel(gap.objective)} · judge ${gapLabel(gap.judge)}`;

/** A goal's guardrail headline (#871): whether the proposal earns a PR for it. */
export const goalVerdictLabel = (goal: EvalGoalVerdictView): string =>
  `${goal.goal === "quality" ? "Quality" : "Cost"} goal: ${goal.pass ? "pass" : "fail"}`;

/** One condition of a goal, with the reason the verdict gives, so a fail names what lost it. */
export const guardrailConditionLabel = (condition: EvalGuardrailConditionView): string =>
  `${condition.pass ? "pass" : "fail"} · ${condition.id}: ${condition.reason}`;

/**
 * A judge-accuracy tally (#877): with no verdicts counted it says so, never
 * "0%" or "100%", which would read as a measured panel.
 */
export function accuracyLabel(tally: EvalAccuracyTallyView): string {
  if (tally.total === 0) return "no calibration yet";
  const share = tally.accuracy ?? tally.agree / tally.total;
  return `${Math.round(share * 100)}% (${tally.agree} of ${tally.total} ${tally.total === 1 ? "verdict" : "verdicts"})`;
}

/** The overall line: with every verdict on a contested axis the panel is calibrated but unscored, never "no calibration yet". */
export const judgeAccuracyHeadline = (accuracy: EvalJudgeAccuracyView): string =>
  accuracy.overall.total === 0 && accuracy.contested > 0 ? "no verdict counted" : accuracyLabel(accuracy.overall);

/** One line per axis the calibration verdicts reached, `<axis>: <label>`; an axis with none is left out. */
export const accuracyAxisLines = (accuracy: EvalJudgeAccuracyView): string[] =>
  EVAL_AXES.filter((axis) => accuracy.axes[axis].total > 0).map((axis) => `${axis}: ${accuracyLabel(accuracy.axes[axis])}`);

/** The verdicts left out because their axis was contested, or null when none were. */
export const contestedExcludedLabel = (contested: number): string | null =>
  contested > 0 ? `${contested} ${contested === 1 ? "verdict" : "verdicts"} on contested axes excluded` : null;

/** What a noise-floor run's card says of its floor: the spread it stored, still running, or stopped short. */
export function floorRunLabel(floor: NonNullable<EvalRunView["noiseFloor"]>, running: boolean): string {
  if (floor.stored && floor.spread !== null) return noiseSpreadLabel(floor.spread);
  if (running) return "running";
  return "no floor stored: the run stopped before the end or was not scored (a rescore of a finished run stores it)";
}

/**
 * The test-set case a Results case's calibration verdict lands on (#876). A
 * set run's case key is the set's id; any other run's case is the set row of
 * the same repo (GitHub names are case-insensitive) and the same PRs in any
 * order. Null when the set holds no such case: the verdict has nowhere to go.
 */
export function calibrationCaseId(
  run: Pick<EvalRunView, "source">,
  entry: Pick<EvalCaseView, "key" | "repo" | "prs">,
  rows: readonly Pick<EvalSetRowView, "id" | "repo" | "prs">[],
): string | null {
  if (run.source.kind === "set") return entry.key;
  const repo = entry.repo.toLowerCase();
  const prs = [...entry.prs].sort((x, y) => x - y).join(",");
  const match = rows.find((row) => row.repo.toLowerCase() === repo && [...row.prs].sort((x, y) => x - y).join(",") === prs);
  return match?.id ?? null;
}

/** The "I disagree" form (#876): which two arms, on which axis, which was better and why. */
export interface CalibrationForm { axis: EvalAxis; armA: string; armB: string; preferred: string; reason: string }

/**
 * The form a case opens on: its first contested axis and pair, where the
 * panel disagreed and a verdict matters most; else the first axis and the
 * first two arms. The preferred arm starts on the first of the pair.
 */
export function calibrationDefaults(entry: Pick<EvalCaseView, "arms" | "contested">): CalibrationForm {
  const arms = entry.arms.map((arm) => arm.arm);
  const contested = entry.contested.find((item) => item.arms.length >= 1);
  // Under the spread rule a contested entry names one arm: pair it with the
  // first other arm the case ran, so the form still opens on the contested axis.
  const named = contested === undefined ? [] : [...new Set(contested.arms)];
  const pair = [...named, ...arms.filter((arm) => !named.includes(arm))].slice(0, 2);
  const first = pair[0] ?? "";
  return { axis: contested?.axis ?? EVAL_AXES[0], armA: first, armB: pair[1] ?? "", preferred: first, reason: "" };
}

/** The calibrate command's body, or why the form is not ready to send. */
export function calibrationBody(caseId: string, form: CalibrationForm):
  { ok: true; body: { case: string; arms: [string, string]; axis: EvalAxis; preferred: string; reason: string } } | { ok: false; why: string } {
  if (form.armA === "" || form.armB === "") return { ok: false, why: "Pick the two arms you compared." };
  if (form.armA === form.armB) return { ok: false, why: "Compare two different arms." };
  if (form.preferred !== form.armA && form.preferred !== form.armB) return { ok: false, why: "Pick which of the two arms was better." };
  const reason = form.reason.trim();
  if (reason === "") return { ok: false, why: "Say why that arm was better." };
  return { ok: true, body: { case: caseId, arms: [form.armA, form.armB], axis: form.axis, preferred: form.preferred, reason } };
}

/** A row's verdict count, "2 verdicts"; null at none, so nothing is drawn. */
export const calibrationCountLabel = (count: number): string | null =>
  count <= 0 ? null : `${count} verdict${count === 1 ? "" : "s"}`;

/** One verdict in words: the preferred arm over the other. */
export const calibrationVerdictLabel = (verdict: Pick<EvalCalibrationVerdictView, "arms" | "preferred">): string => {
  const other = verdict.arms[0] === verdict.preferred ? verdict.arms[1] : verdict.arms[0];
  return `${verdict.preferred} over ${other}`;
};

/** How a proposal's status badge reads: an outcome colours it, a step on the way stays neutral. */
export type ProposalTone = "good" | "bad" | "neutral";

const PROPOSAL_STATUS: Record<EvalProposalStatus, { label: string; tone: ProposalTone }> = {
  // A fresh proposal has only its recommended subset run, which waits in the Inbox for a Start click.
  proposed: { label: "Subset run waiting in the Inbox", tone: "neutral" },
  "subset-run": { label: "Subset run", tone: "neutral" },
  "full-run": { label: "Full-set run", tone: "neutral" },
  passed: { label: "Passed", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

/** A proposal's status badge (#874): its short label and whether it is an outcome. */
export const proposalStatus = (status: EvalProposalStatus): { label: string; tone: ProposalTone } => PROPOSAL_STATUS[status];

/** Whether a proposal's row offers Open PR (#875): only a passed verdict earns a PR, so a failed or unsettled one has no action. */
export const proposalOpensPr = (status: EvalProposalStatus): boolean => status === "passed";

/** What the proposal aims at and what it changes, as the row's headline. */
export const proposalLabel = (row: Pick<EvalProposalRowView, "goal" | "kind">): string =>
  `${row.goal === "quality" ? "Quality" : "Cost"} · ${row.kind === "lineup" ? "Lineup" : "Prompt overlay"}`;

/**
 * The verdict that settled a proposal, compactly: a headline plus one line per
 * condition with its reason, so a fail names what lost it. Null until a run settled it.
 */
export function proposalVerdictSummary(verdict: EvalProposalRowView["verdict"]): { headline: string; conditions: { pass: boolean; label: string }[] } | null {
  if (verdict === null) return null;
  const failed = verdict.conditions.filter((condition) => !condition.pass).length;
  const headline = verdict.pass
    ? `pass · ${verdict.conditions.length} condition${verdict.conditions.length === 1 ? "" : "s"}`
    : `fail · ${failed} of ${verdict.conditions.length} condition${verdict.conditions.length === 1 ? "" : "s"} failed`;
  return { headline, conditions: verdict.conditions.map((condition) => ({ pass: condition.pass, label: guardrailConditionLabel(condition) })) };
}
