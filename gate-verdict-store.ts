#!/usr/bin/env bun
/**
 * The per-loop record of the verdict a loop's intake gate is holding on.
 *
 * Why it exists: #771. The gate says "work available — frontier ticket #12",
 * the iteration looks and hands back ALL_BLOCKED or COMPLETE, and the next
 * gate says the same thing again: without a memory of that disagreement the
 * loop starts session after session for a verdict it already refuted. This
 * record is that memory. `ralph.sh` writes it when an iteration refutes the
 * gate and clears it when the verdict changes or work flows again; the gate
 * reads it (read-only) to hold instead of waking the loop for the same
 * subject, until a budget measured from `first` is spent.
 *
 * There is AT MOST ONE record per loop worktree. A verdict is compared by
 * kind and ticket only — titles and trailing notes change without the
 * subject changing. A different subject replaces the record and restarts the
 * budget clock, because the hold is about that subject, not about the loop.
 *
 * A "hold released" hand-back marks the record released rather than deleting
 * it: the gate's definite "no work" includes "every candidate is held", which
 * a transient read error also produces. Deleting the record there would let
 * one flaky poll restart the budget clock and the disagreement streak, so a
 * ticket that flaps in and out of the frontier would cost a session per flap
 * forever. A released record is not a hold; the same subject written over it
 * re-holds with its original `first`, once silently and from then on as a
 * counted disagreement (`reholds`), so a flapping ticket stops for a human.
 *
 * A missing or unreadable record reads as "no hold" — the gate then behaves
 * as it did before this record existed — and the next write repairs it.
 *
 *   gate-verdict-store.ts read [--json]          0 with a record, 1 with none
 *   gate-verdict-store.ts write --case <text>    0 written or re-held, 3 same, 2 not holdable, 1 failure
 *   gate-verdict-store.ts release                0 released/already/absent, 1 failure
 *   gate-verdict-store.ts clear [--keep-if-case <text>]   0 cleared/kept/absent, 1 failure
 *   gate-verdict-store.ts notify                 0 marked, 1 no record or failure
 *   gate-verdict-store.ts notified               0 when the record says notified and is not released, 1 otherwise
 *   gate-verdict-store.ts describe               one human line; 1 with no record
 *
 * The file is `.ralph/logs/gate-verdict.json` of the working directory unless
 * RALPH_GATE_VERDICT_STORE names another, which is how the tests keep out of
 * this checkout's `.ralph/`. 64 is a usage error.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type HeldKind = "frontier-ticket" | "closable-spec";

export interface VerdictSubject {
  kind: HeldKind;
  ticket: number;
}

export interface HeldVerdict extends VerdictSubject {
  first: string;
  notified: boolean;
  /** The gate handed the hold back on a definite "no work"; the record keeps its clock but holds nothing. */
  released: boolean;
  /** How many times this subject was held again after a release. */
  reholds: number;
}

export const gateVerdictPath = (env: Record<string, string | undefined>, cwd: string): string =>
  env.RALPH_GATE_VERDICT_STORE?.trim() || resolve(cwd, ".ralph/logs/gate-verdict.json");

/* --------------------------------------------------------------------------
 * The verdict's subject.
 * ----------------------------------------------------------------------- */

// The gate prefix is optional, so the caller may pass the whole gate line or
// only the case text after "work available — ".
const GATE_PREFIX = /^(?:[A-Za-z0-9_.-]+: )?work available — /;
// Anchored at the case text's start: a title that happens to contain
// "frontier ticket #9" sits after the first " — " and never matches here.
const FRONTIER = /^frontier ticket #([1-9]\d*)\b/;
const CLOSABLE = /^spec #([1-9]\d*) has no open children left\b/;

export function verdictSubject(text: string): VerdictSubject | null {
  const verdict = text.trim().replace(GATE_PREFIX, "");
  const frontier = FRONTIER.exec(verdict);
  if (frontier) return { kind: "frontier-ticket", ticket: Number(frontier[1]) };
  const closable = CLOSABLE.exec(verdict);
  if (closable) return { kind: "closable-spec", ticket: Number(closable[1]) };
  return null;
}

