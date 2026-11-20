/**
 * The remote dashboard's HTTP surface, served from the hosted store instead
 * of local CLIs (spec #165 §3 "Route map", §5 "Insert", §8, §9 "Function").
 *
 * It does two things and nothing else: it reads the snapshots the bridge
 * pushed, and it inserts command rows for the bridge to relay. It never
 * reaches the machine, and it imports nothing that could: only the route
 * shapes, the route table, the contracts and its own early-400 checks.
 * `api/index.ts` hands it a postgres.js client logged in as `ralph_web`;
 * tests hand it the PGlite store acting as the same role.
 *
 * Which path does what is not written here: every request is looked up in
 * `../route-table.ts`, the one index of the remote dashboard's routes, and
 * answered as its row's kind says. A path with no row is a 404; a path whose
 * rows lack the request's method is a 405 naming the methods it has.
 *
 * - **Snapshot** routes answer the stored `gzip(compact JSON)` as it is, with
 *   `content-encoding: gzip` and `x-ralph-snapshot-at` (the push time). Each
 *   body is kept in instance memory per `(project, key, version)` and the
 *   version is read before the body, so a version crosses the wire about once
 *   per instance (Supabase Free egress is 5 GB a month).
 * - **Derived** routes parse a stored body and project it exactly as
 *   `server.ts` does.
 * - **Command** routes check the request, insert one `ralph.command` row and
 *   wait for the machine's answer, polling the row, for up to `waitMs`.
 * - **Local only** routes are a 403: they clone, create worktrees, open PRs or
 *   write configuration, and stay on the local dashboard.
 * - **Versions** (`GET /api/versions?since=…`, #731) holds the request until
 *   one of the page's read keys changes version, or `versionWaitMs` passes,
 *   reading the version columns alone: the remote page waits for a push
 *   instead of polling every read.
 *
 * Every snapshot read also upserts `ralph.viewer`, at most once per 15 s per
 * project per instance; a trigger turns that into the bridge's wake-up to push
 * this project hot.
 *
 * - **Intake** routes (felipearos/ralph#459) serve the clerk's intake page:
 *   the tickets as a snapshot, the metrics only to a session the metrics
 *   password opened (`intake-auth.ts`). With `surface: "intake"` they are the
 *   only routes served, read through `ralph.intake_snapshot` (`intake.sql`),
 *   for a deployment the team can open without a Vercel account.
 */
import { gunzipSync } from "node:zlib";

import {
  GLOBAL_SNAPSHOT_PROJECT,
  SNAPSHOT_SCHEMA,
  type BridgeStatusView,
  type IntakeSessionView,
  type OutputEvent,
  type ProjectsView,
  type RelayAccepted,
  type RelayedCommandKind,
  type RelayedCommandState,
  type RelayedCommandView,
  type SnapshotKey,
  type VersionsView,
} from "../contracts";
import { SCOPED_API_PATH } from "../routes";
import { checkCommandBody, ControlRouteError, parseJsonBody } from "../command-requests";
import { loopOf, matchRoute, PROJECTIONS, snapshotKeyOf, type Projection, type RouteMatch, type RouteRow } from "../route-table";
import { clientOf, createIntakeGate, type IntakeGate } from "./intake-auth";

/**
 * One parameterised statement against the store, answering its rows. Over
 * postgres.js this is `sql.unsafe(query, params)`; in tests, PGlite as
 * `ralph_web`. Each call is its own statement, so nothing here relies on a
 * session: the transaction pooler hands each one to any backend.
 */
export type Sql = <T = Record<string, unknown>>(query: string, params?: readonly unknown[]) => Promise<T[]>;

