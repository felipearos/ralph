/**
 * The confirmation sweep on the intake board (felipearos/ralph#449): the pure
 * decision and its overrides, then `sweep` against the fake Jira at its HTTP
 * seam, live and shadow, with the store on disk.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, CLERK_JIRA_DEFAULTS, type ClerkRules } from "../project-config";
import { intakeMarker } from "../triage/handoff";
import {
  CONFIRM_PER_POLL,
  decide,
  readOnly,
  shadowMovedKey,
  sweep,
  sweepJql,
  type DecideRules,
  type SweepDeps,
  channelOf,
  ownsTicket,
} from "./confirm";
import { INTAKE_WORKFLOW, SITE, fakeJira, type FakeIssue, type FakeJira, type FakeWorkflow, APP_LABELS } from "./fakes";
import { LINK_TYPES, jiraClient, type JiraClient, type JiraIssue } from "./jira";
import type { ConfirmedEvent, MetricsEvent } from "./metrics";
import { readClerkStore, withClerkStore, type Determination } from "./store";

const CHANNEL = "C0TESTCHAN1";
const POINTS = "customfield_10016";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode: "live",
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: null,
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI", storyPointsField: POINTS },
};
const DECIDE: DecideRules = { statuses: CLERK_JIRA_DEFAULTS.statuses, storyPointsField: POINTS, appLabels: APP_LABELS };
const HOUR = 3_600_000;
const NOW = Date.now();
const CONFIRMER = { accountId: "557058:ana", displayName: "Ana Pérez" };
const PERMALINK = "https://example.slack.com/archives/C0TESTCHAN1/p1760961660000000";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const SNAPSHOT: Determination = {
  type: "Error",
  priority: "High",
  app: "Backoffice",
  assignee: "agent",
  difficulty: "medium",
  storyPoints: 3,
  filedAt: new Date(NOW - 5 * HOUR).toISOString(),
  summary: "No se puede exportar el reporte",
  description: `Al exportar no se descarga nada.\n\nReportado por Ana en Slack: ${PERMALINK}`,
  permalink: PERMALINK,
};

/** A ticket as the search reads it, confirmed for an agent exactly as the clerk filed it. */
const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "OAI-7",
  summary: SNAPSHOT.summary!,
  type: "Error",
  status: "Confirmado",
  statusCategory: "indeterminate",
  priority: "High",
  labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente"],
  created: SNAPSHOT.filedAt,
  resolved: null,
  description: SNAPSHOT.description!,
  comments: 0,
  doneAt: null,
  commentTexts: [],
  storyPoints: 3,
  assignee: null,
  reporter: null,
  resolution: null,
  ...over,
});

