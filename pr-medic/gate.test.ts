// @vitest-environment node
/**
 * felipearos/ralph#246's acceptance criteria for `pr-medic/gate.ts`:
 *
 *  AC 1 — each exclusion, through a fake `gh`: draft, agent branch,
 *         non-matching branch, quiet period, `medi-blocked`, a held
 *         `medi-wip`, the push cap.
 *  AC 2 — a PR red only on a known flake gets at most one retry per head
 *         commit and no iteration.
 *  AC 3 — two gates racing for one PR: exactly one claims it.
 *  AC 4 — `--once` prints the verdict for the operator, like the doctor's.
 *
 * The ci-health store is REAL (a temp file and the real `withStore`), because
 * the GitHub ledger and the retry's once-per-head record are claims on that
 * file. `gh` is a fake hub that keeps the pull requests' labels, so a claim is
 * an assertion over the label it left behind rather than over a call list.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Ran } from "../ci-doctor/gate";
import { retryHead, retryPath, type RetryDeps } from "../ci-doctor/retry";
import { GH_CALLS_PER_HOUR, readStore, withStore } from "../ci-doctor/store";
import {
  claimLease,
  currentLeaseOf,
  leaseBlocksClaim,
  readLeaseStore,
  renewLease,
  writeLeaseStore,
  type LeaseStore,
} from "../claim-lease";
import { supervisorGone, supervisorPidFrom } from "../frontier-gate";
import { withClaimLock } from "../frontier/next-tasks";
import { subprocessSuite } from "../test-timeouts";
import { adoptionMarker, type Unattended } from "./adoption";
import type { KnownVerdict } from "./known-red";
import {
  CLAIM_CALLS,
  assess,
  caseText,
  idleWhy,
  medicPushes,
  noCache,
  PR_FIELDS,
  PR_LIST_LIMIT,
  poll,
  reasonOf,
  verdictLine,
  type Cached,
  type OperatorPr,
  type PollDeps,
  type Rules,
} from "./gate";

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const HEAD = "a".repeat(40);
const OLD = new Date(T0 - 60 * 60_000).toISOString();

const RULES: Rules = {
  loop: "medi",
  loops: ["ralph", "rafa", "medi", "mede"],
  medics: ["medi", "mede"],
  branches: ["felipearosr/*"],
  quietMinutes: 15,
  maxPushes: 3,
  requiredChecks: ["buildkite/loggd"],
};

/** An unattended set naming `loops`, each failed an hour ago. */
const unattended = (...loops: string[]): Unattended =>
  new Map(loops.map((loop) => [loop, { loop, stopKind: "failed" as const, downSince: OLD }]));

const RED = [{ __typename: "StatusContext", context: "buildkite/loggd", state: "FAILURE", targetUrl: null }];
const GREEN = [{ __typename: "StatusContext", context: "buildkite/loggd", state: "SUCCESS", targetUrl: null }];
const PENDING = [{ __typename: "StatusContext", context: "buildkite/loggd", state: "PENDING", targetUrl: null }];

const operator = { oid: "o".repeat(40), committedDate: OLD, messageBody: "operator work" };
const medic = (n: number) => ({ oid: `${n}`.repeat(40).slice(0, 40), committedDate: OLD, messageBody: `fix\n\nPr-Medic: medi` });

/** A red, ready, quiet operator PR — a case — unless `over` says otherwise. */
const pr = (over: Partial<OperatorPr> = {}): OperatorPr => ({
  number: 2197,
  isDraft: false,
  headRefName: "felipearosr/thing",
  headRefOid: HEAD,
  mergeStateStatus: "CLEAN",
  labels: [],
  statusCheckRollup: RED,
  commits: [{ ...operator, oid: HEAD }],
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "medic-gate-"));
  dirs.push(dir);
  return dir;
};

const ok = (value: unknown): Ran => ({ ok: true, stdout: JSON.stringify(value), stderr: "" });
const fail = (stderr: string): Ran => ({ ok: false, stdout: "", stderr });

/**
 * GitHub, as far as the gate sees it: the open PRs, whose labels a claim
 * edits. Every call yields first, so two gates polled with `Promise.all`
 * genuinely interleave rather than running one after the other.
 */
function hub(prs: OperatorPr[], over: { fail?: (args: string[]) => Ran | null } = {}) {
  const calls: string[] = [];
  const byNumber = new Map(prs.map((one) => [one.number, structuredClone(one)]));
  const comments = new Map<number, { body: string }[]>();
  const gh = async (args: string[]): Promise<Ran> => {
    await new Promise((done) => setImmediate(done));
    calls.push(args.join(" "));
    const forced = over.fail?.(args);
    if (forced) return forced;
    if (args[0] === "pr" && args[1] === "list") return ok([...byNumber.values()]);
    const one = byNumber.get(Number(args[2]));
    if (one === undefined) return fail("no such PR");
    if (args[1] === "view") {
      const live = { state: "OPEN", isDraft: one.isDraft, headRefOid: one.headRefOid, labels: one.labels };
      return ok(args[4]?.includes("comments") ? { ...live, comments: comments.get(one.number) ?? [] } : live);
    }
    if (args[1] === "comment" && args[3] === "--body") {
      comments.set(one.number, [...(comments.get(one.number) ?? []), { body: args[4]! }]);
      return ok({});
    }
    if (args[1] === "edit") {
      const [flag, label] = [args[3], args[4]!];
      const names = (one.labels ?? []).map((l) => l.name).filter((name) => name !== label);
      one.labels = (flag === "--add-label" ? [...names, label] : names).map((name) => ({ name }));
      return ok({});
    }
    return fail(`unexpected ${args.join(" ")}`);
  };
  return {
    gh,
    calls,
    labels: (n: number) => (byNumber.get(n)?.labels ?? []).map((l) => l.name),
    comments: (n: number) => comments.get(n) ?? [],
    /** The PR as the next list will read it. */
    listed: (n: number) => structuredClone(byNumber.get(n)!),
  };
}

