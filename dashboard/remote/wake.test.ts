// @vitest-environment node
/**
 * The bridge's wake subscription, over a fake transport.
 *
 * Realtime itself never runs here: `channelFactory` hands `startWake` a fake
 * that records sign-ins, `setAuth` calls and channels, and lets a test push a
 * subscribe status or a broadcast into the channel it opened. One opt-in test
 * at the bottom runs the same module against a real Supabase project.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffDelay,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  startWake,
  SWEEP_EVERY_MS,
  WAKE_TOPIC,
  type AuthChange,
  type WakeChannel,
  type WakeEvent,
  type WakeHandle,
  type WakeOptions,
  type WakeStatus,
  type WakeTransport,
} from "./wake";

const PUBLISHABLE = "sb_publishable_test";
const ID = "0b9d3c1e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

class FakeChannel implements WakeChannel {
  handlers = new Map<WakeEvent, (payload: unknown) => void>();
  status: ((status: string, error?: Error) => void) | null = null;
  closed = false;

  constructor(readonly topic: string) {}

  on(event: WakeEvent, handler: (payload: unknown) => void): WakeChannel {
    this.handlers.set(event, handler);
    return this;
  }

  subscribe(callback: (status: string, error?: Error) => void): void {
    this.status = callback;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Push one subscribe status, as Realtime would. */
  report(status: string, error?: Error): void {
    this.status?.(status, error);
  }

  /** Deliver one broadcast's payload. */
  send(event: WakeEvent, payload: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

class FakeTransport implements WakeTransport {
  channels: FakeChannel[] = [];
  tokens: string[] = [];
  signIns: Array<{ email: string; password: string }> = [];
  signedOut = false;
  failSignIn: string | null = null;
  listener: ((change: AuthChange) => void) | null = null;

  async signIn(email: string, password: string): Promise<string> {
    this.signIns.push({ email, password });
    if (this.failSignIn !== null) throw new Error(this.failSignIn);
    return `token-${this.signIns.length}`;
  }

  onAuthChange(listener: (change: AuthChange) => void): void {
    this.listener = listener;
  }

  setAuth(token: string): void {
    this.tokens.push(token);
  }

  channel(topic: string): WakeChannel {
    const channel = new FakeChannel(topic);
    this.channels.push(channel);
    return channel;
  }

  async signOut(): Promise<void> {
    this.signedOut = true;
  }

  get last(): FakeChannel {
    const channel = this.channels.at(-1);
    if (!channel) throw new Error("no channel opened yet");
    return channel;
  }
}

interface Harness {
  transport: FakeTransport;
  configs: Array<{ url: string; publishableKey: string }>;
  commands: Array<{ project: string; id: string }>;
  viewers: Array<{ project: string }>;
  sweeps: number;
  statuses: Array<[WakeStatus, string | undefined]>;
  handle: WakeHandle;
}

function harness(overrides: Partial<WakeOptions> = {}, transport = new FakeTransport()): Harness {
  const h = {
    transport,
    configs: [],
    commands: [],
    viewers: [],
    sweeps: 0,
    statuses: [],
  } as unknown as Harness;
  h.handle = startWake({
    url: "https://example.supabase.co",
    publishableKey: PUBLISHABLE,
    email: "bridge@ralph.invalid",
    password: "hunter2",
    onCommand: (wake) => {
      h.commands.push(wake);
    },
    onViewer: (wake) => {
      h.viewers.push(wake);
    },
    onSweep: () => {
      h.sweeps += 1;
    },
    onStatus: (status, problem) => {
      h.statuses.push([status, problem]);
    },
    channelFactory: (config) => {
      h.configs.push(config);
      return transport;
    },
    random: () => 0.5,
    ...overrides,
  });
  return h;
}

/** Let the sign-in promise and whatever it chains settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("startWake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs in, hands the token to Realtime, and joins the private wake topic", async () => {
    const h = harness();
    await settle();

    expect(h.configs).toEqual([{ url: "https://example.supabase.co", publishableKey: PUBLISHABLE }]);
    expect(h.transport.signIns).toEqual([{ email: "bridge@ralph.invalid", password: "hunter2" }]);
    expect(h.transport.tokens).toEqual(["token-1"]);
    expect(h.transport.channels.map((channel) => channel.topic)).toEqual([WAKE_TOPIC]);
    expect(WAKE_TOPIC).toBe("ralph:bridge");
    expect([...h.transport.last.handlers.keys()].sort()).toEqual(["command", "viewer"]);
    await h.handle.stop();
  });

  describe("dispatch", () => {
    it("calls onCommand for a command broadcast and onViewer for a viewer broadcast", async () => {
      const h = harness();
      await settle();
      h.transport.last.report("SUBSCRIBED");

      h.transport.last.send("command", { project: "loggd", id: ID });
      h.transport.last.send("viewer", { project: "ralph" });

      expect(h.commands).toEqual([{ project: "loggd", id: ID }]);
      expect(h.viewers).toEqual([{ project: "ralph" }]);
      await h.handle.stop();
    });

    it("forwards the ids alone, whatever else a payload carries", async () => {
      const h = harness();
      await settle();

      h.transport.last.send("command", { project: "loggd", id: ID, body: { action: "pause" } });

      expect(h.commands).toEqual([{ project: "loggd", id: ID }]);
      await h.handle.stop();
    });

    it.each<[string, WakeEvent, unknown]>([
      ["a null payload", "command", null],
      ["a string payload", "command", "loggd"],
      ["an array payload", "command", ["loggd", ID]],
      ["a missing project", "command", { id: ID }],
      ["an empty project", "command", { project: "", id: ID }],
      ["a numeric project", "command", { project: 7, id: ID }],
      ["a missing id", "command", { project: "loggd" }],
      ["an id that is not a UUID", "command", { project: "loggd", id: "42" }],
      ["a UUID with junk around it", "command", { project: "loggd", id: ` ${ID}x` }],
      ["a viewer with no project", "viewer", {}],
      ["a viewer with an empty project", "viewer", { project: "" }],
      ["a viewer with a non-string project", "viewer", { project: ["loggd"] }],
    ])("ignores %s", async (_name, event, payload) => {
      const h = harness();
      await settle();

      h.transport.last.send(event, payload);

      expect(h.commands).toEqual([]);
      expect(h.viewers).toEqual([]);
      await h.handle.stop();
    });

    it("does not let a throwing callback break the subscription", async () => {
      const h = harness({
        onCommand: () => {
          throw new Error("boom");
        },
        onViewer: async () => {
          throw new Error("async boom");
        },
      });
      await settle();

      h.transport.last.send("command", { project: "loggd", id: ID });
      h.transport.last.send("viewer", { project: "loggd" });
      await settle();

      expect(h.transport.channels).toHaveLength(1);
      await h.handle.stop();
    });
  });

  describe("sweeps", () => {
    it("sweeps once on every SUBSCRIBED, the first and each after a reconnect", async () => {
      const h = harness();
      await settle();
      expect(h.sweeps).toBe(0);

      h.transport.last.report("SUBSCRIBED");
      expect(h.sweeps).toBe(1);

      h.transport.last.report("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(backoffDelay(0, () => 0.5));
      expect(h.transport.channels).toHaveLength(2);
      expect(h.sweeps).toBe(1);

      h.transport.last.report("SUBSCRIBED");
      expect(h.sweeps).toBe(2);
      await h.handle.stop();
    });

    it("sweeps every 30 s whatever the socket is doing", async () => {
      expect(SWEEP_EVERY_MS).toBe(30_000);
      const transport = new FakeTransport();
      transport.failSignIn = "Invalid login credentials";
      const h = harness({}, transport);
      await settle();

      await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS - 1);
      expect(h.sweeps).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sweeps).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * SWEEP_EVERY_MS);
      expect(h.sweeps).toBe(3);
      await h.handle.stop();
    });

    it("keeps sweeping on the timer while subscribed", async () => {
      const h = harness();
      await settle();
      h.transport.last.report("SUBSCRIBED");

      await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS);

      expect(h.sweeps).toBe(2);
      await h.handle.stop();
    });
  });

  describe("status and backoff", () => {
    it("reports realtime on SUBSCRIBED", async () => {
      const h = harness();
      await settle();

      h.transport.last.report("SUBSCRIBED");

      expect(h.statuses).toEqual([["realtime", undefined]]);
      await h.handle.stop();
    });

    it.each(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"])(
      "reports poll-only on %s and resubscribes after the backoff",
      async (status) => {
        const h = harness();
        await settle();
        h.transport.last.report("SUBSCRIBED");
        const first = h.transport.last;

        first.report(status, new Error("socket went away"));

        expect(h.statuses.at(-1)).toEqual(["poll-only", `realtime ${status}: socket went away`]);
        expect(first.closed).toBe(true);
        await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS - 1);
        expect(h.transport.channels).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.transport.channels).toHaveLength(2);

        h.transport.last.report("SUBSCRIBED");
        expect(h.statuses.at(-1)).toEqual(["realtime", undefined]);
        // Resubscribing reuses the session: no second sign-in.
        expect(h.transport.signIns).toHaveLength(1);
        await h.handle.stop();
      },
    );

    it("backs off exponentially between failed attempts and resets once subscribed", async () => {
      const h = harness();
      await settle();

      const opened: number[] = [];
      let elapsed = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        h.transport.last.report("CHANNEL_ERROR");
        const before = h.transport.channels.length;
        while (h.transport.channels.length === before) {
          await vi.advanceTimersByTimeAsync(1_000);
          elapsed += 1_000;
        }
        opened.push(elapsed);
        elapsed = 0;
      }
      expect(opened).toEqual([2_000, 4_000, 8_000, 16_000]);

      h.transport.last.report("SUBSCRIBED");
      h.transport.last.report("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS);
      expect(h.transport.channels).toHaveLength(6);
      await h.handle.stop();
    });

    it("ignores a status from a channel it already gave up on", async () => {
      const h = harness();
      await settle();
      const stale = h.transport.last;
      stale.report("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS);

      stale.report("SUBSCRIBED");
      stale.send("command", { project: "loggd", id: ID });

      expect(h.statuses.map(([status]) => status)).toEqual(["poll-only"]);
      expect(h.sweeps).toBe(0);
      expect(h.commands).toEqual([]);
      await h.handle.stop();
    });

    it("reports poll-only with the problem when sign-in fails, then retries with backoff", async () => {
      const transport = new FakeTransport();
      transport.failSignIn = "Invalid login credentials";
      const h = harness({}, transport);
      await settle();

      expect(h.statuses).toEqual([["poll-only", "sign-in failed: Invalid login credentials"]]);
      expect(transport.channels).toEqual([]);

      transport.failSignIn = null;
      await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS);
      expect(transport.signIns).toHaveLength(2);
      transport.last.report("SUBSCRIBED");
      expect(h.statuses.at(-1)).toEqual(["realtime", undefined]);
      await h.handle.stop();
    });

    it("does not repeat an unchanged status", async () => {
      const transport = new FakeTransport();
      transport.failSignIn = "Invalid login credentials";
      const h = harness({}, transport);
      await settle();
      await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS * 4);

      expect(transport.signIns.length).toBeGreaterThan(2);
      expect(h.statuses).toHaveLength(1);
      await h.handle.stop();
    });
  });

  describe("token refresh", () => {
    it("hands every refreshed token to realtime.setAuth", async () => {
      const h = harness();
      await settle();

      h.transport.listener?.({ kind: "refreshed", token: "token-refreshed-1" });
      h.transport.listener?.({ kind: "refreshed", token: "token-refreshed-2" });

      expect(h.transport.tokens).toEqual(["token-1", "token-refreshed-1", "token-refreshed-2"]);
      await h.handle.stop();
    });

    it("treats a lost session as Realtime down: poll-only with a problem, then signs in again", async () => {
      const h = harness();
      await settle();
      h.transport.last.report("SUBSCRIBED");
      const first = h.transport.last;

      h.transport.listener?.({ kind: "signed-out" });

      expect(first.closed).toBe(true);
      expect(h.statuses.at(-1)).toEqual(["poll-only", "auth session ended (token refresh failed?)"]);
      await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS);
      expect(h.transport.signIns).toHaveLength(2);
      expect(h.transport.tokens.at(-1)).toBe("token-2");
      expect(h.transport.channels).toHaveLength(2);
      await h.handle.stop();
    });
  });

  describe("stop", () => {
    it("unsubscribes, signs out, and stops every timer", async () => {
      const h = harness();
      await settle();
      h.transport.last.report("SUBSCRIBED");

      await h.handle.stop();

      expect(h.transport.last.closed).toBe(true);
      expect(h.transport.signedOut).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const sweeps = h.sweeps;
      await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS * 3);
      expect(h.sweeps).toBe(sweeps);
    });

    it("does not report or resubscribe on the CLOSED its own unsubscribe causes", async () => {
      const h = harness();
      await settle();
      h.transport.last.report("SUBSCRIBED");
      const channel = h.transport.last;

      await h.handle.stop();
      channel.report("CLOSED");
      h.transport.listener?.({ kind: "signed-out" });
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);

      expect(h.statuses).toEqual([["realtime", undefined]]);
      expect(h.transport.channels).toHaveLength(1);
    });

    it("cancels a pending resubscribe", async () => {
      const h = harness();
      await settle();
      h.transport.last.report("CHANNEL_ERROR");

      await h.handle.stop();
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);

      expect(h.transport.channels).toHaveLength(1);
    });
  });
});

describe("backoffDelay", () => {
  it("doubles from 2 s and caps at 5 min", () => {
    const flat = () => 0.5;
    expect(BACKOFF_MIN_MS).toBe(2_000);
    expect(BACKOFF_MAX_MS).toBe(300_000);
    expect([0, 1, 2, 3, 7, 8, 9, 40].map((attempt) => backoffDelay(attempt, flat))).toEqual([
      2_000, 4_000, 8_000, 16_000, 256_000, 300_000, 300_000, 300_000,
    ]);
  });

  it("jitters by at most 20 % either way", () => {
    expect(backoffDelay(0, () => 0)).toBe(1_600);
    expect(backoffDelay(0, () => 0.999_999)).toBe(2_400);
    expect(backoffDelay(40, () => 0)).toBe(240_000);
    expect(backoffDelay(40, () => 0.999_999)).toBe(360_000);
  });
});

describe("credentials", () => {
  const SOURCE = readFileSync(join(__dirname, "wake.ts"), "utf8");

  it("names only the publishable key in its config", () => {
    const config = /export interface WakeConfig \{([\s\S]*?)\n\}/.exec(SOURCE)?.[1] ?? "";
    const fields = [...config.matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1]);
    expect(fields).toEqual(["url", "publishableKey", "email", "password"]);
  });

  it("reads no environment and no secret or service_role key", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.env|Bun\.env/);
    expect(code).not.toMatch(/service_?role|secret/i);
  });

  it.each([
    ["a secret key", "sb_secret_abc123"],
    ["a legacy service_role JWT", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig"],
    ["a legacy anon JWT", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig"],
    ["an empty key", ""],
  ])("refuses %s before connecting to anything", (_name, key) => {
    const factory = vi.fn(() => new FakeTransport());
    expect(() => harness({ publishableKey: key, channelFactory: factory })).toThrow(/publishable key/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("imports supabase-js and nothing from ralph or the dashboard", () => {
    const imports = [...SOURCE.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(["@supabase/supabase-js"]);
  });
});

/**
 * The opt-in live test. It needs a Supabase project with the wake policy on
 * `realtime.messages` (dashboard/remote/schema.sql) and the bridge Auth user,
 * and the same Doppler variables the bridge runs with, plus the owner URL to
 * send the broadcast from SQL as the database would.
 */
const LIVE_ENV = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "RALPH_BRIDGE_AUTH_EMAIL",
  "RALPH_BRIDGE_AUTH_PASSWORD",
  "RALPH_SUPABASE_OWNER_URL",
] as const;
const LIVE = process.env.RALPH_REMOTE_LIVE === "1" && LIVE_ENV.every((name) => Boolean(process.env[name]));

