// @vitest-environment node
// The Query-backed read layer (#727): the rules the hand-written read store
// pinned since #603, ported case for case when that store was deleted (#738),
// plus keep-alive and prefetch, which replace its forget-on-last-unsubscribe.
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindRead, bindReads, createQueryReads, KEEP_ALIVE_MS, type ReadClock, type ReadVisibility } from "./query-reads";
import {
  agentsRead,
  bridgeStatusRead,
  intakeMetricsRead,
  intakeRead,
  intakeSessionRead,
  labelsRead,
  loopHistoryRead,
  loopNotificationsRead,
  notificationsRead,
  projectSetupRead,
  projectSleepRead,
  projectsHealthRead,
  projectsRead,
  type ReadTarget,
  sentinelRead,
  usageRead,
} from "./reads";

const START = Date.parse("2026-11-03T12:00:00.000Z");

/** A clock whose timers fire only when the test advances it. */
function fakeClock() {
  let now = START;
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

/** A page visibility the test flips; `hide`/`show` fire the listeners as the browser's event would. */
function fakeVisibility(startHidden = false) {
  let hidden = startHidden;
  const listeners = new Set<() => void>();
  const visibility: ReadVisibility = {
    hidden: () => hidden,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (next: boolean) => {
    hidden = next;
    for (const listener of listeners) listener();
  };
  return {
    visibility,
    hide: () => set(true),
    show: () => set(false),
    /** The page is hidden but the store has not heard yet: another listener on the same event ran first. */
    hideUnheard: () => {
      hidden = true;
    },
    listeners,
  };
}

interface Call {
  url: string;
  init: RequestInit;
  answer(response: Response): void;
  fail(error: unknown): void;
}

/** A fetch whose every request waits until the test answers it. */
function fakeFetch() {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, answer: resolve, fail: reject });
    });
  /** The nth request, failing loudly when the store never made it. */
  const call = (index: number): Call => {
    const found = calls[index];
    if (found === undefined) throw new Error(`no request #${index}; saw ${calls.length}`);
    return found;
  };
  return { fetch, calls, call };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });

/** Let the settled fetch, its body read, Query's retryer and the layer's bookkeeping run. */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function setup() {
  const clock = fakeClock();
  const net = fakeFetch();
  const store = createQueryReads({ fetch: net.fetch, clock: clock.clock });
  return { clock, net, store };
}