export interface RemoteHandlerOptions {
  sql: Sql;
  /** Wall time in ms, for the viewer throttle and the version-wait's deadline. */
  now?: () => number;
  /** How long a command POST waits for the machine's answer before a 202 (`RALPH_COMMAND_WAIT_MS`). */
  waitMs?: number;
  /** How often that wait reads the row. */
  pollMs?: number;
  /** The snapshot schema this app expects (`RALPH_SNAPSHOT_SCHEMA`). */
  schema?: number;
  /** A fresh command id. */
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Per-kind TTLs in place of `COMMAND_TTL_SECONDS`; the end-to-end test shortens them. */
  ttlSeconds?: Partial<Record<RelayedCommandKind, number>>;
  /** The intake metrics password's gate. Absent, the metrics are locked for everyone. */
  intake?: IntakeGate;
  /**
   * `intake` serves the intake routes alone, from `ralph.intake_snapshot`
   * (`RALPH_REMOTE_SURFACE=intake`); `full`, the default, serves everything.
   */
  surface?: RemoteSurface;
  /** How long `GET /api/versions` waits for a change before it answers the unchanged versions. */
  versionWaitMs?: number;
  /** How often that wait re-reads the versions. */
  versionPollMs?: number;
}

export type RemoteSurface = "full" | "intake";

/** A login body is a password and nothing much else. */
const LOGIN_BODY_MAX_BYTES = 1024;

/** The reserved placeholder project of the `_/` keys, shared with the bridge through `contracts.ts`. */
export { GLOBAL_SNAPSHOT_PROJECT };

export const DEFAULT_COMMAND_WAIT_MS = 25_000;
const POLL_MS = 500;
/**
 * The version-wait's hold: well under the function's 30 s limit (`vercel.json`
 * maxDuration), so a wait that ends on its deadline still has room for its
 * last check and its answer before the platform kills it.
 */
export const DEFAULT_VERSION_WAIT_MS = 25_000;
/** How often a version-wait re-reads: a push reaches a waiting page within about this long. */
export const VERSION_POLL_MS = 500;
/**
 * A page asks for its live reads' keys: five, plus two per loop
 * (`liveReads` in `ui/use-reads.ts`). Room for 250 loops; past this a
 * request is refused and the page polls, so it bounds only abuse.
 */
export const VERSION_KEYS_MAX = 505;
/** A snapshot key's shape (`dashboard`, `_/health`, `control/<loop>`, …): no whitespace, bounded. */
const VERSION_KEY = /^\S{1,120}$/;
/** One `viewer` write per project per instance per this long. */
export const VIEWER_THROTTLE_MS = 15_000;
/** A command POST's body, as sent and as stored. `ralph.command` checks the same. */
export const COMMAND_BODY_MAX_BYTES = 4096;
/** The same `(project, kind, loop or case, action)` within this long is the same click. */
const DUPLICATE_WINDOW = "3 seconds";

/**
 * The latest time the bridge may start a command, by kind (spec §5, "TTL"): a
 * start or a kill that fires minutes after the click acts on a situation the
 * operator no longer sees; controls wait for a boundary anyway; a read mark
 * only moves forward.
 */
