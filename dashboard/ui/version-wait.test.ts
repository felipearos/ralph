// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bindLiveStream } from "./live-stream";
import { createQueryReads, type ReadClock } from "./query-reads";
import { FAST_ANSWER_MS, versionWaitSource } from "./version-wait";

const URL_ = "/api/p/loggd/versions";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A fetch whose every request waits until the test answers it, keeping the signal it was given. */
function fakeFetch() {
  const calls: { url: string; signal: AbortSignal | undefined; answer(response: Response): void; reject(error: unknown): void }[] = [];
  const fetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      calls.push({ url, signal, answer: resolve, reject });
    });
  return { fetch, calls };
}

/** The `since` a request sent. */
const sinceOf = (url: string): unknown => JSON.parse(decodeURIComponent(url.slice(url.indexOf("?since=") + "?since=".length)));

/** Timers that fire only when the test fires them. */
function fakeTimer() {
  const timers = new Map<number, { ms: number; fn: () => void }>();
  let nextId = 1;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pending: () => [...timers.values()].map((timer) => timer.ms),
    fire() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
  };
}

function setup(initialKeys: string[] = ["dashboard", "controls"]) {
  const net = fakeFetch();
  const timer = fakeTimer();
  let keys = initialKeys;
  // The wall clock stands still unless a test moves it: an answer is "fast" by default.
  let at = 0;
  const source = versionWaitSource({
    url: URL_,
    keys: () => keys,
    fetch: net.fetch,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    now: () => at,
  });
  const opens: unknown[] = [];
  const messages: unknown[] = [];
  const errors: unknown[] = [];
  source.onopen = (event) => opens.push(event);
  source.onmessage = (event) => messages.push(JSON.parse(event.data as string));
  source.onerror = (event) => errors.push(event);
  return {
    net,
    timer,
    source,
    opens,
    messages,
    errors,
    setKeys: (next: string[]) => {
      keys = next;
    },
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("versionWaitSource", () => {
  it("opens on the baseline answer without a message, having sent null for every key", async () => {
    const { net, source, opens, messages } = setup();
    expect(source.readyState).toBe(0);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url.startsWith(`${URL_}?since=`)).toBe(true);
    expect(sinceOf(net.calls[0]!.url)).toEqual({ dashboard: null, controls: null });
    net.calls[0]!.answer(json({ versions: { dashboard: 3, controls: 7 } }));
    await flush();
    expect(source.readyState).toBe(1);
    expect(opens).toHaveLength(1);
    expect(messages).toEqual([]);
    // The baseline moved every key, so the next wait goes out at once with the versions learned.
    expect(net.calls).toHaveLength(2);
    expect(sinceOf(net.calls[1]!.url)).toEqual({ dashboard: 3, controls: 7 });
  });

  it("sends one message per moved key and waits on the new versions next", async () => {
    const { net, messages } = setup(["dashboard", "controls", "agents"]);
    net.calls[0]!.answer(json({ versions: { dashboard: 3, controls: 7, agents: null } }));
    await flush();
    net.calls[1]!.answer(json({ versions: { dashboard: 4, controls: 7, agents: 1 } }));
    await flush();
    expect(messages).toEqual([
      { key: "dashboard", version: 4 },
      { key: "agents", version: 1 },
    ]);
    expect(net.calls).toHaveLength(3);
    expect(sinceOf(net.calls[2]!.url)).toEqual({ dashboard: 4, controls: 7, agents: 1 });
  });

  it("sends a numeric version for a key that went to null", async () => {
    const { net, messages } = setup(["dashboard"]);
    net.calls[0]!.answer(json({ versions: { dashboard: 3 } }));
    await flush();
    net.calls[1]!.answer(json({ versions: { dashboard: null } }));
    await flush();
    expect(messages).toEqual([{ key: "dashboard", version: -1 }]);
  });

  it("re-reads the keys per request, and refreshes a key that joined after the baseline once", async () => {
    const { net, messages, setKeys } = setup(["dashboard"]);
    net.calls[0]!.answer(json({ versions: { dashboard: 3 } }));
    await flush();
    expect(sinceOf(net.calls[1]!.url)).toEqual({ dashboard: 3 });
    setKeys(["dashboard", "control/ralph"]);
    net.calls[1]!.answer(json({ versions: { dashboard: 4 } }));
    await flush();
    expect(sinceOf(net.calls[2]!.url)).toEqual({ dashboard: 4, "control/ralph": null });
    net.calls[2]!.answer(json({ versions: { dashboard: 4, "control/ralph": 9 } }));
    await flush();
    // Its read was taken while the previous wait, which did not name it, was held.
    expect(messages).toEqual([
      { key: "dashboard", version: 4 },
      { key: "control/ralph", version: 9 },
    ]);
    expect(sinceOf(net.calls[3]!.url)).toEqual({ dashboard: 4, "control/ralph": 9 });
  });

  const failures: [string, (call: ReturnType<typeof fakeFetch>["calls"][number]) => void][] = [
    ["a rejected fetch", (call) => call.reject(new TypeError("network down"))],
    ["a 500", (call) => call.answer(json({ error: "boom" }, 500))],
    ["a body that is not JSON", (call) => call.answer(new Response("not json", { status: 200 }))],
    ["a body without versions", (call) => call.answer(json({ nope: 1 }))],
    ["a version that is not a number", (call) => call.answer(json({ versions: { dashboard: "3" } }))],
  ];
  for (const [name, failure] of failures) {
    it(`closes and errors on ${name}, asking nothing more`, async () => {
      const { net, timer, source, opens, errors } = setup();
      net.calls[0]!.answer(json({ versions: { dashboard: 3, controls: 7 } }));
      await flush();
      failure(net.calls[1]!);
      await flush();
      expect(source.readyState).toBe(2);
      expect(errors).toHaveLength(1);
      expect(opens).toHaveLength(1);
      expect(timer.pending()).toEqual([]);
      expect(net.calls).toHaveLength(2);
    });
  }

  it("errors on a failed baseline too", async () => {
    const { net, source, opens, errors } = setup();
    net.calls[0]!.answer(json({ error: "unavailable" }, 503));
    await flush();
    expect(source.readyState).toBe(2);
    expect(opens).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
  });

  it("close() aborts the request on the wire, without an error or another request", async () => {
    const { net, source, messages, errors } = setup();
    net.calls[0]!.answer(json({ versions: { dashboard: 3, controls: 7 } }));
    await flush();
    const inFlight = net.calls[1]!;
    source.close();
    expect(source.readyState).toBe(2);
    expect(inFlight.signal?.aborted).toBe(true);
    await flush();
    expect(errors).toEqual([]);
    expect(messages).toEqual([]);
    expect(net.calls).toHaveLength(2);
  });

  it("refreshes on a baseline the server held: a push landed after the page's reads", async () => {
    const { net, opens, messages, advance } = setup();
    advance(10_000);
    net.calls[0]!.answer(json({ versions: { dashboard: 1, controls: null } }));
    await flush();
    expect(opens).toHaveLength(1);
    expect(messages).toEqual([{ key: "dashboard", version: 1 }]);
    expect(sinceOf(net.calls[1]!.url)).toEqual({ dashboard: 1, controls: null });
  });

  it("refreshes nothing on a baseline answered at once", async () => {
    const { net, opens, messages } = setup();
    net.calls[0]!.answer(json({ versions: { dashboard: 1, controls: 2 } }));
    await flush();
    expect(opens).toHaveLength(1);
    expect(messages).toEqual([]);
  });

  it("waits before asking again when a fast answer moved nothing", async () => {
    const { net, timer, source, errors } = setup();
    net.calls[0]!.answer(json({ versions: { dashboard: 3, controls: 7 } }));
    await flush();
    net.calls[1]!.answer(json({ versions: { dashboard: 3, controls: 7 } }));
    await flush();
    expect(net.calls).toHaveLength(2);
    expect(timer.pending()).toEqual([FAST_ANSWER_MS]);
    timer.fire();
    expect(net.calls).toHaveLength(3);
    expect(sinceOf(net.calls[2]!.url)).toEqual({ dashboard: 3, controls: 7 });
    // A close during the wait cancels it.
    net.calls[2]!.answer(json({ versions: { dashboard: 3, controls: 7 } }));
    await flush();
    expect(timer.pending()).toEqual([FAST_ANSWER_MS]);
    source.close();
    expect(timer.pending()).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/** A clock whose timers fire only when the test advances it. */
function fakeClock() {
  let now = Date.parse("2026-11-05T12:00:00.000Z");
  let nextId = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const clock: ReadClock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return { clock, pending: () => [...timers.values()].map((timer) => timer.due - now) };
}

describe("versionWaitSource bound through bindLiveStream", () => {
  it("refreshes a moved key's read, and falls back to the read's own poll when the wait fails", async () => {
    const READ = "/api/p/loggd/loops";
    const clock = fakeClock();
    const reads = fakeFetch();
    const store = createQueryReads({ fetch: reads.fetch, clock: clock.clock });
    store.subscribe(READ, 5_000, () => {});
    reads.calls[0]!.answer(json({ n: 0 }));
    await flush();
    reads.calls.splice(0);

    const waits = fakeFetch();
    const timer = fakeTimer();
    const reopen = fakeTimer();
    const live = bindLiveStream({
      store,
      url: URL_,
      reads: { dashboard: READ },
      slowMs: 60_000,
      setTimeout: reopen.setTimeout,
      clearTimeout: reopen.clearTimeout,
      openSource: () =>
        versionWaitSource({
          url: URL_,
          keys: () => ["dashboard"],
          fetch: waits.fetch,
          setTimeout: timer.setTimeout,
          clearTimeout: timer.clearTimeout,
          now: () => 0,
        }),
    });
    expect(live.status()).toBe("connecting");
    waits.calls[0]!.answer(json({ versions: { dashboard: 1 } }));
    await flush();
    expect(live.status()).toBe("live");
    expect(clock.pending()).toEqual([60_000]);
    expect(reads.calls).toHaveLength(0);

    waits.calls[1]!.answer(json({ versions: { dashboard: 2 } }));
    await flush();
    expect(reads.calls.map((call) => call.url)).toEqual([READ]);
    reads.calls[0]!.answer(json({ n: 1 }));
    await flush();
    reads.calls.splice(0);

    waits.calls[2]!.answer(json({ error: "boom" }, 500));
    await flush();
    expect(live.status()).toBe("fallback");
    expect(clock.pending()).toEqual([5_000]);
    // A closed source is re-opened later, with backoff.
    expect(reopen.pending()).toEqual([5_000]);
    expect(waits.calls).toHaveLength(3);
    reopen.fire();
    expect(waits.calls).toHaveLength(4);
    expect(sinceOf(waits.calls[3]!.url)).toEqual({ dashboard: null });
    live.close();
  });
});