const unknown = async (): Promise<KnownVerdict> => ({ kind: "unknown", why: "not a known flake" });

function wire(gh: PollDeps["gh"], over: Partial<PollDeps> & { store?: string } = {}): PollDeps {
  const dir = over.store ?? scratch();
  return {
    gh,
    now: () => T0,
    storePath: join(dir, "ci-health.json"),
    rules: RULES,
    known: unknown,
    withLock: (critical) => critical(),
    unattended: () => null,
    ...over,
  };
}


// The `--once` tests spawn the gate with bun, which may spawn bun again for
// the unattended read.
subprocessSuite("runs pr-medic/gate.ts through bun");

describe("assess — each exclusion", () => {
  const why = (one: OperatorPr, rules: Rules = RULES): string => {
    const result = assess(one, rules, T0);
    return result.kind === "skip" ? result.why : `case: ${result.reason}`;
  };

  it("takes a red, ready, quiet operator PR, and a conflicting one whatever its checks", () => {
    expect(why(pr())).toBe("case: red: buildkite/loggd");
    expect(why(pr({ mergeStateStatus: "DIRTY", statusCheckRollup: GREEN }))).toBe("case: conflicting");
    expect(why(pr({ mergeStateStatus: "DIRTY" }))).toBe("case: conflicting; red: buildkite/loggd");
  });

  it("skips a draft", () => {
    expect(why(pr({ isDraft: true }))).toBe("draft");
  });

  it("skips an agent's branch, even one a careless glob would match, while its loop is attended", () => {
    expect(why(pr({ headRefName: "rafa/2197-thing" }))).toBe("rafa/2197-thing is the rafa loop's branch");
    expect(why(pr({ headRefName: "medi/x" }), { ...RULES, branches: ["**"] })).toBe("medi/x is the medi loop's branch");
    // A known unattended set that does not name the owner changes nothing.
    const others = assess(pr({ headRefName: "rafa/2197-thing" }), RULES, T0, unattended("ralph"));
    expect(others).toMatchObject({ kind: "skip", why: "rafa/2197-thing is the rafa loop's branch", operator: false });
  });

  it("skips a branch no prMedic.branches glob matches", () => {
    expect(why(pr({ headRefName: "renovate/react-19" }))).toBe("renovate/react-19 matches no prMedic.branches glob");
    // `*` is one segment in the harness's dialect.
    expect(why(pr({ headRefName: "felipearosr/a/b" }))).toContain("matches no prMedic.branches glob");
  });

  it("skips a head commit younger than the quiet period", () => {
    const young = new Date(T0 - 5 * 60_000).toISOString();
    expect(why(pr({ commits: [{ ...operator, oid: HEAD, committedDate: young }] }))).toBe("pushed 5m ago (quiet for 15m)");
    expect(why(pr({ commits: [] }))).toBe("its head commit's time could not be read");
  });

  it("skips a PR any medic labelled blocked", () => {
    expect(why(pr({ labels: [{ name: "medi-blocked" }] }))).toBe("labelled medi-blocked");
    expect(why(pr({ labels: [{ name: "mede-blocked" }] }))).toBe("labelled mede-blocked");
  });

  it("skips a PR another medic holds, and resumes one this loop holds", () => {
    expect(why(pr({ labels: [{ name: "mede-wip" }] }))).toBe("held by mede-wip");
    const mine = assess(pr({ labels: [{ name: "medi-wip" }] }), RULES, T0);
    expect(mine).toMatchObject({ kind: "case", resumed: true });
    // Both: roster order decides, so exactly one of the two takes it.
    const both = pr({ labels: [{ name: "medi-wip" }, { name: "mede-wip" }] });
    expect(assess(both, RULES, T0)).toMatchObject({ kind: "case", resumed: true });
    expect(assess(both, { ...RULES, loop: "mede" }, T0)).toMatchObject({ kind: "skip", why: "held by medi-wip" });
  });

  it("skips a PR whose medic pushes since the operator's last reached the cap", () => {
    const capped = pr({ commits: [operator, medic(1), medic(2), { ...medic(3), oid: HEAD }] });
    expect(medicPushes(capped)).toBe(3);
    expect(why(capped)).toBe("3 medic pushes since the operator's last (cap 3)");
    // An operator push on top clears the count.
    const cleared = pr({ commits: [operator, medic(1), medic(2), medic(3), { ...operator, oid: HEAD }] });
    expect(medicPushes(cleared)).toBe(0);
    expect(why(cleared)).toBe("case: red: buildkite/loggd");
  });

  it("skips a green PR and one still running, and resumes its own claim only once CI has spoken", () => {
    expect(why(pr({ statusCheckRollup: GREEN }))).toBe("green");
    expect(why(pr({ statusCheckRollup: PENDING }))).toBe("buildkite/loggd still running");
    // A required check that has not reported at all is pending, not green.
    expect(why(pr({ statusCheckRollup: [] }))).toBe("buildkite/loggd still running");
    const held = { labels: [{ name: "medi-wip" }] };
    expect(why(pr({ ...held, statusCheckRollup: PENDING }))).toBe("this loop's claim; buildkite/loggd still running");
    expect(why(pr({ ...held, statusCheckRollup: GREEN }))).toBe("case: green");
  });

  it("skips an agent's draft as no operator PR at all", () => {
    const draft = assess(pr({ headRefName: "rafa/12-x", isDraft: true }), RULES, T0, unattended("rafa"));
    expect(draft).toMatchObject({ kind: "skip", why: "draft", operator: false });
    expect(idleWhy([draft], [])).toBe("no open operator pull request");
    expect(assess(pr({ isDraft: true }), RULES, T0)).toMatchObject({ kind: "skip", why: "draft", operator: true });
  });

  it("spells the reason the supervisor exports", () => {
    expect(reasonOf(["buildkite/loggd", "Vercel"], false)).toBe("red: buildkite/loggd, Vercel");
    expect(reasonOf([], true)).toBe("conflicting");
  });
});

