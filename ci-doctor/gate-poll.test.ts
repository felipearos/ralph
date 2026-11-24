// @vitest-environment node
/**
 * One poll of the doctor's gate, end to end with every edge injected.
 *
 * Four acceptance criteria live here, and each is a thing that only shows up
 * once the reads, the store and the lease are wired together: the twelve-calls
 * ceiling over a whole idle hour, a throttle that starts no iteration, an
 * infrastructure incident notified exactly once and handed to nobody, and two
 * doctors on one store being handed one case between them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  noCache,
  poll,
  retryDep,
  retryLine,
  parkedOnFlake,
  searchLabels,
  type Cached,
  type Gh,
  type Incident,
  type PollDeps,
  type Ran,
} from "./gate";
import { GH_CALLS_PER_HOUR, readStore, withStore, type Case, type CiHealthStore } from "./store";
import { DEFAULT_CLASSIFY, classify, mergeCases } from "./classify";

process.env.RALPH_PROJECT = join(__dirname, "..", "fixtures", "loggd");

const T0 = Date.parse("2026-09-30T10:00:00.000Z");
const FLAKE = "src/a.test.ts > flaps";
const DAY = "2026-09-30";
const CODERS = ["ralph", "rafa", "remo", "rulo"];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-poll-"));
  dirs.push(dir);
  return join(dir, "ralph", "ci-health.json");
}

const ok = (value: unknown): Ran => ({ ok: true, stdout: JSON.stringify(value), stderr: "" });

const flake = (over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state: "confirmed",
  evidence: [{ build: 2600, branch: "main", commit: "abc", kind: "timeout", line: "FAIL" }],
  cost72h: { redBuilds: 2, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

/** A `gh` that records every call and answers each subcommand from `over`. */
function fakeGh(over: {
  prs?: unknown;
  registry?: unknown;
  search?: unknown;
  comments?: Record<number, unknown>;
  fail?: (args: string[]) => Ran | null;
} = {}): Gh & { calls: string[] } {
  const calls: string[] = [];
  const gh = (async (args: string[]): Promise<Ran> => {
    calls.push(args.join(" "));
    const forced = over.fail?.(args);
    if (forced !== null && forced !== undefined) return forced;
    if (args[0] === "pr") return ok(over.prs ?? []);
    if (args[1] === "view") return ok(over.comments?.[Number(args[2])] ?? { comments: [] });
    if (args.includes("--search")) return ok(over.search ?? []);
    return ok(over.registry ?? []);
  }) as Gh & { calls: string[] };
  gh.calls = calls;
  return gh;
}

function wire(
  path: string,
  gh: Gh,
  over: { loop?: string; run?: string; now?: () => number; seed?: (store: CiHealthStore) => void } = {},
): PollDeps & { raised: Incident[] } {
  const raised: Incident[] = [];
  return {
    gh,
    scan: async () => {
      if (over.seed) await withStore(path, over.seed);
      return { ok: true, why: "" };
    },
    notify: (incident) => raised.push(incident),
    now: over.now ?? (() => T0),
    storePath: path,
    loop: over.loop ?? "ralph",
    run: over.run ?? "run-a",
    coders: CODERS,
    alive: () => true,
    raised,
  };
}

