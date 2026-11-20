// @vitest-environment node
/**
 * The ci-health read's two halves: the pure fold, driven against store
 * literals, and the disk read, driven against a scratch checkout.
 *
 * The emphasis is on what a BAD store does, because the store is a cache
 * another process writes and ticket felipearos/ralph#160's fourth acceptance
 * criterion is that a missing one renders an empty panel rather than an error.
 * Every case below that drops a record asserts the rest of the picture
 * survived: a store half a version behind must degrade field by field, never
 * all at once.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { emptyCiHealthView, foldCiHealth, readCiHealth, readCiWaits } from "./ci-health";
import { CI_METRICS_TREND_DAYS, CI_RETRY_PER_DAY_DEFAULT } from "./contracts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

/** A store with the fields a case needs and nothing else, so a test states only its subject. */
const store = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  cases: {},
  leases: {},
  builds: [],
  reverts: {},
  main: { state: "green", since: hoursAgo(3), build: 412 },
  retries: { day: "2026-10-05", count: 2, byCase: {} },
  ...over,
});

const kase = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "flake",
  state: "confirmed",
  evidence: [],
  cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const build = (number: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  branch: "main",
  commit: "abc",
  state: "failed",
  startedAt: hoursAgo(2),
  finishedAt: new Date(Date.parse(hoursAgo(2)) + 10 * 60_000).toISOString(),
  ...over,
});

