import { describe, expect, it } from "vitest";
import type { ArmScore, TicketScore } from "./backtest-score";
import {
  checkAcceptance, evaluationContent, isPromptKind, isTestSetKind, promptEvidence, promptProposalVerdict, testSetRefusal,
  type PromptEvidence,
} from "./eval-evaluation-proposals";
import type { CalibratedCase } from "./eval-judge-accuracy";
import { AXES, type Axis, type AxisScore, type JudgeSpec, type JudgeVerdict, type PanelResult } from "./eval-panel";
import type { CalibrationVerdict, EvalCase } from "./evals-set";

const CLAUDE: JudgeSpec = { name: "judge-claude", runner: "claude", model: "opus" };

function verdict(arms: Record<string, number>): JudgeVerdict {
  const axes = (score: number) => Object.fromEntries(AXES.map((axis) => [axis, { score, evidence: "e" }])) as Record<Axis, AxisScore>;
  return {
    judge: CLAUDE, status: "ok", ranking: [Object.keys(arms)], reason: "r",
    arms: Object.fromEntries(Object.entries(arms).map(([arm, score]) => [arm, { axes: axes(score), better: "" }])),
  };
}

function panel(arms: Record<string, number>): PanelResult {
  const order = Object.keys(arms);
  return { seed: "s", order, verdicts: [verdict(arms)], contested: [], aggregate: { status: "ok", seed: "s", order, ranking: [order], winners: order, tie: true, reason: "r" } };
}

function arm(name: string, result: "pass" | "fail"): ArmScore {
  return {
    arm: name as ArmScore["arm"], heads: { first: null, final: null },
    heldOut: name === "a" ? null : { status: "ok", files: [{ path: "x.test.ts", baseline: "fail", result }] },
    gates: null, review: null, human: null, notes: [],
  };
}

function score(ticket: string, scores: Record<string, number>, results: Record<string, "pass" | "fail"> = { live: "pass", prop: "fail" }): TicketScore {
  return {
    ticket, scoredAt: "2026-11-19T00:00:00Z", baseline: [],
    arms: [arm("a", "pass"), ...Object.entries(results).map(([name, result]) => arm(name, result))], panel: panel(scores),
  };
}

function cal(axis: Axis, preferred: string): CalibrationVerdict {
  return { arms: ["live", "prop"], axis, preferred, reason: "because", by: "op", at: "2026-11-19T00:00:00Z" };
}

// The operators prefer live on correctness and tests, prop on scope.
const CASES: CalibratedCase[] = [{ id: "c1", calibration: [cal("correctness", "live"), cal("tests", "live"), cal("scope", "prop")] }];

