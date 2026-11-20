// @vitest-environment node
/**
 * The clerk's daily KPI report (felipearos/ralph#453): the calendar, the
 * numbers and the text from a fixture ledger, who it goes to, and the send
 * against a fake Slack at the HTTP seam — never the network.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { KPI_REPORT_DEFAULTS, clerkRules, loadProjectConfig, type KpiReportRules } from "../project-config";
import { fakeSlack, type FakeSlack } from "./fakes";
import {
  buildKpi,
  dueDay,
  kpiText,
  readKpiState,
  reportWindow,
  sendDueReport,
  targetsFor,
  writeKpiState,
  type KpiDeps,
  type Members,
} from "./kpi";
import { appendEvent, type MetricsEvent } from "./metrics";
import { slackClient } from "./slack";

const CHANNEL = "C0TESTCHAN1";
const OPERATOR = "U0OPERATOR1";
const RECIPIENTS = ["U0LEADER01", "U0LEADER02"];
const KPI_CHANNEL = "C0KPICHAN01";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-kpi-"));
  roots.push(dir);
  return dir;
};

/** Santiago is UTC-3 in October 2026: 12:00Z is 09:00 there. Thursday 2026-10-22. */
const THU_0905 = Date.parse("2026-10-22T12:05:00Z");
const THU_0855 = Date.parse("2026-10-22T11:55:00Z");
const THU_1500 = Date.parse("2026-10-22T18:00:00Z");
const FRI_0910 = Date.parse("2026-10-23T12:10:00Z");
const SAT_1000 = Date.parse("2026-10-24T13:00:00Z");

const base = { v: 1 as const, mode: "shadow" as const };
const reported = (report: string, reporter: string, reportedAt: string, reporterName?: string): MetricsEvent => ({
  ...base,
  at: reportedAt,
  kind: "reported",
  report,
  reporter,
  ...(reporterName === undefined ? {} : { reporterName }),
  channel: CHANNEL,
  reportedAt,
});
const classified = (report: string, at: string, fields: Partial<Extract<MetricsEvent, { kind: "classified" }>> = {}): MetricsEvent => ({
  ...base,
  at,
  kind: "classified",
  report,
  key: `OAI-${report}`,
  verdict: "issue",
  app: "Backoffice",
  assignee: "agent",
  difficulty: "medium",
  storyPoints: 3,
  ...fields,
});

/**
 * The fixture ledger: Wednesday 2026-10-21 (the window of Thursday's report)
 * has four reports from two people — one filed, confirmed with overrides and
 * done; one filed and rejected; one ignored; one a duplicate — plus a pwa
 * report confirmed and still open. Older history gives signal versus noise.
 */
const WED = (time: string): string => `2026-10-21T${time}Z`;
const LEDGER: MetricsEvent[] = [
  reported("1", "U0ANA00001", WED("13:00:00"), "Ana"),
  classified("1", WED("13:20:00"), { assignee: "agent", difficulty: "easy", storyPoints: 2 }),
  {
    ...base,
    at: WED("15:00:00"),
    kind: "confirmed",
    report: "1",
    key: "OAI-1",
    by: { accountId: "acc-rafa", displayName: "Rafa" },
    latencyMs: 90 * 60_000,
    overrides: [
      { field: "priority", agent: "Media", human: "Alta" },
      { field: "storyPoints", agent: 2, human: 5 },
      { field: "summary", agent: "a", human: "b" },
    ],
  },
  { ...base, at: WED("20:00:00"), kind: "closed", report: "1", key: "OAI-1", resolution: "Done", status: "Done" },

  reported("2", "U0ANA00001", WED("14:00:00"), "Ana"),
  classified("2", WED("14:20:00"), { assignee: "person", difficulty: "hard", storyPoints: 8 }),
  { ...base, at: WED("16:00:00"), kind: "rejected", report: "2", key: "OAI-2" },

  reported("3", "U0BETO0001", WED("15:00:00")),
  classified("3", WED("15:20:00"), { verdict: "ignore" }),
  { ...base, at: WED("15:20:00"), kind: "ignored", report: "3", reason: "saludo" },

  reported("4", "U0BETO0001", WED("16:00:00")),
  { ...base, at: WED("16:20:00"), kind: "duplicate", report: "4", of: "OAI-1" },

  reported("5", "U0BETO0001", WED("17:00:00")),
  classified("5", WED("17:20:00"), { app: "pwa", assignee: "person", difficulty: "hard", storyPoints: 5 }),
  {
    ...base,
    at: WED("19:00:00"),
    kind: "confirmed",
    report: "5",
    key: "OAI-5",
    by: { accountId: "acc-rafa" },
    latencyMs: 30 * 60_000,
    overrides: [{ field: "priority", agent: "Media", human: "Alta" }],
  },

  // Ten days before: Carla's one report, which keeps her out of the window and quiet now.
  reported("6", "U0CARLA001", "2026-10-12T13:00:00Z"),
  classified("6", "2026-10-12T13:10:00Z"),
];

