// @vitest-environment node
/**
 * The gate rebuilding the shadow canvas (felipearos/ralph#319), one poll at a
 * time, against a fake Slack at the HTTP seam and a store in a scratch
 * directory — `runOnce`, exactly what `--once` prints and exits with, with
 * the fakes wired in.
 *
 * What has to hold: the operator's test canvas is replaced whole only once the
 * rebuild interval has passed; a canvas that is gone is created again, and
 * the new one is what later rebuilds write; in shadow no canvas but that one
 * is ever written; and a canvas that cannot be written never keeps a report
 * from being handed over.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { SHADOW_CANVAS_TITLE, closedIntakeJql, noCache, openIntakeJql, poll, runOnce, type Denial, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import { msTs, slackClient, tsMs, type Fetch } from "./slack";
import { readClerkStore } from "./store";

const CHANNEL = "C0TESTCHAN1";
const TEST_CANVAS = "F0SHADOWCV1";
const TEAM_CANVAS = "F0TEAMCANV1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  channel: CHANNEL,
  canvas: TEAM_CANVAS,
  shadowCanvas: TEST_CANVAS,
  operator: null,
  jira: { site: SITE, project: "OA" },
};
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  plans: Map<string, unknown>;
  stops: Denial[];
  deps: (minutes: number) => PollDeps;
  store: () => ReturnType<typeof readClerkStore>["store"];
}

/** A clerk whose first poll has started the clock at T0; both canvases exist and the bot can write either. */
async function rig(rules: ClerkRules = RULES): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-canvas-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { canvases: [TEST_CANVAS, TEAM_CANVAS] });
  const jira = fakeJira("OA");
  const plans = new Map<string, unknown>();
  const stops: Denial[] = [];
  const deps = (minutes: number): PollDeps => ({
    rules,
    now: () => at(minutes),
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    intervalSeconds: 300,
    readPlan: (batch) => plans.get(batch),
    journal: () => {},
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: (denial) => {
      stops.push(denial);
      return true;
    },
  });
  await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
  return { slack, plans, stops, deps, store: () => readClerkStore(storePath, CHANNEL).store };
}

const canvasCalls = (slack: FakeSlack) => slack.calls.filter((call) => call.method.includes("canvases"));

describe("the rebuild interval", () => {
  it("writes the test canvas at the first poll that reaches Slack, then not again until canvasMinutes have passed", async () => {
    const r = await rig();
    // The starting poll asks Slack nothing, so it writes nothing either.
    expect(canvasCalls(r.slack)).toEqual([]);

    const first = await runOnce(r.deps(5));
    expect(first.code).toBe(1);
    expect(first.lines).toEqual([`clerk-gate: shadow canvas ${TEST_CANVAS} rebuilt (0 would-be tickets)`, "clerk-gate: nothing to do — no unfiled report in C0TESTCHAN1"]);
    expect(canvasCalls(r.slack).map((call) => `${call.method} ${call.params.canvas_id}`)).toEqual([`canvases.edit ${TEST_CANVAS}`]);
    expect(r.store().canvas.rebuiltAt).toBe(new Date(at(5)).toISOString());

    // Inside the interval: the poll runs, the canvas is left alone.
    for (const minutes of [10, 19]) {
      const quiet = await runOnce(r.deps(minutes));
      expect(quiet.lines).toEqual(["clerk-gate: nothing to do — no unfiled report in C0TESTCHAN1"]);
    }
    expect(canvasCalls(r.slack)).toHaveLength(1);

    // Fifteen minutes after the last rebuild: replaced again, whole.
    await runOnce(r.deps(5 + RULES.canvasMinutes));
    expect(canvasCalls(r.slack)).toHaveLength(2);
    expect(r.slack.canvases.get(TEST_CANVAS)).toContain("Sin errores abiertos.");
  });

  it("shows a batch applied in shadow at the next rebuild, as a row linked to its report", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "Se cae la app al guardar una tarea" });
    expect((await poll(r.deps(12), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [{ report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "pwa", priority: "Highest", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "La app se cae al guardar una tarea", description_es: "Al guardar una tarea la app se cierra." }],
    });
    await poll(r.deps(13), noCache());
    expect(r.slack.canvases.get(TEST_CANVAS)).toContain("Sin errores abiertos.");
    await poll(r.deps(12 + RULES.canvasMinutes), noCache());
    const [ticket] = Object.values(r.store().shadow.tickets);
    expect(r.slack.canvases.get(TEST_CANVAS)).toContain(`| [${ticket!.key}](${ticket!.permalink}) | La app se cae al guardar una tarea | pwa | Highest |`);
  });
});

