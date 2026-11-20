// @vitest-environment node
/**
 * One clerk iteration in shadow, through the gate (felipearos/ralph#318):
 * the batch handed over with its candidates, the plan the session wrote
 * validated, handed back once if it is refused, filed unclassified if it is
 * refused twice, and applied in shadow with no Jira or Slack write at all.
 *
 * In-process against a fake Slack and a fake Jira at the HTTP seam, whose
 * intake board the candidates are read from (felipearos/ralph#447), as
 * `clerk/gate-poll.test.ts` drives the gate's reading. The session is the test:
 * it writes the plan the model would have.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { batchView } from "./batch";
import { after, fakeJira, fakeSlack, INTAKE_WORKFLOW, SITE, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import type { MetricsEvent } from "./metrics";
import { noCache, poll, type Denial, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import { slackClient, tsMs } from "./slack";
import { markProcessed, readClerkStore, withClerkStore } from "./store";

const CHANNEL = "C0TESTCHAN1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: "F0SHADOWCV1",
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI" },
};
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));
const DAY = 86_400_000;

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  plans: Map<string, unknown>;
  journal: { batch: string; entry: string }[];
  stops: Denial[];
  storePath: string;
  deps: (minutes: number, rules?: ClerkRules) => PollDeps;
  store: () => ReturnType<typeof readClerkStore>["store"];
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-apply-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { canvases: [RULES.shadowCanvas!] });
  // Handed to the shadow gate on purpose: the port, not the credential's
  // absence, is what keeps a shadow apply from filing.
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  jira.add({ key: "OAI-12", summary: "No se puede exportar el reporte de checklists", labels: ["slack-intake", "acme-backoffice"], status: "Por confirmar" });
  // `resolved` keeps it inside the fake's search window, which reads the real
  // clock; `doneAt` is the close the gate's T0 clock measures the window by.
  jira.add({ key: "OAI-7", summary: "La sincronización de tareas falla", labels: ["slack-intake", "acme-pwa"], status: "Listo", statusCategory: "done", resolved: new Date().toISOString(), doneAt: new Date(tsMs(T0) - 5 * DAY).toISOString() });
  const plans = new Map<string, unknown>();
  const journal: { batch: string; entry: string }[] = [];
  const stops: Denial[] = [];
  const deps = (minutes: number, rules = RULES): PollDeps => ({
    rules,
    now: () => at(minutes),
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    intervalSeconds: 300,
    readPlan: (batch) => plans.get(batch),
    journal: (batch, entry) => journal.push({ batch, entry }),
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: (denial) => {
      stops.push(denial);
      return true;
    },
  });
  await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
  return { slack, jira, plans, journal, stops, storePath, deps, store: () => readClerkStore(storePath, CHANNEL).store };
}

/**
 * Writes Slack would have taken: anything but the reads the gate makes and the
 * rebuild of the configured shadow canvas, the one write shadow makes
 * (felipearos/ralph#319, asserted on its own in `clerk/gate-canvas.test.ts`).
 */
const slackWrites = (slack: FakeSlack) =>
  slack.calls.filter(
    (call) =>
      !["auth.test", "conversations.history", "conversations.replies", "users.info"].includes(call.method) &&
      !(call.method === "canvases.edit" && call.params.canvas_id === RULES.shadowCanvas),
  );

