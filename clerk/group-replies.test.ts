// @vitest-environment node
/**
 * The grouping replies: Slack cannot move a message into a thread, so a report
 * the clerk joined from several top-level messages shows it with replies, in
 * live mode only. The first message's reply lists the others, each of the
 * others is pointed back at the first, a rerun posts none of them twice, a
 * failed post is a note and a retry, and shadow and quiet post nothing.
 *
 * In-process through the gate, against the fake Slack and the fake Jira at the
 * HTTP seam: the replies asserted are the requests the real clients sent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkMode, type ClerkRules } from "../project-config";
import { applyDecisions, chileTime, followUpReply, groupedReply, RECEIVED_REPLY, type Progress } from "./apply";
import { INTAKE_WORKFLOW, SITE, WORKSPACE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { noCache, poll, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import { intakePort } from "./live";
import type { BatchReport, Decision } from "./plan";
import { permalink } from "./reports";
import { slackClient, tsMs, type Fetch } from "./slack";
import { readClerkStore } from "./store";

const CHANNEL = "C0TEAMCHAN1";
const rulesFor = (mode: ClerkMode): ClerkRules => ({
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode,
  channel: CHANNEL,
  canvas: "F0CHANCANV1",
  shadowCanvas: null,
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI" },
});
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));
const linkOf = (ts: string): string => permalink(WORKSPACE, CHANNEL, ts);

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  rules: ClerkRules;
  plans: Map<string, unknown>;
  storePath: string;
  /** Threads whose `chat.postMessage` fails, as a Slack outage of one call would. */
  failing: Set<string>;
  /** The threads of every post the fake refused, in order. */
  refused: string[];
  deps: (minutes: number) => PollDeps;
}