describe("decide", () => {
  it("routes by status and by the para-* label the confirmer left", () => {
    expect(decide(issue(), SNAPSHOT, DECIDE)).toEqual({ outcome: "to-agent", overrides: [] });
    const person = issue({ labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona"] });
    expect(decide(person, SNAPSHOT, DECIDE)?.outcome).toBe("to-person");
    // Neither label is a person's; both is a person's too.
    expect(decide(issue({ labels: ["slack-intake", "acme-backoffice", "difficulty:medium"] }), SNAPSHOT, DECIDE)?.outcome).toBe("to-person");
    expect(decide(issue({ labels: ["slack-intake", "para-agente", "para-persona"] }), SNAPSHOT, DECIDE)?.outcome).toBe("to-person");
    expect(decide(issue({ status: "Descartado" }), SNAPSHOT, DECIDE)?.outcome).toBe("rejected");
    expect(decide(issue({ status: "Por confirmar" }), SNAPSHOT, DECIDE)).toBeNull();
  });

  it("follows the configured status names", () => {
    const statuses = { ...CLERK_JIRA_DEFAULTS.statuses, confirmed: "Aprobado", rejected: "Rechazado" };
    expect(decide(issue({ status: "Aprobado" }), SNAPSHOT, { ...DECIDE, statuses })?.outcome).toBe("to-agent");
    expect(decide(issue({ status: "Rechazado" }), SNAPSHOT, { ...DECIDE, statuses })?.outcome).toBe("rejected");
    expect(decide(issue({ status: "Confirmado" }), SNAPSHOT, { ...DECIDE, statuses })).toBeNull();
  });

  it("keeps every changed field with the clerk's value and the person's", () => {
    const edited = issue({
      type: "Tarea",
      priority: "Highest",
      labels: ["slack-intake", "acme-backoffice", "acme-pwa", "difficulty:hard", "para-persona"],
      storyPoints: 5,
      summary: "Exportar checklists falla en ambas apps",
      description: "Otra descripción.",
    });
    expect(decide(edited, SNAPSHOT, DECIDE)?.overrides).toEqual([
      { field: "type", agent: "Error", human: "Tarea" },
      { field: "priority", agent: "High", human: "Highest" },
      { field: "app", agent: "Backoffice", human: "both" },
      { field: "difficulty", agent: "medium", human: "hard" },
      { field: "storyPoints", agent: 3, human: 5 },
      { field: "assigneeKind", agent: "agent", human: "person" },
      { field: "summary", agent: SNAPSHOT.summary, human: "Exportar checklists falla en ambas apps" },
      { field: "description", agent: SNAPSHOT.description, human: "Otra descripción." },
    ]);
  });

  it("is not fooled by what the round trip or the clerk's own label spelling changes", () => {
    // `none` is filed with the backoffice label; Jira hands text back with its own whitespace.
    const none = { ...SNAPSHOT, app: "none" as const };
    expect(decide(issue({ description: `Al exportar   no se\ndescarga nada.  Reportado por Ana en Slack: ${PERMALINK}` }), none, DECIDE)?.overrides).toEqual([]);
  });

  it("has no overrides without a snapshot, and no points override without a points field", () => {
    expect(decide(issue({ storyPoints: 8 }), null, DECIDE)).toEqual({ outcome: "to-agent", overrides: null });
    expect(decide(issue({ storyPoints: null }), SNAPSHOT, { ...DECIDE, storyPointsField: null })?.overrides).toEqual([]);
    // A snapshot from before the text was kept compares no text.
    const { summary: _summary, description: _description, ...old } = SNAPSHOT;
    expect(decide(issue({ summary: "x", description: "y" }), old, DECIDE)?.overrides).toEqual([]);
  });
});

describe("sweepJql", () => {
  it("asks for the board's open confirmed and rejected tickets not yet fenced", () => {
    expect(sweepJql("OAI", CLERK_JIRA_DEFAULTS.statuses)).toBe(
      'project = "OAI" AND labels = "slack-intake" AND status in ("Confirmado", "Descartado") AND labels not in ("ready-for-agent", "moved-to-jira") AND updated >= -90d ORDER BY updated DESC',
    );
  });
});

interface Rig {
  jira: FakeJira;
  client: JiraClient;
  events: MetricsEvent[];
  storePath: string;
  deps: (over?: Partial<SweepDeps>) => SweepDeps;
  store: () => ReturnType<typeof readClerkStore>["store"];
}

async function rig(workflow: FakeWorkflow = INTAKE_WORKFLOW): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-confirm-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: workflow } });
  jira.actor = CONFIRMER;
  const client = jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch);
  const events: MetricsEvent[] = [];
  await withClerkStore(storePath, CHANNEL, (store) => {
    store.cursor = "1760961600.000000";
    store.processed["1760961660.000000"] = { state: "filed", key: "OAI-7", at: SNAPSHOT.filedAt };
    store.determinations = { "OAI-7": SNAPSHOT };
  });
  const deps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
    rules: RULES,
    board: { mode: "live", jira: client, holdOaMove: false },
    storePath,
    now: () => NOW,
    ledger: (event) => events.push(event) > 0,
    ...over,
  });
  return { jira, client, events, storePath, deps, store: () => readClerkStore(storePath, CHANNEL).store };
}

/** A ticket the clerk filed and a person has just moved to `to`, changing what `over` says. */
function confirmed(r: Rig, over: Partial<FakeIssue> = {}, to = "Confirmado"): FakeIssue {
  const ticket: FakeIssue = {
    key: "OAI-7",
    summary: SNAPSHOT.summary!,
    type: "Error",
    status: to,
    statusCategory: to === "Descartado" ? "done" : "indeterminate",
    priority: "High",
    labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente"],
    created: SNAPSHOT.filedAt,
    description: SNAPSHOT.description,
    custom: { [POINTS]: 3 },
    history: [{ from: "Por confirmar", to, at: new Date(NOW - HOUR).toISOString(), by: CONFIRMER }],
    ...over,
  };
  r.jira.add(ticket);
  return r.jira.issues.find((one) => one.key === ticket.key)!;
}

