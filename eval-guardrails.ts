/**
 * The guardrail verdict of a test-set run (#871): whether a proposal arm
 * earns a PR against the baseline arm running the live setup, for each goal
 * a proposal can have, with one reason per condition.
 *
 * A quality proposal must lift the objective score beyond the noise floor
 * without losing a case, lowering the judges' score or costing much more. A
 * cost proposal must cut tokens without losing a case, lowering the objective
 * score or letting the judges' score fall past the floor. The objective and
 * judge scores stay separate here as in eval-grade.ts: each condition reads
 * one of them, never a blend.
 *
 * A condition that needs the noise floor fails while the floor is missing or
 * stale: a gap nobody can tell from noise must never earn a PR.
 *
 * Pure: nothing is read, written or spawned, and odd input degrades to a
 * failing condition, never a throw.
 */
import { armList, type ArmConfig } from "./backtest";
import type { BacktestReport, TrialRow } from "./backtest-report";
import { gradeRun, round2, type CaseArmGrade, type RunGrades } from "./eval-grade";
import { EPSILON, type NoiseStatus } from "./eval-noise-floor";

export type GuardrailGoal = "quality" | "cost";
/** Quality goal: the proposal may cost at most this share more than the baseline. */
export const DEFAULT_MAX_COST_RISE = 0.15;
/** Cost goal: the proposal must spend at least this share fewer tokens than the baseline. */
export const DEFAULT_MIN_TOKEN_CUT = 0.10;

export interface GuardrailThresholds { maxCostRise: number; minTokenCut: number }

/**
 * The conditions that read the noise floor. A subset run (#874) skips them
 * when it judges a proposal's promise: the floor is measured on the full set,
 * so a gap on a few cases says nothing against it.
 */
export const NOISE_FLOOR_CONDITIONS: ReadonlySet<string> = new Set(["objective-up", "judge-within-floor"]);

/** The project's `evalsGuardrails` with the defaults filled. */
export function guardrailSettings(config: { evalsGuardrails?: { maxCostRise?: number; minTokenCut?: number } }): GuardrailThresholds {
  return {
    maxCostRise: config.evalsGuardrails?.maxCostRise ?? DEFAULT_MAX_COST_RISE,
    minTokenCut: config.evalsGuardrails?.minTokenCut ?? DEFAULT_MIN_TOKEN_CUT,
  };
}

export interface GuardrailCondition { id: string; pass: boolean; reason: string }
export interface GoalVerdict { goal: GuardrailGoal; pass: boolean; conditions: GuardrailCondition[] }
export interface GuardrailVerdict { baseline: string; proposal: string; goals: GoalVerdict[] }
export interface BaselinePair { baseline: string; proposal: string }

const isLive = (arm: ArmConfig): boolean => arm.lineup === "live" && arm.overlay === null;

/**
 * Which agent arm is the baseline: in a set run with exactly two agent arms
 * (arm "a" is the human reference, never an agent arm), the one running the
 * live setup (lineup "live", overlay null) when exactly one does; the other
 * is the proposal. Null otherwise: with two live arms or none there is no
 * telling which side a gap favours.
 */
export function baselinePair(arms: readonly ArmConfig[]): BaselinePair | null {
  const agents = arms.filter((arm) => arm.name !== "a");
  if (agents.length !== 2) return null;
  const live = agents.filter(isLive);
  if (live.length !== 1) return null;
  const baseline = live[0]!;
  const proposal = agents.find((arm) => arm !== baseline)!;
  return { baseline: baseline.name, proposal: proposal.name };
}

const signed = (value: number): string => (value > 0 ? `+${value}` : `${value}`);
const percent = (share: number): string => `${signed(round2(share * 100))}%`;

/** Why a floor-bound condition cannot pass; null when the floor vouches for the axis. */
function floorProblem(status: NoiseStatus, axis: "objective" | "judge"): string | null {
  if (status.state === "missing") return "no noise floor measured — remeasure the noise floor";
  if (status.state === "stale") return "noise floor stale — remeasure the noise floor";
  if ((status.floor?.spread[axis] ?? null) === null) return `noise floor has no ${axis} spread — remeasure the noise floor`;
  return null;
}

