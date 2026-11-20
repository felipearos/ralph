// @vitest-environment node
/**
 * The snapshot collector, driven against the real handler (`createHandler`)
 * over scratch checkouts, with the harness's real redactor.
 *
 * Every assertion is on what would leave the machine: the gzip bodies, their
 * hashes, and the fail-closed answer when the redactor cannot vouch for them.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import { createEvalsAdapter } from "../evals-adapter";
import { createAgentsAdapter } from "../agents-adapter";
import { coderRoster } from "../contracts";
import type { RuntimeSnapshot } from "../contracts";
import { createRalphControlAdapter, type Executor } from "../control-adapter";
import { bunPath, cleanupFixtures, createFixture, removeScratchDir } from "../fixtures";
import { narrowIntake, narrowMetrics, type IntakeAdapter } from "../intake-adapter";
import type { JavAdapter } from "../jav-adapter";
import { createRalphLifecycleAdapter } from "../lifecycle-adapter";
import type { Onboarding } from "../onboarding";
import { createRecordsAdapter } from "../records-adapter";
import { createHandler, type ProjectScope } from "../server";
import { subprocessSuite } from "../../test-timeouts";
import {
  changedSince,
  collect,
  KEY_MAX_BYTES,
  pushBatches,
  SNAPSHOT_ROUTES,
  type Collected,
  type Snapshot,
  type SnapshotProblem,
} from "./collect";
import { processRedactor, scrub, type Redactor } from "./scrub";

subprocessSuite("runs the harness redactor under bun");

const HARNESS = join(__dirname, "..", "..");
const scratch: string[] = [];
afterAll(() => {
  cleanupFixtures();
  scratch.splice(0).forEach((dir) => removeScratchDir(dir));
});

// One credential shape per position the ticket names. None is real.
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${"Zx9_Yw8-Vu7".repeat(3)}`;
const OPENAI_KEY = `sk-proj-${"Qr5St6Uv7W".repeat(3)}`;
const PAT = `github_pat_${"11ABCDEFG0".repeat(3)}`;
const SECRETS = [GITHUB_TOKEN, ANTHROPIC_KEY, OPENAI_KEY, PAT];

const failing: Executor = async () => ({ status: 1, stdout: "", stderr: "not in this fixture" });
const realRedactor = processRedactor({ ralphHome: HARNESS, bunPath: bunPath() });
const identity: Redactor = async (lines) => [...lines];

/**
 * A project `fixture` with one live loop, `ralph`, whose notification feed,
 * stage actor, runner failure and repo URL each carry a credential, served by
 * the real handler with every allowlisted route mounted.
 */
