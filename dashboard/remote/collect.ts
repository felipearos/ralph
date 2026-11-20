/**
 * The snapshot collector: the pure half of the bridge (spec #165 §4).
 *
 * It reads a closed allowlist of the local dashboard's GET routes over
 * loopback, scrubs every body (`scrub.ts`), and turns each into a gzip
 * snapshot ready to store. It reaches no store and runs no loop; the bridge
 * decides when to collect and writes only what `changed` says moved.
 * One of those routes writes on the local host: `/api/evals/proposals`
 * (#874) recommends a promising proposal's full-set run into the inbox as it
 * lists, once per proposal, so a collect can move a proposal on.
 *
 * It is a client of the RUNNING local dashboard, never a second copy of its
 * adapters, so it imports nothing from the dashboard but the route table's
 * dependency-free lists: the response bodies are already the view models in
 * `contracts.ts`, and the routes run every check they run for a local tab.
 *
 * A snapshot's hash is taken over the scrubbed compact JSON with the
 * top-level `generatedAt` and `readAt` dropped (and, for `controls`, each
 * loop's), so a read that says only "this was read again" is not a change. The
 * body keeps them: the page shows how old the picture is.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { SNAPSHOT_ROUTES, type SnapshotRoute } from "../route-table";
import { scrubAll, type ScrubOptions } from "./scrub";

/**
 * Every local route the bridge reads, and the snapshot key it is stored
 * under, read off the route table's collecting rows (#629) so the bridge's
 * allowlist and what the hosted function serves cannot drift. GET only, and
 * closed: a route that is not a collecting row never leaves the machine.
 * Paths are the unscoped forms; a `project` route is read under
 * `/api/p/<project>`. `<loop>` is each loop the project's `dashboard` body
 * names. `controls` is every loop's control view in one read, so the remote
 * overview costs one read too (#615); `control/<loop>` stays for older pages
 * and for a page that fell back to the per-loop route. Re-exported under the
 * same names so the bridge and its tests keep reading them from here.
 */
export { SNAPSHOT_ROUTES, type SnapshotRoute };

/** One key is at most this after gzip; a bigger body is not stored. */
export const KEY_MAX_BYTES = 1024 * 1024;
/** One push is at most this, summed over its bodies. */
export const PUSH_MAX_BYTES = 2 * 1024 * 1024;

/** The top-level fields that say only when a body was read. */
const VOLATILE = ["generatedAt", "readAt"] as const;

/** One allowlisted route, resolved for a project and loop. */
export interface SnapshotTarget {
  /** Null for the `_/` keys, which span every project. */
  project: string | null;
  key: string;
  /** The local path, scoped, with its query. */
  path: string;
}

/** A key read, scrubbed and compressed. */
export interface Snapshot {
  project: string | null;
  key: string;
  /** `gzip(compact JSON)`, the bytes the store keeps and the app serves. */
  body: Uint8Array;
  /** sha256 of the compact JSON without its top-level `generatedAt`/`readAt`. */
  hash: string;
  /** `body.length`. */
  bytes: number;
  /** The local read's wall time, for the bridge's back-off. */
  readMs: number;
  /** Whether this differs from the snapshot last stored under `prevHash`. */
  changed(prevHash: string | null | undefined): boolean;
}

/**
 * A key with no body to store. `too-large` is over `KEY_MAX_BYTES` after
 * gzip; `unreadable` is a local route that did not answer 2xx JSON.
 */
export interface SnapshotProblem {
  project: string | null;
  key: string;
  problem: "too-large" | "unreadable";
  readMs: number;
  /** The local route's status, when it answered. */
  status: number | null;
  detail: string;
}

export type Collected = Snapshot | SnapshotProblem;

export type CollectResult =
  | { ok: true; snapshots: Collected[] }
  /** Fail closed: the redactor could not vouch for the bodies, so none is returned. */
  | { ok: false; error: "redactor-degraded"; detail: string };

export interface CollectOptions extends ScrubOptions {
  /** The local dashboard, e.g. `http://127.0.0.1:8791`. */
  base: string;
  /** Defaults to the global `fetch`; tests hand in the handler. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** A local read slower than this is `unreadable`. */
  timeoutMs?: number;
  /** Wall time, in ms. Injected so tests can pin `readMs`. */
  now?: () => number;
}

/** The scoped path of a project route: `/api/x` under `/api/p/<project>`. */
export const scopedPath = (project: string, path: string): string => `/api/p/${encodeURIComponent(project)}${path.slice("/api".length)}`;

/** The key and path of one route for a project and loop. */
export function targetFor(route: SnapshotRoute, project: string | null, loop: string | null = null): SnapshotTarget {
  if (route.scope === "global") return { project: null, key: route.key, path: route.path };
  if (project === null) throw new Error(`${route.key} is read per project`);
  if (route.scope === "project") return { project, key: route.key, path: scopedPath(project, route.path) };
  if (loop === null) throw new Error(`${route.key} is read per loop`);
  const path = route.path.replace("<loop>", encodeURIComponent(loop));
  return { project, key: route.key.replace("<loop>", loop), path: scopedPath(project, path) };
}

/** `value` without its top-level read times, when it is an object. */
function withoutReadTimes(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of VOLATILE) delete rest[field];
  return rest;
}

