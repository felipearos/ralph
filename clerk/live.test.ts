// @vitest-environment node
/**
 * The live apply (felipearos/ralph#320, #447): in `mode: live` a plan becomes
 * real Jira and Slack writes on the intake board — a new report an `OAI-n`
 * ticket in "Por confirmar", a duplicate a comment on its intake candidate and
 * a reply naming its OA key once it moved there, exactly the calls each
 * outcome needs, no assignee, plain Spanish without emoji — and a crash
 * between a create and the save that records it files nothing twice.
 *
 * In-process through the gate, against a fake Slack and a fake Jira at the
 * HTTP seam: the calls asserted here are the requests the real clients sent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { applyDecisions, describe as describeReport, quote, RECEIVED_REPLY, TargetGone, type Progress } from "./apply";
import { BOT, INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { FAILURES_BEFORE_ALERT, noCache, poll, type Denial, type PollDeps } from "./gate";
import { JiraError, jiraClient } from "./jira";
import { carriesPermalink, filedMarker, intakePort, issueBody, MARKER_NOTE } from "./live";
import type { BatchReport, Decision } from "./plan";
import { slackClient, tsMs } from "./slack";
import { readClerkStore } from "./store";

const CHANNEL = "C0TEAMCHAN1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode: "live",
  channel: CHANNEL,
  canvas: "F0CHANCANV1",
  shadowCanvas: null,
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI" },
};
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));
const DAY = 86_400_000;
/** The intake tickets every rig starts with: the candidates. A new filing is numbered after them, OAI-100 on. */
const SEEDED = new Set(["OAI-7", "OAI-12", "OAI-20"]);

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  plans: Map<string, unknown>;
  alerts: string[];
  storePath: string;
  deps: (minutes: number) => PollDeps;
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-live-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { users: { U0ANA: "Ana Pérez", U0BETO: "Beto" } });
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  jira.add({ key: "OA-12", summary: "El reporte de tareas no exporta", labels: ["slack-intake", "acme-backoffice"], statusCategory: "indeterminate", status: "En curso" });
  jira.add({ key: "OAI-12", summary: "No se puede exportar el reporte de checklists", labels: ["slack-intake", "acme-backoffice"], status: "Confirmado", statusCategory: "indeterminate", created: new Date(at(0) - 3 * DAY).toISOString() });
  // The clerk's clock is T0's, the fake's `updated >= -Nd` reads the real one:
  // `resolved` keeps the seeds inside the search window, `doneAt` is the close
  // the clerk measures the regression window by.
  const recent = new Date().toISOString();
  const closed = new Date(at(0) - 5 * DAY).toISOString();
  jira.add({ key: "OAI-7", summary: "La sincronización de tareas falla en la app", labels: ["slack-intake", "acme-pwa"], status: "Listo", statusCategory: "done", resolved: recent, doneAt: closed });
  // Confirmed for a person and moved to the team's board: closed here, live there as OA-12.
  const moved = new Date(at(0) - 2 * DAY).toISOString();
  jira.add({
    key: "OAI-20",
    summary: "El reporte de tareas no exporta",
    labels: ["slack-intake", "acme-backoffice", "moved-to-jira"],
    status: "Movido",
    statusCategory: "done",
    resolved: recent,
    doneAt: moved,
    comments: ["Pasa al equipo: OA-12"],
  });
  const plans = new Map<string, unknown>();
  const alerts: string[] = [];
  const deps = (minutes: number): PollDeps => ({
    rules: RULES,
    now: () => at(minutes),
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    intervalSeconds: 300,
    readPlan: (batch) => plans.get(batch) ?? "no plan",
    journal: () => {},
    notify: () => {},
    alert: (alert) => alerts.push(alert.subject),
    secret: "test-secret",
    stop: () => true,
  });
  await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
  return { slack, jira, plans, alerts, storePath, deps };
}

/** The intake tickets the clerk filed, oldest first: everything on the board but the seeded candidates. */
const filed = (r: Rig) => r.jira.issues.filter((issue) => issue.key.startsWith("OAI-") && !SEEDED.has(issue.key));
/** The comments written on one ticket. */
const commentsOn = (r: Rig, key: string) => r.jira.writes().filter((call) => call.method === "POST" && call.path === `/rest/api/3/issue/${key}/comment`);
const portOf = (r: Rig) =>
  intakePort(jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, r.jira.fetch), slackClient("xoxb-fake", r.slack.fetch, CHANNEL), RULES);
