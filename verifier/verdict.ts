/**
 * The verifier's verdict rules (spec felipearos/ralph#560, ticket #562), as one
 * pure function over the evidence a check-in gathered. No network, no config
 * reads: the caller resolves thresholds and the mode and passes them in.
 *
 * In order of precedence:
 *
 *   1. UNREACHABLE SOURCE. Sentry unreachable, or traffic unreachable while
 *      the traffic floor is on → `pending` if more check-ins are due, else
 *      `inconclusive`. Never `ticket` or `revert`, whatever else the evidence
 *      says: an observability outage must never cause a revert. With the floor
 *      off the traffic signal is unused, so its reachability does not count.
 *   2. HARD BREAK in any acceptance result → `revert`.
 *   3. SENTRY ISSUES. An issue is new when it was first seen after the deploy,
 *      or its post-deploy rate is above zero and at least `rateFactor` times
 *      the pre-deploy rate. Issues that are not new are pre-existing noise.
 *      A new issue that is attributable to the PR (a frame file or route the
 *      PR changed), not shared with another PR in the same deploy, and over
 *      the impact bar (`minEvents` events or `minDistinctUsers` users) →
 *      `revert`. Any other new issue → `ticket`. Revert beats ticket.
 *   4. FAILED ACCEPTANCE CRITERION → `ticket`. `not-verifiable` never fails.
 *   5. Nothing wrong and more check-ins due → `pending`.
 *   6. Last check-in: floor on and zero hits → `unexercised`; else `verified`.
 *
 * ROUND CAP, after 1–6: a `ticket` or `revert` on failure round 3 or later
 * becomes `needs-human` (high priority) — the loop has already tried twice.
 *
 * MODES, applied last: `act` returns the verdict as is; `report` downgrades
 * `revert` to a high-priority `ticket`; `observe` returns the computed
 * verdict with `act: false` and records it in `wouldHaveBeen`.
 */

// One mode vocabulary: the config validator owns it, and a watch records it
// from there, so the verdict must not hold a second copy that could drift.
import type { VerifierMode } from "../project-config";
export type { VerifierMode };

export type AcceptanceResultKind = "passed" | "failed" | "hard-break" | "not-verifiable";

export interface AcceptanceResult {
  criterion: string;
  result: AcceptanceResultKind;
  detail?: string;
  /** What the session saw: a screenshot path or a response excerpt. */
  evidence?: string;
}

export interface SentryIssue {
  id: string;
  title: string;
  link?: string;
  /** ISO time. */
  firstSeen: string;
  preDeployRate: number;
  postDeployRate: number;
  frameFiles: string[];
  /** Failing routes or features the issue is on. */
  routes: string[];
  /** Already excludes the verifier's test account, so its own probes never count as impact. */
  events: number;
  /** Already excludes the verifier's test account. */
  distinctUsers: number;
}

export interface HealthEvidence {
  reachable: boolean;
  issues: SentryIssue[];
}

export interface TrafficEvidence {
  reachable: boolean;
  /** Hits on the changed routes/features since the deploy. */
  hits: number;
}

export interface DeployedPr {
  number: number;
  files: string[];
  routes: string[];
}

export interface VerdictThresholds {
  rateFactor: number;
  minEvents: number;
  minDistinctUsers: number;
}

export type VerdictKind = "pending" | "verified" | "unexercised" | "inconclusive" | "ticket" | "revert" | "needs-human";

export interface VerdictInput {
  acceptance: AcceptanceResult[];
  health: HealthEvidence;
  traffic: TrafficEvidence;
  /** ISO time of the production deploy. */
  deployedAt: string;
  pr: DeployedPr;
  /** The other PRs that shipped in the same deploy. */
  otherPrs: DeployedPr[];
  thresholds: VerdictThresholds;
  trafficFloor: boolean;
  moreCheckInsDue: boolean;
  /** 1-based: the failure round this verdict would be for the root ticket. */
  round: number;
  mode: VerifierMode;
}

export interface Verdict {
  verdict: VerdictKind;
  reason: string;
  priority: "normal" | "high";
  /** Whether the caller may perform the verdict's action and labels. */
  act: boolean;
  /** Set only when the mode changed what the computed verdict would have done. */
  wouldHaveBeen?: VerdictKind;
}

const ROUND_CAP = 3;

interface Computed {
  verdict: VerdictKind;
  reason: string;
}

