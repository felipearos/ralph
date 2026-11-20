import { describe, expect, it } from "vitest";
import type { BacktestReport } from "./backtest-report";
import type { TicketScore } from "./backtest-score";
import {
  accuracyLabel, calibrationChecks, judgeAccuracy, reportJudgeAccuracy, stampJudgeAccuracy, tallyChecks,
  type CalibratedCase, type JudgeAccuracy,
} from "./eval-judge-accuracy";
import type { CalibrationVerdict } from "./evals-set";
import { AXES, type Axis, type AxisScore, type Contested, type JudgeSpec, type JudgeVerdict, type PanelResult } from "./eval-panel";

const CLAUDE: JudgeSpec = { name: "judge-claude", runner: "claude", model: "opus" };
const CODEX: JudgeSpec = { name: "judge-codex", runner: "codex", model: "gpt" };

type ArmAxes = Partial<Record<Axis, number | null>>;

function axes(scores: ArmAxes): Record<Axis, AxisScore> {
  return Object.fromEntries(AXES.map((axis) => [axis, { score: scores[axis] ?? 3, evidence: "e" }])) as Record<Axis, AxisScore>;
}

function verdict(judge: JudgeSpec, arms: Record<string, ArmAxes>): JudgeVerdict {
  return {
    judge, status: "ok", ranking: [Object.keys(arms)], reason: "r",
    arms: Object.fromEntries(Object.entries(arms).map(([arm, scores]) => [arm, { axes: axes(scores), better: "" }])),
  };
}

function panel(verdicts: JudgeVerdict[], contested: Contested[] = [], rule?: PanelResult["rule"]): PanelResult {
  const order = ["a", "live", "prop"];
  return {
    seed: "s", order, verdicts, contested, ...(rule !== undefined ? { rule } : {}),
    aggregate: { status: "ok", seed: "s", order, ranking: [order], winners: order, tie: true, reason: "r" },
  };
}

function score(ticket: string, p: PanelResult | null, repeat?: number): TicketScore {
  return { ticket, scoredAt: "2026-11-19T00:00:00Z", baseline: [], arms: [], panel: p, ...(repeat !== undefined ? { repeat } : {}) };
}

function cal(axis: Axis, arms: [string, string], preferred: string): CalibrationVerdict {
  return { arms, axis, preferred, reason: "because", by: "op", at: "2026-11-19T00:00:00Z" };
}

// Two judges of different runners: live beats prop on correctness (claude 5 v 3, codex 4 v 2), tie on tests (4 v 4 both).
const PANEL = panel([
  verdict(CLAUDE, { a: { correctness: 4 }, live: { correctness: 5, tests: 4, scope: 2 }, prop: { correctness: 3, tests: 4, scope: 4 } }),
  verdict(CODEX, { a: { correctness: 4 }, live: { correctness: 4, tests: 4, scope: 3 }, prop: { correctness: 2, tests: 4, scope: 5 } }),
]);