describe("the GitHub budget, over an idle hour", () => {
  it("makes at most twelve calls however many times it polls", async () => {
    const path = storeFile();
    const gh = fakeGh();
    let now = T0;
    const deps = wire(path, gh, { now: () => now });

    // A whole idle hour at the configured 300s cadence: twelve polls.
    let cached: Cached = noCache();
    for (let tick = 0; tick < 12; tick++) {
      cached = (await poll(deps, cached)).cached;
      now += 300_000;
    }
    expect(gh.calls).toHaveLength(GH_CALLS_PER_HOUR);
    // Three standing reads, each on its own fifteen-minute cadence.
    expect(gh.calls.filter((call) => call.startsWith("pr list"))).toHaveLength(4);
    expect(gh.calls.filter((call) => call.includes("--label ci-health"))).toHaveLength(4);
    expect(gh.calls.filter((call) => call.includes("--search"))).toHaveLength(4);
  });

  it("carries the spend across processes, so a restart gets no fresh allowance", async () => {
    const path = storeFile();
    const first = fakeGh();
    await poll(wire(path, first), noCache());
    expect(readStore(path).gh?.ralph?.count).toBe(3);

    // A brand-new gate with a brand-new cache, one second later: it reads
    // again, because it holds no answer — but it ADDS to the same hour.
    const second = fakeGh();
    await poll(wire(path, second, { now: () => T0 + 1000 }), noCache());
    expect(readStore(path).gh?.ralph?.count).toBe(6);

    // Same process, warm cache, nothing due: nothing spent.
    const third = fakeGh();
    const warm = await poll(wire(path, third, { now: () => T0 + 2000 }), noCache());
    await poll(wire(path, third, { now: () => T0 + 3000 }), warm.cached);
    expect(readStore(path).gh?.ralph?.count).toBe(9);
  });

  it("still reads when the cache is cold, whatever the cadence marks say", async () => {
    // `--once`, and every restarted gate: the marks are in the store and the
    // answers are in the process, so a fresh gate inside fifteen minutes used
    // to find nothing due, hold no answer, and report the registry unreadable
    // — which `ralph.sh` stops the loop on.
    const path = storeFile();
    await poll(wire(path, fakeGh()), noCache());
    const fresh = fakeGh();
    const { verdict } = await poll(wire(path, fresh, { now: () => T0 + 60_000 }), noCache());
    expect(fresh.calls).toHaveLength(3);
    expect(verdict.why).not.toContain("could not be read");
    // Still bounded: the ceiling refuses the read, the cadence does not.
    await withStore(path, (store) => {
      store.gh = { ralph: { hourStart: new Date(T0).toISOString(), count: GH_CALLS_PER_HOUR, at: {} } };
    });
    const broke = fakeGh();
    await poll(wire(path, broke, { now: () => T0 + 120_000 }), noCache());
    expect(broke.calls).toHaveLength(0);
  });

  it("does not stamp a cadence it could not read, so one throttle blinds it for one poll", async () => {
    const path = storeFile();
    const failing = fakeGh({
      fail: (args) => (args.includes("--label") ? { ok: false, stdout: "", stderr: "API rate limit exceeded" } : null),
    });
    await poll(wire(path, failing), noCache());
    // The registry read failed, so its mark was never set: the next poll may
    // try again rather than waiting out the whole fifteen minutes blind.
    const retry = fakeGh();
    await poll(wire(path, retry, { now: () => T0 + 300_000 }), noCache());
    expect(retry.calls.filter((call) => call.includes("--label ci-health"))).toHaveLength(1);
  });

  it("keeps deciding from the cached reads on a poll that spends nothing", async () => {
    const path = storeFile();
    const gh = fakeGh({ registry: [] });
    const deps = wire(path, gh, { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake(); } });
    const first = await poll(deps, noCache());
    expect(first.verdict.work).toBe(true);

    // Nothing is due, so nothing is read — and the verdict is still a verdict,
    // not "the registry could not be read".
    const again = await poll(wire(path, gh, { now: () => T0 + 60_000 }), first.cached);
    expect(again.calls).toBe(0);
    // Its own lease is not a fence against itself, so the same case comes back.
    expect(again.verdict.key).toBe(`flake:${FLAKE}`);
  });
});