const RULES: KpiReportRules = { ...KPI_REPORT_DEFAULTS, recipients: RECIPIENTS };
const DAY = "2026-10-22";
const MEMBERS: Members = { ok: true, current: ["U0ANA00001", "U0BETO0001", "U0CARLA001", "U0DANI0001"], previous: ["U0ANA00001", "U0BETO0001", "U0CARLA001", "U0EVA00001"] };
const input = (members: Members = MEMBERS) => ({ day: DAY, window: reportWindow(DAY, RULES), timezone: RULES.timezone, quietDays: 7, members });

describe("the calendar", () => {
  it("is due from 09:00 Santiago on a weekday, and not before or on a weekend", () => {
    expect(dueDay(THU_0855, RULES)).toBeNull();
    expect(dueDay(THU_0905, RULES)).toBe("2026-10-22");
    // A missed 09:00 is still that day's report, sent late.
    expect(dueDay(THU_1500, RULES)).toBe("2026-10-22");
    expect(dueDay(SAT_1000, RULES)).toBeNull();
    expect(dueDay(SAT_1000, { ...RULES, weekdays: false })).toBe("2026-10-24");
  });

  it("follows the configured time zone, not the host's", () => {
    // 12:05Z is 09:05 in Santiago but 08:05 in New York.
    expect(dueDay(THU_0905, { ...RULES, timezone: "America/New_York" })).toBeNull();
  });

  it("covers yesterday, and from Friday on a Monday", () => {
    expect(reportWindow("2026-10-22", RULES)).toEqual({ from: "2026-10-21", to: "2026-10-21" });
    expect(reportWindow("2026-10-26", RULES)).toEqual({ from: "2026-10-23", to: "2026-10-25" });
    expect(reportWindow("2026-10-26", { weekdays: false })).toEqual({ from: "2026-10-25", to: "2026-10-25" });
  });
});

describe("the numbers", () => {
  const data = buildKpi(LEDGER, input());

  it("counts intake volume by app, by reporter and by outcome", () => {
    expect(data.intake).toEqual({
      reports: 5,
      byApp: { Backoffice: 3, pwa: 1, "sin dato": 1 },
      byReporter: { U0ANA00001: 2, U0BETO0001: 3 },
      status: { filed: 3, ignored: 1, duplicate: 1, unclassified: 0 },
    });
  });

  it("reads confirmation with the clerk-metrics names", () => {
    expect(data.confirmation.confirmed).toBe(2);
    expect(data.confirmation.rejected).toBe(1);
    expect(data.confirmation.medianConfirmLatencyMs).toBe(60 * 60_000);
    expect(data.confirmation.overrideRateByField).toEqual({ priority: 1, storyPoints: 0.5, summary: 0.5 });
    // Free text is rated, never ranked as a common change.
    expect(data.confirmation.topChanges).toEqual([
      { field: "priority", agent: "Media", human: "Alta", count: 2 },
      { field: "storyPoints", agent: 2, human: 5, count: 1 },
    ]);
  });

  it("splits delivery, counts what closed with its confirmed points, and the open backlog by difficulty", () => {
    expect(data.delivery).toEqual({
      assignee: { agent: 1, person: 2 },
      done: 1,
      // The confirmer's 5, not the clerk's 2.
      storyPointsClosed: 5,
      // Report 5 (hard) and Carla's older report (medium) are open; 2 was rejected.
      backlogByDifficulty: { hard: 1, medium: 1 },
    });
  });

  it("reads signal versus noise per reporter", () => {
    expect(data.signal).toEqual([
      // Points come from valuable reports only, at their final value: Ana's done
      // 5 (overridden from 2), nothing for Beto's confirmed but still open 5, nor
      // for Ana's rejected 8 or Carla's unconfirmed 3.
      { reporter: "U0BETO0001", reports: 3, valuable: 0, noise: 1, pending: 1, duplicate: 1, storyPoints: 0 },
      { reporter: "U0ANA00001", reports: 2, valuable: 1, noise: 1, pending: 0, duplicate: 0, storyPoints: 5 },
      { reporter: "U0CARLA001", reports: 1, valuable: 0, noise: 0, pending: 1, duplicate: 0, storyPoints: 0 },
    ]);
  });

  it("names quiet members, and who joined and left since the last report", () => {
    expect(data.participation).toEqual({ ok: true, quietDays: 7, quiet: ["U0CARLA001", "U0DANI0001"], joined: ["U0DANI0001"], left: ["U0EVA00001"], compared: true });
  });
});