describe("the query reads", () => {
  it("reads at once on first subscribe and settles ready", async () => {
    const { net, store } = setup();
    let heard = 0;
    expect(store.get("/api/a")).toEqual({ state: "loading" });
    store.subscribe("/api/a", 5_000, () => heard++);
    expect(net.calls).toHaveLength(1);
    expect(net.call(0).url).toBe("/api/a");
    expect(net.call(0).init).toEqual({ cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "ready", data: { n: 1 }, at: new Date(START), snapshotAt: null });
    expect(heard).toBe(1);
  });

  it("keeps the last data on an error, with the status and the server's message", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();

    clock.advance(1_000);
    net.call(1).answer(json({ message: "adapter down", error: "ignored" }, { status: 503 }));
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "error", message: "adapter down", status: 503, data: { n: 1 } });

    clock.advance(1_000);
    net.call(2).answer(json({ error: "not set up" }, { status: 409 }));
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "error", message: "not set up", status: 409, data: { n: 1 } });

    clock.advance(1_000);
    net.call(3).answer(new Response("<html>bad gateway</html>", { status: 502 }));
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "error", message: "HTTP 502", status: 502, data: { n: 1 } });

    clock.advance(1_000);
    net.call(4).fail(new TypeError("network down"));
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "error", message: "network down", status: null, data: { n: 1 } });

    clock.advance(1_000);
    net.call(5).fail("plain string");
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "error", message: "plain string", status: null, data: { n: 1 } });
  });

  it("errors with null data when nothing was ever read", async () => {
    const { net, store } = setup();
    store.subscribe("/api/a", null, () => {});
    net.call(0).answer(json({}, { status: 500 }));
    await flush();
    expect(store.get("/api/a")).toEqual({ state: "error", message: "HTTP 500", status: 500, data: null });
  });

  it("never overlaps a slow read with the next one", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", 1_000, () => {});
    clock.advance(60_000);
    expect(net.calls).toHaveLength(1);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    // The next read is scheduled from the settle, not from the start.
    expect(clock.pending()).toEqual([1_000]);
    clock.advance(999);
    expect(net.calls).toHaveLength(1);
    clock.advance(1);
    expect(net.calls).toHaveLength(2);
  });

  it("shares one request between two subscribers and returns the same object", async () => {
    const { net, store } = setup();
    let first = 0;
    let second = 0;
    store.subscribe("/api/a", 5_000, () => first++);
    store.subscribe("/api/a", 5_000, () => second++);
    expect(net.calls).toHaveLength(1);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(store.get("/api/a")).toBe(store.get("/api/a"));
    expect(store.get("/never")).toBe(store.get("/never"));
  });

  it("polls at the shortest interval and recedes when its subscriber leaves", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", 10_000, () => {});
    const leave = store.subscribe("/api/a", 2_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([2_000]);

    // The pending timer keeps its shorter delay and fires once as scheduled.
    leave();
    expect(clock.pending()).toEqual([2_000]);
    clock.advance(2_000);
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([10_000]);
  });

  it("stops polling on the last unsubscribe, and a late answer lands without arming a poll", async () => {
    const { clock, net, store } = setup();
    let heard = 0;
    const leave = store.subscribe("/api/a", 1_000, () => heard++);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(1_000);
    expect(net.calls).toHaveLength(2);

    leave();
    expect(store.inFlight("/api/a")).toBe(false);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    // The first publish, and the poll's start; the leaver hears nothing more.
    expect(heard).toBe(2);
    // The late answer is the newest data: it is kept for a returning reader.
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
    clock.advance(60_000);
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([]);
  });

  it("drops a queued refresh when the last subscriber leaves", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 1_000, () => {});
    store.refresh("/api/a");
    leave();
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
  });

  it("queues exactly one more read for refreshes during a read", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", 10_000, () => {});
    store.refresh("/api/a");
    store.refresh("/api/a");
    store.refresh("/api/a");
    expect(net.calls).toHaveLength(1);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([]);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([10_000]);
  });

  it("refreshes an idle entry now, keeping its data, and reschedules after", async () => {
    const { clock, net, store } = setup();
    const states: string[] = [];
    store.subscribe("/api/a", 10_000, () => states.push(store.get("/api/a").state));
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(4_000);

    store.refresh("/api/a");
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([]);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    net.call(1).answer(json({ n: 2 }));
    await flush();
    // The refresh's start is heard (still ready, data kept), then its answer.
    expect(states).toEqual(["ready", "ready", "ready"]);
    expect(store.get("/api/a")).toEqual({ state: "ready", data: { n: 2 }, at: new Date(START + 4_000), snapshotAt: null });
    expect(clock.pending()).toEqual([10_000]);
  });

  it("ignores a refresh for a URL nobody reads", () => {
    const { net, store } = setup();
    store.refresh("/api/a");
    expect(net.calls).toHaveLength(0);
  });

  it("takes snapshotAt from the x-ralph-snapshot-at header", async () => {
    const { net, store } = setup();
    store.subscribe("/api/a", null, () => {});
    store.subscribe("/api/b", null, () => {});
    net.call(0).answer(json({ n: 1 }, { headers: { "x-ralph-snapshot-at": "2026-11-03T11:59:30.000Z" } }));
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", snapshotAt: new Date("2026-11-03T11:59:30.000Z") });
    expect(store.get("/api/b")).toMatchObject({ state: "ready", snapshotAt: null });
  });

  it("reads a one-shot URL once, and again only on refresh", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", null, () => {});
    store.subscribe("/api/a", null, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(3_600_000);
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);

    store.refresh("/api/a");
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    clock.advance(3_600_000);
    expect(net.calls).toHaveLength(2);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
  });

  it("keeps telling the other listeners when one throws", async () => {
    const { net, store } = setup();
    let heard = 0;
    store.subscribe("/api/a", null, () => {
      throw new Error("broken panel");
    });
    store.subscribe("/api/a", null, () => heard++);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(heard).toBe(1);
  });

  it("keeps one poll chain when a listener refreshes during its own publish", async () => {
    const { clock, net, store } = setup();
    let refreshed = false;
    store.subscribe("/api/a", 1_000, () => {
      if (refreshed) return;
      refreshed = true;
      store.refresh("/api/a");
    });
    net.call(0).answer(json({ n: 1 }));
    await flush();
    // The listener's refresh started the second read; no timer runs beside it.
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([]);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([1_000]);
  });
});

describe("livePoll", () => {
  it("slows the poll while set, and refresh still reads at once", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([5_000]);

    clock.advance(2_000);
    store.livePoll("/api/a", 60_000);
    // Re-armed from now, and slowing down does not read.
    expect(clock.pending()).toEqual([60_000]);
    expect(net.calls).toHaveLength(1);
    clock.advance(59_999);
    expect(net.calls).toHaveLength(1);
    clock.advance(1);
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);

    store.refresh("/api/a");
    expect(net.calls).toHaveLength(3);
    net.call(2).answer(json({ n: 3 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);
  });

  it("restores the subscribers' interval, reading now only when that is already overdue", async () => {
    const { clock, net, store } = setup();
    store.subscribe("/api/a", 5_000, () => {});
    store.livePoll("/api/a", 60_000);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);

    clock.advance(2_000);
    store.livePoll("/api/a", null);
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([3_000]);
    clock.advance(3_000);
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([5_000]);

    store.livePoll("/api/a", 60_000);
    clock.advance(10_000);
    store.livePoll("/api/a", null);
    expect(net.calls).toHaveLength(3);
  });

  it("holds the override for a URL with no subscriber until one arrives, and leaves one-shot reads alone", async () => {
    const { clock, net, store } = setup();
    store.livePoll("/api/a", 60_000);
    expect(net.calls).toHaveLength(0);
    store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);

    store.livePoll("/api/b", 60_000);
    store.subscribe("/api/b", null, () => {});
    net.call(1).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);
  });
});

