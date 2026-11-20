import { describe, expect, it } from "vitest";

import { PHASES, orderOps } from "./order";
import { isRefLabelOp, type TriageOp, type TriagePlan } from "./plan";

const plan = (ops: TriageOp[]): TriagePlan => ({
  unit: 100,
  loop: "tessa",
  attempt: 1,
  outcome: "split",
  ops,
});

/** A split written in the worst possible order: everything promoted first. */
const split = plan([
  { op: "comment", opId: "c1", issue: 100, body: "Split into #child-a and #child-b." },
  {
    op: "create-issue",
    opId: "n1",
    ref: "child-a",
    title: "First slice",
    body: "## Parent\n\n#100\n",
    labels: ["ready-for-agent", "jav-2"],
  },
  { op: "add-label", opId: "a1", issue: 100, label: "spec" },
  { op: "remove-label", opId: "a2", issue: 100, label: "ready-for-agent" },
  { op: "set-section", opId: "s1", issue: 101, heading: "Staffing group", mode: "replace", body: "cli" },
  { op: "add-label", opId: "a3", issue: 101, label: "jav-2" },
  { op: "add-label", opId: "a4", issue: 101, label: "ready-for-agent" },
]);

const phasesOf = (steps: ReturnType<typeof orderOps>): string[] => steps.map((step) => step.phase);

describe("orderOps", () => {
  it("runs the split recipe's phases in order", () => {
    expect(phasesOf(orderOps(split))).toEqual([
      "create",
      "demote",
      "demote",
      "structure",
      "label",
      "ready",
      "ready",
      "comment",
    ]);
  });

  it("creates a child WITHOUT ready-for-agent and promotes it afterwards", () => {
    const steps = orderOps(split);
    const create = steps[0]!.op;
    expect(create.op).toBe("create-issue");
    expect(create.op === "create-issue" && create.labels).toEqual(["jav-2"]);

    const deferred = steps.filter((step) => isRefLabelOp(step.op));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.op).toMatchObject({ opId: "n1.ready", ref: "child-a", label: "ready-for-agent" });
    expect(deferred[0]!.phase).toBe("ready");
  });

  it("takes the parent's ready-for-agent away before any child gains one", () => {
    const steps = orderOps(split);
    const demote = steps.findIndex(
      (step) => step.op.op === "remove-label" && step.op.label === "ready-for-agent",
    );
    const promote = steps.findIndex((step) => step.phase === "ready");
    expect(demote).toBeLessThan(promote);
  });

  it("sets staffing and difficulty before the child is made ready", () => {
    const steps = orderOps(split);
    const section = steps.findIndex((step) => step.op.op === "set-section");
    const difficulty = steps.findIndex((step) => step.op.op === "add-label" && step.op.opId === "a3");
    const ready = steps.findIndex((step) => step.op.opId === "a4");
    expect(section).toBeLessThan(ready);
    expect(difficulty).toBeLessThan(ready);
  });

  it("comments after the structure lands and closes last of all", () => {
    const steps = orderOps(
      plan([
        { op: "close", opId: "x1", issue: 101, evidence: { kind: "duplicate-of", issue: 100 } },
        { op: "comment", opId: "c1", issue: 101, body: "Duplicate of #100." },
        { op: "add-label", opId: "a1", issue: 101, label: "duplicate" },
      ]),
    );
    expect(phasesOf(steps)).toEqual(["label", "comment", "close"]);
  });

  it("keeps the plan's own order within a phase", () => {
    const steps = orderOps(
      plan([
        { op: "comment", opId: "c1", issue: 100, body: "first" },
        { op: "comment", opId: "c2", issue: 100, body: "second" },
      ]),
    );
    expect(steps.map((step) => step.op.opId)).toEqual(["c1", "c2"]);
  });

  it("emits every op exactly once, whatever the phase", () => {
    const steps = orderOps(split);
    expect(steps).toHaveLength(split.ops.length + 1);
    expect(new Set(steps.map((step) => step.op.opId)).size).toBe(steps.length);
  });

  it("assigns every step a declared phase", () => {
    for (const step of orderOps(split)) expect(PHASES).toContain(step.phase);
  });
});

describe("orderOps on a rescue", () => {
  /**
   * felipearos/ralph#150's fixed order, written in the worst order: the label
   * first, the re-spec last. The moment the block label goes the ticket is back
   * in the coders' frontier, so the comment explaining the rescue has to be on
   * it already.
   */
  const rescue = plan([
    { op: "unblock", opId: "u1", issue: 100, label: "rafa-blocked" },
    { op: "comment", opId: "c1", issue: 100, body: "unblocked: rescue count for rafa reset" },
    { op: "add-label", opId: "a1", issue: 100, label: "jav-3" },
    {
      op: "set-section",
      opId: "s1",
      issue: 100,
      heading: "Acceptance criteria",
      mode: "replace",
      body: "- [ ] A narrower one.\n",
    },
  ]);

  it("lands the re-spec and the re-route, then the comment, then the label", () => {
    expect(phasesOf(orderOps(rescue))).toEqual(["structure", "label", "comment", "unblock"]);
    expect(orderOps(rescue).map((step) => step.op.opId)).toEqual(["s1", "a1", "c1", "u1"]);
  });

  it("keeps unblock before close, so a plan that also closes something closes it last", () => {
    const both = plan([
      {
        op: "close",
        opId: "x1",
        issue: 101,
        evidence: { kind: "duplicate-of", issue: 100 },
      },
      { op: "unblock", opId: "u1", issue: 100, label: "rafa-blocked" },
    ]);
    expect(phasesOf(orderOps(both))).toEqual(["unblock", "close"]);
  });

  it("names the new phase in PHASES, between comment and close", () => {
    expect(PHASES.indexOf("unblock")).toBeGreaterThan(PHASES.indexOf("comment"));
    expect(PHASES.indexOf("unblock")).toBeLessThan(PHASES.indexOf("close"));
  });
});
