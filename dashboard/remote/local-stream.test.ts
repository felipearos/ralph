// @vitest-environment node
/**
 * The bridge's local change-stream client (#730): SSE parsing and the
 * refusals that end a stream without opening it, over a fake `fetch` whose
 * body this test feeds by hand; and the per-project manager, over a fake
 * `open` and injected timers. Nothing sleeps: each wait is on a predicate,
 * except the two "nothing more happens" checks, which yield a bounded number
 * of event-loop turns.
 */
import { describe, expect, it, vi } from "vitest";

import { createLocalStreams, openLocalStream, type LocalStreamEvent, type LocalStreamHandlers } from "./local-stream";

/** Yields to the event loop until `predicate` holds (bounded, so a bug fails rather than hangs). */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate()).toBe(true);
}

/** A response whose body the test writes to and ends. */
function feed(init: ResponseInit = { headers: { "content-type": "text/event-stream" } }) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, init),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    error: (error: Error) => controller.error(error),
  };
}

function recorder() {
  const calls: string[] = [];
  const events: LocalStreamEvent[] = [];
  return {
    calls,
    events,
    onOpen: () => calls.push("open"),
    onEvent: (event: LocalStreamEvent) => {
      calls.push("event");
      events.push(event);
    },
    onEnd: (reason: string) => calls.push(`end:${reason}`),
  };
}

describe("openLocalStream", () => {
  it("GETs the table's scoped stream path and parses events across split chunks, CRLF, comments and fields", async () => {
    const stream = feed();
    const fetchFake = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => stream.response);
    const rec = recorder();
    openLocalStream({ base: "http://127.0.0.1:8791/", project: "a b", fetch: fetchFake as unknown as typeof fetch, ...rec });
    await until(() => rec.calls.includes("open"));
    expect(fetchFake.mock.calls[0]![0]).toBe("http://127.0.0.1:8791/api/p/a%20b/stream");
    expect(fetchFake.mock.calls[0]![1]!.method).toBe("GET");

    stream.write("retry: 3000\n\n: keep-alive\n\n");
    stream.write('data: {"key":"dash');
    stream.write('board","version":1}\n');
    stream.write("\n");
    stream.write('event: change\r\nid: 7\r\ndata: {"key":"dashboard","version":2}\r');
    stream.write("\n\r\n");
    stream.write('data: not json\n\ndata: {"key":3,"version":4}\n\ndata: {"key":"x"}\n\ndata: null\n\n');
    stream.write('data:{"key":"dashboard","version":3}\n\n');
    await until(() => rec.events.length === 3);
    expect(rec.events).toEqual([
      { key: "dashboard", version: 1 },
      { key: "dashboard", version: 2 },
      { key: "dashboard", version: 3 },
    ]);

    stream.end();
    await until(() => rec.calls.some((call) => call.startsWith("end:")));
    expect(rec.calls.filter((call) => call.startsWith("end:"))).toEqual(["end:stream ended"]);
  });

  it.each([
    ["a 404", () => new Response("not found", { status: 404 }), "HTTP 404"],
    ["a 503", () => Response.json({ error: "no stream" }, { status: 503 }), "HTTP 503"],
    ["a 2xx JSON answer", () => Response.json({ ok: true }), "not an event stream"],
  ])("ends on %s without opening", async (_name, answer, reason) => {
    const rec = recorder();
    openLocalStream({ base: "http://local", project: "p", fetch: (async () => answer()) as unknown as typeof fetch, ...rec });
    await until(() => rec.calls.length > 0);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toContain(`end:${reason}`);
  });

  it("ends on a network error without opening, and on a read error after opening", async () => {
    const refused = recorder();
    openLocalStream({ base: "http://local", project: "p", fetch: (async () => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch, ...refused });
    await until(() => refused.calls.length > 0);
    expect(refused.calls).toEqual(["end:unreachable: ECONNREFUSED"]);

    const stream = feed();
    const broken = recorder();
    openLocalStream({ base: "http://local", project: "p", fetch: (async () => stream.response) as unknown as typeof fetch, ...broken });
    await until(() => broken.calls.includes("open"));
    stream.error(new Error("reset"));
    await until(() => broken.calls.length === 2);
    expect(broken.calls[1]).toMatch(/^end:read failed/);
  });

  it("does not call onEnd after close()", async () => {
    const stream = feed();
    let signal: AbortSignal | undefined;
    const rec = recorder();
    const handle = openLocalStream({
      base: "http://local",
      project: "p",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return stream.response;
      }) as unknown as typeof fetch,
      ...rec,
    });
    await until(() => rec.calls.includes("open"));
    handle.close();
    expect(signal?.aborted).toBe(true);
    stream.write('data: {"key":"dashboard","version":1}\n\n');
    try {
      stream.end();
    } catch {
      // The abort may already have cancelled the body.
    }
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rec.calls).toEqual(["open"]);
  });

  it("does not call onEnd when closed before the answer arrives", async () => {
    let answer!: (response: Response) => void;
    const rec = recorder();
    const handle = openLocalStream({
      base: "http://local",
      project: "p",
      fetch: (() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch,
      ...rec,
    });
    handle.close();
    answer(new Response("gone", { status: 404 }));
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rec.calls).toEqual([]);
  });
});

/** A fake `open` that records each connection and lets the test drive it. */
function fakeOpen() {
  const connections: { project: string; handlers: LocalStreamHandlers; closed: boolean }[] = [];
  const open = (project: string, handlers: LocalStreamHandlers) => {
    const connection = { project, handlers, closed: false };
    connections.push(connection);
    return { close: () => void (connection.closed = true) };
  };
  return { connections, open, of: (project: string) => connections.filter((c) => c.project === project) };
}

