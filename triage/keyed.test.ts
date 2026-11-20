import { describe, expect, it } from "vitest";
import { APP_LABELS } from "../clerk/fakes";

import { FakeThrottle, createFakeTracker, type FakeIssue, type FakeTracker } from "../tracker/fake";
import { TrackerUnavailableError } from "../tracker/types";
import { hasCurrentTriage, latestTriageMarker } from "../triage-marker";
import { applyKeyedPlan, type KeyedApplyDeps } from "./keyed";
import type { TriageOp, TriagePlan } from "./plan";

const UNIT = 42;
const LOOP = "tria";
const SCOPE = "acme-backoffice";

const BRIEF = [
  "## What to build",
  "",
  "Fix the export button.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] The export downloads a CSV.",
  "",
  "## Blocked by",
  "",
  "None.",
].join("\n");

const REPORT = "El botón de exportar no hace nada.\n\nPrioridad: Medium";

function fakeWith(issue: Partial<FakeIssue> = {}): FakeTracker {
  return createFakeTracker({
    kind: "linear",
    key: "AND",
    issues: [
      {
        number: UNIT,
        body: REPORT,
        labels: ["slack-intake", SCOPE, `${LOOP}-wip`],
        ...issue,
      },
    ],
  });
}

function planOf(op: Partial<TriageOp> & { op: TriageOp["op"] }, extra: Partial<TriagePlan> = {}): TriagePlan {
  const full =
    op.op === "propose"
      ? { opId: "brief", issue: UNIT, body: BRIEF, ...op }
      : { opId: "person", issue: UNIT, reason: "Falta saber qué columnas exporta.", ...op };
  return {
    unit: UNIT,
    loop: LOOP,
    attempt: 1,
    outcome: op.op as TriagePlan["outcome"],
    ops: [full as TriageOp],
    ...extra,
  };
}

const proposePlan = (extra: Partial<TriagePlan> = {}): TriagePlan => planOf({ op: "propose" }, extra);
const toPersonPlan = (): TriagePlan => planOf({ op: "to-person" });

function depsFor(tracker: FakeTracker, overrides: Partial<KeyedApplyDeps> = {}) {
  const released: number[] = [];
  const deps: KeyedApplyDeps = {
    tracker,
    rules: { scopeLabel: SCOPE, apps: APP_LABELS, loop: LOOP, autoReady: false },
    dryRun: false,
    releaseLease: (unit) => void released.push(unit),
    sleep: async () => {},
    spacingMs: 0,
    ...overrides,
  };
  return { deps, released };
}

const issueOf = (tracker: FakeTracker): FakeIssue => tracker.issues.get(UNIT)!;

