import { describe, expect, it } from "vitest";

import type { EvalCaseArmView, EvalCaseView, EvalRunSummary } from "./eval-runs";
import { caseSaturation, DEFAULT_SATURATION_RUNS, saturationById, saturationSettings } from "./eval-saturation";

type Objective = EvalCaseArmView["objective"];

function arm(id: string, objective: Objective): EvalCaseArmView {
  return { arm: id, outcome: null, gates: null, heldOut: null, findings: null, rounds: null, wallSeconds: null, tokens: null, costUsd: null, axes: [], objective, judge: null };
}

/** A graded case view: the reference "a" plus agent arms with the objective results given. */
function objectiveCase(key: string, results: Record<string, Objective>, grader: "tests" | "check" = "tests"): EvalCaseView {
  return {
    key, title: key, repo: "o/r", prs: [], reference: "person",
    arms: [arm("a", null), ...Object.entries(results).map(([id, o]) => arm(id, o))],
    ranking: null, judges: [], contested: [], contestedRule: null,
    grade: { grader, noEvidence: false },
  };
}

function judgeCase(key: string, agents: string[], ranking: string[][] | null): EvalCaseView {
  return { ...objectiveCase(key, Object.fromEntries(agents.map((id) => [id, null]))), ranking, grade: { grader: "judge-only", noEvidence: false } };
}

let seq = 0;
function run(startedAt: string, cases: EvalCaseView[], extra: Partial<EvalRunSummary> = {}): EvalRunSummary {
  seq += 1;
  return {
    id: `run-${seq}`, dir: `/tmp/run-${seq}`, kind: "eval", startedAt, finishedAt: startedAt, running: false, stoppedBy: null,
    source: { kind: "set", version: null, tags: [], cases: cases.map((c) => c.key), unrunnable: [] },
    arms: [], panel: [], resolved: null, repeats: 1, cases, totals: [], repeated: [], analysis: null,
    noise: null, noiseFloor: null, guardrails: null, judgeAccuracy: null, problem: null,
    ...extra,
  };
}

const day = (d: number): string => `2026-11-${String(d).padStart(2, "0")}T10:00:00.000Z`;
const pass = (d: number, key = "c1"): EvalRunSummary => run(day(d), [objectiveCase(key, { b: "pass", c: "pass" })]);
const fail = (d: number, key = "c1"): EvalRunSummary => run(day(d), [objectiveCase(key, { b: "pass", c: "fail" })]);
const window = { window: DEFAULT_SATURATION_RUNS };