/** Injected timers the test fires by hand. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number): unknown => {
      pending.set(++next, { fn, ms });
      return next;
    },
    clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    fireAll: () => {
      const due = [...pending];
      pending.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
}

function manager() {
  const opener = fakeOpen();
  const timers = fakeTimers();
  const changes: string[] = [];
  const logs: string[] = [];
  const attempts: number[] = [];
  const streams = createLocalStreams({
    open: opener.open,
    onChange: (project, key) => changes.push(`${project}:${key}`),
    backoff: (attempt) => {
      attempts.push(attempt);
      return 1000 * 2 ** attempt;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log: (line) => logs.push(line),
  });
  return { streams, opener, timers, changes, logs, attempts };
}

describe("createLocalStreams", () => {
  it("opens only wanted projects and closes un-wanted ones", () => {
    const { streams, opener } = manager();
    streams.want(["a", "b"]);
    expect(opener.connections.map((c) => c.project)).toEqual(["a", "b"]);
    expect(streams.status("a")).toBe("connecting");
    expect(streams.status("c")).toBe("off");

    streams.want(["b", "c"]);
    expect(opener.of("a")[0]!.closed).toBe(true);
    expect(opener.of("b")).toHaveLength(1);
    expect(opener.of("b")[0]!.closed).toBe(false);
    expect(opener.of("c")).toHaveLength(1);
    expect(streams.status("a")).toBe("off");

    streams.close();
    expect(opener.connections.every((c) => c.closed)).toBe(true);
    expect(streams.status("b")).toBe("off");
  });

  it("calls onChange once on open and once per event", () => {
    const { streams, opener, changes } = manager();
    streams.want(["a"]);
    const a = opener.of("a")[0]!.handlers;
    a.onOpen();
    expect(streams.status("a")).toBe("live");
    a.onEvent({ key: "dashboard", version: 1 });
    a.onEvent({ key: "controls", version: 2 });
    expect(changes).toEqual(["a:dashboard", "a:dashboard", "a:controls"]);
  });

  it("reopens after back-off with a growing attempt, reset by a successful open, logging once per streak", () => {
    const { streams, opener, timers, logs, attempts } = manager();
    streams.want(["a"]);
    opener.of("a")[0]!.handlers.onEnd("HTTP 503");
    expect(streams.status("a")).toBe("down");
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([1000]);
    timers.fireAll();
    expect(opener.of("a")).toHaveLength(2);
    expect(streams.status("a")).toBe("connecting");
    opener.of("a")[1]!.handlers.onEnd("HTTP 503");
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([2000]);
    timers.fireAll();
    opener.of("a")[2]!.handlers.onEnd("unreachable");
    expect(attempts).toEqual([0, 1, 2]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("HTTP 503");

    timers.fireAll();
    opener.of("a")[3]!.handlers.onOpen();
    opener.of("a")[3]!.handlers.onEnd("stream ended");
    expect(attempts).toEqual([0, 1, 2, 0]);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("stream ended");
  });

  it("cancels a pending reopen for an un-wanted project, and a re-wanted one starts fresh", () => {
    const { streams, opener, timers, attempts } = manager();
    streams.want(["a"]);
    opener.of("a")[0]!.handlers.onEnd("HTTP 503");
    timers.fireAll();
    opener.of("a")[1]!.handlers.onEnd("HTTP 503");
    expect(timers.pending.size).toBe(1);
    streams.want([]);
    expect(timers.pending.size).toBe(0);
    expect(streams.status("a")).toBe("off");

    streams.want(["a"]);
    expect(opener.of("a")).toHaveLength(3);
    opener.of("a")[2]!.handlers.onEnd("HTTP 503");
    expect(attempts).toEqual([0, 1, 0]);
  });

  it("ignores callbacks from a closed or replaced connection", () => {
    const { streams, opener, timers, changes, logs } = manager();
    streams.want(["a"]);
    const first = opener.of("a")[0]!.handlers;
    first.onEnd("HTTP 503");
    timers.fireAll();
    const second = opener.of("a")[1]!.handlers;
    second.onOpen();
    // The first connection's late callbacks move nothing.
    first.onOpen();
    first.onEvent({ key: "dashboard", version: 9 });
    first.onEnd("late");
    expect(changes).toEqual(["a:dashboard"]);
    expect(streams.status("a")).toBe("live");
    expect(timers.pending.size).toBe(0);
    expect(logs).toHaveLength(1);

    // Nor does a connection of a project no longer wanted.
    streams.want([]);
    second.onEvent({ key: "dashboard", version: 10 });
    second.onEnd("gone");
    expect(changes).toEqual(["a:dashboard"]);
    expect(timers.pending.size).toBe(0);
  });

  it("treats an open that throws as a failure, and survives an onChange that throws", () => {
    const timers = fakeTimers();
    const logs: string[] = [];
    let calls = 0;
    const streams = createLocalStreams({
      open: (_project, handlers) => {
        calls++;
        if (calls === 1) throw new Error("boom");
        handlers.onOpen();
        return { close: () => {} };
      },
      onChange: () => {
        throw new Error("bridge bug");
      },
      backoff: () => 5,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      log: (line) => logs.push(line),
    });
    streams.want(["a"]);
    expect(streams.status("a")).toBe("down");
    timers.fireAll();
    expect(streams.status("a")).toBe("live");
    expect(logs[0]).toContain("boom");
    expect(logs[1]).toContain("bridge bug");
  });
});