describe("a canvas that is gone", () => {
  it("is created again, its new id logged and stored, and the new one written by every later rebuild", async () => {
    const r = await rig();
    r.slack.canvasGone(TEST_CANVAS, "canvas_deleted");
    const recreated = await runOnce(r.deps(5));
    expect(recreated.code).toBe(1);
    expect(recreated.lines[0]).toBe(
      `clerk-gate: shadow canvas ${TEST_CANVAS} is gone or no longer reachable; created F0CREATED001 in its place (0 would-be tickets, owned by the bot alone; set 'clerk.operator' to have the clerk share what it creates) — later rebuilds write F0CREATED001; set 'clerk.shadowCanvas' to it`,
    );
    expect(r.store().canvas).toEqual({ id: "F0CREATED001", configured: TEST_CANVAS, rebuiltAt: new Date(at(5)).toISOString() });
    const create = canvasCalls(r.slack).find((call) => call.method === "canvases.create")!;
    expect(create.body).toMatchObject({ title: SHADOW_CANVAS_TITLE, document_content: { type: "markdown" } });

    await runOnce(r.deps(5 + RULES.canvasMinutes));
    expect(canvasCalls(r.slack).map((call) => `${call.method} ${call.params.canvas_id ?? ""}`)).toEqual([
      `canvases.edit ${TEST_CANVAS}`,
      "canvases.create ",
      "canvases.edit F0CREATED001",
    ]);
    expect(r.slack.created).toEqual(["F0CREATED001"]);
  });

  it("is shared with the operator when 'clerk.operator' names one, so somebody can open it", async () => {
    const r = await rig({ ...RULES, shadowCanvas: null, operator: "U0OPERATOR1" });
    const { lines } = await runOnce(r.deps(5));
    expect(lines[0]).toContain("created shadow canvas F0CREATED001 (0 would-be tickets, shared with U0OPERATOR1)");
    const shares = r.slack.calls.filter((call) => call.method === "canvases.access.set");
    expect(shares).toHaveLength(1);
    expect(shares[0]!.params).toMatchObject({ canvas_id: "F0CREATED001", access_level: "write" });
  });

  it("reads no_permission as a canvas the bot lost, and recreates it", async () => {
    const r = await rig();
    r.slack.canvasGone(TEST_CANVAS, "no_permission");
    const { lines } = await runOnce(r.deps(5));
    expect(lines[0]).toContain(`shadow canvas ${TEST_CANVAS} is gone or no longer reachable; created F0CREATED001`);
  });

  it("is created when no test canvas is configured, and that one is used from then on", async () => {
    const r = await rig({ ...RULES, shadowCanvas: null });
    const { lines } = await runOnce(r.deps(5));
    expect(lines[0]).toBe("clerk-gate: no 'clerk.shadowCanvas' configured; created shadow canvas F0CREATED001 (0 would-be tickets, owned by the bot alone; set 'clerk.operator' to have the clerk share what it creates) — later rebuilds write it; set 'clerk.shadowCanvas' to it");
    await runOnce(r.deps(5 + RULES.canvasMinutes));
    expect(canvasCalls(r.slack).map((call) => call.method)).toEqual(["canvases.create", "canvases.edit"]);
    expect(canvasCalls(r.slack)[1]!.params.canvas_id).toBe("F0CREATED001");
  });

  it("is forgotten once the operator configures another test canvas", async () => {
    const r = await rig();
    r.slack.canvasGone(TEST_CANVAS);
    await runOnce(r.deps(5));
    expect(r.store().canvas.id).toBe("F0CREATED001");
    r.slack.canvases.set("F0NEWTEST01", "");
    await runOnce({ ...r.deps(5 + RULES.canvasMinutes), rules: { ...RULES, shadowCanvas: "F0NEWTEST01" } });
    expect(canvasCalls(r.slack).at(-1)!.params.canvas_id).toBe("F0NEWTEST01");
    expect(r.store().canvas).toMatchObject({ id: null, configured: null });
  });
});

