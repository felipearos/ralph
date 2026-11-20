/**
 * A finished noise-floor run (#859): one test set run on three identical
 * live-setup arms `live-1`, `live-2`, `live-3`, plus the reference arm `a`.
 * Whatever the arms differ by is noise, so the eval-noise-floor tests can
 * check the floor by hand.
 *
 * One judge, every axis of an arm at the same score:
 *   noise-flaky   (tests)       live-1 pass 4   live-2 pass 4   live-3 fail 3   objective 1 (disagree), judge 4 − 3 = 1
 *   noise-steady  (tests)       live-1 pass 4   live-2 pass 5   live-3 pass 4   objective 0 (agree),    judge 5 − 4 = 1
 *   noise-judged  (judge-only)  live-1 4        live-2 4        live-3 4        objective null,         judge 0
 * Pass rates: live-1 2/2 = 1, live-2 2/2 = 1, live-3 1/2 = 0.5 → objective spread 0.5.
 * Judge means: live-1 12/3 = 4, live-2 13/3 = 4.33, live-3 11/3 = 3.67 → judge spread 0.66.
 */
import type { BacktestReport, TrialRow } from "../../backtest-report";
import type { ArmScore, HeldOut, TicketScore } from "../../backtest-score";
import { AXES, type Axis, type AxisScore, type JudgeSpec, type PanelResult } from "../../eval-panel";

export const NOISE_ARMS = ["live-1", "live-2", "live-3"] as const;
type NoiseArm = (typeof NOISE_ARMS)[number];

const JUDGE: JudgeSpec = { name: "judge-one", runner: "claude", model: "opus" };

function axes(score: number): Record<Axis, AxisScore> {
  return Object.fromEntries(AXES.map((axis) => [axis, { score, evidence: `${axis} evidence` }])) as Record<Axis, AxisScore>;
}

function panel(ticket: string, scores: Record<NoiseArm, number>): PanelResult {
  const seed = `seed-${ticket}`;
  const order = [...NOISE_ARMS];
  return {
    seed, order,
    verdicts: [{
      judge: JUDGE, status: "ok",
      ranking: [order],
      arms: Object.fromEntries(NOISE_ARMS.map((arm) => [arm, { axes: axes(scores[arm]), better: "" }])),
      reason: "the arms are alike",
    }],
    contested: [],
    rule: { kind: "inversion" },
    aggregate: { status: "ok", seed, order, ranking: [order], winners: [...order], tie: true, reason: "the arms are alike" },
  };
}

function arm(name: string, heldOut: HeldOut | null): ArmScore {
  return { arm: name, heads: { first: null, final: `${name}-head` }, heldOut, gates: null, review: null, human: null, notes: [] };
}

const NONE: HeldOut = { status: "none", reason: "the human PRs changed no test file" };
const tests = (result: "pass" | "fail"): HeldOut => ({ status: "ok", files: [{ path: "src/fix.test.ts", baseline: "fail", result }] });

function score(ticket: string, baseline: TicketScore["baseline"], heldOut: Record<NoiseArm, HeldOut>, judged: Record<NoiseArm, number>): TicketScore {
  return {
    ticket, scoredAt: "2026-11-19T03:00:00Z", baseline,
    arms: [arm("a", null), ...NOISE_ARMS.map((name) => arm(name, heldOut[name]))],
    panel: panel(ticket, judged),
  };
}

function row(ticket: string, armName: NoiseArm): TrialRow {
  return {
    ticket, arm: armName, lineup: "live",
    outcome: "green-pr", detail: "<ralph>DONE</ralph>",
    gates: [{ name: "ci", conclusion: "SUCCESS" }],
    weakening: [], reviewRounds: 0, reviewThreads: 0, wallSeconds: 600, handoffSeconds: 540,
    tokens: null, cost: { usd: null, source: "unknown" },
    artifacts: `trials/${ticket}/${armName}`,
    models: [{ stage: "coder", model: "opus", runner: "claude" }],
    heads: { base: "base", first: `${armName}-head`, final: `${armName}-head` },
  };
}

export const NOISE_FLOOR_CASES = ["noise-flaky", "noise-steady", "noise-judged"] as const;

export function noiseFloorReport(): BacktestReport {
  const failing: TicketScore["baseline"] = [{ path: "src/fix.test.ts", result: "fail" }];
  const scores: TicketScore[] = [
    score("noise-flaky", failing, { "live-1": tests("pass"), "live-2": tests("pass"), "live-3": tests("fail") }, { "live-1": 4, "live-2": 4, "live-3": 3 }),
    score("noise-steady", failing, { "live-1": tests("pass"), "live-2": tests("pass"), "live-3": tests("pass") }, { "live-1": 4, "live-2": 5, "live-3": 4 }),
    score("noise-judged", [], { "live-1": NONE, "live-2": NONE, "live-3": NONE }, { "live-1": 4, "live-2": 4, "live-3": 4 }),
  ];
  return {
    id: "noise-floor-run",
    startedAt: "2026-11-19T00:00:00Z",
    finishedAt: "2026-11-19T02:30:00Z",
    arms: NOISE_ARMS.map((name) => ({ name, lineup: "live", overlay: null })),
    rows: NOISE_FLOOR_CASES.flatMap((ticket) => NOISE_ARMS.map((name) => row(ticket, name))),
    skipped: [],
    notes: [],
    stoppedBy: null,
    scores,
    set: { version: "floor-v1", selected: [...NOISE_FLOOR_CASES] },
  };
}
