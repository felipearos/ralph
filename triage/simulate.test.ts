import { describe, expect, it } from "vitest";

import type { RawIssue } from "../frontier/next-tasks";
import type { TriageOp, TriagePlan } from "./plan";
import { frontierOf, simulate, stepwiseRefusals, substitute, type Census } from "./simulate";

const issue = (number: number, body: string, labels: string[] = [], title = `#${number}`): RawIssue => ({
  number,
  title,
  body,
  labels: labels.map((name) => ({ name })),
  assignees: [],
  author: { login: "felipearosr" },
  comments: [],
});

/** A spec with two children, one of them annotated with a staffing group. */
const census = (): Census => ({
  raw: [
    issue(100, "A spec.\n", ["spec"]),
    issue(101, "## Parent\n\n#100\n\n## Staffing group\n\ncli\n", ["ready-for-agent"]),
    issue(102, "## Parent\n\n#100\n\n## Staffing group\n\nweb\n", ["ready-for-agent"]),
  ],
  natives: [[], [], []],
  closed: [],
  openPrs: [],
});

const plan = (ops: TriageOp[], rest: Partial<TriagePlan> = {}): TriagePlan => ({
  unit: 100,
  loop: "tessa",
  attempt: 1,
  outcome: "routed",
  ops,
  ...rest,
});

const refusalsOf = (result: ReturnType<typeof simulate>): string[] =>
  result.ok ? [] : result.refusals;

describe("substitute", () => {
  it("adds and removes labels without mutating the input census", () => {
    const input = census();
    const next = substitute(
      input,
      plan([
        { op: "add-label", opId: "a1", issue: 101, label: "needs-info" },
        { op: "remove-label", opId: "a2", issue: 101, label: "ready-for-agent" },
      ]),
    );
    const changed = next.raw.find((row) => row.number === 101)!;
    expect(changed.labels.map((label) => label.name)).toEqual(["needs-info"]);
    expect(input.raw[1]!.labels.map((label) => label.name)).toEqual(["ready-for-agent"]);
  });

  it("applies a set-section to the body the frontier will parse", () => {
    const next = substitute(
      census(),
      plan([{ op: "set-section", opId: "s1", issue: 101, heading: "Staffing group", mode: "replace", body: "api" }]),
    );
    expect(next.raw.find((row) => row.number === 101)!.body).toContain("api");
  });

  it("adds a created issue with a number above everything in the census", () => {
    const next = substitute(
      census(),
      plan([{ op: "create-issue", opId: "n1", ref: "child", title: "New", body: "## Parent\n\n#100\n", labels: ["ready-for-agent"] }]),
    );
    const created = next.raw.find((row) => row.title === "New")!;
    expect(created.number).toBe(103);
    expect(created.labels.map((label) => label.name)).toEqual(["ready-for-agent"]);
  });

  it("resolves a blockedBy ref to the issue the same plan creates, as an OPEN blocker", () => {
    const next = substitute(
      census(),
      plan([
        { op: "create-issue", opId: "n1", ref: "child", title: "New", body: "## Parent\n\n#100\n" },
        { op: "add-blocker", opId: "b1", issue: 101, blockedBy: "child" },
      ]),
    );
    expect(next.natives[next.raw.findIndex((row) => row.number === 101)]).toEqual([
      { number: 103, state: "open" },
    ]);
  });

  it("moves a closed issue out of the open set and marks it closed wherever it blocked", () => {
    const start = census();
    start.natives[1] = [{ number: 102, state: "open" }];
    const next = substitute(start, plan([
      { op: "close", opId: "c1", issue: 102, evidence: { kind: "duplicate-of", issue: 101 } },
    ]));
    expect(next.raw.map((row) => row.number)).toEqual([100, 101]);
    expect(next.closed.map((row) => row.number)).toEqual([102]);
    expect(next.natives[1]).toEqual([{ number: 102, state: "closed" }]);
  });
});

