/**
 * The bridge's client of the local dashboard's change stream (#730).
 *
 * The local server tells every subscriber "project P's `dashboard` snapshot
 * changed, version N" (#724) — invalidations only, never a body. This module
 * turns that into `onChange(project, key)` so the bridge can collect and push
 * a changed key at once instead of on its next tick.
 *
 * It is an accelerator, not a source of truth: the bridge's own timers stay
 * the fallback, so a stream that cannot be opened, drops, or sends junk only
 * makes the bridge slower, never stuck. Hence nothing here throws out of a
 * callback path: a failure is an `onEnd(<why>)`, a reopen after back-off, and
 * one log line per failure streak.
 *
 * Like `collect.ts` it names no route of its own: the path is the route
 * table's `stream` row, scoped by collect's helper.
 */
import { ROUTE_TABLE } from "../route-table";
import { scopedPath } from "./collect";

/** One change the stream announced. */
export interface LocalStreamEvent {
  key: string;
  version: number;
}

export interface LocalStreamHandlers {
  onOpen(): void;
  onEvent(event: LocalStreamEvent): void;
  /** The stream is gone (refused, unreadable, ended); never called after `close()`. */
  onEnd(reason: string): void;
}

export interface LocalStreamOptions extends LocalStreamHandlers {
  /** The local dashboard's origin, e.g. `http://127.0.0.1:8791`. */
  base: string;
  project: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface LocalStream {
  close(): void;
}

/**
 * The key a (re)opened stream marks changed: the one key the server's hub
 * streams today (`snapshot-stream.ts`), since a stream that was down may have
 * missed its events. The push is hash-gated, so a spurious mark costs a read.
 */
export const CATCH_UP_KEY = "dashboard";

/**
 * The reopen delay when the caller's `backoff` throws: about the wake
 * channel's mid-range backoff, so a broken backoff neither hammers the local
 * server nor leaves the stream down for the full five-minute cap.
 */
const BACKOFF_FALLBACK_MS = 30_000;

/** The unscoped path of the route table's stream row, or null if it has none. */
const STREAM_PATH: string | null = ROUTE_TABLE.find((entry) => entry.kind === "stream")?.path ?? null;

/** A `data:` payload the bridge can act on; anything else is ignored. */
function asEvent(payload: string): LocalStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { key, version } = parsed as { key?: unknown; version?: unknown };
  if (typeof key !== "string" || typeof version !== "number") return null;
  return { key, version };
}

/** The joined `data:` lines of one SSE block; comments and other fields drop out. */
function dataOf(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length === 0 ? null : data.join("\n");
}

/** Calls a caller's callback; a throw there is the caller's bug, not a reason to stop reading. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // The caller logs its own failures; the stream keeps going.
  }
}

/**
 * Opens one project's change stream. `onOpen` once the server answers a 2xx
 * `text/event-stream`, then `onEvent` per valid change, then `onEnd` exactly
 * once — unless `close()` came first, which ends it silently.
 */
