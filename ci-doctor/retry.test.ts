// @vitest-environment node
/**
 * felipearos/ralph#161's acceptance criteria for `ci-doctor/retry.ts`:
 *
 *  AC 3 — with a candidate flake and `readCi` idle, the gate retries the failed
 *         job once, and does not retry the same candidate again.
 *  AC 4 — no retry of a `mergify/merge-queue/*` build, none while `readCi`
 *         reports busy or unreadable or a host lease is held, and no 7th retry
 *         in one UTC day across two doctor supervisors sharing the store.
 *  AC 6 — without the token the doctor behaves exactly as with natural reruns
 *         only (the `put` that throws, and the gate's own wiring in
 *         `gate-poll.test.ts`).
 *
 * The store is REAL — a temp directory and the real `withStore` — because the
 * cap is a claim two callers make on one file under a lock, and a fake store
 * would be testing the fake. `put` is injected and records its paths, so "did
 * not retry" is an assertion over an array rather than an absence nobody looks
 * at.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HelperError } from "../bk-log";

import { classify } from "./classify";
import { readStore, withStore, type BuildRecord, type Case, type CiHealthStore, type Failure } from "./store";
import {
  HEAD_RETRY_KEEP_DAYS,
  budget,
  ceilings,
  eligible,
  headKey,
  headRetried,
  retryHead,
  retryOnce,
  retryPath,
  unscannedOrToday,
  utcDay,
  type HeadTarget,
  type RetryDeps,
} from "./retry";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = "2026-10-05";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ci-retry-"));
  dirs.push(dir);
  return join(dir, "ci-health.json");
};

const build = (over: Partial<BuildRecord> & { number: number }): BuildRecord => ({
  branch: "main",
  commit: "c".repeat(40),
  state: "failed",
  source: null,
  createdAt: "2026-10-05T11:00:00Z",
  startedAt: "2026-10-05T11:01:00Z",
  finishedAt: "2026-10-05T11:10:00Z",
  pr: null,
  prs: [],
  steps: { test: "failed" },
  tree: null,
  parent: null,
  sincePrevious: null,
  changedFiles: null,
  branchPaths: null,
  ...over,
});

const row = (over: Partial<Failure> & { testId: string; build: number; job: string }): Failure => ({
  file: "src/a.test.ts",
  branch: "main",
  commit: "c".repeat(40),
  step: "test",
  kind: "timeout",
  line: "Test timed out in 5000ms",
  finishedAt: "2026-10-05T11:10:00Z",
  retried: false,
  ...over,
});

const flake = (over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state: "candidate",
  evidence: [],
  cost72h: { redBuilds: 1, mainReds: 1, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const TEST_ID = "src/a.test.ts > flaps";

/** One candidate flake on main, on a finished build, with nothing spent. */
function oneCandidate(over: Partial<CiHealthStore> = {}): CiHealthStore {
  return {
    ...emptyish(),
    builds: [build({ number: 10 })],
    failures: [row({ testId: TEST_ID, build: 10, job: "job-a" })],
    cases: { [`flake:${TEST_ID}`]: flake() },
    ...over,
  };
}

function emptyish(): CiHealthStore {
  return {
    version: 1,
    cursor: "",
    jobsSeen: {},
    failures: [],
    builds: [],
    cases: {},
    main: { state: "red", since: "", build: 0 },
    leases: {},
    retries: { day: "", count: 0, byCase: {} },
    reverts: {},
    metrics: {},
    backfill: null,
  };
}

const OPTIONS = { baseBranch: "main", branchHead: () => null, ceilings: { perCandidate: 1, perDay: 6 }, now: NOW };

/** `retryOnce` wired with an idle host and a recording `put`. */
function deps(path: string, over: Partial<RetryDeps> = {}): RetryDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    storePath: path,
    org: async () => "loggd",
    pipeline: "loggd",
    baseBranch: "main",
    config: null,
    now: () => NOW,
    put: async (p) => {
      calls.push(p);
    },
    readCi: () => ({ busy: false, detail: "nothing pending" }),
    ciReadCalls: 3,
    afford: () => true,
    hostLeaseBusy: () => ({ busy: false, detail: "no holder, no queue" }),
    branchHead: () => null,
    ...over,
  };
}

