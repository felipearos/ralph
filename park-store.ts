#!/usr/bin/env bun
/**
 * The durable record of what each parked ticket waits on.
 *
 * Why it exists: #774, for #770. When a loop parks a ticket under its
 * `<loop>-blocked` label, the condition that would let the ticket resume
 * (a referenced PR merging, a check going green, a label coming off) had
 * nowhere durable to live: the only per-wait record, `blocker-store.ts`, is
 * dropped with the supervisor that wrote it, so a restart, a reboot or an
 * oomd kill would lose it and the ticket would stay parked until a person
 * noticed. A wake condition must outlive that supervisor, so it is written here.
 *
 * How it differs from `blocker-store.ts`: that store is keyed by CAUSE and
 * shared by the loops waiting on it, and every read prunes waiters whose
 * supervisor died — right for "who is waiting now", wrong here. This store is
 * keyed by TICKET, one park per ticket, and is NEVER pruned on liveness: a
 * park whose loop is gone is exactly the record that has to survive. A park
 * leaves only by `unpark`, or by a new `park` of the same ticket replacing it.
 *
 * Evaluating a condition is not this module's job. It validates a
 * condition's shape (no network, no repo) and stores it; the probe reads
 * this API and decides whether the condition holds.
 *
 * The mutators are pure over a Store value (no fs, no clock). A missing or
 * unreadable file, or any malformed record in it, reads as empty or drops
 * that record — a supervisor path degrades, it does not throw. A write keeps
 * the records it could not read, and refuses a file a newer version wrote,
 * since those may be another loop's parks in a shape this code predates.
 *
 *   park-store.ts park --ticket N --loop L --label L-blocked [--pr N]
 *                      --condition JSON --summary S [--json]
 *   park-store.ts unpark --ticket N
 *   park-store.ts list [--json]
 *   park-store.ts check --condition JSON [--pr N]
 *
 * The file is `parkStorePath()` of the working directory unless
 * RALPH_PARK_STORE names another, which is how the tests keep out of this
 * checkout's git dir. RALPH_PARK_BUDGET_HOURS (default 48) sets how long a
 * park waits before it counts as expired. 64 is a usage or validation error.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { commonStatePath } from "./claim-lease";

export type Condition =
  | { kind: "reference"; ref: string }
  | { kind: "check"; name: string; on: "pr" | "main" }
  | { kind: "step"; check: string; step: string }
  | { kind: "label-removed"; label: string };

/**
 * Every condition kind, in order. A list beside the union because the
 * dashboard's contract keeps a hand copy it validates against, and
 * `dashboard/contract-parity.test.ts` pins that copy to this one; the
 * `satisfies` keeps this list from naming a kind the union lacks.
 */
export const CONDITION_KINDS = ["reference", "check", "step", "label-removed"] as const satisfies readonly Condition["kind"][];

export interface Park {
  ticket: number;
  loop: string;
  /** The `<loop>-blocked` label the park was recorded with. */
  label: string;
  pr: number | null;
  condition: Condition;
  summary: string;
  since: string;
  lastChecked: string | null;
  budgetUntil: string;
  escalatedAt: string | null;
}

export interface Store {
  version: 1;
  parks: Record<string, Park>;
}

export interface ParkInput {
  ticket: number;
  loop: string;
  label: string;
  pr?: number | null;
  condition: Condition;
  summary: string;
}

/** A park as listed: every stored field, plus whether its budget has run out. */
export type ListedPark = Park & { expired: boolean };

export const DEFAULT_BUDGET_HOURS = 48;

/**
 * Ten years. Past about 2.4e9 hours `budgetUntil` is beyond the last date
 * JavaScript can print and `park` would throw, so a value meant as "never
 * expire" must fall back like any other unusable one.
 */
export const MAX_BUDGET_HOURS = 87_600;

export const emptyStore = (): Store => ({ version: 1, parks: {} });

