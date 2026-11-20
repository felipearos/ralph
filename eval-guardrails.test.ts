import { describe, expect, test } from "vitest";
import type { ArmConfig } from "./backtest";
import {
  baselinePair,
  DEFAULT_MAX_COST_RISE,
  DEFAULT_MIN_TOKEN_CUT,
  guardrailSettings,
  reportGuardrails,
  stampGuardrails,
  type GuardrailCondition,
  type GuardrailGoal,
  type GuardrailThresholds,
  type GuardrailVerdict,
} from "./eval-guardrails";
import type { FloorState, NoiseStatus } from "./eval-noise-floor";
import { guardrailReport, GUARDRAIL_ARMS, tokens, type GuardrailCase } from "./fixtures/evals/guardrail-arms";

const DEFAULTS: GuardrailThresholds = { maxCostRise: DEFAULT_MAX_COST_RISE, minTokenCut: DEFAULT_MIN_TOKEN_CUT };

function status(spread: { objective: number | null; judge: number | null } = { objective: 0.25, judge: 0.5 }, state: FloorState = "fresh"): NoiseStatus {
  if (state === "missing") return { state, floor: null, drift: null, staleShare: 0.2 };
  return {
    state,
    floor: { version: "v", measuredAt: "2026-11-19T04:00:00Z", runId: "floor-run", spread },
    drift: { added: 0, retired: 0, share: 0 },
    staleShare: 0.2,
  };
}

/**
 * The proposal that earns both goals: it passes a case the baseline fails
 * (objective 0.5 → 1, gap 0.5), keeps every case, scores 4.5 to 4 with the
 * judge, and spends 800 tokens to 1000.
 */
function good(): GuardrailCase[] {
  return [
    { id: "case-kept", live: { result: "pass" }, proposal: { result: "pass", judge: 5, tokens: tokens(800) } },
    { id: "case-won", live: { result: "fail" }, proposal: { result: "pass", tokens: tokens(800) } },
  ];
}

function verdict(cases: GuardrailCase[], floor = status(), thresholds = DEFAULTS): GuardrailVerdict {
  const result = reportGuardrails(guardrailReport(cases), floor, thresholds);
  expect(result).not.toBeNull();
  return result!;
}

