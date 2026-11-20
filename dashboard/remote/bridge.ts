/**
 * The bridge: the long-running process on the operator's machine that keeps
 * the hosted store fresh (spec #165 §4 "Cadence", §6).
 *
 * It is a client of the RUNNING local dashboard (`http://127.0.0.1:8791`),
 * never a second copy of its adapters. It reaches the server two ways only:
 * every body it reads goes through `collect.ts`, whose closed
 * `SNAPSHOT_ROUTES` allowlist is the only way a body leaves, scrubbed there;
 * and `local-stream.ts` holds the route table's change-stream row open, which
 * carries invalidations (a key and a version), never a body, and is never
 * forwarded. It imports no ralph module and spawns nothing but the redactor,
 * which `read-only.test.ts` pins.
 *
 * - **One instance.** `flock -n` on `$XDG_RUNTIME_DIR/ralph-bridge.lock` per
 *   machine; a second process exits 0 with "already running". In the store, a
 *   lease on the one `ralph.bridge` row (`instance`, `lease_until = now() +
 *   45 s`). Without the lease it reads nothing locally and pushes nothing, and
 *   every snapshot write re-checks the lease in the same statement.
 * - **Heartbeat**, every 15 s whatever the mode: renew the lease and report
 *   `schema`, `local`, `wake`, `controls` and `hot`, then read `ralph.viewer`
 *   as the fallback for a missed `viewer` wake-up.
 * - **Snapshots**, on a per-key cadence that is fast for a hot project and
 *   slow for an idle one, never sooner than twice the key's last read time
 *   after the previous read. Only keys whose hash moved are written.
 * - **Hot**: a viewer in the last 120 s (which also pushes the whole project
 *   at once), or a newly appearing `approval`/`errored` need in `_/health` in
 *   the last 20 min.
 * - **Backoff**: the store unreachable means 2 s doubling to 5 min, ±20 %,
 *   with no local reads meanwhile and a full push on reconnect. The local
 *   dashboard down means heartbeats with `local: "dashboard-down"` and a probe
 *   every 10 s. A redactor that fails means nothing pushed and `local:
 *   "redactor-degraded"`. A write the database rejects is logged and skipped.
 * - **Change stream**: while a project is hot the bridge holds its local
 *   `/api/p/<project>/stream` open (#724) and reads a key the stream names on
 *   the next tick, still never sooner than twice its last read time. The
 *   timers above stay the fallback, so a stream that fails only makes the
 *   bridge slower; it reopens with backoff. Idle projects are never streamed.
 *
 * - **Commands**: `relay.ts`, registered by `main` through `relay()`, turns
 *   each command row into a POST on the local dashboard; only then does the
 *   heartbeat report `controls: "enabled"`.
 *
 * The process itself is `tick()`, run every second; tests drive it directly
 * against a fake clock, the PGlite store and the real handler.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import postgres from "postgres";

import { GLOBAL_SNAPSHOT_PROJECT, SNAPSHOT_SCHEMA, type ProjectsHealthView } from "../contracts";
import {
  collect,
  collectTargets,
  pushBatches,
  SNAPSHOT_ROUTES,
  targetFor,
  type Collected,
  type CollectOptions,
  type CollectResult,
  type Snapshot,
  type SnapshotTarget,
} from "./collect";
import { createLocalStreams, openLocalStream, type LocalStream, type LocalStreamHandlers } from "./local-stream";
import { createRelay } from "./relay";
import { processRedactor } from "./scrub";
import { backoffDelay, startWake, type CommandWake, type WakeOptions, type WakeStatus } from "./wake";

/** How long a heartbeat's lease lasts: three missed beats and the bridge is offline. */
export const LEASE_SECONDS = 45;

/** What the bridge reports about the local side. */
export type LocalStatus = "ok" | "dashboard-down" | "redactor-degraded";

/**
 * The cadence classes of §4's table: `live` is `dashboard`, `controls`
 * and `control/*`;
 * `feed` is `usage`, `notifications` and `history/*`; `global` is the `_/`
 * keys; `config` is everything else.
 */
