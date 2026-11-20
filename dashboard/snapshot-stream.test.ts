import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createSnapshotHub,
  isSnapshotChange,
  snapshotWatchDirs,
  streamResponse,
  type HubTimers,
  type SnapshotEvent,
  type WatchDir,
} from "./snapshot-stream";

/** A clock the test moves by hand; `advance` fires due timers in order and lets their promises settle. */
function fakeTimers(): HubTimers & { advance(ms: number): Promise<void>; readonly pending: number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      queue.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      queue.delete(handle as number);
    },
    now: () => now,
    async advance(ms) {
      const target = now + ms;
      await settle();
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of queue) if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
        if (due === null) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = target;
    },
    get pending() {
      return queue.size;
    },
  };
}

/** Lets every queued microtask and callback run; a yield, not a sleep. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A watch that records what is watched and lets the test fire changes or errors. */
function fakeWatch(fail: (dir: string) => boolean = () => false) {
  const live = new Map<string, { onChange: (filename: string | null) => void; onError: (error: unknown) => void }>();
  const watch: WatchDir = vi.fn((dir, onChange, onError) => {
    if (fail(dir)) throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${dir}'`), { code: "ENOENT" });
    live.set(dir, { onChange, onError });
    return { close: () => live.delete(dir) };
  });
  return {
    watch,
    live,
    fire(dir = [...live.keys()][0]!, filename: string | null = null) {
      live.get(dir)?.onChange(filename);
    },
  };
}

const snap = (value: string, generatedAt = "t0") => ({ generatedAt, value, loops: [] });

/** What a moved dashboard hash announces: the dashboard, then the controls and agents read beside it. */
const dashboardChange = (version: number): SnapshotEvent[] => [
  { key: "dashboard", version },
  { key: "controls", version: version + 1 },
  { key: "agents", version: version + 2 },
];

/** A compute that answers from a queue, repeating the last answer once it runs dry. */
function queued(...answers: unknown[]) {
  let last: unknown = answers[0];
  return vi.fn(async () => {
    if (answers.length > 0) last = answers.shift();
    return last;
  });
}

function setup(compute: () => Promise<unknown>, extra: Partial<Parameters<typeof createSnapshotHub>[0]> = {}) {
  const timers = fakeTimers();
  const watcher = fakeWatch();
  const log = vi.fn();
  const hub = createSnapshotHub({
    compute,
    watchTargets: () => ["/wt/.ralph/logs", "/wt/.ralph/control"],
    watch: watcher.watch,
    timers,
    debounceMs: 250,
    minIntervalMs: 1000,
    fallbackMs: 30_000,
    log,
    ...extra,
  });
  return { hub, timers, watcher, log };
}