const replies = (r: Rig) => r.slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.params);
/** Text with its line breaks dropped: the fake reads a description's ADF back without the breaks inside a paragraph. */
const flat = (text: string): string => text.replace(/\n/g, "");
/** Every string a write carried, ADF flattened, for the checks on all of them. */
const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

describe("a live apply", () => {
  it("makes exactly the Jira and Slack calls each outcome needs, and none on the team's board", async () => {
    const r = await rig();
    const texts = [
      "Se cayó la plataforma, nadie puede entrar al Backoffice!!!",
      "No puedo exportar el reporte de checklists",
      "La sincronización de tareas falla otra vez en la app",
      "El exportar de checklists sale con columnas raras",
      "El breadcrumb vuelve al inicio, ¿es así?",
      "gracias!",
      "El reporte de tareas tampoco exporta",
      "La app se cierra al abrir una tarea",
    ];
    texts.forEach((text, index) => r.slack.post({ ts: after(T0, index + 1), user: index % 2 === 0 ? "U0ANA" : "U0BETO", text }));
    expect((await poll(r.deps(20), noCache())).verdict.work).toBe(true);
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    const id = (n: number) => batch.reports[n]!.id;
    const entry = (n: number, extra: Record<string, unknown>) => ({
      report: id(n),
      verdict: "issue",
      type: "Error",
      app: "Backoffice",
      priority: "Medium",
      assignee: "agent",
      difficulty: "medium",
      story_points: 3,
      duplicate_of: null,
      summary_es: `Resumen ${n}`,
      description_es: `Descripción ${n} 🚨`,
      ...extra,
    });
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        entry(0, { priority: "Highest", summary_es: "El Backoffice no carga para nadie" }),
        entry(1, { duplicate_of: "OAI-12", duplicate_confidence: "sure" }),
        entry(2, { type: "Tarea", app: "pwa", duplicate_of: "OAI-7", duplicate_confidence: "sure" }),
        entry(3, { duplicate_of: "OAI-12", duplicate_confidence: "unsure" }),
        { report: id(4), verdict: "decision", app: "Backoffice", difficulty: "medium", story_points: 3, summary_es: "Definir el comportamiento del breadcrumb", description_es: "Funciona como está diseñado; el equipo decide si cambiarlo." },
        { report: id(5), verdict: "ignore", ignore_reason: "agradecimiento" },
        entry(6, { duplicate_of: "OAI-20", duplicate_confidence: "sure" }),
        // A key it was never offered: the validator files it new, unverified.
        entry(7, { duplicate_of: "OAI-99", duplicate_confidence: "sure" }),
      ],
    });
    expect((await poll(r.deps(21), noCache())).verdict.work).toBe(false);

    // Five new intake tickets: the Highest, the regression, the unsure
    // duplicate, the decision and the unverified duplicate, each in
    // "Por confirmar".
    const issues = filed(r);
    expect(issues.map((issue) => [issue.summary, issue.labels, issue.status])).toEqual([
      // The Highest and the pwa report go to a person whatever the plan said.
      ["El Backoffice no carga para nadie", ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona"], "Por confirmar"],
      ["Resumen 2", ["slack-intake", "acme-pwa", "difficulty:medium", "para-persona", "posible-regresion"], "Por confirmar"],
      ["Resumen 3", ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente", "posible-duplicado"], "Por confirmar"],
      ["Definir el comportamiento del breadcrumb", ["slack-intake", "acme-backoffice", "por-decidir", "difficulty:medium", "para-persona"], "Por confirmar"],
      ["Resumen 7", ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente", "posible-duplicado"], "Por confirmar"],
    ]);
    expect(r.jira.writes().filter((call) => call.path === "/rest/api/3/issue")).toHaveLength(5);
    const [highest, regression, unsure, decision, unverified] = issues;
    expect(highest!.description).toContain(`Reportado por Ana Pérez en Slack: ${batch.reports[0]!.permalink}`);
    expect(highest!.description).toContain("Descripción 0");
    expect(flat(highest!.description!)).toContain(flat("Tipo: Error\nPrioridad: Highest\nApp: Backoffice\nDificultad: medium\nPuntos de historia sugeridos: 3\nAsignado a: persona"));
    expect(highest!.description).toContain(filedMarker(batch.reports[0]!.permalink));
    // Jira hides nothing, so the marker sits below a divider with a note telling readers to leave it alone.
    expect(highest!.description).toContain(`${MARKER_NOTE} ${filedMarker(batch.reports[0]!.permalink)}`);
    expect(r.jira.writes().find((call) => call.path === "/rest/api/3/issue")!.body).toMatchObject({ fields: { description: { content: expect.arrayContaining([{ type: "rule" }]) } } });
    expect(regression!.description).toContain("Posible regresión de OAI-7");
    expect(flat(regression!.description!)).toContain(flat("Tipo: Error\nPrioridad: Medium\nApp: pwa"));
    expect(unsure!.description).toContain("Posible duplicado de OAI-12.");
    expect(flat(decision!.description!)).toContain(flat("Tipo: Tarea\nPrioridad: Sin Prioridad\nApp: Backoffice"));
    expect(unverified!.description).toContain("Posible duplicado de OAI-99 (no verificado).");
    // Each sure duplicate is one comment on its intake ticket — the moved one
    // too, whose OA ticket is not written.
    expect(commentsOn(r, "OAI-12")).toHaveLength(1);
    expect(commentsOn(r, "OAI-20")).toHaveLength(1);
    expect(r.jira.issues.find((issue) => issue.key === "OAI-12")!.comments![0]).toContain(`Nuevo reporte del mismo problema por Beto en Slack: ${batch.reports[1]!.permalink}`);
    expect(r.jira.writes().filter((call) => call.path.startsWith("/rest/api/3/issue/OA-"))).toEqual([]);
    // One thread reply per filed report: "already filed" on the sure
    // duplicates — the moved one naming its OA key, where the work is —
    // the first reply on each new ticket, none on the ignored one.
    expect(replies(r).map((reply) => [reply.thread_ts, reply.text])).toEqual([
      [id(0), RECEIVED_REPLY],
      [id(1), "Ya está reportado: OAI-12."],
      [id(2), RECEIVED_REPLY],
      [id(3), RECEIVED_REPLY],
      [id(4), RECEIVED_REPLY],
      [id(6), "Ya está reportado: OA-12."],
      [id(7), RECEIVED_REPLY],
    ]);
    expect(replies(r).every((reply) => reply.channel === CHANNEL)).toBe(true);
  });

  it("never sets an assignee, and writes no emoji anywhere", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "Todo roto 😭🔥 no puedo guardar" });
    await poll(r.deps(15), noCache());
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [{ report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "both", priority: "Highest", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "No se puede guardar 💥", description_es: "Falla al guardar ✅" }],
    });
    await poll(r.deps(16), noCache());
    const bodies = [...r.jira.writes().map((call) => call.body), ...replies(r)];
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(/assignee/i);
      for (const text of strings(body)) expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    // `both` is labelled for both repos, and nobody is assigned.
    expect(filed(r).map((issue) => [issue.labels, issue.assignee ?? null])).toEqual([[["slack-intake", "acme-backoffice", "acme-pwa", "difficulty:medium", "para-persona"], null]]);
  });

  it("writes nothing anywhere for an ignored report", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "gracias!" });
    await poll(r.deps(15), noCache());
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    r.plans.set(batch.id, { batch: batch.id, entries: [{ report: batch.reports[0]!.id, verdict: "ignore", ignore_reason: "agradecimiento" }] });
    await poll(r.deps(16), noCache());
    expect(readClerkStore(r.storePath, CHANNEL).store.batch).toBeNull();
    expect(r.jira.writes()).toEqual([]);
    expect(replies(r)).toEqual([]);
  });
});

