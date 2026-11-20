/**
 * The live write port: where a `live` clerk's writes reach the Jira intake
 * board and Slack (felipearos/ralph#320, #447).
 *
 * It implements the same `WritePort` the shadow port does, so `clerk/apply.ts`
 * decides every write and this file only carries it out. `intakePort` is built
 * only in `live` mode (`clerk/gate.ts`), and it is the only place in the
 * harness that holds both a Jira writer and a Slack writer. `quietPort`, for
 * `quiet` mode, holds the Jira writer alone.
 *
 * Idempotency, as the spec decides it: every ticket the clerk files carries a
 * marker derived from its report's permalink, and before creating, the board
 * is searched for a ticket whose description carries it; an existing one is
 * reused.
 *
 * The clerk files nowhere else: its Linear port went with the Linear path
 * (felipearos/ralph#466).
 */
import { clerkJira, type ClerkRules } from "../project-config";
import { AGENT_LABEL, fieldLines, filedIdentity, INTAKE_LABEL, PERSON_LABEL, TargetGone, type NewIssue, type ThreadReplies, type WritePort } from "./apply";
import { JiraError, jqlString, type JiraClient, type JiraIssue } from "./jira";
import type { SlackClient } from "./slack";

/**
 * How many marker hits `findFiled` reads. One report is filed once, so more
 * than one hit is already a duplicate; a few is room, not a search.
 */
export const FILED_MARKER_LIMIT = 5;

/**
 * The marker a filed issue carries for its report: one word of letters and
 * digits, because a tokenising search mangles punctuation and every miss costs
 * a duplicate ticket. Stripping the
 * punctuation also keeps it out of the quoted report: a reporter who pasted
 * another report's link quotes the URL with its punctuation, which never reads
 * as this word. The closing `fin` keeps a marker from matching inside a longer
 * permalink's (a thread reply's link extends its root's).
 */
export const filedMarker = (permalink: string): string => `slackintake${permalink.replace(/[^A-Za-z0-9]/g, "")}fin`;

/**
 * Whether `text` is the clerk's own record of `permalink`: the line it writes,
 * not anywhere in the quote. A reporter who pasted another report's link into
 * theirs must not make that other report read as filed.
 */