function hiddenSetup(startHidden = false) {
  const clock = fakeClock();
  const net = fakeFetch();
  const page = fakeVisibility(startHidden);
  const store = createQueryReads({ fetch: net.fetch, clock: clock.clock, visibility: page.visibility });
  return { clock, net, page, store };
}

describe("a hidden page", () => {
  it("subscribes to visibility once, at creation", () => {
    const { page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    store.subscribe("/api/b", 1_000, () => {});
    expect(page.listeners.size).toBe(1);
  });

  it("pauses polling: no timer and no read while hidden", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([1_000]);

    page.hide();
    expect(clock.pending()).toEqual([]);
    clock.advance(60_000);
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
  });

  it("still reads once on the first subscribe while hidden, then nothing more", async () => {
    const { clock, net, store } = hiddenSetup(true);
    store.subscribe("/api/a", 1_000, () => {});
    expect(net.calls).toHaveLength(1);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    expect(clock.pending()).toEqual([]);
    clock.advance(60_000);
    expect(net.calls).toHaveLength(1);
  });

  it("lets a read in flight at hide time settle, without scheduling the next poll", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    page.hide();
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    expect(clock.pending()).toEqual([]);
  });

  it("still reads on an explicit refresh while hidden", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    page.hide();
    store.refresh("/api/a");
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([]);
  });

  it("catches every polling read up at once on show, keeping the data on screen, then resumes polling", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    store.subscribe("/api/b", 5_000, () => {});
    net.call(0).answer(json({ a: 1 }));
    net.call(1).answer(json({ b: 1 }));
    await flush();
    page.hide();
    clock.advance(60_000);
    expect(net.calls).toHaveLength(2);

    page.show();
    expect(net.calls.map((call) => call.url)).toEqual(["/api/a", "/api/b", "/api/a", "/api/b"]);
    // In flight, the old data stays: no flash to a skeleton.
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { a: 1 } });
    expect(store.inFlight("/api/a")).toBe(true);
    expect(clock.pending()).toEqual([]);

    net.call(2).answer(json({ a: 2 }));
    net.call(3).answer(json({ b: 2 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { a: 2 } });
    expect(store.get("/api/b")).toMatchObject({ state: "ready", data: { b: 2 } });
    expect(clock.pending().sort((x, y) => x - y)).toEqual([1_000, 5_000]);
    clock.advance(1_000);
    expect(net.calls).toHaveLength(5);
  });

  it("queues exactly one follow-up for a read in flight at show", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    page.hide();
    page.show();
    expect(net.calls).toHaveLength(1);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(net.calls).toHaveLength(2);
    expect(store.inFlight("/api/a")).toBe(true);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(net.calls).toHaveLength(2);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(clock.pending()).toEqual([1_000]);
  });

  it("does not re-read a one-shot URL on show", async () => {
    const { net, page, store } = hiddenSetup();
    store.subscribe("/api/form", null, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    page.hide();
    page.show();
    expect(net.calls).toHaveLength(1);
  });

  it("issues no read for livePoll(null) while hidden, and catches up at the override's interval", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 5_000, () => {});
    store.livePoll("/api/a", 60_000);
    net.call(0).answer(json({ n: 1 }));
    await flush();

    page.hide();
    clock.advance(10_000);
    // The change stream closes on hide: restoring the interval, though overdue, must not read.
    store.livePoll("/api/a", null);
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);

    // Reopened on show, the stream slows the poll again before the catch-up settles.
    store.livePoll("/api/a", 60_000);
    expect(clock.pending()).toEqual([]);
    page.show();
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);
  });

  it("issues no read for livePoll(null) on hide even before the store hears the event", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 5_000, () => {});
    store.livePoll("/api/a", 60_000);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(10_000);

    // The stream's visibility listener ran first: it closes and restores the interval, overdue by now.
    page.hideUnheard();
    store.livePoll("/api/a", null);
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
  });

  it("treats a repeated hide or show as a no-op", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();

    page.show();
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([1_000]);

    page.hide();
    page.hide();
    expect(clock.pending()).toEqual([]);
    page.show();
    expect(net.calls).toHaveLength(2);
    page.show();
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([1_000]);
  });
});

