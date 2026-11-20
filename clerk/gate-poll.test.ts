// @vitest-environment node
/**
 * The clerk's gate reading Slack (felipearos/ralph#317), one poll at a time,
 * against a fake Slack at the HTTP seam and a store in a scratch directory.
 *
 * In-process, as `ci-doctor/gate-poll.test.ts` drives the doctor's: the CLI's
 * I/O is the real Slack, so `runOnce` — exactly what `--once` prints and exits
 * with — is called with the fake wired in instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { BOT, INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeSlack, APP_LABELS } from "./fakes";
import { backoffSeconds, noCache, poll, runOnce, type Cached, type Denial, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import { msTs, slackClient, tsMs } from "./slack";
import { WATCH_DAYS } from "./threads";
import { markProcessed, readClerkStore, withClerkStore } from "./store";

const CHANNEL = "C0TESTCHAN1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: "F0SHADOWCV1",
  operator: null,
  jira: { site: "example.atlassian.net", project: "OA" },
};

/** The moment the clerk was started, as a Slack ts: everything below is minutes after it. */
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  deps: (nowMinutes: number) => PollDeps;
  storePath: string;
  denials: Denial[];
  stops: Denial[];
}

/** A clerk whose store already starts at T0, as its first poll would have left it. */
async function rig(rules: ClerkRules = RULES): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-poll-"));
  roots.push(dir);
  const storePath = join(dir, "ralph", "clerk", "clara.json");
  const slack = fakeSlack(CHANNEL, { canvases: ["F0SHADOWCV1"] });
  const denials: Denial[] = [];
  const stops: Denial[] = [];
  const deps = (nowMinutes: number): PollDeps => ({
    rules,
    now: () => at(nowMinutes),
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    // Jira answers the candidate reads with nothing: what a poll hands over
    // is this suite's subject, and `clerk/gate-apply.test.ts` is Jira's.
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, fakeJira("OA").fetch),
    storePath,
    readPlan: () => undefined,
    journal: () => {},
    intervalSeconds: 300,
    notify: (denial) => denials.push(denial),
    alert: () => {},
    secret: "test-secret",
    stop: (denial) => {
      stops.push(denial);
      return true;
    },
  });
  // The first poll only starts the clock.
  const first = await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
  expect(first.verdict.work).toBe(false);
  expect(first.verdict.why).toContain(`starting at ${T0}`);
  return { slack, deps, storePath, denials, stops };
}

const batchOf = (r: Rig) => readClerkStore(r.storePath, CHANNEL).store.batch;

