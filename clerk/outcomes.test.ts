// @vitest-environment node
/**
 * The outcome scan (felipearos/ralph#450): closed intake and moved OA tickets
 * become one `closed` event each, the metrics CLI counts the report as
 * valuable or noise from it, and nothing Jira does makes the scan throw.
 *
 * Against the fake Jira at its HTTP seam, with the store and the ledger on disk.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { report } from "../clerk-metrics";
import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { readOnly } from "./confirm";
import { INTAKE_WORKFLOW, SITE, fakeJira, fakeSlack, type FakeIssue, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { jiraClient } from "./jira";
import { liveThreads } from "./live";
import { appendEvent, readEvents, type ClosedEvent, type MetricsEvent } from "./metrics";
import { MERGE_WAIT_DAYS, OA_BATCH, REPLY_KEEP_DAYS, closedIntakeJql, closedKeysJql, resolvedReply, scanOutcomes, type OutcomesDeps } from "./outcomes";
import type { PullRef, PullsRead } from "./pulls";
import { slackClient } from "./slack";
import type { ConfirmedRecord } from "./store";
import { readClerkStore, withClerkStore } from "./store";

const CHANNEL = "C0TESTCHAN1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode: "live",
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: null,
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI" },
};
const HOUR = 3_600_000;
const NOW = Date.now();
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();
const AGENT_REPORT = "1760961660.000000";
const PERSON_REPORT = "1760961720.000000";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  jira: FakeJira;
  ledgerPath: string;
  storePath: string;
  deps: (over?: Partial<OutcomesDeps>) => OutcomesDeps;
  events: () => MetricsEvent[];
  closed: () => ClosedEvent[];
  store: () => ReturnType<typeof readClerkStore>["store"];
}

/**
 * A clerk that filed OAI-7 (confirmed for an agent) and OAI-8 (confirmed for
 * a person and moved to OA-101), with the ledger the gate and the sweep wrote
 * for both up to there.
 */
async function rig(rules: ClerkRules = RULES, confirmed?: Record<string, ConfirmedRecord>): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-outcomes-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const ledgerPath = join(dir, "clara.metrics.jsonl");
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  await withClerkStore(storePath, CHANNEL, (store) => {
    store.cursor = "1760961600.000000";
    store.processed[AGENT_REPORT] = { state: "filed", key: "OAI-7", at: ago(48) };
    store.processed[PERSON_REPORT] = { state: "filed", key: "OAI-8", at: ago(48) };
    store.confirmed = confirmed ?? {
      "OAI-7": { outcome: "to-agent", at: ago(24), done: true },
      "OAI-8": { outcome: "to-person", at: ago(24), done: true, oaKey: "OA-101" },
    };
  });
  const mode = rules.mode;
  for (const [reportId, key, reporter] of [
    [AGENT_REPORT, "OAI-7", "U0ANA"],
    [PERSON_REPORT, "OAI-8", "U0BETO"],
  ] as const) {
    appendEvent(ledgerPath, { v: 1, at: ago(48), kind: "reported", report: reportId, mode, reporter, channel: CHANNEL, reportedAt: ago(48) });
    appendEvent(ledgerPath, { v: 1, at: ago(48), kind: "classified", report: reportId, key, mode, verdict: "issue", app: "Backoffice" });
    appendEvent(ledgerPath, { v: 1, at: ago(24), kind: "confirmed", report: reportId, key, mode, by: { accountId: "557058:ana" }, latencyMs: HOUR, overrides: [] });
  }
  appendEvent(ledgerPath, { v: 1, at: ago(24), kind: "moved", report: PERSON_REPORT, key: "OAI-8", mode, oaKey: "OA-101" });
  const client = jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch);
  const deps = (over: Partial<OutcomesDeps> = {}): OutcomesDeps => ({
    rules,
    jira: readOnly(client),
    storePath,
    now: () => NOW,
    ledger: (event) => appendEvent(ledgerPath, event),
    ...over,
  });
  const events = (): MetricsEvent[] => readEvents(ledgerPath).events;
  return {
    jira,
    ledgerPath,
    storePath,
    deps,
    events,
    closed: () => events().filter((event): event is ClosedEvent => event.kind === "closed"),
    store: () => readClerkStore(storePath, CHANNEL).store,
  };
}