describe("the in-flight flag", () => {
  it("is false for a URL nobody reads", () => {
    const { store } = setup();
    expect(store.inFlight("/api/a")).toBe(false);
  });

  it("is true while the first read is pending, without calling back inside subscribe", async () => {
    const { net, store } = setup();
    let heard = 0;
    store.subscribe("/api/a", 5_000, () => heard++);
    // React re-reads the snapshot after subscribing; a call here would re-enter it.
    expect(heard).toBe(0);
    expect(store.inFlight("/api/a")).toBe(true);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(store.inFlight("/api/a")).toBe(false);
    expect(heard).toBe(1);
  });

  it("is false after an error settles", async () => {
    const { net, store } = setup();
    store.subscribe("/api/a", null, () => {});
    net.call(0).fail(new TypeError("network down"));
    await flush();
    expect(store.get("/api/a").state).toBe("error");
    expect(store.inFlight("/api/a")).toBe(false);
  });

  it("turns true again on a refresh and on a poll, and listeners hear it at the start", async () => {
    const { clock, net, store } = setup();
    const seen: boolean[] = [];
    store.subscribe("/api/a", 1_000, () => seen.push(store.inFlight("/api/a")));
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(seen).toEqual([false]);

    store.refresh("/api/a");
    expect(store.inFlight("/api/a")).toBe(true);
    expect(seen).toEqual([false, true]);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(seen).toEqual([false, true, false]);

    clock.advance(1_000);
    expect(seen).toEqual([false, true, false, true]);
    expect(net.calls).toHaveLength(3);
  });

  it("announces the queued read that follows a settle", async () => {
    const { net, store } = setup();
    const seen: boolean[] = [];
    store.subscribe("/api/a", null, () => seen.push(store.inFlight("/api/a")));
    store.refresh("/api/a");
    net.call(0).answer(json({ n: 1 }));
    await flush();
    // The publish sees it settled; the queued read's start turns it back on.
    expect(seen).toEqual([false, true]);
    expect(store.inFlight("/api/a")).toBe(true);
    expect(net.calls).toHaveLength(2);
  });

  it("is false once the last subscriber leaves mid-read", () => {
    const { store } = setup();
    const leave = store.subscribe("/api/a", 1_000, () => {});
    expect(store.inFlight("/api/a")).toBe(true);
    leave();
    expect(store.inFlight("/api/a")).toBe(false);
  });

  it("fetches nothing when a listener leaves on hearing the start", async () => {
    const { clock, net, store } = setup();
    let leave = () => {};
    let leaveOnStart = false;
    leave = store.subscribe("/api/a", 1_000, () => {
      if (leaveOnStart) leave();
    });
    net.call(0).answer(json({ n: 1 }));
    await flush();
    leaveOnStart = true;
    clock.advance(1_000);
    expect(net.calls).toHaveLength(1);
    expect(store.inFlight("/api/a")).toBe(false);
    expect(clock.pending()).toEqual([]);
  });
});

describe("bindRead", () => {
  it("never touches the store for a null target", () => {
    let asked = 0;
    const binding = bindRead(() => {
      asked += 1;
      throw new Error("a null target must not reach the store");
    }, null, 5_000);
    const leave = binding.subscribe(() => {});
    binding.refresh();
    leave();
    expect(binding.getSnapshot()).toEqual({ state: "loading" });
    expect(binding.getInFlight()).toBe(false);
    expect(asked).toBe(0);
  });

  it("subscribes, reads and refreshes its URL through the store", async () => {
    const { net, store } = setup();
    const binding = bindRead(() => store, "/api/a", 5_000);
    binding.subscribe(() => {});
    expect(net.calls.map((call) => call.url)).toEqual(["/api/a"]);
    expect(binding.getInFlight()).toBe(true);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(binding.getSnapshot()).toMatchObject({ state: "ready", data: { n: 1 } });
    expect(binding.getInFlight()).toBe(false);
    binding.refresh();
    expect(net.calls).toHaveLength(2);
    expect(binding.getInFlight()).toBe(true);
  });
});