function condition(result: GuardrailVerdict, goal: GuardrailGoal, id: string): GuardrailCondition {
  const found = result.goals.find((entry) => entry.goal === goal)?.conditions.find((entry) => entry.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe("guardrailSettings", () => {
  test("fills the defaults", () => {
    expect(guardrailSettings({})).toEqual({ maxCostRise: 0.15, minTokenCut: 0.10 });
    expect(guardrailSettings({ evalsGuardrails: {} })).toEqual({ maxCostRise: 0.15, minTokenCut: 0.10 });
  });

  test("takes the project's overrides one by one", () => {
    expect(guardrailSettings({ evalsGuardrails: { maxCostRise: 0.3 } })).toEqual({ maxCostRise: 0.3, minTokenCut: 0.10 });
    expect(guardrailSettings({ evalsGuardrails: { minTokenCut: 0.2 } })).toEqual({ maxCostRise: 0.15, minTokenCut: 0.2 });
  });
});

describe("baselinePair", () => {
  const live = (name: string): ArmConfig => ({ name, lineup: "live", overlay: null });
  const overlay = (name: string): ArmConfig => ({ name, lineup: "live", overlay: "overlays/x.md" });

  test("the one live arm is the baseline, the other the proposal, whatever the order", () => {
    expect(baselinePair([overlay("p"), live("l")])).toEqual({ baseline: "l", proposal: "p" });
    expect(baselinePair([live("l"), { name: "c", lineup: "codex", overlay: null }])).toEqual({ baseline: "l", proposal: "c" });
  });

  test("ignores the reference arm a", () => {
    expect(baselinePair([live("a"), live("l"), overlay("p")])).toEqual({ baseline: "l", proposal: "p" });
  });

  test("null with both arms live, neither live, three arms or one", () => {
    expect(baselinePair([live("l"), live("m")])).toBeNull();
    expect(baselinePair([overlay("p"), { name: "c", lineup: "codex", overlay: null }])).toBeNull();
    expect(baselinePair([live("l"), overlay("p"), overlay("q")])).toBeNull();
    expect(baselinePair([live("l")])).toBeNull();
    expect(baselinePair([live("a"), live("l")])).toBeNull();
  });
});

describe("reportGuardrails", () => {
  test("a proposal that earns both goals passes every condition, in order", () => {
    const result = verdict(good());
    expect(result.baseline).toBe("live");
    expect(result.proposal).toBe("proposal");
    expect(result.goals.map((goal) => [goal.goal, goal.pass, goal.conditions.map((c) => [c.id, c.pass])])).toEqual([
      ["quality", true, [["all-cases-ran", true], ["objective-up", true], ["no-regressions", true], ["judge-not-down", true], ["cost-within", true]]],
      ["cost", true, [["all-cases-ran", true], ["tokens-down", true], ["no-regressions", true], ["objective-not-down", true], ["judge-within-floor", true]]],
    ]);
  });

  test("null without a baseline pair or a graded set run", () => {
    expect(reportGuardrails(guardrailReport(good(), [GUARDRAIL_ARMS[0]!, { name: "proposal", lineup: "live", overlay: null }]), status(), DEFAULTS)).toBeNull();
    const { set: _set, ...unset } = guardrailReport(good());
    expect(reportGuardrails(unset, status(), DEFAULTS)).toBeNull();
    expect(reportGuardrails({ ...guardrailReport(good()), scores: [] }, status(), DEFAULTS)).toBeNull();
  });
});

describe("quality goal", () => {
  test("objective-up fails when the objective score does not rise", () => {
    const cases: GuardrailCase[] = [{ id: "case-kept", live: { result: "pass" }, proposal: { result: "pass" } }];
    const result = verdict(cases);
    expect(condition(result, "quality", "objective-up")).toMatchObject({ pass: false, reason: "objective score 0, not beyond the noise floor 0.25" });
    expect(result.goals[0]!.pass).toBe(false);
  });

  test("objective-up fails at a gap exactly on the floor and passes just above it", () => {
    const atFloor = condition(verdict(good(), status({ objective: 0.5, judge: 0.5 })), "quality", "objective-up");
    expect(atFloor.pass).toBe(false);
    expect(atFloor.reason).toContain("not beyond the noise floor 0.5");
    expect(condition(verdict(good(), status({ objective: 0.49, judge: 0.5 })), "quality", "objective-up").pass).toBe(true);
  });

  test("a missing or stale floor fails objective-up and the goal, the rest still reported", () => {
    for (const floor of [status(undefined, "missing"), status(undefined, "stale"), status({ objective: null, judge: 0.5 })]) {
      const result = verdict(good(), floor);
      const up = condition(result, "quality", "objective-up");
      expect(up.pass).toBe(false);
      expect(up.reason).toContain("remeasure the noise floor");
      expect(result.goals[0]!.pass).toBe(false);
      expect(result.goals[0]!.conditions).toHaveLength(5);
      expect(condition(result, "quality", "cost-within").pass).toBe(true);
    }
  });

  test("objective-up compares the arms on the cases both decided, never on a case the proposal skipped", () => {
    // Baseline 1 of 2, proposal 1 of 1: unpaired that is +0.5, beyond the 0.25 floor; paired it is level.
    const skipped: GuardrailCase[] = [
      { id: "case-kept", live: { result: "pass" }, proposal: { result: "pass" } },
      { id: "case-skipped", live: { result: "fail" }, proposal: { ran: false } },
    ];
    expect(condition(verdict(skipped), "quality", "objective-up")).toMatchObject({ pass: false, reason: expect.stringContaining("objective score 0,") });
  });

  test("cost-within uses tokens when any USD is only an estimate", () => {
    // Estimated USD would read the proposal as 10% dearer; its tokens are 50% more, past the cap.
    const estimated = good().map((spec, i) => ({
      ...spec,
      live: { ...spec.live, usd: 1, tokens: tokens(1000), ...(i === 0 ? { usdSource: "estimated" as const } : {}) },
      proposal: { ...spec.proposal, usd: 1.1, tokens: tokens(1500) },
    }));
    expect(condition(verdict(estimated), "quality", "cost-within")).toMatchObject({ pass: false, reason: expect.stringContaining("tokens 2000 → 3000") });
  });

  test("no-regressions names every case the proposal loses: a fail, or a trial that never ran", () => {
    const cases: GuardrailCase[] = [
      ...good(),
      { id: "case-lost", live: { result: "pass" }, proposal: { result: "fail" } },
      { id: "case-unrun", live: { result: "pass" }, proposal: { result: "pass", ran: false } },
    ];
    const result = verdict(cases);
    for (const goal of ["quality", "cost"] as const) {
      const lost = condition(result, goal, "no-regressions");
      expect(lost.pass).toBe(false);
      expect(lost.reason).toContain("case-lost, case-unrun");
    }
    expect(condition(verdict(good()), "quality", "no-regressions")).toMatchObject({ pass: true });
  });

  test("judge-not-down fails when the judge score falls, and with no judge scores", () => {
    const down = good().map((spec) => ({ ...spec, proposal: { ...spec.proposal, judge: 3.9 } }));
    expect(condition(verdict(down), "quality", "judge-not-down")).toMatchObject({ pass: false, reason: "judge score down -0.1" });
    const unjudged = good().map((spec) => ({ ...spec, live: { ...spec.live, judge: null } }));
    expect(condition(verdict(unjudged), "quality", "judge-not-down")).toMatchObject({ pass: false, reason: "no judge scores to compare" });
    const level = good().map((spec) => ({ ...spec, proposal: { ...spec.proposal, judge: 4 } }));
    expect(condition(verdict(level), "quality", "judge-not-down").pass).toBe(true);
  });

  test("cost-within compares USD when every first trial has it", () => {
    const priced = (live: number, proposal: number): GuardrailCase[] =>
      good().map((spec) => ({ ...spec, live: { ...spec.live, usd: live }, proposal: { ...spec.proposal, usd: proposal, tokens: tokens(100_000) } }));
    // The proposal spends far more tokens, but USD is what is compared.
    const atCap = condition(verdict(priced(1, 1.15)), "quality", "cost-within");
    expect(atCap.pass).toBe(true);
    expect(atCap.reason).toContain("USD 2 → 2.3 (+15%)");
    const over = condition(verdict(priced(1, 1.2)), "quality", "cost-within");
    expect(over.pass).toBe(false);
    expect(over.reason).toContain("+20%");
  });

  test("cost-within falls back to tokens when one trial lacks USD", () => {
    const partly = good().map((spec, i) => ({ ...spec, live: { ...spec.live, usd: 1 }, proposal: { ...spec.proposal, usd: i === 0 ? 1 : null } }));
    const cost = condition(verdict(partly), "quality", "cost-within");
    expect(cost.pass).toBe(true);
    expect(cost.reason).toContain("tokens 2000 → 1600 (-20%)");
    const dear = good().map((spec) => ({ ...spec, proposal: { ...spec.proposal, tokens: tokens(1000, 200) } }));
    expect(condition(verdict(dear), "quality", "cost-within")).toMatchObject({ pass: false, reason: expect.stringContaining("+20%") });
  });

  test("cost-within fails when neither USD nor tokens are metered", () => {
    const unmetered = good().map((spec, i) => ({ ...spec, live: { ...spec.live, tokens: i === 0 ? null : tokens(1000) } }));
    expect(condition(verdict(unmetered), "quality", "cost-within")).toMatchObject({ pass: false, reason: expect.stringContaining("cost not metered") });
  });

  test("a zero baseline cost passes only a zero proposal cost", () => {
    const free = (proposal: number): GuardrailCase[] =>
      good().map((spec) => ({ ...spec, live: { ...spec.live, usd: 0 }, proposal: { ...spec.proposal, usd: proposal } }));
    expect(condition(verdict(free(0)), "quality", "cost-within").pass).toBe(true);
    expect(condition(verdict(free(0.01)), "quality", "cost-within").pass).toBe(false);
  });
});

describe("cost goal", () => {
  test("tokens-down passes at exactly the required cut and fails short of it", () => {
    const spend = (proposal: number): GuardrailCase[] => good().map((spec) => ({ ...spec, proposal: { ...spec.proposal, tokens: tokens(proposal) } }));
    expect(condition(verdict(spend(900)), "cost", "tokens-down")).toMatchObject({ pass: true, reason: expect.stringContaining("tokens 2000 → 1800 (-10%)") });
    expect(condition(verdict(spend(901)), "cost", "tokens-down").pass).toBe(false);
  });

  test("tokens-down compares spend on the cases both arms ran, never on a case the proposal skipped", () => {
    // The proposal never ran the case the baseline failed: without the pairing its 800 against 2000 would read as a cut.
    const skipped: GuardrailCase[] = [
      { id: "case-kept", live: { result: "pass" }, proposal: { result: "pass", tokens: tokens(1000) } },
      { id: "case-skipped", live: { result: "fail" }, proposal: { ran: false, tokens: tokens(0) } },
    ];
    expect(condition(verdict(skipped), "cost", "tokens-down")).toMatchObject({ pass: false, reason: expect.stringContaining("tokens 1000 → 1000") });
  });

  test("all-cases-ran fails both goals when a selected case did not run on an arm", () => {
    const skipped: GuardrailCase[] = [...good(), { id: "case-skipped", live: { result: "fail" }, proposal: { ran: false } }];
    const result = verdict(skipped);
    for (const goal of ["quality", "cost"] as const) {
      expect(condition(result, goal, "all-cases-ran")).toMatchObject({ pass: false, reason: "1 of 3 case(s) did not run on both arms: case-skipped" });
    }
    expect(result.goals.every((goal) => !goal.pass)).toBe(true);
  });

  test("tokens-down fails when a trial is unmetered", () => {
    const unmetered = good().map((spec, i) => ({ ...spec, proposal: { ...spec.proposal, tokens: i === 0 ? null : tokens(10) } }));
    expect(condition(verdict(unmetered), "cost", "tokens-down")).toMatchObject({ pass: false, reason: expect.stringContaining("not metered") });
  });

  test("objective-not-down passes a level objective score and fails a lower one", () => {
    const level: GuardrailCase[] = [{ id: "case-kept", live: { result: "pass" }, proposal: { result: "pass", tokens: tokens(800) } }];
    expect(condition(verdict(level), "cost", "objective-not-down").pass).toBe(true);
    const lower: GuardrailCase[] = [
      { id: "case-kept", live: { result: "pass" }, proposal: { result: "pass", tokens: tokens(800) } },
      { id: "case-lost", live: { result: "pass" }, proposal: { result: "fail", tokens: tokens(800) } },
    ];
    expect(condition(verdict(lower), "cost", "objective-not-down")).toMatchObject({ pass: false, reason: "objective score down -0.5" });
  });

  test("judge-within-floor passes a fall exactly at the floor and fails one just past it", () => {
    // Every case scored 3.5 against the baseline's 4: a judge gap of -0.5.
    const lower = good().map((spec) => ({ ...spec, proposal: { ...spec.proposal, judge: 3.5 } }));
    expect(condition(verdict(lower, status({ objective: 0.25, judge: 0.5 })), "cost", "judge-within-floor").pass).toBe(true);
    const past = condition(verdict(lower, status({ objective: 0.25, judge: 0.49 })), "cost", "judge-within-floor");
    expect(past.pass).toBe(false);
    expect(past.reason).toContain("down past the noise floor 0.49");
  });

  test("judge-within-floor fails with no judge scores", () => {
    const unjudged = good().map((spec) => ({ ...spec, proposal: { ...spec.proposal, judge: null } }));
    expect(condition(verdict(unjudged), "cost", "judge-within-floor")).toMatchObject({ pass: false, reason: "no judge scores to compare" });
  });

  test("a missing or stale floor fails judge-within-floor and the goal", () => {
    for (const floor of [status(undefined, "missing"), status(undefined, "stale"), status({ objective: 0.25, judge: null })]) {
      const result = verdict(good(), floor);
      expect(condition(result, "cost", "judge-within-floor").reason).toContain("remeasure the noise floor");
      expect(result.goals[1]!.pass).toBe(false);
      expect(condition(result, "cost", "tokens-down").pass).toBe(true);
    }
  });
});

describe("stampGuardrails", () => {
  const noise = { ...status(), gaps: [] };

  test("stamps a set run that carries its noise, against that noise status", () => {
    const stamped = stampGuardrails({ ...guardrailReport(good()), noise }, DEFAULTS);
    expect(stamped.guardrails?.goals.every((goal) => goal.pass)).toBe(true);
  });

  test("drops an earlier stamp a rescore no longer earns, and stamps nothing without noise or on a floor run", () => {
    const earlier = stampGuardrails({ ...guardrailReport(good()), noise }, DEFAULTS).guardrails!;
    expect(stampGuardrails({ ...guardrailReport(good()), guardrails: earlier }, DEFAULTS).guardrails).toBeUndefined();
    expect(stampGuardrails({ ...guardrailReport(good()), noise, noiseFloor: { measuredAt: "2026-11-19T04:00:00Z" } }, DEFAULTS).guardrails).toBeUndefined();
    const twoLive = guardrailReport(good(), [GUARDRAIL_ARMS[0]!, { name: "proposal", lineup: "live", overlay: null }]);
    expect(stampGuardrails({ ...twoLive, noise, guardrails: earlier }, DEFAULTS).guardrails).toBeUndefined();
  });
});
