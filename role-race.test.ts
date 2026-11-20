// @vitest-environment node
/**
 * The claim race between two loops of ONE role.
 *
 * Buckets make it possible: two triagers poll the same untriaged bucket on the
 * same interval, both gates name #1400 from a dry run, and one of them claims it
 * first. The second's real take-one then comes back empty, and before this is
 * read as a race it is read as the gate disagreeing with the iteration — the
 * halt that stopped three loops on 2026-09-26.
 *
 * What is pinned here is that the answer does not depend on the role: the gate
 * hands the supervisor the ROLE's pick, and `claimRace` judges it against the
 * same labels, leases and PR provenance it judges a coder's by. Its own file
 * because the fences resolve the roster once per process, and this one needs a
 * roster with two triagers in it.
 */
import { afterAll, describe, expect, it } from "vitest";

import { claimLease, type ClaimLease, type LeaseStore } from "./claim-lease";
import { EXIT_CODE, claimRace, type RaceIo } from "./claim-race";
import { cleanupFixtures, scratchProject } from "./dashboard/fixtures";
import type { LiveIssue } from "./frontier/next-tasks";

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

// Set before any fence resolves the roster, which every one of them does lazily.
process.env.RALPH_PROJECT_OWNER = "felipearosr";
process.env.RALPH_PROJECT = scratchProject("role-race", [
  "codo",
  { name: "tria", role: "triager" },
  { name: "trib", role: "triager" },
  { name: "doco", role: "ci-doctor" },
]);

const NOW = 1_000_000;

const live = (over: Partial<LiveIssue> = {}): LiveIssue => ({
  assignees: [],
  labels: [{ name: "ready-for-agent" }],
  closedByPullRequestsReferences: [],
  ...over,
});

const leaseFor = (loop: string): ClaimLease =>
  claimLease(
    { version: 1, leases: {} } satisfies LeaseStore,
    {
      issue: 1400,
      run: `${loop}-run`,
      loop,
      pid: null,
      host: "desk",
      worktree: `/tmp/${loop}`,
      branch: `${loop}/1400`,
      nowMs: NOW,
      leaseMs: 120_000,
    },
  ).lease;

const io = (over: { issue?: LiveIssue; lease?: ClaimLease } = {}): RaceIo & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    nowMs: NOW,
    lease: () => over.lease,
    readLive: async (n) => {
      reads.push(`issue ${n}`);
      return over.issue ?? live();
    },
    readPullRequest: async (n) => {
      throw new Error(`no PR #${n} in this test`);
    },
  };
};

describe("two loops of one role", () => {
  it("reads the other triager's claim label as a lost race, not a disagreement", async () => {
    const verdict = await claimRace(1400, "trib", io({ issue: live({ labels: [{ name: "tria-wip" }] }) }));
    expect(verdict).toMatchObject({ outcome: "lost", holder: "tria" });
    expect(verdict.line).toBe("lost the claim race for #1400 to tria (labeled tria-wip)");
    // 0 is "back to the gate, not counted": exactly what a coder gets.
    expect(EXIT_CODE[verdict.outcome]).toBe(0);
  });

  it("reads the other triager's live lease without asking GitHub", async () => {
    // The claim writes the lease before the label, so a claim still in flight
    // leaves no label to read — and this is the only trace of it.
    const seen = io({ lease: leaseFor("tria") });
    const verdict = await claimRace(1400, "trib", seen);
    expect(verdict).toMatchObject({ outcome: "lost", holder: "tria" });
    expect(verdict.line).toBe("lost the claim race for #1400 to tria (live lease tria-wip)");
    expect(seen.reads).toEqual([]);
  });

  it("does not read a coder's claim on a triager's ticket as anything but a lost race either", async () => {
    // The fence is roster-wide on purpose: a role never changes what holding a
    // ticket means, only which tickets it is offered.
    const verdict = await claimRace(1400, "trib", io({ issue: live({ labels: [{ name: "codo-wip" }] }) }));
    expect(verdict).toMatchObject({ outcome: "lost", holder: "codo" });
  });

  it("still reports a ticket nobody holds as free, so a real disagreement counts", async () => {
    const verdict = await claimRace(1400, "trib", io());
    expect(verdict.outcome).toBe("free");
    expect(EXIT_CODE[verdict.outcome]).toBe(1);
  });
});