describe("handing a batch over with its candidates", () => {
  it("offers the open and recently closed intake tickets, and names the reporter", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    const handed = await poll(r.deps(15), noCache());
    expect(handed.verdict.work).toBe(true);
    const [report] = r.store().batch!.reports;
    expect(report!.candidates.map((candidate) => candidate.key)).toEqual(["OAI-12", "OAI-7"]);
    expect(report!.authorName).toBe("U0ANA");
    // Read, never written.
    expect(r.jira.writes()).toEqual([]);
  });

  it("hands nothing over live while the board cannot be read, rather than a batch without candidates", async () => {
    const r = await rig();
    const live: ClerkRules = { ...RULES, mode: "live" };
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No sincroniza" });
    r.jira.fail("/rest/api/3/search/jql", { status: 503 });
    const polled = await poll(r.deps(15, live), noCache());
    expect(polled.verdict).toMatchObject({ work: false, waitSeconds: 300 });
    expect(r.store().batch).toBeNull();
    expect((await poll(r.deps(20, live), polled.cached)).verdict.work).toBe(true);
  });

  it("hands a shadow batch over with no candidates while the board cannot be read, and says so", async () => {
    // Shadow writes nothing real: a Jira outage, or a revoked token, must not
    // stall a shadow run all night for want of a dedupe it can go without.
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No sincroniza" });
    r.jira.fail("/rest/api/3/search/jql", { status: 401 });
    const polled = await poll(r.deps(15), noCache());
    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.notes?.join("\n")).toMatch(/the Jira intake board could not be read for duplicate candidates \(.*\): this batch is offered none/);
    expect(r.store().batch!.reports[0]!.candidates).toEqual([]);
  });

  it("hands a shadow batch over with no candidates when it holds no Jira credential", async () => {
    // Shadow writes nothing real, so a missing dedupe there costs nothing;
    // holding every report back for want of one would stall the shadow run.
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    const polled = await poll({ ...r.deps(15), jira: null }, noCache());
    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.notes).toContain("no RALPH_CLERK_JIRA_TOKEN: this batch is offered no duplicate candidates");
    expect(r.store().batch!.reports[0]!.candidates).toEqual([]);
  });

  it("keeps a shadow clerk with no intake board working: no candidates, and nothing filed anywhere", async () => {
    const r = await rig();
    const bare: ClerkRules = { ...RULES, jira: { site: SITE, project: "OA" } };
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    const polled = await poll({ ...r.deps(15, bare), jira: null }, noCache());
    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.notes).toContain("no 'clerk.jira.intakeProject': this shadow batch is offered no duplicate candidates");
    const batch = r.store().batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [{ report: batch.reports[0]!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: null, assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" }],
    });
    await poll({ ...r.deps(16, bare), jira: null }, noCache());
    expect(r.store().batch).toBeNull();
    expect(r.store().shadow.writes.map((entry) => entry.write.kind)).toEqual(["create", "reply"]);
    expect(r.jira.calls).toEqual([]);
    expect(slackWrites(r.slack)).toEqual([]);
  });
});

