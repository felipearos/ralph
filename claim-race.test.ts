// @vitest-environment node
/**
 * How the supervisor tells a lost claim race from a real disagreement.
 *
 * The gate names a ticket from a dry run; another loop can claim it before the
 * iteration's real take-one. The iteration then comes back empty, and before
 * #118 that counted towards the halt that stops a loop for a human. These pin
 * the three answers `claimRace` gives, against the frontier's own claim fence,
 * with every read injected. `ralph.test.ts` pins what the supervisor does with
 * each answer.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claimLease, type ClaimLease, type LeaseStore } from "./claim-lease";
import { EXIT_CODE, claimRace, type LinkedPullRequest, type RaceIo } from "./claim-race";
import type { LiveIssue } from "./frontier/next-tasks";

// The claim labels come from the project's roster: loggd's ralph, rafa, remo, rulo.
process.env.RALPH_PROJECT = join(__dirname, "fixtures", "loggd");

const NOW = 1_000_000;

const live = (over: Partial<LiveIssue> = {}): LiveIssue => ({
  assignees: [],
  labels: [{ name: "ready-for-agent" }],
  closedByPullRequestsReferences: [],
  ...over,
});

const leaseFor = (loop: string, over: { nowMs?: number; leaseMs?: number } = {}): ClaimLease => {
  const store: LeaseStore = { version: 1, leases: {} };
  return claimLease(store, {
    issue: 1397, run: `${loop}-run`, loop, pid: null, host: "desk",
    worktree: `/tmp/${loop}`, branch: `${loop}/1397`,
    nowMs: over.nowMs ?? NOW, leaseMs: over.leaseMs ?? 120_000,
  }).lease;
};

const io = (over: {
  issue?: LiveIssue | Error;
  prs?: Record<number, LinkedPullRequest | Error>;
  lease?: ClaimLease;
} = {}): RaceIo & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    nowMs: NOW,
    lease: () => over.lease,
    readLive: async (n) => {
      reads.push(`issue ${n}`);
      const issue = over.issue ?? live();
      if (issue instanceof Error) throw issue;
      return issue;
    },
    readPullRequest: async (n) => {
      reads.push(`pr ${n}`);
      const pr = over.prs?.[n];
      if (pr === undefined) throw new Error(`no PR #${n} in this test`);
      if (pr instanceof Error) throw pr;
      return pr;
    },
  };
};

describe("claimRace", () => {
  it("reports a race lost to another loop's claim label, naming the loop", async () => {
    // #1397: `ralph-wip` landed seconds after remo's and rulo's gates named it.
    const verdict = await claimRace(1397, "remo", io({
      issue: live({ labels: [{ name: "ready-for-agent" }, { name: "ralph-wip" }] }),
    }));
    expect(verdict).toEqual({
      outcome: "lost",
      holder: "ralph",
      line: "lost the claim race for #1397 to ralph (labeled ralph-wip)",
    });
    expect(EXIT_CODE[verdict.outcome]).toBe(0);
  });

  it("reports a race lost to the ticket closing, not to this loop's own claim (#655)", async () => {
    const verdict = await claimRace(1407, "rafa", io({ issue: { ...live(), state: "closed", status: "Mergeado" } }));
    expect(verdict).toMatchObject({ outcome: "lost", holder: "closed" });
    expect(verdict.line).toBe("lost the claim race for #1407 to closed (closed (Mergeado))");
    expect(EXIT_CODE[verdict.outcome]).toBe(0);
  });

  it("reports a race lost to an assignee", async () => {
    const verdict = await claimRace(1407, "rafa", io({ issue: live({ assignees: [{ login: "felipearosr" }] }) }));
    expect(verdict.outcome).toBe("lost");
    expect(verdict.line).toBe("lost the claim race for #1407 to felipearosr (assigned to felipearosr)");
  });

  it("reports a race lost to another loop's open PR, named by its provenance line", async () => {
    const verdict = await claimRace(1407, "rafa", io({
      issue: live({ closedByPullRequestsReferences: [{ number: 1500 }] }),
      prs: { 1500: { state: "OPEN", body: "Closes #1407\n\n🤖 Rulo loop — run rulo-abc" } },
    }));
    expect(verdict).toMatchObject({ outcome: "lost", holder: "rulo" });
    expect(verdict.line).toBe("lost the claim race for #1407 to rulo (open PR #1500)");
  });

  it("names an unstamped open PR by its number", async () => {
    const verdict = await claimRace(1407, "rafa", io({
      issue: live({ closedByPullRequestsReferences: [{ number: 1500 }] }),
      prs: { 1500: { state: "OPEN", body: "Closes #1407" } },
    }));
    expect(verdict).toMatchObject({ outcome: "lost", holder: "PR #1500" });
  });

  it("reports a race lost to another loop's live lease without asking GitHub", async () => {
    const reads = io({ lease: leaseFor("rulo") });
    const verdict = await claimRace(1397, "remo", reads);
    expect(verdict).toMatchObject({ outcome: "lost", holder: "rulo" });
    expect(verdict.line).toBe("lost the claim race for #1397 to rulo (live lease rulo-wip)");
    expect(reads.reads).toEqual([]);
  });

  it("does not count an expired lease as a claim", async () => {
    const verdict = await claimRace(1397, "remo", io({ lease: leaseFor("rulo", { nowMs: 0, leaseMs: 1_000 }) }));
    expect(verdict.outcome).toBe("free");
  });

  it("finds nothing to explain an unclaimed ticket — a real disagreement", async () => {
    const verdict = await claimRace(1099, "ralph", io());
    expect(verdict).toEqual({ outcome: "free", line: "#1099 is not claimed by another loop" });
    expect(EXIT_CODE[verdict.outcome]).toBe(1);
  });

  it("does not excuse a ticket held by this loop's own claim", async () => {
    // The iteration came back empty beside a ticket it holds itself: that is
    // exactly the stable disagreement the streak exists to catch.
    const verdict = await claimRace(1099, "ralph", io({
      issue: live({ labels: [{ name: "ralph-blocked" }] }),
      lease: leaseFor("ralph"),
    }));
    expect(verdict).toEqual({
      outcome: "free",
      line: "#1099 is held by this loop's own claim (labeled ralph-blocked), not another loop's",
    });
  });

  it("does not excuse a ticket whose only open PR is this loop's own", async () => {
    const verdict = await claimRace(1099, "ralph", io({
      issue: live({ closedByPullRequestsReferences: [{ number: 1600 }] }),
      prs: { 1600: { state: "OPEN", body: "🤖 Ralph loop — run ralph-1" } },
    }));
    expect(verdict.outcome).toBe("free");
  });

  it("ignores a closed PR the issue still links to", async () => {
    const verdict = await claimRace(1099, "ralph", io({
      issue: live({ closedByPullRequestsReferences: [{ number: 1601 }] }),
      prs: { 1601: { state: "CLOSED", body: "🤖 Rafa loop — run rafa-1" } },
    }));
    expect(verdict.outcome).toBe("free");
  });

  it("reports an unreadable issue as undetermined rather than guessing", async () => {
    const verdict = await claimRace(1099, "ralph", io({
      issue: new Error("gh issue view 1099 failed: API rate limit exceeded\nmore"),
    }));
    expect(verdict).toEqual({
      outcome: "unread",
      line: "could not tell whether #1099 was claimed by another loop: gh issue view 1099 failed: API rate limit exceeded",
    });
    expect(EXIT_CODE[verdict.outcome]).toBe(3);
  });

  it("reports an unreadable linked PR as undetermined too", async () => {
    const verdict = await claimRace(1099, "ralph", io({
      issue: live({ closedByPullRequestsReferences: [{ number: 1602 }] }),
      prs: { 1602: new Error("gh pr view 1602 failed: HTTP 502") },
    }));
    expect(verdict.outcome).toBe("unread");
  });

  it("makes one GitHub read for an issue with no linked PRs", async () => {
    const reads = io({ issue: live({ labels: [{ name: "rafa-wip" }] }) });
    await claimRace(1397, "remo", reads);
    expect(reads.reads).toEqual(["issue 1397"]);
  });
});
