/**
 * A finished test-set run (#855) with one case of every grader: held-out
 * tests the base fails, no evidence, judge-only and an operator check. Agent
 * arms `b` and `c`, the reference arm `a`. Deterministic, so the grade,
 * report, ledger and run-view tests can share it and check numbers by hand.
 *
 * Judge scores, pooled over both judges' non-null axes (5 axes each):
 *   case-tests       b: 5×4 + 4×5 (judge-two leaves `review` null) = 40/9   c: 2, 2 → 2
 *   case-no-evidence b: 3, 3 → 3                                            c: 3, 2 → 2.5
 *   case-judge-only  b: 4, 4 → 4                                            c: 1, 1 → 1
 *   case-check       b: 5, 5 → 5                                            c: 2, 3 → 2.5
 * Arm means: b (40/9 + 3 + 4 + 5) / 4 = 4.11; c (2 + 2.5 + 1 + 2.5) / 4 = 2.
 */
import type { BacktestReport, TrialRow } from "../../backtest-report";
import type { ArmScore, HeldOut, TicketScore } from "../../backtest-score";
import { AXES, type Axis, type AxisScore, type JudgeSpec, type JudgeVerdict, type PanelResult } from "../../eval-panel";

const JUDGES: JudgeSpec[] = [
  { name: "judge-one", runner: "claude", model: "opus" },
  { name: "judge-two", runner: "codex", model: "gpt" },
];

/** Every axis at `score`, except the ones `nulls` names. */
function axes(score: number, nulls: Axis[] = []): Record<Axis, AxisScore> {
  return Object.fromEntries(AXES.map((axis) => [axis, { score: nulls.includes(axis) ? null : score, evidence: `${axis} evidence` }])) as Record<Axis, AxisScore>;
}

function verdict(judge: JudgeSpec, b: Record<Axis, AxisScore>, c: Record<Axis, AxisScore>): JudgeVerdict {
  return {
    judge, status: "ok",
    ranking: [["b"], ["c"]],
    arms: { b: { axes: b, better: "" }, c: { axes: c, better: "" } },
    reason: "b is closer to the ticket",
  };
}

function panel(ticket: string, one: [Record<Axis, AxisScore>, Record<Axis, AxisScore>], two: [Record<Axis, AxisScore>, Record<Axis, AxisScore>]): PanelResult {
  const seed = `seed-${ticket}`;
  return {
    seed, order: ["b", "c"],
    verdicts: [verdict(JUDGES[0]!, ...one), verdict(JUDGES[1]!, ...two)],
    contested: [],
    rule: { kind: "inversion" },
    aggregate: { status: "ok", seed, order: ["b", "c"], ranking: [["b"], ["c"]], winners: ["b"], tie: false, reason: "both judges rank b first" },
  };
}

function arm(name: "a" | "b" | "c", heldOut: HeldOut | null): ArmScore {
  return {
    arm: name,
    heads: { first: null, final: `${name}-head` },
    heldOut,
    gates: null,
    review: null,
    human: null,
    notes: [],
  };
}

const NONE: HeldOut = { status: "none", reason: "the human PRs changed no test file" };

function score(ticket: string, baseline: TicketScore["baseline"], b: HeldOut, c: HeldOut, scored: PanelResult): TicketScore {
  return { ticket, scoredAt: "2026-11-19T03:00:00Z", baseline, arms: [arm("a", null), arm("b", b), arm("c", c)], panel: scored };
}

function row(ticket: string, armName: "b" | "c"): TrialRow {
  return {
    ticket, arm: armName, lineup: armName === "b" ? "live" : "codex",
    outcome: "green-pr", detail: "<ralph>DONE</ralph>",
    gates: [{ name: "ci", conclusion: "SUCCESS" }],
    weakening: [], reviewRounds: 0, reviewThreads: 0, wallSeconds: 600, handoffSeconds: 540,
    tokens: null, cost: { usd: null, source: "unknown" },
    artifacts: `trials/${ticket}/${armName}`,
    models: [{ stage: "coder", model: armName === "b" ? "opus" : "gpt", runner: armName === "b" ? "claude" : "codex" }],
    heads: { base: "base", first: `${armName}-head`, final: `${armName}-head` },
  };
}

export const MIXED_SET_CASES = ["case-tests", "case-no-evidence", "case-judge-only", "case-check"] as const;

export function mixedSetReport(): BacktestReport {
  const scores: TicketScore[] = [
    score("case-tests", [{ path: "src/fix.test.ts", result: "fail" }],
      { status: "ok", files: [{ path: "src/fix.test.ts", baseline: "fail", result: "pass" }] },
      { status: "ok", files: [{ path: "src/fix.test.ts", baseline: "fail", result: "fail" }] },
      panel("case-tests", [axes(4), axes(2)], [axes(5, ["review"]), axes(2)])),
    score("case-no-evidence", [{ path: "src/old.test.ts", result: "pass" }],
      { status: "ok", files: [{ path: "src/old.test.ts", baseline: "pass", result: "pass" }] },
      { status: "ok", files: [{ path: "src/old.test.ts", baseline: "pass", result: "pass" }] },
      panel("case-no-evidence", [axes(3), axes(3)], [axes(3), axes(2)])),
    score("case-judge-only", [], NONE, NONE,
      panel("case-judge-only", [axes(4), axes(1)], [axes(4), axes(1)])),
    score("case-check", [], NONE, NONE,
      panel("case-check", [axes(5), axes(2)], [axes(5), axes(3)])),
  ];
  return {
    id: "mixed-set-run",
    startedAt: "2026-11-19T00:00:00Z",
    finishedAt: "2026-11-19T02:30:00Z",
    arms: [{ name: "b", lineup: "live", overlay: null }, { name: "c", lineup: "codex", overlay: null }],
    rows: MIXED_SET_CASES.flatMap((ticket) => [row(ticket, "b"), row(ticket, "c")]),
    skipped: [],
    notes: [],
    stoppedBy: null,
    scores,
    set: { version: "abc123", selected: [...MIXED_SET_CASES], checks: ["case-check"] },
  };
}
