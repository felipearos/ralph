/**
 * The tickets a report might already be, gathered by code before the session
 * sees the report (felipearos/ralph#315), read from the Jira intake board
 * (felipearos/ralph#447).
 *
 * Every open ticket the clerk filed (`slack-intake`), because the channel's own
 * recent reports are the likeliest duplicates; and the intake tickets closed
 * within the regression window, because a report of one of those may be a
 * regression. A closed ticket carrying `moved-to-jira` was moved to the team's
 * board by the confirmation sweep and is still live there: it is offered with
 * the OA key read from its comments, so a reporter is pointed at where the
 * work is. Each carries the permalink its description names, so a sure
 * duplicate's reply can link the first report of the problem.
 *
 * The session may name only what it was offered: `clerk/plan.ts` downgrades a
 * `duplicate_of` outside this list to a new ticket, so the list is also the
 * boundary of what a report can be merged into.
 */
import { clerkJira, type ClerkJira } from "../project-config";
import { INTAKE_LABEL, MOVED_LABEL, reportPermalinkOf } from "./apply";
import { jqlString, type JiraClient, type JiraIssue } from "./jira";
import type { Candidate } from "./plan";
import type { Report } from "./reports";

/** How many open intake tickets are read. A channel with more open than this has a backlog no dedupe list fixes. */
export const OPEN_CAP = 50;
/** How many closed intake tickets are looked at for the window, most recently updated first. */
export const CLOSED_SCAN = 25;

const DAY_MS = 86_400_000;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The OA key a moved ticket was given: the first match in its comments, newest first; null when none names one. */
export function jiraKeyOf(comments: readonly { body: string; createdAt?: string }[], project: string): string | null {
  const pattern = new RegExp(`\\b${escapeRegExp(project)}-\\d+\\b`);
  const newestFirst = comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => (Date.parse(b.comment.createdAt ?? "") || 0) - (Date.parse(a.comment.createdAt ?? "") || 0) || b.index - a.index);
  for (const { comment } of newestFirst) {
    const match = pattern.exec(comment.body);
    if (match !== null) return match[0];
  }
  return null;
}

const intakeJql = (project: string, clause: string): string =>
  `project = ${jqlString(project)} AND labels = ${jqlString(INTAKE_LABEL)} AND ${clause}`;

/** The open intake tickets: every one not in Jira's done category, newest first. */
export const openIntakeJql = (project: string): string => intakeJql(project, "statusCategory != Done ORDER BY created DESC");

/**
 * The done intake tickets touched within the window, newest first: a superset
 * of those that reached done in it, which code then keeps (`doneAt`).
 */
export const doneIntakeJql = (project: string, days: number): string =>
  intakeJql(project, `statusCategory = Done AND updated >= -${days}d ORDER BY updated DESC`);

/**
 * Each report's candidates, by report id: the open `slack-intake` tickets, and
 * those that reached Jira's done category within the regression window. The
 * same list goes to every report in the batch, read once.
 *
 * A moved ticket's OA key is read from its comments (`jiraKeyOf`). Two
 * searches, then one comment read per moved ticket whose search page did not
 * hold the key. A Jira failure propagates — a live batch handed over without
 * its candidates would invite the duplicates they exist to prevent.
 */
export async function gatherIntakeCandidates(
  jira: JiraClient,
  rules: { jira: ClerkJira; regressionDays: number },
  reports: readonly Report[],
  nowMs: number,
): Promise<Map<string, Candidate[]>> {
  const project = clerkJira(rules.jira).intakeProject;
  if (project === null) throw new Error("clerk: intake candidates need 'clerk.jira.intakeProject'");
  const open: Candidate[] = (await jira.search(openIntakeJql(project), OPEN_CAP)).map((issue) => ({
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    closed: null,
    labels: issue.labels,
    jiraKey: null,
    permalink: reportPermalinkOf(issue.description),
  }));
  const closed: Candidate[] = [];
  for (const issue of await jira.search(doneIntakeJql(project, rules.regressionDays), CLOSED_SCAN)) {
    // A workflow can close a ticket without a resolution; the move to the
    // done category is the close either way.
    const at = issue.doneAt ?? issue.resolved;
    if (at === null || !(nowMs - Date.parse(at) <= rules.regressionDays * DAY_MS)) continue;
    closed.push({
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      closed: at,
      labels: issue.labels,
      jiraKey: issue.labels.includes(MOVED_LABEL) ? await movedKey(jira, issue, rules.jira.project) : null,
      permalink: reportPermalinkOf(issue.description),
    });
  }
  const candidates = [...open, ...closed];
  return new Map(reports.map((report) => [report.id, [...candidates]]));
}

/**
 * The OA key a moved ticket went to. The search carries only its first
 * comments; when those name none and there are more, the rest are read.
 */
async function movedKey(jira: JiraClient, issue: JiraIssue, project: string): Promise<string | null> {
  // Oldest first, as the search returns them: `jiraKeyOf` takes the last.
  const found = jiraKeyOf(issue.commentTexts.map((body) => ({ body })), project);
  if (found !== null || issue.comments <= issue.commentTexts.length) return found;
  // `comments` reads newest first, so reversed into the order `jiraKeyOf` expects.
  return jiraKeyOf([...(await jira.comments(issue.key))].reverse().map((body) => ({ body })), project);
}
