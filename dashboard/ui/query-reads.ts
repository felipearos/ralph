/**
 * The page's JSON reads, shared and polled outside React, with TanStack Query
 * as the cache (#603, spec #722, #727).
 *
 * `usePolled` gave every component its own timer and its own fetch, so two
 * panels reading one URL doubled the adapter's subprocesses. This layer keeps
 * one entry per URL however many components read it, in one `QueryClient` per
 * page. A read reschedules only after it settles (a slow adapter read must not
 * stack a second one on top), an error keeps the last data, and a refresh
 * keeps the data on screen instead of flashing to a skeleton. A URL nobody
 * reads stays cached for KEEP_ALIVE_MS, so going back to a page shows its data
 * at once, and `prefetch` reads one ahead of its reader (a hover before a click).
 *
 * A hidden page does not poll (#725): a forgotten background tab must not
 * spawn adapter subprocesses all night. While hidden no poll timer is armed;
 * the first read, an explicit refresh and a queued read still go. When the
 * page shows again every polling read re-reads at once, keeping its data on
 * screen, so what it shows is never stale.
 *
 * Query is only the cache and the request dedupe. Nothing in it polls or
 * fetches on its own: every read is started here, under the rules above (one
 * read in flight per URL, the next poll armed after a settle), so the adapter
 * sees exactly one read per URL per poll however many panels read it.
 *
 * Framework-free and clock-injected: a binding hands it to
 * `useSyncExternalStore`, and the tests drive it with a fake fetch and clock.
 */
import { QueryClient, QueryObserver, type Query, type QueryCacheNotifyEvent } from "@tanstack/query-core";

import { snapshotAtOf, STALE_AFTER_MS } from "./remote-model";

/** How long a URL nobody reads keeps its data: as long as the page would still call it fresh. */
export const KEEP_ALIVE_MS = STALE_AFTER_MS;

export type Read<T> =
  | { state: "loading" }
  | { state: "ready"; data: T; at: Date; snapshotAt: Date | null }
  // `answered`: the read had a successful answer before this failure. A
  // successful answer may itself be null (a project with no frontier), so
  // `data: null` alone cannot tell a first-read failure from a failed poll.
  | { state: "error"; message: string; status: number | null; data: T | null; answered?: boolean };

export interface ReadClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Whether the page is hidden, and when that changes; the browser's is `document.visibilityState`. */
export interface ReadVisibility {
  hidden(): boolean;
  /** Called on every change; returns unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface ReadStoreDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  clock: ReadClock;
  /** Absent = always visible. While hidden nothing polls; shown again, every polling read catches up at once. */
  visibility?: ReadVisibility;
}

export interface ReadStore {
  /** Current snapshot for a URL; `{state:"loading"}` for one never read. Same object identity until it changes (useSyncExternalStore needs that). */
  get<T>(url: string): Read<T>;
  /**
   * Subscribe; `intervalMs` null = one-shot (fetch once on first subscribe, again only on refresh). Returns unsubscribe.
   * The first subscribe reads even while the page is hidden; the polls after it wait until the page is visible.
   */
  subscribe(url: string, intervalMs: number | null, listener: () => void): () => void;
  /**
   * Re-read now; if a read is in flight, queue exactly one more after it. Keeps current data (no flash to loading). No-op for a URL with no subscribers.
   *
   * `refresh` and `livePoll` together are the seam the server's change stream
   * drives (#724, `live-stream.ts`): an event refreshes the read it names, and
   * a healthy stream slows that read's poll to a fallback.
   */
  refresh(url: string): void;
  /**
   * While `intervalMs` is non-null, the URL polls at that interval whatever
   * its subscribers ask: the change stream is healthy, so the poll is only a
   * fallback. Null restores the shortest subscriber interval. A pending timer
   * is re-armed from now; restoring reads at once only when the normal
   * interval has already passed since the last settled read. Kept across a
   * time with no subscribers; a URL whose subscribers are all one-shot stays
   * one-shot. See `refresh` for the seam both belong to.
   */
  livePoll(url: string, intervalMs: number | null): void;
  /** Whether a read for the URL is on the wire now; false for a URL nobody reads. Listeners hear when it turns true and when it settles. */
  inFlight(url: string): boolean;
}

/** One shared constant so every unread URL, and the binding's null target, returns the same object. */
export const LOADING: Read<never> = { state: "loading" };