describe("handing over settled reports", () => {
  it("exits 0 for a settled report and hands it over whole", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    const { lines, code } = await runOnce(r.deps(12));
    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(/^clerk-gate: work available — 1 settled report in C0TESTCHAN1 \(batch-\d+\.\d+, attempt 1\) — oldest https:\/\/example\.slack\.com\/archives\/C0TESTCHAN1\/p\d+$/);
    const batch = batchOf(r)!;
    expect(batch.reports).toHaveLength(1);
    expect(batch.reports[0]).toMatchObject({ author: "U0ANA", messages: [{ text: "No puedo exportar el reporte de checklists", reply: false }] });
  });

  it("does nothing for a report still being written", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No carga la app" });
    const { lines, code } = await runOnce(r.deps(9));
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("clerk-gate: nothing to do — 1 report in C0TESTCHAN1 still being written (settled after 10m quiet)");
    expect(batchOf(r)).toBeNull();
  });

  it("joins one author's consecutive messages within the join window, and only those", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "Se cae al guardar" });
    r.slack.post({ ts: after(T0, 3), user: "U0ANA", text: "adjunto pantallazo", files: [{ permalink: "https://example.slack.com/files/U0ANA/F1/pantallazo.png" }] });
    // Beyond the window from the previous one: a new report by the same author.
    r.slack.post({ ts: after(T0, 7), user: "U0ANA", text: "otra cosa: el filtro no funciona" });
    // Another author breaks a run, even inside the window.
    r.slack.post({ ts: after(T0, 8), user: "U0BETO", text: "a mí también se me cae" });
    r.slack.post({ ts: after(T0, 9), user: "U0ANA", text: "y el logo sale pixelado" });
    expect((await runOnce(r.deps(30))).code).toBe(0);
    const reports = batchOf(r)!.reports;
    expect(reports.map((report) => report.messages.map((message) => message.text))).toEqual([
      ["Se cae al guardar", "adjunto pantallazo"],
      ["otra cosa: el filtro no funciona"],
      ["a mí también se me cae"],
      ["y el logo sale pixelado"],
    ]);
    expect(reports[0]!.messages[1]!.files).toEqual(["https://example.slack.com/files/U0ANA/F1/pantallazo.png"]);
  });

  it("includes the thread in the report, and the thread keeps it from settling", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No sincroniza" });
    r.slack.post({ ts: after(T0, 6), user: "U0CARLA", text: "¿En qué tienda?", thread_ts: after(T0, 1) });
    r.slack.post({ ts: after(T0, 8), user: "U0ANA", text: "Tienda 12, desde ayer", thread_ts: after(T0, 1) });
    // Ten minutes after the first message, but only two after the last reply.
    expect((await runOnce(r.deps(11))).code).toBe(1);
    expect((await runOnce(r.deps(18))).code).toBe(0);
    const [report] = batchOf(r)!.reports;
    expect(report!.messages.map((message) => [message.text, message.reply])).toEqual([
      ["No sincroniza", false],
      ["¿En qué tienda?", true],
      ["Tienda 12, desde ayer", true],
    ]);
    expect(report!.messages[2]!.permalink).toContain(`?thread_ts=${after(T0, 1)}&cid=${CHANNEL}`);
  });

  it("never treats the clerk's own messages as a report or as activity", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: BOT.userId, bot_id: BOT.botId, text: "Tabla actualizada" });
    r.slack.post({ ts: after(T0, 2), user: "U0ANA", text: "No llega el correo" });
    // The bot answering in the thread nine minutes later neither settles it late nor joins it.
    r.slack.post({ ts: after(T0, 11), user: BOT.userId, bot_id: BOT.botId, text: "ya registrado como OA-12", thread_ts: after(T0, 2) });
    r.slack.post({ ts: after(T0, 12), bot_id: BOT.botId, subtype: "bot_message", text: "otro aviso" });
    expect((await runOnce(r.deps(13))).code).toBe(0);
    const reports = batchOf(r)!.reports;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.messages.map((message) => message.text)).toEqual(["No llega el correo"]);
  });

  it("hands over at most batchSize reports, oldest first", async () => {
    const r = await rig({ ...RULES, batchSize: 2 });
    for (const [minute, user] of [[1, "U1"], [2, "U2"], [3, "U3"]] as const) r.slack.post({ ts: after(T0, minute), user, text: `reporte ${user}` });
    expect((await runOnce(r.deps(20))).code).toBe(0);
    expect(batchOf(r)!.reports.map((report) => report.author)).toEqual(["U1", "U2"]);
  });
});

/** What an apply does to a handed batch: every report processed, the batch cleared. */
async function applyBatch(r: Rig): Promise<string[]> {
  const batch = batchOf(r)!;
  await withClerkStore(r.storePath, CHANNEL, (store) => {
    for (const report of batch.reports) markProcessed(store, report.id, { state: "filed", key: `OA-${report.id}`, at: new Date(at(0)).toISOString() });
    store.batch = null;
  });
  return batch.reports.map((report) => report.id);
}