describe("a live clerk without what it files with", () => {
  it("is refused no_jira_credential and writes nothing, rather than falling to shadow", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo guardar" });
    const denials: Denial[] = [];
    const polled = await poll({ ...r.deps(15), jira: null, stop: (denial) => denials.push(denial) > 0, notify: (denial) => denials.push(denial) }, noCache());
    expect(polled.verdict.work).toBe(false);
    expect(polled.verdict.stop?.remedy).toContain("RALPH_CLERK_JIRA_TOKEN");
    expect(denials.map((denial) => denial.code)).toEqual(["no_jira_credential", "no_jira_credential"]);
    expect(readClerkStore(r.storePath, CHANNEL).store.batch).toBeNull();
    expect(r.jira.writes()).toEqual([]);
    expect(r.slack.calls.filter((call) => call.method === "chat.postMessage")).toEqual([]);
  });

  it("is refused no_intake_board when a hand-spelled rules object names no board", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo guardar" });
    const denials: Denial[] = [];
    const rules: ClerkRules = { ...RULES, jira: { site: SITE, project: "OA" } };
    const polled = await poll({ ...r.deps(15), rules, stop: (denial) => denials.push(denial) > 0, notify: () => {} }, noCache());
    expect(polled.verdict.stop?.remedy).toContain("clerk.jira.intakeProject");
    expect(denials.map((denial) => denial.code)).toEqual(["no_intake_board"]);
    expect(r.jira.writes()).toEqual([]);
  });
});