describe("bindReads", () => {
  it("reads several URLs at once, one failing while the others settle, with a stable snapshot", async () => {
    const { clock, net, store } = setup();
    let heard = 0;
    const binding = bindReads<{ n: number }>(() => store, [
      { url: "/api/p/a/loops", intervalMs: 1_000 },
      { url: "/api/p/b/loops", intervalMs: 1_000 },
      { url: "/api/p/c/loops", intervalMs: 1_000 },
    ]);
    const unsubscribe = binding.subscribe(() => heard++);
    expect(net.calls.map((call) => call.url)).toEqual(["/api/p/a/loops", "/api/p/b/loops", "/api/p/c/loops"]);
    const loading = binding.getSnapshot();
    expect(loading).toEqual([{ state: "loading" }, { state: "loading" }, { state: "loading" }]);
    expect(binding.getSnapshot()).toBe(loading);

    net.call(0).answer(json({ n: 1 }));
    net.call(1).fail(new TypeError("network down"));
    net.call(2).answer(json({ n: 3 }));
    await flush();
    const first = binding.getSnapshot();
    expect(first).not.toBe(loading);
    expect(first).toMatchObject([
      { state: "ready", data: { n: 1 } },
      { state: "error", message: "network down", data: null },
      { state: "ready", data: { n: 3 } },
    ]);
    expect(binding.getSnapshot()).toBe(first);
    expect(heard).toBe(3);

    // The next poll: b recovers, then a fails and keeps its data. The polls
    // start in settle order, so pick each by its URL.
    clock.advance(1_000);
    expect(net.calls).toHaveLength(6);
    const poll = (url: string) => {
      const found = net.calls.slice(3).find((call) => call.url === url);
      if (found === undefined) throw new Error(`no poll of ${url}`);
      return found;
    };
    poll("/api/p/b/loops").answer(json({ n: 2 }));
    await flush();
    const second = binding.getSnapshot();
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(binding.getSnapshot()).toBe(second);

    poll("/api/p/a/loops").answer(json({ message: "adapter down" }, { status: 503 }));
    poll("/api/p/c/loops").answer(json({ n: 3 }));
    await flush();
    expect(binding.getSnapshot()).toMatchObject([
      { state: "error", message: "adapter down", status: 503, data: { n: 1 } },
      { state: "ready", data: { n: 2 } },
      { state: "ready", data: { n: 3 } },
    ]);

    unsubscribe();
    clock.advance(60_000);
    expect(net.calls).toHaveLength(6);
    expect(clock.pending()).toEqual([]);
  });

  it("subscribes to nothing for no targets, and returns one shared empty snapshot", () => {
    const { net, store } = setup();
    const binding = bindReads(() => store, []);
    binding.subscribe(() => {})();
    binding.refresh();
    expect(net.calls).toHaveLength(0);
    expect(binding.getSnapshot()).toEqual([]);
    expect(binding.getSnapshot()).toBe(bindReads(() => store, []).getSnapshot());
  });

  it("reads a one-shot target once on subscribe, never on the clock, and again on refresh", async () => {
    const { clock, net, store } = setup();
    const single = bindRead<{ n: number }>(() => store, "/api/jav", null);
    const many = bindReads<{ n: number }>(() => store, [{ url: "/api/agents/guide", intervalMs: null }]);
    single.subscribe(() => {});
    many.subscribe(() => {});
    expect(net.calls.map((call) => call.url)).toEqual(["/api/jav", "/api/agents/guide"]);
    net.call(0).answer(json({ n: 1 }));
    net.call(1).answer(json({ n: 1 }));
    await flush();
    clock.advance(3_600_000);
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([]);

    single.refresh();
    many.refresh();
    expect(net.calls.map((call) => call.url).slice(2)).toEqual(["/api/jav", "/api/agents/guide"]);
    net.call(2).answer(json({ n: 2 }));
    net.call(3).answer(json({ n: 2 }));
    await flush();
    clock.advance(3_600_000);
    expect(net.calls).toHaveLength(4);
    expect(single.getSnapshot()).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(many.getSnapshot()).toMatchObject([{ state: "ready", data: { n: 2 } }]);
  });
});