// Sentry frames and PR diffs disagree on a leading "./" or "/"; compare bare.
const normalize = (path: string): string => path.replace(/^\.?\//, "");

const intersect = (a: string[], b: string[]): string[] => {
  const set = new Set(b.map(normalize));
  return a.map(normalize).filter((x) => set.has(x));
};

const label = (issue: SentryIssue): string => `Sentry issue ${issue.id} "${issue.title}"`;

function isNew(issue: SentryIssue, deployedAt: string, rateFactor: number): boolean {
  const first = Date.parse(issue.firstSeen);
  const deployed = Date.parse(deployedAt);
  if (first > deployed) return true;
  // post > 0 first: with a pre-deploy rate of 0 the product is 0, and every
  // quiet issue would otherwise count as a rate rise.
  // A non-finite or sub-1 factor would mark falling rates as rises; skip the rule.
  if (!Number.isFinite(rateFactor) || rateFactor < 1) return false;
  return issue.postDeployRate > 0 && issue.postDeployRate >= rateFactor * issue.preDeployRate;
}

/** One new issue's verdict: `revert` only when every leg holds. */
function judgeIssue(issue: SentryIssue, input: VerdictInput): Computed {
  const { pr, otherPrs, thresholds } = input;
  const matched = [...intersect(issue.frameFiles, pr.files), ...intersect(issue.routes, pr.routes)];
  if (matched.length === 0) {
    return { verdict: "ticket", reason: `${label(issue)} is new since the deploy but not attributable to PR #${pr.number}` };
  }
  // Shared asks whether another PR in the deploy could be blamed for the same
  // issue, so it reads the issue's whole trace, not only what matched this PR.
  const sharer = otherPrs.find(
    (other) => intersect(issue.frameFiles, other.files).length > 0 || intersect(issue.routes, other.routes).length > 0,
  );
  if (sharer) {
    return {
      verdict: "ticket",
      reason: `${label(issue)} is new since the deploy but shared with PR #${sharer.number} in the same deploy`,
    };
  }
  // A missing or non-finite threshold compares false both ways; count it as
  // below the bar, so a malformed config can only ever produce a ticket.
  const over = (value: number, min: number): boolean => Number.isFinite(min) && value >= min;
  if (!over(issue.events, thresholds.minEvents) && !over(issue.distinctUsers, thresholds.minDistinctUsers)) {
    return {
      verdict: "ticket",
      reason: `${label(issue)} is new and attributable to PR #${pr.number} but below the impact bar (${issue.events} events, ${issue.distinctUsers} users)`,
    };
  }
  return {
    verdict: "revert",
    reason: `${label(issue)} is new, attributable to PR #${pr.number}, not shared, and over the impact bar (${issue.events} events, ${issue.distinctUsers} users)`,
  };
}

function compute(input: VerdictInput): Computed {
  const { acceptance, health, traffic, trafficFloor, moreCheckInsDue } = input;

  // 1. An outage of what we observe with is never evidence against the PR.
  const unreachable: string[] = [];
  if (!health.reachable) unreachable.push("Sentry");
  if (trafficFloor && !traffic.reachable) unreachable.push("traffic");
  if (unreachable.length > 0) {
    const what = `${unreachable.join(" and ")} unreachable`;
    return moreCheckInsDue
      ? { verdict: "pending", reason: `${what}; waiting for the next check-in` }
      : { verdict: "inconclusive", reason: `${what} at the last check-in` };
  }

  // 2.
  const broken = acceptance.find((a) => a.result === "hard-break");
  if (broken) {
    const detail = broken.detail ? `: ${broken.detail}` : "";
    return { verdict: "revert", reason: `acceptance criterion hard-broke in production: "${broken.criterion}"${detail}` };
  }

  // 3. Revert beats ticket; the first issue of the winning kind decides.
  const judged = health.issues
    .filter((issue) => isNew(issue, input.deployedAt, input.thresholds.rateFactor))
    .map((issue) => judgeIssue(issue, input));
  const decisive = judged.find((j) => j.verdict === "revert") ?? judged[0];
  const failed = acceptance.find((a) => a.result === "failed");
  if (decisive) {
    // A failed criterion is this PR's own finding; keep it in the ticket the issue files.
    if (decisive.verdict === "ticket" && failed) {
      return { verdict: "ticket", reason: `${decisive.reason}; acceptance criterion also failed: "${failed.criterion}"` };
    }
    return decisive;
  }

  // 4.
  if (failed) {
    const detail = failed.detail ? `: ${failed.detail}` : "";
    return { verdict: "ticket", reason: `acceptance criterion failed: "${failed.criterion}"${detail}` };
  }

  // 5.
  if (moreCheckInsDue) return { verdict: "pending", reason: "nothing wrong so far; more check-ins due" };

  // 6.
  if (trafficFloor && traffic.hits === 0) {
    return { verdict: "unexercised", reason: "nothing wrong, but the changed routes saw no traffic" };
  }
  return { verdict: "verified", reason: "nothing wrong at the last check-in" };
}

export function decideVerdict(input: VerdictInput): Verdict {
  let { verdict, reason } = compute(input);

  if ((verdict === "ticket" || verdict === "revert") && input.round >= ROUND_CAP) {
    reason = `${reason} (round cap reached at round ${input.round}, instead of a ${verdict})`;
    verdict = "needs-human";
  }

  const priority = verdict === "revert" || verdict === "needs-human" ? "high" : "normal";

  if (input.mode === "observe") {
    // Observe writes nothing; the would-be action is recorded for later review.
    return { verdict, reason, priority, act: false, ...(verdict !== "pending" ? { wouldHaveBeen: verdict } : {}) };
  }
  if (input.mode === "report" && verdict === "revert") {
    return {
      verdict: "ticket",
      reason: `${reason} (report mode: filed as a ticket instead of a revert)`,
      priority: "high",
      act: true,
      wouldHaveBeen: "revert",
    };
  }
  return { verdict, reason, priority, act: true };
}