describe("createSnapshotHub", () => {
  it("is lazy, emits nothing for the baseline, and versions a real change only", async () => {
    const compute = queued(snap("a"), snap("b"), snap("b", "t1"));
    const { hub, timers, watcher } = setup(compute);
    await timers.advance(5000);
    expect(compute).not.toHaveBeenCalled();
    expect(watcher.watch).not.toHaveBeenCalled();

    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(0);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect([...watcher.live.keys()].sort()).toEqual(["/wt/.ralph/control", "/wt/.ralph/logs"]);

    watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(events).toEqual(dashboardChange(1));

    // Only the read time moved: not a change.
    watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(events).toEqual(dashboardChange(1));
  });

  it("computes once per change for any number of subscribers", async () => {
    const compute = queued(snap("a"), snap("b"));
    const { hub, timers, watcher } = setup(compute);
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(first);
    hub.subscribe(second);
    expect(hub.subscribers).toBe(2);
    await timers.advance(0);
    expect(compute).toHaveBeenCalledTimes(1);
    watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledWith({ key: "dashboard", version: 1 });
    expect(second).toHaveBeenCalledWith({ key: "dashboard", version: 1 });
  });

  it("folds a burst into one recompute per interval and never overlaps two", async () => {
    let release: (() => void) | null = null;
    let running = 0;
    let overlapped = false;
    let n = 0;
    const compute = vi.fn(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      n += 1;
      // The second compute is held open while the burst arrives.
      if (n === 2) await new Promise<void>((resolve) => (release = resolve));
      running -= 1;
      return snap(`v${n}`);
    });
    const { hub, timers, watcher } = setup(compute);
    hub.subscribe(() => undefined);
    await timers.advance(0);
    expect(compute).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20; i += 1) watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(release).not.toBeNull();

    // Events while the recompute is pending: no second call starts.
    for (let i = 0; i < 20; i += 1) watcher.fire();
    await timers.advance(5000);
    expect(compute).toHaveBeenCalledTimes(2);

    release!();
    await timers.advance(1000);
    // Exactly one dirty rerun, and nothing after it.
    expect(compute).toHaveBeenCalledTimes(3);
    await timers.advance(10_000);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(overlapped).toBe(false);
  });

  it("defers a trigger inside the interval rather than dropping it", async () => {
    const compute = queued(snap("a"), snap("b"), snap("c"));
    const { hub, timers, watcher } = setup(compute);
    hub.subscribe(() => undefined);
    await timers.advance(0);
    watcher.fire();
    await timers.advance(999);
    expect(compute).toHaveBeenCalledTimes(1);
    await timers.advance(1);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("logs a failed watch once and still recomputes on the fallback tick", async () => {
    const compute = queued(snap("a"), snap("b"));
    const timers = fakeTimers();
    const watcher = fakeWatch(() => true);
    const log = vi.fn();
    const hub = createSnapshotHub({
      compute,
      watchTargets: () => ["/wt/.ralph/logs", "/wt/.ralph/control"],
      watch: watcher.watch,
      timers,
      log,
    });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(0);
    expect(watcher.watch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("/wt/.ralph/logs");
    expect(log.mock.calls[0]![0]).toContain("ENOENT");

    await timers.advance(30_000);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(events).toEqual(dashboardChange(1));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("treats a watcher's error event as a failed watch", async () => {
    const { hub, timers, watcher, log } = setup(queued(snap("a")));
    hub.subscribe(() => undefined);
    await timers.advance(0);
    watcher.live.get("/wt/.ralph/logs")!.onError(new Error("ENOSPC"));
    watcher.live.get("/wt/.ralph/control")!.onError(new Error("EMFILE"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(watcher.live.size).toBe(0);
  });

  it("swallows a failed compute, logs it once and keeps the last hash", async () => {
    let call = 0;
    const compute = vi.fn(async () => {
      call += 1;
      if (call === 2 || call === 3) throw new Error("adapter down");
      return snap(call === 1 ? "a" : "b");
    });
    const { hub, timers, watcher, log } = setup(compute);
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(0);
    watcher.fire();
    await timers.advance(1000);
    watcher.fire();
    await timers.advance(1000);
    expect(events).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(4);
    expect(events).toEqual(dashboardChange(1));
  });

  it("closes itself when the project is no longer registered, ending every stream", async () => {
    const registered = vi.fn(() => false);
    const { hub, timers } = setup(queued(snap("a")), { registered });
    const closed = vi.fn();
    hub.onClose(closed);
    const listener = vi.fn();
    hub.subscribe(listener);
    await timers.advance(30_000);
    expect(registered).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(hub.subscribers).toBe(0);
    expect(timers.pending).toBe(0);
    // After close a subscribe is a no-op.
    const late = vi.fn();
    hub.subscribe(late)();
    expect(hub.subscribers).toBe(0);
  });

  it("stops everything on the last unsubscribe and starts afresh after", async () => {
    const compute = queued(snap("a"), snap("b"), snap("c"));
    const { hub, timers, watcher } = setup(compute);
    const off1 = hub.subscribe(() => undefined);
    const off2 = hub.subscribe(() => undefined);
    await timers.advance(0);
    watcher.fire();
    off1();
    expect(watcher.live.size).toBe(2);
    off2();
    expect(watcher.live.size).toBe(0);
    expect(timers.pending).toBe(0);
    await timers.advance(60_000);
    expect(compute).toHaveBeenCalledTimes(1);

    // A new subscriber takes a new baseline: "b" differs from "a" but is not an event.
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(0);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
  });

  it("ignores a recompute still in flight when the last subscriber leaves", async () => {
    let release: ((value: unknown) => void) | null = null;
    const compute = vi.fn(() => new Promise<unknown>((resolve) => (release = resolve)));
    const { hub, timers, watcher } = setup(compute);
    const off = hub.subscribe(() => undefined);
    await timers.advance(0);
    off();
    release!(snap("a"));
    await timers.advance(0);
    expect(watcher.live.size).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it("recomputes on a nudge, through the same debounce, and ignores one with no subscriber", async () => {
    const compute = queued(snap("a"), snap("b"));
    const { hub, timers } = setup(compute);
    hub.nudge();
    await timers.advance(5000);
    expect(compute).not.toHaveBeenCalled();

    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(1);
    hub.nudge();
    await timers.advance(249);
    expect(compute).toHaveBeenCalledTimes(1);
    await timers.advance(1);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(events).toEqual(dashboardChange(1));
  });
});

/** A snapshot naming loop `ralph` at `/wt`, plus whatever else `extra` lists. */
const rostered = (value: string, extra: { loop: string; worktree: string | null }[] = []) => ({
  generatedAt: "t0",
  value,
  loops: [{ loop: "ralph", worktree: "/wt" }, ...extra],
});

const keyedDirs = () => [
  "/wt/.ralph/logs",
  "/wt/.ralph/control",
  "/wt/.ralph/control/inbox",
  "/wt/.ralph/control/processed",
  "/other/.ralph/control/processed",
  "/repo/.git/worktrees",
  "/repo/.git",
];

const keysOf = (events: SnapshotEvent[]): string[] => events.map((event) => event.key);

describe("live read keys", () => {
  it("announces a processed command as controls, control/<loop> and history/<loop>, once per burst, without the recompute", async () => {
    let release: ((value: unknown) => void) | null = null;
    let n = 0;
    const compute = vi.fn(() => {
      n += 1;
      // The recompute the event asks for is held open: the keys must not wait for it.
      if (n === 2) return new Promise<unknown>((resolve) => (release = resolve));
      return Promise.resolve(rostered("a"));
    });
    const { hub, timers, watcher } = setup(compute, { watchTargets: keyedDirs });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) watcher.fire("/wt/.ralph/control/processed", `cmd-${i}.outcome.json`);
    watcher.fire("/wt/.ralph/control/inbox", "cmd-9.json");
    await timers.advance(249);
    expect(events).toEqual([]);
    await timers.advance(1);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(release).not.toBeNull();
    expect(keysOf(events)).toEqual(["controls", "control/ralph", "history/ralph"]);
    // One counter for the hub, rising per event.
    expect(events.map((event) => event.version)).toEqual([1, 2, 3]);
    release!(rostered("a"));
    await timers.advance(0);
  });

  it("maps notifications, read marks, the doctor log and signals to their own keys", async () => {
    const { hub, timers, watcher } = setup(queued(rostered("a")), { watchTargets: keyedDirs });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);

    const after = async (dir: string, filename: string | null): Promise<string[]> => {
      events.length = 0;
      watcher.fire(dir, filename);
      await timers.advance(2000);
      return keysOf(events).sort();
    };
    expect(await after("/wt/.ralph/logs", "notifications.jsonl")).toEqual(["notifications"]);
    expect(await after("/wt/.ralph/control", "notifications-read.json")).toEqual(["notifications"]);
    expect(await after("/wt/.ralph/logs", "plugin-doctor.jsonl")).toEqual(["history/ralph"]);
    expect(await after("/wt/.ralph/control", "signals.jsonl")).toEqual(["control/ralph", "controls", "history/ralph"]);
    expect(await after("/wt/.ralph/logs", "state.json")).toEqual([]);
    // The hold state `controls status` reads, which the snapshot does not carry.
    expect(await after("/wt/.ralph/logs", "controls.json")).toEqual(["control/ralph", "controls"]);
    // A write-then-rename's temp file is not the change; the rename names the real file.
    expect(await after("/wt/.ralph/control", "notifications-read.json.4242.tmp")).toEqual([]);
    // No name: everything the dir can signal.
    expect(await after("/wt/.ralph/logs", null)).toEqual(["history/ralph", "notifications"]);
    expect(await after("/wt/.ralph/control", null)).toEqual(["control/ralph", "controls", "history/ralph", "notifications"]);
  });

  it("names no key for a worktree the snapshot does not know, nor before the first snapshot", async () => {
    let release: ((value: unknown) => void) | null = null;
    const compute = vi.fn(() => new Promise<unknown>((resolve) => (release = resolve)));
    const watcher = fakeWatch();
    const timers = fakeTimers();
    // Watched from the outset, so a file event can arrive before any snapshot.
    const hub = createSnapshotHub({ compute, watchTargets: keyedDirs, watch: watcher.watch, timers });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(0);
    release!(rostered("a"));
    await timers.advance(0);
    watcher.fire("/other/.ralph/control/processed", "cmd-1.outcome.json");
    await timers.advance(250);
    expect(events).toEqual([]);
  });

  it("still names its keys under a custom relevance filter that turns the recompute off", async () => {
    const compute = queued(rostered("a"));
    const { hub, timers, watcher } = setup(compute, { watchTargets: keyedDirs, relevant: () => false });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);
    watcher.fire("/wt/.ralph/control/processed", "cmd-1.outcome.json");
    await timers.advance(250);
    expect(keysOf(events)).toEqual(["controls", "control/ralph", "history/ralph"]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("adds controls and agents to every dashboard change, and nothing on the baseline", async () => {
    const compute = queued(rostered("a"), rostered("b"), rostered("b", [{ loop: "rafa", worktree: "/wt2" }]));
    const { hub, timers, watcher } = setup(compute, { watchTargets: keyedDirs });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);
    expect(events).toEqual([]);
    watcher.fire("/wt/.ralph/logs", "state.json");
    await timers.advance(1000);
    expect(events).toEqual(dashboardChange(1));
    events.length = 0;
    watcher.fire("/wt/.ralph/logs", "state.json");
    await timers.advance(1000);
    expect(keysOf(events)).toEqual(["dashboard", "controls", "agents"]);
  });

  it("announces agents when a worktree is added or removed in the git common dir", async () => {
    const compute = queued(rostered("a"));
    const { hub, timers, watcher } = setup(compute, { watchTargets: keyedDirs });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);
    watcher.fire("/repo/.git/worktrees", "ralph-new");
    await timers.advance(250);
    expect(keysOf(events)).toEqual(["agents"]);
    // It counts for the recompute too.
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("announces agents when a fetch may have moved the roster on the base branch", async () => {
    const { hub, timers, watcher } = setup(queued(rostered("a")), { watchTargets: keyedDirs });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(1000);
    watcher.fire("/repo/.git", "FETCH_HEAD");
    await timers.advance(250);
    expect(keysOf(events)).toEqual(["agents"]);
    events.length = 0;
    // Git's other writes in the common dir name nothing.
    watcher.fire("/repo/.git", "index.lock");
    await timers.advance(250);
    expect(events).toEqual([]);
  });
});

describe("producers", () => {
  it("holds a producer to its own minimum interval without dropping the change, and without re-reading the dashboard", async () => {
    const compute = queued(rostered("a"));
    const health = queued({ n: 0 }, { n: 1 }, { n: 2 });
    const { hub, timers, watcher } = setup(compute, {
      watchTargets: keyedDirs,
      producers: { "_/health": { compute: health, targets: () => ["/other/.git/ralph"], minIntervalMs: 5000 } },
    });
    const keyed: SnapshotEvent[] = [];
    hub.subscribe((event) => keyed.push(event), ["_/health"]);
    await timers.advance(0);
    expect(health).toHaveBeenCalledTimes(1);

    // Inside the window: deferred to its end, then read once.
    watcher.fire("/other/.git/ralph", "lease.json");
    await timers.advance(1000);
    expect(health).toHaveBeenCalledTimes(1);
    await timers.advance(4000);
    expect(health).toHaveBeenCalledTimes(2);
    expect(keyed).toEqual([{ key: "_/health", version: 1 }]);

    // A full subscriber's change is not held back by the producer's window, nor does it re-read the producer early.
    const full: SnapshotEvent[] = [];
    hub.subscribe((event) => full.push(event));
    await timers.advance(1000);
    const dashboardReads = compute.mock.calls.length;
    watcher.fire("/wt/.ralph/logs", "state.json");
    await timers.advance(1000);
    expect(compute.mock.calls.length).toBe(dashboardReads + 1);
    expect(health.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("runs only the producer for a keyed subscriber, never the dashboard, and tells it its key only", async () => {
    const compute = queued(rostered("a"));
    const health = queued({ ok: true, readAt: "t0" }, { ok: true, readAt: "t1" }, { ok: false, readAt: "t2" });
    const { hub, timers, watcher } = setup(compute, {
      watchTargets: keyedDirs,
      producers: { "_/health": { compute: health, targets: () => ["/other/.git/ralph"] } },
    });
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event), ["_/health"]);
    await timers.advance(0);
    expect(compute).not.toHaveBeenCalled();
    expect(health).toHaveBeenCalledTimes(1);
    expect([...watcher.live.keys()]).toEqual(["/other/.git/ralph"]);

    // Only the read time moved: not a change.
    watcher.fire("/other/.git/ralph", "ci-health.json");
    await timers.advance(1000);
    expect(events).toEqual([]);
    watcher.fire("/other/.git/ralph", "ci-health.json");
    await timers.advance(1000);
    expect(health).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ key: "_/health", version: 1 }]);
    await timers.advance(60_000);
    expect(compute).not.toHaveBeenCalled();
  });

  it("baselines the dashboard when a full subscriber joins, and drops it with its watches when that one leaves", async () => {
    const compute = queued(rostered("a"), rostered("b"));
    const health = queued({ ok: true });
    const { hub, timers, watcher } = setup(compute, {
      watchTargets: () => ["/wt/.ralph/logs"],
      producers: { "_/health": { compute: health } },
    });
    const keyed: SnapshotEvent[] = [];
    hub.subscribe((event) => keyed.push(event), ["_/health"]);
    await timers.advance(0);
    expect(watcher.live.size).toBe(0);

    const full: SnapshotEvent[] = [];
    const off = hub.subscribe((event) => full.push(event));
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(full).toEqual([]);
    expect([...watcher.live.keys()]).toEqual(["/wt/.ralph/logs"]);
    watcher.fire("/wt/.ralph/logs", "state.json");
    await timers.advance(1000);
    expect(full).toEqual(dashboardChange(1));
    // The keyed subscriber hears none of the dashboard's keys.
    expect(keyed).toEqual([]);

    off();
    expect(watcher.live.size).toBe(0);
    await timers.advance(60_000);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed producer's last hash, and stops running it when nobody names it", async () => {
    let call = 0;
    const health = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("registry down");
      return { ok: call < 3 };
    });
    const compute = queued(rostered("a"));
    const { hub, timers, log } = setup(compute, { producers: { "_/health": { compute: health } } });
    const full: SnapshotEvent[] = [];
    hub.subscribe((event) => full.push(event));
    const keyed: SnapshotEvent[] = [];
    const off = hub.subscribe((event) => keyed.push(event), ["_/health"]);
    await timers.advance(1000);
    expect(health).toHaveBeenCalledTimes(1);
    hub.nudge();
    await timers.advance(1000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(keyed).toEqual([]);
    hub.nudge();
    await timers.advance(1000);
    expect(keyed).toEqual([{ key: "_/health", version: 1 }]);
    // A full subscriber hears a producer's key while some keyed subscriber keeps it running.
    expect(full).toEqual([{ key: "_/health", version: 1 }]);

    off();
    hub.nudge();
    await timers.advance(1000);
    // The baseline, the keyed subscriber's own baseline, two nudges, and the last one without the producer.
    expect(compute).toHaveBeenCalledTimes(5);
    expect(health).toHaveBeenCalledTimes(3);
  });
});

/** Reads the stream until `done(text)` holds or the deadline passes. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, state: { text: string }, done: (text: string) => boolean, ms = 5000) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  while (!done(state.text)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out; read so far: ${JSON.stringify(state.text)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out; read so far: ${JSON.stringify(state.text)}`)), left))),
    ]).finally(() => clearTimeout(timer));
    if (chunk.done) return true;
    state.text += decoder.decode(chunk.value, { stream: true });
  }
  return false;
}

describe("the change hash", () => {
  it("ignores read times at any depth, and still sees a nested change", async () => {
    const body = (readAt: string, failing: number) => ({
      generatedAt: readAt,
      ciHealth: { readAt, failing, checks: [{ name: "test", generatedAt: readAt }] },
      frontier: { readAt, buckets: [] },
      loops: [],
    });
    const compute = queued(body("t0", 0), body("t1", 0), body("t2", 1));
    const { hub, timers, watcher } = setup(compute);
    const events: SnapshotEvent[] = [];
    hub.subscribe((event) => events.push(event));
    await timers.advance(0);
    watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
    watcher.fire();
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(events).toEqual(dashboardChange(1));
  });
});

describe("snapshotWatchDirs", () => {
  it("watches each loop's logs and control dirs and its checkout's git common dir", () => {
    // Real paths: the temp dir may sit behind a symlink, and commonGitDir resolves.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "snapshot-watch-")));
    try {
      // A linked worktree as git lays one out: `.git` names its private git
      // dir, whose `commondir` points back at the shared one.
      const common = join(root, "repo", ".git");
      const privateDir = join(common, "worktrees", "wt");
      mkdirSync(privateDir, { recursive: true });
      writeFileSync(join(privateDir, "commondir"), "../..\n");
      const worktree = join(root, "wt");
      mkdirSync(worktree);
      writeFileSync(join(worktree, ".git"), `gitdir: ${privateDir}\n`);

      const dirs = snapshotWatchDirs({ loops: [{ worktree }, { worktree: null }] });
      expect(dirs.sort()).toEqual(
        [
          join(worktree, ".ralph", "logs"),
          join(worktree, ".ralph", "control"),
          join(worktree, ".ralph", "control", "inbox"),
          join(worktree, ".ralph", "control", "processed"),
          common,
          join(common, "ralph"),
          join(common, "worktrees"),
        ].sort(),
      );
      expect(snapshotWatchDirs({ loops: [{ worktree: null }] })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isSnapshotChange", () => {
  it("ignores a running loop's streaming logs and git's own writes", () => {
    const logs = "/wt/.ralph/logs";
    for (const name of ["iter-20261105T184323.log", "iter-1-1.events.jsonl", "signals-orchestrator-x.jsonl", "inspect-mapper-y.log", "delegate-z.log.jsonl", "loop.stdout", "codex-thread-0.json"]) {
      expect(isSnapshotChange(logs, name), name).toBe(false);
    }
    for (const name of ["state.json", "controls.json", "notifications.jsonl", "usage-ledger.tsv"]) {
      expect(isSnapshotChange(logs, name), name).toBe(true);
    }
    expect(isSnapshotChange("/wt/.ralph/control", "inbox")).toBe(true);
    expect(isSnapshotChange("/wt/.ralph/control/processed", "a.outcome.json")).toBe(true);
    expect(isSnapshotChange("/repo/.git", "ralph-claim-leases.json")).toBe(true);
    expect(isSnapshotChange("/repo/.git", "index.lock")).toBe(false);
    expect(isSnapshotChange("/repo/.git", "FETCH_HEAD")).toBe(false);
    expect(isSnapshotChange("/repo/.git/ralph", "ci-health.json")).toBe(true);
    expect(isSnapshotChange("/wt/.ralph/control/inbox", "cmd-1.json")).toBe(true);
    expect(isSnapshotChange("/repo/.git/worktrees", "ralph-loop")).toBe(true);
    expect(isSnapshotChange("/repo/.git/worktrees", null)).toBe(true);
    // A watcher that names no file may mean anything.
    expect(isSnapshotChange(logs, null)).toBe(true);
  });

  it("keeps a filtered write from costing a recompute", async () => {
    const compute = queued(snap("a"), snap("b"));
    const { hub, timers, watcher } = setup(compute);
    hub.subscribe(() => undefined);
    await timers.advance(0);
    expect(compute).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i += 1) watcher.fire("/wt/.ralph/logs", "iter-1.log");
    await timers.advance(5000);
    expect(compute).toHaveBeenCalledTimes(1);
    watcher.fire("/wt/.ralph/logs", "state.json");
    await timers.advance(1000);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("holds lease heartbeats and timeline appends to one recompute per interval", async () => {
    const compute = queued(snap("a"));
    const { hub, timers, watcher } = setup(compute);
    hub.subscribe(() => undefined);
    await timers.advance(0);
    // Ten seconds of a write every 100 ms: at most one recompute per second.
    for (let i = 0; i < 100; i += 1) {
      watcher.fire("/wt/.ralph/logs", i % 2 === 0 ? "timeline.jsonl" : "state.json");
      await timers.advance(100);
    }
    expect(compute.mock.calls.length).toBeLessThanOrEqual(1 + 10 + 1);
  });
});

describe("streamResponse", () => {
  it("sends a retry hint, versions, keep-alives, and unsubscribes on abort", async () => {
    const compute = queued(snap("a"), snap("b"));
    const { hub, timers, watcher } = setup(compute);
    const abort = new AbortController();
    const response = streamResponse(hub, abort.signal, 20);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const state = { text: "" };
    await readUntil(reader, state, (text) => text.includes("retry:"));
    expect(state.text.startsWith("retry: 3000\n\n")).toBe(true);
    expect(hub.subscribers).toBe(1);

    await timers.advance(0);
    watcher.fire();
    await timers.advance(1000);
    await readUntil(reader, state, (text) => text.includes("data:"));
    expect(state.text).toContain('data: {"key":"dashboard","version":1}\n\n');
    expect(state.text).not.toContain('"value"');

    await readUntil(reader, state, (text) => text.includes(": keep-alive\n\n"));

    abort.abort();
    expect(await readUntil(reader, state, () => false)).toBe(true);
    expect(hub.subscribers).toBe(0);
  });

  it("ends when the hub closes", async () => {
    const { hub, timers } = setup(queued(snap("a")));
    const response = streamResponse(hub, undefined, 60_000);
    const reader = response.body!.getReader();
    const state = { text: "" };
    await readUntil(reader, state, (text) => text.includes("retry:"));
    await timers.advance(0);
    hub.close();
    expect(await readUntil(reader, state, () => false)).toBe(true);
    expect(hub.subscribers).toBe(0);
  });
});
