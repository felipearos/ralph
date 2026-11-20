/**
 * One project's snapshot change stream (#724): a hub that recomputes the
 * compact dashboard snapshot when a loop's files move, and tells every open
 * page "the snapshot changed, version N" — never the snapshot itself. The page
 * reads the body over its usual route, so this module adds no second copy of
 * any read and nothing a browser can use beyond a version number.
 *
 * ONE PRODUCER PER SCOPE. However many tabs are open, a change costs one
 * recompute: the hub is shared, recomputes are single-flight and at least
 * `minIntervalMs` apart, and a burst of file events folds into one.
 *
 * DEGRADES, NEVER THROWS. A watch that cannot be made (ENOENT, ENOSPC, EMFILE)
 * or that errors later is dropped and logged once; the fallback tick still
 * recomputes on its own clock. A failed compute keeps the previous hash and
 * emits nothing. Unattended, a missing signal means a slower page, not a stuck
 * one.
 *
 * LAZY. Nothing is computed or watched until the first subscriber, and the
 * last one leaving stops everything.
 *
 * MORE THAN ONE KEY (#729). The same watches also announce the page's other
 * live reads by their route-table keys: a control, notification or roster
 * file names its key itself (`controls`, `control/<loop>`, `history/<loop>`,
 * `notifications`, `agents`) without a recompute, and the recompute adds
 * `controls` and `agents` whenever the snapshot moves. Producers (another
 * project's health) are lighter computes hashed the same way, run only while
 * a subscriber asks for their key and no oftener than their own minimum
 * interval — so a project nobody watches in full never pays for its
 * dashboard read, and a busy one's health is not re-read every second.
 */
import { watch as fsWatch } from "node:fs";
import { basename, join, sep } from "node:path";

import { commonGitDir } from "./adapter";
import { hashOf } from "./remote/collect";

export interface SnapshotEvent {
  /** A route-table key (`dashboard`, `controls`, `control/<loop>`, …) or a producer's key. */
  key: string;
  /** One counter per hub, shared by every key. */
  version: number;
}

/** A cheap read hashed like the dashboard; its key is announced when its hash moves. */
export interface SnapshotProducer {
  compute: () => Promise<unknown>;
  /** The directories whose changes can move the value; none means the fallback tick only. */
  targets?: (value: unknown) => string[];
  /**
   * The least time between two of this producer's computes, beyond the hub's
   * own minimum. Leading edge: the first change after a quiet spell runs at
   * once, and a change inside the window runs at its end, never dropped.
   */
  minIntervalMs?: number;
}

export interface HubTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** A watch on one directory; `onError` is the watcher's "error" event. */
export type WatchDir = (
  dir: string,
  onChange: (filename: string | null) => void,
  onError: (error: unknown) => void,
) => { close(): void };

export interface SnapshotHubOptions {
  compute: () => Promise<unknown>;
  watchTargets?: (snapshot: unknown) => string[];
  watch?: WatchDir;
  timers?: HubTimers;
  debounceMs?: number;
  minIntervalMs?: number;
  fallbackMs?: number;
  log?: (line: string) => void;
  registered?: () => boolean | Promise<boolean>;
  /** Whether a change to `filename` in `dir` can move the snapshot; default `isSnapshotChange`. */
  relevant?: (dir: string, filename: string | null) => boolean;
  /** Keyed producers, run only while some subscriber's `keys` names them. */
  producers?: Record<string, SnapshotProducer>;
}

export interface SnapshotHub {
  /**
   * `keys` undefined is the full stream: the dashboard compute and every key
   * the hub announces, producers' keys included while some keyed subscriber
   * keeps a producer running. Otherwise the listener hears only those keys,
   * and the dashboard is not computed on its account.
   */
  subscribe(listener: (event: SnapshotEvent) => void, keys?: readonly string[]): () => void;
  close(): void;
  /** Runs `cb` once when the hub closes; returns a way to take it back. */
  onClose(cb: () => void): () => void;
  /**
   * Something changed that no file shows (the design preview's in-memory
   * loops): asks for a recompute down the same debounced, single-flight path
   * a file event takes. A no-op when closed or with no subscriber.
   */
  nudge(): void;
  readonly subscribers: number;
}