/* --------------------------------------------------------------------------
 * Validation.
 * ----------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A string that is non-empty after trim, trimmed; anything else is null. */
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

// The syntax of `parseClearedBy` in backoff.ts. Copied rather than imported:
// backoff.ts pulls in host-lease, and this store must not depend on liveness.
const LOCAL_REF = /^#[1-9]\d*$/;
const FULL_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;

const FIELDS: Record<Condition["kind"], string[]> = {
  reference: ["kind", "ref"],
  check: ["kind", "name", "on"],
  step: ["kind", "check", "step"],
  "label-removed": ["kind", "label"],
};

/**
 * The condition `raw` describes, normalised (strings trimmed), or the reason
 * it is refused. `pr` is the park's PR: a check on the PR needs one. The
 * shape is exact — an extra or missing field is refused, because a probe
 * reading a field this module never checked would be guessing.
 */
export function validateCondition(raw: unknown, pr: number | null): Condition | string {
  if (!isRecord(raw)) return "the condition must be a JSON object";
  const kind = raw.kind;
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) {
    return `unknown condition kind ${JSON.stringify(kind)}: expected reference, check, step or label-removed`;
  }
  const allowed = FIELDS[kind as Condition["kind"]];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return `a ${kind} condition has no field ${extra.map((key) => JSON.stringify(key)).join(", ")}`;

  switch (kind as Condition["kind"]) {
    case "reference": {
      const ref = text(raw.ref);
      if (!ref || !(LOCAL_REF.test(ref) || FULL_REF.test(ref))) {
        return `a reference condition needs ref "#n" or "owner/repo#n", got ${JSON.stringify(raw.ref)}`;
      }
      return { kind: "reference", ref };
    }
    case "check": {
      const name = text(raw.name);
      if (!name) return "a check condition needs a non-empty name";
      if (raw.on !== "pr" && raw.on !== "main") return `a check condition needs on "pr" or "main", got ${JSON.stringify(raw.on)}`;
      if (raw.on === "pr" && pr === null) return "a check condition on \"pr\" needs the park's PR: pass --pr";
      return { kind: "check", name, on: raw.on };
    }
    case "step": {
      const check = text(raw.check);
      const step = text(raw.step);
      if (!check || !step) return "a step condition needs a non-empty check and step";
      return { kind: "step", check, step };
    }
    case "label-removed": {
      const label = text(raw.label);
      if (!label || !label.endsWith("-blocked")) {
        return `a label-removed condition needs a label ending in -blocked, got ${JSON.stringify(raw.label)}`;
      }
      return { kind: "label-removed", label };
    }
  }
}

/** The park `input` would record, normalised, or the reason it is refused. */
export function validateParkInput(input: ParkInput): ParkInput | string {
  if (!isPositiveInteger(input.ticket)) return "the ticket must be a positive integer";
  const loop = text(input.loop);
  if (!loop) return "the loop must be non-empty";
  const label = text(input.label);
  if (label !== `${loop}-blocked`) return `the label must be the loop's own blocked label, ${loop}-blocked`;
  const pr = input.pr ?? null;
  if (pr !== null && !isPositiveInteger(pr)) return "the pr must be a positive integer";
  const summary = text(input.summary);
  if (!summary) return "the summary must be non-empty";
  const condition = validateCondition(input.condition, pr);
  if (typeof condition === "string") return condition;
  return { ticket: input.ticket, loop, label, pr, condition, summary };
}

/**
 * The budget a park gets, in hours: a positive finite number, else the
 * default. An unusable value falls back rather than throws — the caller is a
 * supervisor path.
 */
export function budgetHours(raw: string | undefined): number {
  const hours = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(hours) && hours > 0 && hours <= MAX_BUDGET_HOURS ? hours : DEFAULT_BUDGET_HOURS;
}

/* --------------------------------------------------------------------------
 * Pure mutators.
 * ----------------------------------------------------------------------- */