/**
 * The server's own words when its body says them, so the page shows why rather than a bare code.
 * Exported so every caller that decodes a failed GET does it the same way: one decoder for every read.
 */
export async function readFailureMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const { message, error } = body as { message?: unknown; error?: unknown };
      if (typeof message === "string") return message;
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON: fall back to the status.
  }
  return `HTTP ${response.status}`;
}

export interface QueryReads extends ReadStore {
  /** Fetch the URL ahead of a reader: no read when its data is fresher than KEEP_ALIVE_MS or a read is in flight. */
  prefetch(url: string): void;
  /** The page's one QueryClient (spec #722: one client per page). */
  readonly client: QueryClient;
}

/** What the cache holds for a URL: the body, its pushed-at stamp, and when it landed by the layer's clock. */
interface Snapshot {
  data: unknown;
  snapshotAt: Date | null;
  at: number;
}

/** A failed read, as the query function throws it: the state carries it to the `error` snapshot. */
class ReadError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

interface Subscriber {
  intervalMs: number | null;
  listener: () => void;
}

interface Entry {
  read: Read<unknown>;
  subscribers: Set<Subscriber>;
  /** The pending poll timer's handle; meaningful only while `hasTimer` (a handle may be any value, even 0). */
  timer: unknown;
  hasTimer: boolean;
  /** A read is on the wire (or announced and about to be), whoever started it. */
  inFlight: boolean;
  /** A refresh arrived while a read was in flight: read once more after it. */
  queued: boolean;
  /** `livePoll`'s override of the poll interval; null = the subscribers' own. */
  liveIntervalMs: number | null;
  /** When the last read settled, by the layer's clock; null before the first. */
  settledAt: number | null;
  /** Drops the observer that holds the query in the cache while anyone reads it; null with no subscriber. */
  release: (() => void) | null;
}

// The error type is the plain Error Query defaults to; `instanceof ReadError` recovers the status.
type ReadQuery = Query<Snapshot, Error, Snapshot, [string]>;