describe.skipIf(!LIVE)("against a real Supabase project", () => {
  it(
    "receives a broadcast sent through realtime.send from SQL within 5 s",
    async () => {
      const env = (name: (typeof LIVE_ENV)[number]): string => process.env[name] ?? "";
      const project = `live-test-${randomUUID().slice(0, 8)}`;
      const id = randomUUID();
      let subscribed: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        subscribed = resolve;
      });
      let woke: (wake: { project: string; id: string }) => void = () => {};
      const received = new Promise<{ project: string; id: string }>((resolve) => {
        woke = resolve;
      });
      const handle = startWake({
        url: env("SUPABASE_URL"),
        publishableKey: env("SUPABASE_PUBLISHABLE_KEY"),
        email: env("RALPH_BRIDGE_AUTH_EMAIL"),
        password: env("RALPH_BRIDGE_AUTH_PASSWORD"),
        onCommand: (wake) => {
          if (wake.project === project) woke(wake);
        },
        onViewer: () => {},
        onSweep: () => {},
        onStatus: (status, problem) => {
          if (status === "realtime") subscribed();
          else if (problem) console.warn(`wake: ${problem}`);
        },
      });
      try {
        await withTimeout(ready, 20_000, "never subscribed to ralph:bridge");
        // Bun's own Postgres client, in a child: vitest runs on node.
        const send = spawnSync(
          "bun",
          [
            "-e",
            `const sql = new Bun.SQL(process.env.RALPH_SUPABASE_OWNER_URL);
             await sql\`select realtime.send(
               jsonb_build_object('project', \${process.env.WAKE_PROJECT}::text, 'id', \${process.env.WAKE_ID}::text),
               'command', 'ralph:bridge', true)\`;
             await sql.close();`,
          ],
          { encoding: "utf8", env: { ...process.env, WAKE_PROJECT: project, WAKE_ID: id }, timeout: 15_000 },
        );
        expect(send.status, send.stderr).toBe(0);
        await expect(withTimeout(received, 5_000, "no wake-up within 5 s")).resolves.toEqual({ project, id });
      } finally {
        await handle.stop();
      }
    },
    60_000,
  );
});

function withTimeout<T>(promise: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(why)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
