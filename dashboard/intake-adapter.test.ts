// @vitest-environment node
/**
 * The intake adapter (felipearos/ralph#459): the real `clerk-intake.ts` run
 * against a scratch intake project, its narrowing, its cache, and a CLI that
 * cannot run being an unavailable view instead of a throw. Then the local
 * route over it: GET only, and the session always `local`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import { createIntakeAdapter, emptyIntake, emptyMetrics, INTAKE_CACHE_MS, narrowIntake, narrowMetrics, type IntakeAdapter } from "./intake-adapter";
import { handleIntakeRoute } from "./intake-routes";
import { createRecordingExecutor, type RecordingExecutor } from "./recording-executor";

subprocessSuite("bun clerk-intake.ts");

const HARNESS = join(import.meta.dirname, "..");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ralph-intake-adapter-")));
  scratch.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, ".ralph"));
  copyFileSync(join(HARNESS, "fixtures", "clerk", ".ralph", "config.json"), join(repo, ".ralph", "config.json"));
  return repo;
}

describe("the intake adapter over the real CLI", () => {
  it("reads an unpublished project as unavailable, and its empty ledger as empty metrics", async () => {
    const adapter = createIntakeAdapter({ cliDir: HARNESS, bunPath: BUN, project: { root: project() } });
    const tickets = await adapter.tickets();
    expect(tickets).toMatchObject({ v: 1, available: false, loop: "clara", tickets: [] });
    expect(tickets.reason).toMatch(/todavía no ha publicado/);
    const metrics = await adapter.metrics();
    expect(metrics).toMatchObject({ v: 1, available: true, loop: "clara", byReporter: [], byApp: [], byWeek: [], participation: [] });
  });

  it("is an unavailable view, not a throw, when the CLI cannot run", async () => {
    const adapter = createIntakeAdapter({ cliDir: HARNESS, bunPath: join(HARNESS, "no-such-bun"), project: { root: project() } });
    expect(await adapter.tickets()).toMatchObject({ available: false });
    expect((await adapter.tickets()).reason).toMatch(/No se pudo leer el clerk/);
  });
});

describe("the intake adapter over an injected executor", () => {
  const TICKETS = ["/h/clerk-intake.ts", "--json"];
  const METRICS = ["/h/clerk-intake.ts", "--metrics", "--json"];
  const intakeOf = (recorder: RecordingExecutor, now: () => number = () => 0) =>
    createIntakeAdapter({ cliDir: "/h", bunPath: "/bin/bun", project: { root: "/w/clara" }, exec: recorder.exec, now });
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });

  it("reads the tickets and the metrics through `bun clerk-intake.ts`", async () => {
    const recorder = createRecordingExecutor()
      .on({ args: METRICS }, ok({ v: 1, available: true, loop: "clara", generatedAt: "2026-11-03T00:00:00.000Z", byReporter: [{ key: "ana", reports: 2 }] }))
      .on({ args: TICKETS }, ok({ v: 1, available: true, loop: "clara", source: "jira", mode: "live", tickets: [{ key: "OAI-1", url: "https://x/OAI-1", summary: "S", stage: "abierto" }] }));
    const adapter = intakeOf(recorder);
    const tickets = await adapter.tickets();
    expect(tickets).toMatchObject({ available: true, loop: "clara", source: "jira", mode: "live" });
    expect(tickets.tickets.map((ticket) => ticket.key)).toEqual(["OAI-1"]);
    const metrics = await adapter.metrics();
    expect(metrics).toMatchObject({ available: true, loop: "clara", generatedAt: "2026-11-03T00:00:00.000Z" });
    expect(metrics.byReporter).toEqual([expect.objectContaining({ key: "ana", reports: 2 })]);
    expect(recorder.calls.map((call) => call.invocation.args)).toEqual([TICKETS, METRICS]);
    for (const { invocation } of recorder.calls) {
      expect(invocation).toMatchObject({ command: "/bin/bun", cwd: "/h", timeoutMs: 20_000 });
      expect(invocation.env.RALPH_PROJECT).toBe("/w/clara");
    }
  });

  it("is an unavailable view with the reason when the CLI exits non-zero", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/clerk-intake.ts"] }, { status: 1, stdout: "", stderr: "sin config\n" });
    const adapter = intakeOf(recorder, () => Date.parse("2026-11-03T00:00:00.000Z"));
    expect(await adapter.tickets()).toEqual(emptyIntake("No se pudo leer el clerk: sin config"));
    const metrics = await adapter.metrics();
    expect(metrics).toEqual(emptyMetrics("No se pudo leer el clerk: sin config", Date.parse("2026-11-03T00:00:00.000Z")));
  });

  it("is an unavailable view when the CLI does not print JSON", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/clerk-intake.ts"] }, { status: 0, stdout: "hola", stderr: "" });
    const adapter = intakeOf(recorder);
    expect(await adapter.tickets()).toMatchObject({ available: false, reason: "clerk-intake.ts no imprimió JSON." });
    expect(await adapter.metrics()).toMatchObject({ available: false, reason: "clerk-intake.ts no imprimió JSON." });
  });

  it("shares one run between overlapping reads", async () => {
    const recorder = createRecordingExecutor().on({ args: TICKETS }, ok({ v: 1, available: false, reason: "Sin datos." }));
    const adapter = intakeOf(recorder);
    const [first, second] = await Promise.all([adapter.tickets(), adapter.tickets()]);
    expect(second).toEqual(first);
    expect(recorder.calls).toHaveLength(1);
  });

  it("keeps a failed read for the window too", async () => {
    let now = 0;
    const recorder = createRecordingExecutor().on({ args: METRICS }, { status: 1, stdout: "", stderr: "caído" });
    const adapter = intakeOf(recorder, () => now);
    const first = await adapter.metrics();
    now = INTAKE_CACHE_MS - 1;
    expect(await adapter.metrics()).toEqual(first);
    expect(recorder.calls).toHaveLength(1);
  });

  it("asks the CLI once per cache window", async () => {
    let now = 0;
    const recorder = createRecordingExecutor().on({ args: TICKETS }, ok({ v: 1, available: false, reason: "Sin datos." }));
    const adapter = intakeOf(recorder, () => now);
    await adapter.tickets();
    now = INTAKE_CACHE_MS - 1;
    await adapter.tickets();
    expect(recorder.calls).toHaveLength(1);
    now = INTAKE_CACHE_MS;
    await adapter.tickets();
    expect(recorder.calls).toHaveLength(2);
  });
});

describe("narrowing", () => {
  const ticket = { key: "OAI-1", url: "https://x/OAI-1", summary: "Resumen", stage: "abierto", status: "Todo", assignee: "robot", storyPoints: "3", extra: 1 };

  it("drops unknown fields and values, and a ticket with no key", () => {
    const view = narrowIntake({ v: 1, available: true, loop: "clara", source: "jira", mode: "live", canvasRowCap: 32, tickets: [ticket, { summary: "sin clave" }] });
    expect(view.tickets).toEqual([
      expect.objectContaining({ key: "OAI-1", assignee: null, storyPoints: null, onCanvas: false, reports: 1 }),
    ]);
    expect(view.tickets[0]).not.toHaveProperty("extra");
  });

  it("keeps the page's title and its https shortcuts, and drops any other", () => {
    const links = [
      { group: "GitHub", label: "acme-pwa", url: "https://github.com/example-org/acme-pwa" },
      { group: "Jira", label: "x", url: "javascript:alert(1)" },
      { group: "Slack", label: "y", url: "https://example.slack.com" },
    ];
    const view = narrowIntake({ v: 1, available: true, title: "Acme intake", links, tickets: [] });
    expect(view.title).toBe("Acme intake");
    expect(view.links).toEqual([links[0]]);
    expect(narrowIntake({ v: 1, available: true, tickets: [] })).toMatchObject({ title: null, links: [] });
  });

  it("keeps each stage of a ticket's trail, drops one it cannot read, and keeps only https links", () => {
    const trail = [
      { kind: "slack", url: "https://example.slack.com/archives/C0/p1", at: "2026-10-22T19:04:00.000Z", reporter: "Ana" },
      { kind: "intake", key: "OAI-1", url: "https://example.atlassian.net/browse/OAI-1", status: "Movido", at: null },
      { kind: "team", key: null, url: null, status: null, held: true, at: null },
      { kind: "pr", repo: "example-org/acme-pwa", number: 12, url: "https://github.com/example-org/acme-pwa/pull/12", state: "mergeado", at: null },
      { kind: "pr", repo: "example-org/acme-pwa", number: 13, url: "https://github.com/example-org/acme-pwa/pull/13", state: "borrador", at: null },
    ];
    const junk = [
      { kind: "slack", url: "javascript:alert(1)", at: null, reporter: null },
      { kind: "pr", repo: "x/y", number: 1, url: "javascript:alert(1)", state: "mergeado" },
      { kind: "pr", repo: "x/y", number: 2, url: "https://github.com/x/y/pull/2", state: "merged" },
      { kind: "intake" },
      { kind: "elsewhere" },
      "texto",
    ];
    const [read, old] = narrowIntake({ v: 1, available: true, tickets: [{ ...ticket, trail: [...trail, ...junk] }, { ...ticket, key: "OAI-2" }] }).tickets;
    expect(read!.trail).toEqual([...trail, { kind: "slack", url: null, at: null, reporter: null }]);
    // A snapshot written before the trail: the ticket is kept, with none.
    expect(old!.trail).toEqual([]);
  });

  it("keeps quiet as a mode, and the ledger's reports per mode (#443)", () => {
    expect(narrowIntake({ v: 1, available: true, source: "jira", mode: "quiet", tickets: [] }).mode).toBe("quiet");
    expect(narrowIntake({ v: 1, available: true, source: "jira", mode: "dry", tickets: [] }).mode).toBeNull();
    expect(narrowMetrics({ v: 1, available: true, modes: { quiet: 3, live: "2" } }).modes).toEqual({ shadow: 0, quiet: 3, live: 0 });
    expect(narrowMetrics({ v: 1, available: true }).modes).toEqual({ shadow: 0, quiet: 0, live: 0 });
  });

  it("keeps the precision view, and narrows one from before it to empty", () => {
    const precision = narrowMetrics({
      v: 1,
      available: true,
      precision: {
        confirmed: 2,
        exact: 1,
        precision: 0.5,
        byField: [{ field: "priority", confirmed: 2, corrected: 1, precision: 0.5, topChanges: [{ agent: "High", human: "Medium", count: 1 }] }, { confirmed: 1 }],
        byWeek: [{ week: "2026-W43", confirmed: 2, exact: 1, precision: 0.5, correctedByField: { priority: 1 } }],
        corrections: [{ key: "OAI-1", report: "r1", at: "2026-10-22T15:00:00.000Z", by: "Ana", field: "priority", agent: "High", human: { bad: true } }],
      },
    }).precision;
    expect(precision.byField).toEqual([{ field: "priority", confirmed: 2, corrected: 1, precision: 0.5, topChanges: [{ agent: "High", human: "Medium", count: 1 }] }]);
    expect(precision.byWeek).toHaveLength(1);
    expect(precision.corrections).toEqual([{ key: "OAI-1", report: "r1", at: "2026-10-22T15:00:00.000Z", by: "Ana", field: "priority", agent: "High", human: null }]);
    expect(narrowMetrics({ v: 1, available: true }).precision).toEqual({ confirmed: 0, exact: 0, precision: null, byField: [], byWeek: [], corrections: [] });
  });

  it("reads a bad v as unavailable", () => {
    expect(narrowIntake({ v: 2, tickets: [ticket] })).toMatchObject({ available: false, tickets: [] });
    expect(narrowMetrics(null)).toMatchObject({ available: false, byReporter: [] });
  });
});

describe("the local intake route", () => {
  const fake: IntakeAdapter = {
    tickets: async () => narrowIntake({ v: 1, available: false, reason: "x" }),
    metrics: async () => narrowMetrics({ v: 1, available: true }),
  };
  const get = (path: string, method = "GET") => handleIntakeRoute(new Request(`http://127.0.0.1${path}`, { method }), path, fake);

  it("serves the tickets, the metrics and a local session by GET, and nothing else", async () => {
    expect(await (await get("/api/intake"))!.json()).toMatchObject({ available: false, reason: "x" });
    expect(await (await get("/api/intake/metrics"))!.json()).toMatchObject({ available: true });
    expect(await (await get("/api/intake/session"))!.json()).toEqual({ access: "local" });
    expect((await get("/api/intake", "POST"))!.status).toBe(405);
    expect(await get("/api/intake/login", "POST")).toBeNull();
    expect(await get("/api/jav")).toBeNull();
  });
});