describe("applyKeyedPlan: propose", () => {
  it("rewrites the body, labels it agent-proposed, drops the claim and leaves one marker", async () => {
    const tracker = fakeWith();
    const { deps, released } = depsFor(tracker);

    const result = await applyKeyedPlan(proposePlan(), deps);

    expect(result).toMatchObject({ outcome: "applied", refusals: [], problem: null });
    const issue = issueOf(tracker);
    expect(issue.body).toBe(BRIEF);
    expect(issue.labels).toContain("agent-proposed");
    expect(issue.labels).not.toContain("ready-for-agent");
    expect(issue.labels).not.toContain(`${LOOP}-wip`);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.body).toMatch(/^Triage: brief para un agente, etiquetado agent-proposed\.\n\n/);
    expect(latestTriageMarker(issue.comments)).toMatchObject({ outcome: "propose", op: "release-1", attempt: 1 });
    expect(hasCurrentTriage(issue.body, issue.comments)).toBe(true);
    expect(released).toEqual([UNIT]);
  });

  it("labels it ready-for-agent under autoReady", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker, { rules: { scopeLabel: SCOPE, apps: APP_LABELS, loop: LOOP, autoReady: true } });

    expect((await applyKeyedPlan(proposePlan(), deps)).outcome).toBe("applied");
    expect(issueOf(tracker).labels).toContain("ready-for-agent");
    expect(issueOf(tracker).labels).not.toContain("agent-proposed");
  });

  it.each([
    ["a Highest priority line", { body: "Se cae todo.\n\n**Prioridad:** Highest" }, "Prioridad Highest"],
    ["por-decidir", { labels: ["slack-intake", SCOPE, "por-decidir"] }, "por-decidir"],
    ["both app labels", { labels: ["slack-intake", SCOPE, "acme-pwa"] }, "dos apps"],
  ])("refuses a propose for a report with %s and writes nothing", async (_name, issue, reason) => {
    const tracker = fakeWith(issue);
    const { deps, released } = depsFor(tracker);

    const result = await applyKeyedPlan(proposePlan(), deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals.join("\n")).toContain("must go to a person");
    expect(result.refusals.join("\n")).toContain(reason);
    expect(tracker.writes).toEqual([]);
    expect(released).toEqual([]);
  });

  it("refuses a propose for a pwa report when the scope is the backoffice", async () => {
    // No scope label on the report: the pwa rule, not the both-apps one, is what fires.
    const tracker = fakeWith({ labels: ["slack-intake", "acme-pwa"] });
    const { deps } = depsFor(tracker, { rules: { scopeLabel: null, apps: APP_LABELS, loop: LOOP, autoReady: false } });

    const result = await applyKeyedPlan(proposePlan(), deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals.join("\n")).toContain("acme-pwa");
    expect(tracker.writes).toEqual([]);
  });

  it("refuses a brief missing a section, naming it, and writes nothing", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);
    const body = BRIEF.replace("## Blocked by", "### Blocked by");

    const result = await applyKeyedPlan(planOf({ op: "propose", body }), deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals).toEqual(['ops[0].body: is missing the "## Blocked by" section']);
    expect(tracker.writes).toEqual([]);
  });

  it("refuses a brief whose acceptance criteria have no open item", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);
    const body = BRIEF.replace("- [ ] The export downloads a CSV.", "The export downloads a CSV.");

    const result = await applyKeyedPlan(planOf({ op: "propose", body }), deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals).toEqual(['ops[0].body: "## Acceptance criteria" has no "- [ ]" item']);
    expect(tracker.writes).toEqual([]);
  });

  it("accepts section headings in any case with trailing spaces", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);
    const body = BRIEF.replace("## What to build", "## what to BUILD   ");

    expect((await applyKeyedPlan(planOf({ op: "propose", body }), deps)).outcome).toBe("applied");
  });

  it("makes no second edit, label or comment when re-run after it applied", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);
    await applyKeyedPlan(proposePlan(), deps);
    const writes = [...tracker.writes];

    const again = await applyKeyedPlan(proposePlan(), deps);

    expect(again).toMatchObject({ outcome: "applied", writes: 0 });
    expect(tracker.writes).toEqual(writes);
    expect(issueOf(tracker).comments).toHaveLength(1);
  });

  it("completes a run that crashed between the body edit and the label", async () => {
    const tracker = fakeWith();
    await tracker.editBody(UNIT, BRIEF);
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(proposePlan(), deps);

    expect(result.outcome).toBe("applied");
    const issue = issueOf(tracker);
    expect(issue.labels.filter((label) => label === "agent-proposed")).toHaveLength(1);
    expect(issue.comments).toHaveLength(1);
    expect(tracker.writes.filter((write) => write.startsWith("editBody"))).toHaveLength(1);
  });

  it("finishes a run that crashed after the label, before the marker", async () => {
    const tracker = fakeWith({ body: BRIEF, labels: ["slack-intake", SCOPE, "agent-proposed", `${LOOP}-wip`] });
    const { deps } = depsFor(tracker);

    expect((await applyKeyedPlan(proposePlan(), deps)).outcome).toBe("applied");
    expect(issueOf(tracker).labels).not.toContain(`${LOOP}-wip`);
    expect(issueOf(tracker).comments).toHaveLength(1);
  });

  it("writes nothing on a dry run, and counts what it would write", async () => {
    const tracker = fakeWith();
    const { deps, released } = depsFor(tracker, { dryRun: true });

    const result = await applyKeyedPlan(proposePlan(), deps);

    expect(result).toMatchObject({ outcome: "dry-run", writes: 4 });
    expect(tracker.writes).toEqual([]);
    expect(released).toEqual([]);
  });
});

describe("applyKeyedPlan: to-person", () => {
  it("leaves body and labels, drops the claim, and posts the reason with a current marker", async () => {
    const tracker = fakeWith();
    const { deps, released } = depsFor(tracker);

    const result = await applyKeyedPlan(toPersonPlan(), deps);

    expect(result).toMatchObject({ outcome: "applied", problem: null });
    const issue = issueOf(tracker);
    expect(issue.body).toBe(REPORT);
    expect(issue.labels).toEqual(["slack-intake", SCOPE]);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.body).toContain("Triage: requiere una persona. Falta saber qué columnas exporta.");
    expect(latestTriageMarker(issue.comments)).toMatchObject({ outcome: "to-person" });
    expect(hasCurrentTriage(issue.body, issue.comments)).toBe(true);
    expect(released).toEqual([UNIT]);
  });

  it("reports a tracker that drops the marker, still applied", async () => {
    const tracker = fakeWith();
    // A renderer that strips HTML comments, as Linear's markdown can.
    const comment = tracker.comment.bind(tracker);
    tracker.comment = (number, body) => comment(number, body.replace(/<!--[\s\S]*?-->/g, ""));
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(toPersonPlan(), deps);

    expect(result.outcome).toBe("applied");
    expect(result.problem).toContain("did not keep the triage marker on AND-42");
  });

  it("posts no second marker when re-run", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);
    await applyKeyedPlan(toPersonPlan(), deps);

    expect((await applyKeyedPlan(toPersonPlan(), deps)).outcome).toBe("applied");
    expect(issueOf(tracker).comments).toHaveLength(1);
  });
});

