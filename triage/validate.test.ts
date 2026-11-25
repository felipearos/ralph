import { describe, expect, it } from "vitest";

import { unblockDays, type Ticket } from "../frontier/next-tasks";
import type { SectionHeading, TriageOp, TriagePlan } from "./plan";
import { NEVER_TOUCHED_LABELS, triageLimits, validatePlan, type ValidationContext } from "./validate";
import {
  MAX_UNBLOCKS,
  UNBLOCK_MARKER_OP,
  formatTriageMarker,
  triageBodyHash,
  unblockLead,
} from "../triage-marker";

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  number: 12,
  title: "A ticket",
  body: "## What to build\n\nthings\n",
  author: "felipearosr",
  comments: [],
  labels: new Set<string>(),
  assignees: [],
  openPullRequest: null,
  liveBranch: null,
  parent: null,
  staffingGroup: null,
  malformed: null,
  openBlockers: [],
  closedBlockers: [],
  proseOnlyBlockers: [],
  droppedReferences: [],
  ...overrides,
});

const plan = (ops: TriageOp[], rest: Partial<TriagePlan> = {}): TriagePlan => ({
  unit: 12,
  loop: "tessa",
  attempt: 1,
  outcome: "routed",
  ops,
  ...rest,
});

const context = (
  overrides: Partial<ValidationContext> & { plan: TriagePlan },
): ValidationContext => ({
  tickets: new Map([[12, ticket()]]),
  owner: "felipearosr",
  roster: ["ralph", "rafa", "tessa"],
  loop: "tessa",
  existingLabels: new Set(["ready-for-agent", "spec", "needs-info", "duplicate", "jav-2", "jav-3", "tessa-wip", "ralph-wip", "ralph-blocked", "rafa-blocked", "priority:urgent", "queued"]),
  allowedLabels: new Set(["ready-for-agent", "spec", "needs-info", "duplicate", "jav-2", "jav-3", "tessa-wip", "tessa-blocked", "tessa-done"]),
  coders: ["ralph", "rafa"],
  javLabels: ["jav-2", "jav-3"],
  fences: { outOfScope: [99], closureParents: [50] },
  limits: { maxWrites: 30, maxNewIssues: 6, unblockDays: 7 },
  readRule: () => null,
  duplicateTarget: () => ({ state: "open" }),
  // The production shape: the rescue rules read a thread in FULL, past the
  // census tail. Wired to the fixture's own tickets so the rescue suite runs
  // the path `triage-apply.ts` takes rather than a fallback.
  fullComments: (issue) => overrides.tickets?.get(issue)?.comments ?? null,
  ...overrides,
});

describe("triageLimits", () => {
  it("defaults to 30 writes, 6 new issues and a 7-day rescue window", () => {
    expect(triageLimits({})).toEqual({ maxWrites: 30, maxNewIssues: 6, unblockDays: 7 });
  });

  it("reads the env knobs and ignores garbage rather than throwing", () => {
    expect(triageLimits({ RALPH_TRIAGE_MAX_WRITES: "4", RALPH_TRIAGE_MAX_NEW_ISSUES: "two", RALPH_TRIAGE_UNBLOCK_DAYS: "14" })).toEqual({
      maxWrites: 4,
      maxNewIssues: 6,
      unblockDays: 14,
    });
  });
});

describe("the rescue window's two readers", () => {
  it("agree on the default, so the bucket cannot offer what the op refuses", () => {
    // `RALPH_TRIAGE_UNBLOCK_DAYS` is read on both sides of the same policy:
    // `frontier/next-tasks.ts` for the bucket, here for the op. Both docblocks
    // promise they cannot disagree; this is what makes that true.
    expect(triageLimits({}).unblockDays).toBe(unblockDays());
  });
});

