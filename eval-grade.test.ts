import { describe, expect, it } from "vitest";

import type { TicketScore } from "./backtest-score";
import { caseGrade, gradeRun } from "./eval-grade";
import { mixedSetReport } from "./fixtures/evals/mixed-set";

const bare = (baseline: TicketScore["baseline"]): TicketScore => ({ ticket: "t-1", scoredAt: "2026-11-19T00:00:00Z", baseline, arms: [] });

describe("caseGrade", () => {
  it("grades by tests when the base fails a held-out file, even with a check", () => {
    const baseline: TicketScore["baseline"] = [{ path: "a.test.ts", result: "pass" }, { path: "b.test.ts", result: "fail" }];
    expect(caseGrade(bare(baseline), false)).toEqual({ case: "t-1", grader: "tests", noEvidence: false });
    expect(caseGrade(bare(baseline), true)).toEqual({ case: "t-1", grader: "tests", noEvidence: false });
  });

  it("grades by the check when no held-out test fails on the base", () => {
    expect(caseGrade(bare([]), true)).toEqual({ case: "t-1", grader: "check", noEvidence: false });
    expect(caseGrade(bare([{ path: "a.test.ts", result: "pass" }]), true)).toEqual({ case: "t-1", grader: "check", noEvidence: true });
  });

  it("is judge-only otherwise, with no evidence only when held-out tests exist and all pass on the base", () => {
    expect(caseGrade(bare([]), false)).toEqual({ case: "t-1", grader: "judge-only", noEvidence: false });
    expect(caseGrade(bare([{ path: "a.test.ts", result: "pass" }]), false)).toEqual({ case: "t-1", grader: "judge-only", noEvidence: true });
  });

  it("keeps the no-evidence flag on a check case whose held-out tests all pass on the base", () => {
    expect(caseGrade(bare([{ path: "a.test.ts", result: "pass" }]), true)).toEqual({ case: "t-1", grader: "check", noEvidence: true });
  });
});

describe("gradeRun", () => {
  it("grades the mixed set: grader per case, objective and judge per arm", () => {
    const grades = gradeRun(mixedSetReport(), ["b", "c"])!;
    expect(grades.cases.map(({ case: id, grader, noEvidence }) => ({ id, grader, noEvidence }))).toEqual([
      { id: "case-tests", grader: "tests", noEvidence: false },
      { id: "case-no-evidence", grader: "judge-only", noEvidence: true },
      { id: "case-judge-only", grader: "judge-only", noEvidence: false },
      { id: "case-check", grader: "check", noEvidence: false },
    ]);
    expect(grades.cases.map((c) => c.arms.map((a) => a.objective))).toEqual([["pass", "fail"], [null, null], [null, null], ["pending", "pending"]]);
    // Pooled over both judges' non-null axes: judge-two leaves b's `review` null on case-tests.
    expect(grades.cases[0]!.arms[0]!.judge).toBeCloseTo(40 / 9);
    expect(grades.cases.map((c) => c.arms[1]!.judge)).toEqual([2, 2.5, 1, 2.5]);
    expect(grades.arms).toEqual([
      { arm: "b", objective: { passed: 1, graded: 1, pending: 1 }, judge: { mean: 4.11, cases: 4 } },
      { arm: "c", objective: { passed: 0, graded: 1, pending: 1 }, judge: { mean: 2, cases: 4 } },
    ]);
  });

  it("grades a check case on each arm's check once scoring ran it (#857); a check that could not run is a fail", () => {
    const report = mixedSetReport();
    report.scores = report.scores!.map((s) => (s.ticket !== "case-check" ? s : {
      ...s,
      arms: s.arms.map((a) => (a.arm === "b" ? { ...a, check: { result: "pass" as const } } : a.arm === "c" ? { ...a, check: { result: "error" as const, why: "timed out after 10 min" } } : a)),
    }));
    const grades = gradeRun(report, ["b", "c"])!;
    expect(grades.cases.find((entry) => entry.case === "case-check")!.arms.map((a) => a.objective)).toEqual(["pass", "fail"]);
    expect(grades.arms.map((a) => a.objective)).toEqual([{ passed: 2, graded: 2, pending: 0 }, { passed: 0, graded: 2, pending: 0 }]);
  });

  it("skips the reference arm and keeps the given arm order", () => {
    const grades = gradeRun(mixedSetReport(), ["c", "a", "b"])!;
    expect(grades.arms.map((a) => a.arm)).toEqual(["c", "b"]);
    expect(grades.cases[0]!.arms.map((a) => a.arm)).toEqual(["c", "b"]);
  });

  it("grades nothing objective for a trial that never ran: an infrastructure failure is not the arm failing", () => {
    const report = mixedSetReport();
    report.rows = report.rows.map((row) => (row.arm === "c" && (row.ticket === "case-tests" || row.ticket === "case-check") ? { ...row, outcome: "not-run" as const } : row));
    const grades = gradeRun(report, ["b", "c"])!;
    expect(grades.cases.find((entry) => entry.case === "case-tests")!.arms[1]!.objective).toBeNull();
    expect(grades.cases.find((entry) => entry.case === "case-check")!.arms[1]!.objective).toBeNull();
    expect(grades.arms[1]!.objective).toEqual({ passed: 0, graded: 0, pending: 0 });
    expect(grades.arms[0]!.objective).toEqual({ passed: 1, graded: 1, pending: 1 });
  });

  it("does not count a case for an arm with no score in it, and a missing panel is no judge score", () => {
    const report = mixedSetReport();
    report.scores = report.scores!.map((s) => (s.ticket === "case-tests" ? { ...s, arms: s.arms.filter((a) => a.arm !== "c"), panel: null } : s));
    const grades = gradeRun(report, ["b", "c"])!;
    expect(grades.cases[0]!.arms).toEqual([{ arm: "b", objective: "pass", judge: null }, { arm: "c", objective: null, judge: null }]);
    expect(grades.arms[1]).toEqual({ arm: "c", objective: { passed: 0, graded: 0, pending: 1 }, judge: { mean: 2, cases: 3 } });
  });

  it("fails a tests case whose held-out tests did not apply on the arm", () => {
    const report = mixedSetReport();
    report.scores![0]!.arms[1]!.heldOut = { status: "not-applicable", reason: "the patch did not apply" };
    expect(gradeRun(report, ["b", "c"])!.arms[0]!.objective).toEqual({ passed: 0, graded: 1, pending: 1 });
  });

  it("is null on a run that is not a test-set run, or one not scored", () => {
    const { set: _set, ...notSet } = mixedSetReport();
    expect(gradeRun(notSet, ["b", "c"])).toBeNull();
    expect(gradeRun({ ...mixedSetReport(), scores: [] }, ["b", "c"])).toBeNull();
    expect(gradeRun({ set: mixedSetReport().set, rows: [] }, ["b", "c"])).toBeNull();
  });

  it("never blends the objective result with the judge score", () => {
    const grades = gradeRun(mixedSetReport(), ["b", "c"]);
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (typeof value !== "object" || value === null) return;
      for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); }
    };
    walk(grades);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => /blend|combin|overall|total|weighted/i.test(key))).toEqual([]);
    for (const arm of grades!.arms) expect(Object.keys(arm).sort()).toEqual(["arm", "judge", "objective"]);
  });
});