describe("assess — adopting an unattended loop's PR (#425)", () => {
  const RAFA = "rafa/12-x";
  const loopPr = (over: Partial<OperatorPr> = {}): OperatorPr => pr({ headRefName: RAFA, ...over });
  const held = { labels: [{ name: "medi-wip" }] };
  const why = (one: OperatorPr, set: Unattended | null, rules: Rules = RULES): string => {
    const result = assess(one, rules, T0, set);
    return result.kind === "skip" ? result.why : `case: ${result.reason}`;
  };

  it("adopts an unattended owner's red PR, and a conflicting one", () => {
    const red = assess(loopPr(), RULES, T0, unattended("rafa"));
    expect(red).toMatchObject({
      kind: "case",
      reason: "adopted from rafa; red: buildkite/loggd",
      owner: "rafa",
      adopted: { loop: "rafa", stopKind: "failed" },
      handback: false,
      resumed: false,
    });
    const dirty = loopPr({ mergeStateStatus: "DIRTY", statusCheckRollup: GREEN });
    expect(why(dirty, unattended("rafa"))).toBe("case: adopted from rafa; conflicting");
  });

  it("adopts past the prMedic.branches glob, which a loop's branch never consults", () => {
    expect(why(loopPr(), unattended("rafa"), { ...RULES, branches: ["nothing/*"] })).toBe(
      "case: adopted from rafa; red: buildkite/loggd",
    );
  });

  it("skips an unattended owner's PR the operator's exclusions would skip", () => {
    const set = unattended("rafa");
    expect(why(loopPr({ statusCheckRollup: GREEN }), set)).toBe("green");
    expect(why(loopPr({ statusCheckRollup: PENDING }), set)).toBe("buildkite/loggd still running");
    expect(why(loopPr({ isDraft: true }), set)).toBe("draft");
    expect(why(loopPr({ isDraft: true, ...held }), set)).toBe("draft");
    expect(why(loopPr({ labels: [{ name: "medi-blocked" }] }), set)).toBe("labelled medi-blocked");
    expect(why(loopPr({ labels: [{ name: "mede-wip" }] }), set)).toBe("held by mede-wip");
    const young = new Date(T0 - 5 * 60_000).toISOString();
    expect(why(loopPr({ commits: [{ ...operator, oid: HEAD, committedDate: young }] }), set)).toBe(
      "pushed 5m ago (quiet for 15m)",
    );
    const capped = loopPr({ commits: [operator, medic(1), medic(2), { ...medic(3), oid: HEAD }] });
    expect(why(capped, set)).toBe("3 medic pushes since the operator's last (cap 3)");
  });

  it("resumes an adopted PR whatever its colour while the owner stays away", () => {
    const set = unattended("rafa");
    const green = assess(loopPr({ ...held, statusCheckRollup: GREEN }), RULES, T0, set);
    expect(green).toMatchObject({ kind: "case", reason: "adopted from rafa; green", resumed: true, adopted: null, handback: false });
    expect(why(loopPr(held), set)).toBe("case: adopted from rafa; red: buildkite/loggd");
    expect(why(loopPr({ ...held, statusCheckRollup: PENDING }), set)).toBe("this loop's claim; buildkite/loggd still running");
  });

  it("hands an adopted PR back once its owner is no longer unattended, whatever CI says", () => {
    for (const rollup of [RED, GREEN, PENDING]) {
      const back = assess(loopPr({ ...held, statusCheckRollup: rollup }), RULES, T0, unattended());
      expect(back).toMatchObject({ kind: "case", reason: "handback: rafa is back", handback: true, resumed: true, owner: "rafa" });
    }
  });

  it("hands nothing back when the unattended set could not be read", () => {
    const unread = assess(loopPr(held), RULES, T0, null);
    expect(unread).toMatchObject({ kind: "case", reason: "adopted from rafa; red: buildkite/loggd", handback: false, resumed: true });
    // Nor adopts anything new.
    expect(why(loopPr(), null)).toBe(`${RAFA} is the rafa loop's branch`);
  });
});