describe("keep-alive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the cached read at once to a subscriber back within KEEP_ALIVE_MS, and reads fresh", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    const cached = store.get("/api/a");
    leave();
    expect(store.get("/api/a")).toBe(cached);

    clock.advance(KEEP_ALIVE_MS - 1);
    const states: string[] = [];
    store.subscribe("/api/a", 1_000, () => states.push(store.get("/api/a").state));
    expect(store.get("/api/a")).toBe(cached);
    expect(net.calls).toHaveLength(2);
    expect(store.inFlight("/api/a")).toBe(true);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(states).toEqual(["ready"]);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(clock.pending()).toEqual([1_000]);
  });

  it("keeps an error with its data for a returning subscriber", async () => {
    const { net, store } = setup();
    const leave = store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    store.refresh("/api/a");
    net.call(1).answer(json({ message: "adapter down" }, { status: 503 }));
    await flush();
    leave();
    store.subscribe("/api/a", 1_000, () => {});
    expect(store.get("/api/a")).toEqual({ state: "error", message: "adapter down", status: 503, data: { n: 1 } });
    expect(net.calls).toHaveLength(3);
  });

  it("opens a returning one-shot reader on loading, never on the cache, so a form seeds only from its own read (#734)", async () => {
    const { net, store } = setup();
    const leave = store.subscribe("/api/a", null, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    leave();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });

    store.subscribe("/api/a", null, () => {});
    expect(store.get("/api/a")).toEqual({ state: "loading" });
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ message: "adapter down" }, { status: 503 }));
    await flush();
    // The dropped cache is gone for the error too: no stale data behind it.
    expect(store.get("/api/a")).toEqual({ state: "error", message: "adapter down", status: 503, data: null });
  });

  it("joins a read the last subscriber left in flight, and polls after it settles", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(1_000);
    leave();

    store.subscribe("/api/a", 1_000, () => {});
    expect(net.calls).toHaveLength(2);
    expect(store.inFlight("/api/a")).toBe(true);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(clock.pending()).toEqual([1_000]);
  });

  it("forgets the read KEEP_ALIVE_MS after the last subscriber leaves, so a remount starts from loading", async () => {
    vi.useFakeTimers();
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 1_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    leave();

    vi.advanceTimersByTime(KEEP_ALIVE_MS - 1);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    vi.advanceTimersByTime(1);
    expect(store.get("/api/a")).toEqual({ state: "loading" });
    expect(store.client.getQueryData(["/api/a"])).toBeUndefined();

    store.subscribe("/api/a", 1_000, () => {});
    expect(store.get("/api/a")).toEqual({ state: "loading" });
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(clock.pending()).toEqual([1_000]);
  });

  it("never forgets a URL somebody reads, however slow its poll", async () => {
    vi.useFakeTimers();
    const { clock, net, store } = setup();
    store.subscribe("/api/a", KEEP_ALIVE_MS, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    clock.advance(KEEP_ALIVE_MS);
    expect(net.calls).toHaveLength(2);
  });

  it("gives every layer its own QueryClient, keyed by URL", async () => {
    const { net, store } = setup();
    expect(setup().store.client).not.toBe(store.client);
    store.subscribe("/api/a", null, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(store.client.getQueryData(["/api/a"])).toMatchObject({ data: { n: 1 } });
  });
});