/**
 * Record that `input.ticket` waits on `input.condition`. A ticket parked
 * again is a new park, not a refresh: its budget restarts and the probe and
 * escalation marks are cleared, since they spoke of the old condition.
 * Throws on an invalid input, so a `withStore` around it writes nothing.
 */
export function park(store: Store, input: ParkInput, now: string, hours = DEFAULT_BUDGET_HOURS): Park {
  const valid = validateParkInput(input);
  if (typeof valid === "string") throw new Error(valid);
  const record: Park = {
    ticket: valid.ticket,
    loop: valid.loop,
    label: valid.label,
    pr: valid.pr ?? null,
    condition: valid.condition,
    summary: valid.summary,
    since: now,
    lastChecked: null,
    budgetUntil: new Date(Date.parse(now) + hours * 3_600_000).toISOString(),
    escalatedAt: null,
  };
  store.parks[String(valid.ticket)] = record;
  return record;
}

/** `ticket` no longer waits on anything. Returns whether it was parked. */
export function unpark(store: Store, ticket: number): boolean {
  const key = String(ticket);
  if (!store.parks[key]) return false;
  delete store.parks[key];
  return true;
}

/*
 * The probe's mutators (#775). Each is keyed on the ticket AND the `since`
 * the caller read: the probe reads GitHub outside the lock, and a park
 * replaced in that window (a new block on the same ticket) is a different
 * wait that the stale read says nothing about. Each returns whether it acted.
 */

const current = (store: Store, ticket: number, since: string): Park | null => {
  const record = store.parks[String(ticket)];
  return record !== undefined && record.since === since ? record : null;
};

/** The park read at `since` was probed at `now`. */
export function markChecked(store: Store, ticket: number, since: string, now: string): boolean {
  const record = current(store, ticket, since);
  if (record === null) return false;
  record.lastChecked = now;
  return true;
}

/**
 * The park read at `since` has escalated at `now`. False when it already
 * had, so of several sweeps racing on one store only one pushes.
 */
export function markEscalated(store: Store, ticket: number, since: string, now: string): boolean {
  const record = current(store, ticket, since);
  if (record === null || record.escalatedAt !== null) return false;
  record.escalatedAt = now;
  record.lastChecked = now;
  return true;
}

/**
 * The park read at `since` is about to be probed at `now`: stamped BEFORE the
 * reads, so a sweep killed mid-read (a hung Buildkite, the caller's timeout)
 * cannot leave the same park first in line for every later sweep, and so two
 * sweeps on one host do not both read it. False when it was replaced, or when
 * another sweep checked it less than `intervalMs` ago.
 */
export function claimCheck(store: Store, ticket: number, since: string, now: string, intervalMs: number): boolean {
  const record = current(store, ticket, since);
  if (record === null) return false;
  const last = record.lastChecked === null ? NaN : Date.parse(record.lastChecked);
  if (Number.isFinite(last) && Date.parse(now) - last < intervalMs) return false;
  record.lastChecked = now;
  return true;
}

/** `unpark`, but only the park read at `since`; a newer park of the ticket stays. */
export function unparkIf(store: Store, ticket: number, since: string): boolean {
  if (current(store, ticket, since) === null) return false;
  return unpark(store, ticket);
}

/* --------------------------------------------------------------------------
 * The file and its lock.
 * ----------------------------------------------------------------------- */

export function parkStorePath(gitDir = process.cwd()): string {
  return commonStatePath("ralph-parks.json", gitDir);
}

/** The store every writer and reader uses: RALPH_PARK_STORE when set, so a test never touches the host's. */
export function configuredParkStorePath(env: Record<string, string | undefined>, cwd: string): string {
  return env.RALPH_PARK_STORE?.trim() || parkStorePath(cwd);
}

const stamp = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A stamp that is a date: `expired` compares against it, and NaN would never expire. */
const date = (value: unknown): string | null => {
  const raw = stamp(value);
  return raw !== null && Number.isFinite(Date.parse(raw)) ? raw : null;
};

