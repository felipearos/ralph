#!/usr/bin/env bun
/**
 * Did this loop lose the claim race for the ticket its gate named?
 *
 * The gate used to name a ticket through `next.ts --take-one --dry-run`, which
 * reads but does not claim. The iteration it spawned claimed for real a few
 * seconds to a minute later, and in that window another loop could claim the
 * same ticket. The iteration's take-one then came back empty, the iteration
 * ended `ALL_BLOCKED`, and the supervisor used to count that as the gate and
 * the iteration disagreeing. Two in a row halted the loop for a human. On
 * 2026-09-26/27 that halted remo and rulo over #1397 and rafa over #1407: each
 * lost a race it could never have won.
 *
 * Since #5 the supervisor's coder gate claims the ticket itself when it
 * reports it (`frontier-gate.ts --claim`), under a lease written with
 * RALPH_RUN_ID/RALPH_SUPERVISOR_PID that the run heartbeats — a dead
 * supervisor's lease expires and the frontier reclaims the ticket — so that
 * session cannot lose the race and `ralph.sh` does not ask this. Polls stay
 * read-only. The race now only happens on the gate's unreadable-probe
 * fallback: when the PR list or the loop's claim list could not be read, the
 * gate does not claim, reports the ticket from a dry run, and the session
 * claims as before. That path, and a role whose gate does not claim, still
 * come here.
 *
 * So before the supervisor counts a disagreement, it asks this: is the named
 * ticket now held by someone else? "Held" is the frontier's own claim fence,
 * `loopClaimObstruction` — another loop's `-wip` or `-blocked` label, an
 * assignee, or an open PR that closes it — plus a live lease another loop
 * wrote on this machine, which the frontier reads the same way. Reused rather
 * than restated: a second definition of "claimed" is how this check and the
 * frontier would come to disagree about the very thing it exists to explain.
 * One claim it does not see: a live loop branch (#480), which only the
 * frontier's census reads. That gap is acceptable — the only branch it misses
 * is one that appeared between the gate's dry-run and the take-one, and the
 * census that gated this loop already fenced every branch older than that.
 *
 * Three answers, because a read that failed is not evidence either way:
 *
 *   0  lost   another loop (or a person) holds it — not a disagreement
 *   1  free   nothing explains the empty iteration — a real disagreement
 *   3  unread GitHub could not be asked — not counted, but said out loud
 *
 * One GitHub read for the issue, plus one per PR GitHub links to it (usually
 * none, rarely one). The lease is local and checked first, so it costs nothing.
 *
 * Usage:
 *   ralph/claim-race.ts <ticket>   one line on stdout; exit 0, 1 or 3
 */

import { execFile } from "node:child_process";

import { leasePathFromGit, leaseStatus, readLeaseStore, type ClaimLease } from "./claim-lease";
import { provenance } from "./frontier-gate";
import {
  currentLoop,
  loopClaimObstruction,
  loopRoster,
  readLiveIssue,
  stuckLabelFor,
  wipLabelFor,
  type LiveIssue,
  type LoopName,
} from "./frontier/next-tasks";
import { projectRoot } from "./paths";

/** What a linked PR says about itself: whether it is open, and whose it is. */
export interface LinkedPullRequest {
  state: string;
  body: string | null;
}

export type RaceVerdict =
  | { outcome: "lost"; holder: string; line: string }
  | { outcome: "free"; line: string }
  | { outcome: "unread"; line: string };

export const EXIT_CODE: Record<RaceVerdict["outcome"], number> = { lost: 0, free: 1, unread: 3 };

export interface RaceIo {
  /** This machine's lease on the ticket, if any. */
  lease(n: number): ClaimLease | undefined;
  readLive(n: number): Promise<LiveIssue>;
  readPullRequest(n: number): Promise<LinkedPullRequest>;
  nowMs: number;
}

const lost = (ticket: number, holder: string, why: string): RaceVerdict => ({
  outcome: "lost",
  holder,
  line: `lost the claim race for #${ticket} to ${holder} (${why})`,
});

/**
 * The answer, with every read injected. `loop` is THIS loop: its own labels
 * and its own lease are not somebody else's claim, and an iteration that came
 * back empty beside a ticket it holds itself is exactly the disagreement the
 * streak exists to catch.
 */
export async function claimRace(ticket: number, loop: LoopName, io: RaceIo): Promise<RaceVerdict> {
  // A live lease another loop wrote. The claim path writes the lease before the
  // label, so this can be the only trace of a claim still in flight.
  const lease = io.lease(ticket);
  if (lease !== undefined && lease.loop !== loop && leaseStatus(lease, { nowMs: io.nowMs }) !== "expired") {
    return lost(ticket, lease.loop, `live lease ${lease.claim}`);
  }

  // Which loop stamped each linked PR, filled as the fence asks about them.
  const owners = new Map<number, string | null>();
  const isOpenPr = async (n: number): Promise<boolean> => {
    const pr = await io.readPullRequest(n);
    owners.set(n, provenance().exec(pr.body ?? "")?.[1]?.toLowerCase() ?? null);
    return pr.state === "OPEN";
  };

  let live: LiveIssue;
  let obstruction: string | null;
  try {
    live = await io.readLive(ticket);
    obstruction = await loopClaimObstruction(live, isOpenPr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "unread",
      line: `could not tell whether #${ticket} was claimed by another loop: ${message.split("\n")[0]}`,
    };
  }

  if (obstruction === null) {
    return { outcome: "free", line: `#${ticket} is not claimed by another loop` };
  }

  // The fence said held; now say by whom, in the order it checks. A ticket
  // that closed after the gate read it is lost to that close, not a
  // disagreement and not this loop's own claim.
  if (live.state === "closed") return lost(ticket, "closed", obstruction);
  const assignees = live.assignees.map((a) => a.login);
  if (assignees.length > 0) return lost(ticket, assignees.join(", "), obstruction);

  const labels = new Set(live.labels.map((l) => l.name));
  const other = loopRoster().find(
    (name) => name !== loop && (labels.has(wipLabelFor(name)) || labels.has(stuckLabelFor(name))),
  );
  if (other !== undefined) return lost(ticket, other, obstruction);

  // Only reached through the PR half of the fence, so `owners` is filled.
  for (const [pr, owner] of owners) {
    if (owner === loop) continue;
    return lost(ticket, owner ?? `PR #${pr}`, obstruction);
  }

  return {
    outcome: "free",
    line: `#${ticket} is held by this loop's own claim (${obstruction}), not another loop's`,
  };
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    console.error(`claim-race: expected one ticket number; received ${raw ?? "nothing"}`);
    process.exitCode = 2;
    return;
  }
  // Anchored like the gate, so the lease store and every `gh` call resolve
  // against the project whatever directory this was started from.
  process.chdir(projectRoot());
  const ticket = Number(raw);
  const loop = currentLoop();
  const verdict = await claimRace(ticket, loop, {
    lease: (n) => readLeaseStore(leasePathFromGit()).leases[String(n)],
    readLive: readLiveIssue,
    readPullRequest: async (n) =>
      JSON.parse(await run("gh", ["pr", "view", String(n), "--json", "state,body"])) as LinkedPullRequest,
    nowMs: Date.now(),
  });
  console.log(verdict.line);
  process.exitCode = EXIT_CODE[verdict.outcome];
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