describe("calibrationChecks", () => {
  it("agrees when the panel's mean prefers the operator's arm", () => {
    const checks = calibrationChecks([score("c1", PANEL)], [{ id: "c1", calibration: [cal("correctness", ["live", "prop"], "live")] }]);
    expect(checks).toEqual([{ case: "c1", axis: "correctness", arms: ["live", "prop"], preferred: "live", panel: "live", outcome: "agree" }]);
  });

  it("disagrees when the panel prefers the other arm", () => {
    const checks = calibrationChecks([score("c1", PANEL)], [{ id: "c1", calibration: [cal("scope", ["live", "prop"], "live")] }]);
    expect(checks[0]).toMatchObject({ panel: "prop", outcome: "disagree" });
  });

  it("reads only the judges that scored both arms, so a one-sided score cannot tilt a mean", () => {
    // claude scores review on live alone; codex scores both and prefers live. Mixing them would read 3 v 3, a tie.
    const oneSided = verdict(CLAUDE, { live: { review: 2 }, prop: {} });
    if (oneSided.status === "ok") oneSided.arms.prop!.axes.review = { score: null, evidence: "single head" };
    const p = panel([oneSided, verdict(CODEX, { live: { review: 4 }, prop: { review: 3 } })]);
    const checks = calibrationChecks([score("c1", p)], [{ id: "c1", calibration: [cal("review", ["live", "prop"], "live")] }]);
    expect(checks[0]).toMatchObject({ panel: "live", outcome: "agree" });
  });

  it("reads a panel tie as a disagreement", () => {
    const checks = calibrationChecks([score("c1", PANEL)], [{ id: "c1", calibration: [cal("tests", ["live", "prop"], "prop")] }]);
    expect(checks[0]).toMatchObject({ panel: "tie", outcome: "disagree" });
  });

  it("skips null scores per arm and judge", () => {
    const p = panel([
      verdict(CLAUDE, { live: { review: 5 }, prop: { review: 2 } }),
      verdict(CODEX, { live: { review: null }, prop: { review: 4 } }),
    ]);
    // live mean 5 (codex skipped), prop mean 3.
    const checks = calibrationChecks([score("c1", p)], [{ id: "c1", calibration: [cal("review", ["live", "prop"], "live")] }]);
    expect(checks[0]).toMatchObject({ panel: "live", outcome: "agree" });
  });

  it("excludes a pair contested by inversion, still naming the panel's side", () => {
    const p = panel(PANEL.verdicts, [{ axis: "correctness", arms: ["live", "prop"], judges: ["judge-claude", "judge-codex"] }]);
    const cases = [{ id: "c1", calibration: [cal("correctness", ["prop", "live"], "live"), cal("correctness", ["a", "live"], "live")] }];
    const checks = calibrationChecks([score("c1", p)], cases);
    expect(checks.map((check) => check.outcome)).toEqual(["contested", "agree"]);
    expect(checks[0]?.panel).toBe("live");
    const tallied = tallyChecks(checks);
    expect(tallied.contested).toBe(1);
    expect(tallied.overall).toEqual({ agree: 1, total: 1, accuracy: 1 });
  });

  it("excludes any pair holding an arm contested by spread", () => {
    const p = panel(PANEL.verdicts, [{ axis: "correctness", arms: ["prop"], judges: ["judge-claude", "judge-codex"] }], { kind: "spread", points: 2 });
    const cases = [{ id: "c1", calibration: [cal("correctness", ["live", "prop"], "live"), cal("correctness", ["a", "live"], "live"), cal("scope", ["live", "prop"], "prop")] }];
    expect(calibrationChecks([score("c1", p)], cases).map((check) => check.outcome)).toEqual(["contested", "agree", "agree"]);
  });

  it("leaves out a verdict on a case the run lacks, an arm it lacks, or a panel with no ok verdict", () => {
    const unavailable = panel([{ judge: CLAUDE, status: "unavailable", reason: "down" }]);
    const cases: CalibratedCase[] = [
      { id: "missing", calibration: [cal("correctness", ["live", "prop"], "live")] },
      { id: "c1", calibration: [cal("correctness", ["live", "ghost"], "live")] },
      { id: "null-panel", calibration: [cal("correctness", ["live", "prop"], "live")] },
      { id: "down", calibration: [cal("correctness", ["live", "prop"], "live")] },
      { id: "bare" },
    ];
    const scores = [score("c1", PANEL), score("null-panel", null), score("down", unavailable), score("bare", PANEL)];
    expect(calibrationChecks(scores, cases)).toEqual([]);
    expect(judgeAccuracy(scores, cases).overall).toEqual({ agree: 0, total: 0, accuracy: null });
  });

  it("degrades a malformed panel to unjudged instead of throwing", () => {
    const broken = { seed: "s", verdicts: [{ status: "ok", arms: "nope" }], contested: "x" } as unknown as PanelResult;
    const cases = [{ id: "c1", calibration: [cal("correctness", ["live", "prop"], "live")] }];
    expect(calibrationChecks([score("c1", broken)], cases)).toEqual([]);
  });

  it("reads only a case's first trials, never its repeats", () => {
    const flipped = panel([verdict(CLAUDE, { live: { correctness: 1 }, prop: { correctness: 5 } })]);
    const cases = [{ id: "c1", calibration: [cal("correctness", ["live", "prop"], "live")] }];
    const checks = calibrationChecks([score("c1", flipped, 2), score("c1", PANEL), score("c1", flipped, 3)], cases);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ panel: "live", outcome: "agree" });
  });
});