describe("the text", () => {
  const text = kpiText(LEDGER, input(), { draft: true, recipients: RECIPIENTS });

  it("renders every section from the fixture ledger, participation included", () => {
    for (const heading of ["*Volumen*", "*Confirmación*", "*Señal y ruido*", "*Entrega*", "*Participación*"]) expect(text).toContain(heading);
    expect(text).toContain("*Reporte diario de intake, 2026-10-22* (periodo: 2026-10-21)");
    expect(text).toContain("- Reportes recibidos: 5");
    expect(text).toContain("- Resultado: 3 registrados, 1 ignorados, 1 duplicados");
    expect(text).toContain("- Confirmados: 2; descartados: 1");
    expect(text).toContain("- Tiempo mediano hasta confirmar: 1.0 h");
    expect(text).toContain("- Correcciones por campo: prioridad 100%, puntos 50%, resumen 50%");
    expect(text).toContain("- Cambios más comunes: prioridad Media a Alta (2); puntos 2 a 5 (1)");
    expect(text).toContain("- <@U0ANA00001>: 2 reportes, 1 valiosos, 1 ruido, 0 pendientes, 5 puntos (50% valiosos)");
    expect(text).toContain("- Responsable de lo registrado: persona 2, agente 1");
    expect(text).toContain("- Tickets terminados: 1; puntos de historia cerrados: 5");
    expect(text).toContain("- Pendientes por dificultad: hard 1, medium 1");
    expect(text).toContain("- Sin reportes en los últimos 7 días: <@U0CARLA001>, <@U0DANI0001>");
    expect(text).toContain("- Se unieron al canal desde el último reporte: <@U0DANI0001>");
    expect(text).toContain("- Salieron del canal desde el último reporte: <@U0EVA00001>");
  });

  it("says it is a draft, and who it would go to", () => {
    expect(text.split("\n")[0]).toBe("_Borrador, solo para el operador; destinatarios configurados: <@U0LEADER01>, <@U0LEADER02>._");
    expect(kpiText(LEDGER, input(), { draft: false, recipients: RECIPIENTS })).not.toContain("Borrador");
  });

  it("keeps the participation line when the members could not be read", () => {
    const failed = kpiText(LEDGER, input({ ok: false, why: "Slack conversations.members failed: missing_scope" }), { draft: true, recipients: [] });
    expect(failed).toContain("*Participación*\n- Datos de miembros del canal no disponibles (Slack conversations.members failed: missing_scope)");
  });

  it("names an excluded person in no per-person line, and still counts their reports", () => {
    const excluded = kpiText(LEDGER, { ...input(), exclude: ["U0ANA00001", "U0CARLA001", "U0EVA00001"] }, { draft: true, recipients: [] });
    expect(excluded).not.toContain("U0ANA00001");
    expect(excluded).not.toContain("U0CARLA001");
    expect(excluded).not.toContain("U0EVA00001");
    expect(excluded).toContain("- Reportes recibidos: 5");
    expect(excluded).toContain("- Sin reportes en los últimos 7 días: <@U0DANI0001>");
    expect(excluded).toContain("- Salieron del canal desde el último reporte: nadie");
  });

  it("says there is nothing to compare with on the first report", () => {
    const first = kpiText(LEDGER, input({ ok: true, current: ["U0ANA00001"], previous: null }), { draft: true, recipients: [] });
    expect(first).toContain("- Altas y bajas del canal: sin reporte anterior con que comparar");
  });

  it("renders an empty ledger without a gap", () => {
    const empty = kpiText([], input(), { draft: true, recipients: [] });
    expect(empty).toContain("- Reportes recibidos: 0");
    expect(empty).toContain("- Tiempo mediano hasta confirmar: sin datos");
    expect(empty).toContain("- Sin reportes en el periodo");
  });

  it("carries no emoji", () => {
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/:[a-z_]+:/);
  });
});