/**
 * The directories whose changes can move the snapshot: each loop's logs and
 * control inbox, and the git common dir (with its `ralph/` leases and the
 * `worktrees/` a new or removed agent shows in) the loops on a host share.
 */
export function snapshotWatchDirs(snapshot: unknown): string[] {
  const dirs = new Set<string>();
  const loops = typeof snapshot === "object" && snapshot !== null ? (snapshot as { loops?: unknown }).loops : undefined;
  if (!Array.isArray(loops)) return [];
  for (const loop of loops) {
    const worktree = typeof loop === "object" && loop !== null ? (loop as { worktree?: unknown }).worktree : undefined;
    if (typeof worktree !== "string" || worktree === "") continue;
    dirs.add(join(worktree, ".ralph", "logs"));
    dirs.add(join(worktree, ".ralph", "control"));
    dirs.add(join(worktree, ".ralph", "control", "inbox"));
    dirs.add(join(worktree, ".ralph", "control", "processed"));
    const common = commonGitDir(worktree);
    if (common !== null) {
      dirs.add(common);
      dirs.add(join(common, "ralph"));
      dirs.add(join(common, "worktrees"));
    }
  }
  return [...dirs];
}

/**
 * The files a running loop writes many times a second and the snapshot never
 * reads: its iteration and session logs, the executor's and the inspectors'
 * transcripts. Left in, a busy loop would recompute the snapshot at every
 * minimum interval for as long as it runs — dearer than the poll it replaces.
 */
const STREAMING_LOG = /^(iter-|signals-|inspect-|delegate-|codex-)|^loop\.stdout$|\.log$/;

/**
 * Whether a change can move the snapshot. In a loop's `.ralph/logs`, anything
 * but the streaming logs above; in the git common dir, which git itself writes
 * on every fetch and commit, only the `ralph-*` stores (leases, blockers, sleep);
 * the control dirs, the common dir's `ralph/` stores and its `worktrees/`
 * (an agent added or removed), everything. A watcher that names no file may
 * mean anything, so it counts.
 */
export function isSnapshotChange(dir: string, filename: string | null): boolean {
  if (filename === null || filename === "") return true;
  const name = basename(filename);
  const parts = dir.split(sep);
  const leaf = parts.at(-1);
  if (leaf === "logs" && parts.at(-2) === ".ralph") return !STREAMING_LOG.test(name);
  if (leaf === "control" || leaf === "inbox" || leaf === "processed" || leaf === "ralph" || leaf === "worktrees") return true;
  return name.startsWith("ralph");
}

const defaultWatch: WatchDir = (dir, onChange, onError) => {
  // Not persistent: a watch must never be what keeps the server alive.
  const watcher = fsWatch(dir, { persistent: false }, (_event, filename) =>
    onChange(typeof filename === "string" ? filename : filename === null ? null : String(filename)),
  );
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

const realTimers: HubTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * `value` without `generatedAt` and `readAt` at any depth. The bridge's
 * `hashOf` drops them only at the top, but the dashboard body nests them
 * (`ciHealth.readAt`, `frontier.readAt`, `following.readAt`), stamped anew on
 * every adapter read: left in, every recompute of an idle project is a change.
 */
export function withoutNestedReadTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNestedReadTimes);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (key === "generatedAt" || key === "readAt") continue;
    out[key] = withoutNestedReadTimes(field);
  }
  return out;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Where a loop's file lives decides which of the page's reads it can move. */
type LoopDirKind = "control" | "inbox" | "processed" | "logs";