/** The first trials that ran: repeats do not change the verdict, and a trial that never ran spent nothing. */
function ranFirst(rows: readonly TrialRow[], arm: string): TrialRow[] {
  return rows.filter((row) => row.arm === arm && row.repeat === undefined && row.outcome !== "not-run");
}

/**
 * Each arm's first trials on the cases BOTH arms ran. Spend is compared on
 * the same cases only: a proposal whose trial never ran a case would
 * otherwise look cheaper for the work it skipped.
 */
function pairedTrials(rows: readonly TrialRow[], pair: BaselinePair): { base: TrialRow[]; prop: TrialRow[] } {
  const base = ranFirst(rows, pair.baseline);
  const prop = ranFirst(rows, pair.proposal);
  const both = new Set(base.map((row) => row.ticket).filter((ticket) => prop.some((row) => row.ticket === ticket)));
  return { base: base.filter((row) => both.has(row.ticket)), prop: prop.filter((row) => both.has(row.ticket)) };
}

/** Total tokens over the rows; null when any row is unmetered, since a partial sum would flatter that arm. */
function tokenTotal(rows: readonly TrialRow[]): number | null {
  let total = 0;
  for (const row of rows) {
    const t = row.tokens;
    if (t === null || t === undefined) return null;
    total += t.input + t.output + t.cacheRead + t.cacheWrite;
  }
  return total;
}

/**
 * The two arms' cost in one measure: USD when every first trial of both arms
 * reported one, else tokens. Mixing would compare dollars with tokens, so one
 * missing USD on either side drops both to tokens.
 */
function costs(rows: readonly TrialRow[], pair: BaselinePair): { measure: "USD" | "tokens"; baseline: number; proposal: number } | null {
  const { base, prop } = pairedTrials(rows, pair);
  // Only reported USD: an estimate prices cache reads at the full input rate, an
  // upper bound that would inflate whichever side carries it.
  if ([...base, ...prop].every((row) => typeof row.cost?.usd === "number" && row.cost.source === "reported")) {
    const sum = (list: TrialRow[]) => list.reduce((total, row) => total + (row.cost.usd as number), 0);
    return { measure: "USD", baseline: sum(base), proposal: sum(prop) };
  }
  const baseline = tokenTotal(base);
  const proposal = tokenTotal(prop);
  return baseline === null || proposal === null ? null : { measure: "tokens", baseline, proposal };
}


/** Each case's grade for the two arms. */
function casePairs(grades: RunGrades, pair: BaselinePair): { base: CaseArmGrade | undefined; prop: CaseArmGrade | undefined }[] {
  return grades.cases.map((graded) => ({
    base: graded.arms.find((entry) => entry.arm === pair.baseline),
    prop: graded.arms.find((entry) => entry.arm === pair.proposal),
  }));
}

const decided = (grade: CaseArmGrade | undefined): boolean => grade?.objective === "pass" || grade?.objective === "fail";

/**
 * The pass-rate gap over the cases BOTH arms have a pass or fail on, as
 * measureFloor compares its arms: a proposal whose trial never ran a case the
 * baseline failed would otherwise score over fewer cases and look better.
 */
function objectiveGap(grades: RunGrades, pair: BaselinePair): number | null {
  const both = casePairs(grades, pair).filter(({ base, prop }) => decided(base) && decided(prop));
  if (both.length === 0) return null;
  const rate = (side: "base" | "prop") => both.filter((entry) => entry[side]!.objective === "pass").length / both.length;
  return round2(rate("prop") - rate("base"));
}

/** The judge-mean gap over the cases both arms were scored on, for the same reason. */
function judgeGap(grades: RunGrades, pair: BaselinePair): number | null {
  const both = casePairs(grades, pair).filter(({ base, prop }) => typeof base?.judge === "number" && typeof prop?.judge === "number");
  if (both.length === 0) return null;
  const mean = (side: "base" | "prop") => round2(both.reduce((sum, entry) => sum + entry[side]!.judge!, 0) / both.length);
  return round2(mean("prop") - mean("base"));
}

/**
 * Every selected case ran a first trial on both arms. The verdict is about
 * the whole run (#803 judges full-set runs): a run the batch cap stopped
 * after three cases, or a proposal whose trials failed to build, must not
 * pass on the handful of cases that did run.
 */