describe("a backfill from a cursor moved weeks back (cursor.ts --since)", () => {
  it("drains three weeks oldest first, a batch per poll, reading only a batch's threads", async () => {
    const r = await rig({ ...RULES, batchSize: 20 });
    // Three weeks before T0, one report every 84 minutes by alternating
    // authors, every third with a thread: 360 reports, past one 200-message
    // page of history, so the read crosses Slack's newest-first pages.
    const posted: string[] = [];
    for (let index = 0; index < 360; index++) {
      const ts = after(T0, -21 * 24 * 60 + index * 84);
      posted.push(ts);
      r.slack.post({ ts, user: index % 2 === 0 ? "U0ANA" : "U0BETO", text: `reporte ${index}` });
      if (index % 3 === 0) r.slack.post({ ts: after(ts, 1), user: "U0CARLA", text: "¿desde cuándo?", thread_ts: ts });
    }
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.cursor = msTs(tsMs(posted[0]!) - 1);
    });
    const filed: string[] = [];
    for (let round = 0; round < 40 && filed.length < posted.length; round++) {
      const before = r.slack.calls.length;
      const polled = await poll(r.deps(60), noCache());
      expect(polled.verdict.work, polled.verdict.why).toBe(true);
      const calls = r.slack.calls.slice(before);
      // Never one giant batch, and never every thread of the backlog in one poll.
      expect(batchOf(r)!.reports.length).toBeLessThanOrEqual(20);
      expect(calls.filter((call) => call.method === "conversations.replies").length).toBeLessThanOrEqual(20);
      filed.push(...(await applyBatch(r)));
    }
    // Every report, each once, in the order it was written.
    expect(filed).toEqual(posted);
    expect((await poll(r.deps(61), noCache())).verdict).toMatchObject({ work: false, why: "no unfiled report in C0TESTCHAN1" });
    expect(readClerkStore(r.storePath, CHANNEL).store.cursor).toBe(posted.at(-1));
  });

  it("resumes where a 429 left it, oldest first, after waiting its Retry-After", async () => {
    const r = await rig({ ...RULES, batchSize: 2 });
    const posted = [-300, -200, -100].map((minutes, index) => {
      const ts = after(T0, minutes);
      r.slack.post({ ts, user: `U${index}`, text: `reporte ${index}` });
      r.slack.post({ ts: after(ts, 1), user: "U0CARLA", text: "?", thread_ts: ts });
      return ts;
    });
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.cursor = msTs(tsMs(posted[0]!) - 1);
    });
    r.slack.fail("conversations.replies", { status: 429, retryAfter: "45" });
    expect((await poll(r.deps(5), noCache())).verdict).toMatchObject({ work: false, waitSeconds: 45 });
    expect(batchOf(r)).toBeNull();
    expect((await poll(r.deps(6), noCache())).verdict.work).toBe(true);
    const first = await applyBatch(r);
    expect((await poll(r.deps(7), noCache())).verdict.work).toBe(true);
    expect([...first, ...(await applyBatch(r))]).toEqual(posted);
  });
});

describe("a clerk moved to another channel", () => {
  it("inherits neither the old channel's cursor nor its processed reports", async () => {
    const r = await rig();
    // The old channel's history: a report filed, the cursor past it.
    r.slack.post({ ts: after(T0, 5), user: "U0ANA", text: "viejo" });
    expect((await poll(r.deps(20), noCache())).verdict.work).toBe(true);
    await applyBatch(r);
    await poll(r.deps(21), noCache());
    expect(readClerkStore(r.storePath, CHANNEL).store.cursor).toBe(after(T0, 5));

    // The config now names the team channel, whose history holds a message
    // at the very ts the old channel's processed report has.
    const MOVED = "C0MOVEDCHN1";
    const team = fakeSlack(MOVED, { canvases: ["F0SHADOWCV1"] });
    team.post({ ts: after(T0, 5), user: "U0BETO", text: "No carga el checklist" });
    const moved = (minutes: number): PollDeps => ({ ...r.deps(minutes), rules: { ...RULES, channel: MOVED }, slack: slackClient("xoxb-fake", team.fetch, MOVED) });
    const first = await poll(moved(30), noCache());
    expect(first.verdict.why).toContain(`is for ${CHANNEL}, not ${MOVED}`);
    expect(first.verdict.why).toContain(`starting at ${msTs(at(30))}`);
    // Started at now: nothing of the team channel's before the move is filed…
    expect((await poll(moved(31), noCache())).verdict).toMatchObject({ work: false, why: `no unfiled report in ${MOVED}` });
    // …until the cursor is moved back (cursor.ts --since), and then the
    // report is handed over, not taken for the old channel's processed one.
    await withClerkStore(r.storePath, MOVED, (store) => {
      store.cursor = T0;
    });
    expect((await poll(moved(32), noCache())).verdict.work).toBe(true);
    expect(readClerkStore(r.storePath, MOVED).store.batch!.reports.map((report) => [report.id, report.author])).toEqual([[after(T0, 5), "U0BETO"]]);
  });
});