const seed = async (path: string, store: CiHealthStore): Promise<void> => {
  await withStore(path, (open) => {
    Object.assign(open, store);
  });
};

describe("eligible", () => {
  it("takes a candidate flake's newest unretried red on a finished main build", () => {
    const store = oneCandidate({
      builds: [build({ number: 10 }), build({ number: 12 })],
      failures: [row({ testId: TEST_ID, build: 10, job: "old" }), row({ testId: TEST_ID, build: 12, job: "new" })],
    });
    expect(eligible(store, OPTIONS)).toEqual([
      { key: `flake:${TEST_ID}`, testId: TEST_ID, build: 12, job: "new", branch: "main", commit: "c".repeat(40), step: "test" },
    ]);
  });

  it("never retries a merge-queue build", () => {
    const queue = "mergify/merge-queue/main/abc";
    const store = oneCandidate({
      builds: [build({ number: 10, branch: queue })],
      failures: [row({ testId: TEST_ID, build: 10, job: "job-a", branch: queue })],
    });
    expect(eligible(store, OPTIONS)).toEqual([]);
  });

  it("never retries a case that is not a candidate flake", () => {
    for (const value of [
      flake({ state: "confirmed" }),
      flake({ state: "fixing" }),
      flake({ kind: "regression", state: "confirmed" }),
      flake({ kind: "infra" }),
      flake({ kind: "pr-specific" }),
      flake({ kind: "parked" }),
    ]) {
      expect(eligible(oneCandidate({ cases: { [`flake:${TEST_ID}`]: value } }), OPTIONS)).toEqual([]);
    }
  });

  it("never retries a build that has not finished, or one the store has no record of", () => {
    expect(eligible(oneCandidate({ builds: [build({ number: 10, state: "running" })] }), OPTIONS)).toEqual([]);
    expect(eligible(oneCandidate({ builds: [] }), OPTIONS)).toEqual([]);
  });

  it("never retries a bootstrap failure: that is infra, not a test", () => {
    const store = oneCandidate({ failures: [row({ testId: TEST_ID, build: 10, job: "job-a", kind: "bootstrap" })] });
    expect(eligible(store, OPTIONS)).toEqual([]);
  });

  it("retries a PR branch only while its head is still that build's commit", () => {
    const store = oneCandidate({
      builds: [build({ number: 10, branch: "feat/x" })],
      failures: [row({ testId: TEST_ID, build: 10, job: "job-a", branch: "feat/x" })],
    });
    expect(eligible(store, { ...OPTIONS, branchHead: () => "c".repeat(40) })).toHaveLength(1);
    // Moved on, and unreadable, are both "not this commit".
    expect(eligible(store, { ...OPTIONS, branchHead: () => "d".repeat(40) })).toEqual([]);
    expect(eligible(store, { ...OPTIONS, branchHead: () => null })).toEqual([]);
  });

  it("skips a candidate whose retry today is already recorded, and one whose row is marked retried", () => {
    expect(eligible(oneCandidate({ retries: { day: DAY, count: 1, byCase: { [TEST_ID]: "job-a" } } }), OPTIONS)).toEqual([]);
    // The row marking is the guard that survives the day boundary: the day's
    // count may have reset, but the candidate has had its retry.
    const marked = oneCandidate({
      retries: { day: "2026-10-04", count: 6, byCase: { [TEST_ID]: "job-a" } },
      failures: [row({ testId: TEST_ID, build: 10, job: "job-a", retried: true })],
    });
    expect(eligible(marked, OPTIONS)).toEqual([]);
  });

  it("holds a record from before midnight whose retry the scan has not marked yet", () => {
    // The hole between the two per-candidate guards. A retry made shortly
    // before 00:00 UTC is guarded only by `byCase` until the next scan marks
    // its row — and `byCase` is day-scoped — so the rollover alone would hand
    // the same candidate a second retry.
    const unscanned = oneCandidate({ retries: { day: "2026-10-04", count: 6, byCase: { [TEST_ID]: "job-a" } } });
    expect(eligible(unscanned, OPTIONS)).toEqual([]);
    expect(unscannedOrToday(unscanned, DAY)).toEqual({ [TEST_ID]: "job-a" });

    // And the record is dropped the moment the marking it stood in for
    // arrives, so it is not a second permanent guard.
    const scanned = oneCandidate({
      retries: { day: "2026-10-04", count: 6, byCase: { other: "job-z" } },
      failures: [row({ testId: TEST_ID, build: 10, job: "job-a" }), row({ testId: "x", build: 10, job: "job-z", retried: true })],
    });
    expect(unscannedOrToday(scanned, DAY)).toEqual({});
    expect(eligible(scanned, OPTIONS)).toHaveLength(1);
  });

  it("stops carrying a record once the store no longer holds its job's row", () => {
    // The carry-over's lifetime. Dropping only on the MARKING read well and was
    // wrong both ways: a retry whose PUT faulted is never marked by anything,
    // so its record was carried across every rollover for ever — barring the
    // candidate permanently and growing `byCase` without bound — while the
    // successful path's guard expires with the 72-hour window. The failed retry
    // was the stricter of the two, which is backwards.
    const faulted = oneCandidate({
      retries: { day: "2026-10-04", count: 1, byCase: { [TEST_ID]: "gone" } },
      // The scan's window has moved on; no row holds `gone` any more.
      failures: [row({ testId: TEST_ID, build: 10, job: "job-a" })],
    });
    expect(unscannedOrToday(faulted, DAY)).toEqual({});
    expect(eligible(faulted, OPTIONS)).toHaveLength(1);

    // And the record still binds while the row IS held and unmarked, which is
    // the hole it exists to close.
    const pending = oneCandidate({
      retries: { day: "2026-10-04", count: 1, byCase: { [TEST_ID]: "job-a" } },
      failures: [row({ testId: TEST_ID, build: 10, job: "job-a" })],
    });
    expect(unscannedOrToday(pending, DAY)).toEqual({ [TEST_ID]: "job-a" });
    expect(eligible(pending, OPTIONS)).toEqual([]);
  });

  it("asks git about each branch once, however many of a candidate's reds are on it", () => {
    const asked: string[] = [];
    const store = oneCandidate({
      builds: [build({ number: 10, branch: "feat/x" }), build({ number: 11, branch: "feat/x" })],
      failures: [
        row({ testId: TEST_ID, build: 10, job: "job-a", branch: "feat/x" }),
        row({ testId: TEST_ID, build: 11, job: "job-b", branch: "feat/x" }),
      ],
    });
    eligible(store, {
      ...OPTIONS,
      branchHead: (branch) => {
        asked.push(branch);
        return "d".repeat(40);
      },
    });
    // `git ls-remote` leaves the machine; before the memo these two reds on
    // one branch asked twice, and a candidate with more asks once per red.
    expect(asked).toEqual(["feat/x"]);
  });
});

