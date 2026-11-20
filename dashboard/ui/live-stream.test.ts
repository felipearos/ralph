// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bindLiveStream, type LiveSource } from "./live-stream";
import { createQueryReads, type ReadClock } from "./query-reads";

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
  return {
    clock,
    pending: () => [...timers.values()].map((timer) => timer.due - now),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].due;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** A fetch whose every request waits until the test answers it. */
function fakeFetch() {
  const calls: { url: string; answer(response: Response): void }[] = [];
  const fetch = (url: string) => new Promise<Response>((resolve) => calls.push({ url, answer: resolve }));
  return { fetch, calls };
}

/** An EventSource the test drives by hand. */
class FakeSource implements LiveSource {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 0;
  closed = false;
  private readonly unavailable: ((event: unknown) => void)[] = [];
  addEventListener(_type: "unavailable", listener: (event: unknown) => void): void {
    this.unavailable.push(listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  error(): void {
    this.readyState = 0;
    this.onerror?.({});
  }
  /** A non-stream answer (a 503): the browser closes the source for good. */
  refused(): void {
    this.readyState = 2;
    this.onerror?.({});
  }
  unavailableEvent(): void {
    for (const listener of this.unavailable) listener({ data: '{"reason":"not relayed"}' });
  }
}

const READ = "/api/p/loggd/loops";
const STREAM = "/api/p/loggd/stream";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The re-open timer, apart from the store's clock so its polls stay pinned on their own. */
function fakeReopenTimer() {
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
    /** The waits pending, in ms. */
    pending: () => [...timers.values()].map((timer) => timer.ms),
    /** Fires every pending timer. */
    fire() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
  };
}

/** The store reading the dashboard at five seconds, the stream bound over it. */
async function setup(options: { refreshOnFirstOpen?: boolean } = {}) {
  const clock = fakeClock();
  const net = fakeFetch();
  const store = createQueryReads({ fetch: net.fetch, clock: clock.clock });
  store.subscribe(READ, 5_000, () => {});
  net.calls[0]!.answer(json({ n: 0 }));
  await flush();
  const sources: { url: string; source: FakeSource }[] = [];
  const reopen = fakeReopenTimer();
  const live = bindLiveStream({
    store,
    url: STREAM,
    reads: { dashboard: READ },
    slowMs: 60_000,
    setTimeout: reopen.setTimeout,
    clearTimeout: reopen.clearTimeout,
    ...options,
    openSource: (url) => {
      const source = new FakeSource();
      sources.push({ url, source });
      return source;
    },
  });
  const source = sources[0]!.source;
  /** Answers every read on the wire, so the next poll is armed. */
  const settle = async () => {
    for (const call of net.calls.splice(0)) call.answer(json({ n: 1 }));
    await flush();
  };
  net.calls.splice(0);
  return { clock, net, store, live, source, sources, settle, reopen };
}

describe("bindLiveStream", () => {
  it("opens the stream URL, connecting until it opens, then slows the read's poll", async () => {
    const { clock, net, live, source, sources } = await setup();
    expect(sources.map((entry) => entry.url)).toEqual([STREAM]);
    expect(live.status()).toBe("connecting");
    expect(clock.pending()).toEqual([5_000]);

    let heard = 0;
    live.subscribe(() => heard++);
    source.open();
    expect(live.status()).toBe("live");
    expect(heard).toBe(1);
    // A healthy stream leaves the poll only as a fallback.
    expect(clock.pending()).toEqual([60_000]);
    clock.advance(59_999);
    expect(net.calls).toHaveLength(0);
    clock.advance(1);
    expect(net.calls.map((call) => call.url)).toEqual([READ]);
  });

  it("refreshes the named read at once on an event", async () => {
    const { net, source, settle } = await setup();
    source.open();
    source.message('{"key":"dashboard","version":1}');
    expect(net.calls.map((call) => call.url)).toEqual([READ]);
    await settle();
    source.message('{"key":"dashboard","version":2}');
    expect(net.calls.map((call) => call.url)).toEqual([READ]);
  });

  it("ignores garbage and keys it does not map", async () => {
    const { net, live, source } = await setup();
    source.open();
    for (const data of ["not json", "null", "[]", '{"key":"dashboard"}', '{"key":"controls","version":1}', 42, '{"key":"toString","version":1}']) {
      expect(() => source.message(data)).not.toThrow();
    }
    expect(net.calls).toHaveLength(0);
    expect(live.status()).toBe("live");
  });

  it("falls back to the five-second poll on an error, and comes back live with one refresh on a re-open", async () => {
    const { clock, net, live, source, settle } = await setup();
    source.open();
    clock.advance(1_000);
    source.error();
    expect(live.status()).toBe("fallback");
    // Back to five seconds from the last settled read.
    expect(clock.pending()).toEqual([4_000]);
    clock.advance(4_000);
    expect(net.calls).toHaveLength(1);
    await settle();
    expect(clock.pending()).toEqual([5_000]);

    // EventSource reconnects by itself; the changes missed meanwhile are read once.
    source.open();
    expect(live.status()).toBe("live");
    expect(net.calls.map((call) => call.url)).toEqual([READ]);
    await settle();
    expect(clock.pending()).toEqual([60_000]);
    expect(source.closed).toBe(false);
  });

  it("closes the source for good on `unavailable` and stays on the poll", async () => {
    const { clock, live, source, sources, reopen } = await setup();
    source.open();
    source.unavailableEvent();
    expect(source.closed).toBe(true);
    expect(live.status()).toBe("fallback");
    expect(clock.pending()).toEqual([5_000]);
    // Even the CLOSED error a finished response raises does not reopen it.
    source.refused();
    expect(reopen.pending()).toEqual([]);
    expect(sources).toHaveLength(1);
  });

  it("re-opens a source the browser closed after a bad answer, backing off from 5 s and resetting on open", async () => {
    const { live, sources, reopen } = await setup();
    sources[0]!.source.refused();
    expect(live.status()).toBe("fallback");
    expect(reopen.pending()).toEqual([5_000]);
    reopen.fire();
    expect(sources).toHaveLength(2);

    sources[1]!.source.refused();
    expect(reopen.pending()).toEqual([10_000]);
    reopen.fire();
    sources[2]!.source.refused();
    expect(reopen.pending()).toEqual([20_000]);
    reopen.fire();

    // An open resets the backoff, and the replaced sources' late events do nothing.
    sources[3]!.source.open();
    expect(live.status()).toBe("live");
    sources[0]!.source.refused();
    expect(reopen.pending()).toEqual([]);
    sources[3]!.source.refused();
    expect(reopen.pending()).toEqual([5_000]);
  });

  it("caps the backoff at a minute", async () => {
    const { sources, reopen } = await setup();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      sources.at(-1)!.source.refused();
      waits.push(...reopen.pending());
      reopen.fire();
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it("leaves a plain error to the browser's own reconnect", async () => {
    const { sources, reopen } = await setup();
    sources[0]!.source.error();
    expect(reopen.pending()).toEqual([]);
  });

  it("cancels a pending re-open on close", async () => {
    const { live, sources, reopen } = await setup();
    sources[0]!.source.refused();
    expect(reopen.pending()).toEqual([5_000]);
    live.close();
    expect(reopen.pending()).toEqual([]);
    expect(sources).toHaveLength(1);
  });

  it("refreshes on the first open when asked, for a binding made again after a gap", async () => {
    const { net, source } = await setup({ refreshOnFirstOpen: true });
    source.open();
    expect(net.calls.map((call) => call.url)).toEqual([READ]);
  });

  it("does not refresh on the first open by default", async () => {
    const { net, source } = await setup();
    source.open();
    expect(net.calls).toHaveLength(0);
  });

  it("closes the source and restores the poll on close", async () => {
    const { clock, live, source } = await setup();
    source.open();
    expect(clock.pending()).toEqual([60_000]);
    live.close();
    expect(source.closed).toBe(true);
    expect(clock.pending()).toEqual([5_000]);
    // A late event from a closed binding does nothing.
    source.message('{"key":"dashboard","version":3}');
    source.open();
    expect(clock.pending()).toEqual([5_000]);
  });

  it("falls back when the source cannot be opened at all", () => {
    const clock = fakeClock();
    const net = fakeFetch();
    const store = createQueryReads({ fetch: net.fetch, clock: clock.clock });
    const live = bindLiveStream({
      store,
      url: STREAM,
      reads: { dashboard: READ },
      slowMs: 60_000,
      openSource: () => {
        throw new Error("no EventSource");
      },
    });
    expect(live.status()).toBe("fallback");
  });
});

/** The multi-read map the page builds (#729), every read subscribed at its own interval. */
const P = "/api/p/loggd";
const CONTROLS = `${P}/api/controls`;
const PROJECT_NOTES = `${P}/api/notifications`;
const AGENTS = `${P}/api/agents`;
const HEALTH = "/api/projects/health?selected=loggd";
const control = (loop: string) => `${P}/api/loops/${loop}/control`;
const notes = (loop: string) => `${P}/api/loops/${loop}/notifications`;
const history = (loop: string) => `${P}/api/loops/${loop}/history`;

function mapFor(loops: readonly string[]): Record<string, string | readonly string[]> {
  const reads: Record<string, string | readonly string[]> = {
    dashboard: READ,
    controls: CONTROLS,
    notifications: [PROJECT_NOTES, ...loops.map(notes)],
    agents: AGENTS,
    "_/health": HEALTH,
  };
  for (const loop of loops) {
    reads[`control/${loop}`] = control(loop);
    reads[`history/${loop}`] = history(loop);
  }
  return reads;
}

/** Each URL's own interval: distinct, so the pending timers say which read is which. */
const OWN: Record<string, number> = {
  [READ]: 5_000,
  [CONTROLS]: 5_001,
  [PROJECT_NOTES]: 5_002,
  [AGENTS]: 5_003,
  [HEALTH]: 5_004,
  [control("ralph")]: 5_005,
  [notes("ralph")]: 5_006,
  [history("ralph")]: 5_007,
  [control("rafa")]: 5_008,
  [notes("rafa")]: 5_009,
  [history("rafa")]: 5_010,
};

async function setupMany(loops: readonly string[]) {
  const clock = fakeClock();
  const net = fakeFetch();
  const store = createQueryReads({ fetch: net.fetch, clock: clock.clock });
  for (const [url, ms] of Object.entries(OWN)) store.subscribe(url, ms, () => {});
  for (const call of net.calls.splice(0)) call.answer(json({ n: 0 }));
  await flush();
  const sources: FakeSource[] = [];
  const live = bindLiveStream({
    store,
    url: STREAM,
    reads: mapFor(loops),
    slowMs: 60_000,
    setTimeout: () => 0,
    clearTimeout: () => {},
    openSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  });
  const settle = async () => {
    for (const call of net.calls.splice(0)) call.answer(json({ n: 1 }));
    await flush();
  };
  const urls = () => net.calls.map((call) => call.url).sort();
  /** Pending waits, sorted: a slowed read shows 60 000, a normal one its own interval. */
  const pending = () => clock.pending().sort((a, b) => a - b);
  return { clock, net, store, live, source: sources[0]!, sources, settle, urls, pending };
}

const own = (urls: readonly string[]) => urls.map((url) => OWN[url]!).sort((a, b) => a - b);
const ALL_RALPH = [READ, CONTROLS, PROJECT_NOTES, AGENTS, HEALTH, control("ralph"), notes("ralph"), history("ralph")];
const RAFA = [control("rafa"), notes("rafa"), history("rafa")];

describe("bindLiveStream over several reads (#729)", () => {
  it("refreshes exactly the URLs each key maps, and nothing for an unmapped key", async () => {
    const { source, settle, urls } = await setupMany(["ralph"]);
    source.open();
    const cases: [string, string[]][] = [
      ["dashboard", [READ]],
      ["controls", [CONTROLS]],
      ["control/ralph", [control("ralph")]],
      ["notifications", [PROJECT_NOTES, notes("ralph")].sort()],
      ["history/ralph", [history("ralph")]],
      ["agents", [AGENTS]],
      ["_/health", [HEALTH]],
      ["control/rafa", []],
      ["history/nobody", []],
      ["sentinel", []],
    ];
    for (const [key, expected] of cases) {
      source.message(JSON.stringify({ key, version: 1 }));
      expect(urls(), key).toEqual(expected);
      await settle();
    }
  });

  it("slows every mapped read while live and gives each its own interval back after an error", async () => {
    const { source, pending, live } = await setupMany(["ralph", "rafa"]);
    source.open();
    expect(live.status()).toBe("live");
    expect(pending()).toEqual(Array(ALL_RALPH.length + RAFA.length).fill(60_000));
    source.error();
    expect(live.status()).toBe("fallback");
    expect(pending()).toEqual(own([...ALL_RALPH, ...RAFA]));
  });

  it("setReads follows the roster: an arriving loop goes slow and refreshes, a leaving one gets its interval back", async () => {
    const { source, pending, live, urls, settle } = await setupMany(["ralph"]);
    source.open();
    // rafa's reads are not mapped yet: they keep their own interval.
    expect(pending()).toEqual([...own(RAFA), ...Array(ALL_RALPH.length).fill(60_000)]);

    live.setReads(mapFor(["ralph", "rafa"]));
    expect(pending()).toEqual(Array(ALL_RALPH.length + RAFA.length).fill(60_000));
    source.message('{"key":"history/rafa","version":1}');
    expect(urls()).toEqual([history("rafa")]);
    await settle();
    source.message('{"key":"notifications","version":2}');
    expect(urls()).toEqual([PROJECT_NOTES, notes("rafa"), notes("ralph")].sort());
    await settle();

    live.setReads(mapFor(["rafa"]));
    const ralphOnly = [control("ralph"), notes("ralph"), history("ralph")];
    expect(pending()).toEqual([...own(ralphOnly), ...Array(ALL_RALPH.length).fill(60_000)]);
    source.message('{"key":"control/ralph","version":3}');
    source.message('{"key":"notifications","version":3}');
    expect(urls()).toEqual([PROJECT_NOTES, notes("rafa")].sort());
    expect(source.closed).toBe(false);
  });

  it("does not slow an arriving URL while the stream is not live", async () => {
    const { source, pending, live } = await setupMany([]);
    live.setReads(mapFor(["rafa"]));
    expect(pending()).toEqual(own([READ, CONTROLS, PROJECT_NOTES, AGENTS, HEALTH, control("ralph"), notes("ralph"), history("ralph"), ...RAFA]));
    // Opening then slows the current set, rafa's reads included.
    source.open();
    expect(pending()).toEqual([...own([control("ralph"), notes("ralph"), history("ralph")]), ...Array(5 + RAFA.length).fill(60_000)]);
  });

  it("re-opens with one refresh of every current URL, and close restores every current URL", async () => {
    const { source, pending, live, urls, settle } = await setupMany(["ralph"]);
    source.open();
    live.setReads(mapFor(["rafa"]));
    source.error();
    source.open();
    expect(urls()).toEqual([READ, CONTROLS, PROJECT_NOTES, AGENTS, HEALTH, ...RAFA].sort());
    await settle();
    live.close();
    expect(pending()).toEqual(own([...ALL_RALPH, ...RAFA]));
  });
});