describe("validatePlan — labels", () => {
  it("passes a label that exists and is in the role's set", () => {
    const problems = validatePlan(
      context({ plan: plan([{ op: "add-label", opId: "a1", issue: 12, label: "ready-for-agent" }]) }),
    );
    expect(problems).toEqual([]);
  });

  it("refuses a label that does not exist in the repository", () => {
    const problems = validatePlan(
      context({ plan: plan([{ op: "add-label", opId: "a1", issue: 12, label: "jav-9" }]) }),
    );
    expect(problems.some((p) => p.includes("does not exist"))).toBe(true);
  });

  it("refuses a label outside the role's set even when it exists", () => {
    const problems = validatePlan(
      context({ plan: plan([{ op: "add-label", opId: "a1", issue: 12, label: "ci-health" }]) }),
    );
    expect(problems.some((p) => p.includes("outside this role's label set"))).toBe(true);
  });

  it("refuses every never-touched label, added or removed", () => {
    for (const label of NEVER_TOUCHED_LABELS) {
      const added = validatePlan(
        context({ plan: plan([{ op: "add-label", opId: "a1", issue: 12, label }]) }),
      );
      const removed = validatePlan(
        context({ plan: plan([{ op: "remove-label", opId: "a1", issue: 12, label }]) }),
      );
      expect(added[0]).toContain("never a triager's to set");
      expect(removed[0]).toContain("never a triager's to set");
    }
  });

  it("refuses another loop's claim label and allows its own", () => {
    const other = validatePlan(
      context({ plan: plan([{ op: "remove-label", opId: "a1", issue: 12, label: "ralph-wip" }]) }),
    );
    expect(other[0]).toContain("is ralph's claim label");
    const own = validatePlan(
      context({ plan: plan([{ op: "remove-label", opId: "a1", issue: 12, label: "tessa-wip" }]) }),
    );
    expect(own).toEqual([]);
  });

  it("checks the labels a create-issue carries too", () => {
    const problems = validatePlan(
      context({
        plan: plan([
          { op: "create-issue", opId: "n1", ref: "child", title: "t", body: "b", labels: ["queued"] },
        ]),
      }),
    );
    expect(problems[0]).toContain("never a triager's to set");
  });
});

describe("validatePlan — the owner fence", () => {
  it("refuses an op on an issue the read did not return", () => {
    const problems = validatePlan(
      context({ plan: plan([{ op: "comment", opId: "c1", issue: 77, body: "hi" }]) }),
    );
    expect(problems[0]).toContain("#77 is not an open issue in this read");
  });

  it("refuses an issue authored by somebody else", () => {
    const problems = validatePlan(
      context({
        plan: plan([{ op: "comment", opId: "c1", issue: 12, body: "hi" }]),
        tickets: new Map([[12, ticket({ author: "a-stranger" })]]),
      }),
    );
    expect(problems[0]).toContain("authored by a-stranger");
  });

  it("fails closed when the census could not read the author", () => {
    const problems = validatePlan(
      context({
        plan: plan([{ op: "comment", opId: "c1", issue: 12, body: "hi" }]),
        tickets: new Map([[12, ticket({ author: null })]]),
      }),
    );
    expect(problems[0]).toContain("unreadable account");
  });
});

describe("validatePlan — sections on a claimed issue", () => {
  const sectionOp = (heading: SectionHeading): TriageOp => ({
    op: "set-section",
    opId: "s1",
    issue: 12,
    heading,
    mode: "replace",
    body: "x",
  });

  it("allows Staffing group on a claimed issue and refuses any other section", () => {
    const claimed = new Map([[12, ticket({ labels: new Set(["ralph-wip"]) })]]);
    expect(validatePlan(context({ plan: plan([sectionOp("Staffing group")]), tickets: claimed }))).toEqual([]);
    expect(
      validatePlan(context({ plan: plan([sectionOp("Parent")]), tickets: claimed }))[0],
    ).toContain("only \"Staffing group\"");
  });

  it("refuses a plan that writes under another loop's name, or off the roster", () => {
    // The own-claim exemption below is only safe because of this: `plan.loop` is
    // a string the model types, and a spoofed one would buy a body write and a
    // close on a ticket another loop is holding.
    const spoofed = plan([sectionOp("Acceptance criteria")]);
    spoofed.loop = "rafa";
    expect(validatePlan(context({ plan: spoofed }))[0]).toContain('is not this loop ("tessa")');
    const foreign = plan([sectionOp("Parent")]);
    foreign.loop = "zed";
    const problems = validatePlan(context({ plan: foreign }));
    expect(problems[0]).toContain("is not a loop on this project's roster");
  });

  it("does not read the plan's OWN -wip as somebody else's, but does read its own -blocked", () => {
    // The frontier writes `<loop>-wip` before the model sees the unit, so every
    // plan arrives holding its own claim. Reading that as "claimed" would refuse
    // the body write on the very issue the triager was handed.
    const mine = new Map([[12, ticket({ labels: new Set(["tessa-wip"]) })]]);
    expect(validatePlan(context({ plan: plan([sectionOp("Acceptance criteria")]), tickets: mine }))).toEqual([]);
    // Its own block is a past iteration having given up and put the unit in front
    // of a person; rewriting that body under them is the case the rule is for.
    const givenUp = new Map([[12, ticket({ labels: new Set(["tessa-blocked"]) })]]);
    expect(validatePlan(context({ plan: plan([sectionOp("What to build")]), tickets: givenUp }))[0]).toContain(
      "is claimed",
    );
  });

  it("reads an assignee as a claim too", () => {
    const assigned = new Map([[12, ticket({ assignees: ["felipearosr"] })]]);
    expect(
      validatePlan(context({ plan: plan([sectionOp("Parent")]), tickets: assigned }))[0],
    ).toContain("is claimed");
  });

  it("allows any section on an unclaimed issue", () => {
    expect(validatePlan(context({ plan: plan([sectionOp("Parent")]) }))).toEqual([]);
  });
});

