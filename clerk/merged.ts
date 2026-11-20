/**
 * The merged move: an intake ticket whose work is merged goes to
 * `clerk.jira.mergedStatus` ("Mergeado" on OAI).
 *
 * The coder loops on the client repos never merge (`merge: "human"`): they
 * hand a green PR to a person and leave the ticket in its work status. A
 * person merges it days later, and nothing on the board said so. This reads
 * the app repos' PRs the intake page already caches (`clerk/pulls.ts`) and,
 * for every worked ticket a merged PR names, takes the transition there.
 *
 * Only a ticket whose work started moves: one still waiting for a person, or
 * confirmed and not taken, is left where it is, so a PR that only mentions a
 * ticket in its body cannot skip it past the confirmation. Rejected, moved
 * and already merged tickets are out of the search.
 *
 * Quiet and live only, since it writes the board; shadow is never handed it.
 * It never throws out of a poll and never stops one: a Jira or GitHub failure
 * is a note and a retry on the next poll. It keeps no state: a ticket moved
 * is out of the next search, so a rerun moves nothing twice. The status is
 * in Jira's done category, so the outcome scan then records the close and
 * queues the reporter's "resuelto" reply, which the merge lets out at once.
 */
import { clerkJira, type ClerkRules } from "../project-config";
import { ownsTicket, reportsByKey } from "./confirm";
import { JiraError, jqlString, type JiraClient, type JiraIssue } from "./jira";
import { pullsNaming, type PullsRead } from "./pulls";
import { readClerkStore } from "./store";

/** How many worked tickets one poll reads, most recently updated first. */
export const MERGED_READ = 100;

/** How far back the search looks, as the outcome scan's (`OUTCOMES_WINDOW_DAYS`). */
export const MERGED_WINDOW_DAYS = 90;

export interface MergedDeps {
  rules: ClerkRules;
  jira: Pick<JiraClient, "search" | "transition">;
  storePath: string;
  now: () => number;
  /** The app repos' PRs: the intake page's cached read. */
  pulls: (nowMs: number) => Promise<PullsRead>;
}

/**
 * The intake board's tickets whose work started and is not merged: every
 * status but the confirmation's own and the merged one.
 */
export const workedJql = (project: string, statuses: Record<string, string>, merged: string): string =>
  [
    `project = ${jqlString(project)}`,
    `status not in (${[statuses.pending!, statuses.confirmed!, statuses.rejected!, statuses.moved!, merged].map(jqlString).join(", ")})`,
    `updated >= -${MERGED_WINDOW_DAYS}d`,
  ].join(" AND ") + " ORDER BY updated DESC";

/** One round. Never throws: every failure is a note, and the ticket it stopped on is tried again on the next poll. */
export async function moveMerged(deps: MergedDeps): Promise<string[]> {
  const notes: string[] = [];
  try {
    await move(deps, notes);
  } catch (error) {
    notes.push(`the merged move failed: ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`);
  }
  return notes;
}

async function move(deps: MergedDeps, notes: string[]): Promise<void> {
  const intake = clerkJira(deps.rules.jira);
  const project = intake.intakeProject;
  const merged = intake.mergedStatus;
  if (project === null || merged === null) return;

  const read = await deps.pulls(deps.now());
  if (read.note !== null) notes.push(read.note);
  const merges = read.pulls.filter((pull) => pull.state === "mergeado");
  // Nothing merged names this board: no Jira call at all.
  if (!merges.some((pull) => pull.keys.some((key) => key.startsWith(`${project}-`)))) return;

  let worked: JiraIssue[];
  try {
    worked = await deps.jira.search(workedJql(project, intake.statuses, merged), MERGED_READ);
  } catch (error) {
    // A 400 is most often a status name the board does not have.
    const why = error instanceof JiraError ? error.failure.why : error instanceof Error ? error.message : String(error);
    notes.push(`the intake board ${project} could not be searched for merged tickets: ${why}; tried again at the next poll`);
    return;
  }
  const reports = reportsByKey(readClerkStore(deps.storePath, deps.rules.channel).store);
  for (const ticket of worked) {
    // Another channel's loop moves its own tickets, as it records their closes.
    if (!ownsTicket(ticket, deps.rules.channel, reports)) continue;
    const named = pullsNaming(merges, [ticket.key]);
    if (named.length === 0) continue;
    const pull = named[named.length - 1]!;
    const moved = await deps.jira.transition(ticket.key, merged);
    if (moved.warning !== null) notes.push(`${ticket.key}: ${pull.repo}#${pull.number} is merged, but ${moved.warning}`);
    else notes.push(`${ticket.key}: ${pull.repo}#${pull.number} is merged, moved from '${ticket.status}' to '${merged}'`);
  }
}
