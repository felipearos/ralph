/**
 * Act mode's revert (#568), driven through `reportWatch` with a fake `gh`, a
 * fake `git` and the in-memory tracker: no process is spawned.
 */
import { describe, expect, it } from "vitest";

import type { PushInput } from "../push-notification";
import { createFakeTracker, type FakeTracker } from "../tracker/fake";
import type { ActDeps } from "./act";
import type { Gh } from "./deploys";
import { VERIFIER_REVERT_MARKER } from "./merged";
import { reportWatch, URGENT_LABEL, type ReportDeps } from "./report";
import type { Git } from "./revert";
import type { AcceptanceResult } from "./verdict";
import { emptyStore, type Watch, type WatchReported, type WatchStore } from "./watches";

const NOW = new Date("2026-10-30T10:05:00.000Z");
const MERGE_COMMIT = "abc123abc123abc123abc123abc123abc123abc1";
const LATER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    pr: 501,
    ticket: 10,
    root: null,
    ticketRef: "#10",
    mergeCommit: MERGE_COMMIT,
    mergedAt: "2026-10-29T09:00:00.000Z",
    deployId: "dpl_1",
    deployedAt: "2026-10-29T10:00:00.000Z",
    deployUrl: "https://deploy.example/dpl_1",
    checkIns: [{ offsetHours: 1, dueAt: "2026-10-29T11:00:00.000Z", result: null }],
    round: 1,
    lineage: [],
    mode: "act",
    openedAt: "2026-10-29T10:05:00.000Z",
    verdict: { verdict: "revert", reason: "hard break on checkout", act: true, offsetHours: 1, decidedAt: "2026-10-29T11:01:00.000Z" },
    reported: { announcedAt: "2026-10-29T10:06:00.000Z" },
    ...overrides,
  };
}

/** The watch's first check-in failed one criterion and saw one Sentry issue. */
function withEvidence(watch: Watch): Watch {
  const acceptance: AcceptanceResult[] = [{ criterion: "checkout completes", result: "hard-break", detail: "500 on submit" } as AcceptanceResult];
  watch.checkIns[0]!.result = {
    handedOverAt: "2026-10-29T11:00:00.000Z",
    evidence: {
      gatheredAt: "2026-10-29T11:00:00.000Z",
      health: {
        reachable: true,
        issues: [
          {
            id: "S1",
            title: "TypeError in checkout",
            link: "https://sentry.example/issues/S1",
            firstSeen: "2026-10-29T10:30:00.000Z",
            preDeployRate: 0,
            postDeployRate: 3,
            frameFiles: [],
            routes: [],
            events: 3,
            distinctUsers: 1,
          },
        ],
      },
      traffic: { reachable: true, hits: 4 },
      pr: { number: watch.pr, files: [], routes: [] },
      otherPrs: [],
    },
    decision: { decidedAt: "2026-10-29T11:01:00.000Z", verdict: "revert", reason: "x", act: true, priority: "urgent" },
    acceptance,
  } as unknown as NonNullable<Watch["checkIns"][number]["result"]>;
  return watch;
}

interface GhWorld {
  title: string;
  body: string;
  /** Revert PRs already on the verifier's branch, as `gh pr list` lists them. */
  existing: { number: number; state: string; url: string }[];
  status: { state: string; rollup: unknown[]; mergeable: string; mergeStateStatus: string };
  /** The body file's contents when `pr create` ran. */
  createdBodies: string[];
  /** Whether the merge command exits non-zero. */
  mergeFails?: boolean;
}

