import { describe, expect, it } from "vitest";

import { PLAN_OPS, SECTION_HEADINGS, parsePlan } from "./plan";

const plan = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    unit: 12,
    loop: "ralph",
    attempt: 1,
    outcome: "routed",
    ops: [{ op: "add-label", opId: "a1", issue: 12, label: "ready-for-agent" }],
    ...overrides,
  });

const problemsOf = (text: string, source?: string): string[] => {
  const parsed = parsePlan(text, source);
  if (!("problems" in parsed)) throw new Error("expected problems");
  return parsed.problems;
};

const planOf = (text: string) => {
  const parsed = parsePlan(text);
  if (!("plan" in parsed)) throw new Error(`expected a plan, got ${parsed.problems.join("; ")}`);
  return parsed.plan;
};

describe("parsePlan", () => {
  it("accepts a well-formed plan", () => {
    expect(planOf(plan()).ops).toHaveLength(1);
  });

  it("refuses text that is not JSON, without throwing", () => {
    expect(problemsOf("{not json")).toHaveLength(1);
    expect(problemsOf("{not json")[0]).toContain("not valid JSON");
  });

  it("refuses a JSON array at the root", () => {
    expect(problemsOf("[]")[0]).toContain("must be a JSON object");
  });

  it("reports EVERY problem, not only the first", () => {
    const problems = problemsOf(
      plan({ unit: 0, loop: "Ralph", attempt: 0, outcome: "invented" }),
    );
    expect(problems.some((p) => p.startsWith("unit:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("loop:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("attempt:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("outcome:"))).toBe(true);
  });

  it("prefixes problems with the source when one is given", () => {
    expect(problemsOf(plan({ unit: 0 }), "triage-plan-12.json")[0]).toBe(
      "triage-plan-12.json: unit: must be a positive integer issue number",
    );
  });

  it("refuses an unknown top-level key", () => {
    expect(problemsOf(plan({ apply: true }))[0]).toContain("is not a plan field");
  });

  it("refuses an unknown key inside an op, so a typo'd field is not silently dropped", () => {
    const problems = problemsOf(
      plan({ ops: [{ op: "close", opId: "c1", issue: 12, evidenc: { kind: "duplicate-of", issue: 3 } }] }),
    );
    expect(problems).toContain("ops[0].evidenc: is not a field of close");
    expect(problems.some((p) => p.includes("evidence: is required"))).toBe(true);
  });

  it("refuses an empty ops array", () => {
    expect(problemsOf(plan({ ops: [] }))[0]).toContain("non-empty array");
  });

  it("refuses an op name outside the vocabulary", () => {
    expect(problemsOf(plan({ ops: [{ op: "unwedge", opId: "u1", issue: 12 }] }))[0]).toContain(
      "must be one of",
    );
  });

  it("offers unblock, and parses it as a label op", () => {
    expect(PLAN_OPS).toContain("unblock");
    const parsed = planOf(plan({ ops: [{ op: "unblock", opId: "u1", issue: 12, label: "rafa-blocked" }] }));
    expect(parsed.ops[0]).toEqual({ op: "unblock", opId: "u1", issue: 12, label: "rafa-blocked" });
  });

  it("refuses an unblock with no label, a bad issue, or a field it does not own", () => {
    expect(problemsOf(plan({ ops: [{ op: "unblock", opId: "u1", issue: 12 }] }))[0]).toContain(
      "must be a non-empty label name",
    );
    expect(
      problemsOf(plan({ ops: [{ op: "unblock", opId: "u1", issue: 0, label: "rafa-blocked" }] })).some((problem) =>
        problem.includes("positive integer issue number"),
      ),
    ).toBe(true);
    expect(
      problemsOf(
        plan({ ops: [{ op: "unblock", opId: "u1", issue: 12, label: "rafa-blocked", reason: "because" }] }),
      )[0],
    ).toContain("is not a field of unblock");
  });

  it("parses the keyed intake's propose and to-person, and their outcomes", () => {
    const propose = { op: "propose", opId: "p1", issue: 12, body: "## What to build\n\nA thing.\n" };
    expect(planOf(plan({ outcome: "propose", ops: [propose] })).ops[0]).toEqual(propose);
    const toPerson = { op: "to-person", opId: "t1", issue: 12, reason: "Falta el criterio de aceptación." };
    const parsed = planOf(plan({ outcome: "to-person", ops: [toPerson] }));
    expect(parsed.outcome).toBe("to-person");
    expect(parsed.ops[0]).toEqual(toPerson);
  });

  it("refuses a propose with a missing or empty body, or a field it does not own", () => {
    expect(problemsOf(plan({ ops: [{ op: "propose", opId: "p1", issue: 12 }] }))).toEqual([
      "ops[0].body: must be a non-empty string",
    ]);
    expect(problemsOf(plan({ ops: [{ op: "propose", opId: "p1", issue: 12, body: "  " }] }))).toEqual([
      "ops[0].body: must be a non-empty string",
    ]);
    expect(
      problemsOf(plan({ ops: [{ op: "propose", opId: "p1", issue: 12, body: "x", label: "agent-proposed" }] })),
    ).toEqual(["ops[0].label: is not a field of propose"]);
  });

  it("refuses a to-person reason that is empty, two lines, over 300 characters, or a field it does not own", () => {
    const toPerson = (extra: Record<string, unknown>) =>
      problemsOf(plan({ ops: [{ op: "to-person", opId: "t1", issue: 12, ...extra }] }));
    expect(toPerson({ reason: "" })).toEqual(["ops[0].reason: must be a non-empty string"]);
    expect(toPerson({ reason: "Una línea.\nOtra línea." })).toEqual(["ops[0].reason: must be one line"]);
    expect(toPerson({ reason: "Una línea.\r" })).toEqual(["ops[0].reason: must be one line"]);
    expect(toPerson({ reason: "x".repeat(301) })).toEqual(["ops[0].reason: must be at most 300 characters"]);
    expect(planOf(plan({ ops: [{ op: "to-person", opId: "t1", issue: 12, reason: "x".repeat(300) }] })).ops)
      .toHaveLength(1);
    expect(toPerson({ reason: "Falta contexto.", body: "x" })).toEqual(["ops[0].body: is not a field of to-person"]);
  });

  it("refuses a repeated op id, which is the replay key", () => {
    const problems = problemsOf(
      plan({
        ops: [
          { op: "add-label", opId: "a1", issue: 12, label: "spec" },
          { op: "remove-label", opId: "a1", issue: 12, label: "ready-for-agent" },
        ],
      }),
    );
    expect(problems[0]).toContain("repeats a1");
  });

  it("refuses an op id outside the marker charset", () => {
    expect(problemsOf(plan({ ops: [{ op: "comment", opId: "a 1", issue: 12, body: "hi" }] }))[0]).toContain(
      "opId",
    );
  });

  it("accepts every declared section heading and refuses any other", () => {
    for (const heading of SECTION_HEADINGS) {
      const text = plan({
        ops: [{ op: "set-section", opId: "s1", issue: 12, heading, mode: "replace", body: "x" }],
      });
      expect("plan" in parsePlan(text)).toBe(true);
    }
    const bad = plan({
      ops: [{ op: "set-section", opId: "s1", issue: 12, heading: "Why", mode: "replace", body: "x" }],
    });
    expect(problemsOf(bad)[0]).toContain("heading");
  });

  it("allows an empty replace body but refuses an empty append body", () => {
    const replace = plan({
      ops: [{ op: "set-section", opId: "s1", issue: 12, heading: "Parent", mode: "replace", body: "" }],
    });
    expect("plan" in parsePlan(replace)).toBe(true);
    const append = plan({
      ops: [{ op: "set-section", opId: "s1", issue: 12, heading: "Parent", mode: "append", body: "  " }],
    });
    expect(problemsOf(append)[0]).toContain("non-empty to append");
  });

  it("resolves a blockedBy ref against a create-issue in the same plan, in either order", () => {
    const text = plan({
      ops: [
        { op: "add-blocker", opId: "b1", issue: 12, blockedBy: "child-a" },
        { op: "create-issue", opId: "n1", ref: "child-a", title: "t", body: "b" },
      ],
    });
    expect("plan" in parsePlan(text)).toBe(true);
  });

  it("refuses a blockedBy ref no create-issue declares", () => {
    const text = plan({ ops: [{ op: "add-blocker", opId: "b1", issue: 12, blockedBy: "ghost" }] });
    expect(problemsOf(text)[0]).toContain("names no create-issue ref");
  });

  it("refuses a create-issue ref that looks like an issue number", () => {
    const text = plan({ ops: [{ op: "create-issue", opId: "n1", ref: "42", title: "t", body: "b" }] });
    expect(problemsOf(text)[0]).toContain("must not look like an issue number");
  });

  it("refuses a repeated create-issue ref", () => {
    const text = plan({
      ops: [
        { op: "create-issue", opId: "n1", ref: "child", title: "t", body: "b" },
        { op: "create-issue", opId: "n2", ref: "child", title: "t2", body: "b2" },
      ],
    });
    expect(problemsOf(text).some((p) => p.includes("repeats child"))).toBe(true);
  });

  it("refuses a close with no evidence", () => {
    const text = plan({ ops: [{ op: "close", opId: "c1", issue: 12 }] });
    expect(problemsOf(text)[0]).toContain("evidence: is required");
  });

  it("refuses a done-in close citing nothing per criterion", () => {
    const text = plan({
      ops: [{ op: "close", opId: "c1", issue: 12, evidence: { kind: "done-in", pr: 5, criteria: [] } }],
    });
    expect(problemsOf(text)[0]).toContain("per acceptance criterion");
  });

  it("refuses a criterion citation missing its cite", () => {
    const text = plan({
      ops: [
        {
          op: "close",
          opId: "c1",
          issue: 12,
          evidence: { kind: "done-in", pr: 5, criteria: [{ criterion: "AC 1", cite: "" }] },
        },
      ],
    });
    expect(problemsOf(text)[0]).toContain("{ criterion, cite }");
  });

  it("accepts a duplicate-of close and refuses an unknown evidence kind", () => {
    const ok = plan({
      ops: [{ op: "close", opId: "c1", issue: 12, evidence: { kind: "duplicate-of", issue: 3 } }],
    });
    expect("plan" in parsePlan(ok)).toBe(true);
    const bad = plan({
      ops: [{ op: "close", opId: "c1", issue: 12, evidence: { kind: "obsolete" } }],
    });
    expect(problemsOf(bad)[0]).toContain('"done-in" or "duplicate-of"');
  });

  it("refuses a decision missing a field or citing an escaping path", () => {
    expect(
      problemsOf(plan({ decisions: [{ question: "q", rule: "CONTEXT.md#R", quote: "" }] }))[0],
    ).toContain("decisions[0].quote");
    expect(
      problemsOf(plan({ decisions: [{ question: "q", rule: "../secrets.md", quote: "x" }] }))[0],
    ).toContain("no .. segment");
    expect(
      problemsOf(plan({ decisions: [{ question: "q", rule: "/etc/passwd", quote: "x" }] }))[0],
    ).toContain("no .. segment");
  });

  it("accepts a decision citing a repo-relative rule with a heading", () => {
    expect(
      "plan" in parsePlan(plan({ decisions: [{ question: "q", rule: "docs/adr/0007.md#Scope", quote: "x" }] })),
    ).toBe(true);
  });
});