describe("simulate", () => {
  it("passes a staffing apply and reports the frontier on both sides", () => {
    const start = census();
    start.raw[2] = issue(102, "## Parent\n\n#100\n", ["ready-for-agent"]);
    const before = frontierOf(start);
    expect("frontier" in before && before.frontier.ungroupedTrees.has(100)).toBe(true);

    const result = simulate(
      start,
      plan([{ op: "set-section", opId: "s1", issue: 102, heading: "Staffing group", mode: "replace", body: "web" }]),
    );
    expect(refusalsOf(result)).toEqual([]);
    expect(result.ok && result.after.ungroupedTrees.has(100)).toBe(false);
    // The point of staffing a tree: its siblings stop occluding each other.
    expect(result.ok && result.after.orderedGroups.length).toBeGreaterThan(
      "frontier" in before ? before.frontier.orderedGroups.length : 0,
    );
  });

  it("refuses a plan that writes a staffing group no loop could read", () => {
    // The frontier no longer throws on it — it holds the ticket out instead —
    // but a plan that produces a ticket nobody will ever take is still unsafe.
    const result = simulate(
      census(),
      plan([{ op: "set-section", opId: "s1", issue: 101, heading: "Staffing group", mode: "replace", body: "Web UI" }]),
    );
    expect(refusalsOf(result)[0]).toContain("leaves #101 unreadable to the frontier");
  });

  it("simulates the body the apply will POST, marker and all", () => {
    // A created body reaches GitHub with its op marker. Simulating the unmarked
    // one is how a body the frontier cannot parse passes a simulation.
    const child = "## Parent\n\n#100\n\n## Staffing group\n\ncli\n";
    const next = substitute(
      census(),
      plan([{ op: "create-issue", opId: "n1", ref: "child", title: "New", body: child }]),
    );
    const created = next.raw.find((row) => row.title === "New")!;
    expect(created.body.startsWith("<!-- ralph:triage-op id=n1 -->")).toBe(true);
    expect(frontierOf(next)).toHaveProperty("frontier");
  });

  it("keeps a blocker it already records rather than listing it twice", () => {
    const start = census();
    start.natives[1] = [{ number: 102, state: "open" }];
    const next = substitute(start, plan([{ op: "add-blocker", opId: "b1", issue: 101, blockedBy: 102 }]));
    expect(next.natives[1]).toEqual([{ number: 102, state: "open" }]);
  });

  it("drops an open PR whose every closing reference the plan closes", () => {
    const start = census();
    start.openPrs = [
      { number: 300, closingIssuesReferences: [{ number: 102 }] },
      { number: 301, closingIssuesReferences: [{ number: 101 }, { number: 102 }] },
    ];
    const next = substitute(start, plan([
      { op: "close", opId: "c1", issue: 102, evidence: { kind: "duplicate-of", issue: 101 } },
    ]));
    // #300 closed nothing else, so it is no longer a claim on anything; #301
    // still claims #101 and stays.
    expect(next.openPrs.map((pr) => pr.number)).toEqual([301]);
  });

  it("keeps what a PR references after the plan closes everything it closes", () => {
    const start = census();
    start.openPrs = [{ number: 300, closingIssuesReferences: [{ number: 102 }], references: [{ number: 100 }] }];
    const next = substitute(start, plan([
      { op: "close", opId: "c1", issue: 102, evidence: { kind: "duplicate-of", issue: 101 } },
    ]));
    // `Part of #100` still claims #100 and, through it, #100's children.
    expect(next.openPrs).toEqual([{ number: 300, closingIssuesReferences: [], references: [{ number: 100 }] }]);
  });

  it("refuses a plan that leaves a tree it touched partly annotated", () => {
    const result = simulate(
      census(),
      plan([
        { op: "create-issue", opId: "n1", ref: "child", title: "New", body: "## Parent\n\n#100\n", labels: ["ready-for-agent"] },
      ]),
    );
    expect(refusalsOf(result)[0]).toContain("partly annotated");
  });

  it("does not refuse a tree that was already ungrouped and the plan did not touch", () => {
    const start = census();
    start.raw.push(issue(200, "Another spec.\n", ["spec"]));
    start.raw.push(issue(201, "## Parent\n\n#200\n", ["ready-for-agent"]));
    start.natives.push([], []);
    const result = simulate(
      start,
      plan([{ op: "add-label", opId: "a1", issue: 101, label: "needs-info" }]),
    );
    expect(refusalsOf(result)).toEqual([]);
  });

  it("refuses a plan that puts a spec on the frontier as work", () => {
    const start: Census = {
      raw: [issue(100, "A spec with no children yet.\n", ["spec", "ready-for-agent"])],
      natives: [[]],
      closed: [],
      openPrs: [],
    };
    const before = frontierOf(start);
    expect("frontier" in before && before.frontier.containers.has(100)).toBe(true);
    expect("frontier" in before && before.frontier.readyTasks).toEqual([]);

    const result = simulate(start, plan([{ op: "remove-label", opId: "a1", issue: 100, label: "spec" }]));
    expect(refusalsOf(result)[0]).toContain("puts spec #100 on the frontier as work");
  });

  it("does not refuse a spec that stays a container", () => {
    const result = simulate(
      census(),
      plan([{ op: "add-label", opId: "a1", issue: 100, label: "needs-info" }]),
    );
    expect(refusalsOf(result)).toEqual([]);
  });

  it("does not hold an unrelated plan hostage to a ticket that was already malformed", () => {
    // Before the frontier tolerated one bad ticket, this census could not be
    // read at all and every plan was refused — including the one fixing it.
    const broken: Census = { raw: [issue(1, "## Staffing group\n\nWeb UI\n")], natives: [[]], closed: [], openPrs: [] };
    expect(refusalsOf(simulate(broken, plan([{ op: "add-label", opId: "a1", issue: 1, label: "needs-info" }])))).toEqual([]);
    const fix = simulate(
      broken,
      plan([{ op: "set-section", opId: "s1", issue: 1, heading: "Staffing group", mode: "replace", body: "web-ui" }]),
    );
    expect(refusalsOf(fix)).toEqual([]);
    expect(fix.ok && fix.after.malformed).toEqual([]);
  });
});