export type CadenceClass = "live" | "feed" | "global" | "config";

export interface BridgeTimings {
  /** Per class, how often a key is read while its project is hot, and while idle. */
  cadence: Record<CadenceClass, { hot: number; idle: number }>;
  heartbeatMs: number;
  /** How long each heartbeat's lease lasts. */
  leaseMs: number;
  /** How long a viewer keeps its project hot. */
  viewerMs: number;
  /** How long a new approval or error keeps its project hot. */
  attentionMs: number;
  /** How often a down local dashboard is probed. */
  localRetryMs: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export const DEFAULT_TIMINGS: BridgeTimings = {
  cadence: {
    live: { hot: 5 * SECOND, idle: 5 * MINUTE },
    feed: { hot: 15 * SECOND, idle: 15 * MINUTE },
    global: { hot: 30 * SECOND, idle: 60 * SECOND },
    config: { hot: 30 * SECOND, idle: 15 * MINUTE },
  },
  heartbeatMs: 15 * SECOND,
  leaseMs: LEASE_SECONDS * SECOND,
  viewerMs: 120 * SECOND,
  attentionMs: 20 * MINUTE,
  localRetryMs: 10 * SECOND,
};

/** The class a snapshot key is read at. */
export function cadenceClassOf(key: string): CadenceClass {
  if (key.startsWith("_/")) return "global";
  if (key === "dashboard" || key === "controls" || key.startsWith("control/")) return "live";
  // The sentinel panel changes as the sentinel works, and the Evals tab and its
  // trials' patches as a run does, unlike the config reads. The test set
  // (`evals-set`, #856) is not here: it changes only on an operator's write,
  // so it is read at the config cadence like the other settings. Neither are
  // the suggestions (`evals-suggestions`, #858): each read costs `gh` calls
  // and merged PRs move slowly, so the config cadence is fast enough. Nor is
  // the inbox (`evals-inbox`, #872): it changes on an operator's or an
  // agent's write, like the test set. The proposals (`evals-proposals`, #874)
  // are: each one's status moves as its subset and full-set runs do.
  if (
    key === "usage" ||
    key === "notifications" ||
    key === "sentinel" ||
    key === "evals" ||
    key === "evals-patches" ||
    key === "evals-proposals" ||
    key.startsWith("history/")
  ) return "feed";
  return "config";
}

/**
 * The timings with every `RALPH_BRIDGE_*` knob applied: `RALPH_BRIDGE_<CLASS>_
 * <HOT|IDLE>_MS` per cadence class, plus `RALPH_BRIDGE_HEARTBEAT_MS`,
 * `_LEASE_MS`, `_VIEWER_MS`, `_ATTENTION_MS` and `_LOCAL_RETRY_MS`. A knob
 * that is not a positive number is ignored.
 */
export function timingsFromEnv(env: Record<string, string | undefined>): BridgeTimings {
  const knob = (name: string, fallback: number): number => {
    const value = Number(env[`RALPH_BRIDGE_${name}`]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const cadence = Object.fromEntries(
    Object.entries(DEFAULT_TIMINGS.cadence).map(([name, { hot, idle }]) => [
      name,
      { hot: knob(`${name.toUpperCase()}_HOT_MS`, hot), idle: knob(`${name.toUpperCase()}_IDLE_MS`, idle) },
    ]),
  ) as BridgeTimings["cadence"];
  return {
    cadence,
    heartbeatMs: knob("HEARTBEAT_MS", DEFAULT_TIMINGS.heartbeatMs),
    leaseMs: knob("LEASE_MS", DEFAULT_TIMINGS.leaseMs),
    viewerMs: knob("VIEWER_MS", DEFAULT_TIMINGS.viewerMs),
    attentionMs: knob("ATTENTION_MS", DEFAULT_TIMINGS.attentionMs),
    localRetryMs: knob("LOCAL_RETRY_MS", DEFAULT_TIMINGS.localRetryMs),
  };
}

/** The one thing the bridge needs from Postgres: run a statement, get its rows. */
export interface BridgeStore {
  query<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]>;
}

/**
 * Every statement the bridge runs, as role `ralph_bridge`. Each write that
 * needs the lease checks it in the same statement, so a lease lost between
 * two beats stops the very next write.
 */
export const SQL = {
  /** Take or renew the lease for `$8` ms and report; no row back means another instance holds it. */
  heartbeat: `
    insert into ralph.bridge as b (singleton, instance, lease_until, last_seen_at, schema, local, wake, controls, hot, problem)
    values (true, $1::text, now() + make_interval(secs => $8::double precision / 1000), now(), $2::int, $3::text, $4::text, $5::text, $6::text::jsonb, $7::text)
    on conflict (singleton) do update
      set instance = excluded.instance, lease_until = excluded.lease_until, last_seen_at = excluded.last_seen_at,
          schema = excluded.schema, local = excluded.local, wake = excluded.wake, controls = excluded.controls,
          hot = excluded.hot, problem = excluded.problem
      where b.instance = excluded.instance or b.lease_until is null or b.lease_until <= now()
    returning instance`,
  /** Every viewer row, with its age by the database's clock. */
  viewers: `
    select project, (extract(epoch from now() - last_seen_at) * 1000)::float8 as age_ms
    from ralph.viewer where last_seen_at is not null`,
  /** What the store holds, so a (re)connect writes only what moved. */
  hashes: `select project, key, hash, problem from ralph.snapshot`,
  /** One key, written only while this instance holds the lease. */
  push: `
    insert into ralph.snapshot as s (project, key, body, hash, version, pushed_at, problem)
    select $2::text, $3::text, $4::bytea, $5::text, 1, now(), $6::text
    where exists (select 1 from ralph.bridge where instance = $1::text and lease_until > now())
    on conflict (project, key) do update
      set body = excluded.body, hash = excluded.hash, version = coalesce(s.version, 0) + 1,
          pushed_at = excluded.pushed_at, problem = excluded.problem
    returning version`,
  /** Give the lease up on a clean stop, so the next process need not wait it out. */
  release: `update ralph.bridge set lease_until = now() where instance = $1::text`,
} as const;

/**
 * Whether the database answered and refused (a CHECK violation, read-only
 * mode), as opposed to not being reached. A refusal carries a SQLSTATE; the
 * connection-exception, resource and operator-intervention classes (08, 53,
 * 57) mean the server is going or gone.
 */
export function isRejected(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !/^(08|53|57)/.test(code);
}

/** What the relay ticket (#173) plugs into the running process. */
export interface RelayHooks {
  onCommand?: (wake: CommandWake) => void | Promise<void>;
  onSweep?: () => void | Promise<void>;
}

export interface BridgeOptions {
  store: BridgeStore;
  /** How the local dashboard is read: its base URL, the redactor and, in tests, `fetch`. */
  local: Omit<CollectOptions, "now">;
  timings?: BridgeTimings;
  /** `RALPH_BRIDGE_CONTROLS`: `off` is the kill switch. */
  controls?: "on" | "off";
  instance?: string;
  /** Wall time, in ms. */
  now?: () => number;
  /** The backoff jitter source, `[0, 1)`. */
  random?: () => number;
  log?: (line: string) => void;
  /** How one project's local change stream is opened; default the local dashboard's, over `local.fetch`. */
  stream?: (project: string, handlers: LocalStreamHandlers) => LocalStream;
  /** The timers the stream reopens on; default the real ones. Tests drive them. */
  streamTimers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
}

/** What the bridge believes, for its heartbeat and for tests. */
export interface BridgeState {
  instance: string;
  connected: boolean;
  leased: boolean;
  local: LocalStatus;
  wake: WakeStatus;
  /** Project → until when it is hot, in ms. */
  hot: Record<string, number>;
}

export interface Bridge {
  readonly instance: string;
  /** One step: heartbeat when due, then whatever reads and pushes are due. */
  tick(): Promise<void>;
  /** The callbacks to hand `startWake`. */
  readonly wake: Pick<WakeOptions, "onCommand" | "onViewer" | "onSweep" | "onStatus">;
  /** Register the command relay; its callbacks receive every wake-up and sweep. */
  relay(hooks: RelayHooks): void;
  /** Make a project hot: as a viewer (with a full push at once) or for attention. */
  markHot(project: string, why: "viewer" | "attention"): void;
  state(): BridgeState;
  /** Give up the lease, if held. */
  release(): Promise<void>;
}

/** What the store's hash column holds for a key it keeps as `too-large`. */
const TOO_LARGE = "\u0000too-large";

/** A store row's identity. Global keys are filed under the reserved placeholder project, here and only here. */
const rowProject = (project: string | null): string => project ?? GLOBAL_SNAPSHOT_PROJECT;
const rowKey = (project: string | null, key: string): string => `${rowProject(project)}\u0000${key}`;

/** The keys a stream event may name: the per-project routes; anything else is ignored. */
const STREAM_KEYS: ReadonlySet<string> = new Set(SNAPSHOT_ROUTES.filter((route) => route.scope === "project").map((route) => route.key));

const isSnapshot = (entry: Collected): entry is Snapshot => "body" in entry;

const json = (snapshot: Snapshot): unknown => JSON.parse(gunzipSync(snapshot.body).toString("utf8"));

/** The loops a `dashboard` body names. */
const loopsOf = (value: unknown): string[] => {
  const loops = (value as { loops?: unknown } | null)?.loops;
  if (!Array.isArray(loops)) return [];
  return loops.flatMap((entry) => {
    const loop = (entry as { loop?: unknown } | null)?.loop;
    return typeof loop === "string" && loop !== "" ? [loop] : [];
  });
};

/** The project ids a `_/projects` body names. */
const projectsOf = (value: unknown): string[] => {
  const projects = (value as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.flatMap((entry) => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" && id !== "" ? [id] : [];
  });
};

/** The needs that wake a project: `approval` and `errored`, never `blocked`. */
const attentionOf = (value: unknown): Map<string, string> => {
  const needs = new Map<string, string>();
  for (const project of (value as Partial<ProjectsHealthView> | null)?.projects ?? []) {
    for (const need of project.needs ?? []) {
      if (need.reason === "approval" || need.reason === "errored") {
        needs.set(`${project.project}\u0000${need.loop}\u0000${need.reason}`, project.project);
      }
    }
  }
  return needs;
};

export function createBridge(options: BridgeOptions): Bridge {
  const { store } = options;
  const timings = options.timings ?? DEFAULT_TIMINGS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.error(`ralph-bridge: ${line}`));
  const instance = options.instance ?? randomUUID();
  const local: CollectOptions = { ...options.local, now };

  let connected = false;
  let leased = false;
  let attempt = 0;
  let backoffUntil = 0;
  let nextBeat = 0;
  let nextProbe = 0;
  let localStatus: LocalStatus = "ok";
  let wakeStatus: WakeStatus = "poll-only";
  let wakeProblem: string | null = null;
  let relay: RelayHooks | null = null;
  let busy = false;
  /** Every project wants a full push: on start, on reconnect, on regaining the lease or the dashboard. */
  let fullAll = true;
  const fullProjects = new Set<string>();

  /** Row key → the hash the store holds. */
  const stored = new Map<string, string>();
  /** Row key → when it was last read, and how long that took. */
  const reads = new Map<string, { at: number; readMs: number }>();
  let projects: string[] = [];
  const loops = new Map<string, string[]>();
  const viewerUntil = new Map<string, number>();
  const attentionUntil = new Map<string, number>();
  /** The attention needs on the previous `_/health` read; null before the first. */
  let needs: Map<string, string> | null = null;
  /** Row keys a hot project's change stream named since they were last read. */
  const dirty = new Set<string>();

  const hotUntil = (project: string, at = now()): number | null => {
    const until = Math.max(viewerUntil.get(project) ?? 0, attentionUntil.get(project) ?? 0);
    return until > at ? until : null;
  };
  const anyHot = (at: number): boolean => projects.some((project) => hotUntil(project, at) !== null);

  const openStream =
    options.stream ??
    ((project: string, handlers: LocalStreamHandlers): LocalStream =>
      openLocalStream({ base: options.local.base, project, fetch: options.local.fetch, ...handlers }));
  const streams = createLocalStreams({
    open: openStream,
    // Only a hot project's change matters sooner than its timers; an idle
    // one's cadence stays exactly the table's.
    onChange: (project, key) => {
      if (!STREAM_KEYS.has(key) || hotUntil(project) === null) return;
      dirty.add(rowKey(project, key));
    },
    backoff: (attempt) => backoffDelay(attempt, random),
    ...options.streamTimers,
    log,
  });
  /** Hold a stream open for exactly the hot projects, and only while the bridge is reading at all. */
  const reconcileStreams = (): void => {
    const at = now();
    const reading = connected && leased && localStatus === "ok";
    const wanted = reading ? projects.filter((project) => hotUntil(project, at) !== null) : [];
    streams.want(wanted);
    // A mark left by a project that cooled would make its next hot spell read at once for nothing.
    for (const row of Array.from(dirty)) if (!wanted.includes(row.split("\u0000")[0]!)) dirty.delete(row);
  };

  const controls = (): "enabled" | "disabled" => (options.controls !== "off" && relay !== null ? "enabled" : "disabled");

  const setLocal = (status: LocalStatus, why?: string): void => {
    if (status === localStatus) return;
    if (status !== "ok") log(`local ${status}${why ? `: ${why}` : ""}`);
    else log(`local ok again (was ${localStatus}); pushing everything`);
    // Back from either failure: what the store holds may be minutes old.
    if (status === "ok") fullAll = true;
    localStatus = status;
  };

  const sawViewer = (project: string, until: number): void => {
    const was = viewerUntil.get(project) ?? 0;
    if (until <= was) return;
    viewerUntil.set(project, until);
    // Turning hot by a viewer pushes the whole project at once.
    if (was <= now()) fullProjects.add(project);
  };

  /** A store that was not reached: drop everything until the backoff runs out. */
  const unreachable = (error: unknown): void => {
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    if (connected) log(`store unreachable, backing off: ${error instanceof Error ? error.message : String(error)}`);
    connected = false;
    leased = false;
    backoffUntil = now() + delay;
  };

  const heartbeat = async (): Promise<boolean> => {
    const at = now();
    const hot = Object.fromEntries(
      projects.flatMap((project) => {
        const until = hotUntil(project, at);
        return until === null ? [] : [[project, new Date(until).toISOString()]];
      }),
    );
    let rows: unknown[];
    try {
      rows = await store.query(SQL.heartbeat, [
        instance,
        SNAPSHOT_SCHEMA,
        localStatus,
        wakeStatus,
        controls(),
        JSON.stringify(hot),
        wakeProblem,
        timings.leaseMs,
      ]);
    } catch (error) {
      if (!isRejected(error)) {
        unreachable(error);
        return false;
      }
      // Reached and refused (read-only over quota, say): no lease, and no
      // retry before the next beat is due.
      log(`heartbeat rejected: ${error instanceof Error ? error.message : String(error)}`);
      leased = false;
      backoffUntil = nextBeat = at + timings.heartbeatMs;
      return false;
    }
    if (!connected) {
      connected = true;
      attempt = 0;
      fullAll = true;
      try {
        await loadStored();
      } catch (error) {
        unreachable(error);
        return false;
      }
    }
    const holds = rows.length > 0;
    if (holds && !leased) {
      log(`holding the lease as ${instance}`);
      fullAll = true;
    } else if (!holds && leased) {
      log("lost the lease to another bridge; pushing nothing");
    }
    leased = holds;
    nextBeat = at + timings.heartbeatMs;
    try {
      const viewers = await store.query<{ project: string; age_ms: number }>(SQL.viewers, []);
      for (const viewer of viewers) {
        const left = timings.viewerMs - Math.max(0, Number(viewer.age_ms));
        if (left > 0) sawViewer(viewer.project, at + left);
      }
    } catch (error) {
      if (!isRejected(error)) {
        unreachable(error);
        return false;
      }
      log(`viewer read rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  };

  const loadStored = async (): Promise<void> => {
    const rows = await store.query<{ project: string; key: string; hash: string | null; problem: string | null }>(SQL.hashes, []);
    stored.clear();
    for (const row of rows) {
      const hash = row.problem === "too-large" ? TOO_LARGE : row.hash;
      if (hash !== null) stored.set(`${row.project}\u0000${row.key}`, hash);
    }
  };

  /** Write what moved. False when the store went away under the push. */
  const push = async (collected: readonly Collected[]): Promise<boolean> => {
    const bodies = collected.filter(isSnapshot).filter((entry) => entry.changed(stored.get(rowKey(entry.project, entry.key))));
    const tooLarge = collected.filter(
      (entry) => !isSnapshot(entry) && entry.problem === "too-large" && stored.get(rowKey(entry.project, entry.key)) !== TOO_LARGE,
    );
    const write = async (entry: Collected): Promise<void> => {
      const body = isSnapshot(entry) ? Buffer.from(entry.body) : null;
      const hash = isSnapshot(entry) ? entry.hash : null;
      const problem = isSnapshot(entry) ? null : "too-large";
      const rows = await store.query(SQL.push, [instance, rowProject(entry.project), entry.key, body, hash, problem]);
      if (rows.length === 0) {
        if (leased) log("the lease ran out under a push; pushing nothing until it is back");
        leased = false;
        return;
      }
      stored.set(rowKey(entry.project, entry.key), hash ?? TOO_LARGE);
    };
    // One batch at a time, at most `PUSH_MAX_BYTES` in flight; a key per statement,
    // so the database refusing one key costs only that key.
    for (const batch of [...pushBatches(bodies), tooLarge]) {
      const results = await Promise.allSettled(batch.map(write));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") continue;
        if (!isRejected(result.reason)) {
          unreachable(result.reason);
          return false;
        }
        const entry = batch[index]!;
        log(`store rejected ${rowProject(entry.project)} ${entry.key}, skipped: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
      if (!leased) return true;
    }
    return true;
  };

  /** Fold one collection into the bridge's picture, then push what moved. */
  const settle = async (result: CollectResult, targets: readonly string[]): Promise<boolean> => {
    const at = now();
    if (!result.ok) {
      for (const key of targets) reads.set(key, { at, readMs: reads.get(key)?.readMs ?? 0 });
      setLocal("redactor-degraded", result.detail);
      nextProbe = at + timings.localRetryMs;
      return false;
    }
    for (const entry of result.snapshots) reads.set(rowKey(entry.project, entry.key), { at, readMs: entry.readMs });
    const probe = result.snapshots.find((entry) => entry.key === "_/projects");
    if (probe !== undefined && !isSnapshot(probe) && probe.problem === "unreadable" && (probe.status === null || probe.status >= 500)) {
      setLocal("dashboard-down", probe.detail);
      nextProbe = at + timings.localRetryMs;
      return false;
    }
    setLocal("ok");
    for (const entry of result.snapshots.filter(isSnapshot)) {
      if (entry.key === "_/projects") projects = projectsOf(json(entry));
      else if (entry.key === "dashboard" && entry.project !== null) loops.set(entry.project, loopsOf(json(entry)));
      else if (entry.key === "_/health") {
        const current = attentionOf(json(entry));
        if (needs !== null) {
          for (const [need, project] of current) {
            if (needs.has(need)) continue;
            log(`attention: ${need.split("\u0000").slice(1).join(" ")} in ${project}; hot for ${timings.attentionMs / MINUTE} min`);
            attentionUntil.set(project, at + timings.attentionMs);
          }
        }
        needs = current;
      }
    }
    return push(result.snapshots);
  };

  /** Read and push every key of the given projects, or of every project. */
  const pushFull = async (only?: readonly string[]): Promise<void> => {
    for (const row of Array.from(dirty)) if (!only || only.includes(row.split("\u0000")[0]!)) dirty.delete(row);
    const result = await collect({ ...local, ...(only ? { projects: only } : {}) });
    const ok = await settle(result, []);
    if (!ok || !connected || !leased) return;
    if (only) for (const project of only) fullProjects.delete(project);
    else {
      fullAll = false;
      fullProjects.clear();
    }
  };

  /** Every target whose cadence has come round. */
  const due = (at: number): SnapshotTarget[] => {
    const ready = (target: SnapshotTarget, hot: boolean): boolean => {
      const row = rowKey(target.project, target.key);
      const last = reads.get(row);
      if (last === undefined) return true;
      const { hot: fast, idle } = timings.cadence[cadenceClassOf(target.key)];
      // A key the stream named waits only on the twice-the-read-time rule.
      const cadence = hot && dirty.has(row) ? 0 : hot ? fast : idle;
      return at >= last.at + Math.max(cadence, 2 * last.readMs);
    };
    const globalsHot = anyHot(at);
    const targets: SnapshotTarget[] = [];
    for (const route of SNAPSHOT_ROUTES) {
      if (route.scope !== "global") continue;
      const target = targetFor(route, null);
      if (ready(target, globalsHot)) targets.push(target);
    }
    for (const project of projects) {
      const hot = hotUntil(project, at) !== null;
      for (const route of SNAPSHOT_ROUTES) {
        const candidates =
          route.scope === "project"
            ? [targetFor(route, project)]
            : route.scope === "loop"
              ? (loops.get(project) ?? []).map((loop) => targetFor(route, project, loop))
              : [];
        for (const target of candidates) if (ready(target, hot)) targets.push(target);
      }
    }
    return targets;
  };

  const step = async (): Promise<void> => {
    const at = now();
    // Store unreachable: no local reads at all until the backoff runs out.
    if (at < backoffUntil) return;
    if (!connected || at >= nextBeat) {
      if (!(await heartbeat())) return;
    }
    if (!leased) return;
    // A local failure is retried every `localRetryMs`, never on every tick.
    if (localStatus !== "ok" && now() < nextProbe) return;
    if (localStatus === "dashboard-down") {
      // The probe is the project list; back up, everything is pushed afresh.
      // The table's list puts it first, which collect.test.ts pins.
      const probe = targetFor(SNAPSHOT_ROUTES[0]!, null);
      await settle(await collectTargets([probe], local), [rowKey(null, probe.key)]);
      return;
    }
    if (fullAll) {
      await pushFull();
      return;
    }
    for (const project of Array.from(fullProjects)) {
      await pushFull([project]);
      if (!connected || !leased) return;
    }
    const targets = due(now());
    if (targets.length === 0) return;
    const rows = targets.map((target) => rowKey(target.project, target.key));
    // A mark is spent when its read STARTS: an event that lands while the read
    // is on the wire names a change that read may have missed, so it stays.
    for (const row of rows) dirty.delete(row);
    await settle(await collectTargets(targets, local), rows);
  };

  const fire = (callback: (() => void | Promise<void>) | undefined): void => {
    if (!callback) return;
    void Promise.resolve()
      .then(callback)
      .catch((error: unknown) => log(`relay: ${error instanceof Error ? error.message : String(error)}`));
  };

  return {
    instance,
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await step();
      } catch (error) {
        log(`tick failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      } finally {
        busy = false;
        // After every tick, early returns included: a project that cooled, a
        // lost lease or a down dashboard closes its stream.
        try {
          reconcileStreams();
        } catch (error) {
          log(`local streams: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    wake: {
      onCommand: (wake) => fire(relay?.onCommand && (() => relay!.onCommand!(wake))),
      onViewer: ({ project }) => sawViewer(project, now() + timings.viewerMs),
      onSweep: () => fire(relay?.onSweep),
      onStatus: (status, problem) => {
        wakeStatus = status;
        wakeProblem = problem ?? null;
      },
    },
    relay(hooks) {
      relay = hooks;
    },
    markHot(project, why) {
      if (why === "viewer") sawViewer(project, now() + timings.viewerMs);
      else attentionUntil.set(project, Math.max(attentionUntil.get(project) ?? 0, now() + timings.attentionMs));
    },
    state() {
      const at = now();
      return {
        instance,
        connected,
        leased,
        local: localStatus,
        wake: wakeStatus,
        hot: Object.fromEntries(
          projects.flatMap((project) => {
            const until = hotUntil(project, at);
            return until === null ? [] : [[project, until]];
          }),
        ),
      };
    },
    async release() {
      streams.close();
      if (!leased) return;
      leased = false;
      await store.query(SQL.release, [instance]).catch(() => {});
    },
  };
}

/* ------------------------------------------------------------- the process */

/** The fd behind the machine lock, held open for the life of the process. */
let lockFd: number | null = null;

/** Where the machine lock lives. */
export function lockPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "ralph-bridge.lock");
}

/**
 * `flock -n` on `path`, through libc rather than a spawned `flock`, so the
 * bridge spawns nothing but the redactor. True when this process now holds
 * it; the kernel drops it when the process exits, however it exits.
 */
export async function takeLock(path: string): Promise<boolean> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
    lockFd = fd;
    return true;
  }
  closeSync(fd);
  return false;
}

