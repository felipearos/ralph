// @vitest-environment node
/**
 * The command relay, end to end on one machine: the Vercel handler inserts a
 * row into the PGlite store (`test-store.ts`), the store's wake-up (recorded
 * by its `realtime.send` shim) or a sweep reaches the relay, and the relay
 * POSTs to the real local handler (`createHandler`) over a scratch checkout,
 * whose control, lifecycle, Stop now and records adapters are the real ones.
 * Only subprocesses are faked: `controls.ts status`, `loop-state.ts` and
 * `start.sh` answer from a script.
 *
 * Every assertion is on what the machine would do: which local routes were
 * POSTed, what landed in the loop's inbox and audit file, and what the row
 * and the remote answer say.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { subprocessSuite } from "../../test-timeouts";

import { coderRoster } from "../contracts";
import type { Liveness, ProjectSetupView, RelayAccepted, RelayedCommandKind, RuntimeSnapshot } from "../contracts";
import { createRalphControlAdapter, type ExecResult, type Executor, type Invocation } from "../control-adapter";
import { createInterruptAdapter } from "../interrupt-adapter";
import { createRalphLifecycleAdapter } from "../lifecycle-adapter";
import type { Onboarding } from "../onboarding";
import { createRecordsAdapter } from "../records-adapter";
import { createHandler } from "../server";
import { createBridge, type BridgeStore } from "./bridge";
import { createRemoteHandler } from "./handler";
import { createRelay, KILL_SWITCH_WHY, PRUNE_EVERY_MS, RELAY_ROUTES, RELAY_SQL, RESTARTED_WHY, type Relay, type RelayOptions } from "./relay";
import { createTestStore, type TestStore } from "./test-store";
import { SWEEP_EVERY_MS, startWake, type WakeChannel, type WakeEvent, type WakeTransport } from "./wake";

subprocessSuite("spawns a pid probe and initialises a real PGlite store before measuring relay latency");

const ORIGIN = "https://ralph-dashboard.example.test";
const LOCAL = "http://127.0.0.1:8791";
const HARNESS = "/harness";

const roots: string[] = [];
const stores: TestStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A pid that named a process and no longer does. */
const deadPid = (): number => spawnSync("true").pid!;

/** A control record whose `applied` holds `keys`, as `controls.ts status --json` prints it. */
const recordOf = (keys: string[]) => ({
  version: 1,
  ralphRun: "run-1",
  loop: "ralph",
  applied: keys.map((key) => ({ key, command: "pause", outcome: "applied", at: "2026-10-09T00:00:00.000Z", why: "paused" })),
  deferrals: [],
  hold: null,
  stop: null,
});

/**
 * The project `fixture` with one loop, `ralph`, at run-1, behind the real
 * local handler. `script` is what the faked subprocesses answer; `posts` is
 * every request the relay made, with the local answer as text.
 */