export function openLocalStream(options: LocalStreamOptions): LocalStream {
  const controller = new AbortController();
  let closed = false;
  let ended = false;
  const end = (reason: string): void => {
    if (closed || ended) return;
    ended = true;
    safely(() => options.onEnd(reason));
  };

  const run = async (): Promise<void> => {
    if (STREAM_PATH === null) return end("the route table has no stream row");
    const url = `${options.base.replace(/\/+$/, "")}${scopedPath(options.project, STREAM_PATH)}`;
    const fetchImpl = options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", signal: controller.signal, headers: { accept: "text/event-stream" } });
    } catch (error) {
      return end(`unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (closed) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return end(`HTTP ${response.status}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("text/event-stream") || response.body === null) {
      void response.body?.cancel().catch(() => {});
      return end(`not an event stream (${type || "no content-type"})`);
    }
    safely(() => options.onOpen());

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) break;
        // CRLF folds to LF on the whole buffer, so a `\r` and its `\n` split
        // across chunks still pair up once the second chunk lands.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = dataOf(block);
          const event = data === null ? null : asEvent(data);
          if (event !== null && !closed) safely(() => options.onEvent(event));
        }
      }
    } catch (error) {
      return end(`read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    end("stream ended");
  };
  void run().catch((error: unknown) => end(`stream failed: ${String(error)}`));

  return {
    close(): void {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}

export type StreamStatus = "live" | "connecting" | "down" | "off";

export interface LocalStreamsOptions {
  /** Opens one project's stream: `openLocalStream` in the bridge, a fake in tests. */
  open: (project: string, handlers: LocalStreamHandlers) => LocalStream;
  /** A key of `project` may have changed: collect and push it. */
  onChange(project: string, key: string): void;
  /** The delay before reopen `attempt` (0-based), in ms. */
  backoff(attempt: number): number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface LocalStreams {
  /** Holds a stream open for exactly these projects. */
  want(projects: readonly string[]): void;
  close(): void;
  status(project: string): StreamStatus;
}

interface Entry {
  /** The live connection's token; callbacks carrying another are stale. */
  token: number;
  handle: LocalStream | null;
  timer: unknown;
  attempt: number;
  /** Whether this streak's failure is already logged. */
  failing: boolean;
  status: Exclude<StreamStatus, "off">;
}

/** The bridge's per-project set of streams, reopened with back-off while wanted. */
export function createLocalStreams(options: LocalStreamsOptions): LocalStreams {
  const log = options.log ?? (() => {});
  const setTimer = options.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const { open } = options;
  const entries = new Map<string, Entry>();
  let seq = 0;

  const changed = (project: string, key: string): void => {
    try {
      options.onChange(project, key);
    } catch (error) {
      log(`local stream ${project}: onChange failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const current = (project: string, entry: Entry, token: number): boolean => entries.get(project) === entry && entry.token === token;

  const connect = (project: string, entry: Entry): void => {
    const token = ++seq;
    entry.token = token;
    entry.status = "connecting";
    entry.handle = null;
    let ended = false;

    const fail = (reason: string): void => {
      if (ended || !current(project, entry, token)) return;
      ended = true;
      entry.handle = null;
      entry.status = "down";
      // One line per streak: an unattended night of a dead server is one line, not one per retry.
      if (!entry.failing) {
        entry.failing = true;
        log(`local stream ${project}: ${reason}; reopening with back-off, the bridge's timers cover meanwhile`);
      }
      let delay: number;
      try {
        delay = options.backoff(entry.attempt++);
      } catch {
        delay = BACKOFF_FALLBACK_MS;
      }
      entry.timer = setTimer(() => {
        if (entries.get(project) !== entry || entry.token !== token) return;
        entry.timer = null;
        connect(project, entry);
      }, delay);
    };

    let handle: LocalStream;
    try {
      handle = open(project, {
        onOpen: () => {
          if (ended || !current(project, entry, token)) return;
          entry.attempt = 0;
          entry.failing = false;
          entry.status = "live";
          // Changes may have been missed while it was down; the push is
          // hash-gated, so a spurious one costs a read, not a write.
          changed(project, CATCH_UP_KEY);
        },
        onEvent: (event) => {
          if (ended || !current(project, entry, token)) return;
          changed(project, event.key);
        },
        onEnd: fail,
      });
    } catch (error) {
      fail(`open failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (ended || !current(project, entry, token)) {
      // Ended or replaced before `open` returned: this handle is no one's.
      safely(() => handle.close());
      return;
    }
    entry.handle = handle;
  };

  const drop = (project: string, entry: Entry): void => {
    entries.delete(project);
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    const handle = entry.handle;
    entry.handle = null;
    if (handle !== null) safely(() => handle.close());
  };

  return {
    want(projects: readonly string[]): void {
      const wanted = new Set(projects);
      for (const [project, entry] of entries) if (!wanted.has(project)) drop(project, entry);
      for (const project of wanted) {
        if (entries.has(project)) continue;
        const entry: Entry = { token: 0, handle: null, timer: null, attempt: 0, failing: false, status: "connecting" };
        entries.set(project, entry);
        connect(project, entry);
      }
    },
    close(): void {
      for (const [project, entry] of entries) drop(project, entry);
    },
    status(project: string): StreamStatus {
      return entries.get(project)?.status ?? "off";
    },
  };
}