describe("judgeAccuracy", () => {
  it("tallies each verdict per axis and overall, conflicting verdicts included", () => {
    const cases = [
      { id: "c1", calibration: [cal("correctness", ["live", "prop"], "live"), cal("correctness", ["live", "prop"], "prop"), cal("scope", ["live", "prop"], "prop")] },
      { id: "c2", calibration: [cal("correctness", ["a", "live"], "live"), cal("tests", ["live", "prop"], "live")] },
    ];
    const result = judgeAccuracy([score("c1", PANEL), score("c2", PANEL)], cases);
    expect(result.axes.correctness).toEqual({ agree: 2, total: 3, accuracy: 0.67 });
    expect(result.axes.scope).toEqual({ agree: 1, total: 1, accuracy: 1 });
    expect(result.axes.tests).toEqual({ agree: 0, total: 1, accuracy: 0 });
    expect(result.axes.review).toEqual({ agree: 0, total: 0, accuracy: null });
    expect(result.overall).toEqual({ agree: 3, total: 5, accuracy: 0.6 });
    expect(result.contested).toBe(0);
    expect(result.checks).toHaveLength(5);
  });

  it("has no accuracy and says so with no verdicts", () => {
    const result = judgeAccuracy([score("c1", PANEL)], [{ id: "c1" }]);
    expect(result.overall.accuracy).toBeNull();
    expect(accuracyLabel(result.overall)).toBe("no calibration yet");
  });
});

describe("accuracyLabel", () => {
  it("states the share and the count", () => {
    expect(accuracyLabel({ agree: 3, total: 4, accuracy: 0.75 })).toBe("75% (3 of 4 verdicts)");
    expect(accuracyLabel({ agree: 1, total: 1, accuracy: 1 })).toBe("100% (1 of 1 verdict)");
    expect(accuracyLabel({ agree: 0, total: 0, accuracy: null })).toBe("no calibration yet");
  });
});

describe("stampJudgeAccuracy", () => {
  const CASES = [{ id: "c1", calibration: [cal("correctness", ["live", "prop"], "live")] }];
  const STALE: JudgeAccuracy = tallyChecks([{ case: "old", axis: "scope", arms: ["live", "prop"], preferred: "live", panel: "prop", outcome: "disagree" }]);

  function report(extra: Partial<BacktestReport>): BacktestReport {
    return { id: "r", startedAt: "t", finishedAt: "t", arms: {} as BacktestReport["arms"], rows: [], skipped: [], notes: [], stoppedBy: null, ...extra };
  }

  it("replaces a stale stamp on a set run", () => {
    const stamped = stampJudgeAccuracy(report({ set: { version: null, selected: ["c1"] }, scores: [score("c1", PANEL)], judgeAccuracy: STALE }), CASES);
    expect(stamped.judgeAccuracy?.overall).toEqual({ agree: 1, total: 1, accuracy: 1 });
    expect(stamped.judgeAccuracy?.checks.map((check) => check.case)).toEqual(["c1"]);
  });

  it("stamps nothing off a set run, without scores, or with an unreadable set, and drops a stale stamp", () => {
    const offSet = report({ scores: [score("c1", PANEL)], judgeAccuracy: STALE });
    expect(reportJudgeAccuracy(offSet, CASES)).toBeNull();
    expect("judgeAccuracy" in stampJudgeAccuracy(offSet, CASES)).toBe(false);
    const unscored = report({ set: { version: null, selected: ["c1"] }, judgeAccuracy: STALE });
    expect("judgeAccuracy" in stampJudgeAccuracy(unscored, CASES)).toBe(false);
    const onSet = report({ set: { version: null, selected: ["c1"] }, scores: [score("c1", PANEL)], judgeAccuracy: STALE });
    expect("judgeAccuracy" in stampJudgeAccuracy(onSet, null)).toBe(false);
  });

  it("stamps a total of zero on a set run with no calibration", () => {
    const stamped = stampJudgeAccuracy(report({ set: { version: null, selected: ["c1"] }, scores: [score("c1", PANEL)] }), [{ id: "c1" }]);
    expect(stamped.judgeAccuracy?.overall).toEqual({ agree: 0, total: 0, accuracy: null });
  });
});
