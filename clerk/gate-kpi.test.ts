// @vitest-environment node
/**
 * The daily KPI DM from the gate's poll (felipearos/ralph#453): sent once on a
 * weekday after 09:00 Santiago, never a reason for the poll to stop, wait or
 * hand nothing over, and never a throw. Against a fake Slack at the HTTP seam.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, KPI_REPORT_DEFAULTS, type ClerkRules } from "../project-config";
import { SITE, fakeJira, fakeSlack, type FakeSlack, APP_LABELS } from "./fakes";
import { noCache, poll, type Denial, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import type { KpiDeps } from "./kpi";
import { slackClient } from "./slack";

const CHANNEL = "C0TESTCHAN1";
const OPERATOR = "U0OPERATOR1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: "F0SHADOWCV1",
  operator: OPERATOR,
  jira: { site: "example.atlassian.net", project: "OA" },
  kpiReport: { ...KPI_REPORT_DEFAULTS, recipients: ["U0LEADER01"] },
};

/** Thursday 2026-10-22, 08:00 Santiago (UTC-3). */
const START = Date.parse("2026-10-22T11:00:00Z");
const minutes = (count: number): number => START + count * 60_000;

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function rig(ignoreUsers?: string[]): { slack: FakeSlack; deps: (at: number) => PollDeps; stops: Denial[] } {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-gate-kpi-"));
  roots.push(dir);
  const slack = fakeSlack(CHANNEL, { canvases: ["F0SHADOWCV1"], members: ["U0ANA00001", "U0TEAM0001"] });
  const stops: Denial[] = [];
  // One process: the memo is shared by every poll, as the gate's loop shares it.
  const kpi: KpiDeps = {
    rules: RULES.kpiReport!,
    clerkMode: "shadow",
    operator: OPERATOR,
    channel: CHANNEL,
    ...(ignoreUsers === undefined ? {} : { ignoreUsers }),
    metricsPath: join(dir, "clara.metrics.jsonl"),
    statePath: join(dir, "clara.kpi.json"),
    memo: { doneDay: null },
  };
  const deps = (at: number): PollDeps => ({
    rules: RULES,
    now: () => at,
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, fakeJira("OA").fetch),
    storePath: join(dir, "clara.json"),
    readPlan: () => undefined,
    journal: () => {},
    intervalSeconds: 300,
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: (denial) => {
      stops.push(denial);
      return true;
    },
    kpi,
  });
  return { slack, deps, stops };
}

describe("the KPI DM from the gate's poll", () => {
  it("sends the draft to the operator once, at the first poll after 09:00, and logs it", async () => {
    const r = rig();
    // The first poll only starts the clock.
    await poll({ ...r.deps(minutes(0)), now: () => minutes(0) }, noCache());
    const early = await poll(r.deps(minutes(30)), noCache());
    expect(r.slack.dms).toEqual([]);
    expect(early.verdict.notes ?? []).not.toContainEqual(expect.stringContaining("kpi"));

    const due = await poll(r.deps(minutes(65)), noCache());
    expect(due.verdict.work).toBe(false);
    expect(due.verdict.notes).toContain(`kpi draft for 2026-10-22 sent to ${OPERATOR}`);
    expect(r.slack.dms.map((dm) => dm.user)).toEqual([OPERATOR]);

    await poll(r.deps(minutes(70)), noCache());
    expect(r.slack.dms).toHaveLength(1);
  });

  it("leaves the ignored team members out of the members it counts (clerk.ignoreUsers)", async () => {
    const quietLine = async (ignore?: string[]): Promise<string> => {
      const r = rig(ignore);
      await poll({ ...r.deps(minutes(0)), now: () => minutes(0) }, noCache());
      await poll(r.deps(minutes(65)), noCache());
      return r.slack.dms[0]!.text.split("\n").find((line) => line.startsWith("- Sin reportes en los últimos")) ?? "";
    };
    expect(await quietLine()).toContain("U0TEAM0001");
    const ignored = await quietLine(["U0TEAM0001"]);
    expect(ignored).toContain("U0ANA00001");
    expect(ignored).not.toContain("U0TEAM0001");
  });

  it("keeps a failed send to a note: no stop, no backoff, and a retry next poll", async () => {
    const r = rig();
    await poll({ ...r.deps(minutes(0)), now: () => minutes(0) }, noCache());
    r.slack.fail("conversations.open", { error: "missing_scope", needed: "im:write" });
    const failed = await poll(r.deps(minutes(65)), noCache());
    expect(failed.verdict.stop).toBeUndefined();
    expect(failed.verdict.waitSeconds).toBeUndefined();
    expect(r.stops).toEqual([]);
    expect(failed.verdict.notes?.join("\n")).toContain("missing_scope");

    await poll(r.deps(minutes(70)), noCache());
    expect(r.slack.dms.map((dm) => dm.user)).toEqual([OPERATOR]);
  });

  it("sends nothing when the poll is backing off", async () => {
    const r = rig();
    await poll({ ...r.deps(minutes(0)), now: () => minutes(0) }, noCache());
    r.slack.fail("conversations.history", { status: 503 });
    const backoff = await poll(r.deps(minutes(65)), noCache());
    expect(backoff.verdict.waitSeconds).toBeDefined();
    expect(r.slack.dms).toEqual([]);
  });

  it("sends nothing without a kpiReport block", async () => {
    const r = rig();
    const deps = (at: number): PollDeps => ({ ...r.deps(at), kpi: null });
    await poll({ ...deps(minutes(0)), now: () => minutes(0) }, noCache());
    await poll(deps(minutes(65)), noCache());
    expect(r.slack.dms).toEqual([]);
    expect(r.slack.calls.map((call) => call.method)).not.toContain("conversations.open");
  });
});