export const COMMAND_TTL_SECONDS: Record<RelayedCommandKind, number> = {
  "stop-now": 60,
  start: 60,
  "resume-work": 60,
  "agent-start": 60,
  restart: 60,
  control: 300,
  "mark-read": 600,
  // A run takes hours: one that starts a minute late acts on the same plan.
  "eval-start": 300,
  "eval-stop": 60,
  // Adding a case reads its PRs before it writes: a few minutes late still
  // adds the same case. An edit, retire, keep or calibrate acts on what the
  // operator sees.
  "eval-set-add": 300,
  "eval-set-edit": 60,
  "eval-set-retire": 60,
  "eval-set-keep": 60,
  "eval-set-calibrate": 60,
  // A check clones the case and runs twice (base, then reference) before it
  // writes: a few minutes late still verifies the same check.
  "eval-set-check": 300,
  // An inbox add or start acts on a plan, as a start does: a few minutes late
  // queues or runs the same plan. A dismiss acts on what the operator sees.
  "eval-inbox-add": 300,
  "eval-inbox-start": 300,
  "eval-inbox-dismiss": 60,
  // A proposal reads a finished run, which does not change: a few minutes
  // late proposes the same, as an inbox add queues the same plan.
  "eval-improve-propose": 300,
  // Opening a PR re-checks the proposal passed and finds an open PR before it
  // opens one: a few minutes late opens the same PR, or answers the one open.
  "eval-proposal-open-pr": 300,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const failure = (status: number, error: string, message: string): Response => json({ error, message }, status);

const notFound = (): Response => json({ error: "not found" }, 404);
const noLoop = (name: string): Response => json({ error: `no loop '${name}'` }, 404);

const localOnly = (what: string): Response =>
  failure(403, "LocalOnly", `${what} is only available on the local dashboard`);

const bridgeNotLive = (): Response =>
  failure(503, "BridgeNotLive", "the machine's bridge is offline, so nothing could pick the command up; try again when it is back");

/** A Postgres timestamp as ISO, whichever driver read it. */
const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/* ------------------------------------------------------------------ outputs */

/**
 * The live output pane's one event: the remote dashboard relays no output.
 * `withheld` ends the stream and asks the browser to wait a minute before it
 * tries again, so an open loop page does not hammer the function.
 */
function withheldOutput(): Response {
  const event: OutputEvent = { kind: "withheld", reason: "Live output is not relayed to the remote dashboard" };
  return new Response(`retry: 60000\n\ndata: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/**
 * The page's change stream, answered once: the remote dashboard does not relay
 * it (yet), so the one `unavailable` event tells the page to fall back to its
 * polling, and the minute's retry keeps an open page from hammering the function.
 */
function unavailableStream(): Response {
  const body = { reason: "Live updates are not relayed to the remote dashboard" };
  return new Response(`retry: 60000\n\nevent: unavailable\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

interface CommandRow {
  id: string;
  kind: RelayedCommandKind;
  state: RelayedCommandState;
  created_at: unknown;
  expires_at: unknown;
  finished_at: unknown;
  http_status: number | null;
  result: unknown;
  why: string | null;
}

const COMMAND_COLUMNS = "id, kind, state, created_at, expires_at, finished_at, http_status, result, why";

const commandView = (row: CommandRow): RelayedCommandView => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  createdAt: iso(row.created_at)!,
  expiresAt: iso(row.expires_at)!,
  finishedAt: iso(row.finished_at),
  httpStatus: row.http_status,
  result: row.result ?? null,
  why: row.why,
});

/** The machine's own answer, as the local route gave it. */
const answered = (row: CommandRow): boolean =>
  (row.state === "done" || row.state === "refused") && row.http_status !== null && row.result !== null && row.result !== undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who sent a POST: the page itself, or another site riding the cookie. */
function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

/** The version-wait's `since`: each key to the version the page has; or why it is not one. */
function parseSince(raw: string | null): Record<string, number | null> | string {
  if (raw === null) return "since is required: a JSON object of snapshot keys to the versions the page has";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "since is not JSON";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "since must be a JSON object";
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > VERSION_KEYS_MAX) return `since names at most ${VERSION_KEYS_MAX} keys`;
  for (const [key, value] of entries) {
    if (!VERSION_KEY.test(key)) return `'${key.slice(0, 40)}' is not a snapshot key`;
    if (value !== null && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
      return `the version of '${key}' must be a non-negative integer or null`;
    }
  }
  return Object.fromEntries(entries) as Record<string, number | null>;
}

