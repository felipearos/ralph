// @vitest-environment node
/**
 * The remote dashboard end to end, offline (#175, spec #165 §13): every piece
 * running together, so a regression in any seam fails here before go-live.
 *
 * - **The machine**: the real local dashboard (`createHandler`) over a scratch
 *   project from `fixtures.ts`, served on an ephemeral loopback port. Its
 *   control, lifecycle, Stop now and records adapters are the real ones; only
 *   subprocesses are scripted (`controls.ts status` reports each inbox command
 *   as applied, as the loop's poller would at its boundary).
 * - **The store**: PGlite with `schema.sql` and `roles.sql` (`test-store.ts`)
 *   on a Postgres wire endpoint. The bridge logs in as `ralph_bridge` and the
 *   handler as `ralph_web`, and each runs under that role's grants.
 * - **The bridge**: `bridge.ts` itself, spawned with `bun`, with shortened
 *   cadences, lease and sweep through its `RALPH_BRIDGE_*` knobs. Supabase is
 *   swapped for `e2e-supabase.ts` by `--preload`, so `wake.ts` runs unchanged
 *   against the fake hub below.
 * - **The hub**: fake Supabase Auth and Realtime. It turns each recorded
 *   `realtime.send` into a broadcast on `ralph:bridge`, and can drop them.
 * - **The app**: the remote handler (`handler.ts`), driven by in-process
 *   fetches carrying `Sec-Fetch-Site: same-origin`, over its own postgres.js
 *   client as `api/index.ts` makes it.
 *
 * The scenarios share one bridge and run in order; the last one kills it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAgentsAdapter } from "../agents-adapter";
import { coderRoster } from "../contracts";
import type { BridgeStatusView, ControlView, Liveness, ProjectHealthView, RelayAccepted, RelayedCommandView, RuntimeSnapshot } from "../contracts";
import { createRalphControlAdapter, type ExecResult, type Executor } from "../control-adapter";
import { readControlStatus } from "../control-view";
import { bunPath, cleanupFixtures, createFixture } from "../fixtures";
import { createInterruptAdapter } from "../interrupt-adapter";
import type { JavAdapter } from "../jav-adapter";
import { createRalphLifecycleAdapter } from "../lifecycle-adapter";
import type { Onboarding } from "../onboarding";
import { createRecordsAdapter } from "../records-adapter";
import { createHandler, type ProjectScope } from "../server";
import { subprocessSuite } from "../../test-timeouts";
import { createRemoteHandler, type Sql } from "./handler";
import { createTestStore, type SentWake, type TestStore, type WireEndpoint } from "./test-store";

subprocessSuite("spawns the bridge under bun against PGlite on the wire, a local dashboard and a fake Supabase hub", 45_000);

const HARNESS = join(__dirname, "..", "..");
const BRIDGE = join(__dirname, "bridge.ts");
const PRELOAD = join(__dirname, "e2e-supabase.ts");
const ORIGIN = "https://ralph-dashboard.example.test";
const PUBLISHABLE_KEY = "sb_publishable_e2e";
const EMAIL = "bridge@ralph.test";
const PASSWORD = "bridge-password";
const ACCESS_TOKEN = "e2e-access-token";

/** The knobs: every cadence the scenarios wait on, shortened. */
const LEASE_MS = 5_000;
const SWEEP_MS = 2_500;
const VIEWER_MS = 3_000;
const KNOBS = {
  RALPH_BRIDGE_HEARTBEAT_MS: "1000",
  RALPH_BRIDGE_LEASE_MS: String(LEASE_MS),
  RALPH_BRIDGE_VIEWER_MS: String(VIEWER_MS),
  RALPH_BRIDGE_LIVE_HOT_MS: "500",
  RALPH_BRIDGE_FEED_HOT_MS: "500",
  RALPH_BRIDGE_SWEEP_MS: String(SWEEP_MS),
};
/** How long the app waits for the machine's answer, and a start's TTL. */
const WAIT_MS = 8_000;
const START_TTL_S = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `read` until `done` holds of it, for at most `ms`; the last value either way. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}; last: ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const bodyOf = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/* ------------------------------------------------------------- the machine */

