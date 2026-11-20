// @vitest-environment node
/**
 * Claiming one issue the caller already chose, rather than one the frontier
 * offered.
 *
 * A role whose intake is its own scanner — the ci-doctor, which finds its case
 * in Buildkite — needs the claim without the selection. What must hold is that
 * it is the SAME claim: the same "already held" fence single-ticket mode
 * applies, reading every roster loop's labels whatever that loop's role. Every
 * read is injected here, so each case can also assert that nothing was written
 * when the fence refused. `claim-lease.test.ts` pins the two-process race over
 * the real lock.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  claimByNumber,
  claimByNumberWithLock,
  type ClaimByNumberIo,
  type LiveIssue,
} from "./frontier/next-tasks";

// The claim labels come from the project's roster: loggd's ralph, rafa, remo, rulo, testo.
process.env.RALPH_PROJECT = join(__dirname, "fixtures", "loggd");

const live = (over: Partial<LiveIssue> = {}): LiveIssue => ({
  assignees: [],
  labels: [{ name: "ready-for-agent" }],
  closedByPullRequestsReferences: [],
  ...over,
});

const io = (
  over: { issue?: LiveIssue | Error } = {},
): ClaimByNumberIo & { reads: number[]; writes: string[] } => {
  const reads: number[] = [];
  const writes: string[] = [];
  return {
    reads,
    writes,
    readLive: async (n) => {
      reads.push(n);
      const issue = over.issue ?? live();
      if (issue instanceof Error) throw issue;
      return issue;
    },
    claim: async (n, label) => {
      writes.push(`${n} ${label}`);
    },
  };
};

describe("claimByNumber", () => {
  it("claims a free issue with the label it was given, writing once", async () => {
    const seen = io();
    const outcome = await claimByNumber(1397, "ci-doc-wip", seen);
    expect(outcome).toEqual({ number: 1397, label: "ci-doc-wip", claimed: true, refusal: null });
    expect(seen.writes).toEqual(["1397 ci-doc-wip"]);
    // The live re-read is the fence, so it has to have happened before the write.
    expect(seen.reads).toEqual([1397]);
  });

  it("refuses an issue a human took, naming the assignee, and writes nothing", async () => {
    const seen = io({ issue: live({ assignees: [{ login: "felipearosr" }] }) });
    const outcome = await claimByNumber(1397, "ralph-wip", seen);
    expect(outcome).toMatchObject({ claimed: false, refusal: "assigned to felipearosr" });
    expect(seen.writes).toEqual([]);
  });

  it("refuses an issue another roster loop already claimed, whatever that loop's role", async () => {
    const seen = io({ issue: live({ labels: [{ name: "ready-for-agent" }, { name: "rulo-wip" }] }) });
    const outcome = await claimByNumber(1397, "ralph-wip", seen);
    expect(outcome).toMatchObject({ claimed: false, refusal: "labeled rulo-wip" });
    expect(seen.writes).toEqual([]);
  });

  it("refuses an issue parked as blocked", async () => {
    const seen = io({ issue: live({ labels: [{ name: "remo-blocked" }] }) });
    const outcome = await claimByNumber(1397, "ralph-wip", seen);
    expect(outcome).toMatchObject({ claimed: false, refusal: "labeled remo-blocked" });
    expect(seen.writes).toEqual([]);
  });

  it("claims past labels that are not the roster's: the fence is the claim labels, not any label", async () => {
    const seen = io({
      issue: live({ labels: [{ name: "ready-for-agent" }, { name: "priority:urgent" }, { name: "ci-health" }] }),
    });
    await expect(claimByNumber(1397, "ralph-wip", seen)).resolves.toMatchObject({ claimed: true });
    expect(seen.writes).toEqual(["1397 ralph-wip"]);
  });

  it("refuses a label no fence reads, before it reaches GitHub or the lease store", async () => {
    // A claim written as `rafa2-wip`, or as an unrelated label that happens to
    // exist on the tracker, puts a lease in the store saying the issue is held
    // while every other loop walks straight over it.
    await expect(claimByNumberWithLock(1397, { label: "ralph2-wip" })).rejects.toThrow(
      /not a claim label of this project's loops/,
    );
    await expect(claimByNumberWithLock(1397, { label: "ready-for-agent" })).rejects.toThrow(
      /ready-for-agent is not a claim label/,
    );
    // No positive case here on purpose: a label that PASSES the check goes on to
    // take the lock and ask the real `gh`, and a test that claims a live issue is
    // not a test. The roster's labels are covered by every case above, which all
    // reach `io.claim`.
  });

  it("throws when the live read fails, rather than reporting a refusal it never read", async () => {
    // Unlike `takeOne`, there is no next candidate to fall to: a caller that
    // cannot tell free from held must not claim, and "refused" would be a lie.
    const seen = io({ issue: new Error("gh: API rate limit exceeded") });
    await expect(claimByNumber(1397, "ralph-wip", seen)).rejects.toThrow(/rate limit/);
    expect(seen.writes).toEqual([]);
  });
});