describe("a throttled read", () => {
  it("starts no iteration even with a workable case in the store", async () => {
    const path = storeFile();
    const gh = fakeGh({
      fail: (args) =>
        args[0] === "issue" && args.includes("--label")
          ? { ok: false, stdout: "", stderr: "API rate limit exceeded for user ID 1" }
          : null,
      prs: [],
    });
    const deps = wire(path, gh, { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake(); } });
    const { verdict } = await poll(deps, noCache());
    expect(verdict.work).toBe(false);
    expect(verdict.rateLimited).toBe(true);
    expect(verdict.why).toContain("rate-limited");
  });

  it("is reported as a throttle once the reads that did answer leave no case", async () => {
    const path = storeFile();
    const gh = fakeGh({
      fail: (args) => (args[1] === "view" ? { ok: false, stdout: "", stderr: "You have exceeded a secondary rate limit" } : null),
      search: [{ number: 1557, labels: [{ name: "rafa-blocked" }] }],
    });
    const { verdict } = await poll(wire(path, gh), noCache());
    expect(verdict.work).toBe(false);
    expect(verdict.rateLimited).toBe(true);
    expect(verdict.why).toContain("rate-limited");
  });
});

describe("an infrastructure case", () => {
  it("is notified once per signature and handed to nobody", async () => {
    const path = storeFile();
    const prs = [1, 2, 3].map((number) => ({
      number,
      isDraft: false,
      body: null,
      statusCheckRollup: [{ name: "Vercel", state: "FAILURE", description: "Account is blocked." }],
    }));
    const gh = fakeGh({ prs });
    const deps = wire(path, gh);

    const first = await poll(deps, noCache());
    expect(first.verdict.work).toBe(false);
    expect(first.verdict.why).toContain("cannot fix");
    expect(deps.raised).toHaveLength(1);
    expect(deps.raised[0]!.occurrence).toMatch(/^ci-incident:check:Vercel:Account is blocked\.:/);

    // The record is in the STORE, so a restarted doctor does not page again.
    const key = Object.keys(readStore(path).cases).find((k) => k.startsWith("infra:"))!;
    expect(readStore(path).cases[key]!.notified).toBe(deps.raised[0]!.occurrence);

    const second = wire(path, fakeGh({ prs }), { run: "run-restarted", now: () => T0 + 20 * 60_000 });
    await poll(second, noCache());
    expect(second.raised).toHaveLength(0);
  });

  it("is still remembered as notified after the scan folds its cases", async () => {
    // The regression this pins: `mergeCases` rebuilt every case from the
    // scan's proposal and dropped `notified` with it, and swept the
    // check-derived cases away outright — so the store record that beats
    // `push-notification.ts`'s per-RUN dedupe never survived one poll.
    const path = storeFile();
    const prs = [1, 2, 3].map((number) => ({
      number,
      isDraft: false,
      body: null,
      statusCheckRollup: [{ name: "Vercel", state: "FAILURE", description: "Account is blocked." }],
    }));
    const first = wire(path, fakeGh({ prs }));
    await poll(first, noCache());
    expect(first.raised).toHaveLength(1);

    const key = Object.keys(readStore(path).cases).find((k) => k.startsWith("infra:check:"))!;
    // A real scan's fold, not a fake's: this is what runs at the top of every poll.
    await withStore(path, (store) => {
      mergeCases(store, classify(store, T0 + 60_000, DEFAULT_CLASSIFY));
    });
    expect(readStore(path).cases[key]?.notified).toBe(first.raised[0]!.occurrence);

    const second = wire(path, fakeGh({ prs }), { run: "run-c", now: () => T0 + 20 * 60_000 });
    await poll(second, noCache());
    expect(second.raised).toHaveLength(0);
  });

  it("keeps a filed incident's issue number when a later read folds in", async () => {
    const path = storeFile();
    const prs = [1, 2, 3].map((number) => ({
      number,
      isDraft: false,
      body: null,
      statusCheckRollup: [{ name: "Vercel", state: "FAILURE", description: "Account is blocked." }],
    }));
    await poll(wire(path, fakeGh({ prs })), noCache());
    const key = Object.keys(readStore(path).cases).find((k) => k.startsWith("infra:check:"))!;
    await withStore(path, (store) => {
      store.cases[key]!.issue = 4242;
      store.cases[key]!.state = "filed";
    });

    await poll(wire(path, fakeGh({ prs }), { now: () => T0 + 20 * 60_000 }), noCache());
    const folded = readStore(path).cases[key]!;
    expect(folded.issue).toBe(4242);
    expect(folded.state).toBe("filed");
  });

  it("does not shadow a flake that IS workable", async () => {
    const path = storeFile();
    const deps = wire(path, fakeGh(), {
      seed: (store) => {
        store.cases["infra:agent-lost"] = flake({ kind: "infra", state: "candidate" });
        store.cases[`flake:${FLAKE}`] = flake();
      },
    });
    const { verdict } = await poll(deps, noCache());
    expect(verdict.key).toBe(`flake:${FLAKE}`);
    // Still notified: the incident is real whether or not there is other work.
    expect(deps.raised.map((incident) => incident.key)).toEqual(["infra:agent-lost"]);
  });
});