export const sameSubject = (a: VerdictSubject | null | undefined, b: VerdictSubject | null | undefined): boolean =>
  !!a && !!b && a.kind === b.kind && a.ticket === b.ticket;

export const describeSubject = (subject: VerdictSubject): string =>
  subject.kind === "frontier-ticket" ? `frontier ticket #${subject.ticket}` : `closable spec #${subject.ticket}`;

/* --------------------------------------------------------------------------
 * The record on disk.
 * ----------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The record, or null. Anything wrong with it reads as "no hold" rather than
 * throwing: the reader is the gate or a supervisor step, which must fall back
 * to its old behaviour, not stop the loop.
 */
export function readHeld(path: string): HeldVerdict | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (!isRecord(value) || value.version !== 1) return null;
  const { kind, ticket, first, notified } = value;
  // Absent in a record written before release existed: read as never released.
  // Present but null is malformed like any other wrong type, hence `in`, not `??`.
  const released = "released" in value ? value.released : false;
  const reholds = "reholds" in value ? value.reholds : 0;
  if (kind !== "frontier-ticket" && kind !== "closable-spec") return null;
  if (typeof ticket !== "number" || !Number.isInteger(ticket) || ticket <= 0) return null;
  if (typeof first !== "string" || Number.isNaN(Date.parse(first))) return null;
  if (typeof notified !== "boolean") return null;
  if (typeof released !== "boolean") return null;
  if (typeof reholds !== "number" || !Number.isInteger(reholds) || reholds < 0) return null;
  return { kind, ticket, first, notified, released, reholds };
}

function writeRecord(path: string, held: HeldVerdict): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, ...held }, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Run `critical` under an exclusive lock file. Each critical section is a few
 * milliseconds; a lock older than 30s belongs to a process that died inside
 * one, and is broken. The attempt cap (about 40s of 50ms waits) outlasts that
 * threshold, so a dead holder's lock is always broken before a waiter gives
 * up; it throws rather than spinning forever.
 */