function machine(over: { usage?: () => Promise<unknown>; clock?: () => number; evalsExec?: Executor } = {}) {
  const f = createFixture("remote-collect");
  const worktree = f.worktree("wt-ralph");
  mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });
  writeFileSync(
    join(worktree, ".ralph", "logs", "notifications.jsonl"),
    `${JSON.stringify({
      event: "raised",
      id: "n-1",
      at: "2026-10-09T00:00:00.000Z",
      kind: "blocked",
      subject: "ralph is blocked",
      body: `git push said: remote: invalid credentials ${GITHUB_TOKEN}\nsee ${worktree}/log`,
      run: "run-ralph",
    })}\n`,
  );
  const state = {
    version: 1 as const,
    run: "run-ralph",
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree,
    branch: "ralph/14-thing",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-10-09T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  const snapshot: RuntimeSnapshot = {
    roster: coderRoster("ralph"),
    loops: [
      {
        worktree,
        identity: "ralph",
        loopStatus: "running",
        worktreeStatus: "live",
        branch: "ralph/14-thing",
        state,
        stateProblem: null,
        supervisor: "alive",
        presence: {
          loop: "ralph",
          run: "run-ralph",
          status: "running",
          supervisor: "alive",
          issue: 14,
          branch: "ralph/14-thing",
          iteration: { index: 1, max: 10 },
          observedAt: "2026-10-09T00:00:00.000Z",
          issues: [],
          actors: [
            {
              stage: "executor",
              state: "running",
              invocation: "inv-1",
              runner: "claude",
              model: "opus",
              startedAt: "2026-10-09T00:00:00.000Z",
              endedAt: null,
              lastAction: `tool Bash — curl -H 'x-api-key: ${ANTHROPIC_KEY}' https://api.anthropic.com`,
              activityAt: "2026-10-09T00:00:00.000Z",
            },
          ],
          recent: [],
          failureReason: null,
          step: null,
          phase: { index: 1, total: 5, label: "select and map" },
          warning: null,
        },
        repoUrl: `https://felipe:${PAT}@github.com/felipearos/loggd`,
        runnerFailures: {
          settled: [
            {
              at: "2026-10-09T00:00:00.000Z",
              loop: "ralph",
              run: "run-ralph",
              iteration: 1,
              stage: "executor",
              runner: "claude",
              model: "opus",
              issue: 14,
              exitCode: 1,
              kind: "auth",
              summary: "the provider refused the key",
              visibility: "post-hoc",
              evidence: [`401 Incorrect API key provided: ${OPENAI_KEY}`],
              note: null,
            },
          ],
        },
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
  const project = { id: "fixture", path: f.root, addedAt: "2026-10-01T00:00:00.000Z", source: "local" as const };
  const jav: JavAdapter = { read: async () => ({ path: join(HARNESS, "jav.json") }) as never, save: async () => ({}) as never };
  const intake: IntakeAdapter = {
    tickets: async () => narrowIntake({ v: 1, available: false, reason: "sin clerk" }),
    metrics: async () => narrowMetrics({ v: 1, available: false, reason: "sin clerk", generatedAt: "2026-10-09T00:00:00.000Z" }),
  };
  const scope: ProjectScope = {
    project,
    adapter: { read: async () => snapshot },
    usage: (over.usage ?? (async () => ({ project: "fixture", cost: 1.5, tokens: 1200 }))) as never,
    lineup: async (request) => Response.json({ path: new URL(request.url).pathname, loop: new URL(request.url).searchParams.get("loop") }),
    jav,
    intake,
    evals: createEvalsAdapter({ cliDir: HARNESS, root: f.root, bunPath: "bun", exec: over.evalsExec ?? failing }),
  };
  let nowMs = Date.parse("2026-10-09T00:00:05.000Z");
  const handler = createHandler({
    projects: () => [scope],
    shell: "<html></html>",
    clock: () => ({ nowMs: over.clock?.() ?? nowMs }),
    controlStatus: async () => ({ kind: "none" }),
    controls: ({ worktree: root }) => ({ adapter: createRalphControlAdapter({ cliDir: HARNESS, root, bunPath: "bun", exec: failing }) }),
    lifecycle: ({ worktree: root }) => ({
      control: createRalphControlAdapter({ cliDir: HARNESS, root, bunPath: "bun", exec: failing }),
      lifecycle: createRalphLifecycleAdapter({ cliDir: HARNESS, root, bunPath: "bun", exec: failing }),
    }),
    records: (root) => createRecordsAdapter({ root }),
    onboarding: { status: async () => ({ project: "fixture", ready: true, config: { repo: "felipearos/loggd" } }) } as unknown as Onboarding,
    agents: (registered) => ({
      agents: createAgentsAdapter({ cliDir: HARNESS, root: registered.path, project: registered.id, workspaces: f.root, bunPath: "bun", exec: failing }),
    }),
  });
  const fetchLocal = (url: string) => handler(new Request(url));
  return {
    f,
    worktree,
    handler,
    fetchLocal,
    tick: (ms: number) => (nowMs += ms),
    options: { base: "http://127.0.0.1:8791", fetch: fetchLocal, home: f.root, redact: realRedactor },
  };
}

const unzip = (snapshot: Snapshot): unknown => JSON.parse(gunzipSync(snapshot.body).toString("utf8"));
const bodies = (collected: readonly Collected[]): Snapshot[] => collected.filter((entry): entry is Snapshot => "body" in entry);

describe("collect over the real handler", () => {
  it("returns a gzip body for every allowlisted key, each the local route's JSON after scrubbing", async () => {
    const m = machine();
    const result = await collect(m.options);
    if (!result.ok) throw new Error(result.detail);
    const keys = result.snapshots.map((entry) => `${entry.project ?? "_"} ${entry.key}`);
    expect(keys.sort()).toEqual(
      [
        "_ _/projects",
        "_ _/health",
        "fixture dashboard",
        "fixture controls",
        "fixture control/ralph",
        "fixture checkout/ralph",
        "fixture history/ralph",
        "fixture notifications",
        "fixture usage",
        "fixture setup",
        "fixture agents",
        "fixture lineup/ralph",
        "fixture roots",
        "fixture jav",
        "fixture settings",
        "fixture prompts",
        "fixture sentinel",
        "fixture evals",
        "fixture evals-patches",
        "fixture evals-set",
        "fixture evals-suggestions",
        "fixture evals-inbox",
        "fixture evals-proposals",
        "fixture intake",
        "fixture intake-metrics",
      ].sort(),
    );
    expect(result.snapshots.filter((entry) => !("body" in entry))).toEqual([]);
    const paths: Record<string, string> = {
      "_/projects": "/api/projects",
      "_/health": "/api/projects/health",
      dashboard: "/api/p/fixture/loops",
      controls: "/api/p/fixture/controls",
      "control/ralph": "/api/p/fixture/loops/ralph/control",
      "checkout/ralph": "/api/p/fixture/loops/ralph/checkout",
      "history/ralph": "/api/p/fixture/loops/ralph/history",
      notifications: "/api/p/fixture/notifications",
      usage: "/api/p/fixture/usage",
      setup: "/api/p/fixture/setup",
      agents: "/api/p/fixture/agents",
      "lineup/ralph": "/api/p/fixture/lineup?loop=ralph",
      roots: "/api/p/fixture/roots",
      jav: "/api/p/fixture/jav",
      settings: "/api/p/fixture/settings",
      prompts: "/api/p/fixture/settings/prompts",
      sentinel: "/api/p/fixture/sentinel",
      evals: "/api/p/fixture/evals",
      "evals-patches": "/api/p/fixture/evals/patches",
      "evals-set": "/api/p/fixture/evals/set",
      "evals-suggestions": "/api/p/fixture/evals/suggestions",
      "evals-inbox": "/api/p/fixture/evals/inbox",
      "evals-proposals": "/api/p/fixture/evals/proposals",
      intake: "/api/p/fixture/intake",
      "intake-metrics": "/api/p/fixture/intake/metrics",
    };
    for (const snapshot of bodies(result.snapshots)) {
      const local = await m.fetchLocal(`http://127.0.0.1:8791${paths[snapshot.key]!}`);
      expect(local.status, snapshot.key).toBe(200);
      const expected = await scrub(await local.json(), { redact: realRedactor, home: m.f.root });
      if (!expected.ok) throw new Error(expected.detail);
      expect(unzip(snapshot), snapshot.key).toEqual(expected.value);
      expect(snapshot.bytes).toBe(snapshot.body.length);
      expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.readMs).toBeGreaterThanOrEqual(0);
    }
    // The lineup route was asked for the loop it is keyed by.
    const lineup = bodies(result.snapshots).find((entry) => entry.key === "lineup/ralph")!;
    expect(unzip(lineup)).toEqual({ path: "/api/lineup", loop: "ralph" });
    // The batched control views are keyed by the loops the project names.
    const controls = bodies(result.snapshots).find((entry) => entry.key === "controls")!;
    expect(Object.keys((unzip(controls) as { loops: Record<string, unknown> }).loops)).toEqual(["ralph"]);
  });

  it("scrubs a token from a notification body, an actor's lastAction, runner-failure evidence and repoUrl, and $HOME", async () => {
    const m = machine();
    const result = await collect(m.options);
    if (!result.ok) throw new Error(result.detail);
    const text = bodies(result.snapshots)
      .map((snapshot) => gunzipSync(snapshot.body).toString("utf8"))
      .join("\n");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain(m.f.root);

    const dashboard = unzip(bodies(result.snapshots).find((entry) => entry.key === "dashboard")!) as {
      loops: { loop: string; worktree: string; repoUrl: string; actors: { lastAction: string }[]; runnerFailure: { reason: { evidence: string[] } } }[];
    };
    const ralph = dashboard.loops.find((entry) => entry.loop === "ralph")!;
    expect(ralph.worktree).toBe("~/wt-ralph");
    expect(ralph.repoUrl).toBe("https://github.com/felipearos/loggd");
    expect(ralph.actors[0]!.lastAction).toBe("tool Bash — curl -H 'x-api-key: [redacted:anthropic-key]' https://api.anthropic.com");
    expect(ralph.runnerFailure.reason.evidence).toEqual(["401 Incorrect API key provided: [redacted:openai-key]"]);

    const notifications = unzip(bodies(result.snapshots).find((entry) => entry.key === "notifications")!) as {
      loops: { notifications: { body: string }[] }[];
    };
    expect(notifications.loops[0]!.notifications[0]!.body).toBe(
      "git push said: remote: invalid credentials [redacted:github-token]\nsee ~/wt-ralph/log",
    );
  });

  it("with the patch relay on, scrubs a token and $HOME out of the relayed patch, and keeps an arm named like a credential (#825)", async () => {
    let home = "";
    const m = machine({
      evalsExec: async ({ args }) => {
        if (args[1] !== "patches") return { status: 1, stdout: "", stderr: "not in this fixture" };
        const text = `diff --git a/ci.sh b/ci.sh\n+export GH_TOKEN=${GITHUB_TOKEN}\n+cd ${home}/wt-ralph\n`;
        // An arm named like a credential key (`lean-tokens`) must keep its text:
        // the scrubber blanks strings under such keys, which is why patches
        // travel as a list rather than a record keyed by trial.
        const patches = [
          { run: "eval-1", case: "14", arm: "ralph", text, truncated: false },
          { run: "eval-1", case: "14", arm: "lean-tokens", text: "diff --git a/x b/x\n+plain\n", truncated: false },
        ];
        return { status: 0, stdout: JSON.stringify({ version: 1, enabled: true, patches, omitted: 0 }), stderr: "" };
      },
    });
    home = m.f.root;
    const result = await collect(m.options);
    if (!result.ok) throw new Error(result.detail);
    const patches = unzip(bodies(result.snapshots).find((entry) => entry.key === "evals-patches")!) as {
      enabled: boolean;
      patches: { run: string; case: string; arm: string; text: string; truncated: boolean }[];
    };
    expect(patches.enabled).toBe(true);
    expect(patches.patches).toEqual([
      { run: "eval-1", case: "14", arm: "ralph", text: "diff --git a/ci.sh b/ci.sh\n+export GH_TOKEN=[redacted:github-token]\n+cd ~/wt-ralph\n", truncated: false },
      { run: "eval-1", case: "14", arm: "lean-tokens", text: "diff --git a/x b/x\n+plain\n", truncated: false },
    ]);
  });

  it("relays a summary-only project's Test set with titles, tags and grader kinds only, and scrubs a detailed one's notes (#856)", async () => {
    let home = "";
    let details = false;
    const m = machine({
      evalsExec: async ({ args }) => {
        if (args[1] !== "view") return { status: 1, stdout: "", stderr: "not in this fixture" };
        // A print that over-shares, as a harness bug would: the adapter copies only declared fields.
        const row = {
          id: "acme-app-12", repo: "acme/app", prs: [12], title: "Fix the flaky upload", tags: ["upload"], graders: ["held-out tests", "gates"],
          status: "active", addedAt: "2026-11-19T00:00:00Z", addedBy: "dashboard", lastRun: null,
          reason: "the trap is the retry", notes: `GH_TOKEN=${GITHUB_TOKEN} under ${home}/wt-ralph`,
          heldOut: ["src/upload.test.ts"], check: "bun test src/upload.test.ts", reference: "diff --git a/src/upload.ts b/src/upload.ts",
          ticket: { body: "the ticket body" },
        };
        return { status: 0, stdout: JSON.stringify({ version: "abc1234", details, cases: [row] }), stderr: "" };
      },
    });
    home = m.f.root;
    const read = async (): Promise<Record<string, unknown>> => {
      const result = await collect(m.options);
      if (!result.ok) throw new Error(result.detail);
      return (unzip(bodies(result.snapshots).find((entry) => entry.key === "evals-set")!) as { cases: Record<string, unknown>[] }).cases[0]!;
    };

    const summary = await read();
    expect(summary).toMatchObject({ title: "Fix the flaky upload", tags: ["upload"], graders: ["held-out tests", "gates"] });
    for (const key of ["reason", "notes", "heldOut", "check", "reference", "ticket"]) expect(summary, key).not.toHaveProperty(key);
    expect(JSON.stringify(summary)).not.toMatch(/diff --git|upload\.test|ticket body|trap/);

    details = true;
    const detailed = await read();
    expect(detailed.reason).toBe("the trap is the retry");
    expect(detailed.notes).toBe("GH_TOKEN=[redacted:github-token] under ~/wt-ralph");
    for (const key of ["heldOut", "check", "reference", "ticket"]) expect(detailed, key).not.toHaveProperty(key);
  });

  it("relays a summary-only project's proposals with goal, status and verdict only, and keeps a detailed one's rationale (#874)", async () => {
    let home = "";
    let details = false;
    const m = machine({
      evalsExec: async ({ args }) => {
        if (!args[0]!.endsWith("evals-proposals.ts")) return { status: 1, stdout: "", stderr: "not in this fixture" };
        // A print that over-shares, as a harness bug would: the adapter copies only declared fields.
        const row = {
          id: "prop-1", run: "eval-1", goal: "quality", kind: "prompt-overlay", status: "passed",
          verdict: { pass: true, conditions: [{ id: "solve-rate", pass: true, reason: "3/4 over 2/4" }] },
          reason: null, createdAt: "2026-11-19T00:00:00Z", runs: { subset: "eval-2", full: "eval-3" },
          content: { "coder.md": "Always rebase first" }, overlay: `${home}/wt-ralph/.git/ralph-experiments/overlay/coder.md`,
          files: ["coder.md"], diff: "diff --git a/coder.md b/coder.md", plan: { arms: ["ralph"] },
          ...(details ? { rationale: "the coder skipped the rebase", answers: [{ knob: "prompt", target: "coder.md", change: "add a rebase step", evidence: ["14"] }] } : {}),
        };
        return { status: 0, stdout: JSON.stringify({ version: 1, details, proposals: [row], problems: [] }), stderr: "" };
      },
    });
    home = m.f.root;
    const read = async (): Promise<Record<string, unknown>> => {
      const result = await collect(m.options);
      if (!result.ok) throw new Error(result.detail);
      return (unzip(bodies(result.snapshots).find((entry) => entry.key === "evals-proposals")!) as { proposals: Record<string, unknown>[] }).proposals[0]!;
    };

    const summary = await read();
    expect(summary).toMatchObject({ goal: "quality", status: "passed", verdict: { pass: true, conditions: [{ id: "solve-rate", pass: true, reason: "3/4 over 2/4" }] } });
    for (const key of ["content", "overlay", "files", "diff", "plan", "rationale", "answers"]) expect(summary, key).not.toHaveProperty(key);
    expect(JSON.stringify(summary)).not.toMatch(/diff --git|ralph-experiments|overlay\/|rebase/);

    details = true;
    const detailed = await read();
    expect(detailed.rationale).toBe("the coder skipped the rebase");
    expect(detailed.answers).toEqual([{ knob: "prompt", target: "coder.md", change: "add a rebase step" }]);
    for (const key of ["content", "overlay", "files", "diff", "plan"]) expect(detailed, key).not.toHaveProperty(key);
    expect(JSON.stringify(detailed)).not.toMatch(/diff --git|ralph-experiments|overlay\//);
  });

  it("skips a second collection that differs only in generatedAt and readAt", async () => {
    const m = machine();
    const first = await collect(m.options);
    if (!first.ok) throw new Error(first.detail);
    const stored = new Map(bodies(first.snapshots).map((entry) => [`${entry.project ?? "_"}\u0000${entry.key}`, entry.hash]));
    // Everything is new to an empty store.
    expect(changedSince(first.snapshots, new Map())).toHaveLength(bodies(first.snapshots).length);

    m.tick(60_000);
    const second = await collect(m.options);
    if (!second.ok) throw new Error(second.detail);
    const at = (result: typeof first) =>
      (unzip(bodies(result.snapshots).find((entry) => entry.key === "dashboard")!) as { generatedAt: string }).generatedAt;
    // The read time did move, so the bodies differ...
    expect(at(second)).not.toBe(at(first));
    // ...including each batched control view's own read time (#615)...
    const controlAt = (result: typeof first) =>
      (unzip(bodies(result.snapshots).find((entry) => entry.key === "controls")!) as {
        loops: Record<string, { generatedAt: string }>;
      }).loops.ralph!.generatedAt;
    expect(controlAt(second)).not.toBe(controlAt(first));
    // ...and still nothing is written.
    expect(changedSince(second.snapshots, stored)).toEqual([]);
    for (const snapshot of bodies(second.snapshots)) expect(snapshot.changed(stored.get(`${snapshot.project ?? "_"}\u0000${snapshot.key}`))).toBe(false);
  });

  it("returns a key over 1 MB gzip as too-large, with no body", async () => {
    // Incompressible text, so gzip cannot bring it under the limit.
    const noise = randomBytes(1_200_000).toString("base64");
    const m = machine({ usage: async () => ({ project: "fixture", noise }) });
    const result = await collect({ ...m.options, redact: identity });
    if (!result.ok) throw new Error(result.detail);
    const usage = result.snapshots.find((entry) => entry.key === "usage")!;
    expect(usage).toMatchObject({ project: "fixture", key: "usage", problem: "too-large" });
    expect("body" in usage).toBe(false);
    expect((usage as SnapshotProblem).detail).toContain(String(KEY_MAX_BYTES));
    // The rest of the project still collects.
    expect(bodies(result.snapshots).map((entry) => entry.key)).toContain("dashboard");
  });
});

describe("a redactor that cannot vouch for its answer", () => {
  /** A harness checkout whose `runner-failure.ts` is the given script. */
  const harnessWith = (script: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-remote-redactor-"));
    scratch.push(dir);
    writeFileSync(join(dir, "runner-failure.ts"), script);
    return dir;
  };
  const passThrough = `const text = await new Response(Bun.stdin.stream()).text();`;

  it.each([
    ["exits early", `process.exit(3);`],
    ["writes to stderr", `${passThrough}\nconsole.error("runner-signals.json has no patterns");\nprocess.stdout.write(text);`],
    ["drops a line", `${passThrough}\nprocess.stdout.write(text.split("\\n").slice(1).join("\\n"));`],
  ])("makes collect fail closed when it %s", async (_, script) => {
    const m = machine();
    const redact = processRedactor({ ralphHome: harnessWith(script), bunPath: bunPath() });
    const result = await collect({ ...m.options, redact });
    expect(result).toMatchObject({ ok: false, error: "redactor-degraded" });
    expect("snapshots" in result).toBe(false);
  });

  it("fails closed on a fake that answers the wrong count, or throws", async () => {
    const m = machine();
    for (const redact of [async (lines: readonly string[]) => lines.slice(1), async () => Promise.reject(new Error("boom"))] as Redactor[]) {
      const result = await collect({ ...m.options, redact });
      expect(result).toMatchObject({ ok: false, error: "redactor-degraded" });
    }
  });
});

describe("SNAPSHOT_ROUTES", () => {
  it("is the ticket's allowlist, verbatim", () => {
    // Read off the route table now (#629), in the bridge's read and push order.
    expect(SNAPSHOT_ROUTES).toEqual([
      { scope: "global", key: "_/projects", path: "/api/projects" },
      { scope: "global", key: "_/health", path: "/api/projects/health" },
      { scope: "project", key: "dashboard", path: "/api/loops" },
      { scope: "project", key: "controls", path: "/api/controls" },
      { scope: "loop", key: "control/<loop>", path: "/api/loops/<loop>/control" },
      { scope: "loop", key: "checkout/<loop>", path: "/api/loops/<loop>/checkout" },
      { scope: "loop", key: "history/<loop>", path: "/api/loops/<loop>/history" },
      { scope: "project", key: "notifications", path: "/api/notifications" },
      { scope: "project", key: "usage", path: "/api/usage" },
      { scope: "project", key: "setup", path: "/api/setup" },
      { scope: "project", key: "agents", path: "/api/agents" },
      { scope: "loop", key: "lineup/<loop>", path: "/api/lineup?loop=<loop>" },
      { scope: "project", key: "roots", path: "/api/roots" },
      { scope: "project", key: "jav", path: "/api/jav" },
      { scope: "project", key: "settings", path: "/api/settings" },
      { scope: "project", key: "prompts", path: "/api/settings/prompts" },
      { scope: "project", key: "sentinel", path: "/api/sentinel" },
      { scope: "project", key: "evals", path: "/api/evals" },
      { scope: "project", key: "evals-patches", path: "/api/evals/patches" },
      { scope: "project", key: "evals-set", path: "/api/evals/set" },
      { scope: "project", key: "evals-suggestions", path: "/api/evals/suggestions" },
      { scope: "project", key: "evals-inbox", path: "/api/evals/inbox" },
      { scope: "project", key: "evals-proposals", path: "/api/evals/proposals" },
      { scope: "project", key: "intake", path: "/api/intake" },
      { scope: "project", key: "intake-metrics", path: "/api/intake/metrics" },
    ]);
    // The bridge's dashboard-down probe reads `SNAPSHOT_ROUTES[0]`, which must
    // be the one route every dashboard serves.
    expect(SNAPSHOT_ROUTES[0]!.key).toBe("_/projects");
  });

  it("names no local-only route and no live output", () => {
    // Spec #165 §3: these answer 403 LocalOnly remotely, or are the SSE pane.
    const localOnly = [
      /^\/api\/github\//,
      /^\/api\/setup\//,
      /^\/api\/doctor/,
      /^\/api\/lineup\/(catalog|preview|edit|save)/,
      /^\/api\/jav\/save/,
      /^\/api\/agents\/(delete|checkout|start)/,
      /^\/api\/projects\/remove/,
      /\/output$/,
      /^\/api\/chat/,
    ];
    for (const route of SNAPSHOT_ROUTES) {
      const path = route.path.replace(/<loop>/g, "ralph").split("?")[0]!;
      for (const pattern of localOnly) expect(path, route.key).not.toMatch(pattern);
    }
  });
});

describe("the bridge's side of the boundary", () => {
  it("imports no ralph TypeScript and no dashboard module", () => {
    const IMPORTS = /(?:from\s+|import\()\s*["']([^"']+)["']/g;
    // The route table is the one dashboard module allowed: its lists are the
    // bridge's allowlist (#629), and read-only.test.ts pins that it reaches
    // only `./contracts` and the parser leaf.
    for (const file of ["collect.ts", "scrub.ts"]) {
      const imports = [...readFileSync(join(__dirname, file), "utf8").matchAll(IMPORTS)].map((match) => match[1]!);
      for (const name of imports) {
        const allowed = name === "./scrub" || name.startsWith("node:") || (file === "collect.ts" && name === "../route-table");
        expect(allowed, `${file} imports ${name}`).toBe(true);
      }
    }
  });
});

describe("pushBatches", () => {
  const sized = (key: string, bytes: number): Snapshot =>
    ({ project: "p", key, body: new Uint8Array(bytes), hash: key, bytes, readMs: 0, changed: () => true }) as Snapshot;

  it("splits pushes at 2 MB, in order", () => {
    const mb = 1024 * 1024;
    const batches = pushBatches([sized("a", mb), sized("b", 0.9 * mb), sized("c", 0.5 * mb), sized("d", 10)]);
    expect(batches.map((batch) => batch.map((entry) => entry.key))).toEqual([["a", "b"], ["c", "d"]]);
  });
});