describe("two doctors on one store", () => {
  it("hand one case to exactly one iteration", async () => {
    const path = storeFile();
    const seed = (store: CiHealthStore) => { store.cases[`flake:${FLAKE}`] = flake(); };
    const ralph = wire(path, fakeGh(), { loop: "ralph", run: "run-a", seed });
    const rafa = wire(path, fakeGh(), { loop: "rafa", run: "run-b", seed });

    const [a, b] = await Promise.all([poll(ralph, noCache()), poll(rafa, noCache())]);
    const worked = [a, b].filter((polled) => polled.verdict.work);
    expect(worked).toHaveLength(1);
    expect(worked[0]!.verdict.key).toBe(`flake:${FLAKE}`);

    const idle = [a, b].find((polled) => !polled.verdict.work)!;
    expect(idle.verdict.why).toContain("held by another doctor");
    expect(Object.keys(readStore(path).leases)).toEqual([`flake:${FLAKE}`]);
  });

  it("let the second doctor take the next case rather than wait a whole interval", async () => {
    const path = storeFile();
    const seed = (store: CiHealthStore) => {
      store.cases[`flake:${FLAKE}`] = flake({ cost72h: { redBuilds: 9, mainReds: 0, dequeues: 0 } });
      store.cases["flake:src/b.test.ts > also"] = flake({ cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 } });
    };
    await poll(wire(path, fakeGh(), { loop: "ralph", run: "run-a", seed }), noCache());
    const second = await poll(wire(path, fakeGh(), { loop: "rafa", run: "run-b", now: () => T0 + 1000 }), noCache());
    expect(second.verdict.work).toBe(true);
    expect(second.verdict.key).toBe("flake:src/b.test.ts > also");
  });
});