describe("the shadow fence on canvases", () => {
  it("writes no canvas but the configured test canvas, through a hand-over, an apply and every rebuild", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "Agreguen un filtro por fecha" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        { report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "No se puede exportar el reporte", description_es: "x" },
        { report: batch.reports[1]!.id, verdict: "decision", type: "Tarea", app: "pwa", priority: "Sin Prioridad", duplicate_of: null, difficulty: "medium", story_points: 3, summary_es: "Filtro por fecha", description_es: "y" },
      ],
    });
    for (const minutes of [16, 31, 46, 61]) await poll(r.deps(minutes), noCache());

    const calls = canvasCalls(r.slack);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // Every canvas call names the test canvas: no create, no channel canvas,
    // and the team's canvas — which the bot could write — never touched.
    expect(calls.map((call) => `${call.method} ${call.params.canvas_id}`)).toEqual(calls.map(() => `canvases.edit ${TEST_CANVAS}`));
    expect(r.slack.canvases.get(TEAM_CANVAS)).toBe("");
    expect(r.slack.canvases.get(TEST_CANVAS)).toContain("No se puede exportar el reporte");
    expect(r.slack.canvases.get(TEST_CANVAS)).toContain("Filtro por fecha");
  });

  it("refuses a store that would point shadow at the team's canvas", async () => {
    // The validator refuses `canvas === shadowCanvas`; rules built by hand can
    // still say it, and the gate holds the line itself.
    const r = await rig({ ...RULES, shadowCanvas: TEAM_CANVAS });
    const { lines } = await runOnce(r.deps(5));
    expect(lines[0]).toBe(`clerk-gate: shadow canvas not rebuilt — ${TEAM_CANVAS} is the channel's canvas ('clerk.canvas'), which shadow never writes`);
    expect(canvasCalls(r.slack)).toEqual([]);
  });

  it("never writes the channel canvas in shadow, however many rebuilds there are", async () => {
    // The live canvas is built from the intake board (felipearos/ralph#448);
    // in shadow the gate never asks, and never touches `clerk.canvas`.
    const r = await rig();
    for (const minutes of [5, 20, 35]) await runOnce(r.deps(minutes));
    expect(canvasCalls(r.slack).every((call) => call.params.canvas_id === TEST_CANVAS)).toBe(true);
    expect(r.slack.canvases.get(TEAM_CANVAS)).toBe("");
  });
});

