/**
 * A preview of the remote dashboard: the unchanged shell, flagged remote,
 * served by the real remote handler over a store holding a pushed snapshot.
 *
 *   bun run dashboard:remote-preview
 *
 * The machine is the design preview (`../preview.ts`), started as a child on
 * its own port: its canned loops are read through the real collector and
 * pushed into an in-memory store (PGlite with `schema.sql` and `roles.sql`,
 * `test-store.ts`), and the handler reads them as `ralph_web`, exactly as the
 * Vercel function does. Nothing here touches a loop or a hosted store.
 *
 * A stand-in for the bridge holds the lease and applies queued commands by
 * posting them to the design preview, then pushes again. It is not the
 * bridge (`bridge.ts`): no lease race, no TTL, no audit, no Realtime.
 *
 * `/__remote-preview/…` drives what the page sees, for the browser test
 * (`remote-ui.e2e.test.ts`) and by hand:
 *
 * - `POST /bridge` `{ live?, seenSecondsAgo?, local?, wake?, controls?, schema?, hot? }`
 *   rewrites the bridge row;
 * - `POST /age` `{ seconds }` makes every snapshot that old;
 * - `POST /relay` `{ delayMs }` holds each command that long before applying it;
 * - `POST /snapshot` `{ project, key, value }` pushes one body of your own.
 *
 * `RALPH_REMOTE_PREVIEW_PORT` (default 8793, 0 for any) and
 * `RALPH_REMOTE_PREVIEW_WAIT_MS` (the handler's command wait, default 25 s).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildShell, flagRemote } from "../build";
import { SNAPSHOT_SCHEMA, type RelayedCommandKind } from "../contracts";
import { isShellPath, SCOPED_PAGE_PATH } from "../routes";
import { collect, type Collected } from "./collect";
import { createRemoteHandler, GLOBAL_SNAPSHOT_PROJECT } from "./handler";
import { createTestStore } from "./test-store";

const PORT = Number(process.env.RALPH_REMOTE_PREVIEW_PORT ?? 8793);
const HOST = process.env.RALPH_PREVIEW_HOST ?? "127.0.0.1";
const WAIT_MS = Number(process.env.RALPH_REMOTE_PREVIEW_WAIT_MS ?? 25_000);
/** The design preview's one project. */
const PROJECT = "preview";

/* ------------------------------------------------------------- the machine */

/** Start the design preview on a free port and answer its address. */
async function startMachine(): Promise<{ base: string; stop: () => void }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../preview.ts", import.meta.url))], {
    env: { ...process.env, RALPH_PREVIEW_PORT: "0", RALPH_PREVIEW_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () => child.kill("SIGTERM");
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
  const base = await new Promise<string>((resolve, reject) => {
    let said = "";
    const read = (chunk: Buffer): void => {
      said += chunk.toString();
      const found = /preview on (http:\/\/[^\s]+)/.exec(said);
      if (found !== null) resolve(found[1]!);
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => reject(new Error(`the design preview exited (${String(code)}):\n${said}`)));
  });
  return { base, stop };
}

const machine = await startMachine();
const store = await createTestStore();
let version = 0;

/** Store what was collected, as the bridge's push would. */
async function push(collected: readonly Collected[]): Promise<void> {
  for (const entry of collected) {
    version += 1;
    const project = entry.project ?? GLOBAL_SNAPSHOT_PROJECT;
    const body = "body" in entry ? entry.body : null;
    const problem = "body" in entry ? null : entry.problem;
    await store.owner(
      `insert into ralph.snapshot (project, key, body, hash, version, pushed_at, problem)
       values ($1, $2, $3, $4, $5, now(), $6)
       on conflict (project, key) do update
         set body = excluded.body, hash = excluded.hash, version = excluded.version,
             pushed_at = excluded.pushed_at, problem = excluded.problem`,
      [project, entry.key, body, "body" in entry ? entry.hash : null, version, problem],
    );
  }
}

/** Read every allowlisted route off the machine and push it. The canned data holds no secret to scrub. */
async function pushAll(): Promise<void> {
  const result = await collect({ base: machine.base, redact: async (lines) => [...lines] });
  if (!result.ok) throw new Error(`the preview's collect failed: ${result.detail}`);
  await push(result.snapshots);
}

interface BridgeState {
  live: boolean;
  seenSecondsAgo: number;
  local: "ok" | "dashboard-down" | "redactor-degraded";
  wake: "realtime" | "poll-only";
  controls: "enabled" | "disabled";
  schema: number;
  hot: boolean;
}

