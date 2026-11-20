/**
 * The doctor gate's GitHub budget.
 *
 * `ci-doctor/gate.ts` polls forever: on an idle loop it is the one caller with
 * no natural stopping point, and its reads are the ones nobody is waiting for.
 * So every `gh` call it makes is asked for here first, against a ledger that
 * lives in the ci-health store rather than in the process — a doctor restarted
 * every few minutes must not get itself a fresh budget each time.
 *
 * Two things are budgeted, on one shared counter. A CADENCE is a standing read
 * the gate wants on every poll and may have every fifteen minutes (the
 * `ci-health` issue registry, the parked-ticket search). A one-off is a read
 * caused by something new — a newly parked ticket's block comments — and is
 * simply `affordable` or not.
 *
 * Everything here but `recordSpend` is pure and total: an `undefined` ledger is
 * a legal input to all of it, because the store's field is optional and a
 * hand-edited store must never throw a gate over.
 */
import { GH_CALLS_PER_HOUR, type GhLedger } from "./store";

const HOUR_MS = 3_600_000;

/** A named read the gate may run at most once per `everySeconds`. */
export interface Cadence {
  key: string;
  everySeconds: number;
}

/** `gh issue list --label ci-health --state all` — the case registry. */
export const REGISTRY: Cadence = { key: "registry", everySeconds: 900 };

/** The search for coder tickets parked on a flake. */
export const PARKED: Cadence = { key: "parked", everySeconds: 900 };

export const emptyLedger = (nowMs: number): GhLedger => ({
  hourStart: new Date(nowMs).toISOString(),
  count: 0,
  at: {},
});

/** An ISO time as milliseconds, or null when it is not one. */
function at(iso: unknown): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The ledger as it stands at `nowMs`, rolled over when that has left its hour.
 * Never mutates its input. A ledger that is absent or does not parse reads as
 * empty, so a bad field costs the gate one hour's caution and nothing else.
 */
export function ledgerAt(ledger: GhLedger | undefined, nowMs: number): GhLedger {
  const start = at(ledger?.hourStart);
  const count = ledger?.count;
  const map = ledger?.at;
  if (start === null || typeof count !== "number" || !Number.isFinite(count) || typeof map !== "object" || map === null) {
    return emptyLedger(nowMs);
  }
  const marks: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) if (typeof value === "string") marks[key] = value;
  // A clock that went backwards past the anchor is as much a new hour as one
  // that ran past its end: either way the anchor no longer bounds `nowMs`.
  const inHour = nowMs >= start && nowMs - start < HOUR_MS;
  return {
    hourStart: inHour ? new Date(start).toISOString() : new Date(nowMs).toISOString(),
    count: inHour ? Math.max(0, Math.floor(count)) : 0,
    at: marks,
  };
}

/** How many calls are still affordable in the hour `nowMs` falls in. */
export function remaining(ledger: GhLedger | undefined, nowMs: number): number {
  return Math.max(0, GH_CALLS_PER_HOUR - ledgerAt(ledger, nowMs).count);
}

/** May the gate spend `calls` one-off calls now? */
export function affordable(ledger: GhLedger | undefined, calls: number, nowMs: number): boolean {
  return calls <= remaining(ledger, nowMs);
}

/**
 * May the gate run `cadence` now? No when its interval has not elapsed, and no
 * when the budget is spent — the cadence is a ceiling on frequency, not a
 * reservation.
 */
export function due(ledger: GhLedger | undefined, cadence: Cadence, nowMs: number): boolean {
  if (!affordable(ledger, 1, nowMs)) return false;
  const last = at(ledgerAt(ledger, nowMs).at[cadence.key]);
  if (last === null) return true;
  // A mark in the future is a clock that went backwards; waiting is the safe
  // reading, because treating it as elapsed would spend the budget on every
  // poll until the clock caught up.
  if (last > nowMs) return false;
  return nowMs - last >= cadence.everySeconds * 1000;
}

/**
 * Record `calls` calls, and — when `cadence` is given — stamp that read as
 * having just run. Returns the new ledger; never mutates its input.
 */
export function spend(
  ledger: GhLedger | undefined,
  calls: number,
  nowMs: number,
  cadence?: Cadence,
): GhLedger {
  const base = ledgerAt(ledger, nowMs);
  const marks = { ...base.at };
  if (cadence) marks[cadence.key] = new Date(nowMs).toISOString();
  return { hourStart: base.hourStart, count: base.count + Math.max(0, Math.floor(calls)), at: marks };
}

/** This gate's ledger out of the store's per-loop map. */
export const ledgerOf = (store: { gh?: Record<string, GhLedger> }, loop: string): GhLedger | undefined =>
  store.gh?.[loop];