describe("eligible and a continuous red run (#57)", () => {
  /** `builds` and a red row for each failed one, with the cases `classify` proposes for them. */
  const classified = (builds: BuildRecord[]): CiHealthStore => {
    const store: CiHealthStore = {
      ...emptyish(),
      builds,
      // One line per build, so the main reds are not one regression's run.
      failures: builds
        .filter((one) => one.state === "failed")
        .map((one) => row({ testId: TEST_ID, build: one.number, job: `job-${one.number}`, commit: one.commit, line: `Test timed out in 5000ms (#${one.number})` })),
    };
    return { ...store, cases: classify(store, NOW).cases };
  };
  const green = (number: number): BuildRecord =>
    build({ number, state: "passed", steps: { test: "passed" }, commit: `g${number}`, tree: "T" });
  const red = (number: number, tree: string | null = null): BuildRecord => build({ number, commit: `r${number}`, tree });

  it("never retries a flake that is red on every build since an older green of its tree", () => {
    const store = classified([green(9), red(10, "T"), red(11), red(12)]);
    expect(store.cases[`flake:${TEST_ID}`]).toMatchObject({ state: "retired", redRun: { since: 9, builds: 3 } });
    expect(eligible(store, OPTIONS)).toEqual([]);
  });

  it("still retries a candidate flake with one red, as before", () => {
    const store = classified([red(10)]);
    expect(store.cases[`flake:${TEST_ID}`]?.state).toBe("candidate");
    expect(eligible(store, OPTIONS)).toHaveLength(1);
  });
});