describe("prefetch", () => {
  it("reads once ahead of a reader, and arms no poll", async () => {
    const { clock, net, store } = setup();
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(1);
    expect(net.call(0).init).toEqual({ cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    expect(clock.pending()).toEqual([]);
    clock.advance(3_600_000);
    expect(net.calls).toHaveLength(1);
  });

  it("reads nothing while the cached data is fresher than KEEP_ALIVE_MS", async () => {
    const { clock, net, store } = setup();
    store.prefetch("/api/a");
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(KEEP_ALIVE_MS - 1);
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(1);
    clock.advance(1);
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(2);
  });

  it("reads nothing extra while a read is in flight", async () => {
    const { net, store } = setup();
    store.subscribe("/api/a", 1_000, () => {});
    store.prefetch("/api/a");
    store.prefetch("/b");
    store.prefetch("/b");
    expect(net.calls.map((call) => call.url)).toEqual(["/api/a", "/b"]);
  });

  it("is joined by a subscriber arriving while it is on the wire, which then polls", async () => {
    const { clock, net, store } = setup();
    store.prefetch("/api/a");
    let heard = 0;
    store.subscribe("/api/a", 1_000, () => heard++);
    expect(net.calls).toHaveLength(1);
    expect(store.inFlight("/api/a")).toBe(true);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(heard).toBe(1);
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
    expect(clock.pending()).toEqual([1_000]);
    clock.advance(1_000);
    expect(net.calls).toHaveLength(2);
  });

  it("on a read with subscribers replaces the pending poll, and its settle re-arms one chain", async () => {
    const { clock, net, store } = setup();
    const seen: boolean[] = [];
    store.subscribe("/api/a", 100_000, () => seen.push(store.inFlight("/api/a")));
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(KEEP_ALIVE_MS);
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(2);
    expect(seen).toEqual([false, true]);
    expect(clock.pending()).toEqual([]);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([100_000]);
  });

  it("still reads while the page is hidden: it is the operator's hover", () => {
    const { net, store } = hiddenSetup(true);
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(1);
  });
});

describe("a fresh read on a cold load (#68)", () => {
  it("does not re-read a settled prefetch for a polling subscriber within its interval, and polls on the remainder", async () => {
    const { clock, net, store } = setup();
    store.prefetch("/api/a");
    net.call(0).answer(json({ n: 1 }));
    await flush();
    clock.advance(600);
    const cached = store.get("/api/a");
    store.subscribe("/api/a", 5_000, () => {});
    expect(net.calls).toHaveLength(1);
    expect(store.get("/api/a")).toBe(cached);
    expect(store.inFlight("/api/a")).toBe(false);
    expect(clock.pending()).toEqual([4_400]);
    clock.advance(4_399);
    expect(net.calls).toHaveLength(1);
    clock.advance(1);
    expect(net.calls).toHaveLength(2);
  });

  it("does not re-read for a panel remounted within its interval (a redirect), and shows the cache at once", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    const cached = store.get("/api/a");
    clock.advance(50);
    leave();
    store.subscribe("/api/a", 5_000, () => {});
    expect(store.get("/api/a")).toBe(cached);
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([4_950]);
    clock.advance(4_950);
    expect(net.calls).toHaveLength(2);
  });

  it("reads at once for a subscriber after a refresh nobody heard, though the data is within its interval", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    leave();
    store.refresh("/api/a");
    expect(net.calls).toHaveLength(1);
    clock.advance(100);
    store.subscribe("/api/a", 5_000, () => {});
    expect(net.calls).toHaveLength(2);
    expect(store.inFlight("/api/a")).toBe(true);
  });

  it("reads at once for a subscriber after a refresh nobody heard while a read was on the wire", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 5_000, () => {});
    leave();
    // The change lands after the read started: its answer may predate it.
    store.refresh("/api/a");
    expect(net.calls).toHaveLength(1);
    net.call(0).answer(json({ n: 1 }));
    await flush();
    expect(clock.pending()).toEqual([]);
    clock.advance(100);
    store.subscribe("/api/a", 5_000, () => {});
    expect(net.calls).toHaveLength(2);
  });

  it("re-checks skipped data within the subscribers' interval, and the stream opening does not push that back", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    // The operator goes to another project: no stream watches this URL now.
    leave();
    clock.advance(4_000);
    store.subscribe("/api/a", 5_000, () => {});
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([1_000]);
    // Back on the project, its stream opens and slows the poll to a fallback.
    store.livePoll("/api/a", 60_000);
    expect(clock.pending()).toEqual([1_000]);
    clock.advance(1_000);
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);
  });

  it("judges freshness by the subscribers' interval, not a live stream's slower one", async () => {
    const { clock, net, store } = setup();
    store.livePoll("/api/a", 60_000);
    const leave = store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    leave();
    clock.advance(6_000);
    store.subscribe("/api/a", 5_000, () => {});
    expect(net.calls).toHaveLength(2);
  });

  it("reads at once for a returning subscriber on an error with data, though within its interval", async () => {
    const { clock, net, store } = setup();
    const leave = store.subscribe("/api/a", 5_000, () => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();
    store.refresh("/api/a");
    net.call(1).answer(json({ message: "adapter down" }, { status: 503 }));
    await flush();
    leave();
    clock.advance(100);
    store.subscribe("/api/a", 5_000, () => {});
    expect(store.get("/api/a")).toMatchObject({ state: "error", data: { n: 1 } });
    expect(net.calls).toHaveLength(3);
  });

  it("still reads for a one-shot subscriber after a fresh prefetch (#734)", async () => {
    const { net, store } = setup();
    store.prefetch("/api/a");
    net.call(0).answer(json({ n: 1 }));
    await flush();
    store.subscribe("/api/a", null, () => {});
    expect(store.get("/api/a")).toEqual({ state: "loading" });
    expect(net.calls).toHaveLength(2);
  });

  it("while hidden reads nothing and arms nothing for a fresh entry; showing the page catches it up", async () => {
    const { clock, net, page, store } = hiddenSetup();
    store.prefetch("/api/a");
    net.call(0).answer(json({ n: 1 }));
    await flush();
    page.hide();
    clock.advance(100);
    store.subscribe("/api/a", 5_000, () => {});
    expect(net.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
    page.show();
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
    expect(clock.pending()).toEqual([5_000]);
  });
});

