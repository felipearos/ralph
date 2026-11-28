// @vitest-environment node
/**
 * The bridge, driven tick by tick on a fake clock against the PGlite store
 * (`test-store.ts`, as role `ralph_bridge`) and the real local handler
 * (`createHandler`) over a scratch project. Realtime is a fake transport
 * behind the real `startWake`.
 *
 * Every assertion is on what the machine would do: which local routes it
 * reads and when, which rows it writes, and what its heartbeat reports.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createEvalsAdapter } from "../evals-adapter";
import { createAgentsAdapter } from "../agents-adapter";
import { coderRoster, GLOBAL_SNAPSHOT_PROJECT, SNAPSHOT_SCHEMA } from "../contracts";
import type { ProjectHealthView, RuntimeSnapshot } from "../contracts";
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
  cadenceClassOf,
  createBridge,
  DEFAULT_TIMINGS,
  SQL,
  timingsFromEnv,
  type Bridge,
  type BridgeOptions,
  type BridgeStore,
} from "./bridge";
import type { LocalStream, LocalStreamHandlers } from "./local-stream";
import type { Redactor } from "./scrub";
import { createTestStore, type TestStore } from "./test-store";
import { startWake, type WakeChannel, type WakeEvent, type WakeHandle, type WakeTransport } from "./wake";

subprocessSuite("boots PGlite per test and runs the bridge entrypoint under bun");

const HARNESS = join(__dirname, "..", "..");
const BRIDGE = join(__dirname, "bridge.ts");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const scratch: string[] = [];
const stores: TestStore[] = [];
const wakes: WakeHandle[] = [];
afterEach(async () => {
  await Promise.all(wakes.splice(0).map((wake) => wake.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
afterAll(() => {
  cleanupFixtures();
  scratch.splice(0).forEach((dir) => removeScratchDir(dir));
});

const failing: Executor = async () => ({ status: 1, stdout: "", stderr: "not in this fixture" });
const identity: Redactor = async (lines) => [...lines];

/** One fake clock for the bridge, the handler and the call log. */
const clock = { t: Date.parse("2026-10-09T00:00:00.000Z") };

/**
 * A project `fixture` with one live loop, `ralph`, served by the real handler.
 * Its health's needs, its usage cost and whether the dashboard answers at all
 * are the test's to set.
 */
