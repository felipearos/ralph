// @vitest-environment node
/**
 * The confirmation sweep through the gate's poll (felipearos/ralph#449): it
 * runs after the channel on every poll that reaches Slack, its notes ride on
 * the verdict, and nothing it meets — a Jira outage, a status name the board
 * does not have, a refused credential — takes a hand-over away or hangs the
 * loop. Shadow makes no Jira write at all.
 *
 * In-process against a fake Slack and a fake Jira at the HTTP seam, as
 * `clerk/gate-apply.test.ts` drives the gate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, CLERK_JIRA_DEFAULTS, type ClerkRules } from "../project-config";
import { after, fakeJira, fakeSlack, INTAKE_WORKFLOW, SITE, type FakeJira, type FakeSlack, type FakeWorkflow, APP_LABELS } from "./fakes";
import { noCache, poll, type Denial, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import type { MetricsEvent } from "./metrics";
import { slackClient, tsMs } from "./slack";
import { readClerkStore, withClerkStore } from "./store";

const CHANNEL = "C0TESTCHAN1";
const LIVE: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode: "live",
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: "F0SHADOWCV1",
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI" },
  prRepos: ["example-org/acme-backoffice", "example-org/acme-pwa"],
};
const SHADOW: ClerkRules = { ...LIVE, mode: "shadow" };
const T0 = "1760961600.000000";
const HOUR = 3_600_000;
const CONFIRMER = { accountId: "557058:ana", displayName: "Ana Pérez" };

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  storePath: string;
  events: MetricsEvent[];
  stops: Denial[];
  deps: (minutes: number) => PollDeps;
  store: () => ReturnType<typeof readClerkStore>["store"];
}

async function rig(rules: ClerkRules, workflow: FakeWorkflow = INTAKE_WORKFLOW): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-gate-confirm-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { canvases: [rules.shadowCanvas!] });
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: workflow } });
  const events: MetricsEvent[] = [];
  const stops: Denial[] = [];
  const deps = (minutes: number): PollDeps => ({
    rules,
    now: () => tsMs(after(T0, minutes)),
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    ledger: (event) => events.push(event) > 0,
    intervalSeconds: 300,
    readPlan: () => undefined,
    journal: () => {},
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: (denial) => {
      stops.push(denial);
      return true;
    },
  });
  // The first poll starts the store at T0; the sweep runs from the next.
  await poll(deps(0), noCache());
  await withClerkStore(storePath, CHANNEL, (store) => {
    store.determinations = {
      "OAI-7": { type: "Error", priority: "High", app: "Backoffice", assignee: "agent", difficulty: "medium", storyPoints: 3, filedAt: new Date(Date.now() - 3 * HOUR).toISOString() },
    };
  });
  return { slack, jira, storePath, events, stops, deps, store: () => readClerkStore(storePath, CHANNEL).store };
}

/** OAI-7, as a person has just confirmed it with `labels`. */
const confirm = (r: Rig, labels: string[], status = "Confirmado"): void =>
  r.jira.add({
    key: "OAI-7",
    summary: "No se puede exportar el reporte",
    type: "Error",
    status,
    statusCategory: "indeterminate",
    priority: "High",
    labels: ["slack-intake", "acme-backoffice", ...labels],
    created: new Date(Date.now() - 3 * HOUR).toISOString(),
    description: "Al exportar no se descarga nada.",
    history: [{ from: "Por confirmar", to: status, at: new Date(Date.now() - HOUR).toISOString(), by: CONFIRMER }],
  });

const sweepNotes = (notes: readonly string[] | undefined): string[] => (notes ?? []).filter((note) => !/canvas/.test(note));

