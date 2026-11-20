// @vitest-environment node
/**
 * A clerk loop on the clerk fixture project, end to end (felipearos/ralph#316).
 *
 * The fixture (`fixtures/clerk/.ralph/`) is the intake project the spec
 * decides: one clerk loop, empty `gates` and `requiredChecks`, a `clerk` block
 * in `shadow`, and CLERK_* guidance. What has to hold before such a loop is
 * pointed at a real channel is the supervisor's startup order for it: the REAL
 * `preflight.ts` passes for that project, and the REAL gate it declares then
 * waits rather than spawning.
 *
 * Run as subprocesses against fake `gh`, `doppler` and `git` binaries on
 * PATH, as `preflight.test.ts` runs them: the seams here are processes. Nothing
 * touches GitHub, Doppler, Slack or Jira.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { requiredLabels } from "../preflight";
import { clerkRules, loadProjectConfig } from "../project-config";
import { subprocessSuite } from "../test-timeouts";
import { readPlan } from "./batch";
import { checkClerkIntakeBoard } from "../preflight";
import { INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack } from "./fakes";
import { noCache, poll, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import type { MetricsEvent } from "./metrics";
import { planPath } from "./plan";
import { slackClient, tsMs } from "./slack";
import { intakeSnapshotPath } from "./intake-snapshot";
import { clerkStorePath, readClerkStore } from "./store";

subprocessSuite("runs preflight.ts and clerk/gate.ts end to end");

const HOME = join(__dirname, "..");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;
const LOOP = "clara";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const scratch = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const writeExecutable = (path: string, lines: string[]): void => {
  writeFileSync(path, [...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

/** The intake worktree, and a PATH of stand-ins that record what they were asked. */
function fixture(): { project: string; bin: string; calls: () => string[] } {
  const project = scratch("ralph-clerk-e2e-");
  cpSync(join(HOME, "fixtures", "clerk", ".ralph"), join(project, ".ralph"), { recursive: true });
  mkdirSync(join(project, ".ralph", "logs"), { recursive: true });
  const bin = join(scratch("ralph-clerk-e2e-bin-"), "bin");
  mkdirSync(bin);
  const callsFile = join(bin, "..", "calls.log");
  writeFileSync(callsFile, "");
  const record = (name: string): string => `printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(callsFile)}`;
  const labels = JSON.stringify(requiredLabels(LOOP).map((name) => ({ name })));
  writeExecutable(join(bin, "gh"), [
    "#!/bin/sh",
    record("gh"),
    'if [ "$1 $2" = "auth status" ]; then exit 0; fi',
    `if [ "$1 $2" = "label list" ]; then printf '%s\\n' '${labels}'; exit 0; fi`,
    "exit 0",
  ]);
  writeExecutable(join(bin, "doppler"), ["#!/bin/sh", record("doppler"), "printf '%s\\n' '[]'", "exit 0"]);
  writeExecutable(join(bin, "git"), [
    "#!/bin/sh",
    record("git"),
    'case "$1 $2" in "rev-parse --git-dir") echo .git; exit 0 ;; esac',
    'case "$2" in --verify) echo aaaa111; exit 0 ;; esac',
    "exit 0",
  ]);
  for (const tool of ["claude", "python3"]) writeExecutable(join(bin, tool), ["#!/bin/sh", "exit 0"]);
  writeExecutable(join(bin, "uuidgen"), ["#!/bin/sh", "echo 00000000-0000-4000-8000-000000000000"]);
  return { project, bin, calls: () => readFileSync(callsFile, "utf8").split("\n").filter(Boolean) };
}

const env = (project: string, bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: bin,
  RALPH_PROJECT: project,
  RALPH_LOOP_NAME: LOOP,
  ...extra,
});