describe("the caps", () => {
  it("clamps the project's ceilings and never lets an unvalidated config raise them", () => {
    expect(ceilings(null)).toEqual({ perCandidate: 1, perDay: 6 });
    expect(ceilings({ ciDoctor: { retry: { perCandidate: 0, perDay: 2 } } })).toEqual({ perCandidate: 0, perDay: 2 });
    expect(ceilings({ ciDoctor: { retry: { perCandidate: 9, perDay: 99 } } })).toEqual({ perCandidate: 1, perDay: 6 });
    expect(ceilings({ ciDoctor: { retry: { perDay: "lots" } } })).toEqual({ perCandidate: 1, perDay: 6 });
  });

  it("counts the day's spend, and a new UTC day resets it", () => {
    expect(budget(oneCandidate(), null, NOW).allowed).toBe(6);
    expect(budget(oneCandidate({ retries: { day: DAY, count: 6, byCase: {} } }), null, NOW)).toMatchObject({ allowed: 0 });
    expect(budget(oneCandidate({ retries: { day: "2026-10-04", count: 6, byCase: {} } }), null, NOW).allowed).toBe(6);
    expect(utcDay(NOW)).toBe(DAY);
  });

  it("is off entirely when the project lowers either ceiling to zero", () => {
    expect(budget(oneCandidate(), { ciDoctor: { retry: { perDay: 0 } } }, NOW)).toMatchObject({ allowed: 0 });
    expect(budget(oneCandidate(), { ciDoctor: { retry: { perCandidate: 0 } } }, NOW)).toMatchObject({ allowed: 0 });
  });
});