describe("the confirmation sweep in the gate's poll", () => {
  it("acts on a confirmed ticket on a quiet poll, and says so in the poll's notes", async () => {
    const r = await rig(LIVE);
    confirm(r, ["difficulty:hard", "para-agente"]);
    const { verdict } = await poll(r.deps(5), noCache());
    expect(verdict).toMatchObject({ work: false });
    expect(verdict.stop).toBeUndefined();
    expect(sweepNotes(verdict.notes)).toEqual(["OAI-7 confirmed for an agent by Ana Pérez: labelled 'ready-for-agent'"]);
    expect(r.jira.issues.find((issue) => issue.key === "OAI-7")!.labels).toContain("ready-for-agent");
    expect(r.events.map((event) => event.kind)).toEqual(["confirmed"]);
    expect(r.events[0]).toMatchObject({ mode: "live", overrides: [{ field: "difficulty", agent: "medium", human: "hard" }] });
  });

  it("records the close of a confirmed ticket on a later poll, after the sweep (#450)", async () => {
    const r = await rig(LIVE);
    confirm(r, ["para-agente"]);
    await poll(r.deps(5), noCache());
    // The coder loop finished it on the board.
    Object.assign(r.jira.issues.find((issue) => issue.key === "OAI-7")!, { status: "Listo", statusCategory: "done", resolution: "Done", resolved: new Date().toISOString() });
    const { verdict } = await poll(r.deps(6), noCache());
    expect(sweepNotes(verdict.notes)).toEqual(["OAI-7 closed in 'Listo' as 'Done': recorded"]);
    expect(r.events.map((event) => event.kind)).toEqual(["confirmed", "closed"]);
    expect(r.events[1]).toMatchObject({ key: "OAI-7", mode: "live", resolution: "Done", status: "Listo" });
    await poll(r.deps(7), noCache());
    expect(r.events).toHaveLength(2);
  });

  it("never takes a hand-over away: a Jira failure in the sweep is a note on a poll that hands a batch over", async () => {
    const r = await rig(LIVE);
    confirm(r, ["para-agente"]);
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte" });
    r.jira.fail("/rest/api/3/issue/OAI-7", { status: 503 }, { method: "GET" });
    const { verdict } = await poll(r.deps(15), noCache());
    expect(verdict.work).toBe(true);
    expect(sweepNotes(verdict.notes).join("\n")).toMatch(/OAI-7 \(to-agent\) was not finished: .*503.*; tried again at the next poll/);
    // The next poll finishes it.
    await poll(r.deps(16), noCache());
    expect(r.jira.issues.find((issue) => issue.key === "OAI-7")!.labels).toContain("ready-for-agent");
    expect(r.events.filter((event) => event.kind === "confirmed")).toHaveLength(1);
  });

  it("keeps polling past a status name the board refuses", async () => {
    const r = await rig({ ...LIVE, jira: { ...LIVE.jira, statuses: { ...CLERK_JIRA_DEFAULTS.statuses, confirmed: "Aprobadísimo" } } });
    r.jira.fail("/rest/api/3/search/jql", { status: 400 });
    const first = await poll(r.deps(5), noCache());
    expect(first.verdict.stop).toBeUndefined();
    expect(first.verdict.waitSeconds).toBeUndefined();
    expect(sweepNotes(first.verdict.notes)).toEqual([expect.stringMatching(/could not be searched for confirmed tickets: .*HTTP 400/)]);
    expect(r.stops).toEqual([]);
    expect((await poll(r.deps(6), first.cached)).verdict.stop).toBeUndefined();
  });

  it("stops a live loop on a refused credential when it has nothing to hand over", async () => {
    const r = await rig(LIVE);
    r.jira.fail("/rest/api/3/search/jql", { status: 401 });
    const { verdict } = await poll(r.deps(5), noCache());
    expect(verdict.stop).toMatchObject({ queued: true });
    expect(r.stops.map((denial) => denial.code)).toEqual(["jira_unauthorized"]);
  });

  it("in shadow makes no Jira write, says what it would do, and records it marked shadow", async () => {
    const r = await rig(SHADOW);
    confirm(r, ["para-persona"]);
    const { verdict } = await poll(r.deps(5), noCache());
    expect(r.jira.writes()).toEqual([]);
    expect(sweepNotes(verdict.notes)).toEqual([
      "shadow: OAI-7 confirmed to-person by Ana Pérez — would move OAI-7 to OA, link it and comment the OA key on it, label it 'moved-to-jira' and close it as 'Movido'",
    ]);
    expect(r.events.map((event) => `${event.kind} ${event.mode}`)).toEqual(["confirmed shadow", "moved shadow"]);
    expect(r.store().shadow.writes.map((entry) => entry.write.kind)).toEqual(["confirm"]);
    // A shadow denial is a note: shadow writes nothing real to lose.
    r.jira.fail("/rest/api/3/search/jql", { status: 401 });
    expect((await poll(r.deps(6), noCache())).verdict.stop).toBeUndefined();
    expect(r.jira.writes()).toEqual([]);
  });
});