async function withLock<T>(path: string, critical: () => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (attempt > 800) throw new Error(`the gate verdict record is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      return critical();
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}

/**
 * Hold on `subject`. The same subject already held is left untouched and
 * reported as "same": that is how the caller learns a hold did not take
 * effect. The same subject over a RELEASED record holds again with the
 * original `first` and `notified`: the first time as "reheld", every later
 * time as "same" (held all the same), so a verdict that keeps coming back
 * counts as a disagreement instead of costing a session per flap. A
 * different subject replaces the record with a fresh one.
 */
export const writeHeld = (path: string, subject: VerdictSubject, now: Date): Promise<"written" | "reheld" | "same"> =>
  withLock(path, () => {
    const held = readHeld(path);
    if (held !== null && sameSubject(held, subject)) {
      if (!held.released) return "same";
      writeRecord(path, { ...held, released: false, reholds: held.reholds + 1 });
      return held.reholds === 0 ? "reheld" : "same";
    }
    writeRecord(path, {
      kind: subject.kind,
      ticket: subject.ticket,
      first: now.toISOString(),
      notified: false,
      released: false,
      reholds: 0,
    });
    return "written";
  });

/**
 * Mark the hold released: the gate saw a definite "no work". The record and
 * its clock stay, so a verdict that comes back is a re-hold, not a fresh one.
 */
export const releaseHeld = (path: string): Promise<"released" | "already" | "absent"> =>
  withLock(path, () => {
    const held = readHeld(path);
    if (held === null) return "absent";
    if (held.released) return "already";
    writeRecord(path, { ...held, released: true });
    return "released";
  });

/**
 * Drop the record, unless it holds `keepIfSubject` — a verdict that has not
 * changed keeps its clock, released or not: a released record of the same
 * subject is what lets the next write see the verdict came back.
 */
export const clearHeld = (path: string, keepIfSubject?: VerdictSubject | null): Promise<"cleared" | "kept" | "absent"> =>
  withLock(path, () => {
    if (keepIfSubject && sameSubject(readHeld(path), keepIfSubject)) return "kept";
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    return "cleared";
  });

/** Record that the operator was told about this hold, so it is told once. */
export const markNotified = (path: string): Promise<boolean> =>
  withLock(path, () => {
    const held = readHeld(path);
    if (!held) return false;
    writeRecord(path, { ...held, notified: true });
    return true;
  });

/* --------------------------------------------------------------------------
 * The budget.
 * ----------------------------------------------------------------------- */

export const DEFAULT_HOLD_BUDGET_HOURS = 48;

/** RALPH_GATE_HOLD_BUDGET_HOURS: unset is the default; anything but a positive integer is null, for the caller to decide. */
export function holdBudgetHours(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOLD_BUDGET_HOURS;
  const value = raw.trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** Seconds since the hold began; a `first` in the future (clock stepped back) is age 0. */
export const holdAge = (held: HeldVerdict, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(held.first)) / 1000));

export const budgetSpent = (held: HeldVerdict, now: Date, hours: number): boolean =>
  now.getTime() - Date.parse(held.first) >= hours * 3_600_000;

/** A compact duration, `2d3h` / `5h12m` / `45m` / `30s`. Local on purpose: the gate imports this module, not the reverse. */
export function compactDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const USAGE =
  "usage: gate-verdict-store.ts read [--json] | write --case <text> | release | clear [--keep-if-case <text>] | notify | notified | describe";

/** A flag's value; `null` when the flag is given without one, so that is a usage error rather than a silent skip. */
const flag = (argv: string[], name: string): string | undefined | null => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
};

const usage = (): number => { console.error(USAGE); return 64; };

async function run(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const [command, ...rest] = argv;
  const path = gateVerdictPath(env, process.cwd());

  switch (command) {
    case "read": {
      const held = readHeld(path);
      if (!held) return 1;
      if (rest.includes("--json")) console.log(JSON.stringify({ version: 1, ...held }));
      else console.log(`${held.kind} ${held.ticket} ${held.first} ${held.notified}`);
      return 0;
    }
    case "write": {
      const text = flag(rest, "case");
      if (!text) return usage();
      const subject = verdictSubject(text);
      if (!subject) {
        console.log(`gate-verdict-store: no holdable subject in: ${text}`);
        return 2;
      }
      const outcome = await writeHeld(path, subject, new Date());
      if (outcome === "reheld") {
        console.log(`gate-verdict-store: holding again on ${describeSubject(subject)}, a verdict that came back after a release; held since ${readHeld(path)?.first ?? "?"}`);
        return 0;
      }
      if (outcome === "same") {
        console.log(`gate-verdict-store: the same verdict (${describeSubject(subject)}) was already held since ${readHeld(path)?.first ?? "?"}`);
        return 3;
      }
      console.log(`gate-verdict-store: holding on ${describeSubject(subject)}`);
      return 0;
    }
    case "release": {
      if (rest.length > 0) return usage();
      console.log(`gate-verdict-store: ${await releaseHeld(path)}`);
      return 0;
    }
    case "clear": {
      const text = flag(rest, "keep-if-case");
      if (text === null) return usage();
      const outcome = await clearHeld(path, text === undefined ? null : verdictSubject(text));
      console.log(`gate-verdict-store: ${outcome}`);
      return 0;
    }
    case "notify":
      return (await markNotified(path)) ? 0 : 1;
    case "notified": {
      // A released record holds nothing, so the loop must not read as blocked on it.
      const held = readHeld(path);
      return held !== null && held.notified && !held.released ? 0 : 1;
    }
    case "describe": {
      const held = readHeld(path);
      if (!held) return 1;
      console.log(`${describeSubject(held)}, held since ${held.first} (${compactDuration(holdAge(held, new Date()))})`);
      return 0;
    }
    default:
      return usage();
  }
}

/** Never throws: the shell reads the exit code, and a failure is 1. */
export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  try {
    return await run(argv, env);
  } catch (error) {
    console.error(`gate-verdict-store: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