const isJson = (request: Request): boolean =>
  (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

/* ------------------------------------------------------------------ handler */

interface CachedSnapshot {
  version: string;
  body: Uint8Array<ArrayBuffer>;
  pushedAt: string | null;
  parsed?: unknown;
}

interface SnapshotRead {
  body: Uint8Array<ArrayBuffer>;
  pushedAt: string | null;
  parse(): unknown;
}

export function createRemoteHandler({
  sql,
  now = Date.now,
  waitMs = DEFAULT_COMMAND_WAIT_MS,
  pollMs = POLL_MS,
  schema = SNAPSHOT_SCHEMA,
  newId = () => crypto.randomUUID(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ttlSeconds = {},
  intake = createIntakeGate({ password: null }),
  surface = "full",
  versionWaitMs = DEFAULT_VERSION_WAIT_MS,
  versionPollMs = VERSION_POLL_MS,
}: RemoteHandlerOptions): (request: Request) => Promise<Response> {
  const cache = new Map<string, CachedSnapshot>();
  // The open intake deployment's role reads the two intake keys through a
  // view and nothing else; the main one reads the table, as for every key.
  const SNAPSHOT_TABLE = surface === "intake" ? "ralph.intake_snapshot" : "ralph.snapshot";
  const viewerWrittenAt = new Map<string, number>();

  /** Tell the bridge someone is looking at `project`, at most once per throttle. */
  const touchViewer = async (project: string): Promise<void> => {
    // The intake role may not write `ralph.viewer`: the page waits the idle cadence.
    if (project === GLOBAL_SNAPSHOT_PROJECT || surface === "intake") return;
    const at = now();
    const last = viewerWrittenAt.get(project);
    if (last !== undefined && at - last < VIEWER_THROTTLE_MS) return;
    viewerWrittenAt.set(project, at);
    try {
      await sql(
        `insert into ralph.viewer (project, last_seen_at) values ($1::text, now())
         on conflict (project) do update set last_seen_at = excluded.last_seen_at`,
        [project],
      );
    } catch {
      // Presence only changes the push cadence; a failed write must not fail the read.
      viewerWrittenAt.delete(project);
    }
  };

  /**
   * The stored snapshot, from the instance cache when its version is the
   * store's; or the answer to give instead when there is none to serve.
   */
  const readSnapshot = async (project: string, key: SnapshotKey): Promise<SnapshotRead | Response> => {
    const cacheKey = `${project}\u0000${key}`;
    type Head = { version: string | number | null; pushed_at: unknown; problem: string | null };
    const [head] = await sql<Head>(
      `select version, pushed_at, problem from ${SNAPSHOT_TABLE} where project = $1::text and key = $2::text`,
      [project, key],
    );
    if (head === undefined) {
      return failure(503, "NoSnapshot", `the machine has not pushed '${key}' yet`);
    }
    if (head.problem !== null) {
      if (head.problem === "too-large") return failure(503, "SnapshotTooLarge", `'${key}' is over the store's size limit, so it is not relayed`);
      return failure(503, "SnapshotUnavailable", `the machine could not read '${key}': ${head.problem}`);
    }
    const version = head.version === null ? null : String(head.version);
    let entry = version === null ? undefined : cache.get(cacheKey);
    if (entry === undefined || entry.version !== version) {
      const [row] = await sql<{ body: Uint8Array | null; version: string | number | null; pushed_at: unknown }>(
        `select body, version, pushed_at from ${SNAPSHOT_TABLE} where project = $1::text and key = $2::text`,
        [project, key],
      );
      if (row === undefined || row.body === null) return failure(503, "NoSnapshot", `the machine has not pushed '${key}' yet`);
      entry = { version: row.version === null ? "" : String(row.version), body: new Uint8Array(row.body), pushedAt: iso(row.pushed_at) };
      if (row.version !== null) cache.set(cacheKey, entry);
    }
    const hit = entry;
    return {
      body: hit.body,
      pushedAt: hit.pushedAt,
      parse: () => (hit.parsed ??= JSON.parse(gunzipSync(hit.body).toString("utf8")) as unknown),
    };
  };

  const snapshotHeaders = (read: SnapshotRead): Record<string, string> => ({
    "cache-control": "no-store",
    ...(read.pushedAt === null ? {} : { "x-ralph-snapshot-at": read.pushedAt }),
  });

  const serveSnapshot = async (project: string, key: SnapshotKey): Promise<Response> => {
    const read = await readSnapshot(project, key);
    if (read instanceof Response) return read;
    await touchViewer(project);
    return new Response(read.body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", ...snapshotHeaders(read) },
    });
  };

  const serveDerived = async (
    project: string,
    key: SnapshotKey,
    projection: Projection,
    input: Parameters<Projection>[1],
  ): Promise<Response> => {
    const read = await readSnapshot(project, key);
    if (read instanceof Response) return read;
    await touchViewer(project);
    const projected = projection(read.parse(), input);
    // As `server.ts`: a panel or feed the read does not name is the loop's 404,
    // unless the projection says why it found nothing (an eval patch, #825).
    // A projection with its own content type answers text, not JSON.
    const response = projected.found
      ? projected.contentType !== undefined
        ? new Response(String(projected.body), {
            status: 200,
            headers: { "content-type": projected.contentType, "cache-control": "no-store" },
          })
        : json(projected.body)
      : projected.why !== undefined
        ? failure(404, "NotFound", projected.why)
        : noLoop(input.loop);
    if (read.pushedAt !== null) response.headers.set("x-ralph-snapshot-at", read.pushedAt);
    return response;
  };

  /* ---------------------------------------------------------------- bridge */

  const bridgeStatus = async (project: string): Promise<BridgeStatusView> => {
    const [row] = await sql<BridgeRow>(
      `select coalesce(lease_until > now(), false) as live, last_seen_at, schema, local, wake, controls,
              hot ->> $1::text as hot_until, now() as now
       from ralph.bridge`,
      [project],
    );
    return bridgeView(row ?? null, schema);
  };

  const isLive = async (): Promise<boolean> =>
    (await sql<{ live: boolean }>("select exists (select 1 from ralph.bridge where lease_until > now()) as live"))[0]?.live === true;

  /* -------------------------------------------------------------- versions */

  /** Every asked key's current version, in one statement that reads no body; null when none. */
  const readVersions = async (project: string, keys: readonly string[]): Promise<Record<string, number | null>> => {
    // Each check counts as a look at the project, so the bridge keeps it hot
    // while a page only waits: otherwise nothing would push and nothing change.
    await touchViewer(project);
    const local = keys.filter((key) => !key.startsWith("_/"));
    const global = keys.filter((key) => key.startsWith("_/"));
    // The key lists go in as JSON text, as the command body does: no driver's
    // array encoding to rely on.
    const rows = await sql<{ project: string; key: string; version: string | number | null }>(
      `select project, key, version from ${SNAPSHOT_TABLE}
       where (project = $1::text and key in (select jsonb_array_elements_text($2::text::jsonb)))
          or (project = $3::text and key in (select jsonb_array_elements_text($4::text::jsonb)))`,
      [project, JSON.stringify(local), GLOBAL_SNAPSHOT_PROJECT, JSON.stringify(global)],
    );
    const versions: Record<string, number | null> = Object.fromEntries(keys.map((key) => [key, null]));
    for (const row of rows) {
      const wanted = row.key.startsWith("_/") ? row.project === GLOBAL_SNAPSHOT_PROJECT : row.project === project;
      // postgres.js reads a bigint as a string: the page compares numbers.
      if (wanted && row.key in versions) versions[row.key] = row.version === null ? null : Number(row.version);
    }
    return versions;
  };

  const serveVersions = async (request: Request, project: string, search: URLSearchParams): Promise<Response> => {
    const since = parseSince(search.get("since"));
    if (typeof since === "string") return failure(400, "BadRequest", since);
    const keys = Object.keys(since);
    const changed = (versions: Record<string, number | null>): boolean => keys.some((key) => versions[key] !== since[key]);
    const deadline = now() + versionWaitMs;
    let versions = await readVersions(project, keys);
    // A version that differs on the first check answers at once: that is how
    // a page holding nulls gets its baseline. Nothing asked, nothing to wait for.
    while (keys.length > 0 && !changed(versions) && !request.signal.aborted && now() < deadline) {
      await sleep(Math.min(versionPollMs, Math.max(0, deadline - now())));
      // The page went away: answer what is current, and let the function go.
      if (request.signal.aborted) break;
      versions = await readVersions(project, keys);
    }
    return json({ versions } satisfies VersionsView);
  };

  /* -------------------------------------------------------------- commands */

  /** Expire `id` if it is still queued past its TTL, then read it. */
  const readCommand = async (project: string, id: string): Promise<CommandRow | null> => {
    await sql(
      `update ralph.command
       set state = 'expired', finished_at = now(),
           why = 'the machine did not pick it up within ' || case kind when 'control' then '5 min' when 'mark-read' then '10 min' when 'eval-start' then '5 min' when 'eval-set-add' then '5 min' when 'eval-set-check' then '5 min' when 'eval-inbox-add' then '5 min' when 'eval-inbox-start' then '5 min' when 'eval-improve-propose' then '5 min' when 'eval-proposal-open-pr' then '5 min' else '60 s' end
       where id = $1::uuid and project = $2::text and state = 'queued' and expires_at < now()`,
      [id, project],
    );
    const [row] = await sql<CommandRow>(`select ${COMMAND_COLUMNS} from ralph.command where id = $1::uuid and project = $2::text`, [
      id,
      project,
    ]);
    return row ?? null;
  };

  const relay = async (request: Request, project: string, kind: RelayedCommandKind): Promise<Response> => {
    if (!isJson(request)) return failure(415, "UnsupportedMediaType", "send the command as content-type: application/json");
    if (!sameOrigin(request)) return failure(403, "CrossOrigin", "a command must come from the dashboard's own page");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > COMMAND_BODY_MAX_BYTES) {
      return failure(413, "BodyTooLarge", `a command body is at most ${COMMAND_BODY_MAX_BYTES} bytes`);
    }
    if (!(await isLive())) return bridgeNotLive();

    let parsed: unknown;
    try {
      parsed = parseJsonBody(raw);
      checkCommandBody(kind, parsed);
    } catch (error) {
      if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
      throw error;
    }
    const fields = parsed as Record<string, unknown>;
    // The id is the idempotency key every local write path records the command under.
    const id = newId();
    const body = JSON.stringify({ ...fields, id, via: "remote" });
    if (new TextEncoder().encode(body).length > COMMAND_BODY_MAX_BYTES) {
      return failure(413, "BodyTooLarge", `a command body is at most ${COMMAND_BODY_MAX_BYTES} bytes`);
    }
    // What a click acts on, for the duplicate window: a loop or agent, or a
    // test-set case (#856), so retiring two cases in turn is two commands.
    const loop = typeof fields.loop === "string" ? fields.loop : typeof fields.name === "string" ? fields.name : typeof fields.case === "string" ? fields.case : null;
    const action = typeof fields.action === "string" ? fields.action : null;

    let row: CommandRow | undefined;
    try {
      // One click is one row: a second POST of the same command within the
      // window answers the first one's row instead of inserting another.
      [row] = await sql<CommandRow>(
        `with existing as (
           select ${COMMAND_COLUMNS} from ralph.command
           where project = $1::text and kind = $2::text
             and coalesce(body ->> 'loop', body ->> 'name', body ->> 'case') is not distinct from $5::text
             and body ->> 'action' is not distinct from $6::text
             and created_at > now() - interval '${DUPLICATE_WINDOW}'
           order by created_at desc limit 1
         ), inserted as (
           -- The body goes in as text: postgres.js would JSON.stringify a jsonb parameter into a string.
           insert into ralph.command (id, project, kind, body, expires_at)
           select $7::uuid, $1::text, $2::text, $3::text::jsonb, now() + make_interval(secs => $4::double precision)
           where not exists (select 1 from existing)
           returning ${COMMAND_COLUMNS}
         )
         select * from inserted union all select * from existing`,
        [project, kind, body, ttlSeconds[kind] ?? COMMAND_TTL_SECONDS[kind], loop, action, id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("bridge-not-live")) return bridgeNotLive();
      if (message.includes("rate-limited")) {
        return failure(429, "RateLimited", "this project has had 30 commands in the last minute; wait a moment");
      }
      throw error;
    }
    if (row === undefined) throw new Error("the command insert returned no row");

    // Wait while the machine may still answer; a row it ended without an
    // answer (expired, failed, refused by the kill switch) is a 202 at once.
    for (let waited = 0; waited < waitMs && (row.state === "queued" || row.state === "claimed"); waited += pollMs) {
      await sleep(pollMs);
      row = (await readCommand(project, row.id)) ?? row;
    }
    if (answered(row)) {
      return json(row.result, row.http_status!, { "x-ralph-command": row.id });
    }
    return json(
      { relay: { id: row.id, state: row.state, expiresAt: iso(row.expires_at)! } } satisfies RelayAccepted,
      202,
      { "x-ralph-command": row.id },
    );
  };

  const serveCommand = async (project: string, id: string): Promise<Response> => {
    const row = UUID.test(id) ? await readCommand(project, id) : null;
    if (row === null) return failure(404, "UnknownCommand", `no command '${id}' in this project`);
    return json(commandView(row) satisfies RelayedCommandView);
  };

  /* --------------------------------------------------------------- intake */

  const metricsLocked = (): Response =>
    failure(403, "MetricsLocked", "las métricas están bloqueadas: este despliegue no tiene contraseña configurada");

  const serveIntakeMetrics = async (request: Request, project: string): Promise<Response> => {
    // Checked before the store is read: without a session nothing of the
    // payload, not even whether one exists, reaches the browser.
    if (!intake.configured) return metricsLocked();
    if (!(await intake.session(request))) return failure(401, "Unauthorized", "ingresa la contraseña de las métricas");
    const response = await serveSnapshot(project, "intake-metrics");
    response.headers.set("cache-control", "no-store, private");
    response.headers.set("vary", "cookie");
    return response;
  };

  const intakeLogin = async (request: Request): Promise<Response> => {
    if (!isJson(request)) return failure(415, "UnsupportedMediaType", "send the password as content-type: application/json");
    if (!sameOrigin(request)) return failure(403, "CrossOrigin", "a login must come from the dashboard's own page");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > LOGIN_BODY_MAX_BYTES) return failure(413, "BodyTooLarge", "the login body is too large");
    let password: unknown;
    try {
      password = (JSON.parse(raw) as { password?: unknown } | null)?.password;
    } catch {
      return failure(400, "BadRequest", "the login body is not JSON");
    }
    const result = await intake.login(password, clientOf(request));
    if (result.ok) {
      return json({ access: "unlocked" } satisfies IntakeSessionView, 200, { "set-cookie": result.cookie });
    }
    if (result.reason === "unconfigured") return metricsLocked();
    if (result.reason === "throttled") {
      return json(
        { error: "RateLimited", message: "demasiados intentos; espera unos minutos" },
        429,
        { "retry-after": String(result.retryAfterSeconds ?? 60) },
      );
    }
    return failure(401, "WrongPassword", "contraseña incorrecta");
  };

  /* ---------------------------------------------------------------- serve */

  /** The route the hosted function alone serves, as its row's `serves` names it. */
  const serveRemoteOnly = async (
    request: Request,
    project: string,
    row: RouteRow & { kind: "remote-only" },
    match: RouteMatch,
  ): Promise<Response> => {
    switch (row.serves) {
      case "command-view":
        return serveCommand(project, match.params.id ?? "");
      case "bridge":
        return json((await bridgeStatus(project)) satisfies BridgeStatusView);
      case "versions":
        return serveVersions(request, project, new URL(request.url).searchParams);
      case "intake-metrics":
        return serveIntakeMetrics(request, project);
      case "intake-session": {
        const access = !intake.configured ? "unconfigured" : (await intake.session(request)) ? "unlocked" : "locked";
        return json({ access } satisfies IntakeSessionView);
      }
      case "intake-login":
        return intakeLogin(request);
      case "intake-logout":
        if (!sameOrigin(request)) return failure(403, "CrossOrigin", "a logout must come from the dashboard's own page");
        return json({ access: intake.configured ? "locked" : "unconfigured" } satisfies IntakeSessionView, 200, { "set-cookie": intake.logoutCookie });
    }
  };

  /** One row, answered as its kind says. */
  const perform = async (request: Request, project: string, row: RouteRow, match: RouteMatch, search: URLSearchParams): Promise<Response> => {
    switch (row.kind) {
      case "snapshot":
        return serveSnapshot(project, snapshotKeyOf(row, match.params, search));
      case "derived":
        return serveDerived(project, row.source, PROJECTIONS[row.projection], { loop: loopOf(row, match.params, search), search });
      case "output":
        return withheldOutput();
      case "stream":
        return unavailableStream();
      case "command":
        return relay(request, project, row.command);
      case "remote-only":
        return serveRemoteOnly(request, project, row, match);
      case "local-only":
        return localOnly(row.label);
    }
  };

  const dispatch = (request: Request, project: string, match: RouteMatch | null, search: URLSearchParams): Promise<Response> | Response => {
    if (match === null) return notFound();
    const row = match.rows.find((entry) => entry.method === request.method);
    if (row === undefined) {
      return new Response("method not allowed", { status: 405, headers: { allow: match.rows.map((entry) => entry.method).join(", ") } });
    }
    return perform(request, project, row, match, search);
  };


  /** The first registered project, which an unscoped `/api/…` path means, as locally. */
  const firstProject = async (): Promise<string | null> => {
    const read = await readSnapshot(GLOBAL_SNAPSHOT_PROJECT, "_/projects");
    if (read instanceof Response) return null;
    return (read.parse() as ProjectsView).projects[0]?.id ?? null;
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    try {
      if (surface === "intake") {
        // Scoped intake paths only: the project list itself is not this deployment's to show.
        const scoped = SCOPED_API_PATH.exec(pathname);
        if (scoped === null) return notFound();
        return await dispatch(request, decodeURIComponent(scoped[1]!), matchRoute(`/api${scoped[2] ?? ""}`, "project", (entry) => entry.intake), searchParams);
      }
      const global = matchRoute(pathname, "global");
      if (global !== null) return await dispatch(request, GLOBAL_SNAPSHOT_PROJECT, global, searchParams);

      const scoped = SCOPED_API_PATH.exec(pathname);
      if (scoped !== null) {
        const project = decodeURIComponent(scoped[1]!);
        return await dispatch(request, project, matchRoute(`/api${scoped[2] ?? ""}`, "project"), searchParams);
      }
      if (pathname.startsWith("/api/")) {
        const routes = matchRoute(pathname, "project");
        if (routes === null) return notFound();
        const project = await firstProject();
        if (project === null) return failure(404, "UnknownProject", "no project is registered");
        return await dispatch(request, project, routes, searchParams);
      }
      return notFound();
    } catch (error) {
      return failure(500, "error", error instanceof Error ? error.message : String(error));
    }
  };
}