describe("poll — the exclusions through a fake gh", () => {
  const cases: [string, Partial<OperatorPr>, string][] = [
    ["draft", { isDraft: true }, "draft"],
    ["agent branch", { headRefName: "ralph/2197-x" }, "no open operator pull request"],
    ["non-matching branch", { headRefName: "dependabot/npm/x" }, "no open operator pull request"],
    ["quiet period", { commits: [{ ...operator, oid: HEAD, committedDate: new Date(T0 - 60_000).toISOString() }] }, "pushed 1m ago"],
    ["medi-blocked", { labels: [{ name: "medi-blocked" }] }, "labelled medi-blocked"],
    ["held medi-wip", { labels: [{ name: "mede-wip" }] }, "held by mede-wip"],
    ["cap reached", { commits: [medic(1), medic(2), { ...medic(3), oid: HEAD }] }, "3 medic pushes"],
  ];

  for (const [name, over, said] of cases) {
    it(`spawns nothing and claims nothing for a ${name}`, async () => {
      const github = hub([pr(over)]);
      const { verdict } = await poll(wire(github.gh), noCache());
      expect(verdict.work).toBe(false);
      expect(verdict.why).toContain(said);
      expect(github.calls.filter((call) => call.startsWith("pr edit"))).toEqual([]);
      expect(github.labels(2197)).toEqual((over.labels ?? []).map((l) => l.name));
    });
  }

  it("claims the oldest case, and hands over its number and reason", async () => {
    const github = hub([pr({ number: 2200 }), pr({ number: 2198, mergeStateStatus: "DIRTY" }), pr({ number: 2199 })]);
    const { verdict } = await poll(wire(github.gh), noCache());
    expect(verdict).toMatchObject({ work: true, pr: 2198, reason: "conflicting; red: buildkite/loggd" });
    expect(verdict.why).toBe("operator PR #2198 on felipearosr/thing — conflicting; red: buildkite/loggd");
    expect(github.labels(2198)).toEqual(["medi-wip"]);
    expect(github.labels(2199)).toEqual([]);
    // List, re-read, write, read back: nothing else.
    expect(github.calls).toEqual([
      expect.stringMatching(/^pr list --state open/),
      "pr view 2198 --json state,isDraft,headRefOid,labels",
      "pr edit 2198 --add-label medi-wip",
      "pr view 2198 --json labels",
    ]);
  });

  it("resumes a PR this loop already holds without claiming it again", async () => {
    const github = hub([pr({ number: 2190, labels: [{ name: "medi-wip" }] }), pr({ number: 2180 })]);
    const { verdict } = await poll(wire(github.gh), noCache());
    expect(verdict).toMatchObject({ work: true, pr: 2190, resumed: true });
    expect(github.calls.filter((call) => !call.startsWith("pr list"))).toEqual([]);
  });

  it("walks on when the live re-read shows the list was stale", async () => {
    const github = hub([pr({ number: 2197 }), pr({ number: 2198 })]);
    const stale: Cached = { prs: [pr({ number: 2197 }), pr({ number: 2198 })], known: {} };
    // Another medic took #2197 after this gate's list was read.
    await github.gh(["pr", "edit", "2197", "--add-label", "mede-wip"]);
    github.calls.length = 0;
    const { verdict } = await poll(wire(github.gh), stale);
    expect(verdict).toMatchObject({ work: true, pr: 2198 });
    expect(github.labels(2197)).toEqual(["mede-wip"]);
  });

  it("starts no iteration when GitHub throttles, and none when the list cannot be read", async () => {
    const throttled = hub([pr()], { fail: () => fail("HTTP 403: API rate limit exceeded for user") });
    const first = await poll(wire(throttled.gh), noCache());
    expect(first.verdict).toMatchObject({ work: false, rateLimited: true });

    const broken = hub([pr()], { fail: (args) => (args[1] === "list" ? fail("HTTP 502") : null) });
    const second = await poll(wire(broken.gh), noCache());
    expect(second.verdict).toMatchObject({ work: false, why: "the open pull requests could not be read" });
  });

  it("never spawns on an unreadable claim, and resumes the claim it may have made", async () => {
    const dir = scratch();
    const github = hub([pr()], { fail: (args) => (args.join(" ") === "pr view 2197 --json labels" ? fail("HTTP 502") : null) });
    const first = await poll(wire(github.gh, { store: dir }), noCache());
    expect(first.verdict.work).toBe(false);
    expect(first.verdict.why).toContain("reading the claim back failed");
    // The label did land; the next poll reads it as this loop's own claim.
    const healed = hub([pr({ labels: [{ name: "medi-wip" }] })]);
    const second = await poll(wire(healed.gh, { store: dir }), noCache());
    expect(second.verdict).toMatchObject({ work: true, resumed: true });
  });

  it("charges every call to the loop's ledger, and stays inside twelve an hour", async () => {
    const dir = scratch();
    const github = hub([pr({ statusCheckRollup: GREEN })]);
    let now = T0;
    let cached = noCache();
    for (let tick = 0; tick < 12; tick++) {
      cached = (await poll(wire(github.gh, { store: dir, now: () => now }), cached)).cached;
      now += 300_000;
    }
    // One list every ten minutes: half the polls, half the allowance — the
    // other half is what a claim and a retry are paid from.
    expect(github.calls).toHaveLength(6);
    expect(readStore(join(dir, "ci-health.json")).gh?.medi?.count).toBe(6);
    expect(6 + CLAIM_CALLS).toBeLessThanOrEqual(GH_CALLS_PER_HOUR);
  });

  it("dry-run names the case without claiming it", async () => {
    const github = hub([pr()]);
    const { verdict } = await poll(wire(github.gh, { dryRun: true }), noCache());
    expect(verdict).toMatchObject({ work: true, pr: 2197 });
    expect(github.labels(2197)).toEqual([]);
  });
});

