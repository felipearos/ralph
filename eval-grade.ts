/**
 * Grades a test-set run (#855): which grader each case has, and per agent arm
 * an objective result and a judge score.
 *
 * The two are never combined. Nothing here adds, averages, weights or
 * otherwise blends the objective result with the judge score, and no field
 * carries such a number: they live in separate sub-objects. A prompt that
 * only makes diffs look better to the judges must not hide behind a blended
 * number that a passing test elsewhere props up, nor the other way round.
 *
 * Pure: the report is read, never written, and nothing is spawned.
 */
import type { ArmScore, TicketScore } from "./backtest-score";
import type { BacktestReport } from "./backtest-report";
import { AXES } from "./eval-panel";

/**
 * What decides a case objectively: held-out tests the base fails, an
 * operator check, or nothing but the judges.
 */
export type GraderType = "tests" | "check" | "judge-only";

export interface CaseGrade {
  case: string;
  grader: GraderType;
  /**
   * The case's held-out tests all already passed on the base, so they prove
   * nothing about the arm. Kept on a check case too: the check grades it, but
   * the operator still learns its tests are no evidence.
   */
  noEvidence: boolean;
}

export interface CaseArmGrade {
  arm: string;
  /** Null where the case has no objective grader, or the arm has no score in it. */
  objective: "pass" | "fail" | "pending" | null;
  /** The mean of the arm's axis scores over the panel's answering judges; null when none scored it. */
  judge: number | null;
}

export interface ArmGrades {
  arm: string;
  /** `graded`: tests and check cases the arm has a result for; `pending`: check cases scored before #857, which ran no check. */
  objective: { passed: number; graded: number; pending: number };
  /** The mean of the arm's per-case judge scores, to 2 decimals; null when no case has one. */
  judge: { mean: number | null; cases: number };
}

export interface RunGrades {
  cases: (CaseGrade & { arms: CaseArmGrade[] })[];
  arms: ArmGrades[];
}

/** A failing held-out test on the base outranks a check: a test that turns green is the stronger evidence. */
export function caseGrade(score: TicketScore, hasCheck: boolean): CaseGrade {
  if (score.baseline.some((file) => file.result === "fail")) return { case: score.ticket, grader: "tests", noEvidence: false };
  const noEvidence = score.baseline.length > 0;
  return { case: score.ticket, grader: hasCheck ? "check" : "judge-only", noEvidence };
}

/** Passes only when every test the base fails passes on the arm; a heldOut that did not run is the arm not making the evidence pass. */
function testsResult(arm: ArmScore): "pass" | "fail" {
  const heldOut = arm.heldOut;
  if (heldOut?.status !== "ok") return "fail";
  return heldOut.files.every((file) => file.baseline !== "fail" || file.result === "pass") ? "pass" : "fail";
}

/** Every non-null axis score the answering judges gave the arm, pooled into one mean. */
function judgeScore(score: TicketScore, arm: string): number | null {
  const scores: number[] = [];
  for (const verdict of score.panel?.verdicts ?? []) {
    if (verdict.status !== "ok") continue;
    const scored = verdict.arms[arm];
    if (scored === undefined) continue;
    for (const axis of AXES) {
      const value = scored.axes[axis]?.score;
      if (typeof value === "number") scores.push(value);
    }
  }
  return scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/** Every grade shown to a person is rounded here, so the report, ledger and page agree. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The grades of a test-set run, from each case's first trials only (repeats
 * do not change the verdict). Null on a run that is not a test-set run, or
 * one not scored yet.
 */
export function gradeRun(report: Pick<BacktestReport, "scores" | "set" | "rows">, arms: readonly string[]): RunGrades | null {
  if (report.set === undefined) return null;
  const scores = report.scores ?? [];
  if (scores.length === 0) return null;
  const checks = new Set(report.set.checks ?? []);
  const agentArms = arms.filter((arm) => arm !== "a");
  const totals = new Map(agentArms.map((arm) => [arm, { passed: 0, graded: 0, pending: 0, judged: [] as number[] }]));
  const cases: RunGrades["cases"] = scores.map((score) => {
    const grade = caseGrade(score, checks.has(score.ticket));
    const caseArms = agentArms.map((arm): CaseArmGrade => {
      // Scoring scores a trial that never ran too (its heldOut reads "none"); that is
      // an infrastructure failure, not the arm failing the case, so it grades nothing.
      const ran = report.rows.some((row) => row.ticket === score.ticket && row.arm === arm && row.repeat === undefined && row.outcome !== "not-run");
      const armScore = ran ? score.arms.find((entry) => entry.arm === arm) : undefined;
      const total = totals.get(arm)!;
      let objective: CaseArmGrade["objective"] = null;
      if (armScore !== undefined && grade.grader === "tests") {
        objective = testsResult(armScore);
        total.graded++;
        if (objective === "pass") total.passed++;
      } else if (armScore !== undefined && grade.grader === "check") {
        // A score written before #857 ran no check: pending, not a fail. A check that
        // could not run on the arm's tree is the arm not making the evidence pass, as a
        // held-out set that did not run is.
        if (armScore.check === undefined) {
          objective = "pending";
          total.pending++;
        } else {
          objective = armScore.check.result === "pass" ? "pass" : "fail";
          total.graded++;
          if (objective === "pass") total.passed++;
        }
      }
      const judge = judgeScore(score, arm);
      if (judge !== null) total.judged.push(judge);
      return { arm, objective, judge };
    });
    return { ...grade, arms: caseArms };
  });
  return {
    cases,
    arms: agentArms.map((arm): ArmGrades => {
      const { passed, graded, pending, judged } = totals.get(arm)!;
      const mean = judged.length === 0 ? null : round2(judged.reduce((sum, value) => sum + value, 0) / judged.length);
      return { arm, objective: { passed, graded, pending }, judge: { mean, cases: judged.length } };
    }),
  };
}
