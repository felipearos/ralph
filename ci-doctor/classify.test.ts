import { describe, expect, it } from "vitest";

import { classify, MANAGED_STATES, mergeCases, RED_RUN_MIN, rejectionStands, type Classification } from "./classify";
import {
  emptyStore,
  failureSignature,
  type BuildRecord,
  type Case,
  type CaseState,
  type CiHealthStore,
  type Evidence,
  type Failure,
} from "./store";

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

describe("failureSignature", () => {
  it("keeps error codes and positions, and strips what changes per build", () => {
    const a = failureSignature("assertion", "error XX000 at 2026-11-20T01:02:03.456Z in db/migrate.ts:12:5 after 1.5s (abc1234def)");
    const b = failureSignature("assertion", "error  XX000 at 2026-11-21T09:00:00Z in db/migrate.ts:12:5 after 230ms (0fedcba9876)");
    expect(a).toBe(b);
    expect(a).toContain("XX000");
    expect(a).toContain("db/migrate.ts:12:5");
    expect(a).not.toContain("2026-11-20");
    expect(a.startsWith("assertion|")).toBe(true);
    expect(failureSignature("assertion", "08006 ECONNREFUSED")).toBe("assertion|08006 ECONNREFUSED");
    expect(failureSignature("assertion", "error XX000")).not.toBe(failureSignature("assertion", "error 08006"));
  });
});

/*
 * #57: a rejection keyed on the failure's signature, and a continuous red run
 * that "same tree, both colours" must not read as a flake.
 */

const STEP = "production-migrations";
const outage = (build: number, at = `2026-11-2${build % 10}T01:00:00.000Z`): Evidence => ({
  build,
  branch: "main",
  commit: `c${build}`,
  kind: "assertion",
  line: `error: XX000 database unreachable at ${at}`,
  step: STEP,
});

const signed = (over: Partial<Case> = {}): Case =>
  kase({
    state: "retired",
    evidence: [outage(100)],
    rejectedAt: {
      build: 100,
      at: "2026-11-20T08:00:00.000Z",
      reason: "the database is down",
      signatures: [failureSignature("assertion", outage(100).line)],
    },
    ...over,
  });

const build = (number: number, over: Partial<BuildRecord> = {}): BuildRecord => ({
  number,
  branch: "main",
  commit: `c${number}`,
  state: "failed",
  source: "webhook",
  createdAt: `2026-11-20T00:${String(number % 60).padStart(2, "0")}:00.000Z`,
  startedAt: `2026-11-20T00:${String(number % 60).padStart(2, "0")}:00.000Z`,
  finishedAt: `2026-11-20T00:${String(number % 60).padStart(2, "0")}:30.000Z`,
  pr: null,
  prs: [],
  steps: { [STEP]: "failed" },
  tree: `t${number}`,
  parent: null,
  sincePrevious: null,
  changedFiles: null,
  branchPaths: null,
  ...over,
});

describe("rejectionStands and the failure signature (#57)", () => {
  it("stands against newer builds failing with the same signature, timestamp aside", () => {
    expect(rejectionStands(signed(), [outage(100), outage(101), outage(107)])).toBe(true);
    expect(rejectionStands(signed(), [outage(101)], [build(101), build(107)])).toBe(true);
  });

  it("is overturned by a newer build failing with a new signature", () => {
    const other: Evidence = { ...outage(102), line: "error: 08006 connection reset" };
    expect(rejectionStands(signed(), [outage(101), other])).toBe(false);
  });

  it("is overturned once a tested build after the boundary passed the step", () => {
    const green = build(103, { state: "passed", steps: { [STEP]: "passed" } });
    expect(rejectionStands(signed(), [outage(104)], [build(101), green, build(104)])).toBe(false);
    // A scheduled run is not a tested build, and a green at the boundary is not after it.
    expect(rejectionStands(signed(), [outage(104)], [{ ...green, source: "schedule" }])).toBe(true);
    expect(rejectionStands(signed(), [outage(104)], [{ ...green, number: 100 }])).toBe(true);
    // A row with no step never reads "passed" off an unrelated green build.
    expect(rejectionStands(signed(), [{ ...outage(104), step: null }], [build(103, { state: "passed", steps: {} })])).toBe(true);
  });

  it("keeps today's rule for a rejection with no signatures, or malformed ones", () => {
    const old = signed();
    delete old.rejectedAt!.signatures;
    expect(rejectionStands(old, [outage(100)])).toBe(true);
    expect(rejectionStands(old, [outage(101)])).toBe(false);
    const malformed = signed({ rejectedAt: { build: 100, at: "x", reason: "y", signatures: "assertion|x" as unknown as string[] } });
    expect(rejectionStands(malformed, [outage(101)])).toBe(false);
    const mixed = signed({ rejectedAt: { build: 100, at: "x", reason: "y", signatures: [1] as unknown as string[] } });
    expect(rejectionStands(mixed, [outage(101)])).toBe(false);
  });

  it("keeps a rejected case retired when a fresh red carries the same signature", () => {
    const store = storeWith(signed());
    store.builds = [build(100), build(101)];
    mergeCases(store, proposing(kase({ state: "confirmed", evidence: [outage(100), outage(101)] })));
    expect(store.cases[KEY]).toMatchObject({
      state: "retired",
      rejectedAt: { build: 100, reason: "the database is down" },
    });
  });
});

