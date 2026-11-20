import { describe, expect, it } from "vitest";

import { MANAGED_STATES, mergeCases, rejectionStands, type Classification } from "./classify";
import { emptyStore, type Case, type CaseState, type CiHealthStore, type Evidence } from "./store";

/*
 * `mergeCases` as a unit. `scan.test.ts` reaches it only through recorded
 * Buildkite fixtures, which cannot express the one thing #240 turns on: a
 * store whose case a doctor rejected, re-folded against the SAME rows.
 */

const KEY = "flake:src/a.test.ts > flaps";

const seen = (build: number): Evidence => ({
  build,
  branch: "pr-branch",
  commit: `c${build}`,
  kind: "assertion",
  line: `FAIL src/a.test.ts > flaps (build ${build})`,
});

const kase = (over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state: "confirmed",
  evidence: [seen(100)],
  cost72h: { redBuilds: 3, mainReds: 1, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const rejected = (over: Partial<Case> = {}): Case =>
  kase({ state: "retired", rejectedAt: { build: 100, at: "2026-10-07T08:00:00.000Z", reason: "a ratchet, not a flake" }, ...over });

/** A store holding one case, ready to fold into. */
const storeWith = (value: Case, key = KEY): CiHealthStore => {
  const store = emptyStore();
  store.cases[key] = structuredClone(value);
  return store;
};

/** What the rows now propose. The default re-proposes a live confirmed flake. */
const proposing = (value: Case = kase(), key = KEY): Classification => ({
  cases: { [key]: structuredClone(value) },
  main: { state: "green", since: "2026-10-07T00:00:00.000Z", build: 120 },
});

const fold = (before: Case, next: Classification, key = KEY): Case | undefined => {
  const store = storeWith(before, key);
  mergeCases(store, next);
  return store.cases[key];
};

describe("rejectionStands", () => {
  it("is false for a case no doctor rejected", () => {
    // classify.ts's own 48-hour stale-retire reaches `retired` without ever
    // writing the field. The two meanings of `retired` part here.
    expect(rejectionStands(kase({ state: "retired" }), [seen(999)])).toBe(false);
    expect(rejectionStands(kase({ rejectedAt: null }), [])).toBe(false);
  });

  it("stands against evidence at or below the boundary, and falls only above it", () => {
    const value = rejected();
    expect(rejectionStands(value, [])).toBe(true);
    expect(rejectionStands(value, [seen(99)])).toBe(true);
    expect(rejectionStands(value, [seen(100)])).toBe(true);
    expect(rejectionStands(value, [seen(101)])).toBe(false);
    expect(rejectionStands(value, [seen(99), seen(101)])).toBe(false);
  });
});

describe("mergeCases and a doctor's rejection", () => {
  it("keeps a rejected case retired when the rows propose the same evidence again (AC 1)", () => {
    // The defect this ticket exists for: before #240 this folded back to
    // `confirmed`, and the gate re-offered the case on every poll.
    const after = fold(rejected(), proposing(kase({ evidence: [seen(100)] })));
    expect(after).toMatchObject({
      state: "retired",
      rejectedAt: { build: 100, reason: "a ratchet, not a flake" },
    });
  });

  it("brings the case back clean on evidence from a newer build (AC 2)", () => {
    const after = fold(rejected(), proposing(kase({ evidence: [seen(100), seen(140)] })));
    expect(after?.state).toBe("confirmed");
    expect(after?.rejectedAt).toBeNull();
  });

  it("is not overturned by an older build, nor by the boundary build itself", () => {
    expect(fold(rejected(), proposing(kase({ evidence: [seen(80)] })))?.state).toBe("retired");
    expect(fold(rejected(), proposing(kase({ evidence: [seen(100)] })))?.state).toBe("retired");
  });

  it("keeps a rejected case whose rows have left the window, with its cost zeroed", () => {
    // Deleting it would drop the only record of the decision, and the next red
    // build would rebuild the case with the rejection gone.
    const store = storeWith(rejected());
    mergeCases(store, { cases: {}, main: emptyStore().main });
    expect(store.cases[KEY]).toMatchObject({
      state: "retired",
      rejectedAt: { build: 100 },
      cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
    });
  });

  it("does not outrank a later stage: a filed case carrying a rejection stays filed", () => {
    const after = fold(rejected({ state: "filed", issue: 412 }), proposing());
    expect(MANAGED_STATES.has("filed")).toBe(true);
    expect(after).toMatchObject({ state: "filed", issue: 412 });
  });

  it("leaves classify's own stale-retire folding exactly as it did", () => {
    // The regression guard for the two meanings of `retired`. A stale-retired
    // case has no `rejectedAt`, so it takes the proposal...
    const stale = kase({ state: "retired" });
    expect(fold(stale, proposing(kase({ state: "confirmed" })))?.state).toBe("confirmed");
    // ...and is still swept away when its rows leave the window.
    const store = storeWith(stale);
    mergeCases(store, { cases: {}, main: emptyStore().main });
    expect(store.cases[KEY]).toBeUndefined();
  });

  it("still keeps what later stages own, and the sticky confirmed flake", () => {
    // Guards the fields the rejection patch sits among (#156's `notified` and
    // `fixedAt`), so a future edit to this fold cannot quietly drop them.
    const before = kase({ issue: 7, pr: 9, fixAttempts: 1, notified: "occ-1", fixedAt: { build: 50, at: "x" }, unparks: { a: ["t"] } });
    const after = fold(before, proposing(kase({ state: "candidate", issue: null, pr: null, fixAttempts: 0 })));
    expect(after).toMatchObject({
      state: "confirmed",
      issue: 7,
      pr: 9,
      fixAttempts: 1,
      notified: "occ-1",
      fixedAt: { build: 50 },
      unparks: { a: ["t"] },
    });
  });

  it("writes a case the store has never seen through untouched", () => {
    const store = emptyStore();
    mergeCases(store, proposing());
    expect(store.cases[KEY]).toMatchObject({ state: "confirmed" });
  });

  it("offers every state to the fold without throwing", () => {
    // Cheap exhaustiveness: the ternary gained a branch, so every state is
    // folded once to prove none of them now lands somewhere unintended.
    const states: CaseState[] = ["candidate", "confirmed", "filed", "fixing", "fixed", "retired", "handed-off"];
    for (const state of states) {
      const after = fold(kase({ state }), proposing(kase({ state: "confirmed" })));
      expect(after?.state).toBe(MANAGED_STATES.has(state) ? state : "confirmed");
    }
  });
});
