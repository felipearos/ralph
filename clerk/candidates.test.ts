// @vitest-environment node
/**
 * The dedupe candidates code gathers before the session (felipearos/ralph#394,
 * #447): the open intake tickets and those closed within the regression
 * window, read from the Jira intake board, with the OA key of one moved to the
 * team's board. The list is also the boundary of what a `duplicate_of` may name.
 */
import { describe, expect, it } from "vitest";

import { INTAKE_WORKFLOW, SEARCH_COMMENTS, SITE, fakeJira } from "./fakes";
import { gatherIntakeCandidates, jiraKeyOf } from "./candidates";
import { jiraClient } from "./jira";
import type { Report } from "./reports";

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const report = (id: string): Report => ({
  id,
  author: "U1",
  roots: [id],
  messages: [{ ts: id, user: "U1", text: "No exporta", files: [], reply: false, permalink: "x" }],
  lastActivity: id,
  permalink: "x",
});

describe("a moved ticket's OA key", () => {
  it("is read from its newest comment naming one", () => {
    const at = Date.parse("2026-10-20T12:00:00Z");
    const comments = [
      { body: "Movido a OA-5.", createdAt: iso(at - 3 * DAY) },
      { body: "Corregido: ahora es OA-12, no OA-5.", createdAt: iso(at - 2 * DAY) },
      { body: "Sin clave.", createdAt: iso(at - DAY) },
      { body: "Un DOA-99 no es de este proyecto.", createdAt: iso(at - DAY) },
    ];
    expect(jiraKeyOf(comments, "OA")).toBe("OA-12");
    expect(jiraKeyOf([{ body: "Enviado a Jira." }], "OA")).toBeNull();
  });

  it("escapes the project key, so a key with regex characters matches only itself", () => {
    expect(jiraKeyOf([{ body: "OXA-3 y O.A-4" }], "O.A")).toBe("O.A-4");
  });
});

describe("the candidates read from the Jira intake board (felipearos/ralph#447)", () => {
  // The fake's `updated >= -Nd` counts from the real clock, so these do too.
  const now = Date.now();
  const INTAKE = { jira: { site: SITE, project: "OA", intakeProject: "OAI" }, regressionDays: 7 };
  const board = () => {
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    return { jira, client: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch) };
  };

  it("offers the open intake tickets and those done within the window, with a moved one's OA key", async () => {
    const { jira, client } = board();
    jira.add({
      key: "OAI-12",
      summary: "No exporta",
      labels: ["slack-intake", "acme-backoffice", "para-agente"],
      status: "Por confirmar",
      description: "No exporta.\n\nReportado por Ana Pérez en Slack: https://example.slack.com/archives/C0TESTCHAN1/p1760961000000100",
    });
    jira.add({ key: "OAI-7", summary: "Cerrado hace tres días", labels: ["slack-intake"], status: "Listo", statusCategory: "done", doneAt: iso(now - 3 * DAY), resolved: iso(now - 3 * DAY) });
    jira.add({ key: "OAI-3", summary: "Cerrado hace diez días", labels: ["slack-intake"], status: "Listo", statusCategory: "done", doneAt: iso(now - 10 * DAY), resolved: iso(now - 10 * DAY) });
    jira.add({
      key: "OAI-20",
      summary: "Pasó al equipo",
      labels: ["slack-intake", "moved-to-jira"],
      status: "Movido",
      statusCategory: "done",
      doneAt: iso(now - DAY),
      resolved: iso(now - DAY),
      comments: ["Confirmado.", "Pasa al equipo: OA-55"],
    });
    jira.add({ key: "OAI-30", summary: "Hecho a mano", labels: ["acme-backoffice"], status: "Por confirmar" });
    jira.add({ key: "OA-40", summary: "En el tablero del equipo", labels: ["slack-intake"], status: "Por hacer" });

    const candidates = await gatherIntakeCandidates(client, INTAKE, [report("1"), report("2")], now);

    expect([...candidates.keys()]).toEqual(["1", "2"]);
    expect(candidates.get("1")).toEqual([
      {
        key: "OAI-12",
        summary: "No exporta",
        status: "Por confirmar",
        closed: null,
        labels: ["slack-intake", "acme-backoffice", "para-agente"],
        jiraKey: null,
        permalink: "https://example.slack.com/archives/C0TESTCHAN1/p1760961000000100",
      },
      // A ticket with no reporter line, filed by hand or edited, offers no permalink.
      { key: "OAI-7", summary: "Cerrado hace tres días", status: "Listo", closed: iso(now - 3 * DAY), labels: ["slack-intake"], jiraKey: null, permalink: null },
      { key: "OAI-20", summary: "Pasó al equipo", status: "Movido", closed: iso(now - DAY), labels: ["slack-intake", "moved-to-jira"], jiraKey: "OA-55", permalink: null },
    ]);
    expect(candidates.get("2")).toEqual(candidates.get("1"));
    // Two searches, both on the board; nothing written.
    expect(jira.calls.map((call) => (call.body as { jql: string }).jql)).toEqual([
      'project = "OAI" AND labels = "slack-intake" AND statusCategory != Done ORDER BY created DESC',
      'project = "OAI" AND labels = "slack-intake" AND statusCategory = Done AND updated >= -7d ORDER BY updated DESC',
    ]);
    expect(jira.writes()).toEqual([]);
  });

  it("reads a moved ticket's comments whole when its key is past the ones the search carries", async () => {
    const { jira, client } = board();
    const many = [...Array.from({ length: SEARCH_COMMENTS }, (_, n) => `Nuevo reporte ${n}`), "Pasa al equipo: OA-77"];
    jira.add({ key: "OAI-21", summary: "Movido", labels: ["slack-intake", "moved-to-jira"], status: "Movido", statusCategory: "done", doneAt: iso(now - DAY), resolved: iso(now - DAY), comments: many });
    const [candidate] = (await gatherIntakeCandidates(client, INTAKE, [report("1")], now)).get("1")!;
    expect(candidate!.jiraKey).toBe("OA-77");
  });

  it("rejects when the board cannot be read, rather than handing a batch over without its candidates", async () => {
    const { jira, client } = board();
    jira.fail("/rest/api/3/search/jql", { status: 503 });
    await expect(gatherIntakeCandidates(client, INTAKE, [report("1")], now)).rejects.toThrow("HTTP 503");
  });
});