describe("poll — adopting an unattended loop's PR (#425)", () => {
  const SUPERVISOR = 424_242;
  const IDENTITY = { run: "run-medi", loop: "medi", pid: SUPERVISOR };
  const MARK = adoptionMarker("adopt", "medi", HEAD);
  const loopPr = (over: Partial<OperatorPr> = {}): OperatorPr => pr({ number: 3001, headRefName: "rafa/12-x", ...over });

  /** A poll with an adoption identity and a scratch lease store; `pidAlive` says every pid is gone unless told. */
  function adopting(gh: PollDeps["gh"], over: Partial<PollDeps> & { store?: string; leases?: string } = {}) {
    const leases = over.leases ?? scratch();
    const leasePath = join(leases, "ralph-claim-leases.json");
    const deps = wire(gh, {
      unattended: () => unattended("rafa", "ralph"),
      adoption: { leasePath, identity: IDENTITY, worktree: leases, pidAlive: () => false },
      ...over,
    });
    return { deps, leasePath, leases: (): LeaseStore => readLeaseStore(leasePath) };
  }

  /** The owner's lease on #12, written as its supervisor left it. */
  function ownerLease(path: string, expiresInMs: number): void {
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, { issue: 12, run: "run-rafa", loop: "rafa", pid: 7, host: "elsewhere", worktree: "/tmp/rafa", branch: "rafa/12-x", nowMs: T0 - 600_000 });
    store.leases["12"]!.expiresAt = new Date(T0 + expiresInMs).toISOString();
    writeLeaseStore(path, store);
  }

  it("adopts an unattended owner's red PR: the lease under the supervisor's pid, one marked comment", async () => {
    const github = hub([loopPr()]);
    const { deps, leases } = adopting(github.gh);
    const { verdict } = await poll(deps, noCache());
    expect(verdict).toMatchObject({ work: true, pr: 3001, reason: "adopted from rafa; red: buildkite/loggd" });
    expect(verdict.why).toBe("operator PR #3001 on rafa/12-x — adopted from rafa; red: buildkite/loggd");
    expect(github.labels(3001)).toEqual(["medi-wip"]);
    const lease = leases().leases["12"];
    expect(lease).toMatchObject({ run: "run-medi", loop: "medi", pid: SUPERVISOR, branch: "rafa/12-x" });
    expect(lease?.pid).not.toBe(process.pid);
    expect(github.comments(3001)).toHaveLength(1);
    expect(github.comments(3001)[0]!.body).toContain(MARK);
    expect(github.calls).toContain("pr view 3001 --json state,isDraft,headRefOid,labels,comments");
    expect(readStore(deps.storePath).medicAdoptions?.medi).toEqual({ pr: 3001, head: HEAD, issue: 12 });
  });

  it("adopts nothing, and does not throw, when the unattended read is null or throws", async () => {
    for (const read of [() => null, () => { throw new Error("bun is gone"); }]) {
      const github = hub([loopPr()]);
      const { deps, leases } = adopting(github.gh, { unattended: read });
      const { verdict } = await poll(deps, noCache());
      expect(verdict.work).toBe(false);
      expect(github.labels(3001)).toEqual([]);
      expect(leases().leases).toEqual({});
    }
  });

  it("takes an expired or absent owner lease, and a live one refuses with no label written", async () => {
    const expired = hub([loopPr()]);
    const first = adopting(expired.gh);
    ownerLease(first.leasePath, -60_000);
    expect((await poll(first.deps, noCache())).verdict).toMatchObject({ work: true, pr: 3001 });
    expect(first.leases().leases["12"]).toMatchObject({ loop: "medi", pid: SUPERVISOR });

    const live = hub([loopPr()]);
    const second = adopting(live.gh);
    ownerLease(second.leasePath, 60_000);
    second.deps.adoption = { ...second.deps.adoption!, pidAlive: () => true };
    const { verdict } = await poll(second.deps, noCache());
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("rafa's lease on #12 is still");
    expect(live.labels(3001)).toEqual([]);
    expect(live.calls.filter((call) => call.startsWith("pr edit") || call.startsWith("pr comment"))).toEqual([]);
    expect(second.leases().leases["12"]).toMatchObject({ loop: "rafa" });
    expect(readStore(second.deps.storePath).medicAdoptions).toBeUndefined();
  });

  it("leaves a lease the supervisor's watcher renews, and a dead lease still blocks every other claim", async () => {
    const github = hub([loopPr()]);
    const { deps, leases } = adopting(github.gh);
    await poll(deps, noCache());
    const store = leases();
    const renewed = renewLease(store, 12, IDENTITY, T0 + 30_000);
    expect(renewed).toMatchObject({ loop: "medi", heartbeatAt: new Date(T0 + 30_000).toISOString() });
    expect(currentLeaseOf(store, IDENTITY)?.issue).toBe(12);
    // Dead: the pid is gone and the heartbeat is past the reconnect grace, yet not expired.
    const dead = { ...renewed!, heartbeatAt: new Date(T0 - 10 * 60_000).toISOString() };
    expect(leaseBlocksClaim(dead, { nowMs: T0 + 60_000, pidAlive: () => false })).toBe(true);
  });

  it("adopts no PR whose branch names no issue", async () => {
    const github = hub([loopPr({ headRefName: "rafa/cleanup" })]);
    const { deps, leases } = adopting(github.gh);
    const { verdict } = await poll(deps, noCache());
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("rafa/cleanup names no issue");
    expect(github.labels(3001)).toEqual([]);
    expect(leases().leases).toEqual({});
  });

  it("adopts one orphan per poll, the migration-applied one first, and only from an unattended owner", async () => {
    const applied = [{ name: "migration-applied" }];
    const github = hub([loopPr(), loopPr({ number: 3005, headRefName: "ralph/14-y", labels: applied })]);
    const { deps } = adopting(github.gh);
    expect((await poll(deps, noCache())).verdict).toMatchObject({ work: true, pr: 3005 });
    expect(github.labels(3001)).toEqual([]);

    // rafa (#3001's owner) is attended: its labelled PR is not adopted at all.
    const second = hub([loopPr({ number: 3002, headRefName: "ralph/15-z" }), loopPr({ number: 3009, labels: applied })]);
    const { deps: only } = adopting(second.gh, { unattended: () => unattended("ralph") });
    expect((await poll(only, noCache())).verdict).toMatchObject({ work: true, pr: 3002 });
    expect(second.labels(3009)).toEqual(["migration-applied"]);
  });

  it("leaves out an orphan whose owner's lease still blocks, so it cannot starve the next one", async () => {
    // #3005 would be picked first (migration-applied), but rafa's lease on #12
    // is live: it is skipped before the pick and ralph's #3002 is adopted.
    const github = hub([
      loopPr({ number: 3005, labels: [{ name: "migration-applied" }] }),
      loopPr({ number: 3002, headRefName: "ralph/14-y" }),
    ]);
    const { deps } = adopting(github.gh);
    ownerLease(deps.adoption!.leasePath, 60_000);
    deps.adoption = { ...deps.adoption!, pidAlive: (pid) => pid === 7 };
    const { verdict } = await poll(deps, noCache());
    expect(verdict).toMatchObject({ work: true, pr: 3002 });
    expect(verdict.why).not.toContain("3005");
    expect(github.labels(3005)).toEqual(["migration-applied"]);
  });

  it("releases an adoption the operator turned into a draft, label and lease, and adopts again after", async () => {
    const github = hub([loopPr({ number: 3001, isDraft: true, labels: [{ name: "medi-wip" }] })]);
    const { deps, leasePath, leases } = adopting(github.gh);
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, { issue: 12, run: IDENTITY.run, loop: IDENTITY.loop, pid: SUPERVISOR, worktree: "/tmp/medi", branch: "rafa/12-x", nowMs: T0 - 60_000 });
    writeLeaseStore(leasePath, store);
    await withStore(deps.storePath, (open) => {
      open.medicAdoptions = { medi: { pr: 3001, head: HEAD, issue: 12 } };
    });
    const { verdict } = await poll(deps, noCache());
    expect(verdict.why).toContain("#3001 is a draft — adoption released");
    expect(github.labels(3001)).toEqual([]);
    expect(leases().leases["12"]).toBeUndefined();
    expect(readStore(deps.storePath).medicAdoptions).toEqual({});
  });

  it("adopts no second PR while the store records an adoption", async () => {
    const github = hub([loopPr({ number: 3001, labels: [{ name: "medi-wip" }], statusCheckRollup: PENDING }), loopPr({ number: 3002, headRefName: "ralph/14-y" })]);
    const { deps, leases } = adopting(github.gh);
    await withStore(deps.storePath, (open) => {
      open.medicAdoptions = { medi: { pr: 3001, head: HEAD, issue: 12 } };
    });
    const { verdict } = await poll(deps, noCache());
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("already adopting #3001");
    expect(github.labels(3002)).toEqual([]);
    expect(leases().leases).toEqual({});
    expect(readStore(deps.storePath).medicAdoptions?.medi?.pr).toBe(3001);
  });

  it("clears the record once the PR it names no longer carries this loop's -wip", async () => {
    const github = hub([loopPr({ number: 3001, statusCheckRollup: GREEN })]);
    const { deps } = adopting(github.gh);
    await withStore(deps.storePath, (open) => {
      open.medicAdoptions = { medi: { pr: 3001, head: HEAD, issue: 12 }, mede: { pr: 1, head: HEAD, issue: 1 } };
    });
    await poll(deps, noCache());
    expect(readStore(deps.storePath).medicAdoptions).toEqual({ mede: { pr: 1, head: HEAD, issue: 1 } });
  });

  describe("an adopted PR the list no longer shows", () => {
    /** #3001 is gone from the list; its re-read answers `view`, and every edit is logged. */
    async function gone(view: Ran, over: Partial<PollDeps> = {}) {
      const edits: string[] = [];
      const github = hub([], {
        fail: (args) => {
          if (args[0] === "pr" && args[1] === "view" && args[2] === "3001") return view;
          if (args[0] === "pr" && args[1] === "edit" && args[2] === "3001") {
            edits.push(args.join(" "));
            return ok({});
          }
          return null;
        },
      });
      const setup = adopting(github.gh, over);
      const store: LeaseStore = { version: 1, leases: {} };
      claimLease(store, { issue: 12, run: IDENTITY.run, loop: IDENTITY.loop, pid: SUPERVISOR, worktree: "/tmp/medi", branch: "rafa/12-x", nowMs: T0 - 60_000 });
      writeLeaseStore(setup.leasePath, store);
      await withStore(setup.deps.storePath, (open) => {
        open.medicAdoptions = { medi: { pr: 3001, head: HEAD, issue: 12 } };
      });
      const { verdict } = await poll(setup.deps, noCache());
      return { ...setup, github, edits, verdict };
    }

    it("releases the lease, the label and the record once a re-read says it is closed or merged", async () => {
      for (const state of ["CLOSED", "MERGED"]) {
        const { deps, leases, github, edits, verdict } = await gone(ok({ state }));
        expect(github.calls).toContain("pr view 3001 --json state");
        expect(leases().leases["12"]).toBeUndefined();
        expect(edits).toEqual(["pr edit 3001 --remove-label medi-wip"]);
        expect(readStore(deps.storePath).medicAdoptions).toEqual({});
        expect(verdict.why).toContain("#3001 closed — adoption released");
      }
    });

    it("changes nothing when the re-read fails, is unparseable, or says OPEN (the list was cut off)", async () => {
      const answers: Ran[] = [fail("HTTP 502"), { ok: true, stdout: "not json", stderr: "" }, ok({ state: "OPEN" }), ok({})];
      for (const view of answers) {
        const { deps, leases, edits } = await gone(view);
        expect(leases().leases["12"]).toMatchObject({ loop: "medi" });
        expect(edits).toEqual([]);
        expect(readStore(deps.storePath).medicAdoptions?.medi).toEqual({ pr: 3001, head: HEAD, issue: 12 });
      }
    });

    it("follows the throttled path when the re-read is rate-limited", async () => {
      const { deps, leases, edits, verdict } = await gone(fail("API rate limit exceeded for user"));
      expect(verdict).toMatchObject({ work: false, rateLimited: true });
      expect(leases().leases["12"]).toMatchObject({ loop: "medi" });
      expect(edits).toEqual([]);
      expect(readStore(deps.storePath).medicAdoptions?.medi?.pr).toBe(3001);
    });

    it("dry-run reads it closed but releases nothing", async () => {
      const { deps, leases, edits, github } = await gone(ok({ state: "CLOSED" }), { dryRun: true });
      expect(github.calls).toContain("pr view 3001 --json state");
      expect(leases().leases["12"]).toMatchObject({ loop: "medi" });
      expect(edits).toEqual([]);
      expect(readStore(deps.storePath).medicAdoptions?.medi?.pr).toBe(3001);
    });
  });

  it("releases the lease too when the listed PR it names lost this loop's -wip", async () => {
    const github = hub([loopPr({ number: 3001, statusCheckRollup: GREEN })]);
    const { deps, leasePath, leases } = adopting(github.gh);
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, { issue: 12, run: IDENTITY.run, loop: IDENTITY.loop, pid: SUPERVISOR, worktree: "/tmp/medi", branch: "rafa/12-x", nowMs: T0 - 60_000 });
    writeLeaseStore(leasePath, store);
    await withStore(deps.storePath, (open) => {
      open.medicAdoptions = { medi: { pr: 3001, head: HEAD, issue: 12 } };
    });
    await poll(deps, noCache());
    expect(leases().leases["12"]).toBeUndefined();
    expect(readStore(deps.storePath).medicAdoptions).toEqual({});
  });

  it("keeps the record while the lease store's lock refuses the release, and releases on a later poll", async () => {
    const github = hub([loopPr({ number: 3001, statusCheckRollup: GREEN })]);
    const { deps, leasePath, leases } = adopting(github.gh);
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, { issue: 12, run: IDENTITY.run, loop: IDENTITY.loop, pid: SUPERVISOR, worktree: "/tmp/medi", branch: "rafa/12-x", nowMs: T0 - 60_000 });
    writeLeaseStore(leasePath, store);
    await withStore(deps.storePath, (open) => {
      open.medicAdoptions = { medi: { pr: 3001, head: HEAD, issue: 12 } };
    });
    // The busy lock is the same file `withLeaseStoreLock` takes.
    const lock = join(dirname(leasePath), "next-tasks-claim.lock");
    writeFileSync(lock, "");
    await poll(deps, noCache());
    expect(leases().leases["12"]).toMatchObject({ loop: "medi" });
    expect(readStore(deps.storePath).medicAdoptions?.medi?.pr).toBe(3001);
    rmSync(lock);
    await poll(deps, noCache());
    expect(leases().leases["12"]).toBeUndefined();
    expect(readStore(deps.storePath).medicAdoptions).toEqual({});
  });

  it("records a resumed adoption that has no record, and not under dry-run", async () => {
    const held = (): OperatorPr => loopPr({ labels: [{ name: "medi-wip" }] });
    const github = hub([held()]);
    const { deps } = adopting(github.gh);
    expect((await poll(deps, noCache())).verdict).toMatchObject({ work: true, pr: 3001, resumed: true });
    expect(readStore(deps.storePath).medicAdoptions?.medi).toEqual({ pr: 3001, head: HEAD, issue: 12 });

    const dry = hub([held()]);
    const { deps: dryDeps } = adopting(dry.gh, { dryRun: true });
    expect((await poll(dryDeps, noCache())).verdict).toMatchObject({ work: true, pr: 3001, resumed: true });
    expect(readStore(dryDeps.storePath).medicAdoptions).toBeUndefined();
  });

  it("resumes the adopted PR on the next poll at the same head, with no second comment", async () => {
    const leases = scratch();
    const store = scratch();
    const github = hub([loopPr()]);
    await poll(adopting(github.gh, { leases, store }).deps, noCache());
    const again = hub([github.listed(3001)]);
    const { verdict } = await poll(adopting(again.gh, { leases, store }).deps, noCache());
    expect(verdict).toMatchObject({ work: true, pr: 3001, resumed: true });
    expect(again.calls.filter((call) => !call.startsWith("pr list"))).toEqual([]);
    expect(github.comments(3001)).toHaveLength(1);
  });

  it("dry-run takes no lease, posts no comment and writes no record", async () => {
    const github = hub([loopPr()]);
    const { deps, leases } = adopting(github.gh, { dryRun: true });
    expect((await poll(deps, noCache())).verdict).toMatchObject({ work: true, pr: 3001 });
    expect(leases().leases).toEqual({});
    expect(github.comments(3001)).toEqual([]);
    expect(readStore(deps.storePath).medicAdoptions).toBeUndefined();
  });
});