/**
 * The bytes a body is hashed over: compact JSON without the read times. The
 * batched `controls` body nests one control view per loop, each with its own
 * `generatedAt`, so those are dropped too; otherwise every read is a change.
 */
export function hashOf(key: string, value: unknown): string {
  let stable = withoutReadTimes(value);
  if (key === "controls" && typeof stable === "object" && stable !== null) {
    const loops = (stable as { loops?: unknown }).loops;
    if (typeof loops === "object" && loops !== null && !Array.isArray(loops)) {
      const views = Object.entries(loops as Record<string, unknown>).map(([loop, view]) => [loop, withoutReadTimes(view)]);
      stable = { ...stable, loops: Object.fromEntries(views) };
    }
  }
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

interface Read {
  target: SnapshotTarget;
  readMs: number;
  value?: unknown;
  status: number | null;
  detail?: string;
}

async function readOne(target: SnapshotTarget, options: CollectOptions): Promise<Read> {
  const get = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const started = now();
  const elapsed = (): number => Math.max(0, now() - started);
  try {
    const response = await get(new URL(target.path, options.base).toString(), {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const text = await response.text();
    const readMs = elapsed();
    if (!response.ok) return { target, readMs, status: response.status, detail: `the local route answered ${response.status}` };
    try {
      return { target, readMs, status: response.status, value: JSON.parse(text) };
    } catch {
      return { target, readMs, status: response.status, detail: "the local route did not answer JSON" };
    }
  } catch (error) {
    return { target, readMs: elapsed(), status: null, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Read the given targets and scrub them together, with one redactor call. */
export async function collectTargets(targets: readonly SnapshotTarget[], options: CollectOptions): Promise<CollectResult> {
  return finish(await Promise.all(targets.map((target) => readOne(target, options))), options);
}

/** Scrub, compress and hash what was read; all or nothing on the redactor. */
async function finish(reads: readonly Read[], options: CollectOptions): Promise<CollectResult> {
  const readable = reads.filter((read) => "value" in read);
  const scrubbed = await scrubAll(
    readable.map((read) => read.value),
    options,
  );
  if (!scrubbed.ok) return scrubbed;
  const clean = new Map(readable.map((read, index) => [read, scrubbed.value[index]]));

  const snapshots = reads.map((read): Collected => {
    const { project, key } = read.target;
    if (!clean.has(read)) {
      return { project, key, problem: "unreadable", readMs: read.readMs, status: read.status, detail: read.detail ?? "unreadable" };
    }
    const value = clean.get(read);
    const body = new Uint8Array(gzipSync(JSON.stringify(value)));
    if (body.length > KEY_MAX_BYTES) {
      return {
        project,
        key,
        problem: "too-large",
        readMs: read.readMs,
        status: read.status,
        detail: `${body.length} bytes after gzip, over the ${KEY_MAX_BYTES}-byte limit`,
      };
    }
    const hash = hashOf(key, value);
    return { project, key, body, hash, bytes: body.length, readMs: read.readMs, changed: (prev) => prev !== hash };
  });
  return { ok: true, snapshots };
}

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

/**
 * Every allowlisted key, for every project or the ones named. The project
 * list and each project's loops come from the `_/projects` and `dashboard`
 * reads themselves, raw, before those are scrubbed with the rest: each route
 * is read once per collection.
 */
export async function collect(options: CollectOptions & { projects?: readonly string[] }): Promise<CollectResult> {
  const route = (key: string): SnapshotRoute => SNAPSHOT_ROUTES.find((entry) => entry.key === key)!;
  const globals = await Promise.all(
    SNAPSHOT_ROUTES.filter((entry) => entry.scope === "global").map((entry) => readOne(targetFor(entry, null), options)),
  );
  const projects = options.projects ?? projectsOf(globals.find((read) => read.target.key === "_/projects")?.value);
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const dashboard = await readOne(targetFor(route("dashboard"), project), options);
      const loops = loopsOf(dashboard.value);
      const rest = SNAPSHOT_ROUTES.flatMap((entry): SnapshotTarget[] => {
        if (entry.scope === "project") return entry.key === "dashboard" ? [] : [targetFor(entry, project)];
        if (entry.scope === "loop") return loops.map((loop) => targetFor(entry, project, loop));
        return [];
      });
      return [dashboard, ...(await Promise.all(rest.map((target) => readOne(target, options))))];
    }),
  );
  return finish([...globals, ...perProject.flat()], options);
}

/** Only the snapshots whose hash moved since the store's `previous`. */
export function changedSince(
  collected: readonly Collected[],
  previous: ReadonlyMap<string, string>,
  keyOf: (snapshot: Snapshot) => string = (snapshot) => `${snapshot.project ?? "_"}\u0000${snapshot.key}`,
): Snapshot[] {
  return collected.filter((entry): entry is Snapshot => "body" in entry && entry.changed(previous.get(keyOf(entry))));
}

/** Split snapshots into pushes of at most `PUSH_MAX_BYTES` each, in order. */
export function pushBatches(snapshots: readonly Snapshot[], max = PUSH_MAX_BYTES): Snapshot[][] {
  const batches: Snapshot[][] = [];
  let current: Snapshot[] = [];
  let size = 0;
  for (const snapshot of snapshots) {
    if (current.length > 0 && size + snapshot.bytes > max) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(snapshot);
    size += snapshot.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