describe("a shadow iteration", () => {
  it("applies a valid plan with zero Jira or Slack writes, recording what it would have written", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists, se cae todo" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "Gracias por la ayuda!" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    const [exportReport, thanks] = batch.reports;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        { report: exportReport!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: "OAI-12", duplicate_confidence: "sure", assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" },
        { report: thanks!.id, verdict: "ignore", ignore_reason: "agradecimiento, no es un reporte" },
      ],
    });
    const applied = await poll(r.deps(16), noCache());
    expect(applied.verdict.work).toBe(false);
    expect(r.jira.writes()).toEqual([]);
    expect(slackWrites(r.slack)).toEqual([]);
    const store = r.store();
    expect(store.batch).toBeNull();
    expect(store.processed[exportReport!.id]).toMatchObject({ state: "commented", key: "OAI-12" });
    expect(store.processed[thanks!.id]).toMatchObject({ state: "ignored", key: null });
    expect(store.shadow.writes.map((entry) => [entry.report, entry.write.kind])).toEqual([
      [exportReport!.id, "comment"],
      [exportReport!.id, "reply"],
    ]);
    expect(store.shadow.writes[1]!.write).toMatchObject({ text: "Ya está reportado: OAI-12." });
    // The journal names every report: the would-be writes, and the ignored one with its reason.
    expect(r.journal).toHaveLength(1);
    expect(r.journal[0]!.entry).toContain(`# Clerk: ${batch.id} (shadow)`);
    expect(r.journal[0]!.entry).toContain(`${exportReport!.permalink} — duplicate of OAI-12: comment and thread reply "Ya está reportado: OAI-12." (shadow: not written)`);
    expect(r.journal[0]!.entry).toContain(`${thanks!.permalink} — ignored: agradecimiento, no es un reporte`);
    // And the cursor has passed both.
    expect(store.cursor).toBe(after(T0, 2));
  });

  it("hands a refused plan back once with its problems, then files every report unclassified", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No funciona el login" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const id = r.store().batch!.id;
    r.plans.set(id, { batch: id, entries: [{ report: r.store().batch!.reports[0]!.id, verdict: "bug" }] });

    const retried = await poll(r.deps(16), noCache());
    expect(retried.verdict.work).toBe(true);
    expect(retried.verdict.why).toContain("attempt 2");
    expect(retried.verdict.why).toContain("the last plan was refused");
    expect(r.store().batch!.problems).toEqual([expect.stringContaining('verdict must be one of issue, decision, ignore; got "bug"')]);

    // The second session's plan is refused too.
    r.plans.set(id, { batch: id, entries: [{ report: r.store().batch!.reports[0]!.id, verdict: "issue", type: "Error" }] });
    expect((await poll(r.deps(17), noCache())).verdict.work).toBe(false);
    const tickets = Object.values(r.store().shadow.tickets);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ type: "Tarea", priority: "Sin Prioridad", labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona", "intake-sin-clasificar"] });
    expect(r.journal[0]!.entry).toContain("no valid plan, so every report was filed unclassified");
    expect(r.jira.writes()).toEqual([]);
  });

  it("hands a batch back without spending its retry when no session wrote a plan at all", async () => {
    // A pause, a restart or a runner outage between the hand-over and the turn
    // refuses nothing; only a plan that was written and is wrong does.
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No funciona el login" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const missed = await poll(r.deps(16), noCache());
    expect(missed.verdict.why).toContain("no plan was written; handed over again");
    expect(r.store().batch).toMatchObject({ attempt: 1, misses: 1 });
    // And it is bounded: a batch no session ever plans for still ends, filed unclassified.
    for (let minute = 17; r.store().batch !== null && minute < 40; minute += 1) await poll(r.deps(minute), noCache());
    expect(r.store().batch).toBeNull();
    expect(Object.values(r.store().shadow.tickets)[0]).toMatchObject({ labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona", "intake-sin-clasificar"] });
  });

  it("files a batch changed on disk after the hand-over unclassified, and says so", async () => {
    const r = await rig();
    const alerts: string[] = [];
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    // A session steered by a message adds a candidate it wants a report merged into.
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      store.batch!.reports[0]!.candidates.push({ key: "OAI-1", summary: "x", status: "Todo", closed: null, labels: ["slack-intake"], jiraKey: null });
    });
    const id = r.store().batch!.id;
    r.plans.set(id, { batch: id, entries: [{ report: r.store().batch!.reports[0]!.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: "OAI-1", duplicate_confidence: "sure", assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" }] });
    await poll({ ...r.deps(16), alert: (alert) => alerts.push(alert.subject) }, noCache());
    expect(alerts).toEqual(["The clerk's handed batch was changed on disk"]);
    expect(r.store().shadow.writes.map((entry) => entry.write.kind)).toEqual(["create", "reply"]);
    expect(Object.values(r.store().shadow.tickets)[0]).toMatchObject({ labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona", "intake-sin-clasificar"] });
  });

  it("advances the cursor report by report, so a stop halfway resumes where it stopped", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "uno" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "dos" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    // What a gate killed after its first report leaves behind.
    await withClerkStore(r.storePath, CHANNEL, (store) => markProcessed(store, batch.reports[0]!.id, { state: "ignored", key: null, at: "x" }));
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: batch.reports.map((report) => ({ report: report.id, verdict: "ignore", ignore_reason: "prueba" })),
    });
    await poll(r.deps(16), noCache());
    // Only the second was applied this time; the journal still names both,
    // the first as the earlier poll left it.
    expect(r.journal[0]!.entry).toContain(`${batch.reports[0]!.permalink} — processed`);
    expect(r.journal[0]!.entry).toContain(`${batch.reports[1]!.permalink} — ignored: prueba`);
    expect(r.store().cursor).toBe(after(T0, 2));
  });

  it("folds a report into the ticket an earlier report of its batch became, also after a stop halfway", async () => {
    const r = await rig();
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "La sucursal aparece en México" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "Me sale la sucursal en México" });
    expect((await poll(r.deps(15), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    const [first, again] = batch.reports;
    // The batch tool offers the earlier one, which the board could not.
    expect((batchView(batch).reports as { earlierReports: string[] }[]).map((one) => one.earlierReports)).toEqual([[], [first!.id]]);
    // What a gate killed after its first report leaves behind.
    await withClerkStore(r.storePath, CHANNEL, (store) => markProcessed(store, first!.id, { state: "filed", key: "OAI-40", at: "x" }));
    const entry = (id: string, extra: Record<string, unknown> = {}) => ({
      report: id,
      verdict: "issue",
      type: "Error",
      app: "Backoffice",
      priority: "Medium",
      assignee: "agent",
      difficulty: "medium",
      story_points: 3,
      summary_es: "La sucursal aparece en México",
      description_es: "y",
      ...extra,
    });
    r.plans.set(batch.id, { batch: batch.id, entries: [entry(first!.id), entry(again!.id, { duplicate_of: first!.id, duplicate_confidence: "sure" })] });
    await poll(r.deps(16), noCache());
    const store = r.store();
    expect(store.processed[again!.id]).toMatchObject({ state: "commented", key: "OAI-40" });
    expect(store.shadow.writes.map((one) => [one.report, one.write.kind])).toEqual([
      [again!.id, "comment"],
      [again!.id, "reply"],
    ]);
    expect(store.shadow.writes[1]!.write).toMatchObject({ text: `Ya está reportado: OAI-40 (<${first!.permalink}|reporte original>).` });
  });
});

describe("an iteration on the Jira intake board (felipearos/ralph#447)", () => {
  const POINTS = "customfield_10016";
  const INTAKE: ClerkRules = { ...RULES, jira: { ...RULES.jira, storyPointsField: POINTS } };
  const LIVE: ClerkRules = { ...INTAKE, mode: "live" };

  /** A clerk on the board, handed one batch of two reports — a bug and a thank-you — with the plan a session wrote. */
  async function handed(rules: ClerkRules, ledger: (event: MetricsEvent) => boolean) {
    const r = await rig();
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    jira.add({ key: "OAI-12", summary: "No se puede exportar el reporte de checklists", labels: ["slack-intake", "acme-backoffice"], status: "Por confirmar" });
    const deps = (minutes: number): PollDeps => ({
      ...r.deps(minutes, rules),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
      ledger,
    });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No sincroniza la app" });
    r.slack.post({ ts: after(T0, 2), user: "U0BETO", text: "Gracias por la ayuda!" });
    expect((await poll(deps(15), noCache())).verdict.work).toBe(true);
    const batch = r.store().batch!;
    const [bug, thanks] = batch.reports;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        { report: bug!.id, verdict: "issue", type: "Error", app: "pwa", priority: "Medium", duplicate_of: null, assignee: "person", difficulty: "easy", story_points: 2, summary_es: "No sincroniza", description_es: "La app no sincroniza." },
        { report: thanks!.id, verdict: "ignore", ignore_reason: "agradecimiento" },
      ],
    });
    return { r, jira, deps, bug: bug!, thanks: thanks! };
  }

  it("hands clerk.pwaAgents to the validator: a pwa agent report goes to a person unless an agent project works pwa", async () => {
    for (const [pwaAgents, assignee] of [[undefined, "person"], [false, "person"], [true, "agent"]] as const) {
      const rules: ClerkRules = pwaAgents === undefined ? INTAKE : { ...INTAKE, pwaAgents };
      const { r, deps, bug, thanks } = await handed(rules, () => true);
      const batch = r.store().batch!;
      r.plans.set(batch.id, {
        batch: batch.id,
        entries: [
          { report: bug.id, verdict: "issue", type: "Error", app: "pwa", priority: "Medium", duplicate_of: null, assignee: "agent", difficulty: "easy", story_points: 2, summary_es: "No sincroniza", description_es: "La app no sincroniza." },
          { report: thanks.id, verdict: "ignore", ignore_reason: "agradecimiento" },
        ],
      });
      await poll(deps(16), noCache());
      const key = r.store().processed[bug.id]!.key!;
      expect(r.store().determinations?.[key]?.assignee, `pwaAgents ${pwaAgents}`).toBe(assignee);
    }
  });

  it("in shadow writes nothing to Jira or Slack, and still records the ledger, marked shadow", async () => {
    const events: MetricsEvent[] = [];
    const { r, jira, deps, bug, thanks } = await handed(INTAKE, (event) => events.push(event) > 0);
    const applied = await poll(deps(16), noCache());
    expect(applied.verdict.work).toBe(false);
    expect(jira.writes()).toEqual([]);
    expect(slackWrites(r.slack)).toEqual([]);
    const key = r.store().processed[bug.id]!.key!;
    expect(key).toMatch(/^SHADOW-/);
    expect(events.map((event) => [event.kind, event.report, event.mode])).toEqual([
      ["reported", bug.id, "shadow"],
      ["classified", bug.id, "shadow"],
      ["reported", thanks.id, "shadow"],
      ["ignored", thanks.id, "shadow"],
    ]);
    expect(events[1]).toMatchObject({ key, verdict: "issue", type: "Error", app: "pwa", priority: "Medium", assigneeKind: "person", difficulty: "easy", storyPoints: 2, summary: "No sincroniza", description: "La app no sincroniza." });
    expect(events[0]).toMatchObject({ reporter: "U0ANA", channel: CHANNEL, reportedAt: new Date(tsMs(after(T0, 1))).toISOString() });
    expect(events[3]).toMatchObject({ reason: "agradecimiento" });
    expect(r.store().determinations?.[key]).toMatchObject({ type: "Error", priority: "Medium", app: "pwa", assignee: "person", difficulty: "easy", storyPoints: 2 });
  });

  it("live files on the board, records the ledger marked live, and says when Jira refused the points", async () => {
    const events: MetricsEvent[] = [];
    const { r, jira, deps, bug } = await handed(LIVE, (event) => events.push(event) > 0);
    jira.refuseField(POINTS);
    const applied = await poll(deps(16), noCache());
    expect(applied.verdict.work).toBe(false);
    const key = r.store().processed[bug.id]!.key!;
    const ticket = jira.issues.find((issue) => issue.key === key)!;
    expect(ticket).toMatchObject({ status: "Por confirmar", labels: ["slack-intake", "acme-pwa", "difficulty:easy", "para-persona"], custom: {} });
    expect(ticket.description).toContain("Puntos de historia sugeridos: 2");
    expect(applied.verdict.notes).toContain(`${key} filed without story points in ${POINTS}: Jira refused the field, so they are only in the description ("Puntos de historia sugeridos")`);
    expect(events.map((event) => `${event.kind} ${event.mode}`)).toEqual(["reported live", "classified live", "reported live", "ignored live"]);
  });

  it("a duplicate is a duplicate event, and a ledger that cannot be written is a note, never a failure", async () => {
    const { r, deps, bug, thanks } = await handed(INTAKE, () => false);
    const batch = r.store().batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        { report: bug.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: "OAI-12", duplicate_confidence: "sure", assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" },
        { report: thanks.id, verdict: "ignore", ignore_reason: "agradecimiento" },
      ],
    });
    const applied = await poll(deps(16), noCache());
    expect(applied.verdict.work).toBe(false);
    expect(applied.verdict.stop).toBeUndefined();
    expect(r.store().processed[bug.id]).toMatchObject({ state: "commented", key: "OAI-12" });
    expect(applied.verdict.notes).toContain("the intake metrics ledger could not be written: 4 events lost");

    const events: MetricsEvent[] = [];
    const again = await handed(INTAKE, (event) => events.push(event) > 0);
    const second = again.r.store().batch!;
    again.r.plans.set(second.id, {
      batch: second.id,
      entries: [
        { report: again.bug.id, verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate_of: "OAI-12", duplicate_confidence: "sure", assignee: "agent", difficulty: "medium", story_points: 3, summary_es: "x", description_es: "y" },
        { report: again.thanks.id, verdict: "ignore", ignore_reason: "agradecimiento" },
      ],
    });
    await poll(again.deps(16), noCache());
    expect(events[1]).toMatchObject({ kind: "duplicate", of: "OAI-12", key: "OAI-12", mode: "shadow" });
  });
});
