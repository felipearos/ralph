/**
 * A finished test-set run (#871) on two agent arms: the baseline `live`
 * (lineup "live", no overlay) and the `proposal` (live lineup plus a prompt
 * overlay), with the reference arm `a`. Each case states, per arm, its
 * held-out test result, its judge score, whether its first trial ran, and its
 * tokens and USD, so the eval-guardrails tests can set every gap by hand.
 *
 * A case with a `result` on either arm is graded by held-out tests the base
 * fails; one with no `result` on either is judge-only. One judge scores every
 * axis of an arm at the arm's `judge`, so a case's judge score is exactly it.
 */
import type { ArmConfig } from "../../backtest";
import type { BacktestReport, TrialRow } from "../../backtest-report";
import type { ArmScore, HeldOut, TicketScore } from "../../backtest-score";
import { AXES, type Axis, type AxisScore, type JudgeSpec, type PanelResult } from "../../eval-panel";
import type { Tokens } from "../../experiments";

export const BASELINE_ARM = "live";
export const PROPOSAL_ARM = "proposal";
const ARMS = [BASELINE_ARM, PROPOSAL_ARM] as const;
type GuardrailArm = (typeof ARMS)[number];

export const GUARDRAIL_ARMS: ArmConfig[] = [
  { name: BASELINE_ARM, lineup: "live", overlay: null },
  { name: PROPOSAL_ARM, lineup: "live", overlay: "overlays/proposal.md" },
];

export interface GuardrailArmCase {
  /** The held-out tests' result; absent on a judge-only case (and a fail on a tests case). */
  result?: "pass" | "fail";
  /** Every axis at this score; null leaves the arm unscored. Defaults to 4. */
  judge?: number | null;
  /** False makes the first trial "not-run", so it grades nothing. Defaults to true. */
  ran?: boolean;
  /** Defaults to 1000 input tokens and nothing else. */
  tokens?: Tokens | null;
  /** Defaults to null (unknown). */
  usd?: number | null;
  /** How the USD was got; defaults to "reported". */
  usdSource?: "reported" | "estimated";
}

export interface GuardrailCase { id: string; live: GuardrailArmCase; proposal: GuardrailArmCase }

const JUDGE: JudgeSpec = { name: "judge-one", runner: "claude", model: "opus" };
const NONE: HeldOut = { status: "none", reason: "the human PRs changed no test file" };
export const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): Tokens => ({ input, output, cacheRead, cacheWrite });

function axes(score: number | null): Record<Axis, AxisScore> {
  return Object.fromEntries(AXES.map((axis) => [axis, { score, evidence: `${axis} evidence` }])) as Record<Axis, AxisScore>;
}

function panel(spec: GuardrailCase): PanelResult {
  const seed = `seed-${spec.id}`;
  const order = [...ARMS];
  return {
    seed, order,
    verdicts: [{
      judge: JUDGE, status: "ok",
      ranking: [order],
      arms: Object.fromEntries(ARMS.map((arm) => [arm, { axes: axes(spec[arm].judge === undefined ? 4 : spec[arm].judge!), better: "" }])),
      reason: "scored by hand",
    }],
    contested: [],
    rule: { kind: "inversion" },
    aggregate: { status: "ok", seed, order, ranking: [order], winners: [...order], tie: true, reason: "scored by hand" },
  };
}

function arm(name: string, heldOut: HeldOut | null): ArmScore {
  return { arm: name, heads: { first: null, final: `${name}-head` }, heldOut, gates: null, review: null, human: null, notes: [] };
}

function score(spec: GuardrailCase): TicketScore {
  const tested = ARMS.some((name) => spec[name].result !== undefined);
  const heldOut = (name: GuardrailArm): HeldOut => !tested
    ? NONE
    : { status: "ok", files: [{ path: "src/fix.test.ts", baseline: "fail", result: spec[name].result ?? "fail" }] };
  return {
    ticket: spec.id, scoredAt: "2026-11-19T03:00:00Z",
    baseline: tested ? [{ path: "src/fix.test.ts", result: "fail" }] : [],
    arms: [arm("a", null), ...ARMS.map((name) => arm(name, heldOut(name)))],
    panel: panel(spec),
  };
}

function row(spec: GuardrailCase, name: GuardrailArm): TrialRow {
  const trial = spec[name];
  return {
    ticket: spec.id, arm: name, lineup: "live",
    outcome: trial.ran === false ? "not-run" : "green-pr", detail: "<ralph>DONE</ralph>",
    gates: [{ name: "ci", conclusion: "SUCCESS" }],
    weakening: [], reviewRounds: 0, reviewThreads: 0, wallSeconds: 600, handoffSeconds: 540,
    tokens: trial.tokens === undefined ? tokens(1000) : trial.tokens,
    cost: { usd: trial.usd ?? null, source: trial.usd === undefined || trial.usd === null ? "unknown" : trial.usdSource ?? "reported" },
    artifacts: `trials/${spec.id}/${name}`,
    models: [{ stage: "coder", model: "opus", runner: "claude" }],
    heads: { base: "base", first: `${name}-head`, final: `${name}-head` },
  };
}

/** The run over `cases`, first trials only; `arms` overrides the configured arms. */
export function guardrailReport(cases: readonly GuardrailCase[], arms: ArmConfig[] = GUARDRAIL_ARMS): BacktestReport {
  return {
    id: "guardrail-run",
    startedAt: "2026-11-19T00:00:00Z",
    finishedAt: "2026-11-19T02:30:00Z",
    arms,
    rows: cases.flatMap((spec) => ARMS.map((name) => row(spec, name))),
    skipped: [],
    notes: [],
    stoppedBy: null,
    scores: cases.map(score),
    set: { version: "guardrail-v1", selected: cases.map((spec) => spec.id) },
  };
}