function allCasesRan(rows: readonly TrialRow[], pair: BaselinePair, selected: readonly string[]): GuardrailCondition {
  const id = "all-cases-ran";
  const ran = (arm: string) => new Set(ranFirst(rows, arm).map((row) => row.ticket));
  const base = ran(pair.baseline);
  const prop = ran(pair.proposal);
  const missing = selected.filter((ticket) => !base.has(ticket) || !prop.has(ticket));
  if (selected.length === 0) return { id, pass: false, reason: "no case selected" };
  return missing.length === 0
    ? { id, pass: true, reason: `all ${selected.length} case(s) ran on both arms` }
    : { id, pass: false, reason: `${missing.length} of ${selected.length} case(s) did not run on both arms: ${missing.join(", ")}` };
}

/** A case the baseline passes and the proposal does not; a fail, a pending check or a trial that never ran all lose it. */
function noRegressions(grades: RunGrades, pair: BaselinePair): GuardrailCondition {
  const lost = grades.cases.filter((graded) => {
    const base = graded.arms.find((entry) => entry.arm === pair.baseline)?.objective ?? null;
    const prop = graded.arms.find((entry) => entry.arm === pair.proposal)?.objective ?? null;
    return base === "pass" && prop !== "pass";
  }).map((graded) => graded.case);
  return lost.length === 0
    ? { id: "no-regressions", pass: true, reason: "no case the baseline passes is lost" }
    : { id: "no-regressions", pass: false, reason: `${lost.length} case(s) the baseline passes are lost: ${lost.join(", ")}` };
}

function objectiveUp(grades: RunGrades, pair: BaselinePair, status: NoiseStatus): GuardrailCondition {
  const id = "objective-up";
  const problem = floorProblem(status, "objective");
  if (problem !== null) return { id, pass: false, reason: problem };
  const gap = objectiveGap(grades, pair);
  if (gap === null) return { id, pass: false, reason: "no objective grades to compare" };
  const spread = status.floor!.spread.objective!;
  // A gap exactly at the floor is "within" it (armGaps' rule): no gain to vouch for.
  const beyond = gap > 0 && gap > spread + EPSILON;
  return {
    id, pass: beyond,
    reason: beyond
      ? `objective score ${signed(gap)}, beyond the noise floor ${spread}`
      : `objective score ${signed(gap)}, not beyond the noise floor ${spread}`,
  };
}

function objectiveNotDown(grades: RunGrades, pair: BaselinePair): GuardrailCondition {
  const id = "objective-not-down";
  const gap = objectiveGap(grades, pair);
  if (gap === null) return { id, pass: false, reason: "no objective grades to compare" };
  const pass = gap >= -EPSILON;
  return { id, pass, reason: pass ? `objective score ${signed(gap)}, not down` : `objective score down ${gap}` };
}

function judgeNotDown(grades: RunGrades, pair: BaselinePair): GuardrailCondition {
  const id = "judge-not-down";
  const gap = judgeGap(grades, pair);
  if (gap === null) return { id, pass: false, reason: "no judge scores to compare" };
  const pass = gap >= -EPSILON;
  return { id, pass, reason: pass ? `judge score ${signed(gap)}, not down` : `judge score down ${gap}` };
}

function judgeWithinFloor(grades: RunGrades, pair: BaselinePair, status: NoiseStatus): GuardrailCondition {
  const id = "judge-within-floor";
  const problem = floorProblem(status, "judge");
  if (problem !== null) return { id, pass: false, reason: problem };
  const gap = judgeGap(grades, pair);
  if (gap === null) return { id, pass: false, reason: "no judge scores to compare" };
  const spread = status.floor!.spread.judge!;
  const pass = gap >= -spread - EPSILON;
  return {
    id, pass,
    reason: pass
      ? `judge score ${signed(gap)}, within the noise floor ${spread}`
      : `judge score ${signed(gap)}, down past the noise floor ${spread}`,
  };
}