const scratches: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ralph-ci-health-"));
  scratches.push(root);
  return root;
};
afterEach(() => {
  for (const root of scratches.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("foldCiHealth", () => {
  it("folds a full store into every section", () => {
    const view = foldCiHealth(
      store({
        cases: {
          "flake:a.test.ts > one": kase({ issue: 7, pr: 9, rule: "timeout-only", cost72h: { redBuilds: 2, mainReds: 0, dequeues: 1 } }),
          "regression:b.test.ts > two": kase({ kind: "regression", state: "filed", cost72h: { redBuilds: 1, mainReds: 3, dequeues: 0 } }),
          "infra:agent lost": kase({ kind: "infra", state: "confirmed", cost72h: { redBuilds: 4, mainReds: 0, dequeues: 0 } }),
          "parked:88": kase({ kind: "parked", state: "handed-off", rule: "flake:a.test.ts > one", unparks: { "flake:a.test.ts > one": [hoursAgo(5)] } }),
        },
        reverts: {
          deadbeef: { case: "regression:b.test.ts > two", issue: 31, pr: 32, forwardIssue: 33, state: "merged" },
        },
      }),
      4,
      NOW,
    );
    expect(view.main).toEqual({ state: "green", since: hoursAgo(3), build: 412 });
    // Worst first: the regression weighs 3×3+1 = 10, the flake 2+2 = 4.
    expect(view.cases.map((entry) => entry.key)).toEqual(["regression:b.test.ts > two", "flake:a.test.ts > one"]);
    expect(view.cases[1]).toEqual({
      key: "flake:a.test.ts > one",
      subject: "a.test.ts > one",
      kind: "flake",
      state: "confirmed",
      redBuilds: 2,
      mainReds: 0,
      dequeues: 1,
      issue: 7,
      pr: 9,
      rule: "timeout-only",
      heldBy: null,
      notified: false,
    });
    expect(view.incidents.map((entry) => entry.subject)).toEqual(["agent lost"]);
    expect(view.parked).toEqual([
      {
        issue: 88,
        state: "handed-off",
        rule: "flake:a.test.ts > one",
        unparks: [{ diagnosis: "flake:a.test.ts > one", at: hoursAgo(5) }],
        heldBy: null,
      },
    ]);
    expect(view.retries).toEqual({ day: "2026-10-05", count: 2, cap: 4, today: true });
    expect(view.reverts).toEqual([
      { culprit: "deadbeef", case: "regression:b.test.ts > two", issue: 31, pr: 32, forwardIssue: 33, state: "merged" },
    ]);
  });

  it("keeps the infra incidents out of the case table they head separately", () => {
    const view = foldCiHealth(
      store({ cases: { "infra:one": kase({ kind: "infra" }), "flake:two": kase() } }),
      CI_RETRY_PER_DAY_DEFAULT,
      NOW,
    );
    expect(view.cases.map((entry) => entry.key)).toEqual(["flake:two"]);
    expect(view.incidents.map((entry) => entry.key)).toEqual(["infra:one"]);
  });

  describe("which infra incidents are OPEN", () => {
    const incidentsIn = (states: string[]) =>
      foldCiHealth(
        store({
          cases: Object.fromEntries(states.map((state) => [`infra:${state}`, kase({ kind: "infra", state })])),
        }),
        6,
        NOW,
      ).incidents.map((entry) => entry.subject);

    it("drops a fixed or retired incident: the scan keeps a managed case for ever", () => {
      // `ci-doctor/classify.ts`'s MANAGED_STATES means a cleared incident
      // stays in the store indefinitely. Listing it under a heading that says
      // "open" would be false, and it is history rather than something wrong
      // now.
      expect(incidentsIn(["fixed", "retired"])).toEqual([]);
    });

    it("keeps every state that is still something wrong", () => {
      expect(incidentsIn(["candidate", "confirmed", "filed", "fixing", "handed-off"]).sort()).toEqual([
        "candidate",
        "confirmed",
        "filed",
        "fixing",
        "handed-off",
      ]);
    });

    it("does not quietly move a closed incident into the case table instead", () => {
      const view = foldCiHealth(store({ cases: { "infra:gone": kase({ kind: "infra", state: "fixed" }) } }), 6, NOW);
      expect(view.cases).toEqual([]);
      expect(view.incidents).toEqual([]);
    });
  });

  it("reports whether an incident has already been notified", () => {
    // An infra case starts no iteration, so the notification is the whole of
    // the doctor's response: "nobody has been told" is the useful fact.
    const view = foldCiHealth(
      store({
        cases: {
          "infra:told": kase({ kind: "infra", notified: "ci-incident:told" }),
          "infra:silent": kase({ kind: "infra" }),
        },
      }),
      6,
      NOW,
    );
    expect(new Map(view.incidents.map((entry) => [entry.subject, entry.notified]))).toEqual(
      new Map([
        ["told", true],
        ["silent", false],
      ]),
    );
  });

  it("orders the reverts open first, since the store records no date to call one recent", () => {
    const revert = (state: string) => ({ case: "regression:a", issue: 1, pr: null, forwardIssue: null, state });
    const view = foldCiHealth(
      store({
        reverts: {
          aaaaaaa: revert("merged"),
          bbbbbbb: revert("abandoned"),
          ccccccc: revert("open"),
        },
      }),
      6,
      NOW,
    );
    expect(view.reverts.map((entry) => entry.culprit)).toEqual(["ccccccc", "aaaaaaa", "bbbbbbb"]);
  });

  it("orders equal-cost cases by key, so a poll cannot reshuffle them", () => {
    const flat = { cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 } };
    const view = foldCiHealth(
      store({ cases: { "flake:zebra": kase(flat), "flake:apple": kase(flat), "flake:mango": kase(flat) } }),
      CI_RETRY_PER_DAY_DEFAULT,
      NOW,
    );
    expect(view.cases.map((entry) => entry.key)).toEqual(["flake:apple", "flake:mango", "flake:zebra"]);
  });

  it("nulls main's since and build on the unknown shape the classifier writes", () => {
    const view = foldCiHealth(store({ main: { state: "unknown", since: "", build: 0 } }), 6, NOW);
    expect(view.main).toEqual({ state: "unknown", since: null, build: null });
  });

  it("nulls a since the panel could not render, rather than printing Invalid Date", () => {
    // The panel does `new Date(since).toLocaleString()`, so an unparsable
    // string reaches the operator as the literal words "Invalid Date".
    const view = foldCiHealth(store({ main: { state: "red", since: "not-a-date", build: 9 } }), 6, NOW);
    expect(view.main).toEqual({ state: "red", since: null, build: 9 });
  });

  it("reads an unknown main state as unknown rather than dropping the whole picture", () => {
    const view = foldCiHealth(
      store({ main: { state: "amber", since: hoursAgo(1), build: 9 }, cases: { "flake:a": kase() } }),
      6,
      NOW,
    );
    expect(view.main.state).toBe("unknown");
    expect(view.cases).toHaveLength(1);
  });

  describe("a store written by another version of the doctor", () => {
    it("drops a case of an unknown kind and keeps the rest", () => {
      const view = foldCiHealth(
        store({ cases: { "quarantine:a": kase({ kind: "quarantine" }), "flake:b": kase() } }),
        6,
        NOW,
      );
      expect(view.cases.map((entry) => entry.key)).toEqual(["flake:b"]);
    });

    it("drops a case of an unknown state and keeps the rest", () => {
      const view = foldCiHealth(
        store({ cases: { "flake:a": kase({ state: "quarantined" }), "flake:b": kase() } }),
        6,
        NOW,
      );
      expect(view.cases.map((entry) => entry.key)).toEqual(["flake:b"]);
    });

    it("drops a revert of an unknown state and keeps the rest", () => {
      const view = foldCiHealth(
        store({
          reverts: {
            aaaaaaa: { case: "regression:a", issue: 1, pr: null, forwardIssue: null, state: "reverted" },
            bbbbbbb: { case: "regression:b", issue: 2, pr: null, forwardIssue: null, state: "open" },
          },
        }),
        6,
        NOW,
      );
      expect(view.reverts.map((entry) => entry.culprit)).toEqual(["bbbbbbb"]);
    });

    it("reads a parked key as decimal, so a drifted key cannot link to the wrong issue", () => {
      // `Number` would take both of these — `0x10` as 16 and `1e3` as 1000 —
      // and the link would name an issue that is not the parked ticket.
      const view = foldCiHealth(
        store({
          cases: {
            "parked:0x10": kase({ kind: "parked" }),
            "parked:1e3": kase({ kind: "parked" }),
            "parked:12": kase({ kind: "parked" }),
          },
        }),
        6,
        NOW,
      );
      expect(view.parked.map((entry) => entry.issue)).toEqual([12]);
    });

    it("drops a revert whose key is not a commit", () => {
      const view = foldCiHealth(
        store({
          reverts: {
            "": { case: "regression:a", issue: 1, pr: null, forwardIssue: null, state: "open" },
            "   ": { case: "regression:b", issue: 2, pr: null, forwardIssue: null, state: "open" },
            "not-a-sha": { case: "regression:c", issue: 3, pr: null, forwardIssue: null, state: "open" },
            bbbbbbb: { case: "regression:d", issue: 4, pr: null, forwardIssue: null, state: "open" },
          },
        }),
        6,
        NOW,
      );
      expect(view.reverts.map((entry) => entry.culprit)).toEqual(["bbbbbbb"]);
    });

    it("drops a parked case whose key names no issue", () => {
      const view = foldCiHealth(
        store({ cases: { "parked:none": kase({ kind: "parked" }), "parked:12": kase({ kind: "parked" }) } }),
        6,
        NOW,
      );
      expect(view.parked.map((entry) => entry.issue)).toEqual([12]);
    });

    it("reads a missing cost as zero rather than NaN", () => {
      const view = foldCiHealth(store({ cases: { "flake:a": kase({ cost72h: undefined }) } }), 6, NOW);
      expect(view.cases[0]).toMatchObject({ redBuilds: 0, mainReds: 0, dequeues: 0 });
    });

    it("folds a store of another version to the empty view", () => {
      expect(foldCiHealth(store({ version: 2, cases: { "flake:a": kase() } }), 6, NOW)).toEqual(emptyCiHealthView(6, NOW));
    });

    it("folds a non-object to the empty view", () => {
      for (const raw of [null, undefined, 7, "store", []]) {
        expect(foldCiHealth(raw, 6, NOW)).toEqual(emptyCiHealthView(6, NOW));
      }
    });
  });

  describe("every case an unexpired lease holds", () => {
    const lease = (expiresAt: number) => ({
      run: "r",
      loop: "doc",
      pid: 1,
      host: "h",
      expiresAt: new Date(expiresAt).toISOString(),
    });

    it("includes a PARKED ticket, which no drawn list carries", () => {
      // `ci-doctor/gate.ts` returns `parked:<issue>` as a work verdict and the
      // gate leases whatever key it returns. A search over `cases` and
      // `incidents` missed it, so a doctor mid-unpark read as holding nothing.
      const view = foldCiHealth(
        store({
          cases: { "parked:1109": kase({ kind: "parked", state: "handed-off" }) },
          leases: { "parked:1109": lease(NOW + 60_000) },
        }),
        6,
        NOW,
      );
      expect(view.cases).toEqual([]);
      expect(view.held.map((entry) => entry.key)).toEqual(["parked:1109"]);
      expect(view.parked[0]!.heldBy).toBe("doc");
    });

    it("includes a CLOSED incident, which is filtered out of the open list", () => {
      const view = foldCiHealth(
        store({
          cases: { "infra:old": kase({ kind: "infra", state: "fixed" }) },
          leases: { "infra:old": lease(NOW + 60_000) },
        }),
        6,
        NOW,
      );
      expect(view.incidents).toEqual([]);
      expect(view.held.map((entry) => entry.key)).toEqual(["infra:old"]);
    });

    it("holds nothing when the lease has expired", () => {
      const view = foldCiHealth(
        store({ cases: { "flake:a": kase() }, leases: { "flake:a": lease(NOW - 1) } }),
        6,
        NOW,
      );
      expect(view.held).toEqual([]);
    });

    it("is in cost order, so a leaked second lease resolves the same way every poll", () => {
      const view = foldCiHealth(
        store({
          cases: {
            "flake:lesser": kase({ cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 } }),
            "flake:worst": kase({ cost72h: { redBuilds: 0, mainReds: 3, dequeues: 0 } }),
          },
          leases: { "flake:lesser": lease(NOW + 60_000), "flake:worst": lease(NOW + 60_000) },
        }),
        6,
        NOW,
      );
      expect(view.held.map((entry) => entry.key)).toEqual(["flake:worst", "flake:lesser"]);
    });
  });

  describe("the case lease", () => {
    it("names the doctor holding an unexpired lease", () => {
      const view = foldCiHealth(
        store({
          cases: { "flake:a": kase() },
          leases: { "flake:a": { run: "r", loop: "doc", pid: 1, host: "h", expiresAt: new Date(NOW + 60_000).toISOString() } },
        }),
        6,
        NOW,
      );
      expect(view.cases[0]!.heldBy).toBe("doc");
    });

    it("reads an expired lease as holding nothing", () => {
      const view = foldCiHealth(
        store({
          cases: { "flake:a": kase() },
          leases: { "flake:a": { run: "r", loop: "doc", pid: 1, host: "h", expiresAt: new Date(NOW - 1).toISOString() } },
        }),
        6,
        NOW,
      );
      expect(view.cases[0]!.heldBy).toBeNull();
    });
  });

  describe("the unpark history", () => {
    it("flattens diagnosis to timestamps into events, newest first", () => {
      const view = foldCiHealth(
        store({
          cases: {
            "parked:5": kase({
              kind: "parked",
              unparks: { "flake:a": [hoursAgo(9), hoursAgo(2)], "flake:b": [hoursAgo(5)] },
            }),
          },
        }),
        6,
        NOW,
      );
      expect(view.parked[0]!.unparks).toEqual([
        { diagnosis: "flake:a", at: hoursAgo(2) },
        { diagnosis: "flake:b", at: hoursAgo(5) },
        { diagnosis: "flake:a", at: hoursAgo(9) },
      ]);
    });

    it("orders two unparks of one diagnosis at the same instant without an inconsistent comparator", () => {
      // Two appended times can be equal. A comparator that returns 1 both ways
      // for an equal pair is inconsistent, which `Array.prototype.sort` is
      // entitled to do anything with.
      const at = hoursAgo(4);
      const view = foldCiHealth(
        store({ cases: { "parked:5": kase({ kind: "parked", unparks: { "flake:a": [at, at] } }) } }),
        6,
        NOW,
      );
      expect(view.parked[0]!.unparks).toEqual([
        { diagnosis: "flake:a", at },
        { diagnosis: "flake:a", at },
      ]);
    });

    it("reads a never-unparked ticket as an empty history", () => {
      const view = foldCiHealth(store({ cases: { "parked:5": kase({ kind: "parked", unparks: {} }) } }), 6, NOW);
      expect(view.parked[0]!.unparks).toEqual([]);
    });
  });

  describe("the estimated time lost to known flakes", () => {
    it("multiplies the reds in the window by the median red build", () => {
      const view = foldCiHealth(
        store({
          cases: { "flake:a": kase({ evidence: [{ build: 1 }, { build: 2 }] }) },
          builds: [
            build(1, { startedAt: hoursAgo(2), finishedAt: new Date(Date.parse(hoursAgo(2)) + 6 * 60_000).toISOString() }),
            build(2, { startedAt: hoursAgo(1), finishedAt: new Date(Date.parse(hoursAgo(1)) + 10 * 60_000).toISOString() }),
          ],
        }),
        6,
        NOW,
      );
      // Two timed red builds, 6 and 10 minutes: the median is their mean.
      expect(view.lostTime).toEqual({ reds: 2, medianBuildMinutes: 8, minutes: 16 });
    });

    it("counts only flake cases the doctor has confirmed", () => {
      for (const state of ["candidate", "fixed", "retired"]) {
        const view = foldCiHealth(
          store({ cases: { "flake:a": kase({ state, evidence: [{ build: 1 }] }) }, builds: [build(1)] }),
          6,
          NOW,
        );
        expect(view.lostTime.reds).toBe(0);
      }
      for (const state of ["confirmed", "filed", "fixing", "handed-off"]) {
        const view = foldCiHealth(
          store({ cases: { "flake:a": kase({ state, evidence: [{ build: 1 }] }) }, builds: [build(1)] }),
          6,
          NOW,
        );
        expect(view.lostTime.reds).toBe(1);
      }
    });

    it("counts no red for a regression or an infra case, however it has cost", () => {
      const view = foldCiHealth(
        store({
          cases: {
            "regression:a": kase({ kind: "regression", evidence: [{ build: 1 }] }),
            "infra:b": kase({ kind: "infra", evidence: [{ build: 1 }] }),
          },
          builds: [build(1)],
        }),
        6,
        NOW,
      );
      expect(view.lostTime.reds).toBe(0);
    });

    it("counts no red for evidence naming a build older than the window", () => {
      const view = foldCiHealth(
        store({
          cases: { "flake:a": kase({ evidence: [{ build: 1 }] }) },
          builds: [build(1, { startedAt: hoursAgo(30), finishedAt: hoursAgo(29) })],
        }),
        6,
        NOW,
      );
      expect(view.lostTime.reds).toBe(0);
    });

    it("counts no red for evidence naming a build the store no longer holds", () => {
      const view = foldCiHealth(
        store({ cases: { "flake:a": kase({ evidence: [{ build: 404 }] }) }, builds: [build(1)] }),
        6,
        NOW,
      );
      expect(view.lostTime.reds).toBe(0);
    });

    it("leaves a cancelled or blocked build out of the median, not only a green one", () => {
      // A cancelled build's short wall time would drag the median, and so the
      // estimate, down.
      const view = foldCiHealth(
        store({
          cases: { "flake:a": kase({ evidence: [{ build: 1 }] }) },
          builds: [
            build(1, { startedAt: hoursAgo(2), finishedAt: new Date(Date.parse(hoursAgo(2)) + 10 * 60_000).toISOString() }),
            build(2, { state: "canceled", startedAt: hoursAgo(1), finishedAt: new Date(Date.parse(hoursAgo(1)) + 60_000).toISOString() }),
            build(3, { state: "blocked", startedAt: hoursAgo(3), finishedAt: new Date(Date.parse(hoursAgo(3)) + 60_000).toISOString() }),
          ],
        }),
        6,
        NOW,
      );
      expect(view.lostTime).toEqual({ reds: 1, medianBuildMinutes: 10, minutes: 10 });
    });

    it("counts a flake handed to the coders: it is still flaking, just not the doctor's", () => {
      const view = foldCiHealth(
        store({ cases: { "flake:a": kase({ state: "handed-off", evidence: [{ build: 1 }] }) }, builds: [build(1)] }),
        6,
        NOW,
      );
      expect(view.lostTime.reds).toBe(1);
    });

    it("leaves a green build out of the median: a flake costs a re-run, not the run", () => {
      const view = foldCiHealth(
        store({
          cases: { "flake:a": kase({ evidence: [{ build: 1 }] }) },
          builds: [
            build(1, { startedAt: hoursAgo(2), finishedAt: new Date(Date.parse(hoursAgo(2)) + 10 * 60_000).toISOString() }),
            build(2, { state: "passed", startedAt: hoursAgo(1), finishedAt: new Date(Date.parse(hoursAgo(1)) + 2 * 60_000).toISOString() }),
          ],
        }),
        6,
        NOW,
      );
      expect(view.lostTime).toEqual({ reds: 1, medianBuildMinutes: 10, minutes: 10 });
    });

    it("reports no estimate at all when no build could be timed", () => {
      const view = foldCiHealth(
        store({ cases: { "flake:a": kase({ evidence: [{ build: 1 }] }) }, builds: [build(1, { startedAt: null })] }),
        6,
        NOW,
      );
      expect(view.lostTime).toEqual({ reds: 1, medianBuildMinutes: null, minutes: null });
    });
  });
});

describe("the per-day metrics trend (#163)", () => {
  const metrics = (over: Record<string, unknown>) => foldCiHealth(store({ metrics: over }), 6, NOW).metrics;

  it("draws exactly fourteen UTC days, oldest first, ending on the day of the read", () => {
    const view = metrics({});
    expect(view.days).toHaveLength(CI_METRICS_TREND_DAYS);
    expect(view.days[0]!.day).toBe("2026-09-22");
    expect(view.days.at(-1)!.day).toBe("2026-10-05");
    // Oldest first: the day keys sort lexicographically, so the series being
    // equal to its own sort is the whole of "ascending".
    const keys = view.days.map((entry) => entry.day);
    expect(keys).toEqual(keys.slice().sort());
  });

  it("carries both counters through, and fills a day the doctor recorded nothing for with zeros", () => {
    const view = metrics({
      "2026-10-05": { knownFlakeReds: 3, parkedOnFlake: 2 },
      "2026-10-03": { knownFlakeReds: 1, parkedOnFlake: 5 },
    });
    expect(view.days.at(-1)).toEqual({ day: "2026-10-05", knownFlakeReds: 3, parkedOnFlake: 2 });
    expect(view.days.at(-2)).toEqual({ day: "2026-10-04", knownFlakeReds: 0, parkedOnFlake: 0 });
    expect(view.days.at(-3)).toEqual({ day: "2026-10-03", knownFlakeReds: 1, parkedOnFlake: 5 });
    expect(view.reds).toBe(4);
    expect(view.parkedPeak).toBe(5);
  });

  it("leaves a day outside the window out, however much the store has", () => {
    const view = metrics({ "2026-08-01": { knownFlakeReds: 99, parkedOnFlake: 99 } });
    expect(view.days.some((entry) => entry.day === "2026-08-01")).toBe(false);
    expect(view.reds).toBe(0);
    expect(view.parkedPeak).toBe(0);
    // But the operator is still told the doctor HAS recorded days here.
    expect(view.recorded).toBe(true);
  });

  it("says whether anything was recorded at all, which the zeros cannot", () => {
    expect(metrics({}).recorded).toBe(false);
    expect(metrics({ "2026-10-05": { knownFlakeReds: 0, parkedOnFlake: 0 } }).recorded).toBe(true);
  });

  it("reads a malformed day as zeros rather than NaN, and keeps the rest of the picture", () => {
    const view = foldCiHealth(
      store({ metrics: { "2026-10-05": "nonsense", "2026-10-04": { knownFlakeReds: "two" } }, cases: { "flake:a": kase() } }),
      6,
      NOW,
    );
    expect(view.metrics.days.at(-1)).toEqual({ day: "2026-10-05", knownFlakeReds: 0, parkedOnFlake: 0 });
    expect(view.metrics.days.at(-2)).toEqual({ day: "2026-10-04", knownFlakeReds: 0, parkedOnFlake: 0 });
    expect(view.cases.map((entry) => entry.key)).toEqual(["flake:a"]);
  });
});

describe("the median CI and queue minutes per iteration (#163)", () => {
  /** A worktree with wait results in it, each file's mtime set to `hoursOld`. */
  const worktree = (files: Record<string, { mode: string; elapsedSeconds: number; hoursOld?: number } | string>): string => {
    const root = scratch();
    const dir = join(root, ".ralph", "logs");
    mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      const path = join(dir, name);
      writeFileSync(
        path,
        typeof value === "string"
          ? value
          : JSON.stringify({ outcome: "green", mode: value.mode, pr: "1", head: null, polls: 1, checks: [], detail: "", elapsedSeconds: value.elapsedSeconds }),
      );
      const when = (NOW - (typeof value === "string" ? 0 : (value.hoursOld ?? 1)) * 3_600_000) / 1000;
      utimesSync(path, when, when);
    }
    return root;
  };

  it("sums an iteration's rounds and medians across iterations, per mode", () => {
    const root = worktree({
      // One iteration, two CI rounds: 120s + 180s = 5 minutes.
      "pr-wait-20261005T100000-100-1-1.json": { mode: "ci", elapsedSeconds: 120 },
      "pr-wait-20261005T100000-100-1-2.json": { mode: "ci", elapsedSeconds: 180 },
      // A second iteration: 9 minutes. Median of 5 and 9 is 7.
      "pr-wait-20261005T110000-100-2-1.json": { mode: "ci", elapsedSeconds: 540 },
      // And one queue wait, from a session rather than the supervisor.
      "pr-wait-session-cff94705d3aa-1.json": { mode: "merge", elapsedSeconds: 240 },
    });
    expect(readCiWaits([root], NOW).day).toEqual({
      ciIterations: 2,
      ciMinutes: 7,
      queueIterations: 1,
      queueMinutes: 4,
    });
  });

  it("keeps the 24-hour and 7-day windows apart, by when the wait ended", () => {
    const root = worktree({
      "pr-wait-a-1.json": { mode: "ci", elapsedSeconds: 60, hoursOld: 2 },
      "pr-wait-b-1.json": { mode: "ci", elapsedSeconds: 600, hoursOld: 50 },
      "pr-wait-c-1.json": { mode: "ci", elapsedSeconds: 1200, hoursOld: 400 },
    });
    const waits = readCiWaits([root], NOW);
    expect(waits.day).toMatchObject({ ciIterations: 1, ciMinutes: 1 });
    // 1 and 10 minutes inside the week; the 400-hour-old one is outside both.
    expect(waits.week).toMatchObject({ ciIterations: 2, ciMinutes: 5.5 });
  });

  it("never counts the same wait twice out of the .jsonl history beside it", () => {
    const one = { mode: "ci", elapsedSeconds: 300 };
    const root = worktree({
      "pr-wait-20261005T100000-100-1-1.json": one,
      "pr-wait-20261005T100000-100-1.jsonl": JSON.stringify({ mode: "ci", elapsedSeconds: 300 }),
    });
    expect(readCiWaits([root], NOW).day).toMatchObject({ ciIterations: 1, ciMinutes: 5 });
  });

  it("counts two worktrees' iterations separately even when their keys collide", () => {
    const name = "pr-wait-20261005T100000-100-1-1.json";
    const left = worktree({ [name]: { mode: "ci", elapsedSeconds: 60 } });
    const right = worktree({ [name]: { mode: "ci", elapsedSeconds: 180 } });
    expect(readCiWaits([left, right], NOW).day).toMatchObject({ ciIterations: 2, ciMinutes: 2 });
  });

  it("skips a result that is not a wait that happened, and a file that is not JSON", () => {
    const root = worktree({
      "pr-wait-a-1.json": { mode: "ci", elapsedSeconds: 60 },
      // What `ralph.sh:1314,1327` writes when it could not read an outcome:
      // no mode it can judge and no elapsed time.
      "pr-wait-b-1.json": '{"outcome":"rounds-exhausted","pr":"1"}',
      "pr-wait-c-1.json": "not json at all",
      "pr-wait-d-1.json": '{"mode":"ci","elapsedSeconds":"ten"}',
    });
    expect(readCiWaits([root], NOW).day).toMatchObject({ ciIterations: 1, ciMinutes: 1 });
  });

  it("skips a wait that spent its time failing to read the PR, elapsed time and all", () => {
    // `merge-wait.ts` files an `unreadable` of its own WITH a real elapsed
    // time. Counting it would describe the loops' GitHub trouble as the
    // queue's latency.
    const root = scratch();
    const dir = join(root, ".ralph", "logs");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [
      ["pr-wait-session-run-1-1.json", { outcome: "unreadable", mode: "merge", elapsedSeconds: 300 }],
      ["pr-wait-session-run-2-1.json", { outcome: "head-mismatch", mode: "ci", elapsedSeconds: 300 }],
      ["pr-wait-session-run-3-1.json", { outcome: "merged", mode: "merge", elapsedSeconds: 120 }],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(body));
      utimesSync(path, (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
    }
    expect(readCiWaits([root], NOW).day).toEqual({
      ciIterations: 0,
      ciMinutes: null,
      queueIterations: 1,
      queueMinutes: 2,
    });
  });

  it("reads a worktree that has never waited as no waits, not as unreadable", () => {
    expect(readCiWaits([scratch()], NOW)).toMatchObject({ unreadable: [] });
  });

  it("reads a worktree whose .ralph is a file as no waits either", () => {
    const root = scratch();
    writeFileSync(join(root, ".ralph"), "not a directory");
    expect(readCiWaits([root], NOW)).toMatchObject({ unreadable: [] });
  });

  // Skipped as root, which is allowed to list a directory with no permissions
  // at all — and there is then no way to make a listing fail on purpose.
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "names a worktree whose logs exist and still could not be listed",
    () => {
      const root = scratch();
      const dir = join(root, ".ralph", "logs");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      try {
        const waits = readCiWaits([root], NOW);
        expect(waits.unreadable).toEqual([root]);
        // And it is not read as a quiet window.
        expect(waits.day.ciIterations).toBe(0);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
});

describe("readCiHealth", () => {
  /** A checkout with a `.git` directory, as an ordinary clone has. */
  const checkout = (storeJson?: string, config?: string): string => {
    const root = scratch();
    mkdirSync(join(root, ".git", "ralph"), { recursive: true });
    if (storeJson !== undefined) writeFileSync(join(root, ".git", "ralph", "ci-health.json"), storeJson);
    if (config !== undefined) {
      mkdirSync(join(root, ".ralph"), { recursive: true });
      writeFileSync(join(root, ".ralph", "config.json"), config);
    }
    return root;
  };

  it("reads the store from the checkout's own .git", () => {
    const root = checkout(JSON.stringify(store({ cases: { "flake:a": kase() } })));
    const read = readCiHealth(root, NOW);
    expect(read.problem).toBeNull();
    expect(read.readAt).toBe(new Date(NOW).toISOString());
    expect(read.view?.cases.map((entry) => entry.key)).toEqual(["flake:a"]);
  });

  it("reads a linked worktree's store from the main checkout's common directory", () => {
    const main = checkout(JSON.stringify(store({ cases: { "flake:shared": kase() } })));
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    const linked = scratch();
    writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(readCiHealth(linked, NOW).view?.cases.map((entry) => entry.key)).toEqual(["flake:shared"]);
  });

  describe("a store the panel cannot use", () => {
    it("shows an empty panel for a missing store, and calls it no problem", () => {
      const read = readCiHealth(checkout(), NOW);
      expect(read.problem).toBeNull();
      expect(read.view).toEqual(emptyCiHealthView(CI_RETRY_PER_DAY_DEFAULT, NOW));
    });

    it("shows an empty panel for a truncated store", () => {
      expect(readCiHealth(checkout('{"version":1,"cases":{'), NOW).view).toEqual(emptyCiHealthView(CI_RETRY_PER_DAY_DEFAULT, NOW));
    });

    it("shows an empty panel for a store of another version", () => {
      expect(readCiHealth(checkout(JSON.stringify(store({ version: 2 }))), NOW).view).toEqual(emptyCiHealthView(CI_RETRY_PER_DAY_DEFAULT, NOW));
    });

    it("still carries the coders' wait medians, which the doctor's store has no say in", () => {
      // #163 AC3 through the real reader: the store is a version this cannot
      // use, and the waits are read from the loops' own logs regardless.
      const left = checkout(JSON.stringify(store({ version: 2 })));
      const right = scratch();
      for (const [root, seconds] of [
        [left, 120],
        [right, 480],
      ] as const) {
        const dir = join(root, ".ralph", "logs");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "pr-wait-20261005T100000-100-1-1.json");
        writeFileSync(
          path,
          JSON.stringify({ outcome: "green", mode: "ci", pr: "1", head: null, polls: 2, elapsedSeconds: seconds, checks: [], detail: "" }),
        );
        utimesSync(path, (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
      }
      const read = readCiHealth(left, NOW, [left, right]);
      // Two iterations — one per worktree, despite the identical filename —
      // at 2 and 8 minutes, so the median is 5.
      expect(read.view?.waits.day).toEqual({
        ciIterations: 2,
        ciMinutes: 5,
        queueIterations: 0,
        queueMinutes: null,
      });
      expect(read.view?.metrics.recorded).toBe(false);
      expect(read.problem).toBeNull();
    });

    it("reports a checkout with no readable .git as unknown, not as empty", () => {
      const read = readCiHealth(join(scratch(), "gone"), NOW);
      expect(read.view).toBeNull();
      expect(read.problem).toContain(".git");
    });
  });

  describe("the retry count's day", () => {
    it("calls the count today's when the store's day is the read's", () => {
      const view = foldCiHealth(store({ retries: { day: "2026-10-05", count: 3, byCase: {} } }), 6, NOW);
      expect(view.retries).toEqual({ day: "2026-10-05", count: 3, cap: 6, today: true });
    });

    it("does NOT call yesterday's count today's", () => {
      // The store carries one day and the scan rolls it over lazily, so a
      // count read the morning after is yesterday's. Presenting it as today's
      // would say the doctor has spent nothing when it has spent everything.
      const view = foldCiHealth(store({ retries: { day: "2026-10-04", count: 6, byCase: {} } }), 6, NOW);
      expect(view.retries).toEqual({ day: "2026-10-04", count: 6, cap: 6, today: false });
    });

    it("reads an empty store's day as no day at all, which is never today", () => {
      // `emptyStore()` writes `day: ""`, so this is the shape of a project
      // whose doctor has never retried anything.
      const view = foldCiHealth(store({ retries: { day: "", count: 0, byCase: {} } }), 6, NOW);
      expect(view.retries).toEqual({ day: null, count: 0, cap: 6, today: false });
      expect(emptyCiHealthView(6, NOW).retries).toEqual({ day: null, count: 0, cap: 6, today: false });
    });

    it("keeps a count the store recorded under no day, rather than reading it as nothing", () => {
      // Drift, but the panel's "no retry yet" line is wrong over a count of 3,
      // and that is the same family of untruth the `today` flag exists to stop.
      const view = foldCiHealth(store({ retries: { day: "", count: 3, byCase: {} } }), 6, NOW);
      expect(view.retries).toEqual({ day: null, count: 3, cap: 6, today: false });
    });
  });

  describe("the retry cap", () => {
    it("takes ciDoctor.retry.perDay from the project config", () => {
      const root = checkout(undefined, JSON.stringify({ ciDoctor: { retry: { perDay: 2 } } }));
      expect(readCiHealth(root, NOW).view?.retries.cap).toBe(2);
    });

    it("falls back to the documented default with no config, a malformed one, or no key", () => {
      for (const config of [
        undefined,
        "{",
        JSON.stringify({}),
        JSON.stringify({ ciDoctor: {} }),
        JSON.stringify({ ciDoctor: { retry: "none" } }),
        JSON.stringify({ ciDoctor: { retry: { perDay: "two" } } }),
        JSON.stringify({ ciDoctor: { retry: { perDay: -1 } } }),
      ]) {
        const root = checkout(undefined, config);
        expect(readCiHealth(root, NOW).view?.retries.cap).toBe(CI_RETRY_PER_DAY_DEFAULT);
      }
    });

    it("clamps a raised cap to the ceiling project-config.ts would refuse to run with", () => {
      // The key may be lowered but never raised. This module reads the raw
      // file rather than the validator, so without the clamp the panel would
      // show a cap the harness would not start with.
      const root = checkout(undefined, JSON.stringify({ ciDoctor: { retry: { perDay: 999 } } }));
      expect(readCiHealth(root, NOW).view?.retries.cap).toBe(CI_RETRY_PER_DAY_DEFAULT);
    });
  });

  describe("finding the store from an unusual checkout", () => {
    it("reports a .git file with no gitdir line as unknown", () => {
      const root = scratch();
      writeFileSync(join(root, ".git"), "this is not a gitdir pointer\n");
      const read = readCiHealth(root, NOW);
      expect(read.view).toBeNull();
      expect(read.problem).toContain(".git");
    });

    it("takes a gitdir that is not under worktrees/ as the common directory itself", () => {
      // A repository whose admin directory lives elsewhere — a submodule, or
      // `core.worktree`. The docblock goes out of its way to justify this
      // branch, so it gets a test.
      const admin = join(scratch(), "elsewhere");
      mkdirSync(join(admin, "ralph"), { recursive: true });
      writeFileSync(
        join(admin, "ralph", "ci-health.json"),
        JSON.stringify(store({ cases: { "flake:elsewhere": kase() } })),
      );
      const root = scratch();
      writeFileSync(join(root, ".git"), `gitdir: ${admin}\n`);
      expect(readCiHealth(root, NOW).view?.cases.map((entry) => entry.key)).toEqual(["flake:elsewhere"]);
    });
  });
});