describe("retryOnce", () => {
  it("retries a candidate's failed job once, and records it under the store lock", async () => {
    const path = storePath();
    await seed(path, oneCandidate());
    const wired = deps(path);

    const first = await retryOnce(wired);
    expect(first.outcome).toBe("retried");
    expect(wired.calls).toEqual([retryPath("loggd", "loggd", 10, "job-a")]);
    expect(readStore(path).retries).toEqual({ day: DAY, count: 1, byCase: { [TEST_ID]: "job-a" } });

    // AC 3's second half: the same store again writes nothing and calls nothing.
    const again = await retryOnce(wired);
    expect(again.outcome).toBe("none");
    expect(wired.calls).toHaveLength(1);
    expect(readStore(path).retries.count).toBe(1);
  });

  it("does nothing while the host's CI is busy, or while its state is unreadable", async () => {
    for (const detail of ["pending: #7 buildkite/loggd", "could not list open pull requests"]) {
      const path = storePath();
      await seed(path, oneCandidate());
      const wired = deps(path, { readCi: () => ({ busy: true, detail }) });
      const result = await retryOnce(wired);
      expect(result.outcome).toBe("busy");
      expect(result.why).toContain(detail);
      expect(wired.calls).toEqual([]);
      expect(readStore(path).retries).toEqual({ day: "", count: 0, byCase: {} });
    }
  });

  it("does nothing while a host lease is held or anybody is queued for one", async () => {
    for (const detail of ["held by rulo until 12:05Z", "1 waiting"]) {
      const path = storePath();
      await seed(path, oneCandidate());
      const wired = deps(path, { hostLeaseBusy: () => ({ busy: true, detail }) });
      const result = await retryOnce(wired);
      expect(result.outcome).toBe("busy");
      expect(result.why).toContain(detail);
      expect(wired.calls).toEqual([]);
      expect(readStore(path).retries.count).toBe(0);
    }
  });

  it("re-reads the host lease immediately before the write", async () => {
    // `eligible` asks `git ls-remote` and `readCi` asks GitHub: both leave the
    // machine, and a coder can take the lease while they are out. The cheap
    // read before them is what saves those calls on a busy host; THIS one is
    // the fence.
    const path = storePath();
    await seed(path, oneCandidate());
    let asked = 0;
    const wired = deps(path, {
      hostLeaseBusy: () => {
        asked += 1;
        return asked === 1
          ? { busy: false, detail: "no live host-lease holder and nobody queued" }
          : { busy: true, detail: "host lease held by rulo for #1809" };
      },
    });
    const result = await retryOnce(wired);
    expect(asked).toBe(2);
    expect(result.outcome).toBe("busy");
    expect(result.why).toContain("taken while reading");
    expect(wired.calls).toEqual([]);
    // Nothing claimed: the slot is not spent on a race the doctor lost.
    expect(readStore(path).retries.count).toBe(0);
  });

  it("refuses the 7th retry of a UTC day across two doctors sharing one store", async () => {
    const path = storePath();
    // Seven candidates, so nothing but the daily cap can stop the seventh.
    const ids = Array.from({ length: 7 }, (_, i) => `src/t${i}.test.ts > flaps`);
    await seed(path, {
      ...emptyish(),
      builds: ids.map((_, i) => build({ number: 10 + i })),
      failures: ids.map((id, i) => row({ testId: id, build: 10 + i, job: `job-${i}` })),
      cases: Object.fromEntries(ids.map((id) => [`flake:${id}`, flake()])),
    });
    // Two supervisors, alternating, each with its own `deps` and its own
    // recording `put` — one shared store path.
    const doctors = [deps(path), deps(path)];
    const outcomes: string[] = [];
    for (let i = 0; i < 7; i++) outcomes.push((await retryOnce(doctors[i % 2]!)).outcome);

    expect(outcomes).toEqual(["retried", "retried", "retried", "retried", "retried", "retried", "capped"]);
    expect(doctors[0]!.calls.length + doctors[1]!.calls.length).toBe(6);
    const store = readStore(path);
    expect(store.retries.count).toBe(6);
    expect(Object.keys(store.retries.byCase)).toHaveLength(6);
  });

  it("tells the two capped races apart in words", async () => {
    // The in-lock re-check has two refusals, and one message for both would
    // tell an operator the six-a-day ceiling was exhausted when five of six
    // remained. It is a CROSS-PROCESS race — `retryOnce` reaches its first
    // `await` at the claim, so two calls in one process do not interleave
    // there — so the other doctor's write is injected through
    // `hostLeaseBusy`, which is called both before `eligible` and again
    // immediately before the claim. The write lands on the first call, which
    // is inside the real race window: `readStore` → `withStore`.
    const between = async (write: (store: CiHealthStore) => void) => {
      const path = storePath();
      await seed(path, oneCandidate());
      let written = false;
      const wired = deps(path, {
        hostLeaseBusy: () => {
          if (!written) {
            written = true;
            // Synchronous on purpose: `hostLeaseBusy` is not awaited, and the
            // store write has to have landed before the claim reads it.
            const open = readStore(path);
            write(open);
            writeFileSync(path, JSON.stringify(open));
          }
          return { busy: false, detail: "no live host-lease holder and nobody queued" };
        },
      });
      return { result: await retryOnce(wired), calls: wired.calls };
    };

    // This candidate, taken by the other doctor.
    const candidate = await between((open) => {
      open.retries = { day: DAY, count: 1, byCase: { [TEST_ID]: "job-a" } };
    });
    expect(candidate.result.outcome).toBe("capped");
    expect(candidate.result.why).toBe(`another doctor retried ${TEST_ID} between the read and the claim`);
    expect(candidate.calls).toEqual([]);
    // The reserved calls are still reported: `readCi` was entered, so the
    // gate's ledger must be charged even though the race was lost.
    expect(candidate.result.ghCalls).toBe(3);

    // The day, spent by the other doctor on six OTHER candidates.
    const day = await between((open) => {
      open.retries = { day: DAY, count: 6, byCase: { elsewhere: "job-z" } };
    });
    expect(day.result.outcome).toBe("capped");
    expect(day.result.why).toBe(`another doctor took the last retry of ${DAY}`);
    expect(day.calls).toEqual([]);
    expect(day.result.ghCalls).toBe(3);
  });

  it("reports capped rather than retrying when the day is already spent", async () => {
    const path = storePath();
    await seed(path, oneCandidate({ retries: { day: DAY, count: 6, byCase: { other: "job-z" } } }));
    const wired = deps(path);
    const result = await retryOnce(wired);
    expect(result.outcome).toBe("capped");
    expect(result.why).toContain("already spent");
    expect(wired.calls).toEqual([]);
  });

  it("writes nothing at all when the project has turned retries off", async () => {
    // Either ceiling at zero is off; `capped` names the config rather than
    // claiming there was no candidate, which an operator would have to go and
    // check for themselves.
    for (const [retry, why] of [
      [{ perDay: 0 }, "perDay is 0"],
      [{ perCandidate: 0 }, "perCandidate is 0"],
    ] as const) {
      const path = storePath();
      await seed(path, oneCandidate());
      const wired = deps(path, { config: { ciDoctor: { retry } } });
      const result = await retryOnce(wired);
      expect(result.outcome).toBe("capped");
      expect(result.why).toContain(why);
      expect(wired.calls).toEqual([]);
      expect(readStore(path).retries).toEqual({ day: "", count: 0, byCase: {} });
    }
  });

  it("asks for the organization only when there is a retry to make, and once", async () => {
    // Resolving it is one or two Buildkite reads unless `RALPH_BUILDKITE_ORG`
    // is set, so the eager version paid them on every poll whatever the fences
    // said, and logged a `fault` every five minutes on a project whose
    // organization is ambiguous.
    const quiet = storePath();
    await seed(quiet, oneCandidate({ cases: { [`flake:${TEST_ID}`]: flake({ state: "confirmed" }) } }));
    let asked = 0;
    const counting = async () => {
      asked += 1;
      return "loggd";
    };
    expect((await retryOnce(deps(quiet, { org: counting }))).outcome).toBe("none");
    expect(asked).toBe(0);

    const busy = storePath();
    await seed(busy, oneCandidate());
    expect(
      (await retryOnce(deps(busy, { org: counting, readCi: () => ({ busy: true, detail: "pending: #7" }) }))).outcome,
    ).toBe("busy");
    expect(asked).toBe(0);

    const live = storePath();
    await seed(live, oneCandidate());
    expect((await retryOnce(deps(live, { org: counting }))).outcome).toBe("retried");
    expect(asked).toBe(1);
  });

  it("reports an unresolvable organization as a fault rather than retrying nothing", async () => {
    const path = storePath();
    await seed(path, oneCandidate());
    const wired = deps(path, {
      org: async () => {
        throw new HelperError("which Buildkite organization? set RALPH_BUILDKITE_ORG, or pass a build URL", 1);
      },
    });
    const result = await retryOnce(wired);
    expect(result.outcome).toBe("fault");
    expect(result.why).toContain("which Buildkite organization?");
    expect(wired.calls).toEqual([]);
  });

  it("leaves the slot spent when Buildkite refuses the call, and never throws", async () => {
    const path = storePath();
    await seed(path, oneCandidate());
    const wired = deps(path, {
      put: async () => {
        throw new HelperError("Buildkite 500 on PUT /organizations/loggd/…", 2);
      },
    });
    const result = await retryOnce(wired);
    expect(result.outcome).toBe("fault");
    expect(result.why).toContain("Buildkite 500");
    expect(result.retried).toBeNull();
    // Spent on purpose: a non-2xx does not say whether the job started.
    expect(readStore(path).retries).toEqual({ day: DAY, count: 1, byCase: { [TEST_ID]: "job-a" } });
  });

  it("does not read GitHub at all when the gate's allowance has no room", async () => {
    const path = storePath();
    await seed(path, oneCandidate());
    let asked = 0;
    const wired = deps(path, {
      afford: () => false,
      readCi: () => {
        asked += 1;
        return { busy: false, detail: "" };
      },
    });
    const result = await retryOnce(wired);
    expect(result).toMatchObject({ outcome: "no-budget", ghCalls: 0 });
    expect(asked).toBe(0);
    expect(wired.calls).toEqual([]);
    expect(readStore(path).retries.count).toBe(0);
  });

  it("reports the GitHub calls its idle read spent, for the gate to record", async () => {
    const path = storePath();
    await seed(path, oneCandidate());
    expect(await retryOnce(deps(path))).toMatchObject({ outcome: "retried", ghCalls: 3 });
    // And a busy answer has still spent them: the reads were made.
    const busy = storePath();
    await seed(busy, oneCandidate());
    expect(await retryOnce(deps(busy, { readCi: () => ({ busy: true, detail: "pending: #7" }) }))).toMatchObject({
      outcome: "busy",
      ghCalls: 3,
    });
  });

  it("says there is nothing to do, without a host read, when no case is a candidate", async () => {
    const path = storePath();
    await seed(path, oneCandidate({ cases: { [`flake:${TEST_ID}`]: flake({ state: "confirmed" }) } }));
    let asked = 0;
    const wired = deps(path, {
      readCi: () => {
        asked += 1;
        return { busy: false, detail: "" };
      },
    });
    expect((await retryOnce(wired)).outcome).toBe("none");
    // The GitHub reads `readCi` makes count against the gate's budget, so they
    // are asked only once there is something to spend them on.
    expect(asked).toBe(0);
    expect(wired.calls).toEqual([]);
  });
});

