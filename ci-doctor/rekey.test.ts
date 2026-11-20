// @vitest-environment node
/**
 * What the #237 rekey promises: a jest identity stored before the digest could
 * name its file ends up on the keyed one, carrying its filing with it, and no
 * case is ever moved onto a guess.
 */
import { describe, expect, it } from "vitest";

import { adoptCase, fileByBareTestId, rekeyJestIdentities, splitCaseKey } from "./rekey";
import { emptyStore, type Case, type CaseState, type CiHealthStore, type Failure } from "./store";

const FILE = "app/components/__tests__/activity.test.tsx";
const BARE = "Activity tab show grouping > groups by day";

const row = (testId: string, file: string | null, over: Partial<Failure> = {}): Failure => ({
  testId,
  file,
  build: 3053,
  branch: "main",
  commit: "abc",
  job: `job-${testId}-${file ?? "null"}`,
  step: "mobile",
  kind: "assertion",
  line: "expect(received).toBe(expected)",
  finishedAt: "2026-10-07T00:00:00.000Z",
  retried: false,
  ...over,
});

const kase = (state: CaseState, over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state,
  evidence: [],
  cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const storeWith = (rows: Failure[], cases: Record<string, Case> = {}): CiHealthStore => ({
  ...emptyStore(),
  failures: rows,
  cases,
});

describe("the bare → file mapping", () => {
  it("reads it off the rows that now carry a file", () => {
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE), row(BARE, null)]);
    expect(fileByBareTestId(store)).toEqual(new Map([[BARE, FILE]]));
  });

  it("drops a bare id two files claim", () => {
    const store = storeWith([row("s > t", "a.test.ts"), row("s > t", "b.test.ts"), row("s > t", null)]);
    expect(fileByBareTestId(store).has("s > t")).toBe(false);
    // And the ambiguous row is left exactly as it was.
    expect(rekeyJestIdentities(store)).toEqual({ rows: 0, cases: {} });
    expect(store.failures[2]).toMatchObject({ testId: "s > t", file: null });
  });
});

