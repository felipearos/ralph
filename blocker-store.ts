#!/usr/bin/env bun
/**
 * The shared record of which loops wait on which external blocker.
 *
 * Why it exists: #416. When main's CI goes red, or a PR every loop needs sits
 * unmerged, each loop that hits it reports RETRY_LATER on its own, and each
 * escalates on its own: the operator gets one message per loop for one cause,
 * and no loop knows the cause is shared. This store is what makes "two loops
 * wait on the same blocker" knowable, so a later sibling can escalate ONCE for
 * all of them and resume every waiter when the blocker clears.
 *
 * A blocker is keyed by its cause (say, a failing check and step). It lives in
 * EPISODES: `first` is when anybody first joined it and is never rewritten
 * while the episode lasts, because a shared budget is measured from it.
 * `notified`, `exhaustedNotified` and `clearedAt` are each set once. A join
 * after `clearedAt` opens a new episode with only the joining loop, so a cause
 * that comes back is escalated again and does not inherit a spent budget.
 *
 * "The loops on one project" means the worktrees of one checkout: the store
 * sits in Git's common directory, the same scope as the claim leases. A loop
 * running from a SEPARATE clone of the same repo has its own common dir and
 * shares no blocker with these.
 *
 * The mutators are pure over a Store value (no fs, no clock), so a caller can
 * run several of them inside one `withStore` critical section. Every read
 * prunes waiters whose supervisor died, and a blocker left with no waiters
 * goes with them. A missing or unreadable file reads as empty — a supervisor
 * wait degrades, it does not throw — and the next write repairs it.
 *
 *   blocker-store.ts join --key K --loop L [--pr N] [--summary S] [--cleared-by X]
 *                         [--base-sha S] [--base-failing true|false] [--json]
 *   blocker-store.ts leave --key K --loop L
 *   blocker-store.ts list [--json]
 *
 * `join` needs RALPH_SUPERVISOR_PID, the waiting supervisor's pid. The file
 * is `blockerStorePath()` of the working directory unless RALPH_BLOCKER_STORE
 * names another, which is how the tests keep out of this checkout's git dir.
 * 64 is a usage error.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { commonStatePath } from "./claim-lease";
import { identity, partyAlive } from "./host-lease";

export interface Waiter {
  loop: string;
  pr: number | null;
  pid: number;
  host: string;
  since: string;
  lastSeen: string;
}

export interface Blocker {
  key: string;
  summary: string;
  clearedBy: string | null;
  first: string;
  /** The base branch's head when the episode opened; null is "not known". */
  baseSha: string | null;
  /** Whether the key's check was failing on `baseSha` then; null is "not known". */
  baseFailing: boolean | null;
  notified: string | null;
  exhaustedNotified: string | null;
  clearedAt: string | null;
  waiters: Record<string, Waiter>;
}

export interface Store {
  version: 1;
  blockers: Record<string, Blocker>;
}

export interface JoinInput {
  key: string;
  loop: string;
  pid: number;
  host: string;
  pr?: number | null;
  summary?: string | null;
  clearedBy?: string | null;
  baseSha?: string | null;
  baseFailing?: boolean | null;
}

export type Alive = (party: { pid: number; host: string }) => boolean;

export const emptyStore = (): Store => ({ version: 1, blockers: {} });

/* --------------------------------------------------------------------------
 * Pure mutators.
 * ----------------------------------------------------------------------- */

/**
 * `loop` waits on `input.key`. A rejoin inside the episode refreshes the
 * waiter (`lastSeen`, and its pr/pid/host, which a restarted supervisor
 * changes) and fills `summary`/`clearedBy` when given; the episode's own
 * fields — `first`, `baseSha`, `baseFailing` and the set-once marks — stay as
 * they were.
 */
export function join(store: Store, input: JoinInput, now: string): Blocker {
  const existing = store.blockers[input.key];
  const waiter = (since: string): Waiter => ({
    loop: input.loop, pr: input.pr ?? null, pid: input.pid, host: input.host, since, lastSeen: now,
  });

  if (existing && existing.clearedAt === null) {
    if (input.summary) existing.summary = input.summary;
    if (input.clearedBy) existing.clearedBy = input.clearedBy;
    const prior = existing.waiters[input.loop];
    existing.waiters[input.loop] = prior
      ? { ...prior, pr: input.pr ?? prior.pr, pid: input.pid, host: input.host, lastSeen: now }
      : waiter(now);
    return existing;
  }

  // A new key, or a cleared one coming back: a new episode. Waiters from the
  // cleared episode are dropped, because one that has not polled since the
  // clear must not count as the new episode's second waiter.
  const blocker: Blocker = {
    key: input.key,
    summary: input.summary || existing?.summary || input.key,
    clearedBy: input.clearedBy || existing?.clearedBy || null,
    first: now,
    baseSha: input.baseSha ?? null,
    baseFailing: input.baseFailing ?? null,
    notified: null,
    exhaustedNotified: null,
    clearedAt: null,
    waiters: { [input.loop]: waiter(now) },
  };
  store.blockers[input.key] = blocker;
  return blocker;
}