describe("a parked coder ticket", () => {
  it("has its block comments read once ever, and is decided from the store after that", async () => {
    const path = storeFile();
    const search = [{ number: 1557, labels: [{ name: "rafa-blocked" }, { name: "ready-for-agent" }] }];
    const comments = {
      1557: { comments: [{ body: `blocked: PR #1681 red twice in CI\nunit: FAIL ${FLAKE} — Error: timeout` }] },
    };
    const gh = fakeGh({ search, comments });
    const deps = wire(path, gh, { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake({ state: "fixed" }); } });

    const first = await poll(deps, noCache());
    expect(gh.calls.filter((call) => call.startsWith("issue view"))).toHaveLength(1);
    expect(first.verdict.work).toBe(true);
    expect(first.verdict.key).toBe("parked:1557");
    expect(readStore(path).cases["parked:1557"]!.rule).toBe(FLAKE);

    // Fifteen minutes later the search runs again; the comments do not.
    const later = fakeGh({ search, comments });
    await poll(wire(path, later, { loop: "rafa", run: "run-b", now: () => T0 + 16 * 60_000 }), noCache());
    expect(later.calls.filter((call) => call.startsWith("issue view"))).toHaveLength(0);
  });

  it("counts, per UTC day, the highest number of tickets parked on a flake (#163)", async () => {
    const path = storeFile();
    const comments = (body: string) => ({ comments: [{ body }] });
    const two = fakeGh({
      search: [
        { number: 1557, labels: [{ name: "rafa-blocked" }] },
        { number: 1558, labels: [{ name: "ralph-blocked" }] },
        // Waiting on a person, not on a flake: not counted.
        { number: 1559, labels: [{ name: "rulo-blocked" }] },
      ],
      comments: {
        // The canonical CI block: `other` by kind, because only the lead line
        // is classified, but it names the test — the half the test id catches.
        1557: comments(`blocked: PR #1681 red twice in CI\nunit: FAIL ${FLAKE} — Error: timeout`),
        // And the other half: a flake by its lead line, naming no test file.
        1558: comments("blocked: PR #1690 red on a flaky test, not the diff"),
        1559: comments("needs-migration: draft PR #1242 ready; apply 0062.sql"),
      },
    });
    await poll(wire(path, two), noCache());
    expect(readStore(path).metrics[DAY]!.parkedOnFlake).toBe(2);
    expect(readStore(path).cases["parked:1559"]!.parkedOn).toBe("migration");

    // One ticket later: the day keeps the HIGHER count, because an unparked
    // ticket still cost the loops the hours it was parked.
    const one = fakeGh({
      search: [{ number: 1557, labels: [{ name: "rafa-blocked" }] }],
      comments: { 1557: comments(`blocked: PR #1681 red twice in CI\nunit: FAIL ${FLAKE}`) },
    });
    await poll(wire(path, one, { loop: "rafa", run: "run-b", now: () => T0 + 16 * 60_000 }), noCache());
    const store = readStore(path);
    expect(store.metrics[DAY]!.parkedOnFlake).toBe(2);
    // And it did not disturb the scan's own half of the day.
    expect(store.metrics[DAY]!.knownFlakeReds).toBe(0);
  });

  it("does not count a block that merely mentions a test file (#163)", async () => {
    const path = storeFile();
    const gh = fakeGh({
      search: [{ number: 1560, labels: [{ name: "rafa-blocked" }] }],
      // `testIdOf`'s fallback finds `src/a.test.ts` here, so the ticket has a
      // `rule` — but nothing failed, and the metric must not say it did.
      comments: { 1560: { comments: [{ body: "blocked: ambiguous spec; the diff touches src/a.test.ts" }] } },
    });
    await poll(wire(path, gh), noCache());
    const store = readStore(path);
    expect(store.cases["parked:1560"]!.rule).toBe("src/a.test.ts");
    expect(store.cases["parked:1560"]!.parkedOn).toBe("other");
    expect(store.metrics[DAY]!.parkedOnFlake).toBe(0);
  });

  it("writes no parked count at all on a poll whose search could not run (#163)", async () => {
    const path = storeFile();
    const gh = fakeGh({ fail: (args) => (args.includes("--search") ? { ok: false, stdout: "", stderr: "boom" } : null) });
    await poll(wire(path, gh), noCache());
    expect(readStore(path).metrics).toEqual({});
  });

  it("is not taken for a block that is waiting on a person", async () => {
    const path = storeFile();
    const gh = fakeGh({
      search: [{ number: 1557, labels: [{ name: "rafa-blocked" }] }],
      comments: { 1557: { comments: [{ body: `needs-migration: draft PR #1242 ready; apply 0062.sql (${FLAKE})` }] } },
    });
    const deps = wire(path, gh, { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake({ state: "fixed" }); } });
    const { verdict } = await poll(deps, noCache());
    expect(verdict.key).not.toBe("parked:1557");
    expect(readStore(path).cases["parked:1557"]!.rule).toBeNull();
  });
});