describe("promptProposalVerdict", () => {
  // Current prompt: live 4 v prop 3 on every axis → agrees on 2 of 3.
  const current = promptEvidence([score("c1", { live: 4, prop: 3 })], CASES);

  it("reads accuracy, objectives and mean score from first trials only", () => {
    const repeat = { ...score("c1", { live: 1, prop: 5 }, { live: "fail", prop: "fail" }), repeat: 2 };
    const evidence = promptEvidence([score("c1", { live: 4, prop: 3 }), repeat], CASES);
    expect(evidence.accuracy).toEqual({ agree: 2, total: 3, accuracy: 0.67 });
    expect(evidence.objectives).toEqual({
      "c1/a": "held-out none", "c1/live": "held-out ok x.test.ts=pass", "c1/prop": "held-out ok x.test.ts=fail",
    });
    expect(evidence.meanScore).toBe(3.5);
    expect(evidence.cases).toBe(1);
  });

  it("fails a prompt that raises scores but lowers accuracy", () => {
    // Every score up, but prop now wins every axis → agrees on scope alone.
    const proposed = promptEvidence([score("c1", { live: 4, prop: 5 })], CASES);
    expect(proposed.meanScore!).toBeGreaterThan(current.meanScore!);
    const verdict = promptProposalVerdict(current, proposed);
    expect(verdict.pass).toBe(false);
    expect(verdict.conditions.find((c) => c.id === "accuracy-up")).toMatchObject({ pass: false, reason: expect.stringContaining("0.67 → 0.33") });
    expect(verdict.conditions.find((c) => c.id === "scores-alone")).toMatchObject({ pass: true, reason: expect.stringContaining("raising scores alone never passes") });
  });

  it("passes a prompt that raises accuracy with unchanged objectives", () => {
    const proposed: PromptEvidence = { ...current, accuracy: { agree: 3, total: 3, accuracy: 1 } };
    const verdict = promptProposalVerdict(current, proposed);
    expect(verdict.conditions.map((c) => c.id)).toEqual(["calibrated", "same-verdicts", "accuracy-up", "objective-unchanged", "scores-alone"]);
    expect(verdict.pass).toBe(true);
  });

  it("fails a prompt that raises accuracy by contesting the verdicts it got wrong", () => {
    // Same scores as the current prompt, but the panel contests scope, the verdict it disagrees on.
    const contesting = score("c1", { live: 4, prop: 3 });
    contesting.panel = { ...contesting.panel!, contested: [{ axis: "scope", arms: ["live", "prop"], judges: [] }] } as PanelResult;
    const proposed = promptEvidence([contesting], CASES);
    expect(proposed.accuracy).toEqual({ agree: 2, total: 2, accuracy: 1 });
    expect(current.checked).toEqual(["c1/correctness/live|prop", "c1/scope/live|prop", "c1/tests/live|prop"]);
    const verdict = promptProposalVerdict(current, proposed);
    expect(verdict.conditions.find((c) => c.id === "accuracy-up")?.pass).toBe(true);
    expect(verdict.conditions.find((c) => c.id === "same-verdicts")).toMatchObject({
      pass: false, reason: "the current prompt judged 3 verdict(s), the proposed 2; accuracy compares only on the same verdicts",
    });
    expect(verdict.pass).toBe(false);
  });

  it("fails on the same count of different verdicts", () => {
    const proposed: PromptEvidence = { ...current, checked: ["c1/correctness/live|prop", "c1/scope/live|prop", "c2/tests/live|prop"], accuracy: { agree: 3, total: 3, accuracy: 1 } };
    expect(promptProposalVerdict(current, proposed).conditions.find((c) => c.id === "same-verdicts")).toMatchObject({ pass: false, reason: expect.stringContaining("(different ones)") });
  });

  it("refuses an objective change even with accuracy up", () => {
    const proposed = promptEvidence([score("c1", { live: 4, prop: 3 }, { live: "fail", prop: "fail" })], CASES);
    const verdict = promptProposalVerdict(current, { ...proposed, accuracy: { agree: 3, total: 3, accuracy: 1 } });
    expect(verdict.pass).toBe(false);
    expect(verdict.conditions.find((c) => c.id === "objective-unchanged")).toMatchObject({ pass: false, reason: expect.stringContaining("c1/live") });
  });

  it("refuses with no calibration to measure against", () => {
    const none = promptEvidence([score("c1", { live: 4, prop: 3 })], [{ id: "c1" }]);
    const verdict = promptProposalVerdict(none, { ...none, accuracy: { agree: 1, total: 1, accuracy: 1 } });
    expect(verdict.pass).toBe(false);
    expect(verdict.conditions.find((c) => c.id === "calibrated")?.pass).toBe(false);
  });
});

function evalCase(id: string, prs: number[], extra: Partial<EvalCase> = {}): EvalCase {
  return {
    id, repo: "org/app", status: "active", prs: prs.map((number) => ({ number })), ...extra,
  } as unknown as EvalCase;
}

describe("testSetRefusal", () => {
  const withCheck = evalCase("org-app-3", [3], { check: { test: "t.test.ts", base: "fail", reference: "pass", acceptedAt: "-", acceptedBy: "-" } });
  const cases = [evalCase("org-app-1", [1, 2]), withCheck, evalCase("org-app-5", [5], { status: "retired" })];

  it("refuses a case that would edit one holding its PR", () => {
    expect(testSetRefusal("case", { repo: "org/app", prs: [9, 2], reason: "r" }, cases, new Set())).toBe("would edit case org-app-1, which already holds org/app#2");
  });

  it("accepts a new case, and the same PR number in another repo", () => {
    expect(testSetRefusal("case", { repo: "org/app", prs: [9], reason: "r" }, cases, new Set())).toBeNull();
    expect(testSetRefusal("case", { repo: "org/other", prs: [1], reason: "r" }, cases, new Set())).toBeNull();
  });

  it("refuses a check on a case that has one, a missing case or a retired case", () => {
    expect(testSetRefusal("check", { case: "org-app-3", test: "u.test.ts" }, cases, new Set())).toBe("would replace case org-app-3's check; a proposal may only add");
    expect(testSetRefusal("check", { case: "org-app-7", test: "t.test.ts" }, cases, new Set())).toBe("no case org-app-7 in the set");
    expect(testSetRefusal("check", { case: "org-app-5", test: "t.test.ts" }, cases, new Set())).toBe("case org-app-5 is already retired");
  });

  it("accepts a check on an active case with none", () => {
    expect(testSetRefusal("check", { case: "org-app-1", test: "t.test.ts" }, cases, new Set())).toBeNull();
  });

  it("retires only a saturated case", () => {
    expect(testSetRefusal("retire-suggestion", { case: "org-app-1", reason: "r" }, cases, new Set())).toBe("case org-app-1 is not saturated");
    expect(testSetRefusal("retire-suggestion", { case: "org-app-1", reason: "r" }, cases, new Set(["org-app-1"]))).toBeNull();
  });
});