describe("clerk.ignoreUsers", () => {
  it("files, counts and joins nothing of an ignored user's, and replies to them with nothing", async () => {
    const r = await rig({ ...RULES, ignoreUsers: ["U0TEAM01"] });
    r.slack.post({ ts: after(T0, 1), user: "U0TEAM01", text: "lo reviso hoy" });
    expect((await runOnce(r.deps(30))).lines.at(-1)).toBe("clerk-gate: nothing to do — no unfiled report in C0TESTCHAN1");
    r.slack.post({ ts: after(T0, 31), user: "U0ANA", text: "No exporta" });
    // A team member's reply in the thread is not the report's, and does not hold it from settling.
    r.slack.post({ ts: after(T0, 38), user: "U0TEAM01", text: "¿en qué tienda?", thread_ts: after(T0, 31) });
    r.slack.post({ ts: after(T0, 39), user: "U0TEAM01", text: "hablando de otra cosa" });
    expect((await runOnce(r.deps(42))).code).toBe(0);
    const reports = batchOf(r)!.reports;
    expect(reports.map((report) => [report.author, report.messages.map((message) => message.text)])).toEqual([["U0ANA", ["No exporta"]]]);
    expect(r.slack.calls.filter((call) => call.method === "chat.postMessage")).toEqual([]);
  });
});

describe("what the gate reads", () => {
  it("reads the threads of reports nobody has processed, and no others", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "uno" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "respuesta", thread_ts: after(T0, 1) });
    r.slack.post({ ts: after(T0, 3), user: "U0CARLA", text: "dos" });
    r.slack.post({ ts: after(T0, 4), user: "U0BETO", text: "otra", thread_ts: after(T0, 3) });
    // The first report's thread is still open, so the cursor stays behind it.
    r.slack.post({ ts: after(T0, 20), user: "U0BETO", text: "¿sigue?", thread_ts: after(T0, 1) });
    await withClerkStore(r.storePath, CHANNEL, (store) => markProcessed(store, after(T0, 3), { state: "filed", key: "OA-1", at: new Date(at(5)).toISOString() }));
    const before = r.slack.calls.length;
    await poll(r.deps(21), noCache());
    const replies = r.slack.calls.slice(before).filter((call) => call.method === "conversations.replies");
    expect(replies.map((call) => call.params.ts)).toEqual([after(T0, 1)]);
  });
});

describe("the durable cursor", () => {
  it("survives a restart, and a processed report is never handed over again", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "uno" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "dos" });
    expect((await runOnce(r.deps(15))).code).toBe(0);
    const handed = batchOf(r)!;
    expect(handed.reports).toHaveLength(2);

    // What the apply does per report (felipearos/ralph#318).
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      for (const report of handed.reports) markProcessed(store, report.id, { state: "filed", key: "OA-1", at: "now" });
    });

    // A restart: a new process, the same store.
    const restarted = await poll(r.deps(16), noCache());
    expect(restarted.verdict.work).toBe(false);
    expect(readClerkStore(r.storePath, CHANNEL).store.cursor).toBe(after(T0, 2));
    // And the next poll hands nothing over again. Its read reaches back over
    // the thread-watch window, not just from the cursor (felipearos/ralph#321).
    expect((await poll(r.deps(17), noCache())).verdict.work).toBe(false);
    expect(r.slack.calls.filter((call) => call.method === "conversations.history").at(-1)!.params.oldest).toBe(msTs(at(17) - WATCH_DAYS * 86_400_000));
  });

  it("hands nothing newer over while an older report is still being written", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "lento" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "rápido" });
    // The first one's thread is still going; the second is settled, and waits for it.
    r.slack.post({ ts: after(T0, 14), user: "U0CARLA", text: "¿desde cuándo?", thread_ts: after(T0, 1) });
    expect((await runOnce(r.deps(15))).code).toBe(1);
    expect(batchOf(r)).toBeNull();
    expect((await runOnce(r.deps(30))).code).toBe(0);
    expect(batchOf(r)!.reports.map((report) => report.author)).toEqual(["U0ANA", "U0BETO"]);
  });

  it("holds behind a report that is not done, without handing the done ones after it again", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "lento" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "rápido" });
    r.slack.post({ ts: after(T0, 14), user: "U0CARLA", text: "¿desde cuándo?", thread_ts: after(T0, 1) });
    // The second was processed already (a re-opened report filed, say) while the first is still going.
    await withClerkStore(r.storePath, CHANNEL, (store) => markProcessed(store, after(T0, 2), { state: "ignored", key: null, at: "now" }));

    expect((await runOnce(r.deps(16))).code).toBe(1);
    // The cursor cannot pass the unsettled report, and the processed one past it stays processed.
    expect(readClerkStore(r.storePath, CHANNEL).store.cursor).toBe(T0);
    expect((await runOnce(r.deps(30))).code).toBe(0);
    expect(batchOf(r)!.reports.map((report) => report.author)).toEqual(["U0ANA"]);
  });

  it("starts at now: nothing posted before the clerk's first poll is a report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-poll-"));
    roots.push(dir);
    const slack = fakeSlack(CHANNEL, { canvases: ["F0SHADOWCV1"] });
    slack.post({ ts: after(T0, -60), user: "U0ANA", text: "viejo" });
    const deps: PollDeps = {
      rules: RULES,
      now: () => at(0),
      slack: slackClient("xoxb-fake", slack.fetch),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, fakeJira("OA").fetch),
      storePath: join(dir, "clara.json"),
      readPlan: () => undefined,
      journal: () => {},
      intervalSeconds: 300,
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: () => true,
    };
    expect((await poll(deps, noCache())).verdict.work).toBe(false);
    expect((await poll({ ...deps, now: () => at(30) }, noCache())).verdict).toMatchObject({ work: false, why: "no unfiled report in C0TESTCHAN1" });
  });
});