describe("Buildkite", () => {
  it("unreadable is a wait, not a handover from a stale store", async () => {
    const path = storeFile();
    const gh = fakeGh();
    const deps: PollDeps = {
      ...wire(path, gh, { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake(); } }),
      scan: async () => ({ ok: false, why: "Buildkite could not be read (503)" }),
    };
    const { verdict, calls } = await poll(deps, noCache());
    expect(verdict).toEqual({ work: false, why: "Buildkite could not be read (503)", key: null });
    // And it costs no GitHub call: there is nothing fresh to decide from.
    expect(calls).toBe(0);
  });
});

describe("the retry, wired into the poll (#161)", () => {
  it("is not called at all when the doctor holds no retry token", async () => {
    const path = storeFile();
    // `wire` sets no `retry`, which is what a doctor without the token has:
    // the poll then behaves exactly as it did on natural reruns alone (AC 6).
    const deps = wire(path, fakeGh(), { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake(); } });
    expect(deps.retry).toBeUndefined();
    const polled = await poll(deps, noCache());
    expect(polled.retried).toBeNull();
    expect(polled.verdict.work).toBe(true);
  });

  it("runs once per poll and does not change the verdict it hands over", async () => {
    const path = storeFile();
    let ran = 0;
    const deps: PollDeps = {
      ...wire(path, fakeGh(), { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake(); } }),
      retry: async () => {
        ran += 1;
        return { outcome: "retried", why: `retried job-a of build #10 for ${FLAKE}`, retried: null, ghCalls: 3 };
      },
    };
    const polled = await poll(deps, noCache());
    expect(ran).toBe(1);
    expect(polled.retried?.outcome).toBe("retried");
    // The retried job is evidence the NEXT scan reads, so this poll still
    // hands over the case it would have handed over anyway.
    expect(polled.verdict).toMatchObject({ work: true, key: `flake:${FLAKE}` });
    expect(retryLine(polled.retried!)).toBe(`ci-doctor-gate: retry retried — retried job-a of build #10 for ${FLAKE}`);
  });

  describe("retryDep — whether this doctor can retry at all", () => {
    const PROJECT = join(__dirname, "..", "fixtures", "loggd");
    const READ = "bkua_0123456789abcdef0123456789abcdef01234567";
    const RETRY = "bkua_fedcba9876543210fedcba9876543210fedcba98";
    const both = {
      RALPH_BUILDKITE_READ_TOKEN: READ,
      RALPH_BUILDKITE_RETRY_TOKEN: RETRY,
      RALPH_BUILDKITE_PIPELINE: "loggd",
      RALPH_BUILDKITE_ORG: "loggd",
    };

    it("is wired when the doctor has both tokens and a pipeline", () => {
      expect(retryDep(PROJECT, both)).toBeDefined();
    });

    it("is NOT wired without the READ token, even with a perfectly good retry token", () => {
      // The regression guard for the defect both review axes found: `resolveOrg`
      // asks `/builds` and `/organizations`, and a token whose scope list is
      // exactly `write_builds` — the only kind `--check-retry-token` accepts —
      // can read neither. Resolving the org with the retry token threw on every
      // poll, so the feature never fired unless `RALPH_BUILDKITE_ORG` happened
      // to be set, and logged a `fault` each time. Anyone who drops the read
      // token from this condition has put that back.
      expect(retryDep(PROJECT, { ...both, RALPH_BUILDKITE_READ_TOKEN: "" })).toBeUndefined();
    });

    it("is not wired without a retry token", () => {
      expect(retryDep(PROJECT, { ...both, RALPH_BUILDKITE_RETRY_TOKEN: "" })).toBeUndefined();
    });

    it("wires the GitHub Actions retry, with no Buildkite token, when no required check is a buildkite/<slug> one (#52)", () => {
      // Such a project's CI is Actions (`ci-log.ts`'s projectProvider): there
      // is no pipeline to address, but a failed job re-runs through gh's own
      // auth, under the same ciDoctor.retry limits.
      expect(
        retryDep(PROJECT, {
          RALPH_REQUIRED_CHECKS: "test",
          RALPH_PROJECT_REPO: "acme-org/acme-app",
          RALPH_BASE_BRANCH: "main",
        }),
      ).toBeDefined();
    });
  });

  it("renders an outcome as one supervisor line, and never a token", () => {
    expect(retryLine({ outcome: "busy", why: "the host lease is in use: held by rafa for #9", retried: null, ghCalls: 0 })).toBe(
      "ci-doctor-gate: retry busy — the host lease is in use: held by rafa for #9",
    );
    // The line is what `main` compares against the previous poll's to decide
    // whether to print at all, so two different answers must not render alike.
    const none = retryLine({ outcome: "none", why: "no candidate flake has a retryable failed job", retried: null, ghCalls: 0 });
    expect(none).not.toBe(retryLine({ outcome: "capped", why: "no candidate flake has a retryable failed job", retried: null, ghCalls: 0 }));
  });

  it("spends its idle read on the gate's own GitHub ledger", async () => {
    const path = storeFile();
    const deps: PollDeps = {
      ...wire(path, fakeGh(), { seed: (store) => { store.cases[`flake:${FLAKE}`] = flake(); } }),
      retry: async ({ afford }) => ({
        outcome: afford(3) ? "retried" : "no-budget",
        why: "",
        retried: null,
        ghCalls: afford(3) ? 3 : 0,
      }),
    };
    const polled = await poll(deps, noCache());
    expect(polled.retried?.outcome).toBe("retried");
    // The poll's own reads plus the retry's three, on one counter: the ceiling
    // is what protects the account, and a read outside it is a read nobody
    // counted.
    const ledger = readStore(path).gh!.ralph!;
    expect(ledger.count).toBe(polled.calls + 3);
    expect(ledger.count).toBeLessThanOrEqual(GH_CALLS_PER_HOUR);
  });

  it("is skipped, with the scan, when Buildkite cannot be read", async () => {
    const path = storeFile();
    let ran = 0;
    const deps: PollDeps = {
      ...wire(path, fakeGh()),
      scan: async () => ({ ok: false, why: "Buildkite could not be read (503)" }),
      retry: async () => {
        ran += 1;
        return { outcome: "none", why: "", retried: null, ghCalls: 0 };
      },
    };
    const polled = await poll(deps, noCache());
    // Nothing fresh to retry FROM, and the same API that just refused a read.
    expect(ran).toBe(0);
    expect(polled.retried).toBeNull();
  });
});

describe("parkedOnFlake", () => {
  it("counts what the record says it is parked on, and never a migration", () => {
    expect(
      parkedOnFlake([
        { number: 1, loop: "rafa", testId: FLAKE, parkedOn: "flake" },
        { number: 2, loop: "ralph", testId: null, parkedOn: "flake" },
        { number: 3, loop: "remo", testId: FLAKE, parkedOn: "migration" },
        // Named a test file, but the record is not about a failure: the
        // looseness of `testIdOf`'s fallback must not reach the metric.
        { number: 4, loop: "rulo", testId: "src/b.test.ts", parkedOn: "other" },
        { number: 5, loop: "rulo", testId: null, parkedOn: "unknown" },
      ]),
    ).toBe(2);
  });

  it("falls back to the named test id only for a case written before #163", () => {
    expect(
      parkedOnFlake([
        { number: 1, loop: "rafa", testId: FLAKE },
        { number: 2, loop: "ralph", testId: null },
      ]),
    ).toBe(1);
  });
});

describe("searchLabels", () => {
  it("is one OR'd label search over the coders, not one call each", () => {
    expect(searchLabels(CODERS)).toBe("label:ralph-blocked,rafa-blocked,remo-blocked,rulo-blocked");
  });
});