describe("who it goes to", () => {
  it("sends a draft to the operator alone", () => {
    expect(targetsFor(RULES, "live", OPERATOR)).toEqual({ to: [OPERATOR], channels: [], draft: true });
    expect(targetsFor(RULES, "shadow", OPERATOR)).toEqual({ to: [OPERATOR], channels: [], draft: true });
    // A draft is never posted in a channel, whatever is configured.
    expect(targetsFor({ ...RULES, channels: [KPI_CHANNEL] }, "live", OPERATOR).channels).toEqual([]);
  });

  it("never reaches the recipients in shadow, even switched to send", () => {
    const shadow = targetsFor({ ...RULES, mode: "send" }, "shadow", OPERATOR);
    expect(shadow.to).toEqual([OPERATOR]);
    expect(shadow.draft).toBe(true);
    expect(shadow.draftWhy).toContain("shadow");
  });

  it("never reaches the recipients in quiet either: the team hears nothing (#443)", () => {
    expect(targetsFor({ ...RULES, mode: "send", channels: [KPI_CHANNEL] }, "quiet", OPERATOR)).toEqual({
      to: [OPERATOR],
      channels: [],
      draft: true,
      draftWhy: "clerk en modo quiet: no se envía a los destinatarios",
    });
  });

  it("reaches the recipients only switched to send and live", () => {
    expect(targetsFor({ ...RULES, mode: "send" }, "live", OPERATOR)).toEqual({ to: RECIPIENTS, channels: [], draft: false });
    expect(targetsFor({ ...RULES, mode: "send", channels: [KPI_CHANNEL, KPI_CHANNEL] }, "live", OPERATOR)).toEqual({ to: RECIPIENTS, channels: [KPI_CHANNEL], draft: false });
  });
});

interface Rig {
  slack: FakeSlack;
  deps: (overrides?: Partial<KpiDeps>) => KpiDeps;
  statePath: string;
}

function rig(options: { members?: string[]; bots?: string[]; joined?: string[] } = {}): Rig {
  const dir = scratch();
  const metricsPath = join(dir, "clara.metrics.jsonl");
  for (const event of LEDGER) appendEvent(metricsPath, event);
  const statePath = join(dir, "clara.kpi.json");
  const slack = fakeSlack(CHANNEL, { members: options.members ?? ["U0ANA00001", "U0BETO0001", "U0BOTOTRO1"], bots: options.bots ?? ["U0BOTOTRO1"], joined: options.joined ?? [] });
  return {
    slack,
    statePath,
    deps: (overrides = {}) => ({
      rules: RULES,
      clerkMode: "shadow",
      operator: OPERATOR,
      channel: CHANNEL,
      metricsPath,
      statePath,
      memo: { doneDay: null },
      ...overrides,
    }),
  };
}

const client = (slack: FakeSlack) => slackClient("xoxb-fake", slack.fetch, CHANNEL);

