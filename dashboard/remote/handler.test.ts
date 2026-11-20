// @vitest-environment node
/**
 * The remote dashboard's function, driven in-process against the real store
 * (`schema.sql` and `roles.sql` on PGlite) acting as `ralph_web`, so every
 * statement it runs is one the role is granted.
 *
 * The snapshots are what the bridge would push: the local handler
 * (`createHandler`) over a scratch checkout, read through the real collector.
 * Derived routes are then held to the local server's own answer for the same
 * read, and commands to the local route's own 400s.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import api, { handlerFromEnv } from "../../api/index";
import { coderRoster, SNAPSHOT_SCHEMA } from "../contracts";
import type { BridgeStatusView, ProjectHealthView, RelayAccepted, RelayedCommandView, RuntimeSnapshot, VersionsView } from "../contracts";
import { createRalphControlAdapter, type Executor } from "../control-adapter";
import { createRecordsAdapter } from "../records-adapter";
import { ROUTE_TABLE, type RemoteOnlyServes, type RouteRow } from "../route-table";
import { createHandler, type ProjectScope } from "../server";
import { collect, type Snapshot } from "./collect";
import {
  createRemoteHandler,
  DEFAULT_VERSION_WAIT_MS,
  GLOBAL_SNAPSHOT_PROJECT,
  VERSION_KEYS_MAX,
  VERSION_POLL_MS,
  VIEWER_THROTTLE_MS,
  type RemoteHandlerOptions,
} from "./handler";
import { createIntakeGate } from "./intake-auth";
import { createTestStore, type TestStore } from "./test-store";

const ORIGIN = "https://ralph-dashboard.example.test";
const PUSHED_AT = "2026-10-09T12:00:00.000Z";

let store: TestStore;
const scratch: string[] = [];

beforeAll(async () => {
  store = await createTestStore();
}, 30_000);

afterAll(async () => {
  await store.close();
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** The function as deployed, with the store as `ralph_web`; no wait unless asked. */
const remote = (options: Partial<RemoteHandlerOptions> = {}) => {
  const handler = createRemoteHandler({
    sql: (query, params = []) => store.as("ralph_web", query, [...params]),
    waitMs: 0,
    pollMs: 10,
    ...options,
  });
  return {
    handler,
    get: (path: string) => handler(new Request(`${ORIGIN}${path}`)),
    post: (path: string, body: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
      handler(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
  };
};

async function push(project: string, key: string, body: Uint8Array, version = 1): Promise<void> {
  await store.owner(
    `insert into ralph.snapshot (project, key, body, hash, version, pushed_at) values ($1, $2, $3, 'h', $4, $5)
     on conflict (project, key) do update
       set body = excluded.body, version = excluded.version, pushed_at = excluded.pushed_at, problem = null`,
    [project, key, body, version, PUSHED_AT],
  );
}

const pushJson = async (project: string, key: string, value: unknown, version = 1): Promise<Uint8Array> => {
  const body = new Uint8Array(gzipSync(JSON.stringify(value)));
  await push(project, key, body, version);
  return body;
};

/** The bridge, as its heartbeat leaves the row. */
async function bridge(row: { leaseSeconds: number; seenSecondsAgo?: number; schema?: number; controls?: string; local?: string; hot?: unknown }) {
  await store.lease(row.leaseSeconds);
  await store.owner(
    `update ralph.bridge set last_seen_at = now() - make_interval(secs => $1), schema = $2, controls = $3, local = $4,
       wake = 'realtime', hot = $5::jsonb`,
    [row.seenSecondsAgo ?? 0, row.schema ?? SNAPSHOT_SCHEMA, row.controls ?? "enabled", row.local ?? "ok", JSON.stringify(row.hot ?? {})],
  );
}

const commandsOf = (project: string) =>
  store.owner<{ id: string; kind: string; state: string; body: Record<string, unknown> }>(
    "select id, kind, state, body from ralph.command where project = $1 order by created_at",
    [project],
  );

/* ----------------------------------------------------------- the machine */

const NOTIFICATION = {
  event: "raised",
  id: "n-1",
  at: "2026-10-09T00:00:00.000Z",
  kind: "blocked",
  subject: "ralph is blocked",
  body: "ralph waits on a review",
  run: "run-alpha",
};

function checkout(id: string): string {
  const root = mkdtempSync(join(tmpdir(), `ralph-remote-handler-${id}-`));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  return root;
}

function runtimeAt(worktree: string, run: string): RuntimeSnapshot {
  const state = {
    version: 1 as const,
    run,
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree,
    branch: "ralph/14",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-10-09T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  writeFileSync(join(worktree, ".ralph", "logs", "state.json"), JSON.stringify(state));
  return {
    roster: coderRoster("ralph", "rafa"),
    loops: [
      {
        worktree,
        identity: "ralph",
        loopStatus: "running",
        worktreeStatus: "live",
        branch: "ralph/14",
        state,
        stateProblem: null,
        supervisor: "alive",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
}

const health = (project: string): ProjectHealthView => ({
  project,
  readAt: "2026-10-09T00:00:00.000Z",
  health: "needs-you",
  needsYou: 1,
  needs: [{ loop: "ralph", reason: "approval" }],
  loops: 2,
  running: 1,
  problem: null,
});

const refuse = (): never => {
  throw new Error("only a malformed request reaches this local route in these tests");
};

/** The local dashboard with two projects, every write route mounted but none able to act. */
function machine() {
  const alpha = checkout("alpha");
  const beta = checkout("beta");
  writeFileSync(join(alpha, ".ralph", "logs", "notifications.jsonl"), `${JSON.stringify(NOTIFICATION)}\n`);
  const project = (id: string, path: string) => ({ id, path, addedAt: "2026-10-01T00:00:00.000Z", source: "local" as const });
  const scopes: ProjectScope[] = [
    { project: project("alpha", alpha), adapter: { read: async () => runtimeAt(alpha, "run-alpha") }, health: async () => health("alpha") },
    { project: project("beta", beta), adapter: { read: async () => runtimeAt(beta, "run-beta") }, health: async () => health("beta") },
  ];
  const exec: Executor = async () => ({ status: 1, stdout: "", stderr: "not in this test" });
  return createHandler({
    projects: () => scopes,
    shell: "<html>shell</html>",
    clock: () => ({ nowMs: Date.parse("2026-10-09T00:00:05.000Z") }),
    controls: ({ worktree }) => ({ adapter: createRalphControlAdapter({ cliDir: "/harness", root: worktree, bunPath: "bun", exec }) }),
    lifecycle: refuse,
    interrupt: refuse,
    agents: () => ({}) as never,
    records: (worktree) => createRecordsAdapter({ root: worktree }),
  });
}

/* ------------------------------------------------------------------ tests */

describe("derived routes", () => {
  const local = machine();
  const localGet = async (path: string) => {
    const response = await local(new Request(`http://127.0.0.1${path}`));
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const remoteGet = async (path: string) => {
    const response = await remote().get(path);
    return { status: response.status, body: (await response.json()) as unknown };
  };

  beforeAll(async () => {
    // What the bridge pushes: the real collector over the local handler, unredacted here.
    const collected = await collect({
      base: "http://127.0.0.1",
      fetch: (url, init) => local(new Request(url, init)),
      redact: async (lines) => [...lines],
      home: "/nonexistent-home",
      projects: ["alpha"],
    });
    if (!collected.ok) throw new Error(collected.detail);
    const pushed = collected.snapshots.filter((entry): entry is Snapshot => "body" in entry);
    for (const snapshot of pushed) await push(snapshot.project ?? GLOBAL_SNAPSHOT_PROJECT, snapshot.key, snapshot.body);
    expect(pushed.map((snapshot) => snapshot.key)).toEqual(expect.arrayContaining(["_/projects", "_/health", "dashboard", "notifications"]));
  });

  it("answer a loop panel as the local server does", async () => {
    expect(await remoteGet("/api/p/alpha/loops/ralph")).toEqual(await localGet("/api/p/alpha/loops/ralph"));
    expect(await remoteGet("/api/p/alpha/loops/rafa")).toEqual(await localGet("/api/p/alpha/loops/rafa"));
    expect(await remoteGet("/api/p/alpha/loops/nope")).toEqual(await localGet("/api/p/alpha/loops/nope"));
  });

  it("answer ownership and the frontier as the local server does", async () => {
    expect(await remoteGet("/api/p/alpha/ownership")).toEqual(await localGet("/api/p/alpha/ownership"));
    expect(await remoteGet("/api/p/alpha/frontier")).toEqual(await localGet("/api/p/alpha/frontier"));
  });

  it("answer one loop's notifications as the local server does", async () => {
    const ralph = await remoteGet("/api/p/alpha/loops/ralph/notifications");
    expect(ralph).toEqual(await localGet("/api/p/alpha/loops/ralph/notifications"));
    expect(JSON.stringify(ralph.body)).toContain("ralph is blocked");
    expect(await remoteGet("/api/p/alpha/loops/nope/notifications")).toEqual(await localGet("/api/p/alpha/loops/nope/notifications"));
  });

  it("filter the selected project out of health, as the local server does", async () => {
    expect(await remoteGet("/api/projects/health?selected=alpha")).toEqual(await localGet("/api/projects/health?selected=alpha"));
    expect(await remoteGet("/api/projects/health")).toEqual(await localGet("/api/projects/health"));
  });

  it("answer the derived routes byte for byte as the local server does", async () => {
    // Parsed JSON hides a drift in key order or indentation; the raw text does not.
    for (const path of ["/api/p/alpha/ownership", "/api/p/alpha/frontier", "/api/p/alpha/loops/ralph", "/api/p/alpha/loops/nope"]) {
      const [localResponse, remoteResponse] = [await local(new Request(`http://127.0.0.1${path}`)), await remote().get(path)];
      expect({ path, status: remoteResponse.status, text: await remoteResponse.text() }).toEqual({
        path,
        status: localResponse.status,
        text: await localResponse.text(),
      });
    }
  });

  it("carry the push time", async () => {
    const response = await remote().get("/api/p/alpha/ownership");
    expect(response.headers.get("x-ralph-snapshot-at")).toBe(PUSHED_AT);
  });

  it("serve an unscoped API path as the first project's, as locally", async () => {
    expect(await remoteGet("/api/loops/ralph")).toEqual(await localGet("/api/loops/ralph"));
  });

  describe("a trial's patch, from the relayed evals-patches snapshot (#825)", () => {
    const TRIAL = "?run=r1&case=c1&arm=opus";
    const PATCH = "diff --git a/x.ts b/x.ts\n+const x = 1;\n";

    beforeAll(async () => {
      await pushJson("relays", "evals-patches", {
        enabled: true,
        patches: [{ run: "r1", case: "c1", arm: "opus", text: PATCH, truncated: false }],
        omitted: 0,
        problem: null,
      });
      await pushJson("keeps", "evals-patches", { enabled: false, patches: [], omitted: 0, problem: null });
    });

    it("answers the patch as a diff when the project relays them", async () => {
      const response = await remote().get(`/api/p/relays/evals/patch${TRIAL}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/x-diff; charset=utf-8");
      expect(response.headers.get("x-ralph-snapshot-at")).toBe(PUSHED_AT);
      expect(await response.text()).toBe(PATCH);
    });

    it("says why when the project does not relay patches", async () => {
      const response = await remote().get(`/api/p/keeps/evals/patch${TRIAL}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "NotFound",
        message: "this project does not relay eval patches; open the patch on the local dashboard",
      });
    });

    it("names a trial the snapshot left out", async () => {
      const response = await remote().get("/api/p/relays/evals/patch?run=r1&case=c2&arm=opus");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("NotFound");
      expect(body.message).toContain("r1/c2/opus");
    });

    it("is NoSnapshot before the bridge pushed one", async () => {
      const response = await remote().get(`/api/p/unpushed/evals/patch${TRIAL}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "NoSnapshot" });
    });
  });
});

describe("snapshot routes", () => {
  const ROUTES: [path: string, key: string][] = [
    ["/api/p/snap/loops", "dashboard"],
    ["/api/p/snap/controls", "controls"],
    ["/api/p/snap/loops/ralph/control", "control/ralph"],
    ["/api/p/snap/loops/ralph/checkout", "checkout/ralph"],
    ["/api/p/snap/loops/ralph/history", "history/ralph"],
    ["/api/p/snap/notifications", "notifications"],
    ["/api/p/snap/usage", "usage"],
    ["/api/p/snap/setup", "setup"],
    ["/api/p/snap/agents", "agents"],
    ["/api/p/snap/lineup?loop=ralph", "lineup/ralph"],
    ["/api/p/snap/roots", "roots"],
    ["/api/p/snap/jav", "jav"],
    ["/api/p/snap/settings", "settings"],
    ["/api/p/snap/settings/prompts", "prompts"],
    ["/api/p/snap/sentinel", "sentinel"],
  ];

  it.each(ROUTES)("%s answers the pushed bytes of %s, gzip as stored", async (path, key) => {
    const body = await pushJson("snap", key, { key, loops: [] });
    const response = await remote().get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-ralph-snapshot-at")).toBe(PUSHED_AT);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("answers the project list from the _/projects key", async () => {
    const body = await pushJson(GLOBAL_SNAPSHOT_PROJECT, "_/projects", { projects: [{ id: "alpha" }] });
    const response = await remote().get("/api/projects");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("reads the version before the body, and the body only once per version", async () => {
    const reads: string[] = [];
    const { get } = remote({
      sql: (query, params = []) => {
        reads.push(query.trim().split(/\s+/).slice(0, 2).join(" "));
        return store.as("ralph_web", query, [...params]);
      },
    });
    await pushJson("cache", "dashboard", { v: 1 }, 1);
    const bodyReads = () => reads.filter((query) => query === "select body,").length;
    await get("/api/p/cache/loops");
    await get("/api/p/cache/loops");
    expect(bodyReads()).toBe(1);
    const next = await pushJson("cache", "dashboard", { v: 2 }, 2);
    const response = await get("/api/p/cache/loops");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(next);
    expect(bodyReads()).toBe(2);
  });

  it("says why when there is nothing to serve", async () => {
    expect(await (await remote().get("/api/p/empty/loops")).json()).toMatchObject({ error: "NoSnapshot" });
    await store.owner("insert into ralph.snapshot (project, key, problem) values ('big', 'dashboard', 'too-large')");
    const big = await remote().get("/api/p/big/loops");
    expect(big.status).toBe(503);
    expect(await big.json()).toMatchObject({ error: "SnapshotTooLarge" });
  });
});

describe("viewer presence", () => {
  it("upserts viewer on a snapshot read at most once per 15 s per project", async () => {
    let clock = 1_000_000;
    const { get } = remote({ now: () => clock });
    await pushJson("seen", "dashboard", { loops: [] });
    await pushJson("seen", "usage", {});
    const wakes = async () => (await store.sent()).filter((wake) => wake.event === "viewer" && wake.payload.project === "seen").length;

    await get("/api/p/seen/loops");
    await get("/api/p/seen/usage");
    clock += VIEWER_THROTTLE_MS - 1;
    await get("/api/p/seen/loops/ralph");
    expect(await wakes()).toBe(1);
    const [row] = await store.owner<{ n: number }>("select count(*)::int as n from ralph.viewer where project = 'seen'");
    expect(row?.n).toBe(1);

    clock += 1;
    await get("/api/p/seen/loops");
    expect(await wakes()).toBe(2);
  });

  it("is not written for a read with nothing to serve", async () => {
    await remote().get("/api/p/unseen/loops");
    expect(await store.owner("select * from ralph.viewer where project = 'unseen'")).toEqual([]);
  });
});

describe("the live output pane", () => {
  it("is one withheld event, then the stream closes with a one-minute retry", async () => {
    const response = await remote().get("/api/p/alpha/loops/ralph/output");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text.startsWith("retry: 60000\n\n")).toBe(true);
    const events = [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]!) as unknown);
    expect(events).toEqual([{ kind: "withheld", reason: "Live output is not relayed to the remote dashboard" }]);
  });
});

describe("local-only routes", () => {
  const LOCAL_ONLY: [method: string, path: string][] = [
    ["POST", "/api/projects"],
    ["POST", "/api/projects/remove"],
    ["POST", "/api/projects/pick-folder"],
    ["GET", "/api/github/repos"],
    ["GET", "/api/p/alpha/setup/defaults"],
    ["POST", "/api/p/alpha/setup/validate"],
    ["POST", "/api/p/alpha/setup"],
    ["POST", "/api/p/alpha/agents"],
    ["POST", "/api/p/alpha/agents/delete"],
    ["POST", "/api/p/alpha/agents/checkout"],
    // The guide is a file in the harness checkout and a pending agent's
    // preflight runs in its worktree, so neither read exists off the machine.
    // The readiness items are not here: they ride on the `/api/agents`
    // snapshot, which the remote dashboard does serve.
    ["GET", "/api/p/alpha/agents/guide"],
    ["GET", "/api/p/alpha/agents/preflight"],
    // The verifier's rules are read off the machine and its POST opens a PR there.
    ["GET", "/api/p/alpha/agents/verifier"],
    ["POST", "/api/p/alpha/agents/verifier"],
    // The sentinel's rules form likewise; only its panel read is relayed.
    ["GET", "/api/p/alpha/agents/sentinel"],
    ["POST", "/api/p/alpha/agents/sentinel"],
    // Project settings are proposed as a PR opened from the machine.
    ["POST", "/api/p/alpha/settings/project"],
    // A gate run executes on the machine; only the gates list is relayed.
    ["GET", "/api/p/alpha/settings/gates/run"],
    ["POST", "/api/p/alpha/settings/gates/run"],
    ["POST", "/api/p/alpha/settings/worktrees"],
    ["POST", "/api/p/alpha/doctor"],
    ["GET", "/api/p/alpha/lineup/catalog"],
    ["POST", "/api/p/alpha/lineup/preview"],
    ["POST", "/api/p/alpha/lineup/edit"],
    ["POST", "/api/p/alpha/lineup/save"],
    ["POST", "/api/p/alpha/jav/save"],
  ];

  it.each(LOCAL_ONLY)("%s %s is 403 LocalOnly", async (method, path) => {
    const response = await remote().handler(new Request(`${ORIGIN}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) }));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("LocalOnly");
    expect(body.message).toMatch(/is only available on the local dashboard$/);
  });

  it("answers 404 for an unknown path and 405 for a wrong method", async () => {
    expect((await remote().get("/api/p/alpha/nope")).status).toBe(404);
    expect((await remote().get("/api/nope")).status).toBe(404);
    const wrong = await remote().get("/api/p/alpha/control");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await remote().handler(new Request(`${ORIGIN}/api/p/alpha/loops`, { method: "DELETE" }))).status).toBe(405);
  });
});

describe("GET /api/bridge", () => {
  it("is offline, with controls disabled, once the heartbeat is 50 s old", async () => {
    await bridge({ leaseSeconds: -5, seenSecondsAgo: 50 });
    const view = (await (await remote().get("/api/p/alpha/bridge")).json()) as BridgeStatusView;
    expect(view).toMatchObject({ live: false, controls: "disabled", schema: { bridge: SNAPSHOT_SCHEMA, app: SNAPSHOT_SCHEMA } });
    expect(view.why).toMatch(/offline/);
    expect(Date.now() - Date.parse(view.lastSeenAt!)).toBeGreaterThanOrEqual(49_000);
  });

  it("is live and idle with controls enabled while the lease holds", async () => {
    await bridge({ leaseSeconds: 45 });
    expect(await (await remote().get("/api/p/alpha/bridge")).json()).toMatchObject({
      live: true,
      snapshots: "idle",
      wake: "realtime",
      local: "ok",
      controls: "enabled",
      why: null,
    } satisfies Partial<BridgeStatusView>);
  });

  it("is hot for the project the bridge marks hot, and only that one", async () => {
    await bridge({ leaseSeconds: 45, hot: { alpha: new Date(Date.now() + 60_000).toISOString() } });
    expect(await (await remote().get("/api/p/alpha/bridge")).json()).toMatchObject({ snapshots: "hot" });
    expect(await (await remote().get("/api/p/beta/bridge")).json()).toMatchObject({ snapshots: "idle" });
  });

  it("disables controls on a schema mismatch, a local outage or the kill switch", async () => {
    await bridge({ leaseSeconds: 45, schema: SNAPSHOT_SCHEMA - 1 });
    expect(await (await remote().get("/api/p/alpha/bridge")).json()).toMatchObject({ live: true, controls: "disabled", why: expect.stringMatching(/older ralph/) });
    await bridge({ leaseSeconds: 45, local: "dashboard-down" });
    expect(await (await remote().get("/api/p/alpha/bridge")).json()).toMatchObject({ controls: "disabled", local: "dashboard-down" });
    await bridge({ leaseSeconds: 45, controls: "disabled" });
    expect(await (await remote().get("/api/p/alpha/bridge")).json()).toMatchObject({ controls: "disabled", why: expect.stringMatching(/disabled on the machine/) });
    await bridge({ leaseSeconds: 45, schema: SNAPSHOT_SCHEMA + 1 });
    expect(await (await remote({ schema: SNAPSHOT_SCHEMA + 1 }).get("/api/p/alpha/bridge")).json()).toMatchObject({ controls: "enabled" });
  });
});

describe("GET /api/versions (#731)", () => {
  const PROJECT = "waits";
  const since = (versions: Record<string, unknown>) => `/api/p/${PROJECT}/versions?since=${encodeURIComponent(JSON.stringify(versions))}`;

  /** A handler on a fake clock that `sleep` advances, with a hook on each sleep. */
  const clocked = (onSleep: (call: number) => Promise<void> = async () => {}, options: Partial<RemoteHandlerOptions> = {}) => {
    const clock = { at: 1_000_000, sleeps: 0 };
    const handler = remote({
      now: () => clock.at,
      sleep: async (ms) => {
        clock.at += ms;
        clock.sleeps += 1;
        await onSleep(clock.sleeps);
      },
      versionWaitMs: 3_000,
      versionPollMs: 500,
      ...options,
    });
    return { clock, ...handler };
  };

  beforeAll(async () => {
    await pushJson(PROJECT, "dashboard", { loops: [] }, 7);
    await pushJson(PROJECT, "controls", {}, 3);
    await pushJson(GLOBAL_SNAPSHOT_PROJECT, "_/health", { projects: [] }, 11);
    // The same key under the project must not be the one `_/health` reads.
    await pushJson(PROJECT, "_/health", { projects: [] }, 99);
  });

  it("answers at once, as numbers, when a given version is behind: a page with nulls gets its baseline", async () => {
    const { clock, get } = clocked();
    const response = await get(since({ dashboard: null, controls: null, agents: null }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as VersionsView).toEqual({ versions: { dashboard: 7, controls: 3, agents: null } });
    expect(clock.sleeps).toBe(0);
  });

  it("answers a push made during the wait on the next check, before the deadline", async () => {
    let bumpedAt = 0;
    const { clock, get } = clocked(async (call) => {
      if (call !== 2) return;
      bumpedAt = clock.at;
      await pushJson(PROJECT, "controls", {}, 4);
    });
    try {
      const view = (await (await get(since({ dashboard: 7, controls: 3 }))).json()) as VersionsView;
      expect(view).toEqual({ versions: { dashboard: 7, controls: 4 } });
      expect(clock.at - bumpedAt).toBeLessThan(1_000);
      expect(clock.at - 1_000_000).toBeLessThan(3_000);
    } finally {
      await pushJson(PROJECT, "controls", {}, 3);
    }
  });

  it("answers the unchanged versions once the wait passes, well under the function's 30 s limit", async () => {
    const { clock, get } = clocked();
    const view = (await (await get(since({ dashboard: 7, "_/health": 11 }))).json()) as VersionsView;
    expect(view).toEqual({ versions: { dashboard: 7, "_/health": 11 } });
    expect(clock.at - 1_000_000).toBeGreaterThanOrEqual(3_000);
    expect(clock.at - 1_000_000).toBeLessThan(3_500);
    expect(DEFAULT_VERSION_WAIT_MS + VERSION_POLL_MS).toBeLessThan(28_000);
  });

  it("stops waiting when the page goes away", async () => {
    const abort = new AbortController();
    const { clock, handler } = clocked(async (call) => {
      if (call === 1) abort.abort();
    });
    const response = await handler(new Request(`${ORIGIN}${since({ dashboard: 7 })}`, { signal: abort.signal }));
    expect(await response.json()).toEqual({ versions: { dashboard: 7 } });
    expect(clock.sleeps).toBe(1);
  });

  it("reads the version columns only, one statement per check, and keeps the project hot", async () => {
    const statements: string[] = [];
    const { get } = clocked(async () => {}, {
      sql: (query, params = []) => {
        statements.push(query);
        return store.as("ralph_web", query, [...params]);
      },
      versionWaitMs: 1_000,
    });
    await get(since({ dashboard: 7, controls: 3, "_/health": 11 }));
    const reads = statements.filter((query) => /from ralph\.snapshot/.test(query));
    expect(reads).toHaveLength(3);
    expect(statements.filter((query) => /\bbody\b/.test(query))).toEqual([]);
    expect(statements.filter((query) => /ralph\.viewer/.test(query))).toHaveLength(1);
    expect(await store.owner("select project from ralph.viewer where project = $1", [PROJECT])).toHaveLength(1);
  });

  it("reads `_/health` under the global project", async () => {
    const view = (await (await clocked().get(since({ "_/health": null }))).json()) as VersionsView;
    expect(view.versions["_/health"]).toBe(11);
  });

  it.each([
    ["missing", `/api/p/${PROJECT}/versions`],
    ["not JSON", `/api/p/${PROJECT}/versions?since=${encodeURIComponent("{dashboard")}`],
    ["not an object", since([] as unknown as Record<string, unknown>)],
    ["a bad value", since({ dashboard: -1 })],
    ["a fractional value", since({ dashboard: 1.5 })],
    ["a string value", since({ dashboard: "7" })],
    ["a key with whitespace", since({ "dash board": 1 })],
    ["too many keys", since(Object.fromEntries(Array.from({ length: VERSION_KEYS_MAX + 1 }, (_, index) => [`history/l${index}`, null])))],
  ])("is a 400 for a since that is %s", async (_name, path) => {
    const response = await clocked().get(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "BadRequest" });
  });

  it("is not served on the intake surface", async () => {
    const response = await clocked(async () => {}, { surface: "intake" }).get(since({ intake: null }));
    expect(response.status).toBe(404);
  });
});

describe("command POSTs", () => {
  const PAUSE = { loop: "ralph", action: "pause" };

  it("answer 503 BridgeNotLive, writing nothing, once the heartbeat is 50 s old", async () => {
    await bridge({ leaseSeconds: -5, seenSecondsAgo: 50 });
    const response = await remote().post("/api/p/dead/control", PAUSE);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "BridgeNotLive" });
    expect(await commandsOf("dead")).toEqual([]);
  });

  it("are accepted while the bridge is live in idle snapshot mode", async () => {
    await bridge({ leaseSeconds: 45 });
    const response = await remote().post("/api/p/idle/control", PAUSE);
    expect(response.status).toBe(202);
    const { relay } = (await response.json()) as RelayAccepted;
    expect(relay.state).toBe("queued");
    const [row] = await commandsOf("idle");
    expect(row).toMatchObject({ id: relay.id, kind: "control", state: "queued", body: { ...PAUSE, id: relay.id, via: "remote" } });
  });

  it("are 403 without Sec-Fetch-Site: same-origin and without a matching Origin", async () => {
    await bridge({ leaseSeconds: 45 });
    const { post } = remote();
    expect((await post("/api/p/csrf/control", PAUSE, {})).status).toBe(403);
    expect((await post("/api/p/csrf/control", PAUSE, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("/api/p/csrf/control", PAUSE, { origin: "https://evil.example" })).status).toBe(403);
    expect(await commandsOf("csrf")).toEqual([]);
    expect((await post("/api/p/csrf/control", PAUSE, { origin: ORIGIN })).status).toBe(202);
    expect((await post("/api/p/csrf/start", { loop: "ralph" }, { "sec-fetch-site": "same-origin" })).status).toBe(202);
  });

  it("must be JSON and at most 4 KB", async () => {
    await bridge({ leaseSeconds: 45 });
    const { handler, post } = remote();
    const plain = await handler(
      new Request(`${ORIGIN}/api/p/shape/control`, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: JSON.stringify(PAUSE) }),
    );
    expect(plain.status).toBe(415);
    const big = await post("/api/p/shape/control", { ...PAUSE, why: "x".repeat(4096) });
    expect(big.status).toBe(413);
    expect(await commandsOf("shape")).toEqual([]);
  });

  describe("a malformed body gets the local route's 400, and no row", () => {
    const local = machine();
    const MALFORMED: [route: string, body: unknown][] = [
      ["control", "not json"],
      ["control", []],
      ["control", {}],
      ["control", { loop: "ralph" }],
      ["control", { loop: "ralph", action: "explode" }],
      ["control", { loop: "ralph", action: "stop" }],
      ["control", { loop: "ralph", action: "pause", scope: "forever" }],
      ["control", { loop: "ralph", action: "resume", scope: "phase" }],
      ["control", { loop: "ralph", action: "pause", issue: "14" }],
      ["start", {}],
      ["restart", { loop: "ralph" }],
      ["restart", { loop: "ralph", confirm: true, stopKind: "sudden" }],
      ["stop-now", { loop: "ralph" }],
      ["stop-now", { loop: "ralph", confirm: true, id: ".hidden" }],
      ["resume-work", { loop: 7 }],
      ["agents/start", {}],
      ["agents/start", { name: "Bad Name" }],
      ["notifications/read", { loop: "ralph" }],
      ["notifications/read", { loop: "ralph", through: "yesterday" }],
    ];

    it.each(MALFORMED)("POST /api/%s %j", async (route, body) => {
      await bridge({ leaseSeconds: 45 });
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: raw };
      const expected = await local(new Request(`http://127.0.0.1/api/p/alpha/${route}`, init));
      const actual = await remote().post(`/api/p/malformed/${route}`, raw);
      expect(expected.status).toBe(400);
      expect({ status: actual.status, body: await actual.json() }).toEqual({ status: expected.status, body: await expected.json() });
      expect(await commandsOf("malformed")).toEqual([]);
    });
  });

  it("return the machine's answer when it finishes within the wait", async () => {
    await bridge({ leaseSeconds: 45 });
    const answering = remote({ waitMs: 10_000, pollMs: 20 }).post("/api/p/fast/stop-now", { loop: "ralph", confirm: true });
    let id: string | undefined;
    while (id === undefined) {
      id = (await commandsOf("fast"))[0]?.id;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await store.as(
      "ralph_bridge",
      `update ralph.command set state = 'done', http_status = 409, result = '{"error":"LoopNotAddressable"}', finished_at = now() where id = $1`,
      [id],
    );
    const response = await answering;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "LoopNotAddressable" });
  });

  it("return 202 with the relay when it does not, and GET /api/commands/:id shows the outcome later", async () => {
    await bridge({ leaseSeconds: 45 });
    const { get, post } = remote({ waitMs: 60, pollMs: 20 });
    const response = await post("/api/p/slow/restart", { loop: "ralph", confirm: true });
    expect(response.status).toBe(202);
    const { relay } = (await response.json()) as RelayAccepted;
    expect(relay).toMatchObject({ state: "queued" });
    expect(Date.parse(relay.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);

    expect(await (await get(`/api/p/slow/commands/${relay.id}`)).json()).toMatchObject({ id: relay.id, kind: "restart", state: "queued", result: null });
    await store.as(
      "ralph_bridge",
      `update ralph.command set state = 'done', http_status = 200, result = '{"outcome":"started"}', finished_at = now() where id = $1`,
      [relay.id],
    );
    const view = (await (await get(`/api/p/slow/commands/${relay.id}`)).json()) as RelayedCommandView;
    expect(view).toMatchObject({ id: relay.id, state: "done", httpStatus: 200, result: { outcome: "started" }, why: null });
    expect(view.finishedAt).not.toBeNull();
    // Another project cannot read it, and a malformed id is a plain 404.
    expect((await get(`/api/p/other/commands/${relay.id}`)).status).toBe(404);
    expect((await get("/api/p/slow/commands/not-a-uuid")).status).toBe(404);
  });

  it("expire a queued command past its TTL when they read it", async () => {
    await bridge({ leaseSeconds: 45 });
    const [row] = await store.owner<{ id: string }>(
      `insert into ralph.command (project, kind, body, created_at, expires_at)
       values ('late', 'start', '{"loop":"ralph"}', now() - interval '2 minutes', now() - interval '1 minute') returning id`,
    );
    expect(await (await remote().get(`/api/p/late/commands/${row!.id}`)).json()).toMatchObject({
      state: "expired",
      why: "the machine did not pick it up within 60 s",
    });
  });

  it("make one row of a double POST within 3 s", async () => {
    await bridge({ leaseSeconds: 45 });
    const { post } = remote();
    const first = (await (await post("/api/p/double/control", PAUSE)).json()) as RelayAccepted;
    const second = (await (await post("/api/p/double/control", PAUSE)).json()) as RelayAccepted;
    expect(second.relay.id).toBe(first.relay.id);
    expect(await commandsOf("double")).toHaveLength(1);
    await post("/api/p/double/control", { loop: "ralph", action: "resume" });
    await post("/api/p/double/control", { loop: "rafa", action: "pause" });
    expect(await commandsOf("double")).toHaveLength(3);
  });

  it("set each kind's TTL", async () => {
    await bridge({ leaseSeconds: 45 });
    const { post } = remote();
    await post("/api/p/ttl/control", PAUSE);
    await post("/api/p/ttl/notifications/read", { loop: "ralph", through: "2026-10-09T00:00:00.000Z" });
    await post("/api/p/ttl/agents/start", { name: "rulo" });
    await post("/api/p/ttl/evals/set/add", { repo: "felipearos/loggd", prs: [12], reason: "the migration case" });
    await post("/api/p/ttl/evals/set/edit", { case: "loggd-12", tags: ["db"] });
    await post("/api/p/ttl/evals/set/retire", { case: "loggd-12" });
    await post("/api/p/ttl/evals/set/check", { case: "loggd-12", command: "make check" });
    await post("/api/p/ttl/evals/set/keep", { case: "loggd-12" });
    await post("/api/p/ttl/evals/set/calibrate", { case: "loggd-12", arms: ["opus", "codex"], axis: "correctness", preferred: "opus", reason: "it kept the migration" });
    await post("/api/p/ttl/evals/inbox/add", { plan: { source: { kind: "pr", prs: [12] }, arms: [{ name: "opus" }] } });
    await post("/api/p/ttl/evals/inbox/start", { entry: "rec-1a2b3c4d" });
    await post("/api/p/ttl/evals/inbox/dismiss", { entry: "rec-1a2b3c4d" });
    await post("/api/p/ttl/evals/improve/propose", { run: "eval-abc", goal: "quality" });
    await post("/api/p/ttl/evals/proposals/open-pr", { proposal: "prop-1a2b3c4d" });
    const ttls = await store.owner<{ kind: string; ttl: number }>(
      "select kind, round(extract(epoch from expires_at - created_at))::int as ttl from ralph.command where project = 'ttl' order by kind",
    );
    expect(ttls).toEqual([
      { kind: "agent-start", ttl: 60 },
      { kind: "control", ttl: 300 },
      { kind: "eval-improve-propose", ttl: 300 },
      { kind: "eval-inbox-add", ttl: 300 },
      { kind: "eval-inbox-dismiss", ttl: 60 },
      { kind: "eval-inbox-start", ttl: 300 },
      { kind: "eval-proposal-open-pr", ttl: 300 },
      { kind: "eval-set-add", ttl: 300 },
      { kind: "eval-set-calibrate", ttl: 60 },
      { kind: "eval-set-check", ttl: 300 },
      { kind: "eval-set-edit", ttl: 60 },
      { kind: "eval-set-keep", ttl: 60 },
      { kind: "eval-set-retire", ttl: 60 },
      { kind: "mark-read", ttl: 600 },
    ]);
  });

  it("answer 429 past the store's rate limit", async () => {
    await bridge({ leaseSeconds: 45 });
    await store.owner(
      `insert into ralph.command (project, kind, body, expires_at)
       select 'flood', 'control', jsonb_build_object('loop', 'l' || i), now() + interval '1 minute' from generate_series(1, 30) i`,
    );
    const response = await remote().post("/api/p/flood/control", PAUSE);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "RateLimited" });
  });
});

