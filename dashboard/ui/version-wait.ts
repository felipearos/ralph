/**
 * The remote page's change stream (#731): a `LiveSource` over fetch
 * long-polling, React-free like `live-stream.ts`.
 *
 * The hosted function relays no server-sent events, but it can hold
 * `GET /api/versions?since=…` until a snapshot key it was asked about has a
 * version other than the one sent. Each answer whose key moved becomes the
 * same `{ key, version }` message the local stream sends, so
 * `bindLiveStream` refreshes that key's reads and slows their polls exactly
 * as it does locally. Any failure closes the source: the binding falls back
 * to each read's own poll and re-opens a fresh source with backoff.
 */
import type { VersionsView } from "../contracts";
import type { LiveSource } from "./live-stream";

export interface VersionWaitOptions {
  /** The versions URL, without a query. */
  url: string;
  /** The keys to wait on, read before every request so a roster change joins on the next one. */
  keys: () => readonly string[];
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Wall time in ms, to tell an answer the server held from one it gave at once; injected by tests. */
  now?: () => number;
}

/** An answer that changed nothing and came back faster than this is waited out, so a misbehaving server cannot spin the page. */
export const FAST_ANSWER_MS = 1_000;

/** Sent for a key whose version went to null: `live-stream.ts` only acts on a numeric version. */
const GONE_VERSION = -1;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** The answer's versions, or null for anything that is not `{ versions: { key: number | null } }`. */
function versionsOf(body: unknown): Record<string, number | null> | null {
  if (typeof body !== "object" || body === null) return null;
  const { versions } = body as Partial<VersionsView>;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) return null;
  for (const value of Object.values(versions)) if (value !== null && typeof value !== "number") return null;
  return versions;
}

export function versionWaitSource({
  url,
  keys,
  // Called unbound-safe: a browser's fetch throws when invoked off `globalThis`.
  fetch: fetchFn = (input, init) => globalThis.fetch(input, init),
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: clock = Date.now,
}: VersionWaitOptions): LiveSource {
  const known = new Map<string, number | null>();
  let state = CONNECTING;
  let controller: AbortController | null = null;
  let timer: unknown = null;

  const source: LiveSource = {
    onopen: null,
    onmessage: null,
    onerror: null,
    // Nothing on this path sends `unavailable`: the listener is accepted and never called.
    addEventListener() {},
    close() {
      if (state === CLOSED) return;
      state = CLOSED;
      if (timer !== null) clearTimer(timer);
      timer = null;
      controller?.abort();
      controller = null;
    },
    get readyState() {
      return state;
    },
  };

  const fail = (): void => {
    if (state === CLOSED) return;
    state = CLOSED;
    controller = null;
    source.onerror?.({});
  };

  async function request(): Promise<void> {
    if (state === CLOSED) return;
    const asked = [...new Set(keys())];
    const since: Record<string, number | null> = {};
    for (const key of asked) since[key] = known.get(key) ?? null;
    const abort = new AbortController();
    controller = abort;
    const started = clock();
    let versions: Record<string, number | null> | null;
    try {
      const response = await fetchFn(`${url}?since=${encodeURIComponent(JSON.stringify(since))}`, { signal: abort.signal });
      if (!response.ok) throw new Error(`versions answered ${response.status}`);
      versions = versionsOf(await response.json());
    } catch {
      // An abort is `close()`, which already settled the state: not an error.
      if (!abort.signal.aborted) fail();
      return;
    }
    if (state === CLOSED) return;
    if (versions === null) {
      fail();
      return;
    }
    controller = null;
    const baseline = state === CONNECTING;
    // Held by the server, the answer reports a push made after the page's
    // reads were taken (a store the bridge had not pushed yet): that is a
    // change to refresh, even as the baseline.
    const held = clock() - started >= FAST_ANSWER_MS;
    let moved = false;
    const messages: { key: string; version: number }[] = [];
    for (const key of asked) {
      if (!(key in versions)) continue;
      const current = versions[key] ?? null;
      if (current !== since[key]) moved = true;
      // A key that joined after the baseline (a new loop) was mounted and read
      // while the previous wait, which did not name it, was held: its read may
      // predate this version, so one refresh. The baseline's own keys were just
      // read, unless the server held the answer.
      const joined = !known.has(key) && current !== null && (!baseline || held);
      if (joined || (known.has(key) && known.get(key) !== current)) messages.push({ key, version: current ?? GONE_VERSION });
      known.set(key, current);
    }
    if (baseline) {
      state = OPEN;
      source.onopen?.({});
    }
    for (const message of messages) {
      if (state === CLOSED) return;
      source.onmessage?.({ data: JSON.stringify(message) });
    }
    if (state === CLOSED) return;
    if (!moved && !held) {
      timer = setTimer(() => {
        timer = null;
        void request();
      }, FAST_ANSWER_MS);
      return;
    }
    void request();
  }

  void request();
  return source;
}