describe("stepwiseRefusals — the frontier after every single write", () => {
  /** A split of #100 into one child, written the safe way. */
  const safeSplit = (): TriagePlan =>
    plan([
      {
        op: "create-issue",
        opId: "n1",
        ref: "child-c",
        title: "Third slice",
        body: "## Parent\n\n#100\n\n## Staffing group\n\napi\n\n## Acceptance criteria\n\n- [ ] it works\n",
        labels: ["ready-for-agent", "jav-2"],
      },
      { op: "add-label", opId: "a1", issue: 100, label: "spec" },
      { op: "comment", opId: "c1", issue: 100, body: "Split." },
    ]);

  it("passes a split whose every intermediate state is safe", () => {
    expect(stepwiseRefusals(census(), safeSplit())).toEqual([]);
    expect(refusalsOf(simulate(census(), safeSplit()))).toEqual([]);
  });

  it("refuses a split that offers a child before its tree is annotated", () => {
    const unsafe = plan([
      {
        op: "create-issue",
        opId: "n1",
        ref: "child-c",
        title: "Third slice",
        // No `## Staffing group`: the child is offerable the moment it is
        // created, and its whole tree collapses to the parent-wide domain.
        body: "## Parent\n\n#100\n",
        labels: ["ready-for-agent"],
      },
    ]);
    const refusals = stepwiseRefusals(census(), unsafe);
    expect(refusals.join(" ")).toContain("not yet annotated");
  });

  it("says WHICH write the unsafe state appears after", () => {
    const unsafe = plan([
      { op: "create-issue", opId: "n1", ref: "child-c", title: "T", body: "## Parent\n\n#100\n", labels: ["ready-for-agent"] },
    ]);
    expect(stepwiseRefusals(census(), unsafe)[0]).toMatch(/after \d+ of \d+ writes/);
  });

  it("refuses a split whose children do not name the parent, so the original stays offerable", () => {
    const standalone: Census = {
      raw: [issue(500, "A ticket too big for one agent.\n", ["ready-for-agent"])],
      natives: [[]],
      closed: [],
      openPrs: [],
    };
    const noParent = {
      unit: 500,
      loop: "tessa" as const,
      attempt: 1,
      outcome: "split" as const,
      ops: [
        // No `## Parent`: nothing makes #500 a container, so the frontier goes
        // on offering it beside the slices that replace it.
        { op: "create-issue" as const, opId: "n1", ref: "child-a", title: "Slice", body: "Do the thing.\n" },
      ],
    };
    expect(stepwiseRefusals(standalone, noParent).join(" ")).toContain("still offer #500");
  });

  it("has nothing to check for a plan that creates no issues", () => {
    expect(stepwiseRefusals(census(), plan([{ op: "add-label", opId: "a1", issue: 101, label: "needs-info" }]))).toEqual(
      [],
    );
  });
});

describe("substitute — unblock", () => {
  it("takes the block label off the census, so the frontier sees the rescued ticket", () => {
    const input: Census = {
      raw: [issue(101, "## What to build\n\nA thing.\n", ["ready-for-agent", "rafa-blocked"])],
      natives: [[]],
      closed: [],
      openPrs: [],
    };
    const next = substitute(
      input,
      plan([{ op: "unblock", opId: "u1", issue: 101, label: "rafa-blocked" }], { unit: 101 }),
    );

    expect(next.raw[0]!.labels.map((label) => label.name)).toEqual(["ready-for-agent"]);
    const after = frontierOf(next);
    expect("frontier" in after && after.frontier.readyTasks.map((task) => task.number)).toEqual([101]);
    // The input census is the caller's; substitution never writes through it.
    expect(input.raw[0]!.labels.map((label) => label.name)).toEqual(["ready-for-agent", "rafa-blocked"]);
  });
});