describe("sending from the gate", () => {
  it("DMs the draft to the operator only, and records the day", async () => {
    const r = rig();
    const notes = await sendDueReport(r.deps(), client(r.slack), THU_0905);
    expect(notes).toEqual([`kpi draft for 2026-10-22 sent to ${OPERATOR}`]);
    expect(r.slack.dms.map((dm) => dm.user)).toEqual([OPERATOR]);
    expect(r.slack.dms[0]!.text).toContain("*Reporte diario de intake, 2026-10-22*");
    // Bots are not the team: the other bot is no quiet member.
    expect(r.slack.dms[0]!.text).toContain("- Sin reportes en los últimos 7 días: nadie");
    expect(r.slack.calls.filter((call) => call.method === "conversations.open").map((call) => call.params.users)).toEqual([OPERATOR]);
    expect(readKpiState(r.statePath)).toMatchObject({ day: "2026-10-22", sentTo: [OPERATOR], members: ["U0ANA00001", "U0BETO0001"] });
  });

  it("never DMs the recipients in shadow mode, whatever the switch says", async () => {
    const r = rig();
    await sendDueReport(r.deps({ rules: { ...RULES, mode: "send" } }), client(r.slack), THU_0905);
    expect(r.slack.dms.map((dm) => dm.user)).toEqual([OPERATOR]);
    expect(r.slack.dms[0]!.text).toContain("clerk en modo shadow");
  });

  it("DMs each recipient once it is switched to send and the clerk is live", async () => {
    const r = rig();
    await sendDueReport(r.deps({ rules: { ...RULES, mode: "send" }, clerkMode: "live" }), client(r.slack), THU_0905);
    expect(r.slack.dms.map((dm) => dm.user)).toEqual(RECIPIENTS);
    expect(r.slack.dms[0]!.text).not.toContain("Borrador");
  });

  it("is off with a note on every poll, and sends nothing, without an operator", async () => {
    const r = rig();
    const deps = r.deps({ operator: null });
    for (const at of [THU_0855, THU_0905, THU_1500]) {
      expect(await sendDueReport(deps, client(r.slack), at)).toEqual([expect.stringContaining("kpi report off — 'clerk.operator' is not set")]);
    }
    expect(r.slack.calls).toEqual([]);
  });

  it("sends nothing before 09:00 or on a weekend", async () => {
    const r = rig();
    expect(await sendDueReport(r.deps(), client(r.slack), THU_0855)).toEqual([]);
    expect(await sendDueReport(r.deps(), client(r.slack), SAT_1000)).toEqual([]);
    expect(r.slack.calls).toEqual([]);
  });

  it("sends one report per weekday: a later poll and a restart send none", async () => {
    const r = rig();
    const deps = r.deps();
    await sendDueReport(deps, client(r.slack), THU_0905);
    expect(await sendDueReport(deps, client(r.slack), THU_1500)).toEqual([]);
    // A restart: a fresh process memo, the state on disk.
    expect(await sendDueReport(r.deps(), client(r.slack), THU_1500)).toEqual([]);
    expect(r.slack.dms).toHaveLength(1);
    // The next weekday is a new report.
    await sendDueReport(r.deps(), client(r.slack), FRI_0910);
    expect(r.slack.dms).toHaveLength(2);
    expect(r.slack.dms[1]!.text).toContain("*Reporte diario de intake, 2026-10-23*");
  });

  it("does not resend in the same process when the state cannot be written", async () => {
    const r = rig();
    // A directory where the state file should be: every write fails.
    const deps = r.deps({ statePath: scratch() });
    const notes = await sendDueReport(deps, client(r.slack), THU_0905);
    expect(notes.join("\n")).toContain("could not be written");
    expect(await sendDueReport(deps, client(r.slack), THU_1500)).toEqual([]);
    expect(r.slack.dms).toHaveLength(1);
  });

  it("logs a failed send, does not throw, and retries the same text at the next poll", async () => {
    const r = rig();
    r.slack.fail("chat.postMessage", { status: 503 });
    const notes = await sendDueReport(r.deps(), client(r.slack), THU_0905);
    expect(notes).toEqual([expect.stringMatching(/^kpi draft for 2026-10-22 not sent to U0OPERATOR1: Slack chat.postMessage answered HTTP 503 — retried at the next poll$/)]);
    expect(r.slack.dms).toEqual([]);
    const first = readKpiState(r.statePath).text;

    r.slack.members.push("U0NUEVO001");
    await sendDueReport(r.deps(), client(r.slack), THU_1500);
    expect(r.slack.dms).toHaveLength(1);
    // Rendered once: the retry is the text the first attempt rendered.
    expect(r.slack.dms[0]!.text).toBe(first);
  });

  it("degrades a refused scope to a note rather than a stop", async () => {
    const r = rig();
    r.slack.fail("conversations.open", { error: "missing_scope", needed: "im:write" });
    const notes = await sendDueReport(r.deps(), client(r.slack), THU_0905);
    expect(notes[0]).toContain("missing_scope");
    expect(notes[0]).toContain("retried at the next poll");
  });

  it("still sends, saying so, when the channel's members cannot be read", async () => {
    const r = rig();
    r.slack.fail("conversations.members", { error: "missing_scope", needed: "groups:read" });
    await sendDueReport(r.deps(), client(r.slack), THU_0905);
    expect(r.slack.dms[0]!.text).toContain("- Datos de miembros del canal no disponibles (Slack conversations.members refused the clerk: missing_scope (needs groups:read))");
  });

  it("compares members with the last report's", async () => {
    const r = rig({ members: ["U0ANA00001", "U0BETO0001"], bots: [] });
    await sendDueReport(r.deps(), client(r.slack), THU_0905);
    r.slack.members.splice(0, r.slack.members.length, "U0BETO0001", "U0NUEVO001");
    await sendDueReport(r.deps(), client(r.slack), FRI_0910);
    expect(r.slack.dms[1]!.text).toContain("- Se unieron al canal desde el último reporte: <@U0NUEVO001>");
    expect(r.slack.dms[1]!.text).toContain("- Salieron del canal desde el último reporte: <@U0ANA00001>");
  });

  describe("posting in kpiReport.channels", () => {
    const CHANNELS: KpiReportRules = { ...RULES, channels: [KPI_CHANNEL] };

    it("posts nothing in a channel for a draft, nor in shadow or quiet, even switched to send", async () => {
      for (const [rules, clerkMode] of [
        [CHANNELS, "live"],
        [{ ...CHANNELS, mode: "send" }, "shadow"],
        [{ ...CHANNELS, mode: "send" }, "quiet"],
      ] as const) {
        const r = rig({ joined: [KPI_CHANNEL] });
        await sendDueReport(r.deps({ rules, clerkMode }), client(r.slack), THU_0905);
        expect(r.slack.channelPosts, clerkMode).toEqual([]);
        expect(r.slack.dms.map((dm) => dm.user)).toEqual([OPERATOR]);
      }
    });

    it("tells the operator's draft which channels a sent report would reach", async () => {
      const r = rig({ joined: [KPI_CHANNEL] });
      await sendDueReport(r.deps({ rules: CHANNELS }), client(r.slack), THU_0905);
      expect(r.slack.dms[0]!.text.split("\n")[0]).toContain(`canales configurados: <#${KPI_CHANNEL}>`);
    });

    it("posts the report once per day as a top-level message, sent and live, beside the DMs", async () => {
      const r = rig({ joined: [KPI_CHANNEL] });
      const deps = r.deps({ rules: { ...CHANNELS, mode: "send" }, clerkMode: "live" });
      const notes = await sendDueReport(deps, client(r.slack), THU_0905);
      expect(notes).toContain(`kpi report for 2026-10-22 posted in ${KPI_CHANNEL}`);
      expect(r.slack.channelPosts).toHaveLength(1);
      expect(r.slack.channelPosts[0]).toEqual({ channel: KPI_CHANNEL, text: r.slack.dms[0]!.text });
      expect(r.slack.channelPosts[0]!.text).toContain("*Reporte diario de intake, 2026-10-22*");
      expect(r.slack.channelPosts[0]!.text).not.toContain("Borrador");
      const post = r.slack.calls.find((call) => call.method === "chat.postMessage" && call.params.channel === KPI_CHANNEL);
      expect(post?.body?.thread_ts).toBeUndefined();
      // A later poll, and a restart, post nothing more today.
      expect(await sendDueReport(deps, client(r.slack), THU_1500)).toEqual([]);
      expect(await sendDueReport(r.deps({ rules: { ...CHANNELS, mode: "send" }, clerkMode: "live" }), client(r.slack), THU_1500)).toEqual([]);
      expect(r.slack.channelPosts).toHaveLength(1);
      expect(readKpiState(r.statePath).sentTo).toEqual([...RECIPIENTS, KPI_CHANNEL]);
      // The next weekday is a new post.
      await sendDueReport(r.deps({ rules: { ...CHANNELS, mode: "send" }, clerkMode: "live" }), client(r.slack), FRI_0910);
      expect(r.slack.channelPosts).toHaveLength(2);
    });

    it("notes a channel the bot is not in, without failing, and posts it once the bot is invited", async () => {
      const r = rig();
      const deps = r.deps({ rules: { ...CHANNELS, mode: "send" }, clerkMode: "live" });
      const notes = await sendDueReport(deps, client(r.slack), THU_0905);
      expect(notes).toContain(
        `kpi report for 2026-10-22 not posted in ${KPI_CHANNEL}: the bot is not a member (channel_not_found); invite the clerk's bot to ${KPI_CHANNEL} (/invite in the channel) — retried at the next poll`,
      );
      // The DMs went out regardless, and are not sent again on the retry.
      expect(r.slack.dms.map((dm) => dm.user)).toEqual(RECIPIENTS);
      r.slack.fail("chat.postMessage", { error: "not_in_channel" });
      expect((await sendDueReport(deps, client(r.slack), THU_1500)).join("\n")).toContain("the bot is not a member (not_in_channel)");
      r.slack.joined.push(KPI_CHANNEL);
      expect(await sendDueReport(deps, client(r.slack), THU_1500)).toEqual([`kpi report for 2026-10-22 posted in ${KPI_CHANNEL}`]);
      expect(r.slack.channelPosts).toHaveLength(1);
      expect(r.slack.dms).toHaveLength(RECIPIENTS.length);
      expect(await sendDueReport(deps, client(r.slack), THU_1500)).toEqual([]);
    });

    it("notes a failed post, naming the channel, and retries it", async () => {
      const r = rig({ joined: [KPI_CHANNEL] });
      const deps = r.deps({ rules: { ...CHANNELS, mode: "send", recipients: [] }, clerkMode: "live" });
      r.slack.fail("chat.postMessage", { status: 503 });
      const notes = await sendDueReport(deps, client(r.slack), THU_0905);
      expect(notes).toEqual([
        `kpi report for 2026-10-22 not posted in ${KPI_CHANNEL}: Slack chat.postMessage answered HTTP 503; check that the clerk's bot is invited to ${KPI_CHANNEL} — retried at the next poll`,
      ]);
      await sendDueReport(deps, client(r.slack), THU_1500);
      expect(r.slack.channelPosts).toHaveLength(1);
    });
  });

  it("reads an unreadable state as empty", () => {
    const path = join(scratch(), "state.json");
    writeFileSync(path, "{not json");
    expect(readKpiState(path)).toEqual({ v: 1, day: null, text: null, sentTo: [], members: null });
    expect(writeKpiState(path, { v: 1, day: DAY, text: "x", sentTo: [OPERATOR], members: null })).toBe(true);
    expect(readKpiState(path).day).toBe(DAY);
  });
});

describe("the fixture", () => {
  it("has a kpiReport block in draft mode, with placeholder user ids", () => {
    const rules = clerkRules(loadProjectConfig(join(import.meta.dirname, "..", "fixtures", "clerk")));
    expect(rules?.kpiReport).toMatchObject({ mode: "draft", time: "09:00", timezone: "America/Santiago", weekdays: true, quietDays: 7 });
    for (const id of rules!.kpiReport!.recipients) expect(id).toMatch(/^U[A-Z0-9]+$/);
    expect(rules?.operator).toMatch(/^U/);
  });
});