/** The `loop`/`worktree` pairs of a dashboard snapshot; anything malformed is skipped. */
function rosterOf(snapshot: unknown): { loop: string; worktree: string | null }[] {
  const loops = typeof snapshot === "object" && snapshot !== null ? (snapshot as { loops?: unknown }).loops : undefined;
  if (!Array.isArray(loops)) return [];
  const out: { loop: string; worktree: string | null }[] = [];
  for (const entry of loops) {
    if (typeof entry !== "object" || entry === null) continue;
    const { loop, worktree } = entry as { loop?: unknown; worktree?: unknown };
    if (typeof loop !== "string") continue;
    out.push({ loop, worktree: typeof worktree === "string" && worktree !== "" ? worktree : null });
  }
  return out;
}

/**
 * The signalling dirs of each worktree the snapshot names. Only these name a
 * loop, so a dir the snapshot does not know (or any dir before the first
 * snapshot) announces no file key and waits for the recompute instead.
 */
function loopDirs(snapshot: unknown): Map<string, { loop: string; kind: LoopDirKind }> {
  const out = new Map<string, { loop: string; kind: LoopDirKind }>();
  for (const { loop, worktree } of rosterOf(snapshot)) {
    if (worktree === null) continue;
    out.set(join(worktree, ".ralph", "control"), { loop, kind: "control" });
    out.set(join(worktree, ".ralph", "control", "inbox"), { loop, kind: "inbox" });
    out.set(join(worktree, ".ralph", "control", "processed"), { loop, kind: "processed" });
    out.set(join(worktree, ".ralph", "logs"), { loop, kind: "logs" });
  }
  return out;
}

const commandKeys = (loop: string): string[] => ["controls", `control/${loop}`, `history/${loop}`];

/**
 * The keys a change to `filename` in one of `loop`'s dirs announces. These
 * files change only on a real change, so no hash is needed to trust them. A
 * watcher that names no file counts for every key its dir can signal.
 */
export function fileSignalKeys(kind: LoopDirKind, loop: string, filename: string | null): string[] {
  const name = filename === null || filename === "" ? null : basename(filename);
  // A write-then-rename's temp file (`notifications-read.json.<pid>.tmp`) is
  // not the change: the rename into place names the real file a moment later.
  if (name !== null && name.endsWith(".tmp")) return [];
  switch (kind) {
    case "control":
      if (name === null) return [...commandKeys(loop), "notifications"];
      // The read marks are the notifications view's own state, not a command.
      return name === "notifications-read.json" ? ["notifications"] : commandKeys(loop);
    case "inbox":
    case "processed":
      return commandKeys(loop);
    case "logs":
      if (name === null) return ["notifications", `history/${loop}`];
      if (name === "notifications.jsonl") return ["notifications"];
      if (name === "plugin-doctor.jsonl") return [`history/${loop}`];
      // The loop's hold and pause state, which `controls status` reads and
      // the snapshot does not: a command queued `--after` a phase lands here alone.
      if (name === "controls.json") return ["controls", `control/${loop}`];
      return [];
  }
}

/** The dashboard's slot among the hub's computes; a symbol, so no producer key can collide with it. */
const DASHBOARD: unique symbol = Symbol("dashboard");
type Slot = typeof DASHBOARD | string;