describe("the intake page (felipearos/ralph#459)", () => {
  const PASSWORD = "intake-test-password";
  const METRICS = { v: 1, available: true, byReporter: [{ key: "U1", reports: 3 }] };
  const gated = (password: string | null, surface: "full" | "intake" = "full", role: "ralph_web" | "ralph_intake" = "ralph_web") => {
    const handler = createRemoteHandler({
      sql: (query, params = []) => store.as(role, query, [...params]),
      waitMs: 0,
      intake: createIntakeGate({ password, sleep: async () => {} }),
      surface,
    });
    const send = (path: string, init: RequestInit = {}) => handler(new Request(`${ORIGIN}${path}`, init));
    const login = (password: string, client = "203.0.113.7") =>
      send("/api/p/intake/intake/login", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": client },
        body: JSON.stringify({ password }),
      });
    return { send, login };
  };
  const metrics = (send: (path: string, init?: RequestInit) => Promise<Response>, cookie?: string) =>
    send("/api/p/intake/intake/metrics", cookie === undefined ? {} : { headers: { cookie } });

  beforeAll(async () => {
    await pushJson("intake", "intake", { v: 1, available: true, tickets: [{ key: "OAI-1" }] });
    await pushJson("intake", "intake-metrics", METRICS);
  });

  it("serves the tickets to anyone, from the intake key", async () => {
    const response = await gated(null).send("/api/p/intake/intake");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("locks the metrics for everyone when no password is set: no login opens them", async () => {
    const { send, login } = gated(null);
    expect(await (await send("/api/p/intake/intake/session")).json()).toEqual({ access: "unconfigured" });
    const refused = await metrics(send);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "MetricsLocked" });
    expect((await login("")).status).toBe(403);
    expect((await login(PASSWORD)).status).toBe(403);
  });

  it("answers 401 without a session and after a wrong password, and never the payload", async () => {
    const { send, login } = gated(PASSWORD);
    const none = await metrics(send);
    expect(none.status).toBe(401);
    expect(await none.text()).not.toContain("byReporter");
    const wrong = await login("not-it");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await (await send("/api/p/intake/intake/session")).json()).toEqual({ access: "locked" });
  });

  it("opens them with the right password, through an HttpOnly cookie, until logout clears it", async () => {
    const { send, login } = gated(PASSWORD);
    const right = await login(PASSWORD);
    expect(right.status).toBe(200);
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const session = cookie.split(";")[0]!;
    const served = await metrics(send, session);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("no-store, private");
    expect(JSON.parse(gunzipSync(new Uint8Array(await served.arrayBuffer())).toString("utf8"))).toEqual(METRICS);
    expect(await (await send("/api/p/intake/intake/session", { headers: { cookie: session } })).json()).toEqual({ access: "unlocked" });
    const out = await send("/api/p/intake/intake/logout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("refuses a cross-site or non-JSON login, and a flood of wrong guesses with 429", async () => {
    const { send, login } = gated(PASSWORD);
    const cross = await send("/api/p/intake/intake/login", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(cross.status).toBe(403);
    expect((await send("/api/p/intake/intake/login", { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: PASSWORD })).status).toBe(415);
    for (let i = 0; i < 10; i += 1) expect((await login("guess", "198.51.100.9")).status).toBe(401);
    const flooded = await login(PASSWORD, "198.51.100.9");
    expect(flooded.status).toBe(429);
    expect(Number(flooded.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("on the open intake surface, as ralph_intake, serves the intake routes and nothing else", async () => {
    const { send, login } = gated(PASSWORD, "intake", "ralph_intake");
    expect((await send("/api/p/intake/intake")).status).toBe(200);
    const right = await login(PASSWORD);
    expect((await metrics(send, right.headers.get("set-cookie")!.split(";")[0]!)).status).toBe(200);
    for (const path of ["/api/p/intake/loops", "/api/projects", "/api/p/intake/bridge", "/api/loops"]) {
      expect((await send(path)).status, path).toBe(404);
    }
    expect((await send("/api/p/intake/control", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: "{}" })).status).toBe(404);
  });

  it("on the open intake surface, answers a malformed escape on a route it does not serve with a 404, not a 500", async () => {
    const { send } = gated(PASSWORD, "intake", "ralph_intake");
    for (const path of ["/api/p/intake/loops/%E0", "/api/p/intake/commands/%ZZ"]) {
      const response = await send(path);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: "not found" });
    }
  });

  it("gives ralph_intake the two intake keys and nothing more", async () => {
    await pushJson("intake", "dashboard", { loops: [] });
    const keys = await store.as<{ key: string }>("ralph_intake", "select key from ralph.intake_snapshot where project = 'intake' order by key");
    expect(keys.map((row) => row.key)).toEqual(["intake", "intake-metrics"]);
    await expect(store.as("ralph_intake", "select key from ralph.snapshot")).rejects.toThrow(/permission denied/);
    await expect(store.as("ralph_intake", "select id from ralph.command")).rejects.toThrow(/permission denied/);
  });
});

describe("api/index.ts", () => {
  it("locks the intake metrics unless RALPH_INTAKE_METRICS_PASSWORD is set", async () => {
    // No store, so the answer is the unconfigured handler's; the gate itself is unit-tested in intake-auth.test.ts.
    expect((await handlerFromEnv({ RALPH_INTAKE_METRICS_PASSWORD: "x" })(new Request(`${ORIGIN}/api/p/a/intake/session`))).status).toBe(503);
  });

  it("shows a deployment without a store as offline, and says why everywhere else", async () => {
    const handler = handlerFromEnv({});
    const view = (await (await handler(new Request(`${ORIGIN}/api/p/alpha/bridge`))).json()) as BridgeStatusView;
    expect(view).toMatchObject({ live: false, controls: "disabled", why: expect.stringMatching(/no store/) });
    const loops = await handler(new Request(`${ORIGIN}/api/p/alpha/loops`));
    expect(loops.status).toBe(503);
    expect(await loops.json()).toMatchObject({ error: "StoreNotConfigured" });
    expect(typeof api.fetch).toBe("function");
  });

  it("stores a command body as a JSON object through postgres.js, which types each parameter as the server describes it", async () => {
    // postgres.js serializes a parameter the server describes as `jsonb` with
    // JSON.stringify, so the body text once went in as a JSON *string* and the
    // local route answered 400 "the request body must be a JSON object" (#175).
    await bridge({ leaseSeconds: 45 });
    const wire = await store.serve();
    try {
      const handler = handlerFromEnv({ RALPH_WEB_DATABASE_URL: wire.url("ralph_web"), RALPH_COMMAND_WAIT_MS: "0" });
      const response = await handler(
        new Request(`${ORIGIN}/api/p/wired/control`, {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify({ loop: "ralph", action: "pause" }),
        }),
      );
      expect(response.status).toBe(202);
      const { relay } = (await response.json()) as RelayAccepted;
      const [row] = await store.owner<{ type: string; body: unknown }>("select jsonb_typeof(body) as type, body from ralph.command where id = $1", [relay.id]);
      expect(row).toEqual({ type: "object", body: { loop: "ralph", action: "pause", id: relay.id, via: "remote" } });
    } finally {
      await wire.close();
    }
  });

  it("imports no dashboard/server.ts and no adapter, however deep", () => {
    const repo = resolve(import.meta.dirname, "..", "..");
    const seen = new Set<string>();
    const packages = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)) {
        if (specifier!.startsWith(".")) walk(resolve(dirname(file), `${specifier}.ts`));
        else packages.add(specifier!);
      }
    };
    walk(join(repo, "api", "index.ts"));
    const files = [...seen].map((file) => file.slice(repo.length + 1)).sort();
    expect(files).toEqual([
      "api/index.ts",
      "dashboard/command-requests.ts",
      "dashboard/contracts.ts",
      "dashboard/remote/handler.ts",
      "dashboard/remote/intake-auth.ts",
      "dashboard/route-table.ts",
      "dashboard/routes.ts",
    ]);
    expect(files.filter((file) => file === "dashboard/server.ts" || /adapter/.test(file))).toEqual([]);
    expect([...packages].sort()).toEqual(["node:zlib", "postgres"]);
  });
});