function fakeGh(world: GhWorld): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
  const gh: Gh = async (args) => {
    calls.push(args);
    const json = args[args.indexOf("--json") + 1];
    if (args[0] === "pr" && args[1] === "view" && json === "title,body") return ok(JSON.stringify({ title: world.title, body: world.body }));
    if (args[0] === "pr" && args[1] === "view") {
      const s = world.status;
      return ok(JSON.stringify({ state: s.state, mergedAt: null, labels: [], headRefOid: "h", statusCheckRollup: s.rollup, mergeable: s.mergeable, mergeStateStatus: s.mergeStateStatus }));
    }
    if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify(world.existing));
    if (args[0] === "pr" && args[1] === "create") {
      const { readFileSync } = await import("node:fs");
      world.createdBodies.push(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"));
      // gh opens it on the branch, so the next lookup finds it.
      world.existing.unshift({ number: 900, state: "OPEN", url: "https://github.com/felipearos/loggd/pull/900" });
      return ok("https://github.com/felipearos/loggd/pull/900\n");
    }
    if (args[0] === "pr" && args[1] === "merge") return world.mergeFails ? { ok: false, stdout: "", stderr: "Pull request is not mergeable: base branch policy" } : ok("");
    return { ok: false, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { gh, calls };
}

/** Answers `pushRevert`'s git sequence; `conflict` makes the revert fail on one file, `empty` stages nothing. */
function fakeGit(conflict = false, empty = false): { git: Git; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const git: Git = async (args) => {
    calls.push(args);
    switch (args[0]) {
      case "rev-list":
        return ok(`${MERGE_COMMIT} 1111111111111111111111111111111111111111\n`);
      case "revert":
        if (args[1] === "--abort") return ok();
        return conflict ? { ok: false, stdout: "", stderr: "CONFLICT (content): Merge conflict in app/checkout.ts" } : ok();
      case "diff":
        // `diff --cached --quiet` exits 1 when the revert staged something.
        if (args[1] === "--cached") return empty ? ok() : { ok: false, stdout: "", stderr: "" };
        return ok(conflict ? "app/checkout.ts\n" : "");
      case "log":
        return ok(`${LATER_SHA}\tfix: tweak checkout copy\n`);
      case "rev-parse":
        return ok("0123456789012345678901234567890123456789\n");
      default:
        return ok();
    }
  };
  return { git, calls };
}

const CLEAN_STATUS = { state: "OPEN", rollup: [], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
const run = (name: string, conclusion: string | null): unknown => ({ __typename: "CheckRun", name, status: conclusion === null ? "IN_PROGRESS" : "COMPLETED", conclusion });

function harness(options: { merge?: "loop" | "human"; mergeCommand?: string[] | null; conflict?: boolean; empty?: boolean; world?: Partial<GhWorld>; act?: boolean } = {}) {
  const tracker: FakeTracker = createFakeTracker({ issues: [{ number: 10, state: "closed", closedAt: "2026-10-29T09:00:00.000Z" }] });
  const world: GhWorld = { title: "feat: new checkout", body: "Closes #10", existing: [], status: { ...CLEAN_STATUS }, createdBodies: [], ...options.world };
  const g = fakeGh(world);
  const gi = fakeGit(options.conflict ?? false, options.empty ?? false);
  const pushes: PushInput[] = [];
  const act: ActDeps = {
    gh: g.gh,
    git: gi.git,
    repoRoot: "/nonexistent/repo",
    baseBranch: "main",
    merge: options.merge ?? "human",
    mergeCommand: options.mergeCommand ?? null,
    requiredChecks: ["ci"],
  };
  let now = NOW;
  const deps: ReportDeps = {
    tracker,
    push: (input) => void pushes.push(input),
    language: "en",
    now: () => now,
    repo: "felipearos/loggd",
    act: options.act === false ? null : act,
  };
  let reported: WatchReported = {};
  const record = (patch: Partial<WatchReported>): void => {
    reported = { ...reported, ...patch };
  };
  const step = async (watch: Watch) => {
    const result = await reportWatch({ ...watch, reported: { ...watch.reported, ...reported } }, storeOf(watch), record, deps);
    return result;
  };
  return {
    tracker,
    world,
    pushes,
    ghCalls: g.calls,
    gitCalls: gi.calls,
    step,
    reported: () => reported,
    setNow: (date: Date) => {
      now = date;
    },
  };
}

const storeOf = (...watches: Watch[]): WatchStore => {
  const store = emptyStore();
  for (const watch of watches) store.watches[String(watch.pr)] = watch;
  return store;
};

const creates = (calls: string[][]): number => calls.filter((args) => args[0] === "pr" && args[1] === "create").length;
const merges = (calls: string[][]): string[][] => calls.filter((args) => args[0] === "pr" && args[1] === "merge");

describe("act mode's revert", () => {
  it("opens one revert PR with the evidence, proposes it where a person merges, and reopens the root only once it merged", async () => {
    const h = harness();
    const watch = withEvidence(makeWatch());
    const result = await h.step(watch);
    expect(result.error).toBeNull();
    expect(creates(h.ghCalls)).toBe(1);
    const create = h.ghCalls.find((args) => args[1] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--base", "main", "--head", "verifier/revert-501", "--title", 'Revert "feat: new checkout"']));
    const body = h.world.createdBodies[0]!;
    expect(body).toContain(VERIFIER_REVERT_MARKER);
    expect(body).toContain("hard break on checkout");
    expect(body).toContain('"checkout completes" (hard-break)');
    expect(body).toContain("TypeError in checkout");
    expect(body).toContain("Reopens #10");
    expect(body).not.toMatch(/\b(Closes|Fixes)\b/);
    const commit = h.gitCalls.find((args) => args[0] === "commit")!;
    expect(commit[2]).toBe(`Revert "feat: new checkout"\n\nThis reverts PR #501 (${MERGE_COMMIT}): hard break on checkout`);

    // Proposed, not settled: the root stays closed while the base still holds the change.
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.body).toContain("revert PR #900");
    expect(h.pushes[0]!.body).not.toContain("mergeCommand");
    expect(h.reported()).toMatchObject({ revertPr: 900, revertMerge: "proposed" });
    expect(h.reported().settledAt).toBeUndefined();
    expect(h.tracker.issues.get(10)!.state).toBe("closed");

    // Still open on the next poll: nothing more, no second page.
    await h.step(watch);
    expect(h.pushes).toHaveLength(1);
    expect(h.tracker.issues.get(10)!.state).toBe("closed");

    // A person merges it: the root goes back to the coders with the evidence.
    h.world.status = { ...CLEAN_STATUS, state: "MERGED" };
    expect((await h.step(watch)).error).toBeNull();
    const root = h.tracker.issues.get(10)!;
    expect(root.state).toBe("open");
    expect(root.labels).toContain("ready-for-agent");
    const reopened = root.comments.find((c) => c.body.includes("<!-- verifier-reverted pr=501 root=10 round=1 lineage=10 -->"))!;
    expect(reopened.body).toContain("https://github.com/felipearos/loggd/pull/900");
    expect(reopened.body).toContain("TypeError in checkout");
    expect(merges(h.ghCalls)).toEqual([]);
    expect(h.pushes).toHaveLength(1);
    expect(h.reported()).toMatchObject({ revertMerge: "merged", settledAt: NOW.toISOString() });
    expect(h.reported().rootReopenedAt).toBeDefined();
  });

  it("goes straight to the reopen for an adopted revert PR that already merged, paging nobody", async () => {
    const h = harness({
      world: { existing: [{ number: 900, state: "MERGED", url: "https://github.com/felipearos/loggd/pull/900" }], status: { ...CLEAN_STATUS, state: "MERGED" } },
    });
    const watch = makeWatch({ reported: { announcedAt: "2026-10-29T10:06:00.000Z", revertStartedAt: "2026-10-30T10:00:00.000Z" } });
    expect((await h.step(watch)).error).toBeNull();
    expect(creates(h.ghCalls)).toBe(0);
    expect(h.gitCalls).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.tracker.issues.get(10)!.state).toBe("open");
    expect(h.reported()).toMatchObject({ revertPr: 900, revertMerge: "merged" });
  });

  it("says so when no merge command is configured on a loop-merge project", async () => {
    const h = harness({ merge: "loop", mergeCommand: null });
    await h.step(makeWatch());
    expect(h.pushes[0]!.body).toContain("No 'verifier.mergeCommand' is configured");
    expect(merges(h.ghCalls)).toEqual([]);
  });

  it("waits while the revert PR is pending, runs the merge command once when green and mergeable, and settles once merged", async () => {
    const h = harness({ merge: "loop", mergeCommand: ["pr", "merge", "{pr}", "--squash"], world: { status: { ...CLEAN_STATUS, rollup: [run("ci", null)] } } });
    const watch = makeWatch();
    expect((await h.step(watch)).error).toBeNull();
    expect(h.reported().settledAt).toBeUndefined();
    expect(h.reported().revertMerge).toBeUndefined();
    expect(merges(h.ghCalls)).toEqual([]);
    expect(h.pushes).toEqual([]);

    h.world.status = { ...CLEAN_STATUS, rollup: [run("ci", "SUCCESS")] };
    expect((await h.step(watch)).error).toBeNull();
    expect(merges(h.ghCalls)).toEqual([["pr", "merge", "900", "--squash"]]);
    expect(h.reported().revertMerge).toBe("requested");
    // Requested is not landed: still open, root still closed.
    expect(h.reported().settledAt).toBeUndefined();
    expect(h.tracker.issues.get(10)!.state).toBe("closed");
    await h.step(watch);
    expect(merges(h.ghCalls)).toHaveLength(1);

    h.world.status = { ...CLEAN_STATUS, state: "MERGED" };
    await h.step(watch);
    expect(h.reported()).toMatchObject({ revertMerge: "merged", settledAt: NOW.toISOString() });
    expect(h.tracker.issues.get(10)!.state).toBe("open");
    expect(creates(h.ghCalls)).toBe(1);

    // A re-run after the settle writes nothing.
    const calls = h.ghCalls.length;
    const writes = h.tracker.writes.length;
    expect(await h.step(watch)).toEqual({ wrote: [], error: null });
    expect(h.ghCalls).toHaveLength(calls);
    expect(h.tracker.writes).toHaveLength(writes);
  });

  it("alerts and settles when the revert PR's required checks are red, merging nothing and reopening nothing", async () => {
    const h = harness({ merge: "loop", mergeCommand: ["pr", "merge", "{pr}", "--squash"], world: { status: { ...CLEAN_STATUS, rollup: [run("ci", "FAILURE")] } } });
    expect((await h.step(makeWatch())).error).toBeNull();
    expect(merges(h.ghCalls)).toEqual([]);
    expect(h.pushes).toHaveLength(1);
    expect(h.reported()).toMatchObject({ revertMerge: "red", settledAt: NOW.toISOString() });
    expect(h.tracker.issues.get(10)!.state).toBe("closed");
  });

  it("settles a revert PR closed unmerged with a comment that production still runs the change", async () => {
    const h = harness();
    const watch = makeWatch();
    await h.step(watch);
    h.world.status = { ...CLEAN_STATUS, state: "CLOSED" };
    expect((await h.step(watch)).error).toBeNull();
    expect(h.reported()).toMatchObject({ revertMerge: "closed", settledAt: NOW.toISOString() });
    const ticket = h.tracker.issues.get(10)!;
    expect(ticket.state).toBe("closed");
    expect(ticket.comments.some((c) => c.body.includes("closed without merging") && c.body.includes("<!-- verifier-settled pr=501 -->"))).toBe(true);
  });

  it("stops instead of retrying when the merge command fails", async () => {
    const h = harness({ merge: "loop", mergeCommand: ["pr", "merge", "{pr}", "--squash"], world: { mergeFails: true, status: { ...CLEAN_STATUS, rollup: [run("ci", "SUCCESS")] } } });
    const result = await h.step(makeWatch());
    expect(result.error).toBeNull();
    expect(merges(h.ghCalls)).toHaveLength(1);
    expect(h.reported()).toMatchObject({ revertMerge: "failed", settledAt: NOW.toISOString() });
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.body).toContain("base branch policy");
    expect(h.tracker.issues.get(10)!.state).toBe("closed");
    expect(h.tracker.issues.get(10)!.comments.some((c) => c.body.includes("merge command failed"))).toBe(true);
  });

  it("waits on a green revert PR BLOCKED on a review, and pages a person once it is stale", async () => {
    const h = harness({ merge: "loop", mergeCommand: ["pr", "merge", "{pr}", "--squash"], world: { status: { ...CLEAN_STATUS, mergeStateStatus: "BLOCKED", rollup: [run("ci", "SUCCESS")] } } });
    await h.step(makeWatch());
    expect(h.reported().settledAt).toBeUndefined();
    expect(merges(h.ghCalls)).toEqual([]);
    h.setNow(new Date(NOW.getTime() + 25 * 3600 * 1000));
    await h.step(makeWatch());
    expect(h.reported()).toMatchObject({ revertMerge: "stale" });
    expect(h.reported().settledAt).toBeDefined();
    expect(h.pushes).toHaveLength(1);
    expect(merges(h.ghCalls)).toEqual([]);
    expect(h.tracker.issues.get(10)!.state).toBe("closed");
  });

  it("adopts the revert PR a run that died after pushing it opened", async () => {
    const h = harness({
      world: { existing: [{ number: 900, state: "OPEN", url: "https://github.com/felipearos/loggd/pull/900" }] },
    });
    const watch = makeWatch({ reported: { announcedAt: "2026-10-29T10:06:00.000Z", revertStartedAt: "2026-10-30T10:00:00.000Z" } });
    expect((await h.step(watch)).error).toBeNull();
    expect(creates(h.ghCalls)).toBe(0);
    expect(h.gitCalls).toEqual([]);
    expect(h.reported()).toMatchObject({ revertPr: 900, revertMerge: "proposed" });
  });

  it("treats an empty revert as already reverted: an urgent ticket, nothing pushed", async () => {
    const h = harness({ empty: true });
    expect((await h.step(makeWatch())).error).toBeNull();
    expect(h.gitCalls.some((args) => args[0] === "commit" || args[0] === "push")).toBe(false);
    expect(creates(h.ghCalls)).toBe(0);
    const fix = h.tracker.issues.get(h.reported().fixTicket!)!;
    expect(fix.labels).toContain(URGENT_LABEL);
    expect(fix.body).toContain("already undone on the base branch");
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.subject).toContain("could not revert PR #501");
    expect(h.reported()).toMatchObject({ revertRefused: "twice", settledAt: NOW.toISOString() });
  });

  it("never reverts a revert: an urgent ticket and an alert instead", async () => {
    const h = harness({ world: { title: 'Revert "feat: old checkout"', body: "Reverts felipearos/loggd#400" } });
    expect((await h.step(makeWatch())).error).toBeNull();
    expect(h.gitCalls).toEqual([]);
    expect(creates(h.ghCalls)).toBe(0);
    const fix = h.tracker.issues.get(h.reported().fixTicket!)!;
    expect(fix.labels).toContain(URGENT_LABEL);
    expect(fix.body).toContain("itself a revert");
    expect(h.pushes).toHaveLength(1);
    expect(h.reported()).toMatchObject({ revertRefused: "revert", settledAt: NOW.toISOString() });
    expect(h.tracker.issues.get(10)!.state).toBe("closed");
  });

  it("never reverts the same PR twice: the ticket names the existing revert", async () => {
    const h = harness({ world: { existing: [{ number: 777, state: "MERGED", url: "https://github.com/felipearos/loggd/pull/777" }] } });
    expect((await h.step(makeWatch())).error).toBeNull();
    expect(h.gitCalls).toEqual([]);
    expect(creates(h.ghCalls)).toBe(0);
    const fix = h.tracker.issues.get(h.reported().fixTicket!)!;
    expect(fix.labels).toContain(URGENT_LABEL);
    expect(fix.body).toContain("https://github.com/felipearos/loggd/pull/777");
    expect(h.pushes).toHaveLength(1);
    expect(h.reported()).toMatchObject({ revertRefused: "twice" });
  });

  it("files an urgent ticket naming the commits in the way when the revert conflicts", async () => {
    const h = harness({ conflict: true });
    expect((await h.step(makeWatch())).error).toBeNull();
    expect(h.gitCalls.some((args) => args[0] === "push")).toBe(false);
    expect(h.gitCalls.some((args) => args[0] === "revert" && args[1] === "--abort")).toBe(true);
    expect(creates(h.ghCalls)).toBe(0);
    const fix = h.tracker.issues.get(h.reported().fixTicket!)!;
    expect(fix.labels).toContain(URGENT_LABEL);
    expect(fix.body).toContain("app/checkout.ts");
    expect(fix.body).toContain(`- ${LATER_SHA.slice(0, 7)} fix: tweak checkout copy`);
    expect(fix.body).toContain("no resolution was attempted");
    expect(h.pushes).toHaveLength(1);
    expect(h.tracker.issues.get(10)!.state).toBe("closed");
    expect(h.reported().rootReopenedAt).toBeUndefined();
  });

  it("without act deps writes the would-be revert of report mode", async () => {
    const h = harness({ act: false });
    expect((await h.step(makeWatch())).error).toBeNull();
    expect(h.ghCalls).toEqual([]);
    const fix = h.tracker.issues.get(h.reported().fixTicket!)!;
    expect(fix.title).toContain("would have reverted PR #501");
    expect(h.pushes).toHaveLength(1);
  });
});