describe("a PR red only on a known flake (AC 2)", () => {
  const BUILD = 4821;
  const retryDeps = (storePath: string, puts: string[], now: () => number): Omit<RetryDeps, "afford"> => ({
    storePath,
    org: async () => "loggd",
    pipeline: "loggd",
    baseBranch: "main",
    config: null,
    now,
    put: async (path) => {
      puts.push(path);
    },
    readCi: () => ({ busy: false, detail: "idle" }),
    ciReadCalls: 3,
    hostLeaseBusy: () => ({ busy: false, detail: "no holder" }),
    branchHead: () => null,
  });
  const known = async (head: { pr: number; sha: string; branch: string }): Promise<KnownVerdict> => ({
    kind: "known",
    target: { ...head, build: BUILD, jobs: ["job-1"] },
    why: "red only on 1 confirmed flake (build #4821)",
  });

  it("retries at most once per head commit, and never starts an iteration", async () => {
    const dir = scratch();
    const storePath = join(dir, "ci-health.json");
    const puts: string[] = [];
    let now = T0;
    const deps = (gh: PollDeps["gh"]): PollDeps =>
      wire(gh, {
        store: dir,
        now: () => now,
        known,
        retry: (target, { afford }) => retryHead({ ...retryDeps(storePath, puts, () => now), afford }, target),
      });

    let github = hub([pr()]);
    let cached = noCache();
    for (let tick = 0; tick < 4; tick++) {
      const polled = await poll(deps(github.gh), cached);
      cached = polled.cached;
      expect(polled.verdict.work).toBe(false);
      now += 3_600_000;
    }
    expect(puts).toEqual([retryPath("loggd", "loggd", BUILD, "job-1")]);
    expect(github.calls.filter((call) => call.startsWith("pr edit"))).toEqual([]);

    // The operator pushes: a new head, and one more retry for it.
    const next = "b".repeat(40);
    github = hub([pr({ headRefOid: next, commits: [{ ...operator, oid: next }] })]);
    await poll(deps(github.gh), noCache());
    await poll(deps(github.gh), noCache());
    expect(puts).toHaveLength(2);
    expect(github.calls.filter((call) => call.startsWith("pr edit"))).toEqual([]);
  });

  it("leaves it to the doctor without a retry token, and still spawns nothing", async () => {
    const github = hub([pr()]);
    const { verdict } = await poll(wire(github.gh, { known }), noCache());
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("no retry token");
  });

  it("is the medic's after all when the branch also conflicts", async () => {
    const github = hub([pr({ mergeStateStatus: "DIRTY" })]);
    const { verdict } = await poll(wire(github.gh, { known }), noCache());
    expect(verdict).toMatchObject({ work: true, reason: "conflicting; red: buildkite/loggd" });
  });

  it("waits, rather than spawning, when Buildkite cannot say", async () => {
    const github = hub([pr()]);
    const { verdict } = await poll(
      wire(github.gh, { known: async () => ({ kind: "wait", why: "Buildkite could not be read (502)" }) }),
      noCache(),
    );
    expect(verdict).toMatchObject({ work: false });
    expect(verdict.why).toContain("Buildkite could not be read");
    expect(github.labels(2197)).toEqual([]);
  });
});