/** postgres.js over the session pooler: one persistent connection, TLS unless the URL says otherwise. */
export function postgresStore(url: string): BridgeStore & { close(): Promise<void> } {
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
    ssl: /[?&]sslmode=/.test(url) ? undefined : "require",
    onnotice: () => {},
  });
  return {
    query: async <T>(text: string, params: unknown[]) =>
      (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[],
    close: () => sql.end({ timeout: 5 }),
  };
}

const REQUIRED = [
  "RALPH_BRIDGE_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "RALPH_BRIDGE_AUTH_EMAIL",
  "RALPH_BRIDGE_AUTH_PASSWORD",
] as const;

/** Run the bridge until SIGTERM or SIGINT; resolves to the exit code. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  if (!(await takeLock(lockPath(env)))) {
    console.log("ralph-bridge: already running");
    return 0;
  }
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`ralph-bridge: missing ${missing.join(", ")} (run under \`doppler run --project software-factory --config bridge\`)`);
    return 1;
  }
  const store = postgresStore(env.RALPH_BRIDGE_DATABASE_URL!);
  const base = env.RALPH_BRIDGE_LOCAL_URL || "http://127.0.0.1:8791";
  const controls = env.RALPH_BRIDGE_CONTROLS === "off" ? "off" : "on";
  const bridge = createBridge({
    store,
    local: { base, redact: processRedactor() },
    timings: timingsFromEnv(env),
    controls,
  });
  // Registered before the first heartbeat, which then reports `controls: enabled`
  // (or `disabled` under the kill switch, where the relay refuses every row).
  bridge.relay(
    createRelay({
      store,
      instance: bridge.instance,
      base,
      controls,
      localUp: () => bridge.state().local !== "dashboard-down",
      markHot: (project) => bridge.markHot(project, "viewer"),
    }),
  );
  const wake = startWake({
    url: env.SUPABASE_URL!,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY!,
    email: env.RALPH_BRIDGE_AUTH_EMAIL!,
    password: env.RALPH_BRIDGE_AUTH_PASSWORD!,
    ...bridge.wake,
    // `RALPH_BRIDGE_SWEEP_MS`: the 30 s sweep, shortened by the end-to-end test.
    ...(Number(env.RALPH_BRIDGE_SWEEP_MS) > 0 ? { sweepEveryMs: Number(env.RALPH_BRIDGE_SWEEP_MS) } : {}),
  });
  console.error(`ralph-bridge: started as ${bridge.instance}`);
  const timer = setInterval(() => void bridge.tick(), SECOND);
  void bridge.tick();
  return new Promise<number>((resolve) => {
    const stop = async (): Promise<void> => {
      clearInterval(timer);
      await wake.stop();
      await bridge.release();
      await store.close().catch(() => {});
      if (lockFd !== null) closeSync(lockFd);
      resolve(0);
    };
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
  });
}

if (import.meta.main) process.exit(await main());
