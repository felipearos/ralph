// @vitest-environment node
/**
 * Threads after a report is done with (felipearos/ralph#321, #323), through the
 * gate against a fake Slack and a fake Jira at the HTTP seam:
 *
 * - a new reply on a filed report becomes one comment on its intake ticket,
 *   or on the OA ticket the confirmation sweep moved it to; the
 *   clerk's own replies and replies already copied are skipped, shadow records
 *   the comment and writes nothing, and a failed write leaves the reply for a
 *   later poll;
 * - a reply on an ignored report that mentions the clerk and says "esto es un
 *   reporte" hands the report over again, and the plan may not ignore it; the
 *   same mention on a filed report files nothing new.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { BOT, INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { noCache, poll, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import { slackClient, tsMs } from "./slack";
import { readClerkStore, withClerkStore } from "./store";
import { replyComment, saysReport } from "./threads";

const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  plans: Map<string, unknown>;
  storePath: string;
  rules: ClerkRules;
  deps: (minutes: number) => PollDeps;
  store: () => ReturnType<typeof readClerkStore>["store"];
}

async function rig(mode: "live" | "shadow", extra: Partial<ClerkRules> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-threads-"));
  roots.push(dir);
  const channel = "C0TEAMCHAN1";
  const rules: ClerkRules = {
    ...CLERK_DEFAULTS,
    appLabels: APP_LABELS,
    mode,
    channel,
    canvas: mode === "live" ? "F0CHANCANV1" : null,
    shadowCanvas: mode === "shadow" ? "F0SHADOWCV1" : null,
    operator: null,
    jira: { site: SITE, project: "OA", intakeProject: "OAI" },
    ...extra,
  };
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(channel, { users: { U0ANA: "Ana Pérez", U0BETO: "Beto", U0CARLA: "Carla" } });
  // Handed to a shadow clerk too, so the shadow fence is proven by the port
  // the gate builds, not by the credential being absent.
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  const plans = new Map<string, unknown>();
  const deps = (minutes: number): PollDeps => ({
    rules,
    now: () => at(minutes),
    slack: slackClient("xoxb-fake", slack.fetch, channel),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    intervalSeconds: 300,
    readPlan: (batch) => plans.get(batch),
    journal: () => {},
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: () => true,
  });
  await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
  return { slack, jira, plans, storePath, rules, deps, store: () => readClerkStore(storePath, channel).store };
}

/** Post a report at minute 1, hand it over, and apply `entry` for it: the report's root ts. */
async function filed(r: Rig, entry: Record<string, unknown>): Promise<string> {
  const root = after(T0, 1);
  r.slack.post({ ts: root, user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
  expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
  const batch = r.store().batch!;
  r.plans.set(batch.id, { batch: batch.id, entries: [{ report: batch.reports[0]!.id, ...entry }] });
  await poll(r.deps(16), noCache());
  expect(r.store().batch).toBeNull();
  return root;
}

const ISSUE = { verdict: "issue", type: "Error", app: "Backoffice", priority: "Medium", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "No se puede exportar", description_es: "Falla." };
/** The comments written, as `<key>` per comment, in order. */
const comments = (r: Rig) =>
  r.jira
    .writes()
    .filter((call) => call.path.endsWith("/comment"))
    .map((call) => /\/issue\/([^/]+)\/comment$/.exec(call.path)![1]!);
const creates = (r: Rig) => r.jira.writes().filter((call) => call.path === "/rest/api/3/issue");
const commentsOn = (r: Rig, key: string): string[] => r.jira.issues.find((issue) => issue.key === key)!.comments ?? [];

describe("a reply on a filed report", () => {
  it("is copied when an ignored user wrote it: only report detection skips them", async () => {
    // A team member answering in the thread is context the ticket should carry.
    const r = await rig("live", { ignoreUsers: ["U0BETO"] });
    const root = await filed(r, ISSUE);
    const key = r.store().processed[root]!.key!;
    r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "Lo reviso en la tienda 12", thread_ts: root });
    await poll(r.deps(40), noCache());
    expect(comments(r)).toEqual([key]);
    expect(commentsOn(r, key).at(-1)!).toContain("Respuesta de Beto en Slack");
    expect(creates(r)).toHaveLength(1);
  });

  it("is copied when an ignored user wrote it before the report was filed, and the report's own replies are not", async () => {
    // OAI-69: the team asked "¿no te llegó ninguna?" between the reporter's
    // lines. Left out of the report, older than its last reply — in no ticket.
    const r = await rig("live", { ignoreUsers: ["U0BETO"] });
    const root = after(T0, 1);
    r.slack.post({ ts: root, user: "U0ANA", text: "No me llegaron las notificaciones" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "¿No te llegó ninguna?", thread_ts: root });
    r.slack.post({ ts: after(T0, 3), user: "U0ANA", text: "Ninguna", thread_ts: root });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    expect(batch.reports[0]!.messages.map((message) => message.text)).toEqual(["No me llegaron las notificaciones", "Ninguna"]);
    r.plans.set(batch.id, { batch: batch.id, entries: [{ report: batch.reports[0]!.id, ...ISSUE }] });
    await poll(r.deps(16), noCache());
    const key = r.store().processed[root]!.key!;
    await poll(r.deps(20), noCache());
    expect(comments(r)).toEqual([key]);
    expect(commentsOn(r, key).at(-1)!).toContain("Respuesta de Beto en Slack");
    expect(commentsOn(r, key).at(-1)!).toContain("¿No te llegó ninguna?");
    // Past every reply in the ticket: nothing left to skip, and nothing written twice.
    expect(r.store().processed[root]!.inTicket).toBeUndefined();
    await poll(r.deps(30), noCache());
    expect(comments(r)).toHaveLength(1);
  });

  it("becomes one comment on its intake ticket, and is never copied twice", async () => {
    const r = await rig("live");
    const root = await filed(r, ISSUE);
    const key = r.store().processed[root]!.key!;
    expect(key).toMatch(/^OAI-\d+$/);
    r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "Le pasa también en la tienda 12 <@U0ANA>", thread_ts: root, files: [{ permalink: "https://example.slack.com/files/F9/captura.png" }] });
    // The clerk's own reply in the thread is never copied.
    r.slack.post({ ts: after(T0, 31), user: BOT.userId, bot_id: BOT.botId, text: `Ya está reportado: ${key}.`, thread_ts: root });
    await poll(r.deps(40), noCache());
    expect(comments(r)).toEqual([key]);
    const comment = commentsOn(r, key).at(-1)!;
    expect(comment).toContain(`Respuesta de Beto en Slack: https://example.slack.com/archives/C0TEAMCHAN1/p${after(T0, 30).replace(".", "")}?thread_ts=${root}&cid=C0TEAMCHAN1`);
    expect(comment).toContain("Le pasa también en la tienda 12 @Ana Pérez");
    expect(comment).toContain("https://example.slack.com/files/F9/captura.png");
    // Already copied: the next poll writes nothing.
    await poll(r.deps(50), noCache());
    expect(comments(r)).toHaveLength(1);
    // A second reply is the second comment, and only that one.
    r.slack.post({ ts: after(T0, 60), user: "U0ANA", text: "Ya no pasa", thread_ts: root });
    await poll(r.deps(70), noCache());
    expect(comments(r)).toHaveLength(2);
  });

  it("goes to the ticket a duplicate was folded into", async () => {
    const r = await rig("live");
    r.jira.add({ key: "OAI-12", summary: "No se puede exportar el reporte de checklists", labels: ["slack-intake"], status: "Por confirmar" });
    const root = await filed(r, { ...ISSUE, duplicate_of: "OAI-12", duplicate_confidence: "sure" });
    r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "otro dato", thread_ts: root });
    await poll(r.deps(40), noCache());
    // The duplicate comment from the apply, then the copied reply.
    expect(comments(r)).toEqual(["OAI-12", "OAI-12"]);
  });

  it("follows the ticket to the OA board once the sweep moved it there, live only", async () => {
    for (const mode of ["live", "shadow"] as const) {
      const r = await rig(mode);
      const root = await filed(r, ISSUE);
      const key = r.store().processed[root]!.key!;
      r.jira.add({ key: "OA-5", summary: "No se puede exportar", labels: [], status: "Por hacer" });
      // What the confirmation sweep records once it has moved a to-person ticket.
      await withClerkStore(r.storePath, r.rules.channel, (store) => {
        store.confirmed = { [key]: { outcome: "to-person", at: new Date(at(20)).toISOString(), done: true, oaKey: mode === "live" ? "OA-5" : "SHADOW-OA5" } };
      });
      r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "otro dato", thread_ts: root });
      await poll(r.deps(40), noCache());
      if (mode === "live") {
        expect(comments(r)).toEqual(["OA-5"]);
        expect(r.store().processed[root]!.movedTo).toBe("OA-5");
      } else {
        expect(r.jira.writes()).toEqual([]);
        expect(r.store().shadow.writes.find((entry) => entry.write.kind === "thread-comment")!.write).toMatchObject({ key });
      }
    }
  });

  it("is dropped, not retried forever, when its ticket was deleted by hand", async () => {
    const r = await rig("live");
    const root = await filed(r, ISSUE);
    // What Jira answers a write to a ticket deleted by hand.
    r.jira.fail(`/rest/api/3/issue/${r.store().processed[root]!.key}/comment`, { status: 404 }, { method: "POST" });
    r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "otro dato", thread_ts: root });
    const polled = await poll(r.deps(40), noCache());
    expect(polled.verdict.waitSeconds).toBeUndefined();
    expect(r.store().processed[root]!.copiedThrough).toBe(after(T0, 30));
    // And the clerk goes on filing.
    r.slack.post({ ts: after(T0, 41), user: "U0CARLA", text: "No llega el correo de bienvenida" });
    expect((await poll(r.deps(55), noCache())).verdict.work).toBe(true);
  });

  it("reads a thread whose last word is the clerk's own reply once, not on every poll", async () => {
    const r = await rig("live");
    const root = await filed(r, { ...ISSUE, priority: "Highest" });
    // The Highest reply was posted by the apply; one poll reads it, the next ones do not.
    await poll(r.deps(20), noCache());
    const before = r.slack.calls.filter((call) => call.method === "conversations.replies").length;
    for (const minute of [25, 30, 35]) await poll(r.deps(minute), noCache());
    expect(r.slack.calls.filter((call) => call.method === "conversations.replies").length).toBe(before);
    expect(r.store().processed[root]!.copiedThrough).not.toBe(root);
  });

  it("is recorded in shadow and written nowhere", async () => {
    const r = await rig("shadow");
    const root = await filed(r, ISSUE);
    r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "otro dato", thread_ts: root });
    await poll(r.deps(40), noCache());
    expect(r.jira.writes()).toEqual([]);
    expect(r.slack.calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    const copied = r.store().shadow.writes.filter((entry) => entry.write.kind === "thread-comment");
    expect(copied).toHaveLength(1);
    expect(copied[0]!.write).toMatchObject({ kind: "thread-comment", reply: after(T0, 30), key: r.store().processed[root]!.key });
    // Recorded once, however many polls see it.
    await poll(r.deps(50), noCache());
    expect(r.store().shadow.writes.filter((entry) => entry.write.kind === "thread-comment")).toHaveLength(1);
  });

  it("is left for a later poll when Jira refuses the write", async () => {
    const r = await rig("live");
    const root = await filed(r, ISSUE);
    const key = r.store().processed[root]!.key!;
    r.slack.post({ ts: after(T0, 30), user: "U0BETO", text: "otro dato", thread_ts: root });
    r.jira.fail(`/rest/api/3/issue/${key}/comment`, { status: 503 }, { method: "POST" });
    const failed = await poll(r.deps(40), noCache());
    expect(failed.verdict.work).toBe(false);
    expect(failed.verdict.waitSeconds).toBeGreaterThan(0);
    expect(commentsOn(r, key)).toEqual([]);
    expect(r.store().processed[root]!.copiedThrough).not.toBe(after(T0, 30));
    // Jira is back: the reply is copied, once.
    await poll(r.deps(50), noCache());
    expect(commentsOn(r, key)).toHaveLength(1);
    expect(r.store().processed[root]!.copiedThrough).toBe(after(T0, 30));
  });
});