function machine(label: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-relay-${label}-`)));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  const state = {
    version: 1 as const,
    run: "run-1",
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree: root,
    branch: "ralph/14-thing",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-10-09T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  writeFileSync(join(root, ".ralph", "logs", "state.json"), JSON.stringify(state));
  writeFileSync(join(root, ".ralph", "logs", "supervisor.pid"), `${deadPid()}\n`);
  const runtime = {
    roster: coderRoster("ralph"),
    loops: [
      {
        worktree: root,
        identity: "ralph",
        loopStatus: "running",
        worktreeStatus: "live",
        branch: "ralph/14-thing",
        state,
        stateProblem: null,
        supervisor: "alive",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  } as unknown as RuntimeSnapshot;

  const script = {
    ready: true,
    down: false,
    record: () => null as unknown,
    liveness: (): Liveness => "alive",
  };
  const starts: Invocation[] = [];
  const exec: Executor = async (invocation): Promise<ExecResult> => {
    if (invocation.command.endsWith("start.sh")) {
      starts.push(invocation);
      return { status: 0, stdout: "Started Ralph supervisor (pid 5151); waits 300s.\n", stderr: "" };
    }
    if (invocation.args.some((arg) => arg.endsWith("loop-state.ts"))) {
      const loop = { worktree: root, worktreeStatus: "live", loopStatus: "running", branch: "ralph/14-thing", state: null, stateProblem: null, supervisor: script.liveness() };
      return { status: 0, stdout: JSON.stringify({ self: root, loops: [loop], reconciliation: { orphaned: [], prunable: [] } }), stderr: "" };
    }
    if (invocation.args.some((arg) => arg.endsWith("controls.ts"))) {
      const record = script.record();
      return { status: 0, stdout: record === null ? "null" : JSON.stringify(record), stderr: "" };
    }
    if (invocation.command === "git") return { status: 0, stdout: "", stderr: "" };
    return { status: 127, stdout: "", stderr: `not in this fixture: ${invocation.command}` };
  };
  const control = (worktree: string) => createRalphControlAdapter({ cliDir: HARNESS, root: worktree, bunPath: "bun", env: {}, exec });
  const onboarding = {
    status: async (): Promise<ProjectSetupView> => ({
      project: "fixture",
      status: script.ready ? "ready" : "needs-setup",
      baseBranch: "main",
      pr: null,
    }),
  } as unknown as Onboarding;
  const handler = createHandler({
    projects: () => [
      {
        project: { id: "fixture", path: root, addedAt: "2026-10-01T00:00:00.000Z", source: "local" as const },
        adapter: { read: async () => runtime },
      },
    ],
    shell: "<html></html>",
    clock: () => ({ nowMs: Date.parse("2026-10-09T12:00:00.000Z") }),
    controls: ({ worktree }) => ({ adapter: control(worktree) }),
    lifecycle: ({ worktree }) => ({
      control: control(worktree),
      lifecycle: createRalphLifecycleAdapter({ cliDir: HARNESS, root: worktree, bunPath: "bun", env: {}, exec }),
      sleep: async () => {},
      waitTimeoutMs: 0,
      pollIntervalMs: 1,
    }),
    interrupt: ({ worktree }) => ({ interrupt: createInterruptAdapter({ root: worktree }), control: control(worktree) }),
    records: (worktree) => createRecordsAdapter({ root: worktree }),
    onboarding,
  });

  const posts: { method: string; path: string; body: Record<string, unknown> | null; status: number; text: string }[] = [];
  const fetchLocal = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (script.down) throw new TypeError("Unable to connect. Is the computer able to access the url?");
    const response = await handler(new Request(url, init));
    const text = await response.text();
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    posts.push({ method: init.method ?? "GET", path: new URL(url).pathname, body, status: response.status, text });
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const inbox = (): Record<string, unknown>[] => {
    const dir = join(root, ".ralph", "control", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>);
  };
  const audit = (): Record<string, unknown>[] => {
    const path = join(root, ".ralph", "control", "signals.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return { root, handler, script, starts, posts, fetchLocal, inbox, audit, sent: () => posts.filter((post) => post.method === "POST") };
}

type Machine = ReturnType<typeof machine>;

interface Rig {
  m: Machine;
  store: TestStore;
  relay: Relay;
  hot: string[];
  logs: string[];
  /** The store as role `ralph_bridge`, as the relay uses it. */
  bridgeStore: BridgeStore;
  /** Another relay over the same machine and store, as another bridge process. */
  another(instance: string, over?: Partial<RelayOptions>): Relay;
  /** Insert a row as the app would (body.id and body.via injected), returning its id. */
  insert(kind: RelayedCommandKind, body: Record<string, unknown>, ttl?: string, age?: string): Promise<string>;
  row(id: string): Promise<Record<string, unknown>>;
  /** Hand the relay every wake-up the store has broadcast since the last call. */
  deliverWakes(relay?: Relay): Promise<number>;
}

async function rig(label: string, over: Partial<RelayOptions> = {}): Promise<Rig> {
  const m = machine(label);
  const store = await createTestStore();
  stores.push(store);
  await store.lease(45, "bridge-a");
  const bridgeStore: BridgeStore = { query: (text, params) => store.as("ralph_bridge", text, params) };
  const hot: string[] = [];
  const logs: string[] = [];
  const make = (instance: string, extra: Partial<RelayOptions> = {}): Relay =>
    createRelay({
      store: bridgeStore,
      instance,
      base: LOCAL,
      fetch: m.fetchLocal,
      localUp: () => !m.script.down,
      markHot: (project) => hot.push(project),
      sleep: async () => {},
      log: (line) => logs.push(line),
      ...over,
      ...extra,
    });
  const relay = make("bridge-a");
  let seen = 0;
  return {
    m,
    store,
    relay,
    hot,
    logs,
    bridgeStore,
    another: make,
    async insert(kind, body, ttl = "5 minutes", age = "0 seconds") {
      const id = crypto.randomUUID();
      await store.owner(
        `insert into ralph.command (id, project, kind, body, created_at, expires_at)
         values ($1, 'fixture', $2, $3::jsonb, now() - $5::interval, now() - $5::interval + $4::interval)`,
        [id, kind, JSON.stringify({ ...body, id, via: "remote" }), ttl, age],
      );
      return id;
    },
    async row(id) {
      const [row] = await store.owner("select * from ralph.command where id = $1", [id]);
      return row!;
    },
    async deliverWakes(target = relay) {
      const wakes = (await store.sent()).filter((wake) => wake.event === "command").slice(seen);
      seen += wakes.length;
      for (const wake of wakes) await target.onCommand(wake.payload as { project: string; id: string });
      await target.idle();
      return wakes.length;
    },
  };
}

/** The Vercel function over the same store, as `ralph_web`. */
const remote = (store: TestStore) => {
  const handler = createRemoteHandler({ sql: (query, params = []) => store.as("ralph_web", query, [...params]), waitMs: 10_000, pollMs: 20 });
  return (path: string, body: unknown) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(body),
      }),
    );
};

/** POST through the app while the relay answers its wake-ups; resolves to the app's answer. */
async function click(r: Rig, route: string, body: unknown): Promise<{ status: number; text: string; ms: number }> {
  const started = Date.now();
  const answering = remote(r.store)(`/api/p/fixture/${route}`, body);
  let settled = false;
  void answering.finally(() => (settled = true));
  while (!settled) {
    await r.deliverWakes();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const response = await answering;
  return { status: response.status, text: await response.text(), ms: Date.now() - started };
}

/* ------------------------------------------------------------------- tests */

describe("a command fired by a wake-up", () => {
  it("lands in the local inbox as one command file via remote, and the row ends done with the local ControlResult within 3 s", async () => {
    const r = await rig("pause");
    const answer = await click(r, "control", { loop: "ralph", action: "pause", why: "lunch" });

    expect(answer.ms).toBeLessThan(3_000);
    expect(answer.status).toBe(200);
    const [command, ...others] = r.m.inbox();
    expect(others).toEqual([]);
    expect(command).toMatchObject({ command: "pause", loop: "ralph", why: "lunch", via: "remote" });

    const [row] = await r.store.owner<Record<string, unknown>>("select * from ralph.command");
    expect(row).toMatchObject({ kind: "control", state: "done", http_status: 200, claimed_by: "bridge-a", attempts: 1, why: null });
    expect(command!.id).toBe(row!.id);
    expect(row!.result).toMatchObject({ action: "pause", key: row!.id, outcome: "applied" });
    // The answer the operator got is the local route's, byte for byte.
    expect(answer.text).toBe(r.m.sent()[0]!.text);
    // History says who sent it.
    const history = await (await r.m.handler(new Request(`${LOCAL}/api/p/fixture/loops/ralph/history`))).json();
    expect((history as { entries: { id: string; via: string | null }[] }).entries).toContainEqual(expect.objectContaining({ id: row!.id, via: "remote" }));
    // And the project turns hot, so the next push shows it.
    expect(r.hot).toEqual(["fixture"]);
  });

  it("answers each refusal exactly as the local route does", async () => {
    const r = await rig("refusals");

    const replaced = await click(r, "control", { loop: "ralph", action: "pause", run: "run-0" });
    expect(replaced.status).toBe(200);
    expect(JSON.parse(replaced.text)).toMatchObject({ outcome: "needs-reconfirmation" });
    expect(r.m.inbox()).toEqual([]);

    const stopNow = await click(r, "stop-now", { loop: "ralph", confirm: true, why: "held a turn open" });
    expect(stopNow.status).toBe(200);
    const stopped = JSON.parse(stopNow.text) as { outcome: string; checks: { check: string; ok: boolean }[]; signals: unknown[] };
    expect(stopped.outcome).toBe("refused");
    expect(stopped.checks.find((check) => !check.ok)?.check).toBe("alive");
    expect(stopped.signals).toEqual([]);
    expect(r.m.audit()).toEqual([expect.objectContaining({ event: "refused", via: "remote" })]);
    const history = (await (await r.m.handler(new Request(`${LOCAL}/api/p/fixture/loops/ralph/history`))).json()) as {
      entries: { source: string; failedCheck: string | null; via: string | null }[];
    };
    expect(history.entries.find((entry) => entry.source === "signal")).toMatchObject({ failedCheck: "alive", via: "remote" });

    r.m.script.ready = false;
    const notReady = await click(r, "start", { loop: "ralph" });
    expect(notReady.status).toBe(409);
    expect(JSON.parse(notReady.text)).toMatchObject({ error: "ProjectNotReady", status: "needs-setup" });
    expect(r.m.starts).toEqual([]);

    const rows = await r.store.owner<{ kind: string; state: string; http_status: number }>("select kind, state, http_status from ralph.command order by created_at");
    expect(rows).toEqual([
      { kind: "control", state: "done", http_status: 200 },
      { kind: "stop-now", state: "done", http_status: 200 },
      { kind: "start", state: "refused", http_status: 409 },
    ]);
    // Byte for byte, each of them.
    expect([replaced.text, stopNow.text, notReady.text]).toEqual(r.m.sent().map((post) => post.text));
  });

  it("runs against the kind's fixed route only, whatever route or path the body names", async () => {
    const r = await rig("route");
    const id = await r.insert("control", { loop: "ralph", action: "pause", route: "/api/stop-now", path: "/api/projects/remove", url: "http://evil.test/" });
    await r.relay.onCommand({ project: "fixture", id });
    await r.relay.idle();
    expect(r.m.posts.map((post) => `${post.method} ${post.path}`)).toEqual(["POST /api/p/fixture/control"]);
    expect(await r.row(id)).toMatchObject({ state: "done", http_status: 200 });
    expect(r.m.audit()).toEqual([]);
  });

  it("writes the local answer back verbatim through postgres.js, which types each parameter as the server describes it", async () => {
    // postgres.js serializes a parameter the server describes as `json` with
    // JSON.stringify, so the answer's text once landed as a JSON *string* and
    // the app answered a quoted string instead of the local body (#175).
    const r = await rig("wired");
    const wire = await r.store.serve();
    const client = postgres(wire.url("ralph_bridge"), { max: 1, onnotice: () => {} });
    try {
      const relay = createRelay({
        store: { query: async (text, params) => (await client.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as never },
        instance: "bridge-a",
        base: LOCAL,
        fetch: r.m.fetchLocal,
        sleep: async () => {},
        log: () => {},
      });
      const id = await r.insert("control", { loop: "ralph", action: "pause" });
      await relay.onCommand({ project: "fixture", id });
      await relay.idle();
      const [row] = await r.store.owner<{ state: string; type: string; text: string }>(
        "select state, json_typeof(result) as type, result::text as text from ralph.command where id = $1",
        [id],
      );
      expect(row).toEqual({ state: "done", type: "object", text: r.m.sent()[0]!.text });
    } finally {
      await client.end({ timeout: 1 });
      await wire.close();
    }
  });

  it("names each kind's route, and only those", () => {
    expect(RELAY_ROUTES).toEqual({
      control: "/api/control",
      start: "/api/start",
      restart: "/api/restart",
      "stop-now": "/api/stop-now",
      "resume-work": "/api/resume-work",
      "agent-start": "/api/agents/start",
      "mark-read": "/api/notifications/read",
      "eval-start": "/api/evals/start",
      "eval-stop": "/api/evals/stop",
      "eval-set-add": "/api/evals/set/add",
      "eval-set-edit": "/api/evals/set/edit",
      "eval-set-retire": "/api/evals/set/retire",
      "eval-set-check": "/api/evals/set/check",
      "eval-set-keep": "/api/evals/set/keep",
      "eval-inbox-add": "/api/evals/inbox/add",
      "eval-inbox-start": "/api/evals/inbox/start",
      "eval-inbox-dismiss": "/api/evals/inbox/dismiss",
      "eval-improve-propose": "/api/evals/improve/propose",
      "eval-set-calibrate": "/api/evals/set/calibrate",
      "eval-proposal-open-pr": "/api/evals/proposals/open-pr",
    });
  });

  it("takes a wake-up as a hint: a row already done, unknown, or for another loop than it says is read for itself", async () => {
    const r = await rig("hint");
    await r.relay.onCommand({ project: "fixture", id: crypto.randomUUID() });
    const id = await r.insert("control", { loop: "ralph", action: "pause" });
    // A forged project in the payload changes nothing: the row says where it runs.
    await r.relay.onCommand({ project: "elsewhere", id });
    await r.relay.idle();
    await r.relay.onCommand({ project: "fixture", id });
    await r.relay.idle();
    expect(r.m.sent().map((post) => post.path)).toEqual(["/api/p/fixture/control"]);
    expect(await r.row(id)).toMatchObject({ state: "done", attempts: 1 });
  });
});

/** A Realtime stand-in for the real `startWake`: the test decides what reaches the bridge. */
class FakeTransport implements WakeTransport {
  handlers = new Map<WakeEvent, (payload: unknown) => void>();
  subscribed: ((status: string) => void)[] = [];
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
      subscribe: (callback) => {
        this.subscribed.push(callback);
        queueMicrotask(() => callback("SUBSCRIBED"));
      },
      close: async () => {},
    };
    return channel;
  }
  async signOut(): Promise<void> {}
}

describe("the sweep", () => {
  it("claims a row whose wake-up was dropped within 30 s, and sweeps at once after a resubscribe", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const r = await rig("sweep");
    // The real bridge with the relay registered, behind the real `startWake`.
    const bridge = createBridge({ store: r.bridgeStore, local: { base: LOCAL, fetch: r.m.fetchLocal, redact: async (lines) => [...lines] }, instance: "bridge-a", log: () => {} });
    bridge.relay(r.relay);
    const transport = new FakeTransport();
    const wake = startWake({ url: "https://x.supabase.co", publishableKey: "sb_publishable_x", email: "b@x", password: "p", ...bridge.wake, channelFactory: () => transport, random: () => 0.5 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await r.relay.idle();

      // Inserted, and its wake-up never delivered.
      const first = await r.insert("control", { loop: "ralph", action: "pause" });
      await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS - 1_000);
      await r.relay.idle();
      expect(await r.row(first)).toMatchObject({ state: "queued" });
      await vi.advanceTimersByTimeAsync(1_000);
      await r.relay.idle();
      expect(await r.row(first)).toMatchObject({ state: "done", attempts: 1 });

      // The socket drops; a row lands meanwhile; the resubscribe sweeps it at once.
      transport.subscribed.at(-1)!("CLOSED");
      const second = await r.insert("control", { loop: "ralph", action: "resume" });
      await vi.advanceTimersByTimeAsync(2_000);
      await r.relay.idle();
      expect(transport.subscribed).toHaveLength(2);
      expect(await r.row(second)).toMatchObject({ state: "done", attempts: 1 });
      expect(r.m.inbox().map((command) => command.command).sort()).toEqual(["pause", "resume"]);
    } finally {
      await wake.stop();
    }
  });

  it("runs one loop's rows one at a time, oldest first", async () => {
    const r = await rig("order");
    const ids = [
      await r.insert("control", { loop: "ralph", action: "pause" }, "5 minutes", "3 seconds"),
      await r.insert("control", { loop: "ralph", action: "resume" }, "5 minutes", "2 seconds"),
      await r.insert("control", { loop: "ralph", action: "approve" }, "5 minutes", "1 second"),
    ];
    // The newest one's wake-up arrives first, and a sweep with it.
    await r.relay.onCommand({ project: "fixture", id: ids[2]! });
    await r.relay.onSweep();
    await r.relay.idle();
    expect(r.m.sent().map((post) => post.body?.id)).toEqual(ids);
  });

  it("expires a start nobody claimed within 60 s, and the local server sees no start", async () => {
    const r = await rig("expire");
    const id = await r.insert("start", { loop: "ralph" }, "60 seconds", "61 seconds");
    await r.relay.onCommand({ project: "fixture", id });
    await r.relay.onSweep();
    await r.relay.idle();
    expect(await r.row(id)).toMatchObject({ state: "expired", why: "the machine did not pick it up within 60 s", claimed_by: null });
    expect(r.m.sent()).toEqual([]);
    expect(r.m.starts).toEqual([]);
  });

  it("claims nothing while the local dashboard is down, so the row can expire honestly", async () => {
    const r = await rig("down");
    r.m.script.down = true;
    const id = await r.insert("control", { loop: "ralph", action: "pause" });
    await r.relay.onCommand({ project: "fixture", id });
    await r.relay.onSweep();
    await r.relay.idle();
    expect(await r.row(id)).toMatchObject({ state: "queued", attempts: 0 });
    r.m.script.down = false;
    await r.relay.onSweep();
    await r.relay.idle();
    expect(await r.row(id)).toMatchObject({ state: "done" });
  });

  it("prunes finished rows older than 30 days, once a day", async () => {
    let now = Date.parse("2026-10-09T00:00:00.000Z");
    const r = await rig("prune", { now: () => now });
    const old = await r.insert("control", { loop: "ralph", action: "pause" });
    const recent = await r.insert("control", { loop: "ralph", action: "resume" });
    const finish = (id: string, age: string) =>
      r.store.owner(`update ralph.command set state = 'done', finished_at = now() - $2::interval where id = $1`, [id, age]);
    await finish(old, "31 days");
    await finish(recent, "29 days");
    await r.relay.onSweep();
    expect((await r.store.owner<{ id: string }>("select id from ralph.command")).map((row) => row.id)).toEqual([recent]);

    await finish(recent, "31 days");
    now += PRUNE_EVERY_MS - 1;
    await r.relay.onSweep();
    expect(await r.store.owner("select id from ralph.command")).toHaveLength(1);
    now += 1;
    await r.relay.onSweep();
    expect(await r.store.owner("select id from ralph.command")).toEqual([]);
  });
});

describe("at most once", () => {
  it("lets exactly one claim succeed when two bridges race one row", async () => {
    const r = await rig("race");
    const id = await r.insert("control", { loop: "ralph", action: "pause" });
    const b = r.another("bridge-b");
    await Promise.all([r.relay.onSweep(), b.onSweep(), r.relay.onCommand({ project: "fixture", id }), b.onCommand({ project: "fixture", id })]);
    await Promise.all([r.relay.idle(), b.idle()]);
    expect(await r.row(id)).toMatchObject({ state: "done", claimed_by: "bridge-a", attempts: 1 });
    expect(r.m.sent()).toHaveLength(1);

    // The gate itself: the same conditional update twice at once, one row back.
    const next = await r.insert("control", { loop: "ralph", action: "resume" });
    const claims = await Promise.all([1, 2].map(() => r.bridgeStore.query(RELAY_SQL.claim, ["bridge-a", next])));
    expect(claims.map((rows) => rows.length).sort()).toEqual([0, 1]);
    // And no claim at all without the lease.
    const third = await r.insert("control", { loop: "ralph", action: "approve" });
    expect(await r.bridgeStore.query(RELAY_SQL.claim, ["bridge-b", third])).toEqual([]);
  });

  it("claims once when one bridge gets a wake-up and a sweep for the same row", async () => {
    const r = await rig("wake-and-sweep");
    const id = await r.insert("control", { loop: "ralph", action: "pause" });
    await Promise.all([r.relay.onCommand({ project: "fixture", id }), r.relay.onSweep(), r.relay.onCommand({ project: "fixture", id })]);
    await r.relay.idle();
    expect(await r.row(id)).toMatchObject({ state: "done", attempts: 1 });
    expect(r.m.sent()).toHaveLength(1);
    expect(r.m.inbox()).toHaveLength(1);
  });
});

describe("crash reconciliation", () => {
  /** Claim `id` as a bridge that then died, after (or before) it POSTed. */
  const diedHolding = async (r: Rig, id: string, posted: boolean) => {
    await r.store.lease(45, "bridge-old");
    const [row] = await r.bridgeStore.query<{ body: Record<string, unknown>; kind: RelayedCommandKind }>(RELAY_SQL.claim, ["bridge-old", id]);
    if (posted) {
      await r.m.handler(
        new Request(`${LOCAL}/api/p/fixture${RELAY_ROUTES[row!.kind].slice("/api".length)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row!.body) }),
      );
    }
    await r.store.lease(45, "bridge-a");
  };

  it("re-issues a control with the same id, which the loop answers replayed, leaving one inbox file", async () => {
    const r = await rig("crash-control");
    const id = await r.insert("control", { loop: "ralph", action: "pause" });
    await diedHolding(r, id, true);
    // The loop applied it before the new bridge came up.
    r.m.script.record = () => recordOf([id]);
    await r.relay.onSweep();
    await r.relay.idle();
    const row = await r.row(id);
    expect(row).toMatchObject({ state: "done", http_status: 200, claimed_by: "bridge-a", attempts: 2 });
    expect(row.result).toMatchObject({ key: id, outcome: "replayed", recorded: true });
    expect(r.m.inbox()).toHaveLength(1);
  });

  it("never re-runs a Stop now: it takes the audited outcome, or fails, and sends no second signal", async () => {
    const r = await rig("crash-stop-now");
    const audited = await r.insert("stop-now", { loop: "ralph", confirm: true }, "60 seconds", "2 seconds");
    const unknown = await r.insert("stop-now", { loop: "ralph", confirm: true }, "60 seconds", "1 second");
    await diedHolding(r, audited, true);
    await diedHolding(r, unknown, false);
    expect(r.m.audit()).toHaveLength(1);

    await r.relay.onSweep();
    await r.relay.idle();
    expect(await r.row(audited)).toMatchObject({
      state: "done",
      http_status: null,
      result: expect.objectContaining({ id: audited, outcome: "refused", via: "remote" }),
      why: "the bridge restarted mid-command; the loop's History recorded it as refused",
    });
    expect(await r.row(unknown)).toMatchObject({ state: "failed", why: RESTARTED_WHY });
    expect(r.m.sent()).toEqual([]);
    expect(r.m.audit()).toHaveLength(1);
  });

  it("never re-runs a start, resume-work or agent-start", async () => {
    const r = await rig("crash-start");
    const ids = [
      await r.insert("start", { loop: "ralph" }, "60 seconds"),
      await r.insert("resume-work", { loop: "ralph" }, "60 seconds"),
      await r.insert("agent-start", { name: "rafa" }, "60 seconds"),
    ];
    for (const id of ids) await diedHolding(r, id, false);
    await r.relay.onSweep();
    await r.relay.idle();
    for (const id of ids) expect(await r.row(id)).toMatchObject({ state: "failed", why: RESTARTED_WHY });
    expect(r.m.sent()).toEqual([]);
    expect(r.m.starts).toEqual([]);
  });

  it("reconciles once per process, and only rows another instance claimed", async () => {
    const r = await rig("crash-once");
    const id = await r.insert("start", { loop: "ralph" }, "60 seconds");
    await r.relay.onSweep();
    await r.relay.idle();
    const later = await r.insert("start", { loop: "ralph" }, "60 seconds");
    await diedHolding(r, later, false);
    await r.relay.onSweep();
    await r.relay.idle();
    expect(await r.row(id)).toMatchObject({ state: "done" });
    expect(await r.row(later)).toMatchObject({ state: "claimed", claimed_by: "bridge-old" });
  });
});