export function createSnapshotHub({
  compute,
  watchTargets = snapshotWatchDirs,
  watch = defaultWatch,
  timers = realTimers,
  debounceMs = 250,
  minIntervalMs = 1000,
  fallbackMs = 30_000,
  log = (line) => console.warn(line),
  registered,
  relevant = isSnapshotChange,
  producers = {},
}: SnapshotHubOptions): SnapshotHub {
  // `keys` null is a full subscriber: the one kind the dashboard is computed for.
  const listeners = new Set<{ listener: (event: SnapshotEvent) => void; keys: ReadonlySet<string> | null }>();
  const closers = new Set<() => void>();
  const watches = new Map<string, { close(): void }>();
  let closed = false;
  // Bumped on every start and stop, so a compute or tick from an earlier
  // session lands on nothing.
  let generation = 0;
  // Per active compute: its last hash (absent before its baseline) and the
  // dirs its last value asked to be watched.
  const hashes = new Map<Slot, string>();
  const targetsOf = new Map<Slot, string[]>();
  let dirIndex = new Map<string, { loop: string; kind: LoopDirKind }>();
  let version = 0;
  let inFlight = false;
  let dirty = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let pending: unknown = null;
  // When `pending` fires: a sooner trigger moves it earlier, never later.
  let pendingAt = Number.POSITIVE_INFINITY;
  let fallback: unknown = null;
  // The computes a trigger asked for and no run has taken yet, and when each
  // last started: a producer with its own minimum waits here, not dropped.
  const wanted = new Set<Slot>();
  const slotStart = new Map<Slot, number>();
  // File keys of one debounce window, announced together on their own timer:
  // a command moved to `processed/` must not wait out the recompute.
  const pendingKeys = new Set<string>();
  let keyTimer: unknown = null;
  // Once per hub: a dir that cannot be watched stays unwatchable on every
  // recompute, and a line per recompute would bury the log overnight.
  let loggedWatch = false;
  let loggedCompute = false;

  const isProducer = (key: string): boolean => Object.prototype.hasOwnProperty.call(producers, key);

  // Which computes someone is listening for: the dashboard while a full
  // subscriber is open, a producer while some subscriber names its key.
  const activeSlots = (): Set<Slot> => {
    const slots = new Set<Slot>();
    for (const { keys } of listeners) {
      if (keys === null) slots.add(DASHBOARD);
      else for (const key of keys) if (isProducer(key)) slots.add(key);
    }
    return slots;
  };

  const forget = (slot: Slot): void => {
    hashes.delete(slot);
    targetsOf.delete(slot);
    if (slot === DASHBOARD) dirIndex = new Map();
  };

  const dropWatch = (dir: string): void => {
    const handle = watches.get(dir);
    watches.delete(dir);
    try {
      handle?.close();
    } catch {
      // Already gone.
    }
  };

  const watchFailed = (dir: string, error: unknown): void => {
    if (!loggedWatch) {
      loggedWatch = true;
      log(`snapshot-stream: cannot watch ${dir}: ${reason(error)}; the ${fallbackMs}ms fallback covers it`);
    }
  };

  const emit = (event: SnapshotEvent): void => {
    for (const entry of listeners) {
      if (entry.keys !== null && !entry.keys.has(event.key)) continue;
      try {
        entry.listener(event);
      } catch {
        // One bad listener does not starve the others.
      }
    }
  };

  const announce = (key: string): void => {
    version += 1;
    emit({ key, version });
  };

  const flushKeys = (): void => {
    keyTimer = null;
    const keys = [...pendingKeys];
    pendingKeys.clear();
    if (closed || listeners.size === 0) return;
    for (const key of keys) announce(key);
  };

  // A file whose change names its read: queued for the next key flush. Kept
  // apart from `relevant`, which only decides whether the recompute runs.
  const signalFile = (dir: string, filename: string | null): void => {
    let keys: string[] = [];
    try {
      const owner = dirIndex.get(dir);
      if (owner !== undefined) keys = fileSignalKeys(owner.kind, owner.loop, filename);
      else if (targetsOf.get(DASHBOARD)?.includes(dir)) {
        // An agent's worktree added or removed, or a fetch that may have moved
        // the base branch's roster under a pending agent.
        const name = filename === null ? null : basename(filename);
        if (basename(dir) === "worktrees" || name === "FETCH_HEAD") keys = ["agents"];
      }
    } catch {
      // Unclassified: the recompute still covers it.
      return;
    }
    if (keys.length === 0) return;
    for (const key of keys) pendingKeys.add(key);
    if (keyTimer === null) keyTimer = timers.setTimeout(flushKeys, debounceMs);
  };

  // Watches the union of every active compute's targets.
  const retarget = (): void => {
    const targets = new Set<string>();
    for (const dirs of targetsOf.values()) for (const dir of dirs) targets.add(dir);
    for (const dir of watches.keys()) if (!targets.has(dir)) dropWatch(dir);
    const session = generation;
    for (const dir of targets) {
      if (watches.has(dir)) continue;
      try {
        const handle = watch(
          dir,
          (filename) => {
            if (session !== generation) return;
            signalFile(dir, filename);
            let counts = true;
            try {
              counts = relevant(dir, filename);
            } catch {
              // A filter that fails lets the change through: the hash still decides.
            }
            if (counts) request(debounceMs);
          },
          (error) => {
            if (session !== generation) return;
            watchFailed(dir, error);
            if (watches.get(dir) === handle) dropWatch(dir);
          },
        );
        watches.set(dir, handle);
      } catch (error) {
        // Not watched now; the next recompute tries again, since a missing
        // dir (a fresh worktree's `control/processed`) may appear later.
        watchFailed(dir, error);
      }
    }
  };

  // Asks for a recompute no sooner than `delay` from now. Requests coalesce
  // into the one pending timer; one during a recompute marks it dirty, so
  // exactly one more runs after it.
  // How long until `slot` may compute again; the dashboard has only the hub's minimum.
  const dueIn = (slot: Slot): number => {
    if (slot === DASHBOARD) return 0;
    const spacing = producers[slot]?.minIntervalMs ?? 0;
    return (slotStart.get(slot) ?? Number.NEGATIVE_INFINITY) + spacing - timers.now();
  };

  // Arms the run for what is still wanted, at the soonest any of it is due.
  const scheduleWanted = (): void => {
    if (inFlight || wanted.size === 0) return;
    let soonest = Number.POSITIVE_INFINITY;
    for (const slot of wanted) soonest = Math.min(soonest, dueIn(slot));
    arm(Math.max(soonest, lastStart + minIntervalMs - timers.now(), 0));
  };

  // Sets the one run timer `wait` from now, unless it already fires no later.
  // A producer held to its own interval may have armed it far ahead; a file
  // event for the dashboard must not wait behind that.
  function arm(wait: number): void {
    const at = timers.now() + wait;
    if (pending !== null) {
      if (pendingAt <= at) return;
      timers.clearTimeout(pending);
    }
    pendingAt = at;
    pending = timers.setTimeout(run, wait);
  }

  function request(delay: number): void {
    if (closed || listeners.size === 0) return;
    for (const slot of activeSlots()) wanted.add(slot);
    if (inFlight) {
      dirty = true;
      return;
    }
    arm(Math.max(delay, lastStart + minIntervalMs - timers.now()));
  }

  function run(): void {
    pending = null;
    pendingAt = Number.POSITIVE_INFINITY;
    if (closed || listeners.size === 0) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    // Deferred, not dropped: a trigger before the interval is up runs at its end.
    const wait = lastStart + minIntervalMs - timers.now();
    if (wait > 0) {
      arm(wait);
      return;
    }
    const active = activeSlots();
    for (const slot of wanted) if (!active.has(slot)) wanted.delete(slot);
    const slots = [...wanted].filter((slot) => dueIn(slot) <= 0);
    // Nothing due yet (a producer inside its own interval): run when it is.
    // Subscribers that name no producer and want no dashboard: nothing to read.
    if (slots.length === 0) {
      scheduleWanted();
      return;
    }
    for (const slot of slots) {
      wanted.delete(slot);
      slotStart.set(slot, timers.now());
    }
    inFlight = true;
    lastStart = timers.now();
    const session = generation;
    void recompute(session, slots);
  }

  const failedOnce = (line: string): void => {
    if (loggedCompute) return;
    loggedCompute = true;
    log(line);
  };

  // A compute's value: hashed against its last one (the baseline sets the
  // hash only, since the page has just read it itself), then its watch targets.
  const settle = (slot: Slot, value: unknown): void => {
    const key = slot === DASHBOARD ? "dashboard" : slot;
    try {
      const hash = hashOf(key, withoutNestedReadTimes(value));
      const previous = hashes.get(slot);
      if (previous !== undefined && hash !== previous) {
        announce(key);
        // The control views are composed from the same runtime read, and the
        // agents list follows the roster and the supervisors the snapshot shows.
        if (slot === DASHBOARD) {
          announce("controls");
          announce("agents");
        }
      }
      hashes.set(slot, hash);
    } catch (error) {
      failedOnce(`snapshot-stream: ${key} could not be hashed: ${reason(error)}`);
    }
    if (slot === DASHBOARD) dirIndex = loopDirs(value);
    try {
      targetsOf.set(slot, slot === DASHBOARD ? watchTargets(value) : (producers[slot]!.targets?.(value) ?? []));
    } catch (error) {
      // The previous targets stay watched.
      watchFailed("(targets)", error);
    }
  };

  async function recompute(session: number, slots: Slot[]): Promise<void> {
    const results = await Promise.all(
      slots.map(async (slot): Promise<{ slot: Slot; ok: boolean; value: unknown }> => {
        try {
          return { slot, ok: true, value: await (slot === DASHBOARD ? compute() : producers[slot]!.compute()) };
        } catch (error) {
          if (session === generation) {
            const what = slot === DASHBOARD ? "snapshot" : slot;
            failedOnce(`snapshot-stream: ${what} read failed: ${reason(error)}; keeping the last version`);
          }
          return { slot, ok: false, value: undefined };
        }
      }),
    );
    if (session !== generation) return;
    inFlight = false;
    // A compute nobody listens for any more is dropped, not baselined.
    const active = activeSlots();
    let settled = false;
    for (const result of results) {
      if (!result.ok || !active.has(result.slot)) continue;
      settle(result.slot, result.value);
      settled = true;
    }
    if (settled && session === generation) retarget();
    if (session !== generation) return;
    if (dirty) {
      dirty = false;
      request(0);
    } else scheduleWanted();
  }

  const armFallback = (): void => {
    const session = generation;
    fallback = timers.setTimeout(() => {
      fallback = null;
      if (session !== generation) return;
      void tick(session);
    }, fallbackMs);
  };

  async function tick(session: number): Promise<void> {
    let still = true;
    try {
      if (registered !== undefined) still = await registered();
    } catch {
      // An unreadable registry is not a removed project; keep serving.
    }
    if (session !== generation) return;
    if (still === false) {
      close();
      return;
    }
    request(0);
    armFallback();
  }

  const reset = (): void => {
    for (const slot of [...hashes.keys(), ...targetsOf.keys()]) forget(slot);
    forget(DASHBOARD);
    inFlight = false;
    dirty = false;
    pendingKeys.clear();
    wanted.clear();
  };

  const start = (): void => {
    generation += 1;
    reset();
    lastStart = Number.NEGATIVE_INFINITY;
    armFallback();
    for (const slot of activeSlots()) wanted.add(slot);
    run();
  };

  const stop = (): void => {
    generation += 1;
    if (pending !== null) timers.clearTimeout(pending);
    if (fallback !== null) timers.clearTimeout(fallback);
    if (keyTimer !== null) timers.clearTimeout(keyTimer);
    pending = null;
    pendingAt = Number.POSITIVE_INFINITY;
    fallback = null;
    keyTimer = null;
    reset();
    for (const dir of watches.keys()) dropWatch(dir);
  };

  function close(): void {
    if (closed) return;
    closed = true;
    stop();
    listeners.clear();
    for (const cb of closers) {
      try {
        cb();
      } catch {
        // The owner's bookkeeping does not stop the others.
      }
    }
    closers.clear();
  }

  return {
    subscribe(listener, keys) {
      if (closed) return () => undefined;
      const entry = { listener, keys: keys === undefined ? null : new Set(keys) };
      const before = activeSlots();
      listeners.add(entry);
      if (listeners.size === 1) start();
      else {
        // A compute this subscriber is the first to want takes its baseline now.
        for (const slot of activeSlots()) {
          if (!before.has(slot)) {
            request(0);
            break;
          }
        }
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (!listeners.delete(entry)) return;
        if (listeners.size === 0) {
          if (!closed) stop();
          return;
        }
        // A compute nobody wants any more stops costing a read and its watches.
        const after = activeSlots();
        let dropped = false;
        for (const slot of [DASHBOARD, ...Object.keys(producers)] as Slot[]) {
          if (!after.has(slot) && (hashes.has(slot) || targetsOf.has(slot))) {
            forget(slot);
            dropped = true;
          }
        }
        if (dropped) retarget();
      };
    },
    close,
    nudge() {
      request(debounceMs);
    },
    onClose(cb) {
      if (closed) {
        cb();
        return () => undefined;
      }
      closers.add(cb);
      return () => {
        closers.delete(cb);
      };
    },
    get subscribers() {
      return listeners.size;
    },
  };
}