const kinds = (events: readonly MetricsEvent[]): string[] => events.map((event) => `${event.kind} ${event.mode} ${event.key}`);

describe("sweep, live", () => {
  it("labels a confirmed agent ticket ready-for-agent, keeps the confirmer's difficulty, and records both overrides and who", async () => {
    const r = await rig();
    const ticket = confirmed(r, { labels: ["slack-intake", "acme-backoffice", "difficulty:hard", "para-agente"], custom: { [POINTS]: 5 } });
    const result = await sweep(r.deps());
    expect(result.denial).toBeNull();
    expect(result.notes).toEqual(["OAI-7 confirmed for an agent by Ana Pérez: labelled 'ready-for-agent'"]);
    expect(ticket.labels).toEqual(["slack-intake", "acme-backoffice", "difficulty:hard", "para-agente", "ready-for-agent"]);
    expect(kinds(r.events)).toEqual(["confirmed live OAI-7"]);
    const event = r.events[0] as ConfirmedEvent;
    expect(event).toMatchObject({ report: "1760961660.000000", by: CONFIRMER, latencyMs: 4 * HOUR });
    expect(event.overrides).toEqual([
      { field: "difficulty", agent: "medium", human: "hard" },
      { field: "storyPoints", agent: 3, human: 5 },
    ]);
    expect(r.store().confirmed?.["OAI-7"]).toMatchObject({ outcome: "to-agent", done: true, by: "Ana Pérez" });

    // The label fences it out of the next search: nothing more is written or recorded.
    const writes = r.jira.writes().length;
    expect((await sweep(r.deps())).notes).toEqual([]);
    expect(r.jira.writes()).toHaveLength(writes);
    expect(r.events).toHaveLength(1);
  });

  it("files the moved ticket under 'clerk.jira.parent', and notes a parent Jira refused", async () => {
    const r = await rig();
    confirmed(r, { labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona"] });
    const rules = { ...RULES, jira: { ...RULES.jira, parent: "OA-471" } };
    r.jira.refuseField("parent");
    const result = await sweep(r.deps({ rules }));
    const oa = r.jira.issues.find((one) => one.key.startsWith("OA-"))!;
    expect(oa.parent).toBeUndefined();
    expect(result.notes).toEqual([`OAI-7 confirmed for a person by Ana Pérez: moved to ${oa.key}`, `${oa.key} not filed under its parent: Jira refused OA-471 as its parent; filed at the top level`]);
    const sent = r.jira.calls.filter((call) => call.path === "/rest/api/3/issue").map((call) => (call.body as { fields: Record<string, unknown> }).fields.parent);
    expect(sent[0]).toEqual({ key: "OA-471" });
  });

  it("moves a ticket flipped to para-persona to OA with the type and priority as confirmed, and closes it as Movido", async () => {
    const r = await rig();
    const ticket = confirmed(r, { type: "Tarea", priority: "Highest", labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona"] });
    const result = await sweep(r.deps());
    const oa = r.jira.issues.filter((one) => one.key.startsWith("OA-"));
    expect(oa).toHaveLength(1);
    expect(oa[0]).toMatchObject({ type: "Tarea", priority: "Highest", labels: ["slack-intake"] });
    expect(oa[0]!.description).toContain("Por qué requiere una persona: Confirmado para una persona por Ana Pérez.");
    expect(oa[0]!.description).toContain(`Hilo de Slack: ${PERMALINK}`);
    expect(oa[0]!.description).toContain(`Ticket en el tablero de ingreso: https://${SITE}/browse/OAI-7`);
    expect(oa[0]!.description).toContain(intakeMarker("OAI-7"));
    expect(ticket.comments!.at(-1)).toContain(`Pasa al equipo: ${oa[0]!.key}`);
    expect(ticket.labels).toContain("moved-to-jira");
    expect(ticket.status).toBe("Movido");
    expect(result.notes).toEqual([`OAI-7 confirmed for a person by Ana Pérez: moved to ${oa[0]!.key}`]);
    expect(kinds(r.events)).toEqual(["confirmed live OAI-7", "moved live OAI-7"]);
    expect(r.events[0]).toMatchObject({
      overrides: [
        { field: "type", agent: "Error", human: "Tarea" },
        { field: "priority", agent: "High", human: "Highest" },
        { field: "assigneeKind", agent: "agent", human: "person" },
      ],
    });
    expect(r.events[1]).toMatchObject({ oaKey: oa[0]!.key });
    expect(r.store().confirmed?.["OAI-7"]).toMatchObject({ outcome: "to-person", done: true, oaKey: oa[0]!.key });
  });

  it("links the intake ticket to its OA ticket before saying so, once across reruns", async () => {
    const r = await rig();
    confirmed(r, { labels: ["slack-intake", "acme-backoffice", "para-persona"] });
    // Killed after the link, before the move comment: the rerun links again, which Jira keeps as one.
    r.jira.fail("/rest/api/3/issue/OAI-7/comment", { status: 503 }, { method: "POST" });
    await sweep(r.deps());
    await sweep(r.deps());
    const oa = r.jira.issues.find((one) => one.key.startsWith("OA-"))!;
    const links = r.jira.writes().filter((call) => call.path === "/rest/api/3/issueLink");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.body).toEqual({ type: { id: LINK_TYPES.relates }, inwardIssue: { key: "OAI-7" }, outwardIssue: { key: oa.key } });
    }
    // Once the move comment is there, a later poll links nothing more.
    const count = links.length;
    await sweep(r.deps());
    expect(r.jira.writes().filter((call) => call.path === "/rest/api/3/issueLink")).toHaveLength(count);
  });

  it("still moves a ticket whose link Jira refuses, and says so", async () => {
    const r = await rig();
    const ticket = confirmed(r, { labels: ["slack-intake", "acme-backoffice", "para-persona"] });
    r.jira.fail("/rest/api/3/issueLink", { status: 403 }, { method: "POST" });
    const result = await sweep(r.deps());
    const oa = r.jira.issues.find((one) => one.key.startsWith("OA-"))!;
    expect(ticket.comments!.at(-1)).toContain(`Pasa al equipo: ${oa.key}`);
    expect(ticket.status).toBe("Movido");
    expect(result.notes[0]).toBe(`OAI-7 confirmed for a person by Ana Pérez: moved to ${oa.key}`);
    expect(result.notes[1]).toMatch(new RegExp(`^OAI-7 not linked to ${oa.key}: `));
    expect(r.store().confirmed?.["OAI-7"]).toMatchObject({ done: true });
  });

  it("files no second OA ticket after a kill between the create and the comment", async () => {
    const r = await rig();
    const ticket = confirmed(r, { labels: ["slack-intake", "acme-backoffice", "para-persona"] });
    r.jira.fail("/rest/api/3/issue/OAI-7/comment", { status: 503 }, { method: "POST" });
    const first = await sweep(r.deps());
    expect(first.notes.join("\n")).toMatch(/OAI-7 \(to-person\) was not finished: .*503.*; tried again at the next poll/);
    expect(r.jira.issues.filter((one) => one.key.startsWith("OA-"))).toHaveLength(1);
    expect(r.store().confirmed?.["OAI-7"]).toMatchObject({ outcome: "to-person", done: false });

    await sweep(r.deps());
    expect(r.jira.issues.filter((one) => one.key.startsWith("OA-"))).toHaveLength(1);
    expect(r.jira.writes().filter((call) => call.path === "/rest/api/3/issue")).toHaveLength(1);
    expect(ticket.comments!.filter((comment) => comment.includes("Pasa al equipo"))).toHaveLength(1);
    expect(ticket.status).toBe("Movido");
    // One confirmation, one move, however many polls it took.
    expect(kinds(r.events)).toEqual(["confirmed live OAI-7", "moved live OAI-7"]);
  });

  it("records a rejected ticket exactly once across reruns, and writes nothing", async () => {
    const r = await rig();
    confirmed(r, {}, "Descartado");
    for (let run = 0; run < 3; run++) await sweep(r.deps());
    expect(kinds(r.events)).toEqual(["rejected live OAI-7"]);
    expect(r.jira.writes()).toEqual([]);
  });

  it("records a discarded likely duplicate as already reported, naming the original, not as noise", async () => {
    const r = await rig();
    confirmed(r, { labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente", "posible-duplicado"], description: `${SNAPSHOT.description}\n\nPosible duplicado de OAI-3.` }, "Descartado");
    await sweep(r.deps());
    expect(r.events).toEqual([expect.objectContaining({ kind: "duplicate", key: "OAI-7", of: "OAI-3" })]);
  });

  it("acts again on a rejected ticket a person later confirms", async () => {
    const r = await rig();
    const ticket = confirmed(r, {}, "Descartado");
    await sweep(r.deps());
    ticket.status = "Confirmado";
    ticket.statusCategory = "indeterminate";
    ticket.history = [...ticket.history!, { from: "Descartado", to: "Confirmado", at: new Date(NOW - HOUR / 2).toISOString(), by: CONFIRMER }];
    await sweep(r.deps());
    expect(kinds(r.events)).toEqual(["rejected live OAI-7", "confirmed live OAI-7"]);
    expect(ticket.labels).toContain("ready-for-agent");
  });

  it("routes a ticket filed by hand, with no overrides to compare", async () => {
    const r = await rig();
    confirmed(r, { key: "OAI-30" });
    await sweep(r.deps());
    expect(r.events[0]).toMatchObject({ kind: "confirmed", key: "OAI-30", report: "OAI-30", overrides: [] });
    expect(r.jira.issues.find((one) => one.key === "OAI-30")!.labels).toContain("ready-for-agent");
  });

  it("leaves a ticket another channel's loop filed to that loop, and still acts on its own (OAI-22)", async () => {
    const r = await rig();
    const other = "https://example.slack.com/archives/C0OTHERCHAN/p1760961990000000";
    confirmed(r, { key: "OAI-31", description: `Otro canal.\n\nReportado por Bea en Slack: ${other}`, priority: "Low" });
    confirmed(r, { priority: "Medium" });
    await sweep(r.deps());
    expect(kinds(r.events)).toEqual(["confirmed live OAI-7"]);
    expect(r.events[0]).toMatchObject({ overrides: [{ field: "priority", agent: "High", human: "Medium" }] });
    expect(r.jira.issues.find((one) => one.key === "OAI-31")!.labels).not.toContain("ready-for-agent");
    expect(r.store().confirmed?.["OAI-31"]).toBeUndefined();
  });

  it("owns a ticket it holds a determination for, whatever channel its link names", () => {
    const moved = issue({ description: "Reportado por Ana en Slack: https://example.slack.com/archives/C0OTHERCHAN/p1" });
    expect(channelOf(moved)).toBe("C0OTHERCHAN");
    expect(ownsTicket(moved, CHANNEL, {})).toBe(false);
    expect(ownsTicket(moved, CHANNEL, { "OAI-7": SNAPSHOT })).toBe(true);
    expect(ownsTicket(issue({ description: "Escrito a mano." }), CHANNEL, {})).toBe(true);
  });

  it("acts on the oldest first, at most a poll's worth", async () => {
    const r = await rig();
    for (let n = 0; n < CONFIRM_PER_POLL + 2; n++) {
      confirmed(r, { key: `OAI-${100 + n}`, created: new Date(NOW - (50 - n) * HOUR).toISOString() });
    }
    await sweep(r.deps());
    expect(r.events.map((event) => event.key)).toEqual(Array.from({ length: CONFIRM_PER_POLL }, (_, n) => `OAI-${100 + n}`));
    await sweep(r.deps());
    expect(r.events.map((event) => event.key).slice(CONFIRM_PER_POLL)).toEqual(["OAI-110", "OAI-111"]);
  });

  it("closes into any done status when the board has no Movido", async () => {
    const workflow: FakeWorkflow = {
      statuses: INTAKE_WORKFLOW.statuses.filter((status) => status.name !== "Movido"),
      transitions: { "Por confirmar": ["Confirmado", "Descartado"], Confirmado: ["En curso", "Listo"] },
    };
    const r = await rig(workflow);
    const ticket = confirmed(r, { labels: ["slack-intake", "para-persona"] });
    const result = await sweep(r.deps());
    expect(ticket.status).toBe("Listo");
    expect(result.notes[0]).toMatch(/moved to OA-\d+$/);
  });

  it("notes a ticket it cannot close, and leaves it fenced by its label", async () => {
    const workflow: FakeWorkflow = { statuses: INTAKE_WORKFLOW.statuses, transitions: { ...INTAKE_WORKFLOW.transitions, Confirmado: ["En curso"] } };
    const r = await rig(workflow);
    const ticket = confirmed(r, { labels: ["slack-intake", "para-persona"] });
    const result = await sweep(r.deps());
    expect(result.denial).toBeNull();
    expect(result.notes[0]).toMatch(/but not closed \(OAI-7 has no transition to 'Movido' from 'Confirmado' \(offers: En curso\)\); 'moved-to-jira' keeps it from moving again/);
    expect(ticket.labels).toContain("moved-to-jira");
    const writes = r.jira.writes().length;
    expect((await sweep(r.deps())).notes).toEqual([]);
    expect(r.jira.writes()).toHaveLength(writes);
  });

  it("makes a status name the board refuses a note, never a denial", async () => {
    const r = await rig();
    confirmed(r);
    r.jira.fail("/rest/api/3/search/jql", { status: 400 });
    const result = await sweep(r.deps({ rules: { ...RULES, jira: { ...RULES.jira, statuses: { ...CLERK_JIRA_DEFAULTS.statuses, confirmed: "Aprobadísimo" } } } }));
    expect(result.denial).toBeNull();
    expect(result.notes).toEqual([expect.stringMatching(/^the intake board OAI could not be searched for confirmed tickets: .*HTTP 400.*; tried again at the next poll$/)]);
    expect(r.events).toEqual([]);
  });

  it("hands a refused credential back as a denial", async () => {
    const r = await rig();
    r.jira.fail("/rest/api/3/search/jql", { status: 401 });
    const result = await sweep(r.deps());
    expect(result.denial).toMatchObject({ code: "jira_unauthorized" });
  });

  it("notes a confirmed type the clerk does not file, every poll, without moving it", async () => {
    const r = await rig();
    confirmed(r, { type: "Historia", labels: ["slack-intake", "para-persona"] });
    const result = await sweep(r.deps());
    expect(result.notes).toEqual(["OAI-7 not moved to OA: its type 'Historia' is not one the clerk files (Error, Tarea)"]);
    expect(r.jira.issues.filter((one) => one.key.startsWith("OA-"))).toEqual([]);
    expect(kinds(r.events)).toEqual(["confirmed live OAI-7"]);
    await sweep(r.deps());
    expect(kinds(r.events)).toEqual(["confirmed live OAI-7"]);
  });
});

describe("sweep, shadow", () => {
  it("writes nothing to Jira, says what live would do, and records it once, marked shadow", async () => {
    const r = await rig();
    confirmed(r, { key: "OAI-7", labels: ["slack-intake", "acme-backoffice", "difficulty:hard", "para-agente"] });
    confirmed(r, { key: "OAI-8", labels: ["slack-intake", "para-persona"] });
    confirmed(r, { key: "OAI-9" }, "Descartado");
    const deps = r.deps({ rules: { ...RULES, mode: "shadow" }, board: { mode: "shadow", jira: readOnly(r.client) } });
    const result = await sweep(deps);
    expect(r.jira.writes()).toEqual([]);
    expect(result.notes).toEqual([
      "shadow: OAI-7 confirmed to-agent by Ana Pérez — would add 'ready-for-agent' to OAI-7",
      "shadow: OAI-8 confirmed to-person by Ana Pérez — would move OAI-8 to OA, link it and comment the OA key on it, label it 'moved-to-jira' and close it as 'Movido'",
      "shadow: OAI-9 rejected in 'Descartado' by Ana Pérez: recorded as noise",
    ]);
    expect(kinds(r.events)).toEqual(["confirmed shadow OAI-7", "confirmed shadow OAI-8", "moved shadow OAI-8", "rejected shadow OAI-9"]);
    expect(r.events[2]).toMatchObject({ oaKey: shadowMovedKey("OAI-8") });
    expect(r.store().shadow.writes.map((entry) => entry.write)).toEqual([
      { kind: "confirm", key: "OAI-7", text: "would add 'ready-for-agent' to OAI-7" },
      expect.objectContaining({ kind: "confirm", key: "OAI-8" }),
    ]);

    // Nothing is labelled in shadow: the store is the fence.
    expect((await sweep(deps)).notes).toEqual([]);
    expect(r.events).toHaveLength(4);
    expect(r.jira.writes()).toEqual([]);
  });

  it("holds no write method in its view of Jira", () => {
    const view = readOnly(jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, fakeJira().fetch));
    expect(Object.keys(view).sort()).toEqual(["comments", "search", "statusHistory"]);
  });
});