describe("restart's long wait", () => {
  it("re-issues with the same id while the stop is pending, writing each answer, then ends done", async () => {
    const r = await rig("restart");
    let calls = 0;
    const id = await r.insert("restart", { loop: "ralph", confirm: true }, "60 seconds");
    r.m.script.record = () => ({ ...recordOf([id]), stop: { kind: "blocked", confirmation: calls >= 3 ? "confirmed" : "pending", why: "restart", at: "T", key: id } });
    r.m.script.liveness = () => (calls >= 3 ? "dead" : "alive");
    const seen: unknown[] = [];
    const relay = r.another("bridge-a", {
      sleep: async () => {
        calls += 1;
        seen.push(await r.row(id));
      },
    });
    await relay.onCommand({ project: "fixture", id });
    await relay.idle();

    expect(r.m.sent().map((post) => post.body?.id)).toEqual([id, id, id, id]);
    for (const row of seen) {
      expect(row).toMatchObject({ state: "claimed", http_status: 200, result: expect.objectContaining({ outcome: "halted", halt: "stop-pending" }) });
    }
    expect(await r.row(id)).toMatchObject({ state: "done", http_status: 200, result: expect.objectContaining({ outcome: "started" }) });
    expect(r.m.starts).toHaveLength(1);
  });

  it("gives up re-issuing after 10 minutes and keeps the last answer", async () => {
    let now = 0;
    const r = await rig("restart-cap", { now: () => now, sleep: async (ms) => void (now += ms) });
    const id = await r.insert("restart", { loop: "ralph", confirm: true }, "60 seconds");
    r.m.script.record = () => ({ ...recordOf([id]), stop: { kind: "blocked", confirmation: "pending", why: "restart", at: "T", key: id } });
    await r.relay.onCommand({ project: "fixture", id });
    await r.relay.idle();
    expect(r.m.sent()).toHaveLength(121);
    expect(await r.row(id)).toMatchObject({ state: "done", result: expect.objectContaining({ outcome: "halted", halt: "stop-pending" }) });
  });
});