describe("retryHead — the pr-medic's one retry per head commit (felipearos/ralph#246)", () => {
  const SHA = "e".repeat(40);
  const target = (over: Partial<HeadTarget> = {}): HeadTarget => ({
    pr: 2197,
    sha: SHA,
    branch: "felipearosr/x",
    build: 4821,
    jobs: ["job-1", "job-2"],
    ...over,
  });

  it("re-runs every failed job once, and never again at the same head", async () => {
    const path = storePath();
    const wired = deps(path);
    const first = await retryHead(wired, target());
    expect(first.outcome).toBe("retried");
    expect(wired.calls).toEqual([
      retryPath("loggd", "loggd", 4821, "job-1"),
      retryPath("loggd", "loggd", 4821, "job-2"),
    ]);
    expect(headRetried(readStore(path), 2197, SHA)).toBe(true);

    const again = await retryHead(wired, target());
    expect(again.outcome).toBe("none");
    expect(wired.calls).toHaveLength(2);

    // A new operator push is a new head, and gets its own one retry.
    expect((await retryHead(wired, target({ sha: "f".repeat(40) }))).outcome).toBe("retried");
    expect(wired.calls).toHaveLength(4);
  });

  it("spends the doctor's daily count, so the two roles share one cap", async () => {
    const path = storePath();
    await seed(path, oneCandidate({ retries: { day: DAY, count: 4, byCase: {} } }));
    // Two left today and two jobs: allowed, and it spends both.
    expect((await retryHead(deps(path), target())).outcome).toBe("retried");
    expect(readStore(path).retries.count).toBe(6);
    // The doctor now finds the day spent.
    expect((await retryOnce(deps(path))).outcome).toBe("capped");
  });

  it("refuses rather than retrying a subset when the day cannot cover every job", async () => {
    const path = storePath();
    await seed(path, oneCandidate({ retries: { day: DAY, count: 5, byCase: {} } }));
    const wired = deps(path);
    const result = await retryHead(wired, target());
    expect(result).toMatchObject({ outcome: "capped", ghCalls: 0 });
    expect(result.why).toContain("only 1 retries left");
    expect(wired.calls).toEqual([]);
    expect(headRetried(readStore(path), 2197, SHA)).toBe(false);
  });

  it("holds the doctor's host fences: a busy host, a held lease, no allowance", async () => {
    const fences: Partial<RetryDeps>[] = [
      { readCi: () => ({ busy: true, detail: "pending: #7" }) },
      { hostLeaseBusy: () => ({ busy: true, detail: "held by rafa" }) },
      { afford: () => false },
    ];
    for (const over of fences) {
      const path = storePath();
      const wired = deps(path, over);
      const result = await retryHead(wired, target());
      expect(["busy", "no-budget"]).toContain(result.outcome);
      expect(wired.calls).toEqual([]);
      // Not spent: the next poll may try this head again.
      expect(headRetried(readStore(path), 2197, SHA)).toBe(false);
    }
  });

  it("keeps the head spent when Buildkite refuses, and prunes records past their age", async () => {
    const path = storePath();
    const old = new Date(NOW - (HEAD_RETRY_KEEP_DAYS + 1) * 86_400_000).toISOString();
    await seed(path, { ...emptyish(), prRetries: { [headKey(1, SHA)]: { at: old, build: 1, jobs: ["j"] } } });
    const result = await retryHead(
      deps(path, {
        put: async () => {
          throw new HelperError("Buildkite 500", 2);
        },
      }),
      target(),
    );
    expect(result.outcome).toBe("fault");
    expect(Object.keys(readStore(path).prRetries ?? {})).toEqual([headKey(2197, SHA)]);
    expect(headRetried(readStore(path), 2197, SHA)).toBe(true);
  });
});
