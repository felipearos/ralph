import { describe, expect, it } from "vitest";

import type { Gh } from "./ci-doctor/gate";
import { RateLimitedError, RATE_LIMITED_EXIT } from "./frontier/github-rate-limit";
import { APPLIED_LABEL, appliedComment, appliedMarker, decide, runMigrationApplied, type PrView } from "./migration-applied";
import { createFakeTracker, type FakeTracker } from "./tracker/fake";
import { TrackerUnavailableError } from "./tracker/types";

const TICKET = 432;
const PR = 437;
const BLOCK = `needs-migration: draft PR #${PR} ready; apply drizzle/0062_region.sql before merging`;

/** A `gh` that answers `pr view` from `pr` and records every other call, as the ordered `writes` log shared with the tracker. */
function fakeGh(pr: PrView, writes: string[], options: { labelCreate?: { ok: boolean; stderr: string } } = {}) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return { ok: true, stdout: JSON.stringify({ state: pr.state, isDraft: pr.isDraft, labels: pr.labels.map((name) => ({ name })) }), stderr: "" };
    }
    writes.push(`gh ${args.slice(0, 3).join(" ")}`);
    if (args[0] === "label" && args[1] === "create") return { ok: true, stdout: "", stderr: "", ...options.labelCreate };
    if (args[0] === "pr" && args[1] === "edit") pr.labels.push(args[4]!);
    if (args[0] === "pr" && args[1] === "ready") pr.isDraft = false;
    return { ok: true, stdout: "", stderr: "" };
  };
  return { gh, calls };
}

interface World {
  tracker: FakeTracker;
  pr: PrView;
  /** Tracker and gh writes interleaved, in the order they happened. */
  writes: string[];
  gh: Gh;
  calls: string[][];
  out: string[];
  err: string[];
  run: (argv?: string[]) => Promise<number>;
}