describe("rekeying the rows and cases a mobile job left behind (#237 AC 2)", () => {
  it("moves the old key's filing onto the keyed one, so nothing is paged twice", () => {
    const store = storeWith(
      [row(`${FILE} > ${BARE}`, FILE), row(BARE, null)],
      { [`flake:${BARE}`]: kase("filed", { issue: 2456, pr: 77, fixAttempts: 1, notified: "ci-incident:x", rule: "main flip" }) },
    );

    const result = rekeyJestIdentities(store);

    expect(result).toEqual({ rows: 1, cases: { [`flake:${BARE}`]: `flake:${FILE} > ${BARE}` } });
    expect(store.failures[1]).toMatchObject({ testId: `${FILE} > ${BARE}`, file: FILE });
    expect(store.cases[`flake:${BARE}`]).toBeUndefined();
    expect(store.cases[`flake:${FILE} > ${BARE}`]).toMatchObject({
      state: "filed",
      issue: 2456,
      pr: 77,
      fixAttempts: 1,
      notified: "ci-incident:x",
      rule: "main flip",
    });
  });

  it("folds the old identity into a case the new key already has, keeping the further-along state", () => {
    const store = storeWith(
      [row(`${FILE} > ${BARE}`, FILE), row(BARE, null)],
      {
        [`flake:${BARE}`]: kase("filed", { issue: 2456, fixAttempts: 2 }),
        [`flake:${FILE} > ${BARE}`]: kase("candidate", { cost72h: { redBuilds: 4, mainReds: 0, dequeues: 0 } }),
      },
    );

    rekeyJestIdentities(store);

    const moved = store.cases[`flake:${FILE} > ${BARE}`]!;
    expect(moved.state).toBe("filed");
    expect(moved.issue).toBe(2456);
    expect(moved.fixAttempts).toBe(2);
    // The new key's own evidence is kept: `classify` owns it, not the rekey.
    expect(moved.cost72h.redBuilds).toBe(4);
  });

  it("never lets the old key overrule a filing the new key already has", () => {
    const store = storeWith(
      [row(`${FILE} > ${BARE}`, FILE), row(BARE, null)],
      {
        [`flake:${BARE}`]: kase("confirmed", { issue: 1, fixAttempts: 1 }),
        [`flake:${FILE} > ${BARE}`]: kase("fixing", { issue: 2 }),
      },
    );

    rekeyJestIdentities(store);

    expect(store.cases[`flake:${FILE} > ${BARE}`]).toMatchObject({ state: "fixing", issue: 2 });
  });

  it("rekeys a regression and a pr-specific case, and leaves infra and parked keys alone", () => {
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE), row(BARE, null)], {
      [`regression:${BARE}`]: kase("filed", { kind: "regression", issue: 9 }),
      [`pr-specific:rafa/237-x:${BARE}`]: kase("confirmed", { kind: "pr-specific" }),
      [`infra:${BARE}`]: kase("confirmed", { kind: "infra" }),
      "parked:1234": kase("filed", { kind: "parked" }),
    });

    const result = rekeyJestIdentities(store);

    expect(Object.keys(result.cases).sort()).toEqual([`pr-specific:rafa/237-x:${BARE}`, `regression:${BARE}`]);
    expect(store.cases[`regression:${FILE} > ${BARE}`]).toMatchObject({ kind: "regression", issue: 9 });
    expect(store.cases[`pr-specific:rafa/237-x:${FILE} > ${BARE}`]).toMatchObject({ kind: "pr-specific" });
    expect(store.cases[`infra:${BARE}`]).toBeDefined();
    expect(store.cases["parked:1234"]).toBeDefined();
  });

  it("carries the retry ledger and a revert's case key across", () => {
    const store: CiHealthStore = {
      ...storeWith([row(`${FILE} > ${BARE}`, FILE), row(BARE, null)], { [`flake:${BARE}`]: kase("fixing") }),
      retries: { day: "2026-10-07", count: 1, byCase: { [BARE]: "job-9" } },
      reverts: { sha1: { case: `flake:${BARE}`, issue: 5, pr: 6, forwardIssue: null, state: "open" } },
    };

    rekeyJestIdentities(store);

    expect(store.retries.byCase).toEqual({ [`${FILE} > ${BARE}`]: "job-9" });
    expect(store.reverts.sha1!.case).toBe(`flake:${FILE} > ${BARE}`);
  });

  it("is a no-op on a store with nothing left to rekey, and idempotent", () => {
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE)], { [`flake:${FILE} > ${BARE}`]: kase("filed") });
    expect(rekeyJestIdentities(store)).toEqual({ rows: 0, cases: {} });

    const pending = storeWith([row(`${FILE} > ${BARE}`, FILE), row(BARE, null)], { [`flake:${BARE}`]: kase("filed") });
    rekeyJestIdentities(pending);
    const after = JSON.stringify(pending);
    expect(rekeyJestIdentities(pending)).toEqual({ rows: 0, cases: {} });
    expect(JSON.stringify(pending)).toBe(after);
  });

  it("migrates a case whose own rows were pruned, because the case is what pages", () => {
    // The flake last failed four days ago, so `prune` took its rows — but
    // `prune` never touches `cases` and `mergeCases` keeps a `filed` one for
    // good, so there is no "aging out" to wait for. The keyed row that just
    // arrived is mapping enough.
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE)], { [`flake:${BARE}`]: kase("filed", { issue: 3 }) });

    expect(rekeyJestIdentities(store).cases).toEqual({ [`flake:${BARE}`]: `flake:${FILE} > ${BARE}` });

    expect(store.cases[`flake:${BARE}`]).toBeUndefined();
    expect(store.cases[`flake:${FILE} > ${BARE}`]).toMatchObject({ issue: 3, state: "filed" });
  });

  it("records the key the issue's marker carries, so the filing is not re-filed", () => {
    // `case-issue.ts` re-checks the marker against the key it was asked about,
    // so a moved case key alone would read its own issue as somebody else's.
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE)], { [`flake:${BARE}`]: kase("filed", { issue: 3 }) });
    rekeyJestIdentities(store);
    expect(store.cases[`flake:${FILE} > ${BARE}`]!.filedAs).toBe(`flake:${BARE}`);
  });

  it("records nothing for a case that was never filed: there is no marker to bridge", () => {
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE)], { [`flake:${BARE}`]: kase("confirmed") });
    rekeyJestIdentities(store);
    expect(store.cases[`flake:${FILE} > ${BARE}`]!.filedAs).toBeUndefined();
  });

  it("keeps the ORIGINAL filing key when a case is rekeyed twice", () => {
    // The marker on GitHub is still the first one; a second move must not
    // overwrite the bridge with a key no body ever carried.
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE)], {
      [`flake:${BARE}`]: kase("filed", { issue: 3, filedAs: "flake:older > key" }),
    });
    rekeyJestIdentities(store);
    expect(store.cases[`flake:${FILE} > ${BARE}`]!.filedAs).toBe("flake:older > key");
  });

  it("moves the case lease with the case, so the holder still names what it is on", () => {
    const store: CiHealthStore = {
      ...storeWith([row(`${FILE} > ${BARE}`, FILE)], { [`flake:${BARE}`]: kase("fixing") }),
      leases: { [`flake:${BARE}`]: { run: "run-a", loop: "doc", pid: 1, host: "fedora", expiresAt: "2026-10-07T00:02:00.000Z" } },
    };

    rekeyJestIdentities(store);

    expect(store.leases[`flake:${BARE}`]).toBeUndefined();
    expect(store.leases[`flake:${FILE} > ${BARE}`]).toMatchObject({ run: "run-a", loop: "doc" });
  });

  it("rewrites a parked case's `rule` and its unpark keys, which are test ids and case keys", () => {
    // `parked:<n>` itself is an issue number and is never rekeyed, but
    // `gate.ts`'s `parkedCase` puts a TEST ID in `rule` and `unpark.ts` keys
    // `unparks` by `flake:<test id>` — the lookup `gate.ts`'s `actionable`
    // makes. Left bare, the gate offers the ticket again on every poll.
    const store = storeWith([row(`${FILE} > ${BARE}`, FILE)], {
      [`flake:${BARE}`]: kase("confirmed"),
      "parked:1234": kase("candidate", { kind: "parked", rule: BARE, unparks: { [`flake:${BARE}`]: ["2026-10-07T00:00:00.000Z"] } }),
    });

    rekeyJestIdentities(store);

    const parked = store.cases["parked:1234"]!;
    expect(parked.rule).toBe(`${FILE} > ${BARE}`);
    expect(Object.keys(parked.unparks)).toEqual([`flake:${FILE} > ${BARE}`]);
    expect(store.cases["parked:1234"]).toBeDefined();
  });
});