/** `loop` stops waiting on `key`; a blocker nobody waits on is gone. Returns whether it waited. */
export function leave(store: Store, key: string, loop: string): boolean {
  const blocker = store.blockers[key];
  if (!blocker?.waiters[loop]) return false;
  delete blocker.waiters[loop];
  if (Object.keys(blocker.waiters).length === 0) delete store.blockers[key];
  return true;
}

type OnceField = "notified" | "exhaustedNotified" | "clearedAt";

function setOnce(store: Store, key: string, field: OnceField, now: string): boolean {
  const blocker = store.blockers[key];
  if (!blocker || blocker[field] !== null) return false;
  blocker[field] = now;
  return true;
}

/** The operator was told once for this episode. Returns whether this call set it. */
export const markNotified = (store: Store, key: string, now: string): boolean => setOnce(store, key, "notified", now);

/** The episode's shared budget ran out and that was said once. Returns whether this call set it. */
export const markExhausted = (store: Store, key: string, now: string): boolean =>
  setOnce(store, key, "exhaustedNotified", now);

/** The blocker cleared; the next join opens a new episode. Returns whether this call set it. */
export const markCleared = (store: Store, key: string, now: string): boolean => setOnce(store, key, "clearedAt", now);

/** Drop waiters `alive` says are dead, and blockers left with nobody. Returns the waiters dropped. */
export function prune(store: Store, alive: Alive): number {
  let dropped = 0;
  for (const [key, blocker] of Object.entries(store.blockers)) {
    for (const [loop, waiter] of Object.entries(blocker.waiters)) {
      if (alive({ pid: waiter.pid, host: waiter.host })) continue;
      delete blocker.waiters[loop];
      dropped++;
    }
    if (Object.keys(blocker.waiters).length === 0) delete store.blockers[key];
  }
  return dropped;
}

/* --------------------------------------------------------------------------
 * The file and its lock.
 * ----------------------------------------------------------------------- */

export function blockerStorePath(gitDir = process.cwd()): string {
  return commonStatePath("ralph-blockers.json", gitDir);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A waiter record as written, or null when it could not have been: such a record is dropped, not trusted. */
function readWaiter(loop: string, value: unknown): Waiter | null {
  if (!isRecord(value)) return null;
  const { pid, host, since, lastSeen, pr } = value;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !text(host) || !text(since) || !text(lastSeen)) return null;
  return { loop, pr: typeof pr === "number" && Number.isInteger(pr) ? pr : null, pid, host: host as string, since: since as string, lastSeen: lastSeen as string };
}

/**
 * A blocker record as written, or null. The set-once fields are normalised to
 * null when absent: `join` and `setOnce` test `=== null`, so an `undefined`
 * there would open a new episode on every join and never record a mark.
 */
function readBlocker(key: string, value: unknown): Blocker | null {
  if (!isRecord(value) || !isRecord(value.waiters) || !text(value.first)) return null;
  const waiters: Record<string, Waiter> = {};
  for (const [loop, raw] of Object.entries(value.waiters)) {
    const waiter = readWaiter(loop, raw);
    if (waiter) waiters[loop] = waiter;
  }
  return {
    key,
    summary: text(value.summary) ?? key,
    clearedBy: text(value.clearedBy),
    first: value.first as string,
    baseSha: text(value.baseSha),
    baseFailing: typeof value.baseFailing === "boolean" ? value.baseFailing : null,
    notified: text(value.notified),
    exhaustedNotified: text(value.exhaustedNotified),
    clearedAt: text(value.clearedAt),
    waiters,
  };
}

/**
 * The raw file, unpruned: `withStore` and `listStore` are the reads that
 * prune, so a caller deciding anything goes through one of them.
 *
 * Unlike the host lease, an unreadable store — or any record in it — is read
 * as empty rather than thrown: the caller is a supervisor wait, which must
 * degrade to its own backoff instead of stopping the loop. The next write
 * repairs the file.
 */