export function createQueryReads(deps: ReadStoreDeps): QueryReads {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: KEEP_ALIVE_MS,
        // The layer drives every read; Query must never start one on its own.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
        staleTime: 0,
        // "online" pauses a read while the browser thinks it is offline, and
        // a paused read never settles: the poll chain would stop for good.
        networkMode: "always",
        // Every answer is a new snapshot with its own `at`; sharing would only cost a deep compare.
        structuralSharing: false,
      },
    },
  });
  const entries = new Map<string, Entry>();
  /** The last visibility a change event reported, so a repeated event is a no-op. */
  let hidden = deps.visibility?.hidden() ?? false;

  /**
   * Whether the page is hidden NOW, asked of the source rather than of
   * `hidden`: the change stream's close on hide may call `livePoll` before
   * this layer hears the same event (listeners on one visibility event run in
   * registration order), and a cached flag would then still say visible and
   * read an overdue poll at once.
   */
  function isHidden(): boolean {
    return deps.visibility?.hidden() ?? false;
  }

  function entryOf(url: string): Entry {
    let entry = entries.get(url);
    if (entry === undefined) {
      entry = { read: LOADING, subscribers: new Set(), timer: undefined, hasTimer: false, inFlight: false, queued: false, liveIntervalMs: null, settledAt: null, release: null };
      entries.set(url, entry);
    }
    return entry;
  }

  function cancelTimer(entry: Entry): void {
    if (!entry.hasTimer) return;
    deps.clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.hasTimer = false;
  }

  /** The shortest live interval, read at scheduling time; null when every subscriber is one-shot. */
  function subscribedInterval(entry: Entry): number | null {
    let shortest: number | null = null;
    for (const subscriber of entry.subscribers) {
      if (subscriber.intervalMs === null) continue;
      if (shortest === null || subscriber.intervalMs < shortest) shortest = subscriber.intervalMs;
    }
    return shortest;
  }

  /** The interval the next poll waits: `livePoll`'s override when set and the URL polls at all. */
  function intervalOf(entry: Entry): number | null {
    const subscribed = subscribedInterval(entry);
    return subscribed === null || entry.liveIntervalMs === null ? subscribed : entry.liveIntervalMs;
  }

  function schedule(url: string, entry: Entry): void {
    // A listener that refreshed or subscribed during publish may already have
    // started a read or armed a timer; a second chain would overlap reads.
    if (entry.hasTimer || entry.inFlight) return;
    const interval = intervalOf(entry);
    if (interval === null) return;
    arm(url, entry, interval);
  }

  function arm(url: string, entry: Entry, interval: number): void {
    // Hidden: no poll at all; showing the page again catches every poll up.
    if (isHidden()) return;
    entry.hasTimer = true;
    entry.timer = deps.clock.setTimeout(() => {
      entry.timer = undefined;
      entry.hasTimer = false;
      // A timer that fires anyway while hidden drops; the catch-up covers it.
      if (isHidden()) return;
      start(url, entry);
    }, interval);
  }

  function notify(entry: Entry): void {
    // A Set tolerates a listener unsubscribing mid-iteration: the leaver is skipped.
    for (const subscriber of entry.subscribers) {
      try {
        subscriber.listener();
      } catch {
        // One broken panel must not stop the others hearing about the read.
      }
    }
  }

  function queryOptions(url: string) {
    return { queryKey: [url] as [string], queryFn: () => read(url) };
  }

  /**
   * Start a read the layer drives (first subscribe, poll, refresh, catch-up).
   * `announce` is false for the first subscribe's read: calling a listener
   * before `subscribe` returns would call back into React mid-subscribe, and
   * React re-reads every snapshot right after subscribing anyway. The
   * announce runs before the request goes, so a listener that leaves on
   * hearing it leaves before anything is fetched.
   */
  function start(url: string, entry: Entry, announce = true): void {
    entry.inFlight = true;
    if (announce) {
      notify(entry);
      if (entry.subscribers.size === 0) {
        entry.inFlight = false;
        return;
      }
    }
    // `query.fetch`, not `fetchQuery`: the latter skips the request when the
    // data looks fresh by Query's own `Date.now()`, which a wall clock stepping
    // back makes true even at staleTime 0, and then no settle would ever clear
    // `inFlight` and the URL would stop polling for good. `fetch` always reads,
    // or joins the read on the wire. Never cancelRefetch: a read on the wire is
    // never thrown away for another.
    const options = client.defaultQueryOptions(queryOptions(url));
    client.getQueryCache().build(client, options).fetch(options).catch(() => {
      // The query's state carries the error; the cache listener publishes it.
    });
  }

  /** Re-read now keeping the data on screen; in flight, queue exactly one more after it. */
  function refreshEntry(url: string, entry: Entry): void {
    if (entry.inFlight) {
      entry.queued = true;
      return;
    }
    cancelTimer(entry);
    start(url, entry);
  }

  /** A read settled (success or error): publish it, then the store's settle rules. */
  function settle(url: string, entry: Entry, read: Read<unknown>): void {
    entry.inFlight = false;
    entry.settledAt = deps.clock.now();
    entry.read = read;
    notify(entry);
    // Nobody reads it (they left while it was on the wire): the newest data
    // stays cached for a returning reader, but nothing polls a URL nobody reads.
    if (entry.subscribers.size === 0) {
      entry.queued = false;
      return;
    }
    if (entry.queued) {
      entry.queued = false;
      // A listener's refresh during publish may already have started one.
      if (!entry.inFlight) start(url, entry);
      return;
    }
    schedule(url, entry);
  }

  function onCacheEvent(event: QueryCacheNotifyEvent): void {
    const url = event.query.queryKey[0];
    if (typeof url !== "string") return;
    const entry = entries.get(url);
    if (entry === undefined) return;
    if (event.type === "removed") {
      // Garbage-collected after KEEP_ALIVE_MS unread: a reader arriving now
      // must see a skeleton, not data FeedStamp would present as current.
      entry.read = LOADING;
      entry.settledAt = null;
      return;
    }
    if (event.type !== "updated") return;
    const query = event.query as ReadQuery;
    switch (event.action.type) {
      case "fetch":
        // Already announced when the layer started it; a prefetch's start is
        // news to the readers, and replaces any poll pending beside it.
        if (entry.inFlight) return;
        entry.inFlight = true;
        cancelTimer(entry);
        notify(entry);
        return;
      case "success": {
        const snapshot = query.state.data;
        if (snapshot === undefined) return;
        settle(url, entry, { state: "ready", data: snapshot.data, at: new Date(snapshot.at), snapshotAt: snapshot.snapshotAt });
        return;
      }
      case "error": {
        const error = query.state.error;
        const last = query.state.data;
        settle(url, entry, {
          state: "error",
          message: error?.message ?? "read failed",
          status: error instanceof ReadError ? error.status : null,
          data: last === undefined ? null : last.data,
          answered: last !== undefined,
        });
        return;
      }
      default:
        return;
    }
  }

  // Listeners on Query's cache run synchronously inside the state change
  // (`notifyManager.batch` defers only observer callbacks), so a read's start
  // and settle reach the readers in the same tick as the store's did.
  client.getQueryCache().subscribe(onCacheEvent);

  /** Hold the URL's query in the cache while anyone reads it, so gcTime runs only once nobody does. */
  function hold(url: string, entry: Entry): void {
    if (entry.release !== null) return;
    // Disabled: it never fetches by itself; it only counts as a reader to Query.
    const observer = new QueryObserver<Snapshot, Error, Snapshot, Snapshot, [string]>(client, { queryKey: [url], enabled: false });
    entry.release = observer.subscribe(() => {});
  }

  function onVisibilityChange(): void {
    const next = isHidden();
    if (next === hidden) return;
    hidden = next;
    if (hidden) {
      for (const entry of entries.values()) cancelTimer(entry);
      return;
    }
    for (const [url, entry] of entries) {
      // Only polling reads catch up. A one-shot read feeds things like a form
      // built from it, which must not reload under the operator merely
      // because they switched tabs.
      if (entry.subscribers.size === 0 || intervalOf(entry) === null) continue;
      refreshEntry(url, entry);
    }
  }

  // Once, for the layer's life: the page's client lives as long as the page.
  deps.visibility?.onChange(onVisibilityChange);

  /** The read itself; a failure throws a ReadError. */
  async function read(url: string): Promise<Snapshot> {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new ReadError(error instanceof Error ? error.message : String(error), null);
    }
    if (!response.ok) throw new ReadError(await readFailureMessage(response), response.status);
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new ReadError(error instanceof Error ? error.message : String(error), null);
    }
    return { data, snapshotAt: snapshotAtOf(response.headers), at: deps.clock.now() };
  }

  /**
   * Fresh by the layer's clock, not Query's: Query stamps `dataUpdatedAt`
   * with `Date.now()`, and the clock here is injected (a fake one in tests).
   */
  function freshFor(query: ReadQuery): number {
    const snapshot = query.state.data;
    if (snapshot === undefined) return 0;
    return deps.clock.now() - snapshot.at < KEEP_ALIVE_MS ? Infinity : 0;
  }

  return {
    client,

    get<T>(url: string): Read<T> {
      return (entries.get(url)?.read ?? LOADING) as Read<T>;
    },

    subscribe(url, intervalMs, listener) {
      const entry = entryOf(url);
      const subscriber: Subscriber = { intervalMs, listener };
      const first = entry.subscribers.size === 0;
      entry.subscribers.add(subscriber);
      if (first) {
        // A one-shot read feeds a form that seeds its draft from the data, and
        // the old read store (deleted in #738) dropped it with its last reader (#734): served from
        // the cache, the form would open editable on up to KEEP_ALIVE_MS old
        // data, and the fresh read landing would throw the operator's edits
        // away (or a save would write over a newer config). So it opens on a
        // skeleton until its own read lands; polled reads keep the cache.
        if (intervalMs === null && !entry.inFlight) client.removeQueries({ queryKey: [url], exact: true });
        // A failure nobody was reading when it landed (a hover's prefetch)
        // with no data behind it: the reader opens on a skeleton while its own
        // read runs, as it always did, not on someone else's stale error.
        if (entry.read.state === "error" && entry.read.data === null) entry.read = LOADING;
        hold(url, entry);
        // A read already on the wire (a prefetch, or one the last reader left
        // behind) is joined: its settle arms the poll.
        if (!entry.inFlight) start(url, entry, false);
      } else if (!entry.inFlight && !entry.hasTimer) {
        // Every earlier subscriber was one-shot; a polling one starts the timer.
        schedule(url, entry);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entry.subscribers.delete(subscriber);
        // Others still read it: a timer already pending with the leaver's
        // shorter delay fires once as scheduled, and the next schedule uses
        // the remaining intervals. Rescheduling here would push a due read back.
        if (entry.subscribers.size > 0) return;
        // Nobody reads it any more: stop polling and drop a queued refresh,
        // but keep the data for KEEP_ALIVE_MS so a reader coming back within
        // it sees it at once instead of a skeleton (#727).
        cancelTimer(entry);
        entry.queued = false;
        const release = entry.release;
        entry.release = null;
        release?.();
      };
    },

    refresh(url) {
      const entry = entries.get(url);
      if (entry === undefined || entry.subscribers.size === 0) return;
      refreshEntry(url, entry);
    },

    livePoll(url, intervalMs) {
      const entry = entryOf(url);
      if (entry.liveIntervalMs === intervalMs) return;
      entry.liveIntervalMs = intervalMs;
      // In flight: the settle schedules with the new interval. Unread: the
      // first subscriber's read does.
      if (entry.subscribers.size === 0 || entry.inFlight) return;
      cancelTimer(entry);
      // Hidden: the change stream closing on hide lands here, and must not
      // read "overdue now"; the catch-up on show uses the new interval.
      if (isHidden()) return;
      const interval = intervalOf(entry);
      if (interval === null) return;
      if (intervalMs !== null) {
        // Slowing down never reads now: the stream says what changes.
        arm(url, entry, interval);
        return;
      }
      // Back to the normal rule: a read already overdue by it goes now.
      const since = entry.settledAt === null ? interval : deps.clock.now() - entry.settledAt;
      if (since >= interval) start(url, entry);
      else arm(url, entry, interval - since);
    },

    inFlight(url) {
      const entry = entries.get(url);
      // "False for a URL nobody reads": a read the last reader left behind is nobody's busy flag.
      return entry !== undefined && entry.subscribers.size > 0 && entry.inFlight;
    },

    prefetch(url) {
      // An entry, so the cache listener publishes the answer to readers who
      // arrive while it is on the wire. Hidden or not, it reads: it is the
      // operator's own hover, not a background poll.
      const entry = entryOf(url);
      // One read per hover at most: none while one is on the wire, and none
      // within KEEP_ALIVE_MS of the last settle, a failure included. Query
      // marks a failed query invalidated (always stale), so without this a
      // failing project would be re-read on every pass of the pointer.
      if (entry.inFlight) return;
      if (entry.settledAt !== null && deps.clock.now() - entry.settledAt < KEEP_ALIVE_MS) return;
      // KEEP_ALIVE_MS of freshness, judged by the layer's clock (see freshFor).
      void client.prefetchQuery({ ...queryOptions(url), staleTime: (query) => freshFor(query as ReadQuery) });
    },
  };
}