function world(seed: {
  comments?: string[];
  labels?: string[];
  pr?: Partial<PrView>;
  kind?: "github" | "linear";
  labelCreate?: { ok: boolean; stderr: string };
}): World {
  const tracker = createFakeTracker(seed.kind === "linear" ? { kind: "linear", key: "OA" } : {});
  tracker.put({
    number: TICKET,
    labels: seed.labels ?? ["rafa-blocked"],
    comments: (seed.comments ?? [BLOCK]).map((body) => ({ body })),
  });
  const pr: PrView = { state: "OPEN", isDraft: true, labels: [], ...seed.pr };
  const writes: string[] = [];
  // Mirror the tracker's own write log into the shared, ordered one.
  const push = tracker.writes.push.bind(tracker.writes);
  tracker.writes.push = (...items: string[]) => {
    writes.push(...items.map((item) => `tracker ${item}`));
    return push(...items);
  };
  const { gh, calls } = fakeGh(pr, writes, { labelCreate: seed.labelCreate });
  const out: string[] = [];
  const err: string[] = [];
  const run = (argv = [String(TICKET)]) =>
    runMigrationApplied(argv, { tracker: () => tracker, gh, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { tracker, pr, writes, gh, calls, out, err, run };
}

const commentsOn = (w: World): string[] => w.tracker.issues.get(TICKET)!.comments.map((comment) => comment.body);
const appliedComments = (w: World): string[] => commentsOn(w).filter((body) => body.includes(appliedMarker(TICKET, PR)));
const ghWrites = (w: World): string[][] => w.calls.filter((args) => !(args[0] === "pr" && args[1] === "view"));

/** The end state every completed run must reach. */
function expectApplied(w: World): void {
  expect(appliedComments(w)).toHaveLength(1);
  expect(w.tracker.issues.get(TICKET)!.labels).toEqual(expect.arrayContaining([APPLIED_LABEL]));
  expect(w.tracker.issues.get(TICKET)!.labels.filter((label) => label.endsWith("-blocked"))).toEqual([]);
  expect(w.pr.labels).toContain(APPLIED_LABEL);
  expect(w.pr.isDraft).toBe(false);
}

describe("migration-applied refusals", () => {
  it("refuses a ticket whose newest record is not a migration block, writing nothing", async () => {
    const w = world({ comments: [BLOCK, `blocked: PR #${PR} red twice in CI; not reproducible locally`] });
    expect(await w.run()).toBe(1);
    expect(w.err.join("\n")).toMatch(/refused/);
    expect([...w.tracker.writes]).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("refuses a ticket with no block record at all, writing nothing", async () => {
    const w = world({ comments: ["claimed by rafa"] });
    expect(await w.run()).toBe(1);
    expect([...w.tracker.writes]).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("refuses a migration block that names no PR, writing nothing", async () => {
    const w = world({ comments: ["needs-migration: apply drizzle/0062_region.sql before merging"] });
    expect(await w.run()).toBe(1);
    expect(w.err.join("\n")).toMatch(/names no PR/);
    expect([...w.tracker.writes]).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("exits 2 on a missing or non-numeric issue", async () => {
    const w = world({});
    expect(await w.run([])).toBe(2);
    expect(await w.run(["abc"])).toBe(2);
    expect(w.calls).toEqual([]);
  });

  it("exits 69 when the tracker is not connected", async () => {
    const err: string[] = [];
    const code = await runMigrationApplied([String(TICKET)], {
      tracker: () => {
        throw new TrackerUnavailableError("no credential", "not-connected");
      },
      gh: async () => ({ ok: true, stdout: "", stderr: "" }),
      out: () => {},
      err: (line) => err.push(line),
    });
    expect(code).toBe(69);
  });

  it("exits RATE_LIMITED_EXIT on a throttle", async () => {
    const w = world({});
    w.tracker.failNext("issue", new RateLimitedError("secondary", 60, "throttled"));
    expect(await w.run()).toBe(RATE_LIMITED_EXIT);
  });
});

describe("migration-applied writes", () => {
  it("comments, unblocks, labels and readies, in that order", async () => {
    const w = world({ labels: ["rafa-blocked", "rafa-wip"] });
    expect(await w.run()).toBe(0);
    expect(w.writes).toEqual([
      `tracker comment ${TICKET}`,
      `tracker label- ${TICKET} rafa-blocked`,
      "gh label create migration-applied",
      `tracker label+ ${TICKET} ${APPLIED_LABEL}`,
      `gh pr edit ${PR}`,
      `gh pr ready ${PR}`,
    ]);
    expect(appliedComments(w)[0]).toBe(appliedComment(TICKET, PR));
    expect(appliedComments(w)[0]).not.toMatch(/^(blocked:|needs-migration)/);
    // A `-wip` is a loop's claim, never this command's to drop.
    expect(w.tracker.issues.get(TICKET)!.labels).toContain("rafa-wip");
    expectApplied(w);
    expect(w.out).toEqual([`migration-applied: #${TICKET} PR #${PR} — commented, unblocked, labelled, readied`]);
  });

  it("finishes a run killed after the comment, without a second comment", async () => {
    const w = world({ comments: [BLOCK, appliedComment(TICKET, PR)] });
    expect(await w.run()).toBe(0);
    expect(w.writes).not.toContain(`tracker comment ${TICKET}`);
    expectApplied(w);
  });

  it("finishes a run killed after the unblock, without a second comment", async () => {
    const w = world({ comments: [BLOCK, appliedComment(TICKET, PR)], labels: [] });
    expect(await w.run()).toBe(0);
    expect(w.writes[0]).toBe("gh label create migration-applied");
    expect(w.writes).not.toContain(`tracker comment ${TICKET}`);
    expectApplied(w);
  });

  it("finishes a run killed after the labels by only readying", async () => {
    const w = world({ comments: [BLOCK, appliedComment(TICKET, PR)], labels: [APPLIED_LABEL], pr: { labels: [APPLIED_LABEL] } });
    expect(await w.run()).toBe(0);
    expect(w.writes).toEqual([`gh pr ready ${PR}`]);
    expectApplied(w);
  });

  it("writes nothing on a fully applied issue", async () => {
    const w = world({ comments: [BLOCK, appliedComment(TICKET, PR)], labels: [APPLIED_LABEL], pr: { isDraft: false, labels: [APPLIED_LABEL] } });
    expect(await w.run()).toBe(0);
    expect([...w.tracker.writes]).toEqual([]);
    expect(ghWrites(w)).toEqual([]);
    expect(w.out).toEqual([`migration-applied: #${TICKET} PR #${PR} — nothing to do`]);
  });

  for (const state of ["MERGED", "CLOSED"] as const) {
    it(`never readies a ${state} pull request`, async () => {
      const applied = world({ comments: [BLOCK, appliedComment(TICKET, PR)], labels: [APPLIED_LABEL], pr: { state, isDraft: true, labels: [APPLIED_LABEL] } });
      expect(await applied.run()).toBe(0);
      expect([...applied.tracker.writes]).toEqual([]);
      expect(ghWrites(applied)).toEqual([]);

      const fresh = world({ pr: { state, isDraft: true } });
      expect(await fresh.run()).toBe(0);
      expect(fresh.calls.some((args) => args[0] === "pr" && args[1] === "ready")).toBe(false);
    });
  }

  it("creates the label on the repository before labelling the PR on a non-GitHub tracker", async () => {
    const w = world({ kind: "linear" });
    expect(await w.run()).toBe(0);
    const create = w.writes.indexOf("gh label create migration-applied");
    const edit = w.writes.indexOf(`gh pr edit ${PR}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(edit);
    expect(w.pr.labels).toContain(APPLIED_LABEL);
    expect(w.tracker.issues.get(TICKET)!.labels).toContain(APPLIED_LABEL);
  });

  it("recovers from a write that failed mid-run on the next run, with one comment", async () => {
    // A real failure, not a seeded half-state: the comment and the unblock
    // land, the label write throws, and the operator simply runs it again.
    const w = world({});
    w.tracker.failNext("addLabels", new Error("tracker write failed"));
    expect(await w.run()).not.toBe(0);
    expect(appliedComments(w)).toHaveLength(1);
    expect(w.pr.isDraft).toBe(true);

    expect(await w.run()).toBe(0);
    expectApplied(w);
  });

  it("tolerates a label that already exists on the repository", async () => {
    const w = world({ labelCreate: { ok: false, stderr: 'label with name "migration-applied" already exists; use `--force` to update' } });
    expect(await w.run()).toBe(0);
    expectApplied(w);
  });

  it("fails on any other label create failure, before labelling or readying", async () => {
    const w = world({ labelCreate: { ok: false, stderr: "HTTP 404: Not Found" } });
    expect(await w.run()).toBe(1);
    expect(w.calls.some((args) => args[0] === "pr" && args[1] === "ready")).toBe(false);
  });

  it("comments again when the ticket was re-blocked on a new migration after an earlier apply", async () => {
    const w = world({ comments: [BLOCK, appliedComment(TICKET, PR), BLOCK], labels: ["rafa-blocked", APPLIED_LABEL] });
    expect(await w.run()).toBe(0);
    expect(appliedComments(w)).toHaveLength(2);
    expect(w.writes[0]).toBe(`tracker comment ${TICKET}`);
  });

  it("is not suppressed by another ticket's marker", async () => {
    const w = world({ comments: [BLOCK, `see #99: ${appliedMarker(99, PR)}`] });
    expect(await w.run()).toBe(0);
    expect(w.writes[0]).toBe(`tracker comment ${TICKET}`);
    expectApplied(w);
  });
});

describe("decide", () => {
  it("reads every step off the state alone", () => {
    expect(
      decide({ ticket: TICKET, comments: [{ body: BLOCK }], labels: ["a-blocked", "b-blocked", "a-wip"], pr: { state: "OPEN", isDraft: true, labels: [] } }),
    ).toEqual({ comment: true, unblock: ["a-blocked", "b-blocked"], labelIssue: true, labelPr: true, ready: true });
  });
});