const intakeTicket = (over: Partial<FakeIssue> = {}): FakeIssue => ({
  key: "OAI-7",
  summary: "No se puede exportar el reporte",
  status: "Confirmado",
  statusCategory: "indeterminate",
  labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente", "ready-for-agent"],
  created: ago(48),
  ...over,
});

const moved = (over: Partial<FakeIssue> = {}): FakeIssue => ({
  key: "OAI-8",
  summary: "Cambiar el texto del correo",
  status: "Movido",
  statusCategory: "done",
  labels: ["slack-intake", "acme-backoffice", "para-persona", "moved-to-jira"],
  created: ago(48),
  resolved: ago(24),
  resolution: "Done",
  ...over,
});

const oaTicket = (over: Partial<FakeIssue> = {}): FakeIssue => ({
  key: "OA-101",
  summary: "Cambiar el texto del correo",
  status: "En curso",
  statusCategory: "indeterminate",
  created: ago(24),
  ...over,
});

const outcomeOfReport = (r: Rig, reporter: string): { valuable: number; noise: number; pending: number } => {
  const row = report(r.ledgerPath, { json: true, by: "reporter" }).rows.find((one) => one.key === reporter)!;
  return { valuable: row.valuable, noise: row.noise, pending: row.pending };
};

describe("the outcome scan's queries", () => {
  it("asks the intake board for closed tickets the sweep did not reject or move", () => {
    expect(closedIntakeJql("OAI", { rejected: "Descartado", moved: "Movido" })).toBe(
      'project = "OAI" AND labels = "slack-intake" AND statusCategory = Done AND status not in ("Descartado", "Movido") AND labels not in ("moved-to-jira") AND updated >= -90d ORDER BY updated DESC',
    );
    expect(closedKeysJql(["OA-101", "OA-102"])).toBe('key in ("OA-101", "OA-102") AND statusCategory = Done');
    expect(closedKeysJql(["OA-101"], ["LISTO PARA QA"])).toBe('key in ("OA-101") AND (statusCategory = Done OR status in ("LISTO PARA QA"))');
  });
});