describe("a continuous red run is not same tree, both colours (#57)", () => {
  const TEST = "db/migrate.test.ts > applies";
  const QUEUE = "mergify/merge-queue/main-1";
  const red = (number: number, at: string): Failure => ({
    testId: TEST,
    file: "db/migrate.test.ts",
    build: number,
    branch: QUEUE,
    commit: `c${number}`,
    job: `j${number}`,
    step: STEP,
    kind: "assertion",
    line: "error: XX000 database unreachable",
    finishedAt: at,
    retried: false,
  });
  const green = (number: number): BuildRecord =>
    build(number, { branch: QUEUE, state: "passed", steps: { [STEP]: "passed" }, tree: "T" });
  const failed = (number: number, tree = `t${number}`): BuildRecord => build(number, { branch: QUEUE, tree });
  const NOW = Date.parse("2026-11-20T02:00:00.000Z");

  /** A store of `builds`, with a red row for every failed one. */
  const scenario = (builds: BuildRecord[]): CiHealthStore => {
    const store = emptyStore();
    store.builds = builds;
    store.failures = builds.filter((b) => b.state === "failed").map((b) => red(b.number, b.finishedAt));
    return store;
  };

  it("retires the flake and proposes an infra red-run case when the test is red on every build since the green", () => {
    const store = scenario([green(10), failed(11, "T"), failed(12), failed(13)]);
    const { cases } = classify(store, NOW);
    expect(RED_RUN_MIN).toBe(3);
    expect(cases[`flake:${TEST}`]).toMatchObject({
      state: "retired",
      redRun: { step: STEP, since: 10, builds: 3 },
      rule: `red on every build of ${STEP} since #10 (3 builds)`,
    });
    expect(cases[`infra:red-run:${STEP}`]).toMatchObject({
      kind: "infra",
      state: "confirmed",
      redRun: { step: STEP, since: 10, builds: 3 },
      rule: `red on every build of ${STEP} since #10 (3 builds)`,
    });
    expect(cases[`infra:red-run:${STEP}`]!.evidence.map((seen) => seen.build)).toEqual([11, 12, 13]);
  });

  it("still confirms an alternating flake on one tree", () => {
    const store = scenario([green(10), failed(11, "T"), green(12), failed(13, "T")]);
    const { cases } = classify(store, NOW);
    expect(cases[`flake:${TEST}`]).toMatchObject({ state: "confirmed", rule: "same tree, both colours" });
    expect(cases[`infra:red-run:${STEP}`]).toBeUndefined();
  });

  it("still confirms a red or two after an older green of the same tree", () => {
    for (const builds of [[green(10), failed(11, "T")], [green(10), failed(11, "T"), failed(12)]]) {
      const store = scenario(builds);
      // A timeout, so a lone red is a candidate without a second build of its line.
      store.failures = store.failures.map((row) => ({ ...row, kind: "timeout" }));
      const { cases } = classify(store, NOW);
      expect(cases[`flake:${TEST}`]).toMatchObject({ state: "confirmed", rule: "same tree, both colours" });
      expect(cases[`flake:${TEST}`]!.redRun).toBeUndefined();
    }
  });

  it("is unaffected by a green of the same tree after the red (a retry, a rerun)", () => {
    const store = scenario([failed(10, "T"), green(11), failed(12), failed(13), failed(14)]);
    expect(classify(store, NOW).cases[`flake:${TEST}`]).toMatchObject({ state: "confirmed", rule: "same tree, both colours" });
  });

  it("moves a previously confirmed flake off confirmed when the rows become a red run", () => {
    const store = scenario([green(10), failed(11, "T"), failed(12), failed(13)]);
    store.cases[`flake:${TEST}`] = kase({ state: "confirmed", rule: "same tree, both colours" });
    mergeCases(store, classify(store, NOW));
    expect(store.cases[`flake:${TEST}`]).toMatchObject({ state: "retired", redRun: { since: 10, builds: 3 } });
    expect(store.cases[`infra:red-run:${STEP}`]?.state).toBe("confirmed");
  });
});