describe("two gates racing for one PR (AC 3)", () => {
  it("exactly one claims it under the machine's claim lock", async () => {
    const dir = scratch();
    const lock = join(dir, "pr-medic-claim.lock");
    const github = hub([pr()]);
    const gate = (loop: string): PollDeps =>
      wire(github.gh, {
        store: dir,
        rules: { ...RULES, loop },
        withLock: (critical) => withClaimLock(lock, critical),
      });

    const [a, b] = await Promise.all([poll(gate("medi"), noCache()), poll(gate("mede"), noCache())]);
    expect([a.verdict.work, b.verdict.work].filter(Boolean)).toHaveLength(1);
    const labels = github.labels(2197).filter((name) => name.endsWith("-wip"));
    expect(labels).toHaveLength(1);
    const winner = a.verdict.work ? "medi" : "mede";
    expect(labels).toEqual([`${winner}-wip`]);
    const loser = a.verdict.work ? b : a;
    expect(loser.verdict.why).toMatch(/claimed by|held by/);
  });

  it("never both claim it when no lock serialises them — the read-back is the fence", async () => {
    // Two hosts: nothing shared but GitHub. Both read the PR free, both write,
    // both read back and see the other — and both take their label back.
    const github = hub([pr()]);
    const gate = (loop: string): PollDeps => wire(github.gh, { rules: { ...RULES, loop } });
    const [a, b] = await Promise.all([poll(gate("medi"), noCache()), poll(gate("mede"), noCache())]);
    expect([a.verdict.work, b.verdict.work].filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(github.labels(2197).filter((name) => name.endsWith("-wip")).length).toBeLessThanOrEqual(1);
  });
});

describe("--once (AC 4)", () => {
  const GATE = join(__dirname, "gate.ts");
  const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "loggd", ".ralph", "config.json"), "utf8")) as {
    loops: unknown[];
  };

  /** A project with a medic on its roster, and a `gh` that answers the PR list from a file. */
  function project(prs: OperatorPr[]): { root: string; env: NodeJS.ProcessEnv; calls: () => string[] } {
    const root = scratch();
    mkdirSync(join(root, ".ralph"), { recursive: true });
    writeFileSync(
      join(root, ".ralph", "config.json"),
      // loggd's own roster carries `medi` since loggd#2210 (#249); add it only
      // when the fixture lacks it, or the roster names the loop twice.
      JSON.stringify({
        ...fixture,
        loops: fixture.loops.some((loop) => typeof loop === "object" && (loop as { name?: string }).name === "medi")
          ? fixture.loops
          : [...fixture.loops, { name: "medi", role: "pr-medic" }],
        prMedic: { branches: ["felipearosr/*"] },
      }),
    );
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "gh.log");
    writeFileSync(join(root, "prs.json"), JSON.stringify(prs));
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        `if [ "$1 $2" = "pr list" ]; then cat ${JSON.stringify(join(root, "prs.json"))}; exit 0; fi`,
        "exit 1",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RALPH_PROJECT: root,
      RALPH_LOOP_NAME: "medi",
      RALPH_BUILDKITE_READ_TOKEN: "",
      RALPH_BUILDKITE_RETRY_TOKEN: "",
    };
    return { root, env, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
  }

  const fresh = (): OperatorPr => pr({ commits: [{ ...operator, oid: HEAD, committedDate: new Date(Date.now() - 3_600_000).toISOString() }] });

  it("prints the case and exits 0 when there is one, claiming nothing under --dry-run", () => {
    const { root, env, calls } = project([{ ...fresh(), mergeStateStatus: "DIRTY" }]);
    const run = spawnSync("bun", [GATE, "--once", "--dry-run"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n").at(-1)).toBe(
      `pr-medic-gate: work available — ${caseText(fresh(), "conflicting; red: buildkite/loggd")}`,
    );
    expect(calls().filter((call) => !call.startsWith("pr list"))).toEqual([]);
  });

  it("prints why there is nothing and exits 1", () => {
    const { root, env } = project([{ ...fresh(), isDraft: true }]);
    const run = spawnSync("bun", [GATE, "--once"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe(verdictLine({ work: false, why: "no red operator PR to take — #2197 draft", pr: null, reason: null }));
  });
});

describe("the open pull request list", () => {
  it("stays under GitHub's 500,000-node GraphQL ceiling when it reads commits", () => {
    // `gh` expands `commits` to 100 commits with up to 100 authors each; at
    // `--limit 100` the query was refused outright on the real API.
    const perPr = PR_FIELDS.split(",").includes("commits") ? 100 * 100 : 1;
    expect(PR_LIST_LIMIT * perPr).toBeLessThanOrEqual(500_000);
  });
});

describe("the supervisor liveness check", () => {
  // The medic's gate is started by the same `run_intake_gate` pipeline as the
  // coder's, so its parent is an intermediate bash that outlives a killed
  // supervisor. Imported from `../frontier-gate` so all three gates keep one
  // definition of liveness.
  it("asks the supervisor's pid, not its own parent, whether the supervisor is gone", () => {
    expect(supervisorPidFrom({ RALPH_SUPERVISOR_PID: "4321" }, 99)).toBe(4321);
    expect(supervisorGone(process.pid)).toBe(false);
    // As in `ci-doctor/gate.test.ts`: the helpers alone would stay green with
    // this gate reverted to `process.ppid`, which is the bug itself.
    const source = readFileSync(join(__dirname, "gate.ts"), "utf8");
    expect(source).toContain("const supervisorPid = supervisorPidFrom(process.env, process.ppid);");
    expect(source).toContain("if (supervisorGone(supervisorPid)) return \"orphaned\" as const;");
    expect(source).not.toContain("const supervisorPid = process.ppid;");
  });
});