const LIVE: BridgeState = { live: true, seenSecondsAgo: 2, local: "ok", wake: "realtime", controls: "enabled", schema: SNAPSHOT_SCHEMA, hot: true };

/** Rewrite the bridge row; an offline bridge's lease ran out a minute ago. */
async function setBridge(state: BridgeState): Promise<void> {
  await store.lease(state.live ? 3600 : -60, "remote-preview");
  await store.owner(
    `update ralph.bridge set last_seen_at = now() - make_interval(secs => $1), schema = $2, controls = $3, local = $4, wake = $5,
       hot = case when $6 then jsonb_build_object($7::text, now() + interval '20 minutes') else '{}'::jsonb end`,
    [state.live ? state.seenSecondsAgo : Math.max(state.seenSecondsAgo, 60), state.schema, state.controls, state.local, state.wake, state.hot, PROJECT],
  );
}

/* ------------------------------------------------------- the relay stand-in */

const ROUTE: Record<RelayedCommandKind, string> = {
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
};

let relayDelayMs = 0;

/** Apply each queued command older than the delay: post it to the machine and record its answer. */
async function relayQueued(): Promise<void> {
  const rows = await store.owner<{ id: string; project: string; kind: RelayedCommandKind; body: Record<string, unknown> }>(
    `update ralph.command set state = 'claimed', claimed_at = now(), claimed_by = 'remote-preview', attempts = attempts + 1
     where state = 'queued' and created_at < now() - make_interval(secs => $1)
     returning id, project, kind, body`,
    [relayDelayMs / 1000],
  );
  for (const row of rows) {
    const response = await fetch(new URL(`/api/p/${encodeURIComponent(row.project)}${ROUTE[row.kind].slice("/api".length)}`, machine.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row.body),
    });
    const result = (await response.json().catch(() => ({ error: "NotJson", message: "the local route did not answer JSON" }))) as unknown;
    await store.owner(
      `update ralph.command set state = $2, finished_at = now(), http_status = $3, result = $4::jsonb where id = $1::uuid`,
      [row.id, response.ok ? "done" : "refused", response.status, JSON.stringify(result)],
    );
  }
  if (rows.length > 0) await pushAll();
}

let relaying = false;
setInterval(() => {
  if (relaying) return;
  relaying = true;
  relayQueued()
    .catch((error: unknown) => console.error("relay:", error))
    .finally(() => {
      relaying = false;
    });
}, 250);

/* ------------------------------------------------------------------- serve */

await setBridge(LIVE);
await pushAll();
const shell = await buildShell();
const html = flagRemote(shell.html);
const handler = createRemoteHandler({ sql: (query, params = []) => store.as("ralph_web", query, [...params]), waitMs: WAIT_MS });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** The `/__remote-preview/…` hooks. */
async function drive(request: Request, hook: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  switch (hook) {
    case "bridge":
      await setBridge({ ...LIVE, ...(body as Partial<BridgeState>) });
      return json({ ok: true });
    case "age":
      await store.owner("update ralph.snapshot set pushed_at = now() - make_interval(secs => $1), version = version + 1000000", [
        Number(body.seconds ?? 0),
      ]);
      return json({ ok: true });
    case "relay":
      relayDelayMs = Number(body.delayMs ?? 0);
      return json({ ok: true });
    case "snapshot": {
      version += 1;
      const value = new Uint8Array(gzipSync(JSON.stringify(body.value)));
      await store.owner(
        `insert into ralph.snapshot (project, key, body, hash, version, pushed_at) values ($1, $2, $3, 'preview', $4, now())
         on conflict (project, key) do update set body = excluded.body, version = excluded.version, pushed_at = excluded.pushed_at, problem = null`,
        [String(body.project ?? PROJECT), String(body.key), value, version],
      );
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // Past Bun's 10 s default: the page's `/api/versions` wait is held up to
  // `DEFAULT_VERSION_WAIT_MS` (25 s), and an idle cut would read as a failed wait (#731).
  idleTimeout: 60,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/__remote-preview/")) return drive(request, pathname.slice("/__remote-preview/".length));
    if (pathname.startsWith("/api/")) return handler(request);
    // As `vercel.json`'s rewrites: every page is the one document.
    if (pathname === "/" || SCOPED_PAGE_PATH.test(pathname) || isShellPath(pathname)) {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    const asset = shell.assets.get(pathname);
    if (asset !== undefined) return new Response(asset.body, { headers: { "content-type": asset.type } });
    return json({ error: "not found" }, 404);
  },
});

console.log(`ralph-dashboard remote preview on http://${server.hostname}:${server.port} (machine: ${machine.base})`);