/** Another hub whose `keys` one response forwards beside its own hub's full stream. */
export interface StreamForward {
  hub: SnapshotHub;
  keys: readonly string[];
}

/**
 * The SSE response for one page, modelled on `outputResponse`: a retry hint,
 * a keep-alive comment, and one `data:` line per change. It ends — once — on
 * abort, on the client cancelling, on a failed write, or on its own hub
 * closing, and unsubscribes everywhere when it does.
 *
 * `forwards` (#729) are other projects' hubs heard only for their keys (their
 * `_/health`): a forward's hub closing — that project removed — drops that
 * forward alone. Each hub counts its own versions, so the response re-stamps
 * every event with one counter of its own: versions on one wire only rise.
 */
export function streamResponse(
  hub: SnapshotHub,
  signal?: AbortSignal,
  heartbeatMs = 20_000,
  forwards: readonly StreamForward[] = [],
): Response {
  let finish = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let forgetClose: (() => void) | null = null;
      // Each forward's unsubscribe and onClose take-back, dropped on its own close.
      const forwarded = new Set<() => void>();
      let version = 0;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        forgetClose?.();
        for (const drop of forwarded) drop();
        forwarded.clear();
        signal?.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          finish();
        }
      };
      if (signal?.aborted) {
        finish();
        return;
      }
      signal?.addEventListener("abort", finish, { once: true });
      send("retry: 3000\n\n");
      // A comment every so often keeps a quiet project's stream from being
      // taken for an idle connection, and surfaces a vanished client as a failed write.
      heartbeat = setInterval(() => send(": keep-alive\n\n"), heartbeatMs);
      forgetClose = hub.onClose(() => finish());
      if (closed) return;
      const relay = (event: SnapshotEvent): void => {
        if (closed) return;
        version += 1;
        send(`data: ${JSON.stringify({ key: event.key, version })}\n\n`);
      };
      unsubscribe = hub.subscribe(relay);
      if (closed) {
        unsubscribe();
        return;
      }
      for (const { hub: other, keys } of forwards) {
        if (other === hub || keys.length === 0) continue;
        let off: (() => void) | null = null;
        let forgetOther: (() => void) | null = null;
        const drop = (): void => {
          forwarded.delete(drop);
          off?.();
          forgetOther?.();
        };
        forwarded.add(drop);
        forgetOther = other.onClose(drop);
        // Closed already: `onClose` ran `drop` at once.
        if (!forwarded.has(drop)) continue;
        try {
          off = other.subscribe(relay, keys);
        } catch {
          // A forward that cannot subscribe costs that project's live health, not this stream.
          drop();
        }
      }
    },
    cancel() {
      finish();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