export function readStore(path: string): Store {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return emptyStore(); }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.blockers)) return emptyStore();
  const store = emptyStore();
  for (const [key, raw] of Object.entries(value.blockers)) {
    const blocker = readBlocker(key, raw);
    if (blocker) store.blockers[key] = blocker;
  }
  return store;
}

function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Read, prune, modify, write under an exclusive lock file. Every critical
 * section is a few milliseconds; a lock older than 30s belongs to a process
 * that died inside one, and is broken. The attempt cap throws rather than
 * spinning forever.
 */
export async function withStore<T>(path: string, critical: (store: Store) => T, alive: Alive = partyAlive): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (attempt > 200) throw new Error(`the blocker store is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      const store = readStore(path);
      prune(store, alive);
      const result = critical(store);
      writeStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}

/** The store as it stands, pruned; the pruning is written back so every reader sees it. */
export const listStore = (path: string, alive: Alive = partyAlive): Promise<Store> =>
  withStore(path, (store) => structuredClone(store), alive);

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const USAGE =
  "usage: blocker-store.ts join --key K --loop L [--pr N] [--summary S] [--cleared-by X] [--base-sha S] [--base-failing true|false] [--json] | leave --key K --loop L | list [--json]";

/** A flag's value; `null` when the flag is given without one, so that is a usage error rather than a silent skip. */
const flag = (argv: string[], name: string): string | undefined | null => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
};

const usage = (): number => { console.error(USAGE); return 64; };

export async function main(argv: string[], env = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const path = env.RALPH_BLOCKER_STORE?.trim() || blockerStorePath(process.cwd());
  const json = rest.includes("--json");

  if (command === "list") {
    const store = await listStore(path);
    if (json) { console.log(JSON.stringify(store, null, 2)); return 0; }
    const blockers = Object.values(store.blockers);
    if (blockers.length === 0) console.log("no loop waits on a blocker");
    for (const blocker of blockers) {
      const loops = Object.keys(blocker.waiters).join(", ");
      console.log(`${blocker.key}: ${loops} since ${blocker.first}${blocker.clearedAt ? ` (cleared ${blocker.clearedAt})` : ""}`);
    }
    return 0;
  }

  if (command !== "join" && command !== "leave") return usage();
  const key = flag(rest, "key");
  const loop = flag(rest, "loop");
  if (!key || !loop) return usage();

  if (command === "leave") {
    const waited = await withStore(path, (store) => leave(store, key, loop));
    console.log(waited ? `${loop} no longer waits on ${key}` : `${loop} was not waiting on ${key}`);
    return 0;
  }

  const prRaw = flag(rest, "pr");
  const pr = prRaw === undefined ? null : Number(prRaw);
  if (pr !== null && (!Number.isInteger(pr) || pr <= 0)) return usage();
  const failingRaw = flag(rest, "base-failing");
  if (failingRaw !== undefined && failingRaw !== "true" && failingRaw !== "false") return usage();
  const summary = flag(rest, "summary");
  const clearedBy = flag(rest, "cleared-by");
  const baseSha = flag(rest, "base-sha");
  if (summary === null || clearedBy === null || baseSha === null) return usage();

  // `--loop` names the waiter, so identity() gets it; the run id only has to
  // be present. The pid must be RALPH_SUPERVISOR_PID, not our parent: the
  // caller runs inside a pipeline whose shell dies long before the
  // supervisor, and identity() would fall back to that shell, whose waiter the
  // next read prunes as dead. So a join without it is refused, not recorded.
  const supervisor = Number(env.RALPH_SUPERVISOR_PID);
  if (!Number.isInteger(supervisor) || supervisor <= 0) {
    console.error("blocker-store: join needs RALPH_SUPERVISOR_PID, the waiting supervisor's pid");
    return usage();
  }
  const party = identity({ ...env, RALPH_LOOP_NAME: loop, RALPH_RUN_ID: env.RALPH_RUN_ID || "blocker-store" });
  const blocker = await withStore(path, (store) => structuredClone(join(store, {
    key, loop, pid: party.pid, host: party.host, pr,
    summary, clearedBy, baseSha,
    baseFailing: failingRaw === undefined ? null : failingRaw === "true",
  }, new Date().toISOString())));
  if (json) { console.log(JSON.stringify(blocker, null, 2)); return 0; }
  const count = Object.keys(blocker.waiters).length;
  console.log(`${loop} waits on ${key}: ${count} waiter${count === 1 ? "" : "s"} since ${blocker.first}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`blocker-store: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