describe("caseSaturation", () => {
  it("defaults to three runs", () => {
    expect(DEFAULT_SATURATION_RUNS).toBe(3);
  });

  it("is saturated after N full passes", () => {
    expect(caseSaturation("c1", [pass(1), pass(2), pass(3)], window)).toEqual({ saturated: true, passes: 3, window: 3 });
  });

  it("is cleared by one fail inside the window, counting passes from the newest", () => {
    expect(caseSaturation("c1", [pass(1), fail(2), pass(3)], window)).toEqual({ saturated: false, passes: 1, window: 3 });
    expect(caseSaturation("c1", [pass(1), pass(2), fail(3)], window)).toEqual({ saturated: false, passes: 0, window: 3 });
  });

  it("ignores a fail older than the window", () => {
    expect(caseSaturation("c1", [fail(1), pass(2), pass(3), pass(4)], window).saturated).toBe(true);
  });

  it("is not saturated with fewer than N counted runs", () => {
    expect(caseSaturation("c1", [pass(1), pass(2)], window)).toEqual({ saturated: false, passes: 2, window: 3 });
    expect(caseSaturation("c1", [], window)).toEqual({ saturated: false, passes: 0, window: 3 });
  });

  it("does not count pending or null objectives as a pass", () => {
    for (const objective of ["pending", null] as const) {
      const runs = [pass(1), pass(2), run(day(3), [objectiveCase("c1", { b: "pass", c: objective })])];
      expect(caseSaturation("c1", runs, window).saturated).toBe(false);
    }
  });

  it("grades check cases by the objective too", () => {
    const runs = [1, 2, 3].map((d) => run(day(d), [objectiveCase("c1", { b: "pass" }, "check")]));
    expect(caseSaturation("c1", runs, window).saturated).toBe(true);
  });

  it("needs at least one agent arm", () => {
    const runs = [1, 2, 3].map((d) => run(day(d), [objectiveCase("c1", {})]));
    expect(caseSaturation("c1", runs, window).saturated).toBe(false);
  });

  it("passes a judge-only case ranked at or above the reference", () => {
    const runs = [
      run(day(1), [judgeCase("c1", ["b", "c"], [["b"], ["a", "c"]])]),
      run(day(2), [judgeCase("c1", ["b", "c"], [["b", "c", "a"]])]),
      run(day(3), [judgeCase("c1", ["b", "c"], [["c"], ["b"], ["a"]])]),
    ];
    expect(caseSaturation("c1", runs, window).saturated).toBe(true);
  });

  it("fails a judge-only case with an arm below the reference or no ranking", () => {
    const base = [pass(1), pass(2)];
    expect(caseSaturation("c1", [...base, run(day(3), [judgeCase("c1", ["b", "c"], [["b"], ["a"], ["c"]])])], window).saturated).toBe(false);
    expect(caseSaturation("c1", [...base, run(day(3), [judgeCase("c1", ["b"], null)])], window).saturated).toBe(false);
  });

  it("fails a judge-only case whose ranking leaves out the reference or an arm", () => {
    const base = [pass(1), pass(2)];
    expect(caseSaturation("c1", [...base, run(day(3), [judgeCase("c1", ["b", "c"], [["b"], ["c"]])])], window).saturated).toBe(false);
    expect(caseSaturation("c1", [...base, run(day(3), [judgeCase("c1", ["b", "c"], [["b"], ["a"]])])], window).saturated).toBe(false);
  });

  it("ignores running runs, non-set runs, runs without the case and ungraded views", () => {
    const running = run(day(4), [objectiveCase("c1", { b: "fail" })], { running: true });
    const pr = run(day(5), [objectiveCase("c1", { b: "fail" })], { source: { kind: "pr", repo: "o/r", prs: [1], ticket: null } });
    const other = run(day(6), [objectiveCase("c2", { b: "fail" })]);
    const ungraded = run(day(7), [{ ...objectiveCase("c1", { b: "fail" }), grade: null }]);
    expect(caseSaturation("c1", [pass(1), pass(2), pass(3), running, pr, other, ungraded], window).saturated).toBe(true);
    expect(caseSaturation("c1", [pass(1), pass(2), running], window).saturated).toBe(false);
  });

  it("counts only runs after keptAt", () => {
    const runs = [pass(1), pass(2), pass(3), pass(4), pass(5)];
    expect(caseSaturation("c1", runs, { window: 3, keptAt: day(3) })).toEqual({ saturated: false, passes: 2, window: 3 });
    expect(caseSaturation("c1", [...runs, pass(6)], { window: 3, keptAt: day(3) }).saturated).toBe(true);
    expect(caseSaturation("c1", [fail(1), ...runs.slice(1)], { window: 3, keptAt: day(1) }).saturated).toBe(true);
  });

  it("orders runs by startedAt, not input order", () => {
    expect(caseSaturation("c1", [pass(4), fail(1), pass(3), pass(2)], window).saturated).toBe(true);
    expect(caseSaturation("c1", [pass(1), pass(2), fail(4), pass(3)], window)).toEqual({ saturated: false, passes: 0, window: 3 });
  });

  it("honours a window other than the default", () => {
    expect(caseSaturation("c1", [fail(1), pass(2)], { window: 1 }).saturated).toBe(true);
    expect(caseSaturation("c1", [pass(1), pass(2), pass(3)], { window: 4 }).saturated).toBe(false);
  });

  it("rejects a window that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => caseSaturation("c1", [], { window: bad })).toThrow(/positive integer/);
    }
  });
});

describe("saturationById", () => {
  it("computes each case with its own keptAt", () => {
    const runs = [1, 2, 3].map((d) => run(day(d), [objectiveCase("c1", { b: "pass" }), objectiveCase("c2", { b: "pass" })]));
    const out = saturationById([{ id: "c1" }, { id: "c2", keptAt: day(1) }, { id: "c3" }], runs, 3);
    expect(out.get("c1")).toEqual({ saturated: true, passes: 3, window: 3 });
    expect(out.get("c2")).toEqual({ saturated: false, passes: 2, window: 3 });
    expect(out.get("c3")).toEqual({ saturated: false, passes: 0, window: 3 });
  });

  it("rejects a bad window even with no cases", () => {
    expect(() => saturationById([], [], 0)).toThrow(/positive integer/);
  });
});

describe("saturationSettings", () => {
  it("fills the default window and keeps a configured one", () => {
    expect(saturationSettings({})).toEqual({ runs: DEFAULT_SATURATION_RUNS });
    expect(saturationSettings({ evalsSaturation: {} })).toEqual({ runs: 3 });
    expect(saturationSettings({ evalsSaturation: { runs: 5 } })).toEqual({ runs: 5 });
  });
});
