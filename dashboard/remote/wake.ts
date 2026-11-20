/**
 * The bridge's wake-ups: a push over Supabase Realtime that a command row or a
 * viewer has landed, so the bridge needn't poll on a short interval.
 *
 * The store's `ralph.wake()` trigger broadcasts from the database on the
 * private channel `ralph:bridge`: event `command` with `{ project, id }`, event
 * `viewer` with `{ project }`. Payloads carry ids only, never a command body,
 * and a wake-up is a hint, never authority: the bridge reads and claims the
 * row itself over Postgres, so a forged or replayed wake-up can at most make
 * it look (spec §5 "Wake-ups").
 *
 * Realtime admits a non-browser client the way it admits a browser: the
 * project's publishable key plus a user JWT, checked against the RLS policy on
 * `realtime.messages`. The bridge signs in as its dedicated Auth user and keeps
 * `realtime.setAuth` current on every token refresh (§7). It takes no other
 * key: a legacy JWT key or anything not `sb_publishable_…` is refused.
 *
 * Broadcasts are not queued for a disconnected client, so every (re)subscribe
 * calls `onSweep`, and a 30 s timer calls it whatever the socket is doing. A
 * channel that errors, times out or closes reports `poll-only` and is
 * replaced after an exponential backoff (§6).
 *
 * This module imports supabase-js and nothing else: no ralph module and no
 * dashboard adapter, so the bridge stays on its side of the boundary that
 * `read-only.test.ts` pins. `channelFactory` is the seam the tests replace.
 */
import { createClient } from "@supabase/supabase-js";

/** The one Realtime topic the store broadcasts wake-ups on. */
export const WAKE_TOPIC = "ralph:bridge";

/** How often the bridge sweeps queued rows, subscribed or not. */
export const SWEEP_EVERY_MS = 30_000;

/** The first resubscribe delay, doubled per failed attempt up to the max. */
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 300_000;

/** How far either way a backoff delay is jittered, as a fraction. */
const BACKOFF_JITTER = 0.2;

/** `realtime`: wake-ups arrive by push. `poll-only`: only the sweep carries commands. */
export type WakeStatus = "realtime" | "poll-only";

export type WakeEvent = "command" | "viewer";

export interface CommandWake {
  project: string;
  id: string;
}

export interface ViewerWake {
  project: string;
}

/** What the bridge needs to reach Realtime. Its only key is the publishable one. */
export interface WakeConfig {
  url: string;
  publishableKey: string;
  email: string;
  password: string;
}

/** A callback may be async; its failure is the bridge's to log, never the socket's. */
type Callback<T extends unknown[]> = (...args: T) => void | Promise<void>;

export interface WakeOptions extends WakeConfig {
  onCommand: Callback<[CommandWake]>;
  onViewer: Callback<[ViewerWake]>;
  onSweep: Callback<[]>;
  onStatus: Callback<[status: WakeStatus, problem?: string]>;
  /** Builds the transport. Defaults to supabase-js; tests pass a fake. */
  channelFactory?: (config: { url: string; publishableKey: string }) => WakeTransport;
  /** The jitter source, `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
  /** How often the sweep runs. Defaults to `SWEEP_EVERY_MS`; the end-to-end test shortens it. */
  sweepEveryMs?: number;
}

export interface WakeHandle {
  /** Unsubscribe, sign out, and stop every timer. */
  stop(): Promise<void>;
}

/** A change to the Auth session that Realtime has to hear about. */
export type AuthChange = { kind: "refreshed"; token: string } | { kind: "signed-out" };

/** Everything this module needs from supabase-js, and nothing more. */
export interface WakeTransport {
  /** Sign in with a password; resolves to the access token, rejects on failure. */
  signIn(email: string, password: string): Promise<string>;
  onAuthChange(listener: (change: AuthChange) => void): void;
  setAuth(token: string): void | Promise<void>;
  channel(topic: string): WakeChannel;
  signOut(): Promise<void>;
}

export interface WakeChannel {
  on(event: WakeEvent, handler: (payload: unknown) => void): WakeChannel;
  subscribe(callback: (status: string, error?: Error) => void): void;
  /** Unsubscribe and forget the channel. */
  close(): Promise<void>;
}

/** The subscribe statuses after which the channel is given up and replaced. */
const FAILED = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The delay before attempt `attempt` (from 0): 2 s doubling to 5 min, ±20 %. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MIN_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.round(base * (1 + (random() * 2 - 1) * BACKOFF_JITTER));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProject = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A `command` payload's ids, or null for anything malformed. */
export function parseCommandWake(payload: unknown): CommandWake | null {
  if (!isRecord(payload) || !isProject(payload.project)) return null;
  if (typeof payload.id !== "string" || !UUID.test(payload.id)) return null;
  return { project: payload.project, id: payload.id };
}

