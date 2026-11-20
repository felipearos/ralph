/**
 * What counts as one report in the clerk's channel, and when it is settled
 * (felipearos/ralph#315). Pure: the gate reads Slack, this decides.
 *
 * A reporter does not write a report in one go. They post a message, add a
 * screenshot a minute later, answer a question in the thread. Filing the first
 * message alone files a ticket that is missing what came after it, so:
 *
 * - a top-level message and its whole thread are one report;
 * - consecutive top-level messages by the same author, each within the join
 *   window of the one before, are one report — the second message is the
 *   screenshot the first one forgot;
 * - a report is settled once the settle window has passed with no activity on
 *   it anywhere, its thread included.
 *
 * The clerk's own messages are never reports and never activity: a bot that
 * replies "Ya está reportado: AND-12." must not keep the report it answered from
 * settling, nor file its own reply.
 *
 * Nor are the messages of `clerk.ignoreUsers`, the team members who work the
 * tickets and talk in the channel: a top-level message of theirs opens no
 * report (it is somebody else speaking, so it still ends a reporter's run of
 * messages), and a reply of theirs in a reporter's thread is not part of the
 * report, so it is neither classified nor activity that holds the report
 * from settling. Only detection skips them: once the report is filed, every
 * reply of theirs in its threads — written before the filing or after — is
 * copied to its ticket like anyone's (`clerk/threads.ts`), because a team
 * member answering in the thread is context the ticket should carry.
 */
import { attachableFiles, type AttachableFile } from "./files";
import { compareTs, tsMs, type SlackMessage } from "./slack";

/**
 * Message subtypes that are somebody writing. Everything else — joins,
 * topic changes, another integration's posts — is channel furniture and never
 * a report. A `thread_broadcast` is a reply that was also sent to the channel:
 * it belongs to its thread, which already carries it.
 */
const WRITTEN = new Set<string | undefined>([undefined, "file_share", "me_message"]);

export interface Me {
  userId: string;
  botId: string | null;
}

export const isMine = (message: SlackMessage, me: Me): boolean =>
  (me.userId !== "" && message.user === me.userId) || (me.botId !== null && message.bot_id === me.botId);

/** Whether a top-level message can open or join a report. */
export const isWritten = (message: SlackMessage, me: Me): boolean =>
  !isMine(message, me) &&
  typeof message.user === "string" &&
  message.user !== "" &&
  WRITTEN.has(message.subtype) &&
  (message.thread_ts === undefined || message.thread_ts === message.ts);

export interface ReportMessage {
  ts: string;
  user: string;
  text: string;
  /** Permalinks of the files attached to it, every one of them. */
  files: string[];
  /**
   * Those of its files the clerk copies onto the ticket (`clerk/files.ts`).
   * Absent from a batch stored before files were attached, whose files are
   * linked as they were then.
   */
  attachments?: AttachableFile[];
  /** A reply in a thread, rather than a top-level message. */
  reply: boolean;
  permalink: string;
}

export interface Report {
  /** The ts of its first top-level message: the report's identity everywhere. */
  id: string;
  author: string;
  /** The top-level messages it was joined from, in order. */
  roots: string[];
  /** Every message of it, the threads' replies included, oldest first. */
  messages: ReportMessage[];
  /** The newest message of it, the thread included: what the settle window counts from. */
  lastActivity: string;
  permalink: string;
}