describe("the kill switch", () => {
  it("refuses every row with its why, reaches nothing local, and the bridge reports controls disabled", async () => {
    const r = await rig("kill", { controls: "off" });
    const ids = [
      await r.insert("control", { loop: "ralph", action: "pause" }),
      await r.insert("stop-now", { loop: "ralph", confirm: true }, "60 seconds"),
      await r.insert("start", { loop: "ralph" }, "60 seconds"),
    ];
    r.m.script.down = true;
    await r.relay.onCommand({ project: "fixture", id: ids[0]! });
    await r.relay.onSweep();
    await r.relay.idle();
    for (const id of ids) expect(await r.row(id)).toMatchObject({ state: "refused", why: KILL_SWITCH_WHY, http_status: null });
    expect(r.m.posts).toEqual([]);

    const bridge = createBridge({ store: r.bridgeStore, local: { base: LOCAL, fetch: r.m.fetchLocal, redact: async (lines) => [...lines] }, instance: "bridge-a", controls: "off", log: () => {} });
    bridge.relay(r.relay);
    await bridge.tick();
    expect((await r.store.owner<{ controls: string }>("select controls from ralph.bridge"))[0]).toEqual({ controls: "disabled" });
  });

  it("answers the app at once rather than after its whole wait", async () => {
    const r = await rig("kill-app", { controls: "off" });
    const answer = await click(r, "control", { loop: "ralph", action: "pause" });
    expect(answer.ms).toBeLessThan(3_000);
    expect(answer.status).toBe(202);
    expect((JSON.parse(answer.text) as RelayAccepted).relay.state).toBe("refused");
  });
});