/** A `viewer` payload's project, or null for anything malformed. */
export function parseViewerWake(payload: unknown): ViewerWake | null {
  if (!isRecord(payload) || !isProject(payload.project)) return null;
  return { project: payload.project };
}

/** Call a bridge callback and swallow what it throws, sync or async. */
function fire<T extends unknown[]>(callback: Callback<T>, ...args: T): void {
  try {
    void Promise.resolve(callback(...args)).catch(() => {});
  } catch {
    // The bridge logs its own failures; a wake-up must not die of one.
  }
}

/** supabase-js behind the transport seam. */
export function supabaseTransport(config: { url: string; publishableKey: string }): WakeTransport {
  const client = createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return {
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      return data.session.access_token;
    },
    onAuthChange(listener) {
      client.auth.onAuthStateChange((event, session) => {
        if (event === "TOKEN_REFRESHED" && session) listener({ kind: "refreshed", token: session.access_token });
        else if (event === "SIGNED_OUT") listener({ kind: "signed-out" });
      });
    },
    setAuth: (token) => client.realtime.setAuth(token),
    channel(topic) {
      const raw = client.channel(topic, { config: { private: true } });
      const channel: WakeChannel = {
        on(event, handler) {
          raw.on("broadcast", { event }, (message) => handler(message.payload));
          return channel;
        },
        subscribe(callback) {
          raw.subscribe((status, error) => callback(status, error));
        },
        async close() {
          await client.removeChannel(raw);
        },
      };
      return channel;
    },
    async signOut() {
      await client.auth.signOut();
    },
  };
}

/**
 * Start listening for wake-ups. It returns at once; sign-in and subscribe run
 * in the background and report through `onStatus`. Throws only on a key that
 * isn't a publishable key, before any connection is made.
 */
export function startWake(options: WakeOptions): WakeHandle {
  const { url, publishableKey, email, password } = options;
  if (!publishableKey.startsWith("sb_publishable_")) {
    throw new Error("wake: Realtime takes the project's publishable key (sb_publishable_…) and no other");
  }
  const random = options.random ?? Math.random;
  const transport = (options.channelFactory ?? supabaseTransport)({ url, publishableKey });

  let stopped = false;
  let signedIn = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let current: WakeChannel | null = null;
  /** Bumped whenever the current channel is dropped, so its late events are ignored. */
  let generation = 0;
  let reported: string | null = null;

  const report = (status: WakeStatus, problem?: string): void => {
    const key = `${status}\n${problem ?? ""}`;
    if (key === reported) return;
    reported = key;
    fire(options.onStatus, status, problem);
  };

  const sweep = (): void => fire(options.onSweep);
  const sweeper = setInterval(sweep, options.sweepEveryMs ?? SWEEP_EVERY_MS);

  const drop = (): void => {
    generation += 1;
    const channel = current;
    current = null;
    if (channel) void channel.close().catch(() => {});
  };

  const scheduleRetry = (): void => {
    if (stopped || retry !== null) return;
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      if (signedIn) subscribe();
      else void connect();
    }, delay);
  };

  const subscribe = (): void => {
    if (stopped) return;
    drop();
    const mine = generation;
    const live = (): boolean => !stopped && mine === generation;
    const channel = transport.channel(WAKE_TOPIC);
    current = channel;
    channel
      .on("command", (payload) => {
        const wake = parseCommandWake(payload);
        if (wake && live()) fire(options.onCommand, wake);
      })
      .on("viewer", (payload) => {
        const wake = parseViewerWake(payload);
        if (wake && live()) fire(options.onViewer, wake);
      });
    channel.subscribe((status, error) => {
      if (!live()) return;
      if (status === "SUBSCRIBED") {
        attempt = 0;
        report("realtime");
        sweep();
      } else if (FAILED.has(status)) {
        drop();
        report("poll-only", `realtime ${status}${error?.message ? `: ${error.message}` : ""}`);
        scheduleRetry();
      }
    });
  };

  const connect = async (): Promise<void> => {
    let token: string;
    try {
      token = await transport.signIn(email, password);
    } catch (error) {
      if (stopped) return;
      report("poll-only", `sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRetry();
      return;
    }
    if (stopped) return;
    signedIn = true;
    void Promise.resolve(transport.setAuth(token)).catch(() => {});
    subscribe();
  };

  transport.onAuthChange((change) => {
    if (stopped) return;
    if (change.kind === "refreshed") {
      void Promise.resolve(transport.setAuth(change.token)).catch(() => {});
      return;
    }
    // The session is gone (a refresh failed, or the user was removed): treat
    // it as Realtime down and sign in afresh after the backoff.
    signedIn = false;
    drop();
    report("poll-only", "auth session ended (token refresh failed?)");
    scheduleRetry();
  });

  void connect();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(sweeper);
      if (retry !== null) clearTimeout(retry);
      retry = null;
      const channel = current;
      generation += 1;
      current = null;
      await channel?.close().catch(() => {});
      await transport.signOut().catch(() => {});
    },
  };
}