/** `ralph.bridge` as `GET /api/bridge` reads it, with this project's hot-until and the database's clock. */
interface BridgeRow {
  live: boolean;
  last_seen_at: unknown;
  schema: number | null;
  local: BridgeStatusView["local"] | null;
  wake: BridgeStatusView["wake"] | null;
  controls: BridgeStatusView["controls"] | null;
  hot_until: unknown;
  now: unknown;
}

/** The bridge row as the page's banner reads it; `row` null when no bridge ever registered. */
export function bridgeView(row: BridgeRow | null, appSchema: number): BridgeStatusView {
  const live = row?.live === true;
  const local = row?.local ?? "dashboard-down";
  const bridgeSchema = row?.schema ?? 0;
  const hotUntil = iso(row?.hot_until);
  const dbNow = iso(row?.now);
  const hot = hotUntil !== null && dbNow !== null && Date.parse(hotUntil) > Date.parse(dbNow);
  const why =
    row === null
      ? "no bridge has ever connected to the store"
      : !live
        ? "the machine is offline: its bridge has not checked in for 45 s"
        : local === "dashboard-down"
          ? "the machine is up, but its local dashboard is down"
          : local === "redactor-degraded"
            ? "the machine's redactor is failing, so nothing is relayed"
            : bridgeSchema !== appSchema
              ? `the machine runs an older ralph (snapshot schema ${bridgeSchema}, this page expects ${appSchema}); deploy ~/ralph`
              : row.controls !== "enabled"
                ? "remote control is disabled on the machine"
                : null;
  return {
    live,
    snapshots: hot ? "hot" : "idle",
    lastSeenAt: iso(row?.last_seen_at),
    wake: row?.wake ?? "poll-only",
    local,
    controls: why === null ? "enabled" : "disabled",
    why,
    schema: { bridge: bridgeSchema, app: appSchema },
  };
}

/**
 * The function on a deployment with no store configured (every preview): the
 * banner reads an offline bridge, and every other route says why it is empty.
 */
export function createUnconfiguredHandler(schema = SNAPSHOT_SCHEMA): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const scoped = SCOPED_API_PATH.exec(pathname);
    const rest = scoped === null ? pathname : `/api${scoped[2] ?? ""}`;
    const bridgeRow = matchRoute(rest, "project", (entry) => entry.kind === "remote-only" && entry.serves === "bridge")?.rows[0];
    if (bridgeRow !== undefined && request.method === bridgeRow.method) {
      return json({ ...bridgeView(null, schema), why: "this deployment has no store configured" } satisfies BridgeStatusView);
    }
    return failure(503, "StoreNotConfigured", "this deployment has no store configured (RALPH_WEB_DATABASE_URL)");
  };
}