describe("the live channel canvas from the intake board (felipearos/ralph#322, #448)", () => {
  const POINTS = "customfield_10016";
  const LIVE: ClerkRules = {
    ...RULES,
    mode: "live",
    jira: { site: SITE, project: "OA", intakeProject: "OAI", storyPointsField: POINTS },
  };
  const day = 86_400_000;
  const iso = (ms: number): string => new Date(ms).toISOString();
  /** A live clerk over an intake board holding the channel's tickets, a ticket filed by hand, and the person board's. */
  async function liveRig(rules: ClerkRules = LIVE): Promise<Rig & { jira: FakeJira; searches: () => number; failClosedRead: (status: number) => void }> {
    const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-live-canvas-"));
    roots.push(dir);
    const storePath = join(dir, "clara.json");
    const slack = fakeSlack(CHANNEL, { canvases: [TEST_CANVAS, TEAM_CANVAS] });
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    const now = Date.now();
    jira.add({
      key: "OAI-1",
      summary: "El Backoffice no carga",
      status: "Por confirmar",
      priority: "Highest",
      labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona"],
      created: iso(now - day),
      custom: { [POINTS]: 3 },
      comments: ["Nuevo reporte del mismo problema por Beto en Slack: https://x/p2", "Respuesta de Ana en Slack: https://x/p3"],
    });
    // No points field on it, and no difficulty label: the description line, and a blank cell.
    jira.add({
      key: "OAI-2",
      summary: "Agregar filtro por fecha",
      type: "Tarea",
      status: "Por confirmar",
      priority: "Medium",
      labels: ["slack-intake", "acme-pwa", "para-persona"],
      created: iso(now - 2 * day),
      description: "Contexto\nFalta un filtro.\n\nPuntos de historia sugeridos: 5",
    });
    jira.add({ key: "OAI-3", summary: "Corregir el orden", status: "Confirmado", statusCategory: "indeterminate", priority: "Low", labels: ["slack-intake", "acme-backoffice", "difficulty:easy", "para-agente", "ready-for-agent"], created: iso(now - 3 * day), custom: { [POINTS]: 2 } });
    jira.add({ key: "OAI-4", summary: "No exporta el reporte", status: "Movido", statusCategory: "done", priority: "High", labels: ["slack-intake", "acme-backoffice", "moved-to-jira"], created: iso(now - 4 * day), resolved: iso(now - day), comments: ["Movido a OA: OA-123"] });
    jira.add({ key: "OAI-5", summary: "Cerrado hace dos días", status: "Listo", statusCategory: "done", priority: "Medium", labels: ["slack-intake"], created: iso(now - 5 * day), resolved: iso(now - 2 * day) });
    jira.add({ key: "OAI-6", summary: "No es un error", status: "Descartado", statusCategory: "done", priority: "Medium", labels: ["slack-intake"], created: iso(now - 5 * day), resolved: iso(now - day) });
    jira.add({ key: "OAI-7", summary: "Cerrado hace diez días", status: "Listo", statusCategory: "done", priority: "Medium", labels: ["slack-intake"], created: iso(now - 12 * day), resolved: iso(now - 10 * day) });
    jira.add({ key: "OAI-8", summary: "Ticket hecho a mano", status: "Por confirmar", priority: "Medium", labels: ["acme-backoffice"], created: iso(now - day) });
    jira.add({ key: "OA-9", summary: "Del equipo", status: "Por hacer", priority: "Medium", labels: ["slack-intake"], created: iso(now - day) });
    let closedFailure: number | null = null;
    const closedJql = closedIntakeJql("OAI");
    const fetch: Fetch = async (url, init) => {
      // A failure only the canvas's closed read meets, whatever else the poll
      // asks Jira, so the batch's own reads go through.
      if (closedFailure !== null && typeof init.body === "string" && (JSON.parse(init.body) as { jql?: string }).jql === closedJql) {
        const status = closedFailure;
        closedFailure = null;
        return new Response(JSON.stringify({ errorMessages: [`fake ${status}`] }), { status, headers: { "content-type": "application/json" } });
      }
      return jira.fetch(url, init);
    };
    const plans = new Map<string, unknown>();
    const stops: Denial[] = [];
    const deps = (minutes: number): PollDeps => ({
      rules,
      // The tickets' dates are real dates, and so are the fake's JQL windows: the clerk's clock is real too.
      now: () => Date.now() + minutes * 60_000,
      slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, fetch),
      storePath,
      intervalSeconds: 300,
      readPlan: (batch) => plans.get(batch),
      journal: () => {},
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: (denial) => {
        stops.push(denial);
        return true;
      },
    });
    await poll(deps(0), noCache());
    // The canvas's own reads, whatever else a live poll asks Jira.
    const searches = (): number => canvasSearches(jira).length;
    return { slack, jira, searches, failClosedRead: (status) => void (closedFailure = status), plans, stops, deps, store: () => readClerkStore(storePath, CHANNEL).store };
  }
  /** The body of one section of a canvas: from its heading to the next. */
  const section = (markdown: string, title: string): string => markdown.split(`## ${title}`)[1]!.split("\n## ")[0]!;
  const canvasSearches = (jira: FakeJira): { jql: string; fields: string[] }[] =>
    jira.calls
      .filter((call) => call.path === "/rest/api/3/search/jql")
      .map((call) => call.body as { jql: string; fields: string[] })
      .filter((body) => body.jql === openIntakeJql("OAI") || body.jql === closedIntakeJql("OAI"));
  const browse = (key: string): string => `[${key}](https://${SITE}/browse/${key})`;

  it("renders the channel canvas from the intake board: every section, the points field or line, the team's key, only slack-intake on the board", async () => {
    const r = await liveRig();
    const { lines } = await runOnce(r.deps(5));
    // The confirmation sweep (felipearos/ralph#449) runs first, on the board's
    // rejected ticket, and its note comes before the canvas's.
    expect(lines[0]).toBe("clerk-gate: OAI-6 rejected in 'Descartado': recorded as noise");
    expect(lines.find((line) => line.includes("channel canvas"))).toBe(`clerk-gate: channel canvas ${TEAM_CANVAS} rebuilt from the intake board OAI (6 tickets)`);
    const markdown = r.slack.canvases.get(TEAM_CANVAS)!;
    expect(markdown).toContain("Generado automáticamente desde el tablero de Jira OAI");
    // One plus the duplicate comment; a copied reply is not a report.
    expect(section(markdown, "Por confirmar")).toContain(`| ${browse("OAI-1")} | El Backoffice no carga | Backoffice | Error | Highest | medium | 3 | Por confirmar | 2 |`);
    expect(section(markdown, "Por confirmar")).toContain(`| ${browse("OAI-2")} | Agregar filtro por fecha | pwa | Tarea | Medium | - | 5 | Por confirmar | 1 |`);
    expect(section(markdown, "Para agente")).toContain(`| ${browse("OAI-3")} | Corregir el orden | Backoffice | Error | Low | easy | 2 | Confirmado | 1 |`);
    expect(section(markdown, "En el equipo")).toContain(`| ${browse("OAI-4")} | No exporta el reporte | Backoffice | Error | High | - | - | ${browse("OA-123")} | 1 |`);
    expect(section(markdown, "Cerrados en los últimos 7 días")).toContain(`[OAI-5]`);
    expect(section(markdown, "Descartados")).toContain(`[OAI-6]`);
    // Closed ten days ago is not even read; a ticket the clerk did not file, and the person board's own, never appear.
    for (const gone of ["OAI-7", "OAI-8", "OA-9"]) expect(markdown).not.toContain(`[${gone}]`);
    // Both reads ask for the points field, and name the intake board.
    const searches = canvasSearches(r.jira);
    expect(searches.map((search) => search.jql)).toEqual([openIntakeJql("OAI"), closedIntakeJql("OAI")]);
    expect(searches.every((search) => search.fields.includes(POINTS))).toBe(true);
    // Nothing written to Jira, and the test canvas is not the live clerk's to write.
    expect(r.jira.writes()).toEqual([]);
    expect(r.slack.canvases.get(TEST_CANVAS)).toBe("");
  });

  it("follows a ticket confirmed on the board at the next rebuild, and reads nothing before the interval", async () => {
    const r = await liveRig();
    await runOnce(r.deps(5));
    const read = r.searches();
    expect(read).toBe(2);
    const ticket = r.jira.issues.find((issue) => issue.key === "OAI-1")!;
    Object.assign(ticket, { status: "Confirmado", statusCategory: "indeterminate", labels: [...ticket.labels!, "ready-for-agent"] });
    await runOnce(r.deps(10));
    expect(r.searches()).toBe(read);
    expect(section(r.slack.canvases.get(TEAM_CANVAS)!, "Para agente")).not.toContain("[OAI-1]");
    await runOnce(r.deps(5 + LIVE.canvasMinutes));
    expect(section(r.slack.canvases.get(TEAM_CANVAS)!, "Para agente")).toContain("[OAI-1]");
    expect(section(r.slack.canvases.get(TEAM_CANVAS)!, "Por confirmar")).not.toContain("[OAI-1]");
  });

  it("creates the channel's canvas when the configured one is gone, and writes that one from then on", async () => {
    const r = await liveRig();
    r.slack.canvasGone(TEAM_CANVAS);
    const { lines } = await runOnce(r.deps(5));
    expect(lines.find((line) => line.includes("channel canvas"))).toBe(`clerk-gate: channel canvas ${TEAM_CANVAS} is gone or no longer reachable; created F0CHANNEL001 as ${CHANNEL}'s canvas (6 tickets) — set 'clerk.canvas' to it`);
    await runOnce(r.deps(5 + LIVE.canvasMinutes));
    expect(canvasCalls(r.slack).at(-1)).toMatchObject({ method: "canvases.edit", params: { canvas_id: "F0CHANNEL001" } });
  });

  it("keeps the newest past the row cap, and counts the rest", async () => {
    const r = await liveRig();
    const now = Date.now();
    for (let n = 0; n < 60; n += 1) r.jira.add({ key: `OAI-${300 + n}`, summary: `Error ${n}`, status: "Por confirmar", priority: "Medium", labels: ["slack-intake"], created: iso(now - (n + 1) * 60_000) });
    await runOnce(r.deps(5));
    const pending = section(r.slack.canvases.get(TEAM_CANVAS)!, "Por confirmar");
    // Two pending tickets from the rig plus 60, capped at the row cap; the rig's are the oldest.
    expect(pending).toContain(`y ${62 - LIVE.rowCap} más`);
    expect(pending).toContain("[OAI-300]");
    expect(pending).not.toContain("[OAI-2]");
  });

  it("never stops on a failed Jira read: leaves the canvas as it was, says why, hands the report over, and waits the interval", async () => {
    const r = await liveRig();
    await runOnce(r.deps(5));
    const before = r.slack.canvases.get(TEAM_CANVAS)!;
    const rebuiltAt = r.store().canvas.rebuiltAt;
    // A report a minute after that rebuild, settled ten minutes later, when the canvas is due again.
    r.slack.post({ ts: msTs(Date.now() + 6 * 60_000), user: "U0ANA", text: "No sincroniza" });
    r.jira.add({ key: "OAI-50", summary: "Nuevo y no leído", status: "Por confirmar", priority: "Medium", labels: ["slack-intake"], created: new Date().toISOString() });
    r.failClosedRead(503);
    const failed = await runOnce(r.deps(5 + LIVE.canvasMinutes));
    expect(failed.lines.find((line) => line.includes("channel canvas"))).toMatch(new RegExp(`^clerk-gate: channel canvas not rebuilt — .*503.*; tried again in ${LIVE.canvasMinutes}m$`));
    // The settled report is handed over on that same poll, and nothing stopped.
    expect(failed.code).toBe(0);
    expect(failed.lines.at(-1)).toMatch(/^clerk-gate: work available — 1 settled report/);
    expect(r.stops).toEqual([]);
    // The canvas is as it was: no half-read rebuild replaced it.
    expect(r.slack.canvases.get(TEAM_CANVAS)).toBe(before);
    expect(r.store().canvas.rebuiltAt).toBe(rebuiltAt);
    expect(r.store().canvas.triedAt).toEqual(expect.any(String));
    const searches = r.searches();
    await runOnce(r.deps(10 + LIVE.canvasMinutes));
    expect(r.searches()).toBe(searches);
    await runOnce(r.deps(5 + 2 * LIVE.canvasMinutes));
    expect(r.slack.canvases.get(TEAM_CANVAS)).toContain("[OAI-50]");
  });

  it("in quiet, draws the same board on the operator's test canvas and never on the channel's (felipearos/ralph#443)", async () => {
    const r = await liveRig({ ...LIVE, mode: "quiet" });
    const { lines } = await runOnce(r.deps(5));
    expect(lines).toContain(`clerk-gate: quiet: shadow canvas ${TEST_CANVAS} rebuilt from the intake board OAI (6 tickets)`);
    expect(r.slack.canvases.get(TEST_CANVAS)).toContain("Generado automáticamente desde el tablero de Jira OAI");
    expect(r.slack.canvases.get(TEAM_CANVAS)).toBe("");
    expect(canvasCalls(r.slack).map((call) => `${call.method} ${call.body?.canvas_id}`)).toEqual([`canvases.edit ${TEST_CANVAS}`]);
  });

  it("in quiet, writes no canvas without a test canvas, or with one that is gone, and creates none", async () => {
    const unset = await liveRig({ ...LIVE, mode: "quiet", shadowCanvas: null });
    expect((await runOnce(unset.deps(5))).lines).toContainEqual(expect.stringMatching(/^clerk-gate: quiet: no canvas written \(6 tickets\) — 'clerk.shadowCanvas' is not set/));
    expect(canvasCalls(unset.slack)).toEqual([]);
    // Waits the interval like any rebuild, rather than reading the board every poll.
    const searched = unset.searches();
    await runOnce(unset.deps(6));
    expect(unset.searches()).toBe(searched);

    const gone = await liveRig({ ...LIVE, mode: "quiet", shadowCanvas: "F0NOTTHERE1" });
    expect((await runOnce(gone.deps(5))).lines).toContain(
      "clerk-gate: quiet: shadow canvas F0NOTTHERE1 is gone or no longer reachable, and quiet creates none; set 'clerk.shadowCanvas' to a canvas of yours",
    );
    expect(gone.slack.created).toEqual([]);
    expect(canvasCalls(gone.slack).map((call) => call.method)).toEqual(["canvases.edit"]);
  });

  it("with no intake board configured, is stopped before it writes any canvas (felipearos/ralph#466)", async () => {
    // The config validator refuses this; the gate does not trust a hand-spelled rules object either.
    const rules: ClerkRules = { ...LIVE, jira: { site: SITE, project: "OA" } };
    const r = await liveRig(rules);
    const { lines } = await runOnce(r.deps(5));
    expect(lines).toContainEqual(expect.stringMatching(/^clerk-gate: stopping the loop — the clerk is live but 'clerk.jira.intakeProject' names no intake board/));
    expect(canvasCalls(r.slack)).toEqual([]);
    expect(r.searches()).toBe(0);
  });
});