/** One request the bridge made of the local dashboard, with the answer as text. */
interface LocalCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  status: number;
  text: string;
  /** The Content-Encoding the handler answered with, so a case can see the bridge read compressed bytes. */
  encoding: string | null;
}

/**
 * The project `fixture` with one live loop, `ralph`, whose supervisor pid file
 * names a dead process, served by the real local handler on a loopback port.
 */
async function startMachine() {
  const f = createFixture("remote-e2e");
  const worktree = f.worktree("wt-ralph");
  const state = {
    version: 1 as const,
    run: "run-1",
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree,
    branch: "ralph/14-thing",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-10-09T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  writeFileSync(join(worktree, ".ralph", "logs", "state.json"), JSON.stringify(state));
  writeFileSync(join(worktree, ".ralph", "logs", "supervisor.pid"), `${spawnSync("true").pid!}\n`);
  const runtime = {
    roster: coderRoster("ralph"),
    loops: [
      { worktree, identity: "ralph", loopStatus: "running", worktreeStatus: "live", branch: "ralph/14-thing", state, stateProblem: null, supervisor: "alive", presence: null },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  } as unknown as RuntimeSnapshot;

  const inbox = (): Record<string, unknown>[] => {
    const dir = join(worktree, ".ralph", "control", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>);
  };
  const audit = (): Record<string, unknown>[] => {
    const path = join(worktree, ".ralph", "control", "signals.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const liveness = (): Liveness => "alive";
  const exec: Executor = async (invocation): Promise<ExecResult> => {
    if (invocation.command.endsWith("start.sh")) return { status: 0, stdout: "Started Ralph supervisor (pid 5151); waits 300s.\n", stderr: "" };
    if (invocation.args.some((arg) => arg.endsWith("loop-state.ts"))) {
      const loop = { worktree, worktreeStatus: "live", loopStatus: "running", branch: "ralph/14-thing", state: null, stateProblem: null, supervisor: liveness() };
      return { status: 0, stdout: JSON.stringify({ self: worktree, loops: [loop], reconciliation: { orphaned: [], prunable: [] } }), stderr: "" };
    }
    if (invocation.args.some((arg) => arg.endsWith("controls.ts"))) {
      // The loop's poller, at its boundary: every inbox command applied.
      const applied = inbox().map((command) => ({
        key: command.id,
        command: command.command,
        outcome: "applied",
        at: "2026-10-09T00:00:00.000Z",
        why: String(command.why ?? "applied"),
      }));
      const record = { version: 1, ralphRun: "run-1", loop: "ralph", applied, deferrals: [], hold: null, stop: null };
      return { status: 0, stdout: applied.length === 0 ? "null" : JSON.stringify(record), stderr: "" };
    }
    if (invocation.command === "git") return { status: 0, stdout: "", stderr: "" };
    return { status: 127, stdout: "", stderr: `not in this fixture: ${invocation.command}` };
  };
  const control = (root: string) => createRalphControlAdapter({ cliDir: HARNESS, root, bunPath: "bun", env: {}, exec });
  const jav: JavAdapter = { read: async () => ({ path: join(HARNESS, "jav.json") }) as never, save: async () => ({}) as never };
  const scope: ProjectScope = {
    project: { id: "fixture", path: f.root, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
    adapter: { read: async () => runtime } as ProjectScope["adapter"],
    usage: (async () => ({ project: "fixture", cost: 1.5, tokens: 1200 })) as never,
    lineup: async (request) => Response.json({ loop: new URL(request.url).searchParams.get("loop") }),
    jav,
    health: async (): Promise<ProjectHealthView> =>
      ({ project: "fixture", readAt: "2026-10-09T00:00:00.000Z", health: "running", needsYou: 0, needs: [], loops: 1, running: 1, problem: null }) as ProjectHealthView,
  };
  const handler = createHandler({
    projects: () => [scope],
    shell: "<html></html>",
    controlStatus: (root) => readControlStatus(control(root)),
    controls: ({ worktree: root }) => ({ adapter: control(root) }),
    lifecycle: ({ worktree: root }) => ({
      control: control(root),
      lifecycle: createRalphLifecycleAdapter({ cliDir: HARNESS, root, bunPath: "bun", env: {}, exec }),
      sleep: async () => {},
      waitTimeoutMs: 0,
      pollIntervalMs: 1,
    }),
    interrupt: ({ worktree: root }) => ({ interrupt: createInterruptAdapter({ root }), control: control(root) }),
    records: (root) => createRecordsAdapter({ root }),
    onboarding: { status: async () => ({ project: "fixture", status: "ready", baseBranch: "main", pr: null }) } as unknown as Onboarding,
    agents: (registered) => ({
      agents: createAgentsAdapter({
        cliDir: HARNESS,
        root: registered.path,
        project: registered.id,
        workspaces: f.root,
        bunPath: "bun",
        exec: async () => ({ status: 1, stdout: "", stderr: "not in this fixture" }),
      }),
    }),
  });

  const calls: LocalCall[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const raw = await bodyOf(request);
      const method = request.method ?? "GET";
      const url = `http://127.0.0.1${request.url ?? "/"}`;
      const answer = await handler(
        new Request(url, {
          method,
          headers: Object.entries(request.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : [])),
          ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(raw) }),
        }),
      );
      // The bytes go to the bridge as the handler encoded them (#69): reading
      // them as text would mangle a compressed body under its Content-Encoding.
      const bytes = Buffer.from(await answer.arrayBuffer());
      const encoding = answer.headers.get("content-encoding");
      const text = (encoding === "br" ? brotliDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8");
      calls.push({ method, path: new URL(url).pathname, body: method === "POST" ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : null, status: answer.status, text, encoding });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(bytes);
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  const base = await listen(server);
  return { f, base, runtime, state, inbox, audit, calls, posts: () => calls.filter((call) => call.method === "POST"), stop: () => close(server) };
}

/* ----------------------------------------------------------------- the hub */

/** Fake Supabase Auth and Realtime for the bridge, fed by the store's `realtime.send` record. */
async function startHub(store: TestStore) {
  const streams = new Set<ServerResponse>();
  const hub = {
    /** Drop every broadcast instead of sending it, as a lost wake-up. */
    drop: false,
    delivered: [] as SentWake[],
    dropped: [] as SentWake[],
    subscribes: 0,
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://hub");
      if ((request.headers.apikey ?? "") !== PUBLISHABLE_KEY) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error_description: "bad apikey" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
        const { email, password } = JSON.parse((await bodyOf(request)).toString("utf8")) as { email: string; password: string };
        const ok = email === EMAIL && password === PASSWORD;
        response
          .writeHead(ok ? 200 : 400, { "content-type": "application/json" })
          .end(JSON.stringify(ok ? { access_token: ACCESS_TOKEN } : { error_description: "Invalid login credentials" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/realtime/v1/broadcast") {
        // The policy on `realtime.messages`: the bridge's user, its private topic, nothing else.
        const allowed =
          request.headers.authorization === `Bearer ${ACCESS_TOKEN}` && url.searchParams.get("topic") === "ralph:bridge" && url.searchParams.get("private") === "true";
        if (!allowed) {
          response.writeHead(403).end();
          return;
        }
        hub.subscribes += 1;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.flushHeaders();
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }
      response.writeHead(404).end();
    })();
  });
  const url = await listen(server);

  // The broadcast-from-database step: each new `realtime.send` row goes to every open stream.
  let seen = 0;
  let pumping = false;
  const pump = setInterval(() => {
    if (pumping) return;
    pumping = true;
    void store
      .owner<SentWake & { seq: number }>("select seq::int as seq, payload, event, topic, private from realtime.sent where seq > $1 order by seq", [seen])
      .then((rows) => {
        for (const row of rows) {
          seen = row.seq;
          const wake: SentWake = { payload: row.payload, event: row.event, topic: row.topic, private: row.private };
          if (hub.drop || streams.size === 0) {
            hub.dropped.push(wake);
            continue;
          }
          for (const stream of streams) stream.write(`${JSON.stringify({ event: wake.event, payload: wake.payload })}\n`);
          hub.delivered.push(wake);
        }
      })
      .finally(() => {
        pumping = false;
      });
  }, 25);

  return {
    hub,
    url,
    stop: async () => {
      clearInterval(pump);
      for (const stream of streams) stream.end();
      await close(server);
    },
  };
}

/* --------------------------------------------------------------- the rig */

let store: TestStore;
let wire: WireEndpoint;
let machine: Awaited<ReturnType<typeof startMachine>>;
let hubServer: Awaited<ReturnType<typeof startHub>>;
let web: postgres.Sql;
let bridge: ChildProcess;
let bridgeLog = "";
let sql: Sql;

/** A fresh app instance, as a cold Vercel function: no viewer throttle, no snapshot cache. */
const app = () => createRemoteHandler({ sql, waitMs: WAIT_MS, pollMs: 100, ttlSeconds: { start: START_TTL_S } });
let remote: ReturnType<typeof app>;

const get = (path: string, handler = remote): Promise<Response> => handler(new Request(`${ORIGIN}${path}`));
const post = (path: string, body: unknown): Promise<Response> =>
  remote(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
    }),
  );
const bridgeStatus = async (): Promise<BridgeStatusView> => (await (await get("/api/p/fixture/bridge")).json()) as BridgeStatusView;
const row = async (key: string): Promise<{ body: Uint8Array; version: number; pushed_at: Date }> => {
  const [found] = await store.owner<{ body: Uint8Array; version: number; pushed_at: Date }>(
    "select body, version::int as version, pushed_at from ralph.snapshot where project = 'fixture' and key = $1",
    [key],
  );
  return found!;
};
const unzip = (bytes: Uint8Array): unknown => JSON.parse(gunzipSync(bytes).toString("utf8"));
/** A snapshot route's body, as the browser would decode it: stored gzip, served with `content-encoding: gzip`. */
const snapshot = async <T>(path: string): Promise<T> => {
  const response = await get(path);
  expect(response.headers.get("content-encoding")).toBe("gzip");
  return unzip(new Uint8Array(await response.arrayBuffer())) as T;
};

beforeAll(async () => {
  store = await createTestStore();
  wire = await store.serve();
  machine = await startMachine();
  hubServer = await startHub(store);
  // As `api/index.ts`: `ralph_web` through a transaction pooler, so no prepared statements.
  web = postgres(wire.url("ralph_web"), { prepare: false, max: 4, onnotice: () => {} });
  sql = async <T>(query: string, params: readonly unknown[] = []) => (await web.unsafe(query, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
  remote = app();

  const runtime = machine.f.root;
  bridge = spawn(bunPath(), ["--preload", PRELOAD, BRIDGE], {
    cwd: HARNESS,
    env: {
      ...process.env,
      HOME: runtime,
      XDG_RUNTIME_DIR: runtime,
      RALPH_BRIDGE_DATABASE_URL: wire.url("ralph_bridge"),
      RALPH_BRIDGE_LOCAL_URL: machine.base,
      SUPABASE_URL: hubServer.url,
      SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
      RALPH_BRIDGE_AUTH_EMAIL: EMAIL,
      RALPH_BRIDGE_AUTH_PASSWORD: PASSWORD,
      ...KNOBS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout!.on("data", (chunk: Buffer) => (bridgeLog += chunk.toString()));
  bridge.stderr!.on("data", (chunk: Buffer) => (bridgeLog += chunk.toString()));

  // Up: live, subscribed, controls on, and a first full push landed.
  try {
    await until(bridgeStatus, (view) => view.live && view.wake === "realtime" && view.controls === "enabled", 20_000, "the bridge to come up");
    await until(() => get("/api/p/fixture/loops/ralph/control").then((response) => response.status), (status) => status === 200, 10_000, "the first push");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nbridge said:\n${bridgeLog}`);
  }
});

afterAll(async () => {
  if (bridge !== undefined && bridge.exitCode === null && bridge.signalCode === null) {
    bridge.kill("SIGCONT");
    bridge.kill("SIGKILL");
    await new Promise((resolve) => bridge.once("close", resolve));
  }
  await web?.end({ timeout: 1 });
  await hubServer?.stop();
  await machine?.stop();
  await wire?.close();
  await store?.close();
  cleanupFixtures();
});

/** A command's local answer: what the machine said to the bridge's POST for row `id`. */
const localAnswer = (id: string): LocalCall | undefined => machine.posts().find((call) => call.body?.id === id);

describe("the remote dashboard, end to end", () => {
  it("pause round trip: the local ControlResult within 3 s, one inbox file via remote, and the next control read shows it", async () => {
    const started = Date.now();
    const response = await post("/api/p/fixture/control", { loop: "ralph", action: "pause", why: "lunch" });
    const ms = Date.now() - started;
    const text = await response.text();
    const id = response.headers.get("x-ralph-command")!;

    expect(ms, bridgeLog).toBeLessThan(3_000);
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ action: "pause", key: id });
    // The answer is the local route's, byte for byte, through a real postgres.js `json` column.
    expect(text).toBe(localAnswer(id)?.text);
    // The wake-up carried ids only, never the body.
    expect(hubServer.hub.delivered).toContainEqual({ event: "command", payload: { project: "fixture", id }, topic: "ralph:bridge", private: true });

    const [command, ...others] = machine.inbox();
    expect(others).toEqual([]);
    expect(command).toMatchObject({ id, command: "pause", loop: "ralph", why: "lunch", via: "remote" });

    // The command turned the project hot, so the next push of the control view shows the pause.
    const view = await until(
      () => snapshot<ControlView>("/api/p/fixture/loops/ralph/control"),
      (control) => control.commands.some((entry) => entry.key === id),
      5_000,
      "the control view to show the pause",
    );
    expect(view.commands).toContainEqual(expect.objectContaining({ key: id, command: "pause", outcome: "applied" }));
  });

  it("Stop now on a dead pid: refused on the alive check, byte-identical to the local answer", async () => {
    const response = await post("/api/p/fixture/stop-now", { loop: "ralph", confirm: true, why: "held a turn open" });
    const text = await response.text();
    const id = response.headers.get("x-ralph-command")!;

    expect(response.status).toBe(200);
    const result = JSON.parse(text) as { outcome: string; failedCheck?: string; checks: { check: string; ok: boolean }[]; signals: unknown[] };
    expect(result.outcome).toBe("refused");
    expect(result.checks.find((check) => !check.ok)?.check).toBe("alive");
    expect(result.signals).toEqual([]);
    expect(text).toBe(localAnswer(id)?.text);
    expect(machine.audit()).toEqual([expect.objectContaining({ event: "refused", via: "remote" })]);
    // And the History entry, as the remote page reads it once pushed, names the check.
    const history = await until(
      () => snapshot<{ entries: { id: string; failedCheck: string | null; via: string | null }[] }>("/api/p/fixture/loops/ralph/history"),
      (view) => view.entries.some((entry) => entry.id === id),
      5_000,
      "History to carry the refusal",
    );
    expect(history.entries.find((entry) => entry.id === id)).toMatchObject({ failedCheck: "alive", via: "remote" });
  });

  it("lost wake-up: with the hub dropping broadcasts, the command still completes through the sweep", async () => {
    hubServer.hub.drop = true;
    try {
      const started = Date.now();
      const response = await post("/api/p/fixture/control", { loop: "ralph", action: "resume", why: "back" });
      const ms = Date.now() - started;
      const id = response.headers.get("x-ralph-command")!;

      expect(response.status, bridgeLog).toBe(200);
      expect(JSON.parse(await response.clone().text())).toMatchObject({ action: "resume", key: id });
      expect(hubServer.hub.dropped).toContainEqual(expect.objectContaining({ event: "command", payload: { project: "fixture", id } }));
      expect(hubServer.hub.delivered.some((wake) => wake.payload.id === id)).toBe(false);
      // One sweep interval, give or take a claim and a local POST.
      expect(ms).toBeLessThan(2 * SWEEP_MS);
      expect(machine.inbox().filter((command) => command.id === id)).toEqual([expect.objectContaining({ command: "resume", via: "remote" })]);
    } finally {
      hubServer.hub.drop = false;
    }
  });

  it("expiry: with the bridge stopped, a start ends expired after its TTL and the machine never sees it", async () => {
    bridge.kill("SIGSTOP");
    let id: string;
    try {
      // This scenario needs a live lease at admission, followed by command
      // expiry. The stopped bridge cannot renew its short fixture lease, and
      // host scheduling may already have used most of it before this test.
      await store.owner("update ralph.bridge set lease_until = now() + interval '30 seconds'");
      const response = await post("/api/p/fixture/start", { loop: "ralph" });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as RelayAccepted;
      id = accepted.relay.id;
      // The app's wait ends as soon as the row is past its TTL, not at `WAIT_MS`.
      expect(accepted.relay.state).toBe("expired");
      const view = (await (await get(`/api/p/fixture/commands/${id}`)).json()) as RelayedCommandView;
      expect(view).toMatchObject({ id, kind: "start", state: "expired", httpStatus: null, result: null });
      expect(view.why).toMatch(/did not pick it up/);
    } finally {
      bridge.kill("SIGCONT");
    }
    // Back, the bridge sees the wake-up and sweeps; neither may run the row.
    await until(bridgeStatus, (view) => view.live, 10_000, "the bridge to take its lease back");
    await sleep(SWEEP_MS + 500);
    expect(machine.posts().filter((call) => call.path.endsWith("/start"))).toEqual([]);
    const [stored] = await store.owner<{ state: string; claimed_by: string | null }>("select state, claimed_by from ralph.command where id = $1", [id!]);
    expect(stored).toEqual({ state: "expired", claimed_by: null });
  });

  it("viewer: a snapshot read makes the project hot, and a fresh dashboard snapshot lands within 10 s", async () => {
    // Let every earlier viewer and command go cold first.
    await until(bridgeStatus, (view) => view.snapshots === "idle", VIEWER_MS + 5_000, "the project to go idle");
    const before = await row("dashboard");
    // Something moves on the machine; idle, the bridge would not read `dashboard` for 5 minutes.
    machine.state.iteration = { index: 7, max: 10 };
    const wakes = hubServer.hub.delivered.length;

    const started = Date.now();
    // A cold instance, as a new page load: its first read writes the viewer row.
    const read = await get("/api/p/fixture/loops/ralph/control", app());
    expect(read.status, `${await read.clone().text()}\n${bridgeLog}`).toBe(200);
    const fresh = await until(
      () => row("dashboard"),
      (current) => JSON.stringify(unzip(current.body)).includes('"iteration":{"index":7'),
      10_000,
      "a fresh dashboard push",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fresh.version).toBeGreaterThan(before.version);
    // The bridge asks with fetch's own Accept-Encoding, so its dashboard read
    // came back compressed and it still pushed the snapshot it decoded (#69).
    expect(machine.calls.some((call) => call.method === "GET" && call.encoding !== null)).toBe(true);
    const viewerWakes = await until(
      async () => hubServer.hub.delivered.slice(wakes).filter((wake) => wake.event === "viewer"),
      (found) => found.length > 0,
      2_000,
      "the viewer wake-up",
    );
    expect(viewerWakes[0]).toEqual({ event: "viewer", payload: { project: "fixture" }, topic: "ralph:bridge", private: true });
    // The page's banner hears of it with the next heartbeat.
    await until(bridgeStatus, (view) => view.snapshots === "hot", 3_000, "the bridge to report the project hot");
  });

  it("offline: once the bridge is killed it goes not-live within the lease, POSTs are 503, and reads serve the last push", async () => {
    bridge.kill("SIGKILL");
    await new Promise((resolve) => bridge.once("close", resolve));
    const killed = Date.now();
    const status = await until(bridgeStatus, (view) => !view.live, LEASE_MS + 2_000, "the bridge to go offline");
    expect(Date.now() - killed).toBeLessThanOrEqual(LEASE_MS + 2_000);
    expect(status).toMatchObject({ live: false, controls: "disabled" });

    const refused = await post("/api/p/fixture/control", { loop: "ralph", action: "pause", why: "again" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "BridgeNotLive" });

    const last = await row("dashboard");
    const read = await get("/api/p/fixture/loops");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-encoding")).toBe("gzip");
    expect(read.headers.get("x-ralph-snapshot-at")).toBe(new Date(last.pushed_at).toISOString());
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array(last.body));
  });
});