describe("validatePlan — closes", () => {
  const closeOp = (evidence: Extract<TriageOp, { op: "close" }>["evidence"], issue = 12): TriageOp => ({
    op: "close",
    opId: "c1",
    issue,
    evidence,
  });
  const doneIn: Extract<TriageOp, { op: "close" }>["evidence"] = {
    kind: "done-in",
    pr: 4,
    criteria: [{ criterion: "AC 1", cite: "triage/plan.ts" }],
  };

  it("accepts a done-in close of an unclaimed, PR-less, non-spec issue", () => {
    expect(validatePlan(context({ plan: plan([closeOp(doneIn)]) }))).toEqual([]);
  });

  it("refuses closing a spec, a claimed issue, or one with an open PR", () => {
    const spec = new Map([[12, ticket({ labels: new Set(["spec"]) })]]);
    expect(validatePlan(context({ plan: plan([closeOp(doneIn)]), tickets: spec }))[0]).toContain("is a spec");
    const claimed = new Map([[12, ticket({ labels: new Set(["ralph-wip"]) })]]);
    expect(validatePlan(context({ plan: plan([closeOp(doneIn)]), tickets: claimed }))[0]).toContain("is claimed");
    const withPr = new Map([[12, ticket({ openPullRequest: 300 })]]);
    expect(validatePlan(context({ plan: plan([closeOp(doneIn)]), tickets: withPr }))[0]).toContain("open PR #300");
  });

  it("closes an issue the plan's own loop holds, and refuses one another loop holds", () => {
    const mine = new Map([[12, ticket({ labels: new Set(["tessa-wip"]) })]]);
    expect(validatePlan(context({ plan: plan([closeOp(doneIn)]), tickets: mine }))).toEqual([]);
    const theirs = new Map([[12, ticket({ labels: new Set(["rafa-wip"]) })]]);
    expect(validatePlan(context({ plan: plan([closeOp(doneIn)]), tickets: theirs }))[0]).toContain("is claimed");
  });

  it("refuses closing a plan Parent-closure exception or an Out-of-scope issue", () => {
    const tickets = new Map([
      [50, ticket({ number: 50 })],
      [99, ticket({ number: 99 })],
    ]);
    expect(
      validatePlan(context({ plan: plan([closeOp(doneIn, 50)]), tickets }))[0],
    ).toContain("Parent-closure exception");
    expect(
      validatePlan(context({ plan: plan([closeOp(doneIn, 99)]), tickets }))[0],
    ).toContain("Out of scope");
  });

  it("refuses a duplicate-of whose target was closed as not planned, or could not be read", () => {
    const notPlanned = validatePlan(
      context({
        plan: plan([closeOp({ kind: "duplicate-of", issue: 3 })]),
        duplicateTarget: () => ({ state: "closed", completed: false }),
      }),
    );
    expect(notPlanned[0]).toContain("closed as not planned");
    const unreadable = validatePlan(
      context({
        plan: plan([closeOp({ kind: "duplicate-of", issue: 3 })]),
        duplicateTarget: () => ({ state: "unknown" }),
      }),
    );
    expect(unreadable[0]).toContain("could not be read");
  });

  it("accepts a duplicate-of an open issue or one closed as completed", () => {
    for (const state of [{ state: "open" } as const, { state: "closed", completed: true } as const]) {
      expect(
        validatePlan(
          context({ plan: plan([closeOp({ kind: "duplicate-of", issue: 3 })]), duplicateTarget: () => state }),
        ),
      ).toEqual([]);
    }
  });

  it("refuses a duplicate close on a repository with no `duplicate` label", () => {
    // The tool applies that label itself, so it is the one label that would
    // otherwise never be checked — and the close would fail mid-plan.
    const problems = validatePlan(
      context({
        plan: plan([closeOp({ kind: "duplicate-of", issue: 3 })]),
        existingLabels: new Set(["ready-for-agent"]),
      }),
    );
    expect(problems.some((p) => p.includes('"duplicate" does not exist'))).toBe(true);
  });

  it("refuses an issue duplicating itself", () => {
    expect(
      validatePlan(context({ plan: plan([closeOp({ kind: "duplicate-of", issue: 12 })]) }))[0],
    ).toContain("cannot duplicate itself");
  });
});