/** A park record as written, or null when it could not have been: such a record is dropped, not trusted. */
function readPark(key: string, value: unknown): Park | null {
  if (!/^[1-9]\d*$/.test(key) || !isRecord(value)) return null;
  const ticket = Number(key);
  if (value.ticket !== ticket) return null;
  const pr = value.pr ?? null;
  if (pr !== null && !isPositiveInteger(pr)) return null;
  const loop = text(value.loop);
  const label = text(value.label);
  const summary = text(value.summary);
  const since = date(value.since);
  const budgetUntil = date(value.budgetUntil);
  if (!loop || label !== `${loop}-blocked` || !summary || !since || !budgetUntil) return null;
  const condition = validateCondition(value.condition, pr);
  if (typeof condition === "string") return null;
  return {
    ticket,
    loop,
    label,
    pr,
    condition,
    summary,
    since,
    lastChecked: stamp(value.lastChecked),
    budgetUntil,
    escalatedAt: stamp(value.escalatedAt),
  };
}

/**
 * The file as it stands. An unreadable store — or any record in it — reads as
 * empty rather than throwing: the caller is a supervisor path, which must
 * degrade instead of stopping the loop. The next write repairs the file.
 */
export const readStore = (path: string): Store => readFile(path).store;

/**
 * The store, plus what a write must not destroy: the records this code could
 * not read, and whether the file is a newer version than this code knows.
 * Loops are restarted one at a time, so for a while an older loop shares the
 * file with a newer one; if the older one's write dropped what it could not
 * read, one park or unpark would erase every newer park, and those tickets
 * would stay blocked until a person noticed — the failure this store exists
 * to end.
 */
function readFile(path: string): { store: Store; unread: Record<string, unknown>; newer: boolean } {
  const store = emptyStore();
  const unread: Record<string, unknown> = {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return { store, unread, newer: false }; }
  if (isRecord(value) && typeof value.version === "number" && value.version > 1) return { store, unread, newer: true };
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.parks)) return { store, unread, newer: false };
  for (const [key, raw] of Object.entries(value.parks)) {
    const record = readPark(key, raw);
    if (record) store.parks[key] = record;
    else unread[key] = raw;
  }
  return { store, unread, newer: false };
}

function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const STALE_LOCK_MS = 30_000;

/**
 * Wait past the point a lock counts as stale: a caller that gave up sooner
 * would fail every park for the first half-minute after a writer was killed
 * mid-write, which is just when a restarted supervisor parks.
 */
const LOCK_WAIT = { attempts: 700, delayMs: 50 };

/**
 * Read, modify, write under an exclusive lock file. Every critical section is
 * a few milliseconds; a lock older than 30s belongs to a process that died
 * inside one, and is broken. The attempt cap throws rather than spinning
 * forever. A `critical` that throws writes nothing, and so does a file a
 * newer version wrote. Records this code cannot read are written back as they
 * were.
 */
export async function withStore<T>(
  path: string,
  critical: (store: Store) => T,
  wait: { attempts: number; delayMs: number } = LOCK_WAIT,
): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock); } catch {}
      if (attempt >= wait.attempts) throw new Error(`the park store is locked: ${lock}`);
      await sleep(wait.delayMs);
      continue;
    }
    try {
      const { store, unread, newer } = readFile(path);
      if (newer) throw new Error(`the park store was written by a newer ralph; restart this loop to use it: ${path}`);
      const result = critical(store);
      // A record this code could not read is kept, unless this write replaced it.
      for (const [key, raw] of Object.entries(unread)) if (!(key in store.parks)) (store.parks as Record<string, unknown>)[key] = raw;
      writeStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}

/**
 * Every park, by ticket, each marked `expired` once `now` is past its budget.
 * No lock: nothing is pruned on read, so there is nothing to write back.
 */