describe("evaluationContent", () => {
  it("refuses a case carrying a graded-only field, naming it", () => {
    expect(evaluationContent("case", { repo: "org/app", prs: [1], reason: "r", heldOut: ["x.test.ts"] }))
      .toEqual({ ok: false, reason: "a test-set proposal may only add; it may not set heldOut" });
    expect(evaluationContent("case", { repo: "org/app", prs: [1], reason: "r", notes: "the answer" }))
      .toEqual({ ok: false, reason: "a test-set proposal may only add; it may not set notes" });
  });

  it("de-duplicates a case's PRs and refuses a bad one", () => {
    expect(evaluationContent("case", { repo: "org/app", prs: [2, 1, 2], reason: "r", tags: ["ui"] }))
      .toEqual({ ok: true, content: { repo: "org/app", prs: [2, 1], reason: "r", tags: ["ui"] } });
    expect(evaluationContent("case", { repo: "org/app", prs: [0], reason: "r" }).ok).toBe(false);
    expect(evaluationContent("case", { repo: "org/app", prs: [], reason: "r" }).ok).toBe(false);
  });

  it("takes a test file on a check, never a command", () => {
    expect(evaluationContent("check", { case: "org-app-1", test: "t.test.ts" })).toEqual({ ok: true, content: { case: "org-app-1", test: "t.test.ts" } });
    const command = { ok: false, reason: "an improver's check may only name a test file; a command check is an operator's" };
    expect(evaluationContent("check", { case: "org-app-1", command: "rm -rf ~" })).toEqual(command);
    expect(evaluationContent("check", { case: "org-app-1", test: "t", command: "c" })).toEqual(command);
    expect(evaluationContent("check", { case: "org-app-1" }).ok).toBe(false);
    expect(evaluationContent("check", { case: "org-app-1", test: "../t" }).ok).toBe(false);
  });

  it("requires non-empty instructions on a prompt and refuses an unknown key", () => {
    expect(evaluationContent("judge-prompt", { instructions: "  " }).ok).toBe(false);
    expect(evaluationContent("analyst-prompt", { instructions: "Read it." })).toEqual({ ok: true, content: { instructions: "Read it." } });
    expect(evaluationContent("judge-prompt", { instructions: "x", extra: 1 })).toEqual({ ok: false, reason: "a judge-prompt proposal has an unknown key extra" });
  });

  it("guards the kinds", () => {
    expect(isPromptKind("judge-prompt") && isTestSetKind("retire-suggestion")).toBe(true);
    expect(isPromptKind("case") || isTestSetKind("analyst-prompt")).toBe(false);
  });
});

describe("checkAcceptance", () => {
  it("refuses a check that passes on the base, in checkCase's words", () => {
    expect(checkAcceptance({ base: { result: "pass" }, reference: { result: "pass" } }, { base: "abcdef0123", reference: "fedcba9876" }))
      .toBe("the check passes on the base (abcdef0); it must fail there");
  });

  it("checks the base's error first and accepts fail-then-pass", () => {
    expect(checkAcceptance({ base: { result: "error", why: "no tree" }, reference: { result: "error", why: "x" } })).toBe("the check cannot run on the base: no tree");
    expect(checkAcceptance({ base: { result: "fail" }, reference: { result: "fail" } })).toBe("the check fails on the reference; it must pass there");
    expect(checkAcceptance({ base: { result: "fail" }, reference: { result: "pass" } })).toBeNull();
  });
});
