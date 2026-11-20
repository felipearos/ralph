// @vitest-environment node
/**
 * The gate writing the intake snapshot (felipearos/ralph#459) on each canvas
 * rebuild, against the same fakes as `gate-canvas.test.ts`: what the page
 * shows is what the canvas read, the canvas carries the page's link when
 * `clerk.dashboardUrl` is set, and a snapshot that cannot be written is a note
 * — the canvas is still rebuilt and the batch still handed over.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { noCache, poll, runOnce, type PollDeps } from "./gate";
import { intakeSnapshotPath, readIntakeSnapshot } from "./intake-snapshot";
import { jiraClient } from "./jira";
import { slackClient, tsMs } from "./slack";
import { readClerkStore } from "./store";
import type { PullRef } from "./pulls";

const CHANNEL = "C0TESTCHAN1";
const TEST_CANVAS = "F0SHADOWCV1";
const TEAM_CANVAS = "F0TEAMCANV1";
const PAGE = "https://ralph-intake.example.test/p/acme-intake/intake";
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

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  plans: Map<string, unknown>;
  storePath: string;
  deps: (minutes: number) => PollDeps;
}

async function rig(rules: ClerkRules, jira: FakeJira = fakeJira("OA"), clock: (minutes: number) => number = (m) => tsMs(after(T0, m))): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-intake-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { canvases: [TEST_CANVAS, TEAM_CANVAS] });
  const plans = new Map<string, unknown>();
  const deps = (minutes: number): PollDeps => ({
    rules,
    now: () => clock(minutes),
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
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
  await poll(deps(0), noCache());
  return { slack, plans, storePath, deps };
}

describe("the shadow intake snapshot", () => {
  it("holds every would-be ticket with its fields and reporter, marks the canvas's rows, and the canvas links the page", async () => {
    const r = await rig({ ...RULES, dashboardUrl: PAGE });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "Se cae la app al guardar una tarea" });
    expect((await poll(r.deps(12), noCache())).verdict.work).toBe(true);
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        {
          report: batch.reports[0]!.id,
          verdict: "issue",
          type: "Error",
          app: "Backoffice",
          priority: "High",
          duplicate_of: null,
          assignee: "agent",
          difficulty: "hard",
          story_points: 5,
          summary_es: "La app se cae al guardar una tarea",
          description_es: "Al guardar una tarea la app se cierra.",
        },
      ],
    });
    await poll(r.deps(13), noCache());
    await poll(r.deps(12 + RULES.canvasMinutes), noCache());

    const snapshot = readIntakeSnapshot(intakeSnapshotPath(r.storePath))!;
    expect(snapshot).toMatchObject({ v: 1, source: "shadow", mode: "shadow", canvasRowCap: RULES.rowCap });
    expect(snapshot.tickets).toHaveLength(1);
    expect(snapshot.tickets[0]).toMatchObject({
      summary: "La app se cae al guardar una tarea",
      app: "Backoffice",
      type: "Error",
      priority: "High",
      difficulty: "hard",
      storyPoints: 5,
      assignee: "agente",
      stage: "abierto",
      onCanvas: true,
    });
    expect(snapshot.tickets[0]!.reporter).not.toBeNull();
    // The Seguimiento column: the report's own message, then the would-be ticket.
    expect(snapshot.tickets[0]!.trail.map((step) => step.kind)).toEqual(["slack", "intake"]);
    expect(snapshot.tickets[0]!.trail[0]).toMatchObject({ kind: "slack", url: batch.reports[0]!.permalink });

    const canvas = r.slack.canvases.get(TEST_CANVAS)!;
    expect(canvas.split("\n").slice(0, 3)).toEqual(["# Reportes del canal (prueba, modo shadow)", "", `Ver todo el backlog: ${PAGE}`]);
  });

  it("leaves the link line out without clerk.dashboardUrl", async () => {
    const r = await rig(RULES);
    await runOnce(r.deps(5));
    expect(r.slack.canvases.get(TEST_CANVAS)).not.toContain("Ver todo el backlog");
  });

  it("is a note when it cannot be written: the canvas is still rebuilt and the poll still answers", async () => {
    const r = await rig(RULES);
    // A directory where the file goes: the rename fails, every time.
    mkdirSync(intakeSnapshotPath(r.storePath), { recursive: true });
    const { lines, code } = await runOnce(r.deps(5));
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^clerk-gate: intake snapshot not written to .*clara\.intake\.json — /);
    expect(lines).toContain(`clerk-gate: shadow canvas ${TEST_CANVAS} rebuilt (0 would-be tickets)`);
    expect(lines.at(-1)).toBe("clerk-gate: nothing to do — no unfiled report in C0TESTCHAN1");
  });

  it("never keeps a report from being handed over", async () => {
    const r = await rig(RULES);
    mkdirSync(intakeSnapshotPath(r.storePath), { recursive: true });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No carga el listado" });
    const polled = await poll(r.deps(12), noCache());
    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.notes?.some((note) => /intake snapshot not written/.test(note))).toBe(true);
  });
});

describe("the live intake snapshot, from the intake board", () => {
  const LIVE: ClerkRules = { ...RULES, mode: "live", jira: { site: SITE, project: "OA", intakeProject: "OAI" }, dashboardUrl: PAGE };
  const day = 86_400_000;
  const iso = (ms: number): string => new Date(ms).toISOString();

  it("reads each ticket's fields, reporter and stage, keeps a ticket that left the read, and the canvas links the page", async () => {
    const now = Date.now();
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    jira.add({
      key: "OAI-1",
      summary: "No carga el listado",
      status: "Por confirmar",
      priority: "High",
      labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente"],
      created: iso(now - day),
      description: "Al abrir el listado queda en blanco.\n\nReportado por Ana Pérez en Slack: https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100\n\nPuntos de historia sugeridos: 3",
    });
    jira.add({ key: "OAI-2", summary: "Movido al equipo", status: "Movido", statusCategory: "done", priority: "Medium", labels: ["slack-intake", "acme-pwa", "moved-to-jira", "para-persona"], created: iso(now - 2 * day), resolved: iso(now - day), comments: ["Movido a OA: OA-9"] });
    jira.add({ key: "OAI-3", summary: "No es un error", status: "Descartado", statusCategory: "done", priority: "Medium", labels: ["slack-intake"], created: iso(now - 3 * day), resolved: iso(now - day) });
    // The team ticket OAI-2 moved to: its status is read for the Seguimiento column.
    jira.add({ key: "OA-9", summary: "Movido al equipo", status: "En curso", priority: "Medium", labels: [], created: iso(now - day) });
    const r = await rig(LIVE, jira, (minutes) => Date.now() + minutes * 60_000);
    const pr: PullRef = { repo: "example-org/acme-pwa", number: 12, url: "https://github.com/example-org/acme-pwa/pull/12", state: "mergeado", at: iso(now), keys: ["OA-9"] };
    const { lines } = await runOnce({ ...r.deps(5), pulls: async () => ({ pulls: [pr], note: null }) });
    expect(lines.some((line) => /intake snapshot not written/.test(line))).toBe(false);

    const snapshot = readIntakeSnapshot(intakeSnapshotPath(r.storePath))!;
    expect(snapshot).toMatchObject({ source: "jira", mode: "live" });
    const byKey = new Map(snapshot.tickets.map((ticket) => [ticket.key, ticket]));
    expect(byKey.get("OAI-1")).toMatchObject({
      url: `https://${SITE}/browse/OAI-1`,
      app: "Backoffice",
      priority: "High",
      difficulty: "medium",
      storyPoints: 3,
      assignee: "agente",
      status: "Por confirmar",
      reporter: "Ana Pérez",
      stage: "abierto",
      onCanvas: true,
    });
    expect(byKey.get("OAI-2")).toMatchObject({ stage: "movido", assignee: "persona", movedTo: "OA-9", movedToUrl: `https://${SITE}/browse/OA-9` });
    expect(byKey.get("OAI-1")!.trail).toEqual([
      { kind: "slack", url: "https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100", at: iso(now - day), reporter: "Ana Pérez" },
      { kind: "intake", key: "OAI-1", url: `https://${SITE}/browse/OAI-1`, status: "Por confirmar", at: iso(now - day) },
    ]);
    expect(byKey.get("OAI-2")!.trail.slice(1)).toEqual([
      { kind: "intake", key: "OAI-2", url: `https://${SITE}/browse/OAI-2`, status: "Movido", at: iso(now - 2 * day) },
      { kind: "team", key: "OA-9", url: `https://${SITE}/browse/OA-9`, status: "En curso", held: false, at: iso(now - day) },
      { kind: "pr", repo: pr.repo, number: 12, url: pr.url, state: "mergeado", at: pr.at },
    ]);
    expect(byKey.get("OAI-3")).toMatchObject({ stage: "cerrado", status: "Descartado" });
    expect(r.slack.canvases.get(TEAM_CANVAS)!.split("\n").slice(0, 3)).toEqual(["# Reportes del canal", "", `Ver todo el backlog: ${PAGE}`]);

    // Gone from both reads (closed long ago): the page keeps it, in Historial.
    const ticket = jira.issues.find((issue) => issue.key === "OAI-1")!;
    Object.assign(ticket, { status: "Listo", statusCategory: "done", resolved: iso(now - 30 * day) });
    await runOnce(r.deps(5 + LIVE.canvasMinutes));
    const later = readIntakeSnapshot(intakeSnapshotPath(r.storePath))!;
    expect(later.tickets.find((entry) => entry.key === "OAI-1")).toMatchObject({ stage: "cerrado", onCanvas: false, reporter: "Ana Pérez" });
  });

  it("is still written, with notes, when neither GitHub nor the team ticket can be read", async () => {
    const now = Date.now();
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    // Moved to a team ticket that no longer exists: Jira refuses the key, and the search is asked again without it.
    jira.add({ key: "OAI-2", summary: "Movido", status: "Movido", statusCategory: "done", priority: "Medium", labels: ["slack-intake", "moved-to-jira"], created: iso(now - day), resolved: iso(now), comments: ["Movido a OA: OA-404"] });
    const r = await rig(LIVE, jira, (minutes) => Date.now() + minutes * 60_000);
    const { lines } = await runOnce({
      ...r.deps(5),
      pulls: async () => {
        throw new Error("gh is not installed");
      },
    });
    expect(lines).toContainEqual(expect.stringMatching(/intake page: pull requests not read \(gh is not installed\); the page shows none/));
    expect(lines.some((line) => /channel canvas .* rebuilt from the intake board/.test(line))).toBe(true);
    const ticket = readIntakeSnapshot(intakeSnapshotPath(r.storePath))!.tickets.find((entry) => entry.key === "OAI-2")!;
    expect(ticket.trail.map((step) => step.kind)).toEqual(["slack", "intake", "team"]);
    expect(ticket.trail[2]).toMatchObject({ key: "OA-404", status: null });
  });
});