/** The Slack calls that only read. */
const READS = new Set(["auth.test", "conversations.history", "conversations.replies", "users.info", "conversations.info", "conversations.members"]);

const oaTickets = (r: Rig) => r.jira.issues.filter((issue) => issue.key.startsWith("OA-"));

/** OAI-7 confirmed for a person and held: nothing on OA, still confirmed on the intake board, labelled for the move. */
async function expectHeld(r: Rig, mode: "quiet" | "live"): Promise<void> {
  const { verdict } = await poll(r.deps(5), noCache());
  const ticket = r.jira.issues.find((issue) => issue.key === "OAI-7")!;
  expect(oaTickets(r)).toEqual([]);
  expect(ticket.status).toBe("Confirmado");
  expect(ticket.labels).toEqual(["slack-intake", "acme-backoffice", "para-persona", "para-mover-a-oa"]);
  expect(sweepNotes(verdict.notes)).toEqual([
    `${mode === "live" ? "" : "quiet: "}OAI-7 confirmed for a person by Ana Pérez: not moved to OA (held: 'clerk.holdOaMove'), labelled 'para-mover-a-oa'`,
  ]);
  expect(r.events.map((event) => `${event.kind} ${event.mode}`)).toEqual([`confirmed ${mode}`, `moved ${mode}`]);
  expect(r.events[1]).toMatchObject({ key: "OAI-7", oaKey: "HELD-OAI7", held: true });
  expect(r.store().confirmed?.["OAI-7"]).toMatchObject({ outcome: "to-person", done: true, oaKey: "HELD-OAI7" });
  // The label is the one write, and the next poll does nothing twice.
  expect(r.jira.writes().map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /rest/api/3/issue/OAI-7"]);
  await poll(r.deps(6), noCache());
  expect(r.events).toHaveLength(2);
  expect(r.jira.writes()).toHaveLength(1);
}

/** OAI-7 confirmed for a person and moved for real: an OA ticket, the intake one closed as Movido. */
async function expectMoved(r: Rig, mode: "quiet" | "live"): Promise<void> {
  const { verdict } = await poll(r.deps(5), noCache());
  const oa = oaTickets(r);
  expect(oa).toHaveLength(1);
  const ticket = r.jira.issues.find((issue) => issue.key === "OAI-7")!;
  expect(ticket.status).toBe("Movido");
  expect(ticket.labels).toContain("moved-to-jira");
  expect(ticket.labels).not.toContain("para-mover-a-oa");
  expect(sweepNotes(verdict.notes)).toEqual([`${mode === "live" ? "" : "quiet: "}OAI-7 confirmed for a person by Ana Pérez: moved to ${oa[0]!.key}`]);
  expect(r.events.map((event) => `${event.kind} ${event.mode}`)).toEqual([`confirmed ${mode}`, `moved ${mode}`]);
  expect(r.events[1]).toMatchObject({ oaKey: oa[0]!.key });
  expect(r.events[1]).not.toHaveProperty("held");
}

describe("holding the move to OA (clerk.holdOaMove, felipearos/ralph#443)", () => {
  it("live moves by default", async () => {
    const r = await rig(LIVE);
    confirm(r, ["para-persona"]);
    await expectMoved(r, "live");
  });

  it("live with holdOaMove files nothing on OA: a test clerk on a private channel never reaches the team's board", async () => {
    const r = await rig({ ...LIVE, holdOaMove: true });
    confirm(r, ["para-persona"]);
    await expectHeld(r, "live");
  });
});

describe("the confirmation sweep of a quiet clerk (felipearos/ralph#443)", () => {
  const QUIET: ClerkRules = { ...LIVE, mode: "quiet" };

  it("holds a to-person move by default, and writes nothing in Slack but the operator's canvas", async () => {
    const r = await rig(QUIET);
    confirm(r, ["para-persona"]);
    await expectHeld(r, "quiet");
    // In Slack, only the operator's canvas: never a post, never the channel's.
    const writes = r.slack.calls.filter((call) => !READS.has(call.method));
    expect(writes.map((call) => `${call.method} ${call.body?.canvas_id ?? call.params.canvas_id}`)).toEqual(writes.map(() => "canvases.edit F0SHADOWCV1"));
  });

  it("moves for real with holdOaMove off, as live does, the ledger marked quiet", async () => {
    const r = await rig({ ...QUIET, holdOaMove: false });
    confirm(r, ["para-persona"]);
    await expectMoved(r, "quiet");
  });

  it("adds ready-for-agent to a confirmed to-agent ticket for real, and stops on a refused credential as live does", async () => {
    const r = await rig(QUIET);
    confirm(r, ["para-agente"]);
    const { verdict } = await poll(r.deps(5), noCache());
    expect(sweepNotes(verdict.notes)).toEqual(["quiet: OAI-7 confirmed for an agent by Ana Pérez: labelled 'ready-for-agent'"]);
    expect(r.jira.issues.find((issue) => issue.key === "OAI-7")!.labels).toContain("ready-for-agent");
    r.jira.fail("/rest/api/3/search/jql", { status: 401 });
    expect((await poll(r.deps(6), noCache())).verdict.stop).toMatchObject({ queued: true });
    expect(r.stops.map((denial) => denial.code)).toEqual(["jira_unauthorized"]);
  });

  it("records a rejection as noise, marked quiet", async () => {
    const r = await rig(QUIET);
    confirm(r, ["para-agente"], "Descartado");
    await poll(r.deps(5), noCache());
    expect(r.events.map((event) => `${event.kind} ${event.mode}`)).toEqual(["rejected quiet"]);
  });
});

describe("the resolved reply through the gate's poll", () => {
  /** A report posted an hour before the clerk started, filed as OAI-7: its thread is the one a reply goes in. */
  const REPORT = after(T0, -60);

  async function closed(rules: ClerkRules): Promise<Rig> {
    const r = await rig(rules);
    r.slack.post({ ts: REPORT, user: "U0ANA", text: "No puedo exportar el reporte" });
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.processed[REPORT] = { state: "filed", key: "OAI-7", at: new Date(Date.now() - 3 * HOUR).toISOString() };
      store.confirmed = { "OAI-7": { outcome: "to-agent", at: new Date(Date.now() - 2 * HOUR).toISOString(), done: true } };
    });
    // The coder loop finished it on the board.
    confirm(r, ["para-agente", "ready-for-agent"], "Listo");
    Object.assign(r.jira.issues.find((issue) => issue.key === "OAI-7")!, { statusCategory: "done", resolution: "Done", resolved: new Date().toISOString() });
    return r;
  }

  const threadPosts = (r: Rig): string[] =>
    r.slack.calls.filter((call) => call.method === "chat.postMessage" && call.params.thread_ts === REPORT).map((call) => call.params.text!);

  it("live tells the reporter once, and the next polls post nothing more", async () => {
    const r = await closed(LIVE);
    const { verdict } = await poll(r.deps(5), noCache());
    expect(sweepNotes(verdict.notes)).toContain(`OAI-7: told report ${REPORT} in its thread that it is resolved`);
    expect(threadPosts(r)).toEqual(["Resuelto: OAI-7 ya está listo. Gracias por reportarlo."]);
    await poll(r.deps(6), noCache());
    await poll(r.deps(7), noCache());
    expect(threadPosts(r)).toHaveLength(1);
  });

  it("live waits for the ticket's PR to be merged before telling the reporter", async () => {
    const r = await closed(LIVE);
    const pr = { repo: "example-org/acme-pwa", number: 41, url: "https://github.com/example-org/acme-pwa/pull/41", at: new Date().toISOString(), keys: ["OAI-7"] };
    await poll({ ...r.deps(5), pulls: async () => ({ pulls: [{ ...pr, state: "abierto" as const }], note: null }) }, noCache());
    expect(threadPosts(r)).toEqual([]);
    await poll({ ...r.deps(6), pulls: async () => ({ pulls: [{ ...pr, state: "mergeado" as const }], note: null }) }, noCache());
    expect(threadPosts(r)).toEqual(["Resuelto: OAI-7 ya está listo. Gracias por reportarlo."]);
  });

  for (const mode of ["quiet", "shadow"] as const) {
    it(`${mode} records the close and never posts in the thread`, async () => {
      const r = await closed({ ...LIVE, mode });
      await poll(r.deps(5), noCache());
      await poll(r.deps(6), noCache());
      expect(r.events.filter((event) => event.kind === "closed")).toEqual([expect.objectContaining({ key: "OAI-7", report: REPORT, mode })]);
      expect(r.slack.calls.filter((call) => call.method === "chat.postMessage")).toEqual([]);
      expect(r.store().outcomes?.replies).toBeUndefined();
    });
  }
});