describe("a rebuild that fails", () => {
  it("still hands a settled report over, says why, and tries again at the next poll", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No sincroniza" });
    r.slack.fail("canvases.edit", { status: 503 });
    const handed = await runOnce(r.deps(15));
    expect(handed.code).toBe(0);
    // Its shadow rig names no intake board, so the batch's own note
    // ("offered no duplicate candidates") is among the lines too.
    expect(handed.lines).toContain("clerk-gate: shadow canvas not rebuilt — Slack canvases.edit answered HTTP 503; tried again at the next poll");
    expect(handed.lines.at(-1)).toMatch(/^clerk-gate: work available — 1 settled report/);
    expect(r.store().canvas.rebuiltAt).toBeNull();

    // Not an interval later: the next poll.
    const retried = await runOnce(r.deps(16));
    expect(retried.lines[0]).toBe(`clerk-gate: shadow canvas ${TEST_CANVAS} rebuilt (0 would-be tickets)`);
  });

  it("never stops the loop, even on a code that stops it from any other call", async () => {
    const r = await rig();
    r.slack.fail("canvases.edit", { error: "missing_scope", needed: "canvases:write" });
    const polled = await poll(r.deps(5), noCache());
    expect(polled.verdict.stop).toBeUndefined();
    expect(polled.verdict.notes![0]).toContain("shadow canvas not rebuilt — Slack canvases.edit refused the clerk: missing_scope");
    expect(r.stops).toEqual([]);
  });

  it("is skipped when the poll is stopping the loop", async () => {
    const r = await rig();
    r.slack.fail("conversations.history", { error: "not_in_channel" });
    const polled = await poll(r.deps(5), noCache());
    expect(polled.verdict.stop).toBeDefined();
    expect(canvasCalls(r.slack)).toEqual([]);
  });

});