describe("a clerk loop on the clerk fixture", () => {
  it("passes preflight with empty gates, then waits in its gate rather than spawning", () => {
    const { project, bin, calls } = fixture();

    // What the supervisor exports once `clerk/slack.ts --check-token` has
    // proved the token: its NAME, never its value, which goes to the gate alone.
    const preflight = spawnSync(BUN, [join(HOME, "preflight.ts"), "--json"], {
      cwd: project,
      encoding: "utf8",
      // No Jira credential in its environment, so the intake board check
      // (asked in-process below, against a fake) never reaches the network.
      env: env(project, bin, { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_CLERK_SLACK_TOKEN RALPH_CLERK_JIRA_TOKEN", RALPH_CLERK_JIRA_TOKEN: "" }),
      timeout: 60_000,
    });
    const report = JSON.parse(preflight.stdout) as { verdict: string; checks: { name: string; outcome: { status: string } }[] };
    expect(report.verdict, preflight.stdout).toBe("ready");
    expect(preflight.status).toBe(0);
    const asked = report.checks.map((check) => check.name);
    // The spec's one drop: the clerk takes nothing off the frontier.
    expect(asked).not.toContain("frontier-prerequisites");
    for (const name of ["project-config", "tools", "loop-identity", "loop-labels", "github-credentials", "doppler-scope", "clerk-credentials"]) {
      expect(asked, `the clerk was not asked ${name}`).toContain(name);
    }
    // Read-only, as every preflight is: nothing it asked writes.
    for (const call of calls()) expect(call).not.toMatch(/^gh (issue|pr|label create|api -X)/);

    // The gate the supervisor would run next, in its blocking form. Its
    // supervisor is already gone, so it waits exactly one poll and stops —
    // which is what a loop with no work does between iterations.
    const dead = spawnSync("true");
    const gate = spawnSync(BUN, [join(HOME, "clerk", "gate.ts"), "300"], {
      cwd: project,
      encoding: "utf8",
      // A token that is not a real one: a fresh store's first poll only starts
      // the clock, so nothing here reaches Slack.
      env: env(project, bin, {
        RALPH_SUPERVISOR_PID: String(dead.pid),
        RALPH_CONTROL_POLL_SECONDS: "1",
        RALPH_CLERK_SLACK_TOKEN: "xoxb-test-not-a-real-token",
        RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:not-a-real-token",
      }),
      timeout: 20_000,
    });
    expect(gate.stderr).toBe("");
    expect(gate.status).toBe(0);
    const lines = gate.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^clerk-gate: .* — waiting 300s \(poll 1, idle 0s\)$/);
    expect(gate.stdout).not.toContain("work available");
    expect(lines.at(-1)).toBe(`clerk-gate: supervisor ${dead.pid} is gone — stopping.`);
  });

  it("takes a settled report from the gate through the session's plan to a shadow apply and the shadow canvas, with no other write", async () => {
    // felipearos/ralph#318. The gate runs in-process against a fake Slack and
    // a fake Jira whose intake board its candidates are read from
    // (felipearos/ralph#447), as `ci-doctor/end-to-end.test.ts` runs the doctor's: its
    // I/O is injected, a subprocess's could not be. The SESSION's side is the
    // real CLI, run as the session runs it — in the worktree, with no
    // credential — and the plan is what a model would write.
    const { project, bin } = fixture();
    const rules = clerkRules(loadProjectConfig(project))!;
    expect(rules.jira.intakeProject).toBe("OAI");
    const slack = fakeSlack(rules.channel, { users: { U0ANA: "Ana Pérez" }, canvases: [rules.shadowCanvas!] });
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    jira.add({ key: "OAI-12", summary: "No se puede exportar el reporte de checklists", labels: ["slack-intake", "acme-backoffice"], status: "Por confirmar" });
    const T0 = "1760961600.000000";
    const journal: string[] = [];
    const events: MetricsEvent[] = [];
    const deps = (minutes: number): PollDeps => ({
      rules,
      now: () => tsMs(after(T0, minutes)),
      slack: slackClient("xoxb-fake", slack.fetch, rules.channel),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
      // Shadow reads its candidates from the intake board and writes nothing to it.
      ledger: (event) => events.push(event) > 0,
      storePath: clerkStorePath(LOOP, project),
      readPlan: (batch) => readPlan(project, batch),
      journal: (_batch, entry) => journal.push(entry),
      intervalSeconds: 300,
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: () => true,
    });
    await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());

    // A report is written, and settles.
    slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists desde el back" });
    const handed = await poll(deps(12), noCache());
    expect(handed.verdict.work).toBe(true);

    // The session reads its batch through the CLI, with no credential.
    const session = (args: string[] = []) =>
      spawnSync(BUN, [join(HOME, "clerk", "batch.ts"), ...args], {
        cwd: project,
        encoding: "utf8",
        env: env(project, bin, { RALPH_CLERK_SLACK_TOKEN: "", RALPH_CLERK_JIRA_TOKEN: "" }),
      });
    const read = session();
    expect(read.status, read.stderr).toBe(0);
    const view = JSON.parse(read.stdout) as { batch: string; plan: string; reports: { report: string; author: string; candidates: { key: string }[] }[] };
    expect(view.reports).toHaveLength(1);
    expect(view.reports[0]!.author).toBe("Ana Pérez");
    expect(view.reports[0]!.candidates.map((candidate) => candidate.key)).toContain("OAI-12");
    expect(view.plan).toBe(planPath(view.batch));

    // It writes the plan a model would, and checks it with the gate's rules.
    writeFileSync(
      join(project, view.plan),
      JSON.stringify({
        batch: view.batch,
        entries: [
          {
            report: view.reports[0]!.report,
            verdict: "issue",
            type: "Error",
            app: "Backoffice",
            priority: "High",
            assignee: "agent",
            difficulty: "medium",
            story_points: 3,
            duplicate_of: "OAI-12",
            duplicate_confidence: "unsure",
            summary_es: "No se puede exportar el reporte de checklists en el Backoffice",
            description_es: "Al exportar el reporte de checklists desde el Backoffice no se descarga nada.",
          },
        ],
      }),
    );
    expect(session(["--check"]).status).toBe(0);

    // The gate's next poll validates and applies it, in shadow.
    expect((await poll(deps(13), noCache())).verdict.work).toBe(false);
    const { store } = readClerkStore(clerkStorePath(LOOP, project), rules.channel);
    expect(store.batch).toBeNull();
    const [ticket] = Object.values(store.shadow.tickets);
    expect(ticket).toMatchObject({
      type: "Error",
      priority: "High",
      assignee: "agent",
      difficulty: "medium",
      storyPoints: 3,
      labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente", "posible-duplicado"],
    });
    expect(ticket!.fields).toEqual(expect.arrayContaining(["Dificultad: medium", "Puntos de historia sugeridos: 3"]));
    expect(store.shadow.writes.map((entry) => entry.write.kind)).toEqual(["create", "link", "reply"]);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain("posible duplicado of OAI-12, thread reply (shadow: not written)");

    // felipearos/ralph#319: the gate redraws the operator's test canvas once
    // the rebuild interval has passed since its last rebuild (at the hand-over
    // poll, minute 12), and the would-be ticket is a row in it.
    const rebuilt = await poll(deps(12 + rules.canvasMinutes), noCache());
    expect(rebuilt.verdict.notes).toEqual([`shadow canvas ${rules.shadowCanvas} rebuilt (1 would-be ticket)`]);
    const canvas = slack.canvases.get(rules.shadowCanvas!)!;
    expect(canvas).toContain("# Reportes del canal (prueba, modo shadow)");
    expect(canvas).toContain(`[${ticket!.key}](${ticket!.permalink}) | No se puede exportar el reporte de checklists en el Backoffice | Backoffice | High | medium | 3 | Sin registrar (shadow) | 1 |`);

    // The ledger has the report and what the clerk made of it, marked shadow
    // (felipearos/ralph#447).
    expect(events.map((event) => `${event.kind} ${event.mode}`)).toEqual(["reported shadow", "classified shadow"]);
    expect(events[1]).toMatchObject({ key: ticket!.key, assigneeKind: "agent", difficulty: "medium", storyPoints: 3 });

    // Zero real writes: Jira only searched, for the candidates, and Slack
    // only read — but for the shadow canvas, the one write shadow makes.
    expect(jira.writes()).toEqual([]);
    expect(new Set(jira.calls.map((call) => `${call.method} ${call.path}`))).toEqual(new Set(["POST /rest/api/3/search/jql"]));
    const writes = slack.calls.filter((call) => !["auth.test", "conversations.history", "conversations.replies", "users.info"].includes(call.method));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.map((call) => `${call.method} ${call.params.canvas_id}`)).toEqual(writes.map(() => `canvases.edit ${rules.shadowCanvas}`));
    expect(slack.created).toEqual([]);
  });

  it("live on the intake board: preflight's board check passes, and one poll files the report into Por confirmar, once", async () => {
    // felipearos/ralph#447. The fixture flipped live, with a points field.
    const { project } = fixture();
    const configPath = join(project, ".ralph", "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { clerk: Record<string, unknown> & { jira: Record<string, unknown> } };
    raw.clerk.mode = "live";
    raw.clerk.jira.storyPointsField = "customfield_10016";
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const config = loadProjectConfig(project);
    const rules = clerkRules(config)!;
    // A board whose new tickets start in Backlog, so the move to Por
    // confirmar is the clerk's to make.
    const workflow = {
      statuses: [{ name: "Backlog", category: "new" as const }, ...INTAKE_WORKFLOW.statuses],
      transitions: { ...INTAKE_WORKFLOW.transitions, Backlog: ["Por confirmar"] },
    };
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: workflow } });
    const build = (site: string, credential: { email: string; token: string }) => jiraClient(site, credential, jira.fetch);
    const board = await checkClerkIntakeBoard(config, "clerk", { RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:fake" }, build);
    expect(board!.outcome.status).toBe("ok");

    const slack = fakeSlack(rules.channel, { users: { U0ANA: "Ana Pérez" } });
    const T0 = "1760961600.000000";
    const events: MetricsEvent[] = [];
    const notes: string[] = [];
    const storePath = clerkStorePath(LOOP, project);
    const deps = (minutes: number): PollDeps => ({
      rules,
      now: () => tsMs(after(T0, minutes)),
      slack: slackClient("xoxb-fake", slack.fetch, rules.channel),
      jira: build(SITE, { email: "clerk@example.com", token: "fake" }),
      ledger: (event) => events.push(event) > 0,
      storePath,
      readPlan: (batch) => readPlan(project, batch),
      journal: () => {},
      intervalSeconds: 300,
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: () => true,
    });
    const run = async (minutes: number) => {
      const polled = await poll(deps(minutes), noCache());
      notes.push(...(polled.verdict.notes ?? []));
      return polled.verdict;
    };
    await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
    slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte de checklists desde el back" });
    const handed = await run(12);
    expect(handed.work, handed.why).toBe(true);
    const batch = readClerkStore(storePath, rules.channel).store.batch!;
    writeFileSync(
      join(project, planPath(batch.id)),
      JSON.stringify({
        batch: batch.id,
        entries: [
          {
            report: batch.reports[0]!.id,
            verdict: "issue",
            type: "Error",
            app: "Backoffice",
            priority: "High",
            assignee: "agent",
            difficulty: "medium",
            story_points: 3,
            duplicate_of: null,
            summary_es: "No se puede exportar el reporte de checklists en el Backoffice",
            description_es: "Al exportar el reporte de checklists desde el Backoffice no se descarga nada.",
          },
        ],
      }),
    );
    // The store as it stood before the apply: restoring it after is a kill
    // between the create and every later save, the Slack reply included.
    const before = readFileSync(storePath, "utf8");
    expect((await run(13)).work).toBe(false);

    const filed = jira.issues.filter((issue) => issue.key.startsWith("OAI-"));
    expect(filed).toHaveLength(1);
    const [ticket] = filed;
    expect(ticket).toMatchObject({
      status: "Por confirmar",
      type: "Error",
      priority: "High",
      labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente"],
      custom: { customfield_10016: 3 },
    });
    expect(ticket!.description).toContain("Puntos de historia sugeridos: 3");
    const replies = () => slack.calls.filter((call) => call.method === "chat.postMessage");
    expect(replies().map((call) => call.params.text)).toEqual(["Recibido, en revisión."]);
    const { store } = readClerkStore(storePath, rules.channel);
    expect(store.processed[batch.reports[0]!.id]).toMatchObject({ state: "filed", key: ticket!.key });
    expect(store.determinations?.[ticket!.key]).toMatchObject({ type: "Error", priority: "High", app: "Backoffice", assignee: "agent", difficulty: "medium", storyPoints: 3 });
    expect(events.map((event) => `${event.kind} ${event.mode} ${event.key}`)).toEqual([`reported live ${ticket!.key}`, `classified live ${ticket!.key}`]);

    // The rerun after the kill finds the ticket by its marker and the reply
    // by its text: nothing is filed or posted twice.
    writeFileSync(storePath, before);
    expect((await run(14)).work).toBe(false);
    expect(jira.issues.filter((issue) => issue.key.startsWith("OAI-"))).toHaveLength(1);
    expect(jira.writes().filter((call) => call.path === "/rest/api/3/issue")).toHaveLength(1);
    expect(replies()).toHaveLength(1);
    expect(notes.filter((note) => /not moved|story points/.test(note))).toEqual([]);

    // felipearos/ralph#449: a person makes it hard and five points, and
    // confirms it for an agent. The next poll labels it ready-for-agent,
    // keeps the confirmer's difficulty, and records who and what changed.
    const confirmer = { accountId: "557058:ana", displayName: "Ana Pérez" };
    jira.actor = confirmer;
    const edited = jira.issues.find((issue) => issue.key === ticket!.key)!;
    edited.labels = edited.labels!.map((label) => (label === "difficulty:medium" ? "difficulty:hard" : label));
    edited.custom = { ...edited.custom, customfield_10016: 5 };
    await build(SITE, { email: "clerk@example.com", token: "fake" }).transition(ticket!.key, rules.jira.statuses!.confirmed);
    expect(edited.status).toBe("Confirmado");
    await run(15);
    expect(edited.labels).toEqual(["slack-intake", "acme-backoffice", "difficulty:hard", "para-agente", "ready-for-agent"]);
    const confirmed = events.filter((event) => event.kind === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      mode: "live",
      key: ticket!.key,
      report: batch.reports[0]!.id,
      by: confirmer,
      overrides: [
        { field: "difficulty", agent: "medium", human: "hard" },
        { field: "storyPoints", agent: 3, human: 5 },
      ],
    });
    // A restart changes nothing: the label fences it, the store remembers it.
    await run(16);
    expect(events.filter((event) => event.kind === "confirmed")).toHaveLength(1);
    expect(edited.labels!.filter((label) => label === "ready-for-agent")).toHaveLength(1);
  });

  it("quiet on the intake board: every Jira write live makes, a held OA move, and not one Slack write (felipearos/ralph#443)", async () => {
    // The fixture flipped quiet, with a points field and no test canvas: with
    // none, quiet writes no canvas at all, so the whole run must leave Slack
    // exactly as it found it.
    const { project } = fixture();
    const configPath = join(project, ".ralph", "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { clerk: Record<string, unknown> & { jira: Record<string, unknown> } };
    raw.clerk.mode = "quiet";
    raw.clerk.jira.storyPointsField = "customfield_10016";
    delete raw.clerk.shadowCanvas;
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const config = loadProjectConfig(project);
    const rules = clerkRules(config)!;
    expect(rules).toMatchObject({ mode: "quiet", holdOaMove: true, shadowCanvas: null });

    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    const build = (site: string, credential: { email: string; token: string }) => jiraClient(site, credential, jira.fetch);
    // The board must exist, as for live: a missing status is a denial, not a warning.
    const board = await checkClerkIntakeBoard(config, "clerk", { RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:fake" }, build);
    expect(board!.outcome.status).toBe("ok");
    const missing = await checkClerkIntakeBoard(
      { ...config, clerk: { ...config.clerk!, jira: { ...config.clerk!.jira!, statuses: { pending: "Nunca" } } } },
      "clerk",
      { RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:fake" },
      build,
    );
    expect(missing!.outcome.status).toBe("denied");

    const slack = fakeSlack(rules.channel, { users: { U0ANA: "Ana Pérez", U0LUIS: "Luis Soto" }, canvases: ["F0SHADOWCV1"] });
    const T0 = "1760961600.000000";
    const events: MetricsEvent[] = [];
    const journal: string[] = [];
    const notes: string[] = [];
    const storePath = clerkStorePath(LOOP, project);
    const deps = (minutes: number): PollDeps => ({
      rules,
      now: () => tsMs(after(T0, minutes)),
      slack: slackClient("xoxb-fake", slack.fetch, rules.channel),
      jira: build(SITE, { email: "clerk@example.com", token: "fake" }),
      ledger: (event) => events.push(event) > 0,
      storePath,
      readPlan: (batch) => readPlan(project, batch),
      journal: (_batch, entry) => journal.push(entry),
      intervalSeconds: 300,
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: () => true,
    });
    const run = async (minutes: number) => {
      const polled = await poll(deps(minutes), noCache());
      notes.push(...(polled.verdict.notes ?? []));
      return polled.verdict;
    };
    await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
    const root = after(T0, 1);
    slack.post({ ts: root, user: "U0ANA", text: "No puedo exportar el reporte de checklists desde el back" });
    const handed = await run(12);
    expect(handed.work, handed.why).toBe(true);
    const batch = readClerkStore(storePath, rules.channel).store.batch!;
    writeFileSync(
      join(project, planPath(batch.id)),
      JSON.stringify({
        batch: batch.id,
        entries: [
          {
            report: batch.reports[0]!.id,
            verdict: "issue",
            type: "Error",
            app: "Backoffice",
            priority: "High",
            assignee: "person",
            difficulty: "hard",
            story_points: 5,
            duplicate_of: null,
            summary_es: "No se puede exportar el reporte de checklists en el Backoffice",
            description_es: "Al exportar el reporte de checklists desde el Backoffice no se descarga nada.",
          },
        ],
      }),
    );
    expect((await run(13)).work).toBe(false);

    // Filed for real on the intake board, exactly as live files it.
    const filed = jira.issues.filter((issue) => issue.key.startsWith("OAI-"));
    expect(filed).toHaveLength(1);
    const [ticket] = filed;
    expect(ticket).toMatchObject({
      status: "Por confirmar",
      type: "Error",
      priority: "High",
      labels: ["slack-intake", "acme-backoffice", "difficulty:hard", "para-persona"],
      custom: { customfield_10016: 5 },
    });
    expect(journal[0]).toContain(`${ticket!.key}: Error High`);
    expect(journal[0]).toContain("(quiet: nothing posted in Slack)");
    expect(readClerkStore(storePath, rules.channel).store.determinations?.[ticket!.key]).toMatchObject({ assignee: "person", difficulty: "hard", storyPoints: 5 });

    // A reply in the report's thread is still copied to the ticket: a Jira write (#321).
    slack.post({ ts: after(T0, 20), thread_ts: root, user: "U0LUIS", text: "A mí también me pasa con el de junio" });
    await run(21);
    expect(ticket!.comments!.at(-1)).toContain("Respuesta de Luis Soto en Slack");
    expect(ticket!.comments!.at(-1)).toContain("A mí también me pasa con el de junio");

    // A person confirms it for a person: the move to OA is held, and the
    // ticket waits on the intake board, labelled for the move.
    jira.actor = { accountId: "557058:ana", displayName: "Ana Pérez" };
    await build(SITE, { email: "clerk@example.com", token: "fake" }).transition(ticket!.key, rules.jira.statuses!.confirmed);
    await run(22);
    expect(jira.issues.filter((issue) => issue.key.startsWith("OA-"))).toEqual([]);
    expect(ticket!.status).toBe("Confirmado");
    expect(ticket!.labels).toContain("para-mover-a-oa");
    expect(notes).toContainEqual(expect.stringContaining(`quiet: ${ticket!.key} confirmed for a person by Ana Pérez: not moved to OA (held: 'clerk.holdOaMove')`));

    // The canvas interval passes: the board is read and the dashboard's
    // snapshot recorded from it, and no canvas is written anywhere.
    await run(13 + rules.canvasMinutes);
    expect(notes).toContainEqual(expect.stringMatching(/^quiet: no canvas written \(1 ticket\) — 'clerk.shadowCanvas' is not set/));
    const snapshot = JSON.parse(readFileSync(intakeSnapshotPath(storePath), "utf8")) as { source: string; mode: string; tickets: { key: string }[] };
    expect(snapshot).toMatchObject({ source: "jira", mode: "quiet" });
    expect(snapshot.tickets.map((one) => one.key)).toEqual([ticket!.key]);

    // Every ledger event is marked quiet, the held move with its placeholder key.
    expect(events.map((event) => `${event.kind} ${event.mode}`)).toEqual(["reported quiet", "classified quiet", "confirmed quiet", "moved quiet"]);
    expect(events.at(-1)).toMatchObject({ oaKey: `HELD-${ticket!.key.replace("-", "")}`, held: true });

    // Real Jira writes: the create, its move to Por confirmar, the copied
    // reply, the confirmation's label.
    const jiraWrites = jira.writes().map((call) => `${call.method} ${call.path}`);
    expect(jiraWrites).toContain("POST /rest/api/3/issue");
    expect(jiraWrites).toContain(`POST /rest/api/3/issue/${ticket!.key}/comment`);
    expect(jiraWrites).toContain(`PUT /rest/api/3/issue/${ticket!.key}`);
    // And not one Slack write: no "Recibido", no post, no canvas, no DM.
    const reads = new Set(["auth.test", "conversations.history", "conversations.replies", "users.info", "conversations.info", "conversations.members"]);
    expect(slack.calls.filter((call) => !reads.has(call.method))).toEqual([]);
    expect(slack.created).toEqual([]);
    expect(slack.canvases.get("F0SHADOWCV1")).toBe("");
  });

  it("live with holdOaMove: real Slack replies and intake-board writes, and nothing ever filed on OA (felipearos/ralph#443)", async () => {
    // The second clerk the operator runs on a private test channel: it
    // answers in Slack and files on the shared intake board as live does, and
    // must never put a test ticket on the team's board.
    const { project } = fixture();
    const configPath = join(project, ".ralph", "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { clerk: Record<string, unknown> };
    raw.clerk.mode = "live";
    raw.clerk.holdOaMove = true;
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const rules = clerkRules(loadProjectConfig(project))!;
    expect(rules).toMatchObject({ mode: "live", holdOaMove: true });

    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    const build = (site: string, credential: { email: string; token: string }) => jiraClient(site, credential, jira.fetch);
    const slack = fakeSlack(rules.channel, { users: { U0ANA: "Ana Pérez" } });
    const T0 = "1760961600.000000";
    const events: MetricsEvent[] = [];
    const notes: string[] = [];
    const storePath = clerkStorePath(LOOP, project);
    const deps = (minutes: number): PollDeps => ({
      rules,
      now: () => tsMs(after(T0, minutes)),
      slack: slackClient("xoxb-fake", slack.fetch, rules.channel),
      jira: build(SITE, { email: "clerk@example.com", token: "fake" }),
      ledger: (event) => events.push(event) > 0,
      storePath,
      readPlan: (batch) => readPlan(project, batch),
      journal: () => {},
      intervalSeconds: 300,
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: () => true,
    });
    const run = async (minutes: number) => {
      const polled = await poll(deps(minutes), noCache());
      notes.push(...(polled.verdict.notes ?? []));
      return polled.verdict;
    };
    await poll({ ...deps(0), now: () => tsMs(T0) }, noCache());
    slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No carga el listado de inspecciones" });
    expect((await run(12)).work).toBe(true);
    const batch = readClerkStore(storePath, rules.channel).store.batch!;
    writeFileSync(
      join(project, planPath(batch.id)),
      JSON.stringify({
        batch: batch.id,
        entries: [
          {
            report: batch.reports[0]!.id,
            verdict: "issue",
            type: "Error",
            app: "Backoffice",
            priority: "High",
            assignee: "person",
            difficulty: "medium",
            story_points: 3,
            duplicate_of: null,
            summary_es: "No carga el listado de inspecciones en el Backoffice",
            description_es: "El listado de inspecciones queda cargando.",
          },
        ],
      }),
    );
    await run(13);
    const [ticket] = jira.issues.filter((issue) => issue.key.startsWith("OAI-"));
    expect(ticket).toMatchObject({ status: "Por confirmar", labels: expect.arrayContaining(["para-persona"]) });
    // The reporter is answered in Slack, as live does.
    expect(slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.params.text)).toEqual(["Recibido, en revisión."]);

    jira.actor = { accountId: "557058:ana", displayName: "Ana Pérez" };
    await build(SITE, { email: "clerk@example.com", token: "fake" }).transition(ticket!.key, rules.jira.statuses!.confirmed);
    await run(14);
    await run(15);
    expect(jira.issues.filter((issue) => issue.key.startsWith("OA-"))).toEqual([]);
    expect(jira.writes().filter((call) => call.path === "/rest/api/3/issue").map((call) => (call.body as { fields: { project: { key: string } } }).fields.project.key)).toEqual(["OAI"]);
    expect(ticket!.status).toBe("Confirmado");
    expect(ticket!.labels).toContain("para-mover-a-oa");
    expect(notes).toContainEqual(`${ticket!.key} confirmed for a person by Ana Pérez: not moved to OA (held: 'clerk.holdOaMove'), labelled 'para-mover-a-oa'`);
    expect(events.map((event) => `${event.kind} ${event.mode}`)).toEqual(["reported live", "classified live", "confirmed live", "moved live"]);
    expect(events.at(-1)).toMatchObject({ held: true, oaKey: `HELD-${ticket!.key.replace("-", "")}` });
  });
});