describe("scanOutcomes", () => {
  it("records a confirmed to-agent ticket closed as Done once, and the metrics CLI counts its report valuable", async () => {
    const r = await rig();
    r.jira.add(intakeTicket());
    r.jira.add(moved());
    r.jira.add(oaTicket());
    expect(await scanOutcomes(r.deps())).toEqual([]);
    expect(r.closed()).toEqual([]);
    expect(outcomeOfReport(r, "U0ANA")).toEqual({ valuable: 0, noise: 0, pending: 1 });

    // The coder loop finished it.
    Object.assign(r.jira.issues.find((one) => one.key === "OAI-7")!, { status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) });
    expect(await scanOutcomes(r.deps())).toEqual(["OAI-7 closed in 'Listo' as 'Done': recorded"]);
    expect(r.closed()).toEqual([
      { v: 1, at: new Date(NOW).toISOString(), kind: "closed", report: AGENT_REPORT, key: "OAI-7", mode: "live", resolution: "Done", status: "Listo" },
    ]);
    expect(outcomeOfReport(r, "U0ANA")).toEqual({ valuable: 1, noise: 0, pending: 0 });

    // A rerun repeats nothing, and the moved intake ticket is never its own close.
    expect(await scanOutcomes(r.deps())).toEqual([]);
    expect(r.closed()).toHaveLength(1);
    expect(r.store().outcomes?.recorded["OAI-7"]).toEqual({ at: new Date(NOW).toISOString(), report: AGENT_REPORT });
  });

  it("leaves another channel's closed ticket to that channel's loop, and still records a hand-filed one", async () => {
    const r = await rig();
    r.jira.add(intakeTicket({ key: "OAI-40", status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1), description: "Reportado por Bea en Slack: https://example.slack.com/archives/C0OTHERCHAN/p1760961990000000" }));
    r.jira.add(oaTicket());
    r.jira.add(intakeTicket({ key: "OAI-41", status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1), description: "Escrito a mano." }));
    expect(await scanOutcomes(r.deps())).toEqual(["OAI-41 closed in 'Listo' as 'Done': recorded"]);
    expect(r.closed().map((event) => event.key)).toEqual(["OAI-41"]);
  });

  it("records the OA ticket a person's report moved to, and a Won't Do close makes that report noise", async () => {
    const r = await rig();
    r.jira.add(moved());
    r.jira.add(oaTicket());
    await scanOutcomes(r.deps());
    expect(r.closed()).toEqual([]);
    expect(r.store().outcomes?.watched["OA-101"]).toMatchObject({ report: PERSON_REPORT, intake: "OAI-8", board: "oa", checkedAt: new Date(NOW).toISOString() });

    Object.assign(r.jira.issues.find((one) => one.key === "OA-101")!, { status: "Listo", statusCategory: "done", resolution: "Won't Do", resolved: ago(1) });
    expect(await scanOutcomes(r.deps())).toEqual(["OA-101 closed in 'Listo' as 'Won't Do': recorded"]);
    expect(r.closed()).toEqual([
      expect.objectContaining({ report: PERSON_REPORT, key: "OAI-8", oaKey: "OA-101", resolution: "Won't Do", status: "Listo" }),
    ]);
    expect(outcomeOfReport(r, "U0BETO")).toEqual({ valuable: 0, noise: 1, pending: 0 });
    expect(r.store().outcomes?.watched["OA-101"]).toBeUndefined();
    await scanOutcomes(r.deps());
    expect(r.closed()).toHaveLength(1);
  });

  it("reads the moved OA tickets in batches by key, the least recently read first", async () => {
    const many = Object.fromEntries(
      Array.from({ length: OA_BATCH + 5 }, (_, at) => [`OAI-${200 + at}`, { outcome: "to-person", at: ago(24), done: true, oaKey: `OA-${300 + at}` } as ConfirmedRecord]),
    );
    const r = await rig(RULES, many);
    for (let at = 0; at < OA_BATCH + 5; at++) r.jira.add(oaTicket({ key: `OA-${300 + at}` }));
    await scanOutcomes(r.deps());
    const searches = r.jira.calls.filter((call) => call.path === "/rest/api/3/search/jql").map((call) => (call.body as { jql: string }).jql);
    expect(searches.filter((jql) => jql.startsWith("key in"))).toHaveLength(2);
    expect(searches.find((jql) => jql.startsWith("key in"))!.match(/"OA-\d+"/g)).toHaveLength(OA_BATCH);
  });

  it("reads key by key when one moved ticket is gone, and asks for it no more", async () => {
    const r = await rig(RULES, {
      "OAI-8": { outcome: "to-person", at: ago(24), done: true, oaKey: "OA-101" },
      "OAI-9": { outcome: "to-person", at: ago(24), done: true, oaKey: "OA-404" },
    });
    r.jira.add(oaTicket({ status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
    const notes = await scanOutcomes(r.deps());
    expect(notes).toEqual(["OA-404 is not on OA any more: its close is not watched for", "OA-101 closed in 'Listo' as 'Done': recorded"]);
    expect(r.closed().map((event) => event.oaKey)).toEqual(["OA-101"]);
    expect(r.store().outcomes?.watched["OA-404"]?.gone).toBe(true);
    const before = r.jira.calls.length;
    await scanOutcomes(r.deps());
    expect(r.jira.calls.slice(before).some((call) => JSON.stringify(call.body).includes("OA-404"))).toBe(false);
  });

  it("makes a Jira read failure a note, never a throw, and records the close on the next scan", async () => {
    for (const status of [503, 401, 429]) {
      const r = await rig();
      r.jira.add(intakeTicket({ status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
      r.jira.add(oaTicket({ status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
      r.jira.fail("/rest/api/3/search/jql", { status }, { always: true });
      const notes = await scanOutcomes(r.deps());
      expect(notes).toEqual([
        expect.stringMatching(/^the intake board OAI could not be searched for closed tickets: .*; tried again at the next poll$/),
        expect.stringMatching(/^OA could not be searched for the moved tickets' closes: .*; tried again at the next poll$/),
      ]);
      expect(r.closed()).toEqual([]);
    }
    const r = await rig();
    r.jira.add(intakeTicket({ status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
    r.jira.fail("/rest/api/3/search/jql", { network: "socket hang up" });
    await scanOutcomes(r.deps());
    expect(r.closed()).toEqual([]);
    await scanOutcomes(r.deps());
    expect(r.closed().map((event) => event.key)).toEqual(["OAI-7"]);
  });

  it("is a note when the store cannot be opened, and a lost ledger line is a note too", async () => {
    const r = await rig();
    expect(await scanOutcomes(r.deps({ storePath: "/dev/null/clara.json" }))).toEqual([expect.stringMatching(/^the outcome scan failed: .*; tried again at the next poll$/)]);
    r.jira.add(intakeTicket({ status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
    const notes = await scanOutcomes(r.deps({ ledger: () => false }));
    expect(notes).toContain("the intake metrics ledger could not be written: 1 event lost");
    // Recorded all the same: a lost line is never written twice.
    expect(r.store().outcomes?.recorded["OAI-7"]).toBeDefined();
  });

  it("runs in shadow without a write, marks its events shadow, and never reads a shadow key", async () => {
    const shadow: ClerkRules = { ...RULES, mode: "shadow" };
    const r = await rig(shadow, { "OAI-8": { outcome: "to-person", at: ago(24), done: true, oaKey: "SHADOW-OAI8" } });
    r.jira.add(intakeTicket({ key: "OAI-30", status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
    await scanOutcomes(r.deps());
    expect(r.jira.writes()).toEqual([]);
    expect(r.closed()).toEqual([expect.objectContaining({ key: "OAI-30", report: "OAI-30", mode: "shadow" })]);
    expect(JSON.stringify(r.jira.calls)).not.toContain("SHADOW-");
  });

  it("does nothing without an intake board", async () => {
    const r = await rig({ ...RULES, jira: { site: SITE, project: "OA" } });
    expect(await scanOutcomes(r.deps())).toEqual([]);
    expect(r.jira.calls).toEqual([]);
  });
});

describe("the resolved reply in the report's thread", () => {
  /** The rig, plus a Slack holding both reports' first messages and the live thread writer onto it. */
  async function withSlack(confirmed?: Record<string, ConfirmedRecord>): Promise<Rig & { slack: FakeSlack; live: (over?: Partial<OutcomesDeps>) => OutcomesDeps; replies: () => { thread: string; text: string }[] }> {
    const r = await rig(RULES, confirmed);
    const slack = fakeSlack(CHANNEL);
    slack.post({ ts: AGENT_REPORT, user: "U0ANA", text: "No se puede exportar el reporte" });
    slack.post({ ts: PERSON_REPORT, user: "U0BETO", text: "Cambien el texto del correo" });
    const threads = liveThreads(slackClient("xoxb-fake", slack.fetch, CHANNEL), RULES);
    return {
      ...r,
      slack,
      live: (over = {}) => r.deps({ threads, ...over }),
      replies: () => slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => ({ thread: call.params.thread_ts!, text: call.params.text! })),
    };
  }

  const done = (r: Rig, key: string, resolution = "Done"): void => {
    Object.assign(r.jira.issues.find((one) => one.key === key)!, { status: "Listo", statusCategory: "done", resolution, resolved: ago(1) });
  };

  it("names the ticket in plain Spanish", () => {
    expect(resolvedReply("OAI-22")).toBe("Resuelto: OAI-22 ya está listo. Gracias por reportarlo.");
  });

  it("tells the reporter once when the work is done, and a rerun posts nothing more", async () => {
    const r = await withSlack();
    r.jira.add(intakeTicket());
    await scanOutcomes(r.live());
    expect(r.replies()).toEqual([]);

    done(r, "OAI-7");
    expect(await scanOutcomes(r.live())).toEqual(["OAI-7 closed in 'Listo' as 'Done': recorded", `OAI-7: told report ${AGENT_REPORT} in its thread that it is resolved`]);
    expect(r.replies()).toEqual([{ thread: AGENT_REPORT, text: "Resuelto: OAI-7 ya está listo. Gracias por reportarlo." }]);
    expect(r.store().outcomes?.replies).toEqual({});

    expect(await scanOutcomes(r.live())).toEqual([]);
    expect(r.replies()).toHaveLength(1);
  });

  it("names the OA key for a report moved to the team's board", async () => {
    const r = await withSlack();
    r.jira.add(moved());
    r.jira.add(oaTicket());
    await scanOutcomes(r.live());
    done(r, "OA-101");
    await scanOutcomes(r.live());
    expect(r.replies()).toEqual([{ thread: PERSON_REPORT, text: "Resuelto: OA-101 ya está listo. Gracias por reportarlo." }]);
  });

  it("posts nothing a second time when a kill left the reply posted and still queued", async () => {
    const r = await withSlack();
    r.jira.add(intakeTicket());
    done(r, "OAI-7");
    await scanOutcomes(r.deps());
    // As a kill between the post and the save leaves it: queued, and in the thread.
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.outcomes!.replies = { "OAI-7": { report: AGENT_REPORT, since: ago(0) } };
    });
    r.slack.post({ ts: "1760961700.000000", thread_ts: AGENT_REPORT, user: "U0CLERKBOT", bot_id: "B0CLERKBOT", text: resolvedReply("OAI-7") });
    expect(await scanOutcomes(r.live())).toEqual([]);
    expect(r.replies()).toEqual([]);
    expect(r.store().outcomes?.replies).toEqual({});
  });

  it("says nothing for a Won't Do close, or for a ticket filed by hand", async () => {
    const r = await withSlack();
    r.jira.add(moved());
    r.jira.add(oaTicket());
    await scanOutcomes(r.live());
    done(r, "OA-101", "Won't Do");
    // Closed straight off the board, with no Slack report behind it.
    r.jira.add(intakeTicket({ key: "OAI-30", status: "Listo", statusCategory: "done", resolution: "Done", resolved: ago(1) }));
    expect(await scanOutcomes(r.live())).toHaveLength(2);
    expect(r.closed().map((event) => event.key).sort()).toEqual(["OAI-30", "OAI-8"]);
    expect(r.replies()).toEqual([]);
    expect(r.store().outcomes?.replies ?? {}).toEqual({});
  });

  it("queues and posts nothing without the live thread writer", async () => {
    const r = await withSlack();
    r.jira.add(intakeTicket());
    done(r, "OAI-7");
    await scanOutcomes(r.deps());
    expect(r.closed()).toHaveLength(1);
    expect(r.store().outcomes?.replies).toBeUndefined();
    // Switched to live later, the old close is told to nobody.
    await scanOutcomes(r.live());
    expect(r.replies()).toEqual([]);
  });

  it("is a note when Slack fails, and the reply goes out on the next poll", async () => {
    const r = await withSlack();
    r.jira.add(intakeTicket());
    done(r, "OAI-7");
    r.slack.fail("chat.postMessage", { error: "not_in_channel" });
    const notes = (await scanOutcomes(r.live())).filter((note) => note.startsWith("OAI-7"));
    expect(notes[0]).toBe("OAI-7 closed in 'Listo' as 'Done': recorded");
    expect(notes[1]).toMatch(new RegExp(`^OAI-7: the resolved reply in report ${AGENT_REPORT}'s thread could not be posted: .*; tried again at the next poll$`));
    expect(r.closed()).toHaveLength(1);
    expect(r.store().outcomes?.replies?.["OAI-7"]).toMatchObject({ report: AGENT_REPORT });

    expect(await scanOutcomes(r.live())).toEqual([`OAI-7: told report ${AGENT_REPORT} in its thread that it is resolved`]);
    expect(r.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
    expect(r.closed()).toHaveLength(1);
  });

  it("still posts a queued reply while Jira is down, and gives up on one past its window", async () => {
    const r = await withSlack();
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.outcomes = {
        recorded: {},
        watched: {},
        replies: {
          "OAI-7": { report: AGENT_REPORT, since: ago(1) },
          "OA-101": { report: PERSON_REPORT, since: ago((REPLY_KEEP_DAYS + 1) * 24) },
        },
      };
    });
    r.jira.fail("/rest/api/3/search/jql", { network: "socket hang up" }, { always: true });
    const notes = await scanOutcomes(r.live());
    expect(notes).toContain(`OAI-7: told report ${AGENT_REPORT} in its thread that it is resolved`);
    expect(notes).toContain(`OA-101: gave up on telling report ${PERSON_REPORT} it is resolved after ${REPLY_KEEP_DAYS} days`);
    expect(r.replies()).toEqual([{ thread: AGENT_REPORT, text: resolvedReply("OAI-7") }]);
    expect(r.store().outcomes?.replies).toEqual({});
  });
  describe("waits for the work to be merged", () => {
    const pull = (over: Partial<PullRef> = {}): PullRef => ({
      repo: "example-org/acme-pwa",
      number: 41,
      url: "https://github.com/example-org/acme-pwa/pull/41",
      state: "abierto",
      at: ago(2),
      keys: ["OAI-7"],
      ...over,
    });
    const reading = (pulls: PullRef[]): OutcomesDeps["pulls"] => async (): Promise<PullsRead> => ({ pulls, note: null });

    it("holds the reply while the PR is open, and posts it once the PR is merged", async () => {
      const r = await withSlack();
      r.jira.add(intakeTicket());
      done(r, "OAI-7");
      expect(await scanOutcomes(r.live({ pulls: reading([pull()]) }))).toContain("OAI-7 closed in 'Listo' as 'Done': recorded");
      expect(r.replies()).toEqual([]);
      expect(r.store().outcomes?.replies?.["OAI-7"]).toMatchObject({ report: AGENT_REPORT });

      expect(await scanOutcomes(r.live({ pulls: reading([pull({ state: "mergeado", at: ago(0) })]) }))).toEqual([
        `OAI-7: told report ${AGENT_REPORT} in its thread that it is resolved`,
      ]);
      expect(r.replies()).toEqual([{ thread: AGENT_REPORT, text: resolvedReply("OAI-7") }]);
      expect(r.store().outcomes?.replies).toEqual({});
    });

    it("counts a merged PR that names the intake key of a report moved to the team's board", async () => {
      const r = await withSlack();
      r.jira.add(moved());
      r.jira.add(oaTicket());
      await scanOutcomes(r.live({ pulls: reading([]) }));
      done(r, "OA-101");
      await scanOutcomes(r.live({ pulls: reading([]) }));
      expect(r.replies()).toEqual([]);
      expect(r.store().outcomes?.replies?.["OA-101"]).toMatchObject({ report: PERSON_REPORT, intake: "OAI-8" });

      await scanOutcomes(r.live({ pulls: reading([pull({ state: "mergeado", keys: ["OAI-8"] })]) }));
      expect(r.replies()).toEqual([{ thread: PERSON_REPORT, text: resolvedReply("OA-101") }]);
    });

    const READY: ClerkRules = { ...RULES, jira: { ...RULES.jira, readyStatuses: ["LISTO PARA QA", "QA"] } };

    it("tells a moved report once its team ticket is ready for QA, with no PR to wait for, and its close tells nobody again", async () => {
      const r = await withSlack();
      r.jira.add(moved());
      r.jira.add(oaTicket());
      // Merged but still in progress on the team's board: not yet.
      const merged = reading([pull({ state: "mergeado", at: ago(0), keys: ["OA-101"] })]);
      await scanOutcomes(r.live({ rules: READY, pulls: merged }));
      expect(r.replies()).toEqual([]);

      Object.assign(r.jira.issues.find((one) => one.key === "OA-101")!, { status: "LISTO PARA QA" });
      expect(await scanOutcomes(r.live({ rules: READY, pulls: reading([]) }))).toEqual([`OA-101: told report ${PERSON_REPORT} in its thread that it is resolved`]);
      expect(r.replies()).toEqual([{ thread: PERSON_REPORT, text: resolvedReply("OA-101") }]);
      expect(r.store().outcomes?.watched["OA-101"]).toMatchObject({ told: true });
      expect(r.closed()).toEqual([]);

      // On to QA, then Done: recorded for the metrics, never told twice.
      Object.assign(r.jira.issues.find((one) => one.key === "OA-101")!, { status: "QA" });
      expect(await scanOutcomes(r.live({ rules: READY, pulls: merged }))).toEqual([]);
      done(r, "OA-101");
      expect(await scanOutcomes(r.live({ rules: READY, pulls: merged }))).toEqual(["OA-101 closed in 'Listo' as 'Done': recorded"]);
      expect(r.closed().map((event) => event.oaKey)).toEqual(["OA-101"]);
      expect(r.replies()).toHaveLength(1);
      expect(r.store().outcomes?.replies).toEqual({});
    });

    it("tells nobody at a ready status without readyStatuses, or without the live thread writer", async () => {
      const r = await withSlack();
      r.jira.add(moved());
      r.jira.add(oaTicket({ status: "LISTO PARA QA" }));
      await scanOutcomes(r.live({ pulls: reading([]) }));
      await scanOutcomes(r.deps({ rules: READY }));
      expect(r.replies()).toEqual([]);
      expect(r.store().outcomes?.watched["OA-101"]?.told).toBeUndefined();
    });

    it("does not count a PR closed unmerged, and gives up after its wait", async () => {
      const r = await withSlack();
      await withClerkStore(r.storePath, CHANNEL, (store) => {
        store.outcomes = {
          recorded: {},
          watched: {},
          replies: {
            "OAI-7": { report: AGENT_REPORT, since: ago((REPLY_KEEP_DAYS + 1) * 24) },
            "OAI-9": { report: PERSON_REPORT, since: ago((MERGE_WAIT_DAYS + 1) * 24) },
          },
        };
      });
      const notes = await scanOutcomes(r.live({ pulls: reading([pull({ state: "cerrado" }), pull({ number: 42, state: "cerrado", keys: ["OAI-9"] })]) }));
      expect(notes.filter((note) => note.startsWith("OAI-"))).toEqual([`OAI-9: gave up on telling report ${PERSON_REPORT} it is resolved: no merged PR named it in ${MERGE_WAIT_DAYS} days`]);
      expect(r.replies()).toEqual([]);
      // Closed a week ago and merged just now: its week runs from the merge.
      expect(Object.keys(r.store().outcomes?.replies ?? {})).toEqual(["OAI-7"]);
      await scanOutcomes(r.live({ pulls: reading([pull({ state: "mergeado", at: ago(1) })]) }));
      expect(r.replies()).toEqual([{ thread: AGENT_REPORT, text: resolvedReply("OAI-7") }]);
    });

    it("keeps the reply waiting, with a note, when the PRs cannot be read", async () => {
      const r = await withSlack();
      r.jira.add(intakeTicket());
      done(r, "OAI-7");
      const notes = await scanOutcomes(
        r.live({
          pulls: async () => {
            throw new Error("gh: rate limited");
          },
        }),
      );
      expect(notes).toContain("the resolved replies wait: pull requests not read — gh: rate limited; tried again at the next poll");
      expect(r.replies()).toEqual([]);
      expect(r.store().outcomes?.replies?.["OAI-7"]).toMatchObject({ report: AGENT_REPORT });
    });
  });
});