describe("the merged move through the gate's poll", () => {
  const REPORT = after(T0, -60);
  const MERGED: ClerkRules = { ...LIVE, jira: { ...LIVE.jira, mergedStatus: "Mergeado" } };
  const WORKFLOW: FakeWorkflow = {
    statuses: [...INTAKE_WORKFLOW.statuses, { name: "Mergeado", category: "done" }],
    transitions: { ...INTAKE_WORKFLOW.transitions, "En curso": ["Listo", "Mergeado"] },
  };
  const pr = { repo: "example-org/acme-pwa", number: 41, url: "https://github.com/example-org/acme-pwa/pull/41", at: new Date().toISOString(), keys: ["OAI-7"] };

  /** OAI-7 confirmed for an agent, which handed its PR to a person and left the ticket in work. */
  async function handedOff(rules: ClerkRules): Promise<Rig> {
    const r = await rig(rules, WORKFLOW);
    r.slack.post({ ts: REPORT, user: "U0ANA", text: "No puedo exportar el reporte" });
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.processed[REPORT] = { state: "filed", key: "OAI-7", at: new Date(Date.now() - 3 * HOUR).toISOString() };
      store.confirmed = { "OAI-7": { outcome: "to-agent", at: new Date(Date.now() - 2 * HOUR).toISOString(), done: true } };
    });
    confirm(r, ["para-agente", "ready-for-agent", "ralph-done"], "En curso");
    return r;
  }

  it("live moves the ticket once its PR is merged, and tells the reporter on the same poll", async () => {
    const r = await handedOff(MERGED);
    await poll({ ...r.deps(5), pulls: async () => ({ pulls: [{ ...pr, state: "abierto" as const }], note: null }) }, noCache());
    expect(r.jira.issues.find((issue) => issue.key === "OAI-7")!.status).toBe("En curso");
    const { verdict } = await poll({ ...r.deps(6), pulls: async () => ({ pulls: [{ ...pr, state: "mergeado" as const }], note: null }) }, noCache());
    expect(verdict.notes).toContain("OAI-7: example-org/acme-pwa#41 is merged, moved from 'En curso' to 'Mergeado'");
    expect(r.jira.issues.find((issue) => issue.key === "OAI-7")!.status).toBe("Mergeado");
    expect(r.slack.calls.filter((call) => call.method === "chat.postMessage" && call.params.thread_ts === REPORT).map((call) => call.params.text)).toEqual([
      "Resuelto: OAI-7 ya está listo. Gracias por reportarlo.",
    ]);
  });

  it("shadow never moves it", async () => {
    const r = await handedOff({ ...MERGED, mode: "shadow" });
    await poll({ ...r.deps(5), pulls: async () => ({ pulls: [{ ...pr, state: "mergeado" as const }], note: null }) }, noCache());
    expect(r.jira.issues.find((issue) => issue.key === "OAI-7")!.status).toBe("En curso");
  });
});