describe("when Slack fails", () => {
  it("waits exactly Retry-After on a 429, and hands nothing over", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "uno" });
    r.slack.fail("conversations.history", { status: 429, retryAfter: "30" });
    const polled = await poll(r.deps(20), noCache());
    expect(polled.verdict).toMatchObject({ work: false, waitSeconds: 30 });
    expect(polled.verdict.stop).toBeUndefined();
    expect(batchOf(r)).toBeNull();
    // And the next poll reads it.
    expect((await poll(r.deps(21), polled.cached)).verdict.work).toBe(true);
  });

  it("backs off on a transient failure, doubling per failure in a row, and forgets once one succeeds", async () => {
    const r = await rig();
    let cached: Cached = noCache();
    for (const [index, failure] of [{ status: 503 as const }, { network: "ETIMEDOUT" }, { error: "internal_error" }].entries()) {
      r.slack.fail("auth.test", failure);
      const polled = await poll(r.deps(5), cached);
      expect(polled.verdict.work).toBe(false);
      expect(polled.verdict.waitSeconds).toBe(backoffSeconds(300, index + 1));
      cached = polled.cached;
    }
    expect([1, 2, 3].map((streak) => backoffSeconds(300, streak))).toEqual([300, 600, 1200]);
    expect(backoffSeconds(300, 20)).toBe(3600);
    const recovered = await poll(r.deps(6), cached);
    expect(recovered.cached.transientStreak).toBe(0);
    expect(r.denials).toEqual([]);
    expect(r.stops).toEqual([]);
  });

  it("stops the loop on each denial, with the remedy and one notification, without throwing", async () => {
    for (const [code, remedy] of [
      ["invalid_auth", "store a valid bot token"],
      ["missing_scope", "add the channels:history scope"],
      ["not_in_channel", "invite the clerk's bot"],
    ] as const) {
      const r = await rig();
      r.slack.fail("conversations.history", { error: code, ...(code === "missing_scope" ? { needed: "channels:history" } : {}) });
      const { lines, code: exit } = await runOnce(r.deps(5));
      // A denial is not "nothing to do": 2, which the supervisor reads as a
      // gate that could not reach a verdict and stops on as gate-broken.
      expect(exit, code).toBe(2);
      expect(lines[0]).toMatch(/^clerk-gate: stopping the loop — /);
      expect(lines[0]).toContain(remedy);
      expect(r.denials.map((denial) => denial.code)).toEqual([code]);
      expect(r.stops.map((denial) => denial.code)).toEqual([code]);
    }
  });

  it("treats no token at all as a denial, before asking Slack anything", async () => {
    const r = await rig();
    const calls = r.slack.calls.length;
    const polled = await poll({ ...r.deps(5), slack: null }, noCache());
    expect(polled.verdict.stop?.remedy).toContain("RALPH_CLERK_SLACK_TOKEN");
    expect(r.stops.map((denial) => denial.code)).toEqual(["no_token"]);
    expect(r.slack.calls.length).toBe(calls);
  });

  it("says when the stop could not be queued, so the gate fails instead of re-gating into the same denial", async () => {
    const r = await rig();
    r.slack.fail("auth.test", { error: "invalid_auth" });
    const polled = await poll({ ...r.deps(5), stop: () => false }, noCache());
    expect(polled.verdict.stop).toMatchObject({ queued: false });
  });

  it("still stops when the notification itself cannot be sent", async () => {
    const r = await rig();
    r.slack.fail("auth.test", { error: "token_revoked" });
    const polled = await poll({ ...r.deps(5), notify: () => { throw new Error("no feed"); } }, noCache());
    expect(polled.verdict.stop).toBeDefined();
    expect(r.stops.map((denial) => denial.code)).toEqual(["token_revoked"]);
  });
});

