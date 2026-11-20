// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ControlView } from "../contracts";
import { bindLoopControl, createControlsFallback } from "./loop-control";
import { createQueryReads, type ReadClock } from "./query-reads";
import { POLL_MS } from "./reads";

const START = Date.parse("2026-11-03T12:00:00.000Z");

/** A clock whose timers fire only when the test advances it (as in query-reads.test.ts). */
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

interface Call {
  url: string;
  answer(response: Response): void;
}

/** A fetch whose every request waits until the test answers it. */
function fakeFetch() {
  const calls: Call[] = [];
  const fetch = (url: string, _init: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({ url, answer: resolve });
    });
  /** Answer every request still waiting, by URL. */
  const answerAll = (respond: (url: string) => Response) => {
    for (const call of calls.splice(0)) call.answer(respond(call.url));
  };
  return { fetch, calls, answerAll };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Enough microtask turns for a read to settle on either layer: the Query
 * layer's error path (Query's retryer, then the cache's notify) takes more
 * turns than the store's.
 */
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const view = (loop: string): ControlView => ({ hold: null, stop: null, loop }) as unknown as ControlView;
const LOOPS = ["ralph", "rafa", "tria"];
const BATCHED = "/api/p/sf/controls";
const perLoopUrl = (loop: string) => `/api/p/sf/loops/${loop}/control`;

function setup() {
  const clock = fakeClock();
  const net = fakeFetch();
  const fetched: string[] = [];
  const store = createQueryReads({
    fetch: (url, init) => {
      fetched.push(url);
      return net.fetch(url, init);
    },
    clock: clock.clock,
  });
  const fallback = createControlsFallback();
  const bind = (loop: string) => bindLoopControl(() => store, "sf", loop, fallback);
  return { clock, net, fetched, store, fallback, bind };
}

describe("the batched loop control read (#615)", () => {
  it("shares one /controls fetch a tick across every loop, each picking its row", async () => {
    const { clock, net, fetched, bind } = setup();
    const bindings = LOOPS.map(bind);
    for (const binding of bindings) binding.subscribe(() => {});
    expect(fetched).toEqual([BATCHED]);
    net.answerAll(() => json({ loops: Object.fromEntries(LOOPS.map((loop) => [loop, view(loop)])) }));
    await flush();
    bindings.forEach((binding, index) => {
      const read = binding.getSnapshot();
      expect(read.state).toBe("ready");
      expect(read.state === "ready" ? read.data : null).toEqual(view(LOOPS[index] as string));
    });
    clock.advance(POLL_MS);
    expect(fetched).toEqual([BATCHED, BATCHED]);
  });

  it("answers a loop the batched view lacks as the per-loop route would", async () => {
    const { net, bind } = setup();
    const binding = bind("ghost");
    binding.subscribe(() => {});
    net.answerAll(() => json({ loops: { ralph: view("ralph") } }));
    await flush();
    expect(binding.getSnapshot()).toEqual({ state: "error", message: "no loop 'ghost'", status: 404, data: null });
  });

  it("falls back to the per-loop route for the session when /controls answers 404", async () => {
    const { clock, net, fetched, fallback, bind } = setup();
    let heard = 0;
    const bindings = LOOPS.map(bind);
    for (const binding of bindings) binding.subscribe(() => heard++);
    net.answerAll(() => json({ error: "not found" }, 404));
    await flush();
    expect(fallback.missing(BATCHED)).toBe(true);
    expect(heard).toBeGreaterThanOrEqual(LOOPS.length);
    expect(fetched.slice(1).sort()).toEqual(LOOPS.map(perLoopUrl).sort());
    net.answerAll((url) => json(view(LOOPS.find((loop) => url === perLoopUrl(loop)) as string)));
    await flush();
    bindings.forEach((binding, index) => {
      const read = binding.getSnapshot();
      expect(read.state === "ready" ? read.data : read).toEqual(view(LOOPS[index] as string));
    });
    clock.advance(POLL_MS * 3);
    expect(fetched.filter((url) => url === BATCHED)).toHaveLength(1);
    // A binding made later, for the same project, never asks the batched route.
    const before = fetched.length;
    const late = bind("late");
    late.subscribe(() => {});
    expect(fetched.slice(before)).toEqual([perLoopUrl("late")]);
  });

  it("does not fall back on another error", async () => {
    const { clock, net, fetched, fallback, bind } = setup();
    const binding = bind("ralph");
    binding.subscribe(() => {});
    net.answerAll(() => json({ error: "boom" }, 500));
    await flush();
    expect(fallback.missing(BATCHED)).toBe(false);
    expect(binding.getSnapshot()).toEqual({ state: "error", message: "boom", status: 500, data: null });
    clock.advance(POLL_MS);
    expect(fetched).toEqual([BATCHED, BATCHED]);
  });

  it("falls back when the remote has never had a batched snapshot to serve", async () => {
    const { net, fetched, fallback, bind } = setup();
    const binding = bind("ralph");
    binding.subscribe(() => {});
    // An older bridge never pushes `controls`, and the remote says so with a 503.
    net.answerAll(() => json({ error: "NoSnapshot", message: "the machine has not pushed 'controls' yet" }, 503));
    await flush();
    expect(fallback.missing(BATCHED)).toBe(true);
    expect(fetched).toEqual([BATCHED, perLoopUrl("ralph")]);
  });

  it("keeps batching through a 503 once the batched route has answered", async () => {
    const { clock, net, fetched, fallback, bind } = setup();
    const binding = bind("ralph");
    binding.subscribe(() => {});
    net.answerAll(() => json({ loops: { ralph: view("ralph") } }));
    await flush();
    clock.advance(POLL_MS);
    net.answerAll(() => json({ error: "SnapshotUnavailable", message: "the machine could not read 'controls'" }, 503));
    await flush();
    expect(fallback.missing(BATCHED)).toBe(false);
    clock.advance(POLL_MS);
    expect(fetched).toEqual([BATCHED, BATCHED, BATCHED]);
  });

  it("keeps the loop's stale row on an error after a ready read", async () => {
    const { clock, net, bind } = setup();
    const binding = bind("ralph");
    binding.subscribe(() => {});
    net.answerAll(() => json({ loops: { ralph: view("ralph") } }));
    await flush();
    clock.advance(POLL_MS);
    net.answerAll(() => json({ error: "boom" }, 500));
    await flush();
    expect(binding.getSnapshot()).toEqual({ state: "error", message: "boom", status: 500, data: view("ralph") });
  });

  it("hands back the same snapshot object while nothing changed", async () => {
    const { net, bind } = setup();
    const binding = bind("ralph");
    binding.subscribe(() => {});
    expect(binding.getSnapshot()).toBe(binding.getSnapshot());
    net.answerAll(() => json({ loops: { ralph: view("ralph") } }));
    await flush();
    const first = binding.getSnapshot();
    expect(first.state).toBe("ready");
    expect(binding.getSnapshot()).toBe(first);
  });
});