describe("every route-table row is answered as its kind says", () => {
  const PROJECT = "walk";
  const LOOP = "ralph";
  const LOOP_ENTRY = { loop: LOOP };
  // A well-formed body for each relayed kind, as the local route's parser takes it.
  const BODIES: Record<string, unknown> = {
    control: { loop: LOOP, action: "pause" },
    start: { loop: LOOP },
    restart: { loop: LOOP, confirm: true },
    "stop-now": { loop: LOOP, confirm: true },
    "resume-work": { loop: LOOP },
    "agent-start": { name: "rulo" },
    "mark-read": { loop: LOOP, through: "2026-10-09T00:00:00.000Z" },
    "eval-start": { plan: { source: { kind: "pr", prs: [12] }, arms: [{ name: "opus" }] } },
    "eval-stop": { run: "eval-abc" },
    "eval-set-add": { repo: "felipearos/loggd", prs: [12], reason: "the migration case" },
    "eval-set-edit": { case: "loggd-12", notes: "graded on the diff" },
    "eval-set-retire": { case: "loggd-12" },
    "eval-set-check": { case: "loggd-12", test: "src/a.test.ts" },
    "eval-set-keep": { case: "loggd-12" },
    "eval-inbox-add": { plan: { source: { kind: "pr", prs: [12] }, arms: [{ name: "opus" }] }, reason: "worth a look" },
    "eval-inbox-start": { entry: "rec-1a2b3c4d" },
    "eval-inbox-dismiss": { entry: "rec-1a2b3c4d" },
    "eval-improve-propose": { run: "eval-abc", goal: "cost" },
    "eval-set-calibrate": { case: "loggd-12", arms: ["opus", "codex"], axis: "correctness", preferred: "opus", reason: "it kept the migration" },
    "eval-proposal-open-pr": { proposal: "prop-1a2b3c4d" },
  };
  const REMOTE_ONLY: Record<RemoteOnlyServes, [status: number, error: string | null]> = {
    bridge: [200, null],
    versions: [400, "BadRequest"],
    "command-view": [404, "UnknownCommand"],
    "intake-metrics": [403, "MetricsLocked"],
    "intake-session": [200, null],
    "intake-login": [403, "MetricsLocked"],
    "intake-logout": [200, null],
  };
  // Minimal bodies the projections can read: only the fields they touch.
  const DASHBOARD = { ownership: { claims: [] }, frontier: null, loops: [LOOP_ENTRY] } as unknown;
  const NOTIFICATIONS = { loops: [{ ...LOOP_ENTRY, items: [] }] } as unknown;
  const HEALTH = { selected: null, projects: [] } as unknown;
  const EVAL_PATCHES = { enabled: true, patches: [{ run: "r", case: "c", arm: "a", text: "diff\n", truncated: false }], omitted: 0, problem: null };

  beforeAll(async () => {
    await bridge({ leaseSeconds: 45 });
    for (const row of ROUTE_TABLE) {
      if (row.kind !== "snapshot") continue;
      const key = row.key.replace("<loop>", LOOP);
      await pushJson(row.scope === "global" ? GLOBAL_SNAPSHOT_PROJECT : PROJECT, key, { key });
    }
    await pushJson(PROJECT, "dashboard", DASHBOARD);
    await pushJson(PROJECT, "notifications", NOTIFICATIONS);
    await pushJson(GLOBAL_SNAPSHOT_PROJECT, "_/health", HEALTH);
    await pushJson(PROJECT, "evals-patches", EVAL_PATCHES);
  });

  const urlOf = (row: RouteRow): string => {
    const path = row.path.replace("<loop>", LOOP).replace("<id>", crypto.randomUUID());
    const query = row.loopFrom === "query" ? `?loop=${LOOP}` : row.path === "/api/evals/patch" ? "?run=r&case=c&arm=a" : "";
    return row.scope === "global" ? `${path}${query}` : `/api/p/${PROJECT}${path.slice("/api".length)}${query}`;
  };

  it.each(ROUTE_TABLE.map((row) => [`${row.method} ${row.path}`, row] as const))("%s", async (_name, row) => {
    const { handler, get, post } = remote();
    const url = urlOf(row);
    const response =
      row.method === "GET"
        ? await get(url)
        : row.method === "DELETE"
          ? await handler(new Request(`${ORIGIN}${url}`, { method: "DELETE", headers: { "sec-fetch-site": "same-origin" } }))
          : await post(url, row.kind === "command" ? BODIES[row.command] : {});
    if (response.status === 404 && (response.headers.get("content-type") ?? "").includes("json")) {
      expect(await response.clone().json()).not.toEqual({ error: "not found" });
    }
    switch (row.kind) {
      case "snapshot":
        expect(response.status).toBe(200);
        expect(response.headers.get("content-encoding")).toBe("gzip");
        break;
      case "derived":
        expect(response.status).toBe(200);
        // A trial's patch is a diff; every other projection is JSON.
        if (row.projection === "eval-patch") {
          expect(response.headers.get("content-type")).toMatch(/^text\/x-diff/);
          expect(await response.text()).toBe("diff\n");
        } else {
          expect(response.headers.get("content-type")).toMatch(/^application\/json/);
          await response.json();
        }
        break;
      case "command": {
        expect(response.status).toBe(202);
        const rows = await commandsOf(PROJECT);
        expect(rows.map((entry) => entry.kind)).toContain(row.command);
        break;
      }
      case "local-only": {
        expect(response.status).toBe(403);
        const body = (await response.json()) as { error: string; message: string };
        expect(body.error).toBe("LocalOnly");
        expect(body.message).toContain(row.label);
        break;
      }
      case "output":
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        break;
      case "stream":
        // One `unavailable` event: the page falls back to polling.
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(await response.text()).toContain("event: unavailable\n");
        break;
      case "remote-only": {
        // The handler's own answer for each, with no metrics password set and a command id nobody sent.
        const [status, error] = REMOTE_ONLY[row.serves];
        expect(response.status).toBe(status);
        if (error !== null) expect(((await response.json()) as { error: string }).error).toBe(error);
        break;
      }
    }
  });
});