describe("review fixes (#727)", () => {
  it("does not re-read a failed prefetch on every hover within KEEP_ALIVE_MS", async () => {
    const { clock, net, store } = setup();
    store.prefetch("/api/a");
    net.call(0).answer(json({ message: "down" }, { status: 503 }));
    await flush();
    store.prefetch("/api/a");
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(1);
    clock.advance(KEEP_ALIVE_MS);
    store.prefetch("/api/a");
    expect(net.calls).toHaveLength(2);
  });

  it("opens a reader on loading, not on a failed prefetch's error with no data", async () => {
    const { net, store } = setup();
    store.prefetch("/api/a");
    net.call(0).answer(json({ message: "down" }, { status: 503 }));
    await flush();
    store.subscribe("/api/a", 5000, () => {});
    expect(store.get("/api/a")).toEqual({ state: "loading" });
    expect(net.calls).toHaveLength(2);
    net.call(1).answer(json({ n: 1 }));
    await flush();
    expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 1 } });
  });

  it("still reads, and keeps polling, when the wall clock steps back behind the last answer", async () => {
    const { clock, net, store } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
      store.subscribe("/api/a", 5000, () => {});
      net.call(0).answer(json({ n: 1 }));
      await flush();
      // Query now holds data stamped in 2030; the wall clock steps back a day.
      vi.setSystemTime(Date.parse("2029-12-31T00:00:00Z"));
      clock.advance(5000);
      expect(net.calls).toHaveLength(2);
      net.call(1).answer(json({ n: 2 }));
      await flush();
      expect(store.get("/api/a")).toMatchObject({ state: "ready", data: { n: 2 } });
      expect(store.inFlight("/api/a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the change stream's seam (#724)", () => {
  it("drives one URL with refresh and livePoll as bindLiveStream does", async () => {
    const { clock, net, store } = setup();
    const binding = bindRead<{ n: number }>(() => store, "/api/a", 5_000);
    binding.subscribe(() => {});
    net.call(0).answer(json({ n: 1 }));
    await flush();

    // The stream opens: slow the poll to the fallback, then catch up once.
    store.livePoll("/api/a", 60_000);
    store.refresh("/api/a");
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([]);
    // An event during that read queues exactly one more.
    store.refresh("/api/a");
    net.call(1).answer(json({ n: 2 }));
    await flush();
    expect(net.calls).toHaveLength(3);
    net.call(2).answer(json({ n: 3 }));
    await flush();
    expect(clock.pending()).toEqual([60_000]);
    expect(binding.getSnapshot()).toMatchObject({ state: "ready", data: { n: 3 } });

    // The stream closes: the subscriber's interval is back, overdue reads at once.
    clock.advance(5_000);
    store.livePoll("/api/a", null);
    expect(net.calls).toHaveLength(4);
  });
});

describe("the polled reads on the Query layer (#733)", () => {
  // The real targets the polled hooks read, so a change to a read's interval
  // or URL is covered here too.
  const targets: [string, ReadTarget<unknown> | null][] = [
    ["projectsRead", projectsRead()],
    ["projectsHealthRead", projectsHealthRead("alpha")],
    ["projectSetupRead", projectSetupRead("alpha")],
    ["projectSleepRead (local)", projectSleepRead("alpha", false)],
    ["bridgeStatusRead (remote)", bridgeStatusRead("alpha", true)],
    ["usageRead", usageRead("alpha")],
    ["sentinelRead", sentinelRead("alpha")],
    ["notificationsRead", notificationsRead("alpha")],
    ["loopNotificationsRead", loopNotificationsRead("alpha", "rafa")],
    ["loopHistoryRead", loopHistoryRead("alpha", "rafa")],
    ["agentsRead", agentsRead("alpha")],
    ["labelsRead", labelsRead("alpha")],
    ["intakeRead", intakeRead("alpha")],
    ["intakeSessionRead", intakeSessionRead("alpha")],
    ["intakeMetricsRead (open)", intakeMetricsRead("alpha", true)],
  ];

  describe.each(targets)("%s", (_name, target) => {
    /** The target, asserted polled: these hooks never read a one-shot or a null target. */
    const polledTarget = (): { url: string; intervalMs: number } => {
      if (target === null || target.intervalMs === null) throw new Error("expected a polled target");
      return { url: target.url, intervalMs: target.intervalMs };
    };

    it("shares one request and one snapshot between two readers", async () => {
      const { url, intervalMs } = polledTarget();
      const { net, store } = setup();
      let first = 0;
      let second = 0;
      store.subscribe(url, intervalMs, () => first++);
      store.subscribe(url, intervalMs, () => second++);
      expect(net.calls).toHaveLength(1);
      expect(net.call(0).url).toBe(url);
      net.call(0).answer(json({ n: 1 }));
      await flush();
      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(store.get(url)).toEqual({ state: "ready", data: { n: 1 }, at: new Date(START), snapshotAt: null });
      expect(store.get(url)).toBe(store.get(url));
    });

    it("polls at the shortest interval its readers ask for", async () => {
      const { url, intervalMs } = polledTarget();
      const { clock, net, store } = setup();
      store.subscribe(url, intervalMs, () => {});
      net.call(0).answer(json({ n: 1 }));
      await flush();
      expect(clock.pending()).toEqual([intervalMs]);

      const shorter = Math.floor(intervalMs / 2);
      store.subscribe(url, shorter, () => {});
      // However the new reader's arrival is scheduled, from the next settle on
      // the read polls at the shorter interval.
      clock.advance(intervalMs);
      const polled = net.calls.length;
      net.call(polled - 1).answer(json({ n: 2 }));
      await flush();
      expect(clock.pending()).toEqual([shorter]);
      clock.advance(shorter);
      expect(net.calls).toHaveLength(polled + 1);
    });

    it("is in flight while a read is on the wire", async () => {
      const { url, intervalMs } = polledTarget();
      const { net, store } = setup();
      expect(store.inFlight(url)).toBe(false);
      store.subscribe(url, intervalMs, () => {});
      expect(store.inFlight(url)).toBe(true);
      net.call(0).answer(json({ n: 1 }));
      await flush();
      expect(store.inFlight(url)).toBe(false);
    });
  });
});