describe("candidates from the Jira intake board (felipearos/ralph#447)", () => {
  const INTAKE: ClerkRules = { ...RULES, jira: { site: SITE, project: "OA", intakeProject: "OAI" } };
  /** A rig on the intake board, with the board's fake and whether the gate holds a Jira credential at all. */
  const intakeRig = async (rules: ClerkRules, credential = true) => {
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    jira.add({ key: "OAI-12", summary: "No exporta", labels: ["slack-intake"], status: "Por confirmar" });
    const r = await rig(rules);
    const deps = (minutes: number): PollDeps => ({ ...r.deps(minutes), jira: credential ? jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch) : null });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar" });
    return { ...r, jira, deps };
  };

  it("offers the board's tickets in shadow", async () => {
    const r = await intakeRig(INTAKE);
    const polled = await poll(r.deps(12), noCache());
    expect(polled.verdict.work).toBe(true);
    expect(batchOf(r)!.reports[0]!.candidates.map((candidate) => candidate.key)).toEqual(["OAI-12"]);
    expect(r.jira.writes()).toEqual([]);
  });

  it("hands a shadow batch over with no candidates while the board cannot be read, and says so", async () => {
    const r = await intakeRig(INTAKE);
    r.jira.fail("/rest/api/3/search/jql", { status: 503 });
    const polled = await poll(r.deps(12), noCache());
    expect(polled.verdict.work).toBe(true);
    expect(batchOf(r)!.reports[0]!.candidates).toEqual([]);
    expect(polled.verdict.notes?.some((note) => note.startsWith("the Jira intake board could not be read for duplicate candidates"))).toBe(true);
  });

  it("hands nothing over live while the board cannot be read, and backs off rather than throwing", async () => {
    const r = await intakeRig({ ...INTAKE, mode: "live" });
    r.jira.fail("/rest/api/3/search/jql", { status: 503 });
    const polled = await poll(r.deps(12), noCache());
    expect(polled.verdict.work).toBe(false);
    expect(polled.verdict.waitSeconds).toBeGreaterThan(0);
    expect(batchOf(r)).toBeNull();
    expect(r.stops).toEqual([]);
  });

  it("hands a shadow batch over with no candidates when the gate holds no Jira credential", async () => {
    const r = await intakeRig(INTAKE, false);
    const polled = await poll(r.deps(12), noCache());
    expect(polled.verdict.work).toBe(true);
    expect(batchOf(r)!.reports[0]!.candidates).toEqual([]);
    // Said once, however the poll's notes are gathered.
    expect(polled.verdict.notes?.filter((note) => note.includes("candidates"))).toEqual(["no RALPH_CLERK_JIRA_TOKEN: this batch is offered no duplicate candidates"]);
    expect(r.stops).toEqual([]);
  });

  it("stops a live clerk on the board with no Jira credential as no_jira_credential", async () => {
    const r = await intakeRig({ ...INTAKE, mode: "live" }, false);
    const polled = await poll(r.deps(12), noCache());
    expect(polled.verdict.stop).toBeDefined();
    expect(r.stops.map((denial) => denial.code)).toEqual(["no_jira_credential"]);
    // With the credential, the same live clerk polls on.
    const held = await intakeRig({ ...INTAKE, mode: "live" });
    expect((await poll(held.deps(12), noCache())).verdict.work).toBe(true);
    expect(held.stops).toEqual([]);
  });
});