describe("a crash between the create and the save", () => {
  it("reuses a ticket already carrying the report's marker, through the gate", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo guardar" });
    await poll(r.deps(15), noCache());
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    const permalink = batch.reports[0]!.permalink;
    // What a create that landed before the crash left behind.
    r.jira.add({ key: "OAI-40", summary: "No se puede guardar", labels: ["slack-intake"], description: `Falla.\n\n${filedMarker(permalink)}`, status: "Por confirmar", created: new Date(at(15)).toISOString() });
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [{ report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "No se puede guardar", description_es: "Falla." }],
    });
    await poll(r.deps(16), noCache());
    expect(r.jira.writes().filter((call) => call.path === "/rest/api/3/issue")).toEqual([]);
    expect(readClerkStore(r.storePath, CHANNEL).store.batch).toBeNull();
    expect(readClerkStore(r.storePath, CHANNEL).store.processed[batch.reports[0]!.id]?.key).toBe("OAI-40");
    expect(replies(r).map((reply) => reply.text)).toEqual([RECEIVED_REPLY]);
  });

  it("marks a report with one word no quote of its link can contain", () => {
    const own = "https://example.slack.com/archives/C0TEAMCHAN1/p1760961660000100";
    const other = "https://example.slack.com/archives/C0TEAMCHAN1/p1760961720000100";
    expect(filedMarker(own)).toMatch(/^[A-Za-z0-9]+$/);
    const report: BatchReport = {
      id: "1760961660.000100",
      author: "U0ANA",
      authorName: "Ana",
      names: { U0ANA: "Ana" },
      roots: ["1760961660.000100"],
      messages: [{ ts: "1760961660.000100", user: "U0ANA", text: `igual que <${other}> y que ${other}`, files: [], reply: false, permalink: own }],
      lastActivity: "1760961660.000100",
      permalink: own,
      candidates: [],
    };
    // The description quotes the other report's link, and still reads as
    // filed only for its own.
    const description = describeReport(report, "Algo falla.", []);
    expect(description).toContain(other);
    expect(description).not.toContain(filedMarker(other));
    expect(description).not.toContain(filedMarker(own));
    // Nor is one report's marker inside a longer link's, a thread reply's.
    expect(filedMarker(`${own}?thread_ts=1760961660.000100`)).not.toContain(filedMarker(own));
  });

  it("marks each ticket of a split report apart, none of them as the report's own", () => {
    const own = "https://example.slack.com/archives/C0TEAMCHAN1/p1760961660000100";
    const fields = { type: "Error", summary: "x", description: "Algo falla.", labels: [], app: "pwa", priority: "Low", assignee: "agent", difficulty: "easy", storyPoints: 2, permalink: own } as const;
    const first = issueBody({ ...fields, labels: [] });
    const second = issueBody({ ...fields, labels: [], part: 2 });
    expect(first).toContain(filedMarker(own));
    expect(second).toContain(filedMarker(`${own}#parte-2`));
    expect(second).not.toContain(filedMarker(own));
    expect(filedMarker(`${own}#parte-2`)).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("failed iterations", () => {
  it(`raise one alert after ${FAILURES_BEFORE_ALERT} in a row, and keep the batch for the next poll`, async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo guardar" });
    await poll(r.deps(15), noCache());
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [{ report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "Low", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" }],
    });
    for (let poll_ = 1; poll_ <= FAILURES_BEFORE_ALERT + 1; poll_ += 1) {
      r.jira.fail("/rest/api/3/issue", { status: 503 }, { method: "POST" });
      const polled = await poll(r.deps(15 + poll_), noCache());
      expect(polled.verdict.work).toBe(false);
      expect(r.alerts, `after ${poll_} failures`).toHaveLength(poll_ >= FAILURES_BEFORE_ALERT ? 1 : 0);
    }
    expect(readClerkStore(r.storePath, CHANNEL).store.batch?.id).toBe(batch.id);
    // Jira comes back: the batch is filed and the count clears.
    await poll(r.deps(30), noCache());
    expect(filed(r)).toHaveLength(1);
    expect(readClerkStore(r.storePath, CHANNEL).store.failures).toBe(0);
  });
});

describe("the reply", () => {
  it("is posted as the bot, so the gate never reads it as a report or as activity", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    await poll(r.deps(15), noCache());
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [{ report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "Low", duplicate_of: "OAI-12", duplicate_confidence: "sure", assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" }],
    });
    await poll(r.deps(16), noCache());
    expect(replies(r)).toHaveLength(1);
    expect(r.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    // A later poll reads the bot's own reply in the thread and hands nothing over.
    const later = await poll(r.deps(40), noCache());
    // Nothing handed over; the only other thing the poll says is about the
    // channel canvas, which it rebuilds in live mode (felipearos/ralph#322).
    const { notes, ...rest } = later.verdict;
    expect(rest).toEqual({ work: false, why: `no unfiled report in ${CHANNEL}` });
    expect((notes ?? []).every((note) => note.startsWith("channel canvas") || note.startsWith("no 'clerk.canvas'"))).toBe(true);
    expect(BOT.userId).toBe("U0CLERKBOT");
  });
});

describe("one report's trouble stays that report's", () => {
  const decisionFor = (report: BatchReport, extra: Partial<Extract<Decision, { verdict: "issue" | "decision" }>> = {}): Decision => ({
    report: report.id,
    verdict: "issue",
    type: "Error",
    app: "Backoffice",
    priority: "Medium",
    assignee: "agent",
    difficulty: "medium",
    storyPoints: 3,
    summary: "No se puede exportar",
    description: "Falla al exportar.",
    duplicate: null,
    unverifiedDuplicate: null,
    ...extra,
  });
  const run = async (r: Rig, decision: Decision, report: BatchReport) => {
    const progress: Record<string, Progress> = {};
    const port = portOf(r);
    return applyDecisions([decision], [report], {
      rules: RULES,
      port,
      now: () => at(16),
      progress: (id) => progress[id] ?? {},
      saveProgress: async (id, saved) => {
        progress[id] = saved;
      },
      done: async () => {},
    });
  };
  const handed = async (r: Rig): Promise<BatchReport> => {
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    await poll(r.deps(15), noCache());
    return readClerkStore(r.storePath, CHANNEL).store.batch!.reports[0] as BatchReport;
  };

  it("comments and replies once on a duplicate, however often the same plan is applied", async () => {
    const r = await rig();
    const report = await handed(r);
    const candidate = report.candidates.find((one) => one.key === "OAI-12")!;
    const decision = decisionFor(report, { duplicate: { candidate, confidence: "sure" } });
    // Each run starts with no progress: what a gate killed before any save leaves.
    await run(r, decision, report);
    const [again] = await run(r, decision, report);
    expect(again!.writes).toEqual([]);
    expect(commentsOn(r, "OAI-12")).toHaveLength(1);
    expect(replies(r).map((reply) => reply.text)).toEqual(["Ya está reportado: OAI-12."]);
    expect(filed(r)).toEqual([]);
  });

  it("files a new ticket when the open ticket it duplicates was deleted before the apply", async () => {
    const r = await rig();
    const report = await handed(r);
    const candidate = report.candidates.find((one) => one.key === "OAI-12")!;
    r.jira.issues.splice(r.jira.issues.findIndex((issue) => issue.key === "OAI-12"), 1);
    const [applied] = await run(r, decisionFor(report, { duplicate: { candidate, confidence: "sure" } }), report);
    expect(applied!.outcome).toBe("create");
    expect(applied!.key).toBe(filed(r)[0]!.key);
    expect(filed(r)[0]!.description).toContain("Iba a registrarse como duplicado de OAI-12, que ya no existe.");
    // A new report's reply, not the duplicate's "already filed".
    expect(replies(r).map((reply) => reply.text)).toEqual([RECEIVED_REPLY]);
  });

  it("links a new ticket to the candidate it may duplicate, and names it in the description", async () => {
    const r = await rig();
    const report = await handed(r);
    const candidate = report.candidates.find((one) => one.key === "OAI-12")!;
    const [applied] = await run(r, decisionFor(report, { duplicate: { candidate, confidence: "unsure" } }), report);
    expect(filed(r)[0]!.description).toContain("Posible duplicado de OAI-12.");
    const link = r.jira.writes().find((call) => call.path === "/rest/api/3/issueLink")!;
    // By the stock id, which survives a site renaming "Duplicate" (the client's is "Duplicado"): the new ticket duplicates OAI-12.
    expect(link.body).toMatchObject({ type: { id: "10002" }, inwardIssue: { key: applied!.key }, outwardIssue: { key: "OAI-12" } });
    expect(filed(r)[0]!.labels).toContain("posible-duplicado");
  });

  it("relabels an original a person's: para-agente off and para-persona on in one edit, a gone one a gone target", async () => {
    const r = await rig();
    const report = await handed(r);
    const port = portOf(r);
    await port.relabel("OAI-12", report);
    const edit = r.jira.writes().find((call) => call.method === "PUT" && call.path.startsWith("/rest/api/3/issue/OAI-12"))!;
    expect(edit.body).toMatchObject({ update: { labels: expect.arrayContaining([{ add: "para-persona" }, { remove: "para-agente" }]) } });
    await expect(port.relabel("OAI-8", report)).rejects.toBeInstanceOf(TargetGone);
  });

  it("reads Jira's not-found as a gone target, and anything else as a real failure", async () => {
    const r = await rig();
    const report = await handed(r);
    const port = portOf(r);
    await port.comment("OAI-12", `Respuesta de Ana en Slack: ${report.permalink}`, report);
    expect(await port.hasComment("OAI-12", report.permalink)).toBe(true);
    await expect(port.hasComment("OAI-8", report.permalink)).rejects.toBeInstanceOf(TargetGone);
    r.jira.fail("/rest/api/3/issue/OAI-12/comment", { status: 500 }, { method: "POST" });
    await expect(port.comment("OAI-12", "x", report)).rejects.toBeInstanceOf(JiraError);
  });

  it("reads a permalink as filed only from the clerk's own line, never from a quote", () => {
    const own = "https://example.slack.com/archives/C0TEAMCHAN1/p1760961660000100";
    const other = "https://example.slack.com/archives/C0TEAMCHAN1/p1760961720000100";
    const description = `Algo falla.\n\nReportado por Ana en Slack: ${own}\n\nMensaje original:\n> igual que ${other}`;
    expect(carriesPermalink(description, own)).toBe(true);
    expect(carriesPermalink(description, other)).toBe(false);
    // Nor a longer permalink that merely starts with this one.
    expect(carriesPermalink(`en Slack: ${own}9`, own)).toBe(false);
  });

  it("does not post a thread reply twice when the save after it was lost", async () => {
    const r = await rig();
    const report = await handed(r);
    const port = portOf(r);
    const decision = decisionFor(report, { priority: "Highest" });
    let kill = true;
    const progress: Record<string, Progress> = {};
    const deps = {
      rules: RULES,
      port,
      now: () => at(16),
      progress: (id: string) => progress[id] ?? {},
      saveProgress: async (id: string, saved: Progress) => {
        if (kill && saved.replied === true) {
          kill = false;
          throw new Error("killed after the reply");
        }
        progress[id] = { ...saved };
      },
      done: async () => {},
    };
    await expect(applyDecisions([decision], [report], deps)).rejects.toThrow("killed after the reply");
    await applyDecisions([decision], [report], deps);
    expect(replies(r)).toHaveLength(1);
  });

  it("quotes Slack's link and mention markup as text a person reads", () => {
    const report: BatchReport = {
      id: "1.000100",
      author: "U0ANA",
      authorName: "Ana",
      names: { U0ANA: "Ana", U0BETO: "Beto" },
      roots: ["1.000100"],
      messages: [{ ts: "1.000100", user: "U0ANA", text: "Ver <https://example.com/r?id=1&amp;x=2|el reporte> y <https://example.com/a>, como dijo <@U0BETO> &lt;3", files: [], reply: false, permalink: "x" }],
      lastActivity: "1.000100",
      permalink: "x",
      candidates: [],
    };
    expect(quote(report)).toBe("> Ver el reporte (https://example.com/r?id=1&x=2) y https://example.com/a, como dijo @Beto <3");
  });
});

describe("failed polls of any kind", () => {
  it(`raise one alert when Slack itself fails ${FAILURES_BEFORE_ALERT} polls in a row`, async () => {
    const r = await rig();
    r.slack.fail("conversations.history", { status: 503 }, { always: true });
    for (let n = 1; n <= FAILURES_BEFORE_ALERT + 1; n += 1) await poll(r.deps(5 + n), noCache());
    expect(r.alerts).toEqual([`The clerk failed ${FAILURES_BEFORE_ALERT} polls in a row`]);
  });
});

describe("filing on the Jira intake board (felipearos/ralph#447)", () => {
  const POINTS = "customfield_10016";
  const INTAKE: ClerkRules = { ...RULES, jira: { ...RULES.jira, storyPointsField: POINTS } };
  /** A board whose new tickets start in Backlog, so the move to "Por confirmar" is the port's to make. */
  const WORKFLOW = {
    statuses: [{ name: "Backlog", category: "new" as const }, ...INTAKE_WORKFLOW.statuses],
    transitions: { ...INTAKE_WORKFLOW.transitions, Backlog: ["Por confirmar"] },
  };
  const PERMALINK = "https://example.slack.com/archives/C0TEAMCHAN1/p1760961660000100";
  const report: BatchReport = {
    id: "1760961660.000100",
    author: "U0ANA",
    authorName: "Ana Pérez",
    names: { U0ANA: "Ana Pérez" },
    roots: ["1760961660.000100"],
    messages: [{ ts: "1760961660.000100", user: "U0ANA", text: "No puedo exportar", files: [], reply: false, permalink: PERMALINK }],
    lastActivity: "1760961660.000100",
    permalink: PERMALINK,
    candidates: [],
  };
  const decision = (extra: Partial<Extract<Decision, { verdict: "issue" | "decision" }>> = {}): Decision => ({
    report: report.id,
    verdict: "issue",
    type: "Error",
    app: "Backoffice",
    priority: "High",
    assignee: "agent",
    difficulty: "hard",
    storyPoints: 5,
    summary: "No se puede exportar",
    description: "Falla al exportar.",
    duplicate: null,
    unverifiedDuplicate: null,
    ...extra,
  });
  const board = () => {
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: WORKFLOW } });
    const slack = fakeSlack(CHANNEL);
    slack.post({ ts: report.id, user: "U0ANA", text: "No puedo exportar" });
    const notes: string[] = [];
    const port = intakePort(jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch), slackClient("xoxb-fake", slack.fetch, CHANNEL), INTAKE, (note) => notes.push(note));
    const progress: Record<string, Progress> = {};
    const apply = (decisions: Decision[], saveProgress?: () => Promise<void>) =>
      applyDecisions(decisions, [report], {
        rules: INTAKE,
        port,
        now: () => at(16),
        progress: (id) => progress[id] ?? {},
        saveProgress:
          saveProgress ??
          (async (id, saved) => {
            progress[id] = saved;
          }),
        done: async () => {},
      });
    const intake = () => jira.issues.filter((issue) => issue.key.startsWith("OAI-"));
    const replies = () => slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.params.text);
    return { jira, slack, notes, apply, intake, replies };
  };

  it("files a report as an OAI ticket in Por confirmar, with every label and its points in the field", async () => {
    const b = board();
    const [applied] = await b.apply([decision()]);
    const [ticket] = b.intake();
    expect(b.intake()).toHaveLength(1);
    expect(applied!.key).toBe(ticket!.key);
    expect(ticket).toMatchObject({
      status: "Por confirmar",
      type: "Error",
      priority: "High",
      labels: ["slack-intake", "acme-backoffice", "difficulty:hard", "para-agente"],
      custom: { [POINTS]: 5 },
    });
    expect(ticket!.description).toContain("Puntos de historia sugeridos: 5");
    expect(ticket!.description).toContain(filedMarker(PERMALINK));
    expect(b.replies()).toEqual([RECEIVED_REPLY]);
    expect(b.notes).toEqual([]);
    // The create and the move, and nothing on any other project.
    expect(b.jira.writes().map((call) => `${call.method} ${call.path}`)).toEqual(["POST /rest/api/3/issue", `POST /rest/api/3/issue/${ticket!.key}/transitions`]);
    expect((b.jira.calls[0]!.body as { jql: string }).jql).toBe(`project = "OAI" AND text ~ "${filedMarker(PERMALINK)}" ORDER BY created DESC`);
  });

  it("labels a decision filed unclassified for a person, with no points anywhere", async () => {
    const b = board();
    await b.apply([decision({ verdict: "decision", assignee: "person", difficulty: "medium", storyPoints: null, unclassified: true })]);
    const [ticket] = b.intake();
    expect(ticket!.labels).toEqual(["slack-intake", "acme-backoffice", "por-decidir", "difficulty:medium", "para-persona", "intake-sin-clasificar"]);
    expect(ticket!.custom).toEqual({});
    expect(ticket!.description).not.toContain("Puntos de historia sugeridos");
  });

  it("still files the ticket when Jira refuses the points field, keeping them in the description, and says so", async () => {
    const b = board();
    b.jira.refuseField(POINTS);
    await b.apply([decision()]);
    const [ticket] = b.intake();
    expect(ticket!.status).toBe("Por confirmar");
    expect(ticket!.custom).toEqual({});
    expect(ticket!.description).toContain("Puntos de historia sugeridos: 5");
    expect(b.notes).toEqual([`${ticket!.key} filed without story points in ${POINTS}: Jira refused the field, so they are only in the description ("Puntos de historia sugeridos")`]);
  });

  it("keeps the ticket when its move fails, and says so rather than throwing", async () => {
    const b = board();
    b.jira.fail("/rest/api/3/issue/OAI-", { status: 503 }, { method: "GET" });
    const [applied] = await b.apply([decision()]);
    const [ticket] = b.intake();
    expect(applied!.key).toBe(ticket!.key);
    expect(ticket!.status).toBe("Backlog");
    expect(b.notes).toHaveLength(1);
    expect(b.notes[0]).toContain(`${ticket!.key} filed, but not moved to 'Por confirmar'`);
  });

  it("files nothing twice when killed between the create and the save, and makes the move the kill cut off", async () => {
    const b = board();
    // The move fails and then the save after the create never lands: the
    // ticket exists in Backlog, and nothing remembers it.
    b.jira.fail("/rest/api/3/issue/OAI-", { network: "killed" }, { method: "GET" });
    await expect(
      b.apply([decision()], async () => {
        throw new Error("killed");
      }),
    ).rejects.toThrow("killed");
    expect(b.intake().map((issue) => issue.status)).toEqual(["Backlog"]);
    // The rerun starts with no progress, finds it by its marker, moves it on
    // and only replies.
    const [rerun] = await b.apply([decision()]);
    expect(b.intake()).toHaveLength(1);
    expect(rerun!.key).toBe(b.intake()[0]!.key);
    expect(rerun!.writes.map((write) => write.kind)).toEqual(["reply"]);
    expect(b.intake()[0]!.status).toBe("Por confirmar");
    expect(b.jira.writes().filter((call) => call.path === "/rest/api/3/issue")).toHaveLength(1);
    expect(b.replies()).toEqual([RECEIVED_REPLY]);
  });

  it("finds a ticket the search index has not caught up with among the clerk's recent ones", async () => {
    const b = board();
    await b.apply([decision()]);
    const [ticket] = b.intake();
    // As if Jira's index trailed the create: the text search knows nothing yet.
    const indexed = ticket!.description!;
    ticket!.description = indexed.replace(filedMarker(PERMALINK), "");
    const port = intakePort(jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, b.jira.fetch), slackClient("xoxb-fake", b.slack.fetch, CHANNEL), INTAKE);
    expect(await port.findFiled(PERMALINK)).toBeNull();
    ticket!.description = indexed;
    expect(await port.findFiled(PERMALINK)).toBe(ticket!.key);
  });

  it("comments on a sure duplicate on the board, and links a regression with Jira's own link", async () => {
    const b = board();
    b.jira.add({ key: "OAI-7", summary: "No exporta", labels: ["slack-intake"], status: "Por confirmar" });
    const open = { key: "OAI-7", summary: "No exporta", status: "Por confirmar", closed: null, labels: ["slack-intake"], jiraKey: null };
    const [dup] = await b.apply([decision({ duplicate: { candidate: open, confidence: "sure" } })]);
    expect(dup!.outcome).toBe("comment");
    expect(b.jira.issues.find((issue) => issue.key === "OAI-7")!.comments).toHaveLength(1);
    expect(b.replies()).toEqual(["Ya está reportado: OAI-7."]);

    const c = board();
    c.jira.add({ key: "OAI-3", summary: "Exportar falla", labels: ["slack-intake"], status: "Listo", statusCategory: "done" });
    const done = { key: "OAI-3", summary: "Exportar falla", status: "Listo", closed: new Date(at(0) - 2 * DAY).toISOString(), labels: ["slack-intake"], jiraKey: null };
    const [regression] = await c.apply([decision({ duplicate: { candidate: done, confidence: "sure" } })]);
    expect(regression!.outcome).toBe("create");
    const link = c.jira.writes().find((call) => call.path === "/rest/api/3/issueLink")!;
    expect(link.body).toMatchObject({ type: { id: "10003" }, inwardIssue: { key: regression!.key }, outwardIssue: { key: "OAI-3" } });
    expect(c.jira.issues.find((issue) => issue.key === regression!.key)!.labels).toContain("posible-regresion");
  });
});
