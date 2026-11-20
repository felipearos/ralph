/**
 * Judge accuracy (#877): how often the judge panel's own verdict agrees with
 * an operator's calibration verdicts (#876), per axis and overall.
 *
 * Pure on purpose: the caller reads the run and the test set, and this module
 * only compares them. A verdict the run cannot speak to (its case or an arm
 * missing, no ok judge scoring both arms) is unjudged and counts nowhere; a
 * verdict on an axis the panel itself contested is excluded from accuracy but
 * counted, so a report can say how many were set aside. Odd input degrades to
 * unjudged, never to a throw.
 */
import type { BacktestReport } from "./backtest-report";
import type { TicketScore } from "./backtest-score";
import type { CalibrationVerdict } from "./evals-set";
import { AXES, type Axis, type PanelResult } from "./eval-panel";

export type CalibrationOutcome = "agree" | "disagree" | "contested";

/** One operator verdict against the panel; `panel` is the arm the panel preferred, or "tie". */
export interface CalibrationCheck {
  case: string;
  axis: Axis;
  arms: [string, string];
  preferred: string;
  panel: string | "tie";
  outcome: CalibrationOutcome;
}

/** `total` is agree + disagree; `accuracy` is agree / total to 2 decimals, null with no total. */
export interface AccuracyTally { agree: number; total: number; accuracy: number | null }

export interface JudgeAccuracy {
  overall: AccuracyTally;
  axes: Record<Axis, AccuracyTally>;
  /** Verdicts on an axis the panel contested for their arms: excluded from every tally. */
  contested: number;
  checks: CalibrationCheck[];
}