async function rig(mode: ClerkMode = "live"): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-group-"));
  dirs.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { users: { U0ANA: "Ana Pérez", U0BETO: "Beto" } });
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  jira.add({ key: "OAI-12", summary: "No se puede exportar el reporte de checklists", labels: ["slack-intake", "acme-backoffice"], status: "Confirmado", statusCategory: "indeterminate", created: new Date(at(0) - 86_400_000).toISOString() });
  const failing = new Set<string>();
  const refused: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith("/chat.postMessage") && failing.has(String(body.thread_ts))) {
      refused.push(String(body.thread_ts));
      return new Response(JSON.stringify({ ok: false, error: "fatal_error" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return slack.fetch(url, init);
  };
  const rules = rulesFor(mode);
  const plans = new Map<string, unknown>();
  const deps = (minutes: number): PollDeps => ({
    rules,
    now: () => at(minutes),
    slack: slackClient("xoxb-fake", fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    intervalSeconds: 300,
    readPlan: (batch) => plans.get(batch) ?? "no plan",
    journal: () => {},
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: () => true,
  });
  await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
  return { slack, jira, rules, plans, storePath, failing, refused, deps };
}

/** Ana's three messages a minute apart: one report, joined from three. */
const ROOTS = [after(T0, 1), after(T0, 2), after(T0, 3)];
function postGrouped(r: Rig): void {
  r.slack.post({ ts: ROOTS[0]!, user: "U0ANA", text: "No puedo exportar el reporte de tareas" });
  r.slack.post({ ts: ROOTS[1]!, user: "U0ANA", text: "mira la captura" });
  r.slack.post({ ts: ROOTS[2]!, user: "U0ANA", text: "y en Chrome tampoco" });
}

const entry = (report: string, extra: Record<string, unknown> = {}) => ({
  report,
  verdict: "issue",
  type: "Error",
  app: "Backoffice",
  priority: "Medium",
  assignee: "agent",
  difficulty: "medium",
  story_points: 3,
  duplicate_of: null,
  summary_es: "No se puede exportar el reporte de tareas",
  description_es: "Falla al exportar.",
  ...extra,
});

/** Hand the channel's reports over, plan them with `extra`, and apply. */
async function file(r: Rig, extra: Record<string, unknown> = {}, minutes = 16) {
  await poll(r.deps(minutes - 1), noCache());
  const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
  r.plans.set(batch.id, { batch: batch.id, entries: batch.reports.map((report) => entry(report.id, extra)) });
  const polled = await poll(r.deps(minutes), noCache());
  return { batch, polled };
}

/** The posts Slack accepted; a refused one never reaches the fake. */
const posts = (r: Rig) => r.slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.params.thread_ts, call.params.text]);

const GROUPED = `${RECEIVED_REPLY} Este reporte incluye también: <${linkOf(ROOTS[1]!)}|mensaje de ${chileTime(ROOTS[1]!)}>, <${linkOf(ROOTS[2]!)}|mensaje de ${chileTime(ROOTS[2]!)}>`;
const FOLLOW_UP = `Agregado al reporte de arriba: <${linkOf(ROOTS[0]!)}|ver reporte>`;

describe("the grouping replies' text", () => {
  it("writes the time in Chile, whatever the host's zone", () => {
    // 2025-10-20 12:02 UTC is 09:02 in Santiago (summer time, UTC-3).
    expect(chileTime(ROOTS[1]!)).toBe("09:02");
    // 2025-07-01 12:00 UTC is 08:00 in Santiago (winter time, UTC-4).
    expect(chileTime("1751371200.000100")).toBe("08:00");
  });

  it("keeps a one-message report's reply plain, and lists the others in Slack's link markup otherwise", () => {
    const message = (ts: string) => ({ ts, user: "U0ANA", text: "x", files: [], reply: false, permalink: linkOf(ts) });
    expect(groupedReply(RECEIVED_REPLY, { roots: [ROOTS[0]!], messages: [message(ROOTS[0]!)] })).toBe(RECEIVED_REPLY);
    expect(groupedReply(RECEIVED_REPLY, { roots: ROOTS, messages: ROOTS.map(message) })).toBe(GROUPED);
    expect(followUpReply(linkOf(ROOTS[0]!))).toBe(FOLLOW_UP);
    for (const text of [GROUPED, FOLLOW_UP]) expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("a live report", () => {
  it("of one message gets the plain reply and nothing else", async () => {
    const r = await rig();
    r.slack.post({ ts: ROOTS[0]!, user: "U0ANA", text: "No puedo exportar el reporte de tareas" });
    await file(r);
    expect(posts(r)).toEqual([[ROOTS[0], RECEIVED_REPLY]]);
  });

  it("joined from three messages lists the other two on the first, and points each of them back at it", async () => {
    const r = await rig();
    postGrouped(r);
    const { batch } = await file(r);
    expect(batch.reports.map((report) => report.roots)).toEqual([ROOTS]);
    expect(posts(r)).toEqual([
      [ROOTS[0], GROUPED],
      [ROOTS[1], FOLLOW_UP],
      [ROOTS[2], FOLLOW_UP],
    ]);
    const store = readClerkStore(r.storePath, CHANNEL).store;
    expect(store.processed[ROOTS[0]!]).toMatchObject({ state: "filed", roots: ROOTS });
    expect(store.processed[ROOTS[0]!]!.pendingFollowUps).toBeUndefined();
    expect(store.processed[ROOTS[0]!]!.line).toContain("grouping replies on 2 follow-up message(s)");
  });

  it("adapts a duplicate's reply the same way", async () => {
    const r = await rig();
    postGrouped(r);
    await file(r, { duplicate_of: "OAI-12", duplicate_confidence: "sure" });
    expect(posts(r)).toEqual([
      [ROOTS[0], GROUPED.replace(RECEIVED_REPLY, "Ya está reportado: OAI-12.")],
      [ROOTS[1], FOLLOW_UP],
      [ROOTS[2], FOLLOW_UP],
    ]);
  });

  it("posts nothing twice, however often it is polled or the same plan applied", async () => {
    const r = await rig();
    postGrouped(r);
    const { batch } = await file(r);
    await poll(r.deps(30), noCache());
    await poll(r.deps(45), noCache());
    // A run that starts with no progress at all, what a kill before any save
    // leaves: every reply is found in its thread and none is posted again.
    const report = batch.reports[0] as BatchReport;
    const decision: Decision = {
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
    };
    const progress: Record<string, Progress> = {};
    const port = intakePort(jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, r.jira.fetch), slackClient("xoxb-fake", r.slack.fetch, CHANNEL), r.rules);
    const [again] = await applyDecisions([decision], [report], {
      rules: r.rules,
      port,
      now: () => at(50),
      progress: (id) => progress[id] ?? {},
      saveProgress: async (id, saved) => {
        progress[id] = saved;
      },
      done: async () => {},
    });
    expect(again!.writes).toEqual([]);
    expect(posts(r)).toHaveLength(3);
  });

  it("keeps a failed follow-up reply as a note and retries it on the next poll, never failing the apply", async () => {
    const r = await rig();
    postGrouped(r);
    r.failing.add(ROOTS[1]!);
    const { polled } = await file(r);
    // Refused by the apply, and again by the same poll's retry after it.
    expect(r.refused).toEqual([ROOTS[1], ROOTS[1]]);
    expect(posts(r)).toEqual([
      [ROOTS[0], GROUPED],
      [ROOTS[2], FOLLOW_UP],
    ]);
    expect(polled.verdict.stop).toBeUndefined();
    expect(polled.verdict.notes?.some((note) => note.includes(`grouping reply on follow-up message ${ROOTS[1]}`))).toBe(true);
    let store = readClerkStore(r.storePath, CHANNEL).store;
    expect(store.failures ?? 0).toBe(0);
    expect(store.batch).toBeNull();
    expect(store.processed[ROOTS[0]!]!.pendingFollowUps).toEqual([ROOTS[1]]);

    // Still failing: a note again, and still kept.
    const failed = await poll(r.deps(20), noCache());
    expect(failed.verdict.notes?.some((note) => note.includes(`grouping reply on follow-up message ${ROOTS[1]}`))).toBe(true);
    expect(readClerkStore(r.storePath, CHANNEL).store.processed[ROOTS[0]!]!.pendingFollowUps).toEqual([ROOTS[1]]);

    r.failing.clear();
    await poll(r.deps(25), noCache());
    store = readClerkStore(r.storePath, CHANNEL).store;
    expect(store.processed[ROOTS[0]!]!.pendingFollowUps).toBeUndefined();
    await poll(r.deps(30), noCache());
    // Refused on every try while failing, posted once, and never again once it is recorded.
    expect(r.refused).toEqual([ROOTS[1], ROOTS[1], ROOTS[1]]);
    expect(posts(r)).toEqual([
      [ROOTS[0], GROUPED],
      [ROOTS[2], FOLLOW_UP],
      [ROOTS[1], FOLLOW_UP],
    ]);
  });

  it("still copies a later reply in a follow-up's thread to the ticket, and never its own grouping reply", async () => {
    const r = await rig();
    postGrouped(r);
    await file(r);
    const key = readClerkStore(r.storePath, CHANNEL).store.processed[ROOTS[0]!]!.key!;
    r.slack.post({ ts: after(T0, 20), thread_ts: ROOTS[2]!, user: "U0BETO", text: "a mí me pasa en Firefox" });
    await poll(r.deps(25), noCache());
    const comments = r.jira.issues.find((issue) => issue.key === key)!.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("Respuesta de Beto en Slack:");
    expect(comments[0]).toContain("a mí me pasa en Firefox");
    expect(comments.some((comment) => comment.includes("Agregado al reporte"))).toBe(false);
  });
});

describe("shadow and quiet", () => {
  for (const mode of ["shadow", "quiet"] as const) {
    it(`${mode} posts nothing in Slack for a grouped report`, async () => {
      const r = await rig(mode);
      postGrouped(r);
      await file(r);
      await poll(r.deps(30), noCache());
      expect(posts(r)).toEqual([]);
      const store = readClerkStore(r.storePath, CHANNEL).store;
      expect(store.processed[ROOTS[0]!]).toMatchObject({ state: "filed" });
      expect(store.processed[ROOTS[0]!]!.pendingFollowUps).toBeUndefined();
      if (mode === "shadow") {
        // The would-be reply is the one shadow always recorded: plain, on the first message only.
        expect(store.shadow.writes.filter((one) => one.write.kind === "reply").map((one) => one.write)).toEqual([{ kind: "reply", thread: ROOTS[0], text: RECEIVED_REPLY }]);
      }
    });
  }
});
