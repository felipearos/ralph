// @vitest-environment node
/**
 * The gate's GitHub budget, pinned.
 *
 * The acceptance criterion this file exists for is a ceiling: at most 12 `gh`
 * calls per idle hour, however many polls that hour contains. So the cases
 * below are the ways a ceiling leaks — a rollover that also resets the
 * cadences, a malformed ledger read as a fresh budget, a clock that went
 * backwards, a `spend` that mutates the caller's copy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PARKED,
  REGISTRY,
  affordable,
  due,
  emptyLedger,
  ledgerAt,
  ledgerOf,
  remaining,
  spend,
} from "./gh-budget";
import { GH_CALLS_PER_HOUR, readStore, withStore, type GhLedger } from "./store";

const T0 = Date.parse("2026-09-30T10:00:00.000Z");
const MINUTE = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-budget-"));
  dirs.push(dir);
  return join(dir, "ralph", "ci-health.json");
}

describe("the hourly ceiling", () => {
  it("affords twelve calls and no more", () => {
    let ledger: GhLedger | undefined;
    for (let call = 0; call < GH_CALLS_PER_HOUR; call++) {
      expect(affordable(ledger, 1, T0)).toBe(true);
      ledger = spend(ledger, 1, T0);
    }
    expect(ledger?.count).toBe(GH_CALLS_PER_HOUR);
    expect(remaining(ledger, T0)).toBe(0);
    expect(affordable(ledger, 1, T0)).toBe(false);
  });

  it("refuses a batch larger than what is left", () => {
    const ledger = spend(undefined, 10, T0);
    expect(affordable(ledger, 2, T0)).toBe(true);
    expect(affordable(ledger, 3, T0)).toBe(false);
  });

  it("rolls the count over at the hour, and keeps the cadence marks", () => {
    const spent = spend(spend(undefined, 11, T0), 1, T0, REGISTRY);
    expect(remaining(spent, T0 + 59 * MINUTE)).toBe(0);

    const next = ledgerAt(spent, T0 + 61 * MINUTE);
    expect(next.count).toBe(0);
    expect(next.hourStart).toBe(new Date(T0 + 61 * MINUTE).toISOString());
    // The mark has to survive: reset with the count, every hour boundary would
    // re-run both standing reads at once.
    expect(next.at[REGISTRY.key]).toBe(new Date(T0).toISOString());
    expect(due(spent, REGISTRY, T0 + 61 * MINUTE)).toBe(true);
  });

  it("does not let a spent hour leak into the next one", () => {
    const spent = spend(undefined, GH_CALLS_PER_HOUR, T0);
    expect(affordable(spent, 1, T0 + 30 * MINUTE)).toBe(false);
    expect(affordable(spent, 1, T0 + 60 * MINUTE)).toBe(true);
  });
});

describe("cadences", () => {
  it("are due first, then not again until the interval has elapsed", () => {
    expect(due(undefined, REGISTRY, T0)).toBe(true);
    const ran = spend(undefined, 1, T0, REGISTRY);
    expect(due(ran, REGISTRY, T0 + 14 * MINUTE)).toBe(false);
    expect(due(ran, REGISTRY, T0 + 15 * MINUTE)).toBe(true);
  });

  it("are independent of each other", () => {
    const ran = spend(undefined, 1, T0, REGISTRY);
    expect(due(ran, REGISTRY, T0 + MINUTE)).toBe(false);
    expect(due(ran, PARKED, T0 + MINUTE)).toBe(true);
  });

  it("yield to a spent budget", () => {
    const spent = spend(undefined, GH_CALLS_PER_HOUR, T0);
    expect(due(spent, REGISTRY, T0)).toBe(false);
  });

  it("wait out a mark in the future rather than reading it as elapsed", () => {
    const skewed: GhLedger = { hourStart: new Date(T0).toISOString(), count: 1, at: { [REGISTRY.key]: new Date(T0 + 30 * MINUTE).toISOString() } };
    expect(due(skewed, REGISTRY, T0)).toBe(false);
  });
});

describe("a ledger that cannot be read", () => {
  it("is treated as absent rather than thrown over", () => {
    const empty = emptyLedger(T0);
    for (const bad of [
      undefined,
      { hourStart: "", count: 0, at: {} },
      { hourStart: "not a time", count: 0, at: {} },
      { hourStart: new Date(T0).toISOString(), count: Number.NaN, at: {} },
      { hourStart: new Date(T0).toISOString(), count: 3, at: null },
    ] as (GhLedger | undefined)[]) {
      expect(ledgerAt(bad, T0)).toEqual(empty);
      expect(remaining(bad, T0)).toBe(GH_CALLS_PER_HOUR);
    }
  });

  it("drops a non-string mark but keeps the rest", () => {
    const mixed = { hourStart: new Date(T0).toISOString(), count: 1, at: { registry: 7, parked: new Date(T0).toISOString() } } as unknown as GhLedger;
    expect(ledgerAt(mixed, T0).at).toEqual({ parked: new Date(T0).toISOString() });
  });
});

describe("spend", () => {
  it("does not mutate its input", () => {
    const before = emptyLedger(T0);
    const snapshot = structuredClone(before);
    spend(before, 4, T0, REGISTRY);
    expect(before).toEqual(snapshot);
  });
});

describe("the store's per-loop map", () => {
  it("gives each doctor its own allowance, so two never starve one another", async () => {
    const path = storeFile();
    await withStore(path, (store) => {
      store.gh = { ralph: spend(undefined, GH_CALLS_PER_HOUR, T0, REGISTRY) };
    });
    const store = readStore(path);
    expect(remaining(ledgerOf(store, "ralph"), T0)).toBe(0);
    expect(remaining(ledgerOf(store, "rafa"), T0)).toBe(GH_CALLS_PER_HOUR);
    expect(due(ledgerOf(store, "rafa"), REGISTRY, T0)).toBe(true);
  });

  it("is absent from a store nothing has budgeted in", async () => {
    const path = storeFile();
    await withStore(path, (store) => {
      store.cursor = "";
    });
    expect(readStore(path).gh).toBeUndefined();
    expect(ledgerOf(readStore(path), "ralph")).toBeUndefined();
  });
});