export interface CalibratedCase { id: string; calibration?: CalibrationVerdict[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The arm's score on the axis from one judge's arms map, or null when it gave none. */
function scoreOf(arms: unknown, arm: string, axis: Axis): number | null {
  if (!isRecord(arms)) return null;
  const entry = arms[arm];
  if (!isRecord(entry) || !isRecord(entry.axes)) return null;
  const scored = entry.axes[axis];
  if (!isRecord(scored)) return null;
  return typeof scored.score === "number" && Number.isFinite(scored.score) ? scored.score : null;
}

/**
 * The panel's side on one pair and axis: the mean over the judges that scored
 * BOTH arms, so each mean reads the same judges (a judge that scored one arm
 * alone would tilt it); null when no ok judge scored both.
 */
function panelSide(panel: PanelResult, axis: Axis, [p, q]: [string, string]): string | "tie" | null {
  const verdicts = Array.isArray(panel.verdicts) ? panel.verdicts : [];
  const ok = verdicts.filter((verdict) => isRecord(verdict) && verdict.status === "ok");
  let diff = 0;
  let paired = 0;
  for (const verdict of ok) {
    const arms = (verdict as { arms?: unknown }).arms;
    const sp = scoreOf(arms, p, axis);
    const sq = scoreOf(arms, q, axis);
    if (sp === null || sq === null) continue;
    diff += sp - sq;
    paired += 1;
  }
  if (paired === 0) return null;
  return diff === 0 ? "tie" : diff > 0 ? p : q;
}

/** Inversion entries name both arms of the pair; a spread entry names one arm, and contests any pair holding it. */
function isContested(panel: PanelResult, axis: Axis, [p, q]: [string, string]): boolean {
  const contested = Array.isArray(panel.contested) ? panel.contested : [];
  return contested.some((entry) => {
    if (!isRecord(entry) || entry.axis !== axis || !Array.isArray(entry.arms)) return false;
    const arms = entry.arms as unknown[];
    return arms.length === 1 ? arms.includes(p) || arms.includes(q) : arms.includes(p) && arms.includes(q);
  });
}

/** Every operator verdict the run can speak to, checked against its panel; unjudged verdicts are left out. */
export function calibrationChecks(scores: readonly TicketScore[], cases: readonly CalibratedCase[]): CalibrationCheck[] {
  // A case's first trials only: repeats are a run's own evidence, not its verdict (as backtest-ledger reads them).
  const panels = new Map<string, PanelResult>();
  for (const score of scores) {
    if (!isRecord(score) || score.repeat !== undefined || typeof score.ticket !== "string") continue;
    if (panels.has(score.ticket)) continue;
    if (isRecord(score.panel)) panels.set(score.ticket, score.panel);
  }
  const checks: CalibrationCheck[] = [];
  for (const c of cases) {
    const panel = panels.get(c.id);
    if (panel === undefined || !Array.isArray(c.calibration)) continue;
    for (const verdict of c.calibration) {
      if (!isRecord(verdict) || !Array.isArray(verdict.arms) || verdict.arms.length !== 2) continue;
      if (!(AXES as readonly string[]).includes(verdict.axis)) continue;
      const arms: [string, string] = [String(verdict.arms[0]), String(verdict.arms[1])];
      const side = panelSide(panel, verdict.axis, arms);
      if (side === null) continue;
      const outcome: CalibrationOutcome = isContested(panel, verdict.axis, arms)
        ? "contested"
        // A tie disagrees: the panel saw no difference where the operator saw one.
        : side === verdict.preferred ? "agree" : "disagree";
      checks.push({ case: c.id, axis: verdict.axis, arms, preferred: verdict.preferred, panel: side, outcome });
    }
  }
  return checks;
}

function tally(agree: number, total: number): AccuracyTally {
  return { agree, total, accuracy: total === 0 ? null : Math.round((agree / total) * 100) / 100 };
}

/** Separate from calibrationChecks so stored checks can be re-tallied without the run. */
export function tallyChecks(checks: readonly CalibrationCheck[]): JudgeAccuracy {
  const counts = Object.fromEntries(AXES.map((axis) => [axis, { agree: 0, total: 0 }])) as Record<Axis, { agree: number; total: number }>;
  let contested = 0;
  for (const check of checks) {
    if (check.outcome === "contested") {
      contested += 1;
      continue;
    }
    const count = counts[check.axis];
    if (count === undefined) continue;
    count.total += 1;
    if (check.outcome === "agree") count.agree += 1;
  }
  const axes = Object.fromEntries(AXES.map((axis) => [axis, tally(counts[axis].agree, counts[axis].total)])) as Record<Axis, AccuracyTally>;
  const agree = AXES.reduce((sum, axis) => sum + counts[axis].agree, 0);
  const total = AXES.reduce((sum, axis) => sum + counts[axis].total, 0);
  return { overall: tally(agree, total), axes, contested, checks: [...checks] };
}

export function judgeAccuracy(scores: readonly TicketScore[], cases: readonly CalibratedCase[]): JudgeAccuracy {
  return tallyChecks(calibrationChecks(scores, cases));
}

/** Null unless the report is a scored set run; otherwise its tally, possibly with no total. */
export function reportJudgeAccuracy(report: BacktestReport, cases: readonly CalibratedCase[]): JudgeAccuracy | null {
  if (report.set === undefined || report.scores === undefined) return null;
  return judgeAccuracy(report.scores, cases);
}

/**
 * The report as it is written, carrying its judge accuracy. An earlier stamp
 * is always dropped, so a rescore never keeps an accuracy its new panels do
 * not earn; a set that could not be read (`cases` null) stamps nothing. It
 * never throws: an accuracy that cannot be computed is no accuracy.
 */
export function stampJudgeAccuracy(report: BacktestReport, cases: readonly CalibratedCase[] | null): BacktestReport {
  const { judgeAccuracy: _stale, ...rest } = report;
  if (cases === null) return rest;
  try {
    const accuracy = reportJudgeAccuracy(rest, cases);
    return accuracy === null ? rest : { ...rest, judgeAccuracy: accuracy };
  } catch {
    return rest;
  }
}

/** Never "0%" or "100%" on nothing: with no verdicts the panel is simply uncalibrated. */
export function accuracyLabel(tally: AccuracyTally): string {
  if (tally.total === 0 || tally.accuracy === null) return "no calibration yet";
  return `${Math.round(tally.accuracy * 100)}% (${tally.agree} of ${tally.total} verdict${tally.total === 1 ? "" : "s"})`;
}