export const carriesPermalink = (text: string, permalink: string): boolean =>
  new RegExp(`en Slack: ${permalink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "m").test(text);

/**
 * What a reader is told about the marker. It has to stay in the description,
 * where the search finds it, so the line says who may ignore it and why it
 * must not be edited: deleting it lets the clerk file the report again.
 */
export const MARKER_NOTE = "Referencia interna del clerk. Agentes y devs: ignorar esta línea. No editar ni borrar, evita tickets duplicados:";

/**
 * The description of a ticket the clerk files: the report, its field lines,
 * then the marker below a divider. A split report's other tickets carry their
 * part's marker, so none of them reads as the report's own ticket.
 */
export const issueBody = (issue: NewIssue): string =>
  [issue.description, fieldLines(issue).join("\n"), "---", `${MARKER_NOTE} ${filedMarker(filedIdentity(issue))}`].join("\n\n");

/** A 404 from Jira on a write aimed at `key`, as the "it is gone" the apply knows how to handle. */
async function aimedAt<T>(key: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof JiraError && error.failure.kind === "denied" && error.failure.code === "jira_not_found") throw new TargetGone(key);
    throw error;
  }
}

/**
 * How far back the second, code-matched look for a filed ticket goes, and how
 * many it reads. The crash it exists for is minutes old — a create that
 * landed and a save that did not — so a week of one channel's reports is room.
 */
export const FILED_LOOKBACK_DAYS = 7;
export const FILED_LOOKBACK_MAX = 100;

/** The intake tickets whose text carries a report's marker: the idempotency search, as before #393. */
export const filedMarkerJql = (project: string, permalink: string): string =>
  `project = ${jqlString(project)} AND text ~ ${jqlString(filedMarker(permalink))} ORDER BY created DESC`;

/** The clerk's own recent intake tickets, for the look that does not trust the search index. */
export const recentIntakeJql = (project: string): string =>
  `project = ${jqlString(project)} AND labels = ${jqlString(INTAKE_LABEL)} AND created >= -${FILED_LOOKBACK_DAYS}d ORDER BY created DESC`;

/** Every write of a port but those that reach a Slack thread. */
type BoardWrites = Omit<WritePort, "mode" | "reply" | "hasReply" | "threads">;

/**
 * The Jira half of the intake ports (felipearos/ralph#447): a report becomes a
 * ticket in `clerk.jira.intakeProject`, moved to the board's pending status
 * ("Por confirmar") for a person to confirm, and every other write — a
 * duplicate's comment, a regression's link, a thread reply copied on — is a
 * Jira one. Live and quiet share it whole, so what quiet tests on the board is
 * exactly what live will do there.
 *
 * `note` hears what the poll's notes should keep: a status move that failed,
 * story points Jira refused. Neither is a failure: the ticket exists, and
 * losing its key would file it again on the next run.
 */
function boardWrites(jira: JiraClient, rules: ClerkRules, note: (line: string) => void): BoardWrites {
  const intake = clerkJira(rules.jira);
  const project = intake.intakeProject;
  // The gate builds these ports only when the board is configured.
  if (project === null) throw new Error("clerk: an intake port needs 'clerk.jira.intakeProject'");
  const pending = intake.statuses.pending;
  const field = intake.storyPointsField;
  const carries = (issue: JiraIssue, permalink: string): boolean => issue.description.includes(filedMarker(permalink));
  const toPending = async (key: string): Promise<void> => {
    // `transition` never throws and leaves a ticket already there alone.
    const moved = await jira.transition(key, pending);
    if (moved.warning !== null) note(`${key} filed, but not moved to '${pending}': ${moved.warning}`);
  };
  return {
    async findFiled(permalink) {
      let hit = (await jira.search(filedMarkerJql(project, permalink), FILED_MARKER_LIMIT)).find((issue) => carries(issue, permalink));
      if (hit === undefined) {
        // Jira's search index can trail a create by a few seconds, which is
        // exactly the window a kill between the create and the save falls
        // in; the clerk's own recent tickets are read as well, and the marker
        // matched in code, so that rerun finds what the search has not yet.
        hit = (await jira.search(recentIntakeJql(project), FILED_LOOKBACK_MAX)).find((issue) => carries(issue, permalink));
      }
      if (hit === undefined) return null;
      // A kill between the create and its move leaves the ticket where the
      // board starts new ones. Still in that category, it is moved now; one a
      // person has already moved on is left where they put it.
      if (hit.statusCategory === "new" && hit.status !== pending) await toPending(hit.key);
      return hit.key;
    },
    async hasComment(key, permalink) {
      return aimedAt(key, async () => (await jira.comments(key)).some((comment) => carriesPermalink(comment, permalink)));
    },
    async create(issue) {
      const { key, pointsWritten } = await jira.createIssue(
        {
          project,
          type: issue.type,
          summary: issue.summary,
          // The field block keeps the suggested points in the description
          // whatever the field does, so a refused field loses nothing.
          description: issueBody(issue),
          labels: issue.labels,
          priority: issue.priority,
          storyPoints: issue.storyPoints,
        },
        { storyPointsField: field },
      );
      if (field !== null && issue.storyPoints !== null && !pointsWritten) {
        note(`${key} filed without story points in ${field}: Jira refused the field, so they are only in the description ("Puntos de historia sugeridos")`);
      }
      await toPending(key);
      return key;
    },
    async comment(key, body) {
      await aimedAt(key, () => jira.addComment(key, body));
    },
    async link(from, to, why) {
      await aimedAt(to, () => jira.link(from, to, why === "posible duplicado" ? "duplicate" : "relates"));
    },
    async relabel(key) {
      await aimedAt(key, () => jira.updateFields(key, { labels: { add: [PERSON_LABEL], remove: [AGENT_LABEL] } }));
    },
    async copyReply(key, body) {
      try {
        await aimedAt(key, () => jira.addComment(key, body));
      } catch (error) {
        // Gone — deleted by hand, or a key from before the board, which Jira
        // does not hold: the reply has nowhere to go, and holding every later
        // reply behind it would be worse than dropping this one.
        if (!(error instanceof TargetGone)) throw error;
      }
    },
  };
}

/**
 * The live write port onto the Jira intake board: the board's writes, and the
 * report's thread replies posted in Slack.
 */
export function intakePort(jira: JiraClient, slack: SlackClient, rules: ClerkRules, note: (line: string) => void = () => {}): WritePort {
  const threads = liveThreads(slack, rules);
  return {
    mode: "live",
    ...boardWrites(jira, rules, note),
    threads,
    hasReply: (report, text) => threads.hasReply(report.id, text),
    reply: (report, text) => threads.reply(report.id, text),
  };
}

/**
 * Replies in any thread of the channel: a report's own, and the grouping
 * replies on its follow-up messages. Only `intakePort` builds one.
 */
export function liveThreads(slack: Pick<SlackClient, "replies" | "postReply">, rules: Pick<ClerkRules, "channel">): ThreadReplies {
  return {
    async hasReply(thread, text) {
      return (await slack.replies(rules.channel, thread)).some((message) => message.bot_id !== undefined && message.text === text);
    },
    async reply(thread, text) {
      await slack.postReply(rules.channel, thread, text);
    },
  };
}

/**
 * The quiet write port (felipearos/ralph#443): the same Jira writes as live,
 * on the real intake board, and no Slack at all. It is handed no Slack client,
 * as the shadow port is handed no client of any kind, so no plan, thread or
 * defect can make a quiet apply post in the channel: the reply the reporter
 * would get is dropped here, and the journal line says so.
 */
export function quietPort(jira: JiraClient, rules: ClerkRules, note: (line: string) => void = () => {}): WritePort {
  return {
    mode: "quiet",
    ...boardWrites(jira, rules, note),
    async hasReply() {
      return false;
    },
    async reply() {},
  };
}