function costWithin(rows: readonly TrialRow[], pair: BaselinePair, maxCostRise: number): GuardrailCondition {
  const id = "cost-within";
  const cost = costs(rows, pair);
  if (cost === null) return { id, pass: false, reason: "cost not metered: neither USD nor tokens on every trial" };
  const { measure, baseline, proposal } = cost;
  const cap = `at most ${percent(maxCostRise)}`;
  if (baseline === 0) {
    const pass = proposal === 0;
    return { id, pass, reason: pass ? `${measure}: both arms cost 0` : `${measure}: baseline cost 0, proposal ${proposal}` };
  }
  const change = proposal / baseline - 1;
  // Relative tolerance: the cap is a product of floats, and a cost exactly at it meets it.
  const pass = proposal <= baseline * (1 + maxCostRise) + EPSILON * Math.max(1, baseline);
  return { id, pass, reason: `${measure} ${round2(baseline)} → ${round2(proposal)} (${percent(change)}), ${cap}` };
}

function tokensDown(rows: readonly TrialRow[], pair: BaselinePair, minTokenCut: number): GuardrailCondition {
  const id = "tokens-down";
  const { base, prop } = pairedTrials(rows, pair);
  const baseline = tokenTotal(base);
  const proposal = tokenTotal(prop);
  if (baseline === null || proposal === null) return { id, pass: false, reason: "tokens not metered on every trial" };
  const change = baseline === 0 ? 0 : proposal / baseline - 1;
  const pass = proposal <= baseline * (1 - minTokenCut) + EPSILON * Math.max(1, baseline);
  return { id, pass, reason: `tokens ${baseline} → ${proposal} (${percent(change)}), needs at most ${percent(-minTokenCut)}` };
}

const goal = (name: GuardrailGoal, conditions: GuardrailCondition[]): GoalVerdict =>
  ({ goal: name, pass: conditions.every((condition) => condition.pass), conditions });

/** Pure. Every condition is evaluated and reported, even when an earlier one already fails the goal. */
export function guardrailVerdict(grades: RunGrades, rows: readonly TrialRow[], pair: BaselinePair, status: NoiseStatus, thresholds: GuardrailThresholds, selected: readonly string[] = grades.cases.map((graded) => graded.case)): GuardrailVerdict {
  const regressions = noRegressions(grades, pair);
  const coverage = allCasesRan(rows, pair, selected);
  return {
    baseline: pair.baseline,
    proposal: pair.proposal,
    goals: [
      goal("quality", [
        coverage,
        objectiveUp(grades, pair, status),
        regressions,
        judgeNotDown(grades, pair),
        costWithin(rows, pair, thresholds.maxCostRise),
      ]),
      goal("cost", [
        { ...coverage },
        tokensDown(rows, pair, thresholds.minTokenCut),
        // A copy: a reader that edits one goal's condition must not edit the other's.
        { ...regressions },
        objectiveNotDown(grades, pair),
        judgeWithinFloor(grades, pair, status),
      ]),
    ],
  };
}

/** Null when the report is not a graded set run or has no baseline pair. */
export function reportGuardrails(report: BacktestReport, status: NoiseStatus, thresholds: GuardrailThresholds): GuardrailVerdict | null {
  const pair = baselinePair(armList(report.arms));
  if (pair === null) return null;
  const grades = gradeRun(report, [pair.baseline, pair.proposal]);
  if (grades === null) return null;
  return guardrailVerdict(grades, report.rows, pair, status, thresholds, report.set?.selected ?? grades.cases.map((graded) => graded.case));
}

/**
 * The report as it is written, carrying its verdict: on a set run stamped
 * with its noise (stampNoise), against that same floor status, so the
 * verdict and the gaps beside it never read different floors. A floor run
 * gets none (its arms are identical by design) and an earlier stamp is
 * dropped, so a rescore never keeps a verdict its new scores do not earn.
 * It never throws: a verdict that cannot be computed is no verdict.
 */
export function stampGuardrails(report: BacktestReport, thresholds: GuardrailThresholds): BacktestReport {
  const { guardrails: _stale, ...rest } = report;
  if (report.noiseFloor !== undefined || report.noise === undefined) return rest;
  try {
    const verdict = reportGuardrails(rest, report.noise, thresholds);
    return verdict === null ? rest : { ...rest, guardrails: verdict };
  } catch {
    return rest;
  }
}