/** A message's link, from the workspace URL `auth.test` reports. */
export function permalink(workspaceUrl: string, channel: string, ts: string, threadTs?: string): string {
  const base = workspaceUrl.endsWith("/") ? workspaceUrl : `${workspaceUrl}/`;
  const link = `${base}archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs !== undefined && threadTs !== ts ? `${link}?thread_ts=${threadTs}&cid=${channel}` : link;
}

export interface GroupInput {
  /** Top-level messages, oldest first. */
  topLevel: readonly SlackMessage[];
  /** Each thread by its parent's ts, parent first. */
  threads: ReadonlyMap<string, readonly SlackMessage[]>;
  me: Me;
  channel: string;
  workspaceUrl: string;
  joinMinutes: number;
  /** `clerk.ignoreUsers`: whose messages are never part of a report. */
  ignore?: ReadonlySet<string>;
}

/** The channel's top-level messages grouped into reports, oldest first. */
export function groupReports(input: GroupInput): Report[] {
  const { me, channel, workspaceUrl } = input;
  const ignored = (message: SlackMessage): boolean => input.ignore !== undefined && typeof message.user === "string" && input.ignore.has(message.user);
  const joinMs = input.joinMinutes * 60_000;
  const reports: Report[] = [];
  let open: Report | null = null;
  let lastRoot: string | null = null;
  const toMessage = (message: SlackMessage, reply: boolean, threadTs?: string): ReportMessage => ({
    ts: message.ts,
    user: message.user ?? "",
    text: message.text ?? "",
    files: (message.files ?? []).map((file) => file.permalink).filter((link): link is string => typeof link === "string" && link !== ""),
    ...(attachableFiles(message.files).length === 0 ? {} : { attachments: attachableFiles(message.files) }),
    reply,
    permalink: permalink(workspaceUrl, channel, message.ts, threadTs),
  });

  for (const message of input.topLevel) {
    if (!isWritten(message, me) || ignored(message)) {
      // Anything else between two of one author's messages breaks the run:
      // "consecutive" means nobody else spoke in between. A reply broadcast to
      // the channel is not somebody speaking at the top level — its thread
      // carries it — and the clerk's own messages are not a reporter's.
      if (!isMine(message, me) && message.subtype !== "thread_broadcast") {
        open = null;
        lastRoot = null;
      }
      continue;
    }
    const author = message.user!;
    const joins = open !== null && open.author === author && lastRoot !== null && tsMs(message.ts) - tsMs(lastRoot) <= joinMs;
    if (!joins) {
      open = { id: message.ts, author, roots: [], messages: [], lastActivity: message.ts, permalink: permalink(workspaceUrl, channel, message.ts) };
      reports.push(open);
    }
    const report = open!;
    report.roots.push(message.ts);
    report.messages.push(toMessage(message, false));
    for (const reply of input.threads.get(message.ts) ?? []) {
      if (reply.ts === message.ts || isMine(reply, me) || ignored(reply)) continue;
      if (reply.subtype !== undefined && !WRITTEN.has(reply.subtype) && reply.subtype !== "thread_broadcast") continue;
      report.messages.push(toMessage(reply, true, message.ts));
    }
    lastRoot = message.ts;
  }
  for (const report of reports) {
    report.messages.sort((a, b) => compareTs(a.ts, b.ts));
    report.lastActivity = report.messages.reduce((newest, message) => (compareTs(message.ts, newest) > 0 ? message.ts : newest), report.id);
  }
  return reports;
}

/** Whether nothing has happened on `report` for the settle window. */
export const settled = (report: Report, nowMs: number, settleMinutes: number): boolean =>
  nowMs - tsMs(report.lastActivity) >= settleMinutes * 60_000;

/**
 * Where the cursor may move to: the newest top-level message such that every
 * message up to it is either no report at all or part of a processed one.
 *
 * The cursor is what makes a restart neither skip nor re-file: everything at or
 * before it is done, and history is read from just after it. It stops at the
 * first report that is not processed — an unsettled one, or one whose filing
 * failed — however many processed reports follow, so a crash or an outage
 * leaves it where nothing past it is lost. The processed reports beyond it are
 * remembered by id (`isProcessed`), which is why they are not filed twice when
 * the read starts before them again.
 */
export function advanceCursor(
  cursor: string,
  topLevel: readonly SlackMessage[],
  reports: readonly Report[],
  isProcessed: (reportId: string) => boolean,
): string {
  const owner = new Map<string, string>();
  for (const report of reports) for (const root of report.roots) owner.set(root, report.id);
  let next = cursor;
  for (const message of topLevel) {
    if (compareTs(message.ts, cursor) <= 0) continue;
    const id = owner.get(message.ts);
    if (id !== undefined && !isProcessed(id)) break;
    next = message.ts;
  }
  return next;
}