function machine(over: { evalsExec?: Executor } = {}) {
  const f = createFixture("remote-bridge");
  const worktree = f.worktree("wt-ralph");
  mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });
  const snapshot: RuntimeSnapshot = {
    roster: coderRoster("ralph"),
    loops: [
      {
        worktree,
        identity: "ralph",
        loopStatus: "running",
        worktreeStatus: "live",
        branch: "ralph/14-thing",
        state: {
          version: 1,
          run: "run-ralph",
          owner: { loop: "ralph", pid: null, host: "test" },
          worktree,
          branch: "ralph/14-thing",
          stage: "iteration",
          iteration: { index: 1, max: 10 },
          heartbeat: "2026-10-09T00:00:00.000Z",
          lastEvent: null,
          stopReason: null,
        },
        stateProblem: null,
        supervisor: "alive",
        presence: null,
        repoUrl: "https://github.com/felipearos/loggd",
        runnerFailures: { settled: [] },
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  } as unknown as RuntimeSnapshot;
  const local = {
    needs: [] as ProjectHealthView["needs"],
    cost: 1.5,
    down: null as "refused" | "5xx" | null,
    calls: [] as { at: number; path: string }[],
    /** Runs as each local read reaches the server, before it answers. */
    onCall: null as ((path: string) => void) | null,
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
    usage: (async () => ({ project: "fixture", cost: local.cost, tokens: 1200 })) as never,
    lineup: async (request) => Response.json({ loop: new URL(request.url).searchParams.get("loop") }),
    jav,
    intake,
    evals: createEvalsAdapter({ cliDir: HARNESS, root: f.root, bunPath: "bun", exec: over.evalsExec ?? failing }),
    health: async () => ({
      project: "fixture",
      readAt: "2026-10-09T00:00:00.000Z",
      health: local.needs.length > 0 ? "needs-you" : "running",
      needsYou: local.needs.length,
      needs: local.needs,
      loops: 1,
      running: 1,
      problem: null,
    }),
  };
  const handler = createHandler({
    projects: () => [scope],
    shell: "<html></html>",
    clock: () => ({ nowMs: clock.t }),
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
  const fetchLocal = async (url: string): Promise<Response> => {
    const parsed = new URL(url);
    local.calls.push({ at: clock.t, path: `${parsed.pathname}${parsed.search}` });
    local.onCall?.(`${parsed.pathname}${parsed.search}`);
    if (local.down === "refused") throw new TypeError("Unable to connect. Is the computer able to access the url?");
    if (local.down === "5xx") return new Response("upstream gone", { status: 502 });
    return handler(new Request(url));
  };
  const notify = (id: string): void =>
    writeFileSync(
      join(worktree, ".ralph", "logs", "notifications.jsonl"),
      `${JSON.stringify({ event: "raised", id, at: "2026-10-09T00:00:00.000Z", kind: "blocked", subject: "ralph is blocked", body: "x", run: "run-ralph" })}\n`,
      { flag: "a" },
    );
  return { f, local, fetchLocal, notify, snapshot };
}

/**
 * A local change stream the test controls, in place of the real handler's
 * (which has no hub): it records opens and closes per project, and its
 * reopen timers run on the fake clock when `flush` is called.
 */
function fakeStreams() {
  const handlers = new Map<string, LocalStreamHandlers>();
  const opened: string[] = [];
  const closed: string[] = [];
  const timers = new Map<number, { due: number; fn: () => void }>();
  let ids = 0;
  const fake = {
    opened,
    closed,
    /** Every open throws, as a dashboard that refuses the stream would end it. */
    refuse: false,
    open(project: string, events: LocalStreamHandlers): LocalStream {
      opened.push(project);
      if (fake.refuse) throw new Error("refused");
      handlers.set(project, events);
      return {
        close: () => {
          if (handlers.get(project) !== events) return;
          handlers.delete(project);
          closed.push(project);
        },
      };
    },
    live: (project: string): boolean => handlers.has(project),
    /** The server answered: the stream is live. */
    accept: (project: string): void => handlers.get(project)?.onOpen(),
    emit: (project: string, key: string): void => handlers.get(project)?.onEvent({ key, version: 1 }),
    drop(project: string): void {
      const events = handlers.get(project);
      handlers.delete(project);
      events?.onEnd("stream ended");
    },
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        ids += 1;
        timers.set(ids, { due: clock.t + ms, fn });
        return ids;
      },
      clearTimeout: (handle: unknown): void => void timers.delete(handle as number),
    },
    /** Run every reopen timer the clock has reached. */
    flush(): void {
      for (const [id, timer] of timers) {
        if (timer.due > clock.t) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
  return fake;
}

/** Every local path a full push of `fixture` reads. */
const FULL = [
  "/api/projects",
  "/api/projects/health",
  "/api/p/fixture/dashboard",
  "/api/p/fixture/controls",
  "/api/p/fixture/loops/ralph/control",
  "/api/p/fixture/loops/ralph/checkout",
  "/api/p/fixture/loops/ralph/history",
  "/api/p/fixture/notifications",
  "/api/p/fixture/usage",
  "/api/p/fixture/setup",
  "/api/p/fixture/agents",
  "/api/p/fixture/lineup?loop=ralph",
  "/api/p/fixture/roots",
  "/api/p/fixture/jav",
  "/api/p/fixture/settings",
  "/api/p/fixture/settings/prompts",
  "/api/p/fixture/sentinel",
  "/api/p/fixture/evals",
  "/api/p/fixture/evals/patches",
  "/api/p/fixture/evals/set",
  "/api/p/fixture/evals/suggestions",
  "/api/p/fixture/evals/inbox",
  "/api/p/fixture/evals/proposals",
  "/api/p/fixture/intake",
  "/api/p/fixture/intake/metrics",
];

interface Rig {
  m: ReturnType<typeof machine>;
  streams: ReturnType<typeof fakeStreams>;
  store: TestStore;
  bridge: Bridge;
  /** The store as the bridge sees it: `down` makes every statement fail to connect. */
  link: { down: boolean; reject: ((text: string, params: unknown[]) => boolean) | null; queries: { at: number; text: string }[] };
  logs: string[];
  /** Advance the clock by `ms` in `step`s, ticking after each. */
  run(ms: number, step?: number): Promise<void>;
  rows(): Promise<{ project: string; key: string; version: number; problem: string | null }[]>;
  versions(): Promise<Record<string, number>>;
  bridgeRow(): Promise<Record<string, unknown>>;
  callsSince(at: number): string[];
}

async function rig({ evalsExec, ...over }: Partial<BridgeOptions> & { redact?: Redactor; evalsExec?: Executor } = {}): Promise<Rig> {
  clock.t = Date.parse("2026-10-09T00:00:00.000Z");
  const m = machine({ evalsExec });
  const store = await createTestStore();
  stores.push(store);
  const link: Rig["link"] = { down: false, reject: null, queries: [] };
  const bridgeStore: BridgeStore = {
    query: async <T>(text: string, params: unknown[]) => {
      link.queries.push({ at: clock.t, text });
      if (link.down) throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
      if (link.reject?.(text, params)) {
        throw Object.assign(new Error('new row violates check constraint "snapshot_body_check"'), { code: "23514" });
      }
      return store.as<T>("ralph_bridge", text, params);
    },
  };
  const logs: string[] = [];
  const streams = fakeStreams();
  const bridge = createBridge({
    store: bridgeStore,
    local: { base: "http://127.0.0.1:8791", fetch: m.fetchLocal, home: m.f.root, redact: over.redact ?? identity },
    now: () => clock.t,
    random: () => 0.5,
    instance: "bridge-a",
    log: (line) => logs.push(line),
    stream: streams.open,
    streamTimers: streams.timers,
    ...over,
  });
  const rows = () =>
    store.owner<{ project: string; key: string; version: number; problem: string | null }>(
      "select project, key, version::int as version, problem from ralph.snapshot order by project, key",
    );
  return {
    m,
    streams,
    store,
    bridge,
    link,
    logs,
    async run(ms, step = SECOND) {
      streams.flush();
      await bridge.tick();
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        clock.t += step;
        streams.flush();
        await bridge.tick();
      }
    },
    rows,
    async versions() {
      return Object.fromEntries((await rows()).map((row) => [`${row.project} ${row.key}`, row.version]));
    },
    async bridgeRow() {
      const [row] = await store.owner("select *, extract(epoch from lease_until - last_seen_at)::float8 as lease_s from ralph.bridge");
      return row ?? {};
    },
    callsSince: (at) => m.local.calls.filter((call) => call.at >= at).map((call) => call.path),
  };
}

/** A Realtime stand-in for the real `startWake`: it subscribes at once and lets a test broadcast. */
class FakeTransport implements WakeTransport {
  handlers = new Map<WakeEvent, (payload: unknown) => void>();
  async signIn(): Promise<string> {
    return "token";
  }
  onAuthChange(): void {}
  setAuth(): void {}
  channel(): WakeChannel {
    const channel: WakeChannel = {
      on: (event, handler) => {
        this.handlers.set(event, handler);
        return channel;
      },
      subscribe: (callback) => queueMicrotask(() => callback("SUBSCRIBED")),
      close: async () => {},
    };
    return channel;
  }
  async signOut(): Promise<void> {}
  send(event: WakeEvent, payload: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

describe("the lease", () => {
  it("pushes nothing and reads nothing locally while another bridge holds the lease, then takes it when it runs out", async () => {
    const r = await rig();
    await r.store.lease(600, "bridge-b");
    await r.run(2 * MINUTE);
    expect(r.bridge.state().leased).toBe(false);
    expect(await r.rows()).toEqual([]);
    expect(r.m.local.calls).toEqual([]);
    expect((await r.bridgeRow()).instance).toBe("bridge-b");

    await r.store.lease(-1, "bridge-b");
    await r.run(15 * SECOND);
    expect(r.bridge.state().leased).toBe(true);
    expect((await r.bridgeRow()).instance).toBe("bridge-a");
    // Taking the lease pushes a full snapshot.
    expect((await r.rows()).map((row) => `${row.project} ${row.key}`)).toContain("fixture dashboard");
  });

  it("stops writing the moment the lease is gone, even between beats", async () => {
    const r = await rig();
    await r.run(0);
    const before = await r.versions();
    await r.store.lease(600, "bridge-b");
    r.bridge.markHot("fixture", "viewer");
    r.m.local.cost = 99;
    await r.run(10 * SECOND);
    expect(await r.versions()).toEqual(before);
    expect(r.bridge.state().leased).toBe(false);
  });

  it("renews lease_until to now() + 45 s every 15 s, idle and hot alike", async () => {
    const r = await rig();
    await r.run(MINUTE);
    r.bridge.markHot("fixture", "viewer");
    await r.run(MINUTE);
    const beats = r.link.queries.filter((query) => query.text === SQL.heartbeat).map((query) => query.at - Date.parse("2026-10-09T00:00:00.000Z"));
    expect(beats).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120].map((s) => s * SECOND));
    const row = await r.bridgeRow();
    expect(row.lease_s).toBe(45);
    expect(row).toMatchObject({ instance: "bridge-a", schema: SNAPSHOT_SCHEMA, local: "ok", wake: "poll-only", controls: "disabled" });
    expect(Object.keys(row.hot as object)).toEqual(["fixture"]);
    const [{ left } = { left: 0 }] = await r.store.owner<{ left: number }>("select extract(epoch from lease_until - now())::float8 as left from ralph.bridge");
    expect(left).toBeGreaterThan(40);
    expect(left).toBeLessThanOrEqual(45);
  });
});

describe("snapshots", () => {
  it("pushes every key on start, the _/ keys under the global placeholder project", async () => {
    const r = await rig();
    await r.run(0);
    expect(r.m.local.calls.map((call) => call.path).sort()).toEqual([...FULL].sort());
    const keys = (await r.rows()).map((row) => `${row.project} ${row.key}`);
    expect(keys).toEqual(
      [
        `${GLOBAL_SNAPSHOT_PROJECT} _/health`,
        `${GLOBAL_SNAPSHOT_PROJECT} _/projects`,
        "fixture agents",
        "fixture checkout/ralph",
        "fixture control/ralph",
        "fixture controls",
        "fixture dashboard",
        "fixture evals",
        "fixture evals-inbox",
        "fixture evals-patches",
        "fixture evals-proposals",
        "fixture evals-set",
        "fixture evals-suggestions",
        "fixture history/ralph",
        "fixture intake",
        "fixture intake-metrics",
        "fixture jav",
        "fixture lineup/ralph",
        "fixture notifications",
        "fixture prompts",
        "fixture roots",
        "fixture sentinel",
        "fixture settings",
        "fixture setup",
        "fixture usage",
      ].sort(),
    );
    expect(GLOBAL_SNAPSHOT_PROJECT).toBe("_");
  });

  describe("relayed eval patches (#825)", () => {
    const PATCH = "diff --git a/app.ts b/app.ts\n+// patch-825-marker: only on this host\n";
    const view = { version: 1, runs: [{ id: "eval-1", cases: [], dir: "eval-1" }], lineups: [], defaults: { panel: [], trialMinutes: 90, repeats: 2 }, history: { trialSeconds: null, trialTokens: null, trials: 0 } };
    /** An experiments.ts that has the patch on disk and prints `patches` as the project's flag says. */
    const evalsExec = (enabled: boolean): Executor => async ({ args }) => {
      const verb = args[1];
      if (verb === "runs") return { status: 0, stdout: JSON.stringify({ ...view, relayPatches: enabled }), stderr: "" };
      if (verb === "patch" && args.slice(2).join("/") === "eval-1/14/ralph") return { status: 0, stdout: PATCH, stderr: "" };
      if (verb === "patches") {
        const patches = enabled ? [{ run: "eval-1", case: "14", arm: "ralph", text: PATCH, truncated: false }] : [];
        return { status: 0, stdout: JSON.stringify({ version: 1, enabled, patches, omitted: 0 }), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "not in this fixture" };
    };
    /** Every body the bridge stored, gunzipped as the bridge reads them back. */
    const stored = async (r: Rig): Promise<Record<string, string>> => {
      const rows = await r.store.owner<{ key: string; body: Uint8Array | null }>("select key, body from ralph.snapshot where body is not null");
      return Object.fromEntries(rows.map((row) => [row.key, gunzipSync(Buffer.from(row.body!)).toString("utf8")]));
    };

    it("with the flag off, no patch reaches the hosted store", async () => {
      const r = await rig({ evalsExec: evalsExec(false) });
      await r.run(0);
      const bodies = await stored(r);
      expect(Object.keys(bodies)).toContain("evals");
      for (const [key, body] of Object.entries(bodies)) expect(body, key).not.toContain("patch-825-marker");
      expect(JSON.parse(bodies["evals-patches"]!)).toMatchObject({ enabled: false, patches: [] });
    });

    it("with the flag on, the stored evals-patches body carries the patch, named by its trial", async () => {
      const r = await rig({ evalsExec: evalsExec(true) });
      await r.run(0);
      const patches = JSON.parse((await stored(r))["evals-patches"]!) as { enabled: boolean; patches: unknown[] };
      expect(patches.enabled).toBe(true);
      expect(patches.patches).toEqual([{ run: "eval-1", case: "14", arm: "ralph", text: PATCH, truncated: false }]);
    });
  });

  it("reads dashboard at most once per 5 min per project while idle, and _/health every minute", async () => {
    const r = await rig();
    await r.run(20 * MINUTE, 5 * SECOND);
    const at = (path: string) => r.m.local.calls.filter((call) => call.path === path).map((call) => call.at);
    const dashboard = at("/api/p/fixture/dashboard");
    expect(dashboard).toHaveLength(5);
    for (let i = 1; i < dashboard.length; i++) expect(dashboard[i]! - dashboard[i - 1]!).toBeGreaterThanOrEqual(5 * MINUTE);
    const health = at("/api/projects/health");
    expect(health).toHaveLength(21);
    expect(at("/api/p/fixture/usage")).toHaveLength(2);
  });

  it("writes zero rows for keys that did not change but for generatedAt/readAt, and only the key that did", async () => {
    const r = await rig();
    await r.run(0);
    const before = await r.versions();
    // Hot: every key is read again and again, each with a fresh generatedAt.
    r.bridge.markHot("fixture", "viewer");
    await r.run(2 * MINUTE);
    expect(r.callsSince(clock.t - MINUTE).filter((path) => path === "/api/p/fixture/dashboard").length).toBeGreaterThan(5);
    expect(await r.versions()).toEqual(before);

    r.m.local.cost = 2.5;
    r.bridge.markHot("fixture", "viewer");
    await r.run(30 * SECOND);
    const after = await r.versions();
    expect(after["fixture usage"]).toBe(before["fixture usage"]! + 1);
    expect({ ...after, "fixture usage": 0 }).toEqual({ ...before, "fixture usage": 0 });
  });

  it("backs a key off to twice its last read time when the host is slow", async () => {
    const r = await rig();
    // Every local read takes 20 s of wall time, as `readMs` sees it.
    const slow = r.m.fetchLocal;
    const local = { base: "http://127.0.0.1:8791", home: r.m.f.root, redact: identity };
    let reads = 0;
    const bridge = createBridge({
      store: { query: (text, params) => r.store.as("ralph_bridge", text, params) },
      local: {
        ...local,
        fetch: async (url) => {
          reads += 1;
          const response = await slow(url);
          clock.t += 20 * SECOND;
          return response;
        },
      },
      now: () => clock.t,
      instance: "bridge-slow",
      log: () => {},
      stream: fakeStreams().open,
    });
    await r.store.lease(-1, "nobody");
    bridge.markHot("fixture", "viewer");
    await bridge.tick();
    const start = clock.t;
    const dashboardAt: number[] = [];
    while (clock.t - start < 5 * MINUTE) {
      const before = r.m.local.calls.length;
      clock.t += SECOND;
      await bridge.tick();
      if (r.m.local.calls.slice(before).some((call) => call.path === "/api/p/fixture/dashboard")) dashboardAt.push(clock.t);
    }
    expect(reads).toBeGreaterThan(0);
    // Hot is 5 s, but a read that took 20 s waits at least 40 s.
    for (let i = 1; i < dashboardAt.length; i++) expect(dashboardAt[i]! - dashboardAt[i - 1]!).toBeGreaterThanOrEqual(40 * SECOND);
  });

  it("logs and skips a key the database rejects, without retrying it in a loop", async () => {
    const r = await rig();
    r.link.reject = (text, params) => text === SQL.push && params[2] === "usage";
    await r.run(MINUTE);
    const keys = (await r.rows()).map((row) => row.key);
    expect(keys).not.toContain("usage");
    expect(keys).toContain("dashboard");
    const attempts = r.link.queries.filter((query) => query.text === SQL.push).length;
    expect(r.logs.filter((line) => line.includes("rejected fixture usage"))).toHaveLength(1);
    // Idle, usage is next read in 15 min: no write is tried in between.
    await r.run(5 * MINUTE, 5 * SECOND);
    expect(r.logs.filter((line) => line.includes("rejected fixture usage"))).toHaveLength(1);
    expect(r.link.queries.filter((query) => query.text === SQL.push).length).toBe(attempts);
    expect(r.bridge.state().connected).toBe(true);
  });
});

describe("hot", () => {
  it("turns a project hot on a viewer wake-up and pushes the whole project at once", async () => {
    const r = await rig();
    const transport = new FakeTransport();
    wakes.push(
      startWake({
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_test",
        email: "bridge@ralph.invalid",
        password: "pw",
        channelFactory: () => transport,
        ...r.bridge.wake,
      }),
    );
    await r.run(10 * MINUTE, 5 * SECOND);
    expect(r.bridge.state().hot).toEqual({});
    await r.run(15 * SECOND);
    expect((await r.bridgeRow()).wake).toBe("realtime");

    transport.send("viewer", { project: "fixture" });
    const at = clock.t;
    await r.run(SECOND);
    expect([...r.callsSince(at)].sort()).toEqual([...FULL].sort());
    expect(Object.keys(r.bridge.state().hot)).toEqual(["fixture"]);
    // Hot: dashboard every 5 s.
    await r.run(30 * SECOND);
    expect(r.callsSince(at).filter((path) => path === "/api/p/fixture/dashboard").length).toBeGreaterThanOrEqual(6);
    // And idle again once the viewer has been gone 120 s.
    await r.run(2 * MINUTE);
    expect(r.bridge.state().hot).toEqual({});
  });

  it("turns a project hot from a viewer row read on the heartbeat, when the wake-up was missed", async () => {
    const r = await rig();
    await r.run(10 * MINUTE, 5 * SECOND);
    await r.store.as("ralph_web", "insert into ralph.viewer (project, last_seen_at) values ('fixture', now())");
    const at = clock.t + SECOND;
    await r.run(15 * SECOND);
    expect(Object.keys(r.bridge.state().hot)).toEqual(["fixture"]);
    expect(r.callsSince(at)).toEqual(expect.arrayContaining(FULL));
    // One full push, not one per beat while the row stays fresh.
    await r.run(30 * SECOND);
    expect(r.callsSince(at).filter((path) => path === "/api/p/fixture/setup")).toHaveLength(2);
  });

  it("makes a project hot for 20 min on a new approval or errored need, with no viewer", async () => {
    for (const reason of ["approval", "errored"] as const) {
      const r = await rig();
      await r.run(5 * MINUTE, 5 * SECOND);
      r.m.local.needs = [{ loop: "ralph", reason }];
      await r.run(MINUTE, 5 * SECOND);
      expect(Object.keys(r.bridge.state().hot), reason).toEqual(["fixture"]);
      expect(r.logs.some((line) => line.startsWith(`attention: ralph ${reason}`))).toBe(true);
      // Still there, but no longer new: it does not extend the 20 min.
      await r.run(20 * MINUTE, 10 * SECOND);
      expect(r.bridge.state().hot).toEqual({});
    }
  });

  it("does not turn hot on a new blocked need or a new notification", async () => {
    const r = await rig();
    await r.run(5 * MINUTE, 5 * SECOND);
    r.m.local.needs = [{ loop: "ralph", reason: "blocked" }];
    r.m.notify("n-1");
    await r.run(20 * MINUTE, 10 * SECOND);
    expect(r.bridge.state().hot).toEqual({});
    // The notification still reached the store, at the idle cadence.
    const versions = await r.versions();
    expect(versions["fixture notifications"]).toBe(2);
  });

  it("does not count needs already there on the first read as new", async () => {
    const r = await rig();
    r.m.local.needs = [{ loop: "ralph", reason: "approval" }];
    await r.run(3 * MINUTE, 5 * SECOND);
    expect(r.bridge.state().hot).toEqual({});
  });
});

describe("the local change stream", () => {
  const DASHBOARD = "/api/p/fixture/dashboard";
  const loopReads = (r: Rig): number[] => r.m.local.calls.filter((call) => call.path === DASHBOARD).map((call) => call.at);
  /** A change the `dashboard` key reflects. */
  const moveBranch = (r: Rig, branch: string): void => {
    (r.m.snapshot.loops[0] as unknown as { branch: string }).branch = branch;
  };

  it("reads and pushes a key the stream names within 2 s while hot, well before its 5 s cadence", async () => {
    const r = await rig();
    r.bridge.markHot("fixture", "viewer");
    await r.run(0);
    expect(r.streams.opened).toEqual(["fixture"]);
    r.streams.accept("fixture");
    await r.run(3 * SECOND);
    const before = await r.versions();
    const previous = loopReads(r).at(-1)!;

    moveBranch(r, "ralph/15-other");
    r.streams.emit("fixture", "dashboard");
    const emitted = clock.t;
    await r.run(2 * SECOND);
    // `run` ticks at the current time first: the read may land on the emit's own tick.
    const next = loopReads(r).find((at) => at >= emitted)!;
    expect(next - emitted).toBeLessThanOrEqual(2 * SECOND);
    expect(next - previous).toBeLessThan(5 * SECOND);
    expect((await r.versions())["fixture dashboard"]).toBe(before["fixture dashboard"]! + 1);
  });

  it("keeps a mark that lands while the key's read is on the wire, and reads it again on the next tick", async () => {
    const r = await rig();
    r.bridge.markHot("fixture", "viewer");
    await r.run(0);
    r.streams.accept("fixture");
    await r.run(6 * SECOND);
    // The next cadence read of `dashboard` sees the old state; the change and
    // its event land while that read is still in flight.
    r.m.local.onCall = (path) => {
      if (path !== DASHBOARD) return;
      r.m.local.onCall = null;
      moveBranch(r, "ralph/16-raced");
      r.streams.emit("fixture", "dashboard");
    };
    const before = await r.versions();
    await r.run(6 * SECOND);
    expect(r.m.local.onCall).toBeNull();
    const reads = loopReads(r);
    // The in-flight read, then a second one at most a tick or two later, not 5 s.
    expect(reads.at(-1)! - reads.at(-2)!).toBeLessThanOrEqual(2 * SECOND);
    expect((await r.versions())["fixture dashboard"]).toBe(before["fixture dashboard"]! + 1);
  });

  it("ignores keys it does not know and never opens a stream for an idle project", async () => {
    const r = await rig();
    await r.run(10 * MINUTE, 5 * SECOND);
    expect(r.streams.opened).toEqual([]);
    const dashboard = loopReads(r);
    expect(dashboard).toHaveLength(3);
    for (let i = 1; i < dashboard.length; i++) expect(dashboard[i]! - dashboard[i - 1]!).toBeGreaterThanOrEqual(5 * MINUTE);

    r.bridge.markHot("fixture", "viewer");
    await r.run(10 * SECOND);
    const reads = r.m.local.calls.length;
    r.streams.emit("fixture", "no-such-key");
    r.streams.emit("fixture", "_/health");
    await r.run(SECOND);
    expect(r.m.local.calls.length).toBe(reads);
  });

  it("still waits twice a key's last read time before an event-triggered read", async () => {
    const r = await rig();
    const streams = fakeStreams();
    const bridge = createBridge({
      store: { query: (text, params) => r.store.as("ralph_bridge", text, params) },
      local: {
        base: "http://127.0.0.1:8791",
        home: r.m.f.root,
        redact: identity,
        fetch: async (url) => {
          const response = await r.m.fetchLocal(url);
          clock.t += 20 * SECOND;
          return response;
        },
      },
      now: () => clock.t,
      instance: "bridge-slow",
      log: () => {},
      stream: streams.open,
      streamTimers: streams.timers,
    });
    await r.store.lease(-1, "nobody");
    bridge.markHot("fixture", "viewer");
    await bridge.tick();
    streams.accept("fixture");
    const start = clock.t;
    const dashboardAt: number[] = [];
    // Each read costs 20 s of the clock, so this window holds only a few.
    while (clock.t - start < 30 * MINUTE) {
      const before = r.m.local.calls.length;
      clock.t += SECOND;
      bridge.markHot("fixture", "viewer");
      streams.emit("fixture", "dashboard");
      await bridge.tick();
      if (r.m.local.calls.slice(before).some((call) => call.path === DASHBOARD)) dashboardAt.push(clock.t);
    }
    expect(dashboardAt.length).toBeGreaterThan(1);
    for (let i = 1; i < dashboardAt.length; i++) expect(dashboardAt[i]! - dashboardAt[i - 1]!).toBeGreaterThanOrEqual(40 * SECOND);
    await bridge.release();
  });

  it("keeps the hot cadence when the stream is refused, and logs it once", async () => {
    const r = await rig();
    r.streams.refuse = true;
    r.bridge.markHot("fixture", "viewer");
    await r.run(0);
    const start = clock.t;
    await r.run(30 * SECOND);
    expect(r.streams.opened.length).toBeGreaterThan(1);
    expect(loopReads(r).filter((at) => at > start).length).toBeGreaterThanOrEqual(6);
    expect(r.logs.filter((line) => line.startsWith("local stream fixture:"))).toHaveLength(1);
  });

  it("falls back to the timers when the stream drops, reopens it on back-off, and reads dashboard on reopen", async () => {
    const r = await rig();
    r.bridge.markHot("fixture", "viewer");
    await r.run(0);
    r.streams.accept("fixture");
    await r.run(SECOND);
    r.streams.drop("fixture");
    expect(r.streams.live("fixture")).toBe(false);
    expect(r.logs.filter((line) => line.startsWith("local stream fixture:"))).toHaveLength(1);
    // Back-off starts near 2 s; meanwhile the 5 s cadence still reads.
    const dropped = clock.t;
    await r.run(6 * SECOND);
    expect(r.streams.opened).toEqual(["fixture", "fixture"]);
    expect(r.streams.live("fixture")).toBe(true);
    expect(loopReads(r).filter((at) => at > dropped).length).toBeGreaterThanOrEqual(1);

    const last = loopReads(r).at(-1)!;
    clock.t = Math.max(clock.t, last + SECOND);
    r.streams.accept("fixture");
    const reopened = clock.t;
    await r.run(SECOND);
    const after = loopReads(r).filter((at) => at >= reopened);
    expect(after.length).toBeGreaterThanOrEqual(1);
    // Sooner than the 5 s cadence would have read it.
    expect(after[0]! - last).toBeLessThan(5 * SECOND);
  });

  it("closes the stream when the project cools, when the lease is lost, and on release", async () => {
    const cools = await rig();
    cools.bridge.markHot("fixture", "viewer");
    await cools.run(0);
    expect(cools.streams.live("fixture")).toBe(true);
    await cools.run(2 * MINUTE + 5 * SECOND, 5 * SECOND);
    expect(cools.bridge.state().hot).toEqual({});
    expect(cools.streams.closed).toEqual(["fixture"]);

    const lost = await rig();
    lost.bridge.markHot("fixture", "viewer");
    await lost.run(0);
    await lost.store.lease(600, "bridge-b");
    await lost.run(20 * SECOND);
    expect(lost.bridge.state().leased).toBe(false);
    expect(lost.streams.closed).toEqual(["fixture"]);

    const released = await rig();
    released.bridge.markHot("fixture", "viewer");
    await released.run(0);
    await released.bridge.release();
    expect(released.streams.closed).toEqual(["fixture"]);
  });
});

describe("failures", () => {
  it("reads nothing locally while the store is unreachable, and pushes a full snapshot on reconnect", async () => {
    const r = await rig();
    await r.run(MINUTE);
    r.link.down = true;
    await r.run(20 * SECOND);
    expect(r.bridge.state().connected).toBe(false);
    const reads = r.m.local.calls.length;
    await r.run(10 * MINUTE, 5 * SECOND);
    expect(r.m.local.calls.length).toBe(reads);
    // Retried on the backoff, not every tick.
    const attempts = r.link.queries.filter((query) => query.text === SQL.heartbeat && query.at > clock.t - 10 * MINUTE).length;
    expect(attempts).toBeLessThan(10);

    r.m.local.cost = 7;
    r.link.down = false;
    const back = clock.t;
    await r.run(6 * MINUTE, 5 * SECOND);
    expect(r.bridge.state()).toMatchObject({ connected: true, leased: true });
    expect(r.callsSince(back)).toEqual(expect.arrayContaining(FULL));
    const versions = await r.versions();
    expect(versions["fixture usage"]).toBe(2);
    expect(versions["fixture dashboard"]).toBe(1);
  });

  it.each([["refused" as const], ["5xx" as const]])(
    "heartbeats with local: dashboard-down when the dashboard is %s, probes every 10 s, and pushes everything once it is back",
    async (how) => {
      const r = await rig();
      await r.run(MINUTE);
      r.m.local.down = how;
      await r.run(MINUTE + 15 * SECOND);
      expect(r.bridge.state().local).toBe("dashboard-down");
      expect((await r.bridgeRow()).local).toBe("dashboard-down");
      const since = clock.t;
      await r.run(MINUTE);
      const calls = r.callsSince(since + 1);
      expect(new Set(calls)).toEqual(new Set(["/api/projects"]));
      expect(calls).toHaveLength(6);
      // The heartbeat went on all along.
      expect(r.link.queries.filter((query) => query.text === SQL.heartbeat && query.at > since)).toHaveLength(4);

      r.m.local.down = null;
      const back = clock.t;
      await r.run(15 * SECOND);
      expect(r.bridge.state().local).toBe("ok");
      expect(r.callsSince(back)).toEqual(expect.arrayContaining(FULL));
      expect((await r.bridgeRow()).local).toBe("ok");
    },
  );

  it("pushes nothing and reports redactor-degraded when the redactor fails", async () => {
    const r = await rig({ redact: async () => Promise.reject(new Error("runner-signals.json is unreadable")) });
    await r.run(MINUTE);
    expect(await r.rows()).toEqual([]);
    expect(r.bridge.state().local).toBe("redactor-degraded");
    expect((await r.bridgeRow()).local).toBe("redactor-degraded");
    // Retried every 10 s, not every tick.
    expect(r.m.local.calls.filter((call) => call.path === "/api/projects").length).toBeLessThanOrEqual(8);
  });
});

describe("hooks for the relay", () => {
  it("hands wake-ups and sweeps to a registered relay, and reports controls enabled unless the kill switch is off", async () => {
    for (const controls of ["on", "off"] as const) {
      const r = await rig({ controls });
      const seen: string[] = [];
      r.bridge.relay({ onCommand: ({ id }) => void seen.push(id), onSweep: () => void seen.push("sweep") });
      r.bridge.wake.onCommand({ project: "fixture", id: "c-1" });
      r.bridge.wake.onSweep();
      await r.run(0);
      expect(seen).toEqual(["c-1", "sweep"]);
      expect((await r.bridgeRow()).controls).toBe(controls === "on" ? "enabled" : "disabled");
    }
  });
});

describe("knobs", () => {
  it("classes keys as the spec's cadence table does", () => {
    expect(["dashboard", "controls", "control/ralph"].map(cadenceClassOf)).toEqual(["live", "live", "live"]);
    expect(["usage", "notifications", "sentinel", "evals", "evals-patches", "history/ralph"].map(cadenceClassOf)).toEqual([
      "feed",
      "feed",
      "feed",
      "feed",
      "feed",
      "feed",
    ]);
    expect(["_/health", "_/projects"].map(cadenceClassOf)).toEqual(["global", "global"]);
    // The test set changes only on an operator's write (#856).
    expect(cadenceClassOf("evals-set")).toBe("config");
    // The suggestions cost gh calls per read and merged PRs move slowly (#858).
    expect(cadenceClassOf("evals-suggestions")).toBe("config");
    // The inbox changes only on an operator's or an agent's write (#872).
    expect(cadenceClassOf("evals-inbox")).toBe("config");
    // A proposal's status moves as its subset and full-set runs do (#874).
    expect(cadenceClassOf("evals-proposals")).toBe("feed");
    expect(["setup", "agents", "checkout/ralph", "jav", "settings", "prompts", "lineup/ralph", "roots"].map(cadenceClassOf)).toEqual(Array(8).fill("config"));
  });

  it("reads RALPH_BRIDGE_* overrides and ignores nonsense", () => {
    const timings = timingsFromEnv({ RALPH_BRIDGE_LIVE_IDLE_MS: "60000", RALPH_BRIDGE_HEARTBEAT_MS: "nope", RALPH_BRIDGE_ATTENTION_MS: "-1" });
    expect(timings.cadence.live).toEqual({ hot: 5_000, idle: 60_000 });
    expect(timings.heartbeatMs).toBe(DEFAULT_TIMINGS.heartbeatMs);
    expect(timings.attentionMs).toBe(DEFAULT_TIMINGS.attentionMs);
    expect(DEFAULT_TIMINGS.leaseMs).toBe(45_000);
    expect(timingsFromEnv({ RALPH_BRIDGE_LEASE_MS: "5000" }).leaseMs).toBe(5_000);
  });
});

describe("one bridge per machine", () => {
  it("exits 0 with 'already running' while another process holds the lock", async () => {
    const runtime = mkdtempSync(join(tmpdir(), "ralph-bridge-lock-"));
    scratch.push(runtime);
    const env: Record<string, string | undefined> = { ...process.env, XDG_RUNTIME_DIR: runtime };
    for (const name of Object.keys(env)) if (name.startsWith("RALPH_BRIDGE_") || name.startsWith("SUPABASE_")) delete env[name];

    const holder = spawn(
      bunPath(),
      ["-e", `const { takeLock, lockPath } = await import(${JSON.stringify(BRIDGE)}); if (!(await takeLock(lockPath()))) process.exit(2); console.log("held"); setInterval(() => {}, 1000);`],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("held") && resolve());
        holder.on("exit", (code) => reject(new Error(`the lock holder exited ${code}`)));
      });
      const second = spawnSync(bunPath(), [BRIDGE], { env, encoding: "utf8" });
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("already running");
    } finally {
      holder.kill("SIGKILL");
    }
    await new Promise((resolve) => holder.once("close", resolve));

    // With the lock free it gets past it, and stops at its missing config.
    const alone = spawnSync(bunPath(), [BRIDGE], { env, encoding: "utf8" });
    expect(alone.status).toBe(1);
    expect(alone.stderr).toContain("missing RALPH_BRIDGE_DATABASE_URL");
  });
});