describe("validatePlan — cited rules", () => {
  const cite = (rule: string, quote: string) =>
    plan([{ op: "comment", opId: "c1", issue: 12, body: `Decided under ${rule}.` }], {
      decisions: [{ question: "retain how long?", rule, quote }],
    });

  it("accepts a rule that resolves and a quote that appears in it", () => {
    const problems = validatePlan(
      context({
        plan: cite("CONTEXT.md#Retention", "logs are kept for 30 days"),
        readRule: (path) => (path === "CONTEXT.md" ? "# C\n\n## Retention\n\nlogs are kept\nfor 30 days\n" : null),
      }),
    );
    expect(problems).toEqual([]);
  });

  it("refuses a rule path that does not exist at the base branch", () => {
    const problems = validatePlan(context({ plan: cite("docs/adr/0009.md", "anything") }));
    expect(problems[0]).toContain("does not exist at the base branch");
  });

  it("refuses a quote that is not in the rule file", () => {
    const problems = validatePlan(
      context({ plan: cite("CONTEXT.md", "invented policy"), readRule: () => "# C\n\nreal policy\n" }),
    );
    expect(problems[0]).toContain("does not appear verbatim");
  });

  it("refuses a heading fragment the file does not carry", () => {
    const problems = validatePlan(
      context({ plan: cite("CONTEXT.md#Nope", "real policy"), readRule: () => "# C\n\nreal policy\n" }),
    );
    expect(problems.some((p) => p.includes('no heading "Nope"'))).toBe(true);
  });

  it("refuses a cited rule no comment on the unit names", () => {
    const silent = plan([{ op: "comment", opId: "c1", issue: 12, body: "no citation here" }], {
      decisions: [{ question: "q", rule: "CONTEXT.md", quote: "real policy" }],
    });
    const problems = validatePlan(context({ plan: silent, readRule: () => "real policy" }));
    expect(problems[0]).toContain("must be visible on the issue");
  });
});

describe("validatePlan — the keyed intake's outcomes", () => {
  const keyed = "is a Linear or Jira project's Slack-intake outcome; a GitHub triager may not use it";

  it("refuses a propose plan on GitHub, for the outcome and for the op", () => {
    const problems = validatePlan(
      context({
        plan: plan([{ op: "propose", opId: "p1", issue: 12, body: "## What to build\n\nA thing.\n" }], {
          outcome: "propose",
        }),
      }),
    );
    expect(problems).toEqual([`plan.outcome: "propose" ${keyed}`, `ops[0].op: "propose" ${keyed}`]);
  });

  it("refuses a to-person plan on GitHub, for the outcome and for the op", () => {
    const problems = validatePlan(
      context({
        plan: plan([{ op: "to-person", opId: "t1", issue: 12, reason: "Falta el criterio de aceptación." }], {
          outcome: "to-person",
        }),
      }),
    );
    expect(problems).toEqual([`plan.outcome: "to-person" ${keyed}`, `ops[0].op: "to-person" ${keyed}`]);
  });
});

describe("validatePlan — limits", () => {
  it("refuses more mutations than the write cap", () => {
    const ops = Array.from({ length: 4 }, (_, at): TriageOp => ({
      op: "comment",
      opId: `c${at}`,
      issue: 12,
      body: "x",
    }));
    const problems = validatePlan(context({ plan: plan(ops), limits: { maxWrites: 3, maxNewIssues: 6, unblockDays: 7 } }));
    expect(problems[0]).toContain("RALPH_TRIAGE_MAX_WRITES");
  });

  it("counts the write ordering DERIVES, not just the plan's own ops", () => {
    // A create-issue asking for `ready-for-agent` becomes two writes: the
    // creation, then the promotion once the child has a number.
    const ops: TriageOp[] = [
      { op: "create-issue", opId: "n1", ref: "child", title: "t", body: "b", labels: ["ready-for-agent"] },
      { op: "comment", opId: "c1", issue: 12, body: "x" },
    ];
    const problems = validatePlan(context({ plan: plan(ops), limits: { maxWrites: 2, maxNewIssues: 6, unblockDays: 7 } }));
    expect(problems[0]).toContain("3 mutations exceeds RALPH_TRIAGE_MAX_WRITES (2)");
  });

  it("refuses more creations than the new-issue cap", () => {
    const ops = Array.from({ length: 3 }, (_, at): TriageOp => ({
      op: "create-issue",
      opId: `n${at}`,
      ref: `child-${at}`,
      title: "t",
      body: "b",
    }));
    const problems = validatePlan(context({ plan: plan(ops), limits: { maxWrites: 30, maxNewIssues: 2, unblockDays: 7 } }));
    expect(problems[0]).toContain("RALPH_TRIAGE_MAX_NEW_ISSUES");
  });
});

/**
 * felipearos/ralph#150's five preconditions on lifting a coder's block. Every
 * case here is a REFUSAL case bar one: the whole value of the op is that it
 * cannot be talked into a rescue the ticket has not earned, and a wrong grant
 * sends a coder back at an unchanged ticket with its rescue count reset.
 */