describe("splitCaseKey", () => {
  it("splits the three key shapes whose tail is a test id", () => {
    expect(splitCaseKey("flake:a.test.ts > t")).toEqual({ prefix: "flake:", subject: "a.test.ts > t" });
    expect(splitCaseKey("regression:a.test.ts > t")).toEqual({ prefix: "regression:", subject: "a.test.ts > t" });
    expect(splitCaseKey("pr-specific:rafa/237-x:a.test.ts > t")).toEqual({
      prefix: "pr-specific:rafa/237-x:",
      subject: "a.test.ts > t",
    });
  });

  it("refuses the keys whose tail is not a test id", () => {
    expect(splitCaseKey("infra:some signature")).toBeNull();
    expect(splitCaseKey("parked:1234")).toBeNull();
    // A describe title may hold a colon; the key's own grammar decides the
    // split, not the first colon in the subject.
    expect(splitCaseKey("flake:a.test.ts > API:auth > rejects")).toEqual({
      prefix: "flake:",
      subject: "a.test.ts > API:auth > rejects",
    });
  });
});

describe("adoptCase", () => {
  it("fills the new key's holes without overruling an answer it already has", () => {
    const old = kase("filed", { issue: 1, pr: 2, fixAttempts: 2, notified: "ci-incident:x" });
    const target = kase("candidate", { issue: 9 });
    expect(adoptCase(target, old)).toMatchObject({ state: "filed", issue: 9, pr: 2, fixAttempts: 2, notified: "ci-incident:x" });
  });
});