describe("applyKeyedPlan: refusals", () => {
  it.each([
    ["already carries an outcome label", { labels: ["slack-intake", SCOPE, "moved-to-jira"] }],
    ["is not a Slack report", { labels: [SCOPE] }],
    ["is closed", { state: "closed" as const }],
  ])("refuses an issue that %s", async (_name, issue) => {
    const tracker = fakeWith(issue);
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(toPersonPlan(), deps);

    expect(result.outcome).toBe("refused");
    expect(tracker.writes).toEqual([]);
  });

  it("says why an issue is not an untriaged report, with its labels", async () => {
    const tracker = fakeWith({ labels: ["slack-intake", SCOPE, "moved-to-jira"] });
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(toPersonPlan(), deps);

    expect(result.refusals).toEqual([
      `ops[0]: AND-${UNIT} is not an untriaged Slack report (labels: slack-intake, ${SCOPE}, moved-to-jira)`,
    ]);
  });

  it("refuses a GitHub outcome", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan({ ...toPersonPlan(), outcome: "routed" }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals.join("\n")).toContain("on a linear tracker the triager's outcomes are propose and to-person");
    expect(tracker.writes).toEqual([]);
  });

  it("refuses two ops", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker);
    const plan = toPersonPlan();

    const result = await applyKeyedPlan({ ...plan, ops: [...plan.ops, { ...plan.ops[0]!, opId: "again" }] }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals.join("\n")).toContain("exactly one op");
    expect(tracker.writes).toEqual([]);
  });

  it("refuses an op on another issue", async () => {
    const tracker = fakeWith();
    tracker.put({ number: 7, labels: ["slack-intake", SCOPE] });
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(planOf({ op: "to-person", issue: 7 }), deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusals.join("\n")).toContain(`ops[0].issue: must be the plan's unit AND-${UNIT}`);
    expect(tracker.writes).toEqual([]);
  });

  it("refuses another loop's plan", async () => {
    const tracker = fakeWith();
    const { deps } = depsFor(tracker, { rules: { scopeLabel: SCOPE, apps: APP_LABELS, loop: "rafa", autoReady: false } });

    expect((await applyKeyedPlan(toPersonPlan(), deps)).outcome).toBe("refused");
    expect(tracker.writes).toEqual([]);
  });
});

describe("applyKeyedPlan: tracker failures", () => {
  it("reports a throttled read as rate-limited and writes nothing", async () => {
    const tracker = fakeWith();
    tracker.failNext("issue", new FakeThrottle({ kind: "secondary", retryAfterSeconds: 60 }));
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(proposePlan(), deps);

    expect(result.outcome).toBe("rate-limited");
    expect(tracker.writes).toEqual([]);
  });

  it("reports a throttled write as rate-limited with the writes made, and a re-run completes it", async () => {
    const tracker = fakeWith();
    tracker.failNext("addLabels", new FakeThrottle({ kind: "secondary", retryAfterSeconds: 60 }));
    const { deps } = depsFor(tracker);

    expect(await applyKeyedPlan(proposePlan(), deps)).toMatchObject({ outcome: "rate-limited", writes: 1 });
    expect((await applyKeyedPlan(proposePlan(), deps)).outcome).toBe("applied");
    expect(issueOf(tracker).labels.filter((label) => label === "agent-proposed")).toHaveLength(1);
    expect(issueOf(tracker).comments).toHaveLength(1);
  });

  it("reports a failed -wip removal and still applies", async () => {
    const tracker = fakeWith();
    tracker.failNext("removeLabels", new Error("label gone"));
    const { deps } = depsFor(tracker);

    const result = await applyKeyedPlan(toPersonPlan(), deps);

    expect(result.outcome).toBe("applied");
    expect(result.problem).toBe(`could not remove ${LOOP}-wip from AND-42: label gone`);
    expect(issueOf(tracker).comments).toHaveLength(1);
  });

  it("lets a not-connected tracker propagate, for the caller to exit on", async () => {
    const tracker = fakeWith();
    tracker.failNext("issue", new TrackerUnavailableError("no credential", "not-connected"));
    const { deps } = depsFor(tracker);

    await expect(applyKeyedPlan(proposePlan(), deps)).rejects.toBeInstanceOf(TrackerUnavailableError);
    expect(tracker.writes).toEqual([]);
  });

  it("reports any other failure as failed", async () => {
    const tracker = fakeWith();
    tracker.failNext("editBody", new Error("boom"));
    const { deps } = depsFor(tracker);

    expect(await applyKeyedPlan(proposePlan(), deps)).toMatchObject({ outcome: "failed", problem: "boom", writes: 0 });
  });
});