/**
 * What a binding hands `useSyncExternalStore` for one target. A null URL (a
 * read that does not apply here, such as the bridge status locally) never
 * touches the store, so it never fetches. Kept here, React-free, so that rule
 * is tested without a DOM.
 */
export function bindRead<T>(store: () => ReadStore, url: string | null, intervalMs: number | null): {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Read<T>;
  getInFlight: () => boolean;
  refresh: () => void;
} {
  if (url === null) {
    return { subscribe: () => () => {}, getSnapshot: () => LOADING, getInFlight: () => false, refresh: () => {} };
  }
  return {
    subscribe: (listener) => store().subscribe(url, intervalMs, listener),
    getSnapshot: () => store().get<T>(url),
    getInFlight: () => store().inFlight(url),
    refresh: () => store().refresh(url),
  };
}

/** One shared empty snapshot, so a binding over no targets keeps one identity. */
export const NO_READS: readonly Read<never>[] = [];

/**
 * `bindRead` over several targets at once, for a view that reads one URL per
 * project (the factory floor). Each URL keeps its own store entry, so one that
 * fails does not touch the others. The snapshot array is cached and handed
 * back unchanged while every element is the same object: a fresh array per
 * call would make `useSyncExternalStore` re-render forever.
 */
export function bindReads<T>(store: () => ReadStore, targets: readonly { url: string; intervalMs: number | null }[]): {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly Read<T>[];
  refresh: () => void;
} {
  if (targets.length === 0) {
    return { subscribe: () => () => {}, getSnapshot: () => NO_READS, refresh: () => {} };
  }
  let last: readonly Read<T>[] = NO_READS;
  return {
    subscribe: (listener) => {
      const unsubscribes = targets.map((target) => store().subscribe(target.url, target.intervalMs, listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    getSnapshot: () => {
      const current = targets.map((target) => store().get<T>(target.url));
      const same = current.length === last.length && current.every((read, index) => read === last[index]);
      if (!same) last = current;
      return last;
    },
    refresh: () => {
      for (const target of targets) store().refresh(target.url);
    },
  };
}