export function listStore(path: string, now: string = new Date().toISOString()): ListedPark[] {
  const at = Date.parse(now);
  return Object.values(readStore(path).parks)
    .sort((a, b) => a.ticket - b.ticket)
    .map((record) => ({ ...record, expired: at > Date.parse(record.budgetUntil) }));
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const USAGE =
  "usage: park-store.ts park --ticket N --loop L --label L-blocked [--pr N] --condition JSON --summary S [--json] | unpark --ticket N | list [--json] | check --condition JSON [--pr N]";

/** A flag's value; `null` when the flag is given without one, so that is a usage error rather than a silent skip. */
const flag = (argv: string[], name: string): string | undefined | null => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
};

const usage = (): number => { console.error(USAGE); return 64; };

const refuse = (reason: string): number => { console.error(`park-store: ${reason}`); return 64; };

/** A positive integer flag; undefined when absent, null when given but not one. */
function integerFlag(argv: string[], name: string): number | undefined | null {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  if (raw === null || !/^[1-9]\d*$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** The `--condition` JSON, or the reason it cannot be read. */
function conditionFlag(argv: string[]): { raw: unknown } | string {
  const raw = flag(argv, "condition");
  if (raw === undefined || raw === null) return "--condition needs a JSON value";
  try { return { raw: JSON.parse(raw) }; } catch { return `--condition is not JSON: ${raw}`; }
}

export async function main(argv: string[], env = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");

  // `check` validates and writes nothing, so it resolves no path either.
  if (command === "check") {
    const pr = integerFlag(rest, "pr");
    if (pr === null) return refuse("--pr must be a positive integer");
    const parsed = conditionFlag(rest);
    if (typeof parsed === "string") return refuse(parsed);
    const condition = validateCondition(parsed.raw, pr ?? null);
    if (typeof condition === "string") return refuse(condition);
    console.log(JSON.stringify(condition));
    return 0;
  }

  const path = configuredParkStorePath(env, process.cwd());

  if (command === "list") {
    const parks = listStore(path);
    if (json) { console.log(JSON.stringify(parks, null, 2)); return 0; }
    if (parks.length === 0) console.log("no ticket is parked");
    for (const record of parks) {
      const pr = record.pr === null ? "" : ` pr #${record.pr}`;
      console.log(
        `#${record.ticket} (${record.loop}${pr}): ${record.condition.kind} since ${record.since}, budget until ${record.budgetUntil}${record.expired ? " EXPIRED" : ""} — ${record.summary}`,
      );
    }
    return 0;
  }

  if (command !== "park" && command !== "unpark") return usage();
  const ticket = integerFlag(rest, "ticket");
  if (ticket === undefined || ticket === null) return refuse("--ticket must be a positive integer");

  if (command === "unpark") {
    const was = await withStore(path, (store) => unpark(store, ticket));
    console.log(was ? `#${ticket} is no longer parked` : `#${ticket} was not parked`);
    return 0;
  }

  const loop = flag(rest, "loop");
  const label = flag(rest, "label");
  const summary = flag(rest, "summary");
  if (!loop?.trim()) return refuse("--loop needs a value");
  if (!label?.trim()) return refuse("--label needs a value");
  if (!summary?.trim()) return refuse("--summary needs a value");
  const pr = integerFlag(rest, "pr");
  if (pr === null) return refuse("--pr must be a positive integer");
  const parsed = conditionFlag(rest);
  if (typeof parsed === "string") return refuse(parsed);

  // Validated before the lock, so a refusal creates neither the file nor its lock.
  const input = validateParkInput({ ticket, loop, label, pr: pr ?? null, condition: parsed.raw as Condition, summary });
  if (typeof input === "string") return refuse(input);
  const hours = budgetHours(env.RALPH_PARK_BUDGET_HOURS);
  const record = await withStore(path, (store) => structuredClone(park(store, input, new Date().toISOString(), hours)));
  if (json) { console.log(JSON.stringify(record, null, 2)); return 0; }
  console.log(`#${record.ticket} parked by ${record.loop} on ${record.condition.kind} until ${record.budgetUntil}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`park-store: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