describe("validatePlan — unblock", () => {
  const BODY = "## What to build\n\nA thing.\n\n## Acceptance criteria\n\n- [ ] It works somehow.\n";
  const BLOCK = "blocked: PR #900 red twice in CI; not reproducible locally";

  const blockRecord = (body = BLOCK, createdAt = "2026-01-01T00:00:00Z") => ({ body, createdAt });

  const unblockMark = (at: string, attempt = 1) => ({
    body: `${unblockLead("rafa")}\n\n${formatTriageMarker(
      { attempt, outcome: "specced", body: triageBodyHash(BODY) },
      { loop: "tessa", unit: 12, op: UNBLOCK_MARKER_OP, labels: [] },
    )}`,
    createdAt: at,
  });

  const blocked = (overrides: Partial<Ticket> = {}): Ticket =>
    ticket({
      body: BODY,
      labels: new Set(["ready-for-agent", "rafa-blocked"]),
      comments: [blockRecord()],
      ...overrides,
    });

  /** The comment #150 requires, with the marker, the reason and what changed. */
  const rescueComment = (extra = ""): Extract<TriageOp, { op: "comment" }> => ({
    op: "comment",
    opId: "c1",
    issue: 12,
    body:
      `${unblockLead("rafa")}\n\n` +
      `It was parked as: ${BLOCK}\n\n` +
      `Re-specified Acceptance criteria. It used to read:\n\n> - [ ] It works somehow.\n\n${extra}\n\n` +
      formatTriageMarker(
        { attempt: 1, outcome: "specced", body: triageBodyHash(BODY) },
        { loop: "tessa", unit: 12, op: UNBLOCK_MARKER_OP, labels: [] },
      ),
  });

  const respec: Extract<TriageOp, { op: "set-section" }> = {
    op: "set-section",
    opId: "s1",
    issue: 12,
    heading: "Acceptance criteria",
    mode: "replace",
    body: "- [ ] A measurable one.\n",
  };

  const unblock: Extract<TriageOp, { op: "unblock" }> = {
    op: "unblock",
    opId: "u1",
    issue: 12,
    label: "rafa-blocked",
  };

  const rescue = (
    ops: TriageOp[] = [respec, rescueComment(), unblock],
    over: Partial<ValidationContext> = {},
    issue: Ticket = blocked(),
  ): string[] =>
    validatePlan(
      context({
        plan: plan(ops, { outcome: "specced" }),
        tickets: new Map([[12, issue]]),
        now: new Date("2026-06-01T00:00:00Z"),
        ...over,
      }),
    );

  it("accepts a rescue that re-specifies, says why, and quotes what it replaced", () => {
    expect(rescue()).toEqual([]);
  });

  it("accepts a rescue that re-ROUTES instead, naming the new difficulty", () => {
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("Re-specified Acceptance criteria.", "Re-routed jav-2 → jav-3."),
    };
    expect(
      rescue([{ op: "add-label", opId: "a1", issue: 12, label: "jav-3" }, comment, unblock]),
    ).toEqual([]);
  });

  it("accepts a rescue whose spec change is a SEPARATE amending comment", () => {
    const amendment: Extract<TriageOp, { op: "comment" }> = {
      op: "comment",
      opId: "c0",
      issue: 12,
      amends: true,
      body: "Narrowing this: only the retry path is in scope, not the queue.",
    };
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: `${rescueComment().body}\n\nNarrowing this: only the retry path is in scope, not the queue.`,
    };
    expect(rescue([amendment, comment, unblock])).toEqual([]);
  });

  it("does not let the unblock comment be its OWN amendment", () => {
    // The plan is required to carry that comment, so `amends: true` on it would
    // let a two-op plan satisfy "changed the spec" with itself.
    expect(rescue([{ ...rescueComment(), amends: true }, unblock]).join("\n")).toContain(
      "changes neither the spec nor the route",
    );
  });

  it("refuses an amendment the unblock comment does not carry the first line of", () => {
    const amendment: Extract<TriageOp, { op: "comment" }> = {
      op: "comment",
      opId: "c0",
      issue: 12,
      amends: true,
      body: "Narrowing this: only the retry path is in scope.",
    };
    expect(rescue([amendment, rescueComment(), unblock]).join("\n")).toContain(
      "does not carry the first line of the amendment",
    );
  });

  it("refuses a re-route that changes no label, and accepts one that does", () => {
    // Re-adding the label the ticket already carries is a write the apply
    // reports as `skipped`: the coder would get the identical ticket back.
    const had = blocked({ labels: new Set(["ready-for-agent", "rafa-blocked", "jav-2"]) });
    const comment = (label: string): Extract<TriageOp, { op: "comment" }> => ({
      ...rescueComment(),
      body: rescueComment().body.replace("Re-specified Acceptance criteria.", `Re-routed to ${label}.`),
    });
    expect(
      rescue([{ op: "add-label", opId: "a1", issue: 12, label: "jav-2" }, comment("jav-2"), unblock], {}, had).join("\n"),
    ).toContain("changes neither the spec nor the route");
    expect(
      rescue([{ op: "add-label", opId: "a1", issue: 12, label: "jav-3" }, comment("jav-3"), unblock], {}, had),
    ).toEqual([]);
  });

  it("refuses a re-route with no destination — stripping the only difficulty label", () => {
    // With Jav on, a ticket carrying no difficulty label is invisible to every
    // coder: that is the opposite of handing it back, and there is no "new
    // difficulty" for the comment to name.
    const had = blocked({ labels: new Set(["ready-for-agent", "rafa-blocked", "jav-2"]) });
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("Re-specified Acceptance criteria.", "Dropped jav-2."),
    };
    expect(
      rescue([{ op: "remove-label", opId: "a1", issue: 12, label: "jav-2" }, comment, unblock], {}, had).join("\n"),
    ).toContain("changes neither the spec nor the route");

    // A swap — strip the old, add the new — is a real re-route.
    const swap: TriageOp[] = [
      { op: "remove-label", opId: "a1", issue: 12, label: "jav-2" },
      { op: "add-label", opId: "a2", issue: 12, label: "jav-3" },
    ];
    const both: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("Re-specified Acceptance criteria.", "Re-routed jav-2 → jav-3."),
    };
    expect(rescue([...swap, both, unblock], {}, had)).toEqual([]);
  });

  it("refuses a rescue set-section on a heading the exemption does not cover", () => {
    // The block is evidence the SPEC failed, not evidence about the ticket's
    // parent or its blockers.
    const structural: Extract<TriageOp, { op: "set-section" }> = {
      op: "set-section",
      opId: "s2",
      issue: 12,
      heading: "Blocked by",
      mode: "replace",
      body: "#99\n",
    };
    expect(rescue([respec, structural, rescueComment(), unblock]).join("\n")).toContain(
      'only "Staffing group" may be set',
    );
  });

  it("refuses the unparseable-date marker as well as the undated one", () => {
    const nonsense = blocked({
      comments: [{ ...unblockMark("2026-05-01T00:00:00Z"), createdAt: "the other day" }, blockRecord()],
    });
    expect(rescue([respec, rescueComment(), unblock], {}, nonsense).join("\n")).toContain("which will not parse");
  });

  it("names the three means in the refusal, so the model knows what would count", () => {
    expect(rescue([rescueComment(), unblock]).join("\n")).toContain('a comment with "amends": true');
  });

  it("refuses an unblock whose plan changes neither spec nor route", () => {
    expect(rescue([rescueComment(), unblock]).join("\n")).toContain("changes neither the spec nor the route");
  });

  it("refuses a re-spec that is not one of the two headings as a spec change", () => {
    const staffing: TriageOp = {
      op: "set-section",
      opId: "s1",
      issue: 12,
      heading: "Staffing group",
      mode: "replace",
      body: "cli",
    };
    expect(rescue([staffing, rescueComment(), unblock]).join("\n")).toContain(
      "changes neither the spec nor the route",
    );
  });

  it("refuses an unblock on a migration block", () => {
    const issue = blocked({
      comments: [blockRecord("needs-migration: draft PR #900 ready; apply drizzle/0062_x.sql first")],
    });
    expect(rescue([respec, rescueComment(), unblock], {}, issue).join("\n")).toContain(
      "blocked on a migration",
    );
  });

  it("refuses an unblock on a CI flake, which is the ci-doctor's", () => {
    const issue = blocked({
      comments: [blockRecord("blocked: PR #900 red on a flaky test (src/a.test.ts), not the diff")],
    });
    expect(rescue([respec, rescueComment(), unblock], {}, issue).join("\n")).toContain("that is the ci-doctor's, not a re-spec");
  });

  it("refuses an unblock when no block record can be read at all", () => {
    expect(rescue([respec, rescueComment(), unblock], {}, blocked({ comments: [] })).join("\n")).toContain(
      "no readable block record",
    );
  });

  it("refuses an unblock on a ticket with an open PR", () => {
    expect(
      rescue([respec, rescueComment(), unblock], {}, blocked({ openPullRequest: 900 })).join("\n"),
    ).toContain("has open PR #900");
  });

  it("refuses an unblock on a ticket that is not ready-for-agent, or is a spec", () => {
    expect(
      rescue([respec, rescueComment(), unblock], {}, blocked({ labels: new Set(["rafa-blocked"]) })).join("\n"),
    ).toContain("is not ready-for-agent");
    expect(
      rescue(
        [respec, rescueComment(), unblock],
        {},
        blocked({ labels: new Set(["ready-for-agent", "spec", "rafa-blocked"]) }),
      ).join("\n"),
    ).toContain("is a spec");
  });

  it("refuses an unblock of a label that is not a coder's block", () => {
    // tessa is the triager itself; its own block is a hand-off to a person.
    const issue = blocked({ labels: new Set(["ready-for-agent", "tessa-blocked"]) });
    const problems = rescue(
      [respec, rescueComment(), { ...unblock, label: "tessa-blocked" }],
      {},
      issue,
    ).join("\n");
    expect(problems).toContain(`ops[2].label: "tessa-blocked" is not a coder's block (coders: ralph, rafa)`);
  });

  it("refuses an unblock when two coders' blocks are on the ticket", () => {
    const issue = blocked({ labels: new Set(["ready-for-agent", "ralph-blocked", "rafa-blocked"]) });
    expect(rescue([respec, rescueComment(), unblock], {}, issue).join("\n")).toContain(
      "a person decides which block stands",
    );
  });

  it("refuses an unblock whose label is not the one the ticket carries", () => {
    expect(
      rescue([respec, rescueComment(), { ...unblock, label: "ralph-blocked" }], {}, blocked()).join("\n"),
    ).toContain('does not carry "ralph-blocked"');
  });

  it("refuses an unblock on a ticket that is in flight, label or no label", () => {
    expect(
      rescue(
        [respec, rescueComment(), unblock],
        {},
        blocked({ labels: new Set(["ready-for-agent", "rafa-blocked", "ralph-wip"]) }),
      ).join("\n"),
    ).toContain("it is in flight, not blocked");
    expect(
      rescue([respec, rescueComment(), unblock], {}, blocked({ assignees: ["felipearosr"] })).join("\n"),
    ).toContain("has an assignee");
  });

  it("refuses a second unblock inside RALPH_TRIAGE_UNBLOCK_DAYS, and allows one outside it", () => {
    const inside = blocked({ comments: [unblockMark("2026-05-28T00:00:00Z"), blockRecord(BLOCK, "2026-05-30T00:00:00Z")] });
    expect(rescue([respec, rescueComment(), unblock], {}, inside).join("\n")).toContain(
      "inside RALPH_TRIAGE_UNBLOCK_DAYS (7)",
    );

    const outside = blocked({ comments: [unblockMark("2026-04-01T00:00:00Z"), blockRecord(BLOCK, "2026-05-30T00:00:00Z")] });
    expect(rescue([respec, rescueComment(), unblock], {}, outside)).toEqual([]);
  });

  it("refuses the THIRD unblock however old the others are — AC 4", () => {
    const twice = blocked({
      comments: [
        unblockMark("2026-01-02T00:00:00Z", 1),
        unblockMark("2026-02-02T00:00:00Z", 2),
        blockRecord(BLOCK, "2026-03-01T00:00:00Z"),
      ],
    });
    expect(rescue([respec, rescueComment(), unblock], {}, twice).join("\n")).toContain(
      `unblocked 2 times already (cap ${MAX_UNBLOCKS})`,
    );
  });

  it("refuses an undated unblock marker rather than assuming it is old", () => {
    const undated = blocked({
      comments: [{ body: unblockMark("2026-05-01T00:00:00Z").body }, blockRecord(BLOCK, "2026-05-30T00:00:00Z")],
    });
    expect(rescue([respec, rescueComment(), unblock], {}, undated).join("\n")).toContain("undated unblock marker");
  });

  it("refuses a rescue with no unblock comment, or one whose first line is wrong", () => {
    expect(rescue([respec, unblock]).join("\n")).toContain('whose first line is "unblocked: rescue count for rafa reset"');
    const mistitled: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: `Rescuing this one.\n\n${rescueComment().body}`,
    };
    expect(rescue([respec, mistitled, unblock]).join("\n")).toContain("whose first line is");
  });

  it("does NOT ask the plan for the op=unblock marker — apply.ts stamps it", () => {
    // The marker carries a truncated sha256 of the issue body, which no model
    // can produce by hand; and one written by the plan would be posted whether
    // or not the label removal after it succeeded, so the count could run ahead
    // of the rescues.
    const unmarked: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.split("<!-- ralph:triage")[0]!.trimEnd(),
    };
    expect(rescue([respec, unmarked, unblock])).toEqual([]);
  });

  it("refuses two comments leading with the unblock line — one rescue, one comment", () => {
    const second: Extract<TriageOp, { op: "comment" }> = { ...rescueComment(), opId: "c2" };
    expect(rescue([respec, rescueComment(), second, unblock]).join("\n")).toContain(
      "one rescue, one comment",
    );
  });

  it("refuses a second -blocked that is not a coder's — a person is waiting on it", () => {
    const alsoParked = blocked({ labels: new Set(["ready-for-agent", "rafa-blocked", "tessa-blocked"]) });
    expect(rescue([respec, rescueComment(), unblock], {}, alsoParked).join("\n")).toContain(
      "also carries tessa-blocked, which is not a coder's",
    );
  });

  it("accepts a block record quoted verbatim, backticks and all", () => {
    // `blockReasonOf` strips emphasis from the reason, so a comment quoting the
    // comment faithfully must still match.
    const ticked = "blocked: PR #900 red twice in CI; see `src/queue/retry.test.ts`";
    const issue = blocked({ comments: [blockRecord(`**${ticked}**`)] });
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace(`It was parked as: ${BLOCK}`, `> **${ticked}**`),
    };
    expect(rescue([respec, comment, unblock], {}, issue)).toEqual([]);
  });

  it("refuses a comment that quotes the REPLACEMENT instead of what it replaced", () => {
    const superset: Extract<TriageOp, { op: "set-section" }> = {
      ...respec,
      body: "- [ ] It works somehow, and measurably.\n",
    };
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("> - [ ] It works somehow.", "> - [ ] It works somehow, and measurably."),
    };
    expect(rescue([superset, comment, unblock]).join("\n")).toContain('does not quote the "Acceptance criteria"');
  });

  it("refuses a comment that does not NAME the heading it re-specified", () => {
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("Re-specified Acceptance criteria.", "Rewrote the spec."),
    };
    expect(rescue([respec, comment, unblock]).join("\n")).toContain('does not name the re-specified "Acceptance criteria"');
  });

  it("asks for no quote when the section is appended, or was never there", () => {
    const appended: Extract<TriageOp, { op: "set-section" }> = { ...respec, mode: "append" };
    expect(rescue([appended, rescueComment(), unblock])).toEqual([]);

    const noSection = blocked({ body: "## What to build\n\nA thing.\n" });
    const comment: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("\n\n> - [ ] It works somehow.", ""),
    };
    expect(rescue([respec, comment, unblock], {}, noSection)).toEqual([]);
  });

  it("says so when the roster names no coders at all", () => {
    expect(rescue([respec, rescueComment(), unblock], { coders: [] }).join("\n")).toContain(
      "none on this roster",
    );
  });

  it("refuses when the full comment read fails — a cap cannot be counted blind", () => {
    expect(rescue([respec, rescueComment(), unblock], { fullComments: () => null }).join("\n")).toContain(
      "could not be read in full",
    );
  });

  it("refuses an unblock comment that does not quote the block record or the text it replaces", () => {
    const silent: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace(`It was parked as: ${BLOCK}\n\n`, ""),
    };
    expect(rescue([respec, silent, unblock]).join("\n")).toContain("does not quote the block record's first line");

    const unquoted: Extract<TriageOp, { op: "comment" }> = {
      ...rescueComment(),
      body: rescueComment().body.replace("> - [ ] It works somehow.", ""),
    };
    expect(rescue([respec, unquoted, unblock]).join("\n")).toContain(
      'does not quote the "Acceptance criteria" it replaces',
    );
  });

  it("still refuses remove-label on a *-blocked, even beside a valid unblock", () => {
    // The interesting case: a plan that has earned its unblock does NOT earn
    // the general op. Every guard hangs off `unblock`, so the capability may
    // not be reached any other way.
    const problems = rescue([
      respec,
      rescueComment(),
      unblock,
      { op: "remove-label", opId: "r1", issue: 12, label: "rafa-blocked" },
    ]);
    expect(problems.join("\n")).toContain(`"rafa-blocked" is rafa's claim label`);
  });

  it("refuses a set-section on a blocked ticket when the plan does not unblock it", () => {
    // Without the unblock in the plan, the ticket's own block reads as a claim.
    // The permission itself is covered by the suite's first test.
    expect(rescue([respec, rescueComment()]).join("\n")).toContain("only \"Staffing group\" may be set");
  });

  it("accepts a rescue on a ticket carrying THIS plan's own -wip", () => {
    // The frontier writes `<loop>-wip` on the unit before the model sees it, so
    // every rescue plan arrives with its own claim on the ticket. Refusing that
    // would refuse every rescue there can ever be.
    const claimed = blocked({ labels: new Set(["ready-for-agent", "rafa-blocked", "tessa-wip"]) });
    expect(rescue([respec, rescueComment(), unblock], {}, claimed)).toEqual([]);
  });

  it("does not extend that exemption to a ticket somebody is actually working", () => {
    const live = blocked({ labels: new Set(["ready-for-agent", "rafa-blocked", "ralph-wip"]) });
    expect(rescue([respec, rescueComment(), unblock], {}, live).join("\n")).toContain(
      "only \"Staffing group\" may be set",
    );
  });

  it("refuses an unblock whose label does not exist in the repository", () => {
    const issue = blocked({ labels: new Set(["ready-for-agent", "remo-blocked"]) });
    expect(
      rescue([respec, rescueComment(), { ...unblock, label: "remo-blocked" }], { coders: ["ralph", "rafa", "remo"] }, issue)
        .join("\n"),
    ).toContain('"remo-blocked" does not exist in this repository');
  });
});
