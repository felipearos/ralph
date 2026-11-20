/**
 * The page's end of the server's change stream (#724), React-free like
 * `loop-control.ts`.
 *
 * The stream carries invalidations only — `{ key, version }` per change,
 * never a body — so an event refreshes the store's read for that key and the
 * page re-reads through its normal route. While the stream is healthy the
 * read's poll slows to a fallback; on any trouble the read's own poll
 * interval comes back, so a dropped stream costs freshness, never correctness.
 */
import type { ReadStore } from "./query-reads";

export type LiveStatus = "connecting" | "live" | "fallback";

/** The slice of `EventSource` the binding uses, so tests hand it a fake. */
export interface LiveSource {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: "unavailable", listener: (event: unknown) => void): void;
  close(): void;
  readonly readyState: number;
}

/** All the stream asks of a store: its "refresh this read" seam. */
export type LiveStore = Pick<ReadStore, "refresh" | "livePoll">;

export interface LiveStreamOptions {
  store: LiveStore;
  url: string;
  /**
   * The store URL(s) each event key refreshes: `{ dashboard: dashboardRead(project).url }`.
   * A key may name several (`notifications` feeds the project's list and each loop's).
   */
  reads: LiveReads;
  openSource?: (url: string) => LiveSource;
  /** The poll interval while the stream is healthy: a fallback only. */
  slowMs: number;
  /**
   * Refresh the mapped reads on the first open too, not only on a re-open:
   * a binding made again after a gap (the tab was hidden) may have missed changes.
   */
  refreshOnFirstOpen?: boolean;
  /** The re-open backoff's timer; real by default, injected by tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The first wait before re-opening a stream the browser gave up on, doubled per failure. */
export const REOPEN_FIRST_MS = 5_000;
export const REOPEN_MAX_MS = 60_000;

/** Event key → the store URL, or URLs, it refreshes. */
export type LiveReads = Readonly<Record<string, string | readonly string[]>>;

export interface LiveStream {
  status(): LiveStatus;
  subscribe(listener: () => void): () => void;
  /**
   * Replace the key map without reopening the stream, so per-loop keys follow
   * the roster: a URL that leaves gets its own poll back, one that arrives is
   * slowed if the stream is live.
   */
  setReads(next: LiveReads): void;
  close(): void;
}

/** `EventSource.CLOSED`, spelled out so the binding loads where there is no EventSource. */
const CLOSED = 2;

const browserSource = (url: string): LiveSource => new EventSource(url) as unknown as LiveSource;

/** The map with every value a list, own keys only (so `toString` maps nothing). */
function normalise(reads: LiveReads): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const [key, value] of Object.entries(reads)) map.set(key, typeof value === "string" ? [value] : value);
  return map;
}

/** Every URL the map names, once each. */
function urlsOf(map: Map<string, readonly string[]>): Set<string> {
  const urls = new Set<string>();
  for (const list of map.values()) for (const url of list) urls.add(url);
  return urls;
}

/** The key a `data:` line names, or null for anything else: a bad line is ignored, never thrown. */
function keyOf(data: unknown): string | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { key, version } = parsed as { key?: unknown; version?: unknown };
    return typeof key === "string" && typeof version === "number" ? key : null;
  } catch {
    return null;
  }
}

export function bindLiveStream({
  store,
  url,
  reads,
  openSource = browserSource,
  slowMs,
  refreshOnFirstOpen = false,
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}: LiveStreamOptions): LiveStream {
  const listeners = new Set<() => void>();
  let keyed = normalise(reads);
  // The current URL set: close, fall-back and open all act on this, never on the first map.
  let targets = urlsOf(keyed);
  let current: LiveStatus = "connecting";
  let closed = false;
  // Whether the stream has been open before: a re-open may have missed events.
  let opened = refreshOnFirstOpen;
  let source: LiveSource | null = null;
  let reopenTimer: unknown = null;
  let backoffMs = REOPEN_FIRST_MS;

  const set = (next: LiveStatus): void => {
    if (current === next) return;
    current = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One broken listener does not stop the others hearing.
      }
    }
  };

  const fallBack = (): void => {
    for (const target of targets) store.livePoll(target, null);
    set("fallback");
  };

  // An EventSource that got a non-stream answer (a 503, say) is CLOSED for
  // good: the browser never retries it. Re-open it ourselves, backing off, so
  // one bad answer does not leave the tab polling for its life.
  const scheduleReopen = (): void => {
    if (closed || reopenTimer !== null) return;
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, REOPEN_MAX_MS);
    reopenTimer = setTimer(() => {
      reopenTimer = null;
      connect();
    }, wait);
  };

  function connect(): void {
    if (closed) return;
    let opening: LiveSource;
    try {
      opening = openSource(url);
    } catch {
      // No stream at all: the page polls as it always did.
      source = null;
      fallBack();
      return;
    }
    source = opening;
    // Every handler checks it is still the current source: a replaced one's late events are not this binding's.
    const stale = (): boolean => closed || source !== opening;
    opening.onopen = () => {
      if (stale()) return;
      backoffMs = REOPEN_FIRST_MS;
      for (const target of targets) store.livePoll(target, slowMs);
      // Down for a while, the stream may have dropped changes: read once now.
      if (opened) for (const target of targets) store.refresh(target);
      opened = true;
      set("live");
    };
    opening.onmessage = (event) => {
      if (stale()) return;
      const key = keyOf(event.data);
      if (key === null) return;
      for (const target of keyed.get(key) ?? []) store.refresh(target);
    };
    // A plain error is left to EventSource's own reconnect, which honours the
    // server's retry hint; until it reopens, the read's own poll carries the page.
    opening.onerror = () => {
      if (stale()) return;
      fallBack();
      if (opening.readyState === CLOSED) scheduleReopen();
    };
    // The remote dashboard does not relay the stream: reopening is pointless.
    opening.addEventListener("unavailable", () => {
      if (stale()) return;
      opening.close();
      source = null;
      fallBack();
    });
  }

  connect();

  return {
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setReads(next) {
      if (closed) return;
      const nextKeyed = normalise(next);
      const nextTargets = urlsOf(nextKeyed);
      for (const target of targets) if (!nextTargets.has(target)) store.livePoll(target, null);
      if (current === "live") for (const target of nextTargets) if (!targets.has(target)) store.livePoll(target, slowMs);
      keyed = nextKeyed;
      targets = nextTargets;
    },
    close() {
      if (closed) return;
      closed = true;
      if (reopenTimer !== null) clearTimer(reopenTimer);
      reopenTimer = null;
      source?.close();
      source = null;
      for (const target of targets) store.livePoll(target, null);
      listeners.clear();
    },
  };
}