describe("a mention that says it is a report", () => {
  const mention = (root: string, minute: number) => ({
    ts: after(T0, minute),
    user: "U0CARLA",
    text: `<@${BOT.userId}> Esto ES un reporte, no lo ignores`,
    thread_ts: root,
  });

  it("hands an ignored report over again, with the hint, and the plan may not ignore it", async () => {
    const r = await rig("live");
    const root = await filed(r, { verdict: "ignore", ignore_reason: "parece conversación" });
    expect(r.store().processed[root]!.state).toBe("ignored");
    // A reply that does not ask changes nothing.
    r.slack.post({ ts: after(T0, 20), user: "U0BETO", text: "jaja", thread_ts: root });
    expect((await poll(r.deps(25), noCache())).verdict.work).toBe(false);

    r.slack.post(mention(root, 30));
    const again = await poll(r.deps(31), noCache());
    expect(again.verdict.work).toBe(true);
    const batch = r.store().batch!;
    expect(batch.reports.map((report) => [report.id, report.hint])).toEqual([[root, "Carla"]]);
    expect(batch.reports[0]!.messages.map((message) => message.text)).toContain(`<@${BOT.userId}> Esto ES un reporte, no lo ignores`);

    // Ignored again: refused, handed back with the reason.
    r.plans.set(batch.id, { batch: batch.id, entries: [{ report: root, verdict: "ignore", ignore_reason: "sigue pareciendo conversación" }] });
    const refused = await poll(r.deps(32), noCache());
    expect(refused.verdict.work).toBe(true);
    expect(r.store().batch!.problems).toEqual([expect.stringContaining('may not be "ignore": Carla said in its thread that this is a report')]);
    // Filed this time.
    r.plans.set(batch.id, { batch: batch.id, entries: [{ report: root, ...ISSUE }] });
    await poll(r.deps(33), noCache());
    expect(r.store().processed[root]!.state).toBe("filed");
    expect(creates(r)).toHaveLength(1);
  });

  it("goes back to ignored, rather than waiting for ever, when the report cannot be rebuilt", async () => {
    const r = await rig("live");
    const root = await filed(r, { verdict: "ignore", ignore_reason: "parece conversación" });
    r.slack.post(mention(root, 30));
    // The mention re-opens it, but Jira is down, so nothing is handed over.
    r.jira.fail("/rest/api/3/search/jql", { status: 503 });
    expect((await poll(r.deps(31), noCache())).verdict.work).toBe(false);
    expect(Object.keys(r.store().reopened ?? {})).toEqual([root]);
    // Then the report's message is deleted: there is nothing left to hand over.
    const real = r.slack.fetch;
    r.slack.fetch = async (url, init) => {
      const response = await real(url, init);
      if (!url.includes("conversations.history")) return response;
      const body = (await response.json()) as { messages: { ts: string }[] };
      return new Response(JSON.stringify({ ...body, messages: body.messages.filter((message) => message.ts !== root) }), { status: 200 });
    };
    expect((await poll(r.deps(40), noCache())).verdict.work).toBe(false);
    expect(r.store().reopened ?? {}).toEqual({});
    expect(r.store().processed[root]).toMatchObject({ state: "ignored" });
  });

  it("files nothing new on a report already filed: it is one more reply, copied as a comment", async () => {
    const r = await rig("live");
    const root = await filed(r, ISSUE);
    r.slack.post(mention(root, 30));
    const polled = await poll(r.deps(40), noCache());
    expect(polled.verdict.work).toBe(false);
    expect(creates(r)).toHaveLength(1);
    expect(comments(r)).toHaveLength(1);
  });

  it("is recognised whatever the case and accents, and only when it mentions the clerk", () => {
    const me = { userId: BOT.userId, botId: BOT.botId };
    expect(saysReport({ ts: "1", user: "U1", text: `<@${BOT.userId}> esto es un reporté` }, me)).toBe(true);
    expect(saysReport({ ts: "1", user: "U1", text: "esto es un reporte" }, me)).toBe(false);
    expect(saysReport({ ts: "1", user: "U1", text: `<@${BOT.userId}> gracias` }, me)).toBe(false);
  });
});

describe("the comment a reply becomes", () => {
  it("names who wrote it, links it, quotes it and lists its files, in plain Spanish", () => {
    expect(replyComment({ name: "Beto", permalink: "https://x/p1", text: "se cae 💥\nen la tienda", files: ["https://x/f.png"], names: {} })).toBe(
      "Respuesta de Beto en Slack: https://x/p1\n\n> se cae\n> en la tienda\n\nAdjuntos:\n- https://x/f.png",
    );
  });
});
