/**
 * The notification feed and the audit history: pure projections of the
 * records a loop's checkout already keeps.
 *
 * Nothing here reads a file or keeps state. `records-adapter.ts` hands over
 * what it read — the text of each record, or why there is none — and these
 * functions narrow it to the dashboard's view models. Neither view is a record
 * of its own: the feed is `.ralph/logs/notifications.jsonl` as the loop wrote
 * it, and the history is the command inbox's settled files, the Stop now audit
 * and the plugin doctor's record, merged by time.
 *
 * Every record may be missing, truncated or not what it should be. A line that
 * is not an entry is skipped; a record that cannot be read is a `problem` on
 * the view, never an exception, so neither view can fail the page.
 */
import {
  INTERRUPT_CHECKS,
  type DeliveryView,
  type HistoryEntryView,
  type HistorySource,
  type HistoryView,
  type InterruptCheckName,
  type InterruptSignal,
  type NotificationFeed,
  type NotificationView,
  type NotificationsView,
  type RecordProblem,
} from "./contracts";

/** One record as the adapter found it. */
export type RawFile = { state: "missing" } | { state: "unreadable"; why: string } | { state: "read"; text: string };

/** One command file from the inbox (`pending`) or from the settled ones beside its outcome. */
export interface RawCommandFile {
  stem: string;
  pending: boolean;
  /** The file's modification time: when a command names no time of its own. */
  modifiedAt: string | null;
  command: RawFile;
  outcome: RawFile;
}

export interface RawFeed {
  feed: RawFile;
  readMark: RawFile;
}

export interface RawHistory {
  commands: { state: "missing" } | { state: "unreadable"; why: string } | { state: "read"; files: RawCommandFile[] };
  signals: RawFile;
  repairs: RawFile;
}

/** How many alerts a loop's feed shows, and how many the merged feed does. */
export const FEED_LIMIT = 100;
export const RECENT_LIMIT = 50;
/** How many history entries a loop shows. */
export const HISTORY_LIMIT = 100;

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const timeOf = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};
const newestFirst = <T extends { at: string }>(a: T, b: T): number => timeOf(b.at) - timeOf(a.at);

/** Each line of a JSON-lines record that is a JSON object, in order. */
function rowsOf(raw: string): Row[] {
  return raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      return isRow(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function jsonOf(file: RawFile): Row | null {
  if (file.state !== "read") return null;
  try {
    const value: unknown = JSON.parse(file.text);
    return isRow(value) ? value : null;
  } catch {
    return null;
  }
}

function problemOf(file: { state: "missing" } | { state: "unreadable"; why: string }, what: string): RecordProblem {
  return file.state === "missing"
    ? { kind: "missing", detail: `no ${what} has been recorded yet` }
    : { kind: "unreadable", detail: `the ${what} could not be read: ${file.why}` };
}

/* --------------------------------------------------------------- the feed */

const NOT_ANSWERED = "no answer was recorded";
const deliveryKey = (id: string, channel: string, name: string): string => `${id}\u0000${channel}\u0000${name}`;

/** How a plugin took an alert, from its last recorded answer. */
function pluginDelivery(name: string, answer: Row | undefined): DeliveryView {
  if (answer === undefined) return { channel: "plugin", name, state: "unconfirmed", why: NOT_ANSWERED, at: null };
  const state = answer.ok === true ? "delivered" : answer.ran === false ? "skipped" : "failed";
  return { channel: "plugin", name, state, why: state === "delivered" ? null : (text(answer.why) ?? "the plugin gave no reason"), at: text(answer.at) };
}

const COMMENT_STATES: Record<string, DeliveryView["state"]> = {
  posted: "delivered",
  capped: "skipped",
  unheld: "skipped",
  unavailable: "failed",
  ambiguous: "unconfirmed",
};

/** The ticket comment, when the alert had a ticket to comment on. */
function githubDelivery(github: unknown, ticket: number | null, answer: Row | undefined): DeliveryView | null {
  if (github === "unheld") {
    return {
      channel: "github",
      name: "github",
      state: "skipped",
      why: `the run held no live claim on ${ticket === null ? "the ticket" : `#${ticket}`} when the alert was raised`,
      at: null,
    };
  }
  if (github !== "eligible") return null;
  if (answer === undefined) return { channel: "github", name: "github", state: "unconfirmed", why: NOT_ANSWERED, at: null };
  const state = COMMENT_STATES[String(answer.outcome)] ?? (answer.ok === true ? "delivered" : "failed");
  return { channel: "github", name: "github", state, why: state === "delivered" ? null : text(answer.why), at: text(answer.at) };
}

function readThroughOf(file: RawFile): string | null {
  const mark = jsonOf(file);
  const through = mark === null ? null : text(mark.readThrough);
  return through !== null && !Number.isNaN(Date.parse(through)) ? through : null;
}

/**
 * The times one kind of alert was RAISED in a feed, newest first, with no cap.
 *
 * `notificationFeed` below is the page's projection and keeps only the
 * `FEED_LIMIT` newest alerts of every kind together, which is right for a
 * panel and wrong for counting: a loop chatty enough to raise a hundred other
 * alerts would hide its own restart records, and the reconciler's bound is
 * counted from exactly those (`reconcile.ts`). `null` is "the record could not
 * be read", which a counter must not confuse with none.
 */
export function raisedAt(feed: RawFile, kind: string): string[] | null {
  return raisedRows(feed, kind)?.map((row) => row.at) ?? null;
}

/**
 * `raisedAt` with each alert's `retry` payload beside its time, for the retry
 * view (`reconcile.ts`). The payload is passed through raw: what counts as a
 * well-formed one is the caller's rule, not the feed's.
 */
export function raisedRows(feed: RawFile, kind: string): { id: string; at: string; retry: unknown }[] | null {
  if (feed.state === "unreadable") return null;
  if (feed.state !== "read") return [];
  const seen = new Map<string, { id: string; at: string; retry: unknown }>();
  for (const row of rowsOf(feed.text)) {
    const id = text(row.id);
    const at = text(row.at);
    if (row.event !== "raised" || id === null || at === null || text(row.kind) !== kind) continue;
    // One alert may be written twice (an `unsent` line and the sender's); it
    // keeps the first time, as `notificationFeed` does.
    if (!seen.has(id)) seen.set(id, { id, at, retry: row.retry });
  }
  return [...seen.values()].sort(newestFirst);
}

/** One loop's feed: its alerts newest first, how each channel took them, and which are read. */
export function notificationFeed(loop: string, raw: RawFeed): NotificationFeed {
  const readThrough = readThroughOf(raw.readMark);
  if (raw.feed.state !== "read") {
    return { loop, notifications: [], unread: 0, readThrough, problem: problemOf(raw.feed, "notification feed") };
  }
  const rows = rowsOf(raw.feed.text);
  const answers = new Map<string, Row>();
  for (const row of rows) {
    const id = text(row.id);
    const name = text(row.name);
    if (row.event !== "delivery" || id === null || name === null) continue;
    // The last answer for a channel is the one that stands.
    answers.set(deliveryKey(id, String(row.channel), name), row);
  }
  // An alert is raised once, but may be written more than once: an `unsent`
  // line when the record could not be claimed (or pushes were off), and the
  // line of the sender that claimed it, in either order. It keeps the first
  // time, and the claimed line's channels whenever there is one.
  const firstAt = new Map<string, string>();
  const raised = new Map<string, Row>();
  for (const row of rows) {
    const id = text(row.id);
    const at = text(row.at);
    if (row.event !== "raised" || id === null || at === null || text(row.kind) === null) continue;
    if (!firstAt.has(id)) firstAt.set(id, at);
    const kept = raised.get(id);
    if (kept === undefined || text(kept.unsent) !== null) raised.set(id, row);
  }
  const notifications: NotificationView[] = [];
  for (const [id, row] of raised) {
    const at = firstAt.get(id)!;
    const kind = text(row.kind)!;
    const ticket = positive(row.ticket);
    const plugins = Array.isArray(row.plugins) ? row.plugins.filter((name): name is string => text(name) !== null) : [];
    const deliveries: DeliveryView[] = plugins.map((name) => pluginDelivery(name, answers.get(deliveryKey(id, "plugin", name))));
    const comment = githubDelivery(row.github, ticket, answers.get(deliveryKey(id, "github", "github")));
    if (comment !== null) deliveries.push(comment);
    notifications.push({
      id,
      loop,
      run: text(row.run),
      kind,
      subject: text(row.subject) ?? kind,
      body: typeof row.body === "string" ? row.body : "",
      priority: row.priority === "high" ? "high" : "normal",
      ticket,
      iteration: positive(row.iteration),
      at,
      read: readThrough !== null && timeOf(at) <= timeOf(readThrough),
      deliveries,
      unsent: text(row.unsent),
    });
  }
  const shown = notifications.sort(newestFirst).slice(0, FEED_LIMIT);
  return { loop, notifications: shown, unread: shown.filter((entry) => !entry.read).length, readThrough, problem: null };
}

/** Every loop's feed, and the newest alerts across all of them. */
export function mergeFeeds(loops: NotificationFeed[], generatedAt: string): NotificationsView {
  const recent = loops
    .flatMap((feed) => feed.notifications)
    .sort(newestFirst)
    .slice(0, RECENT_LIMIT);
  return { generatedAt, loops, recent, unread: loops.reduce((sum, feed) => sum + feed.unread, 0) };
}

/* ------------------------------------------------------------ the history */

const blankEntry = (source: HistorySource, id: string, at: string, action: string, outcome: string): HistoryEntryView => ({
  source,
  id,
  at,
  action,
  outcome,
  detail: null,
  reason: null,
  run: null,
  via: null,
  issue: null,
  failedCheck: null,
  signals: [],
});

function commandEntry(file: RawCommandFile): HistoryEntryView | null {
  const command = jsonOf(file.command);
  if (command === null) return settledUnreadable(file);
  // A command may arrive as `{"control": {…}}`, the shape a plugin or a hand may write.
  const body = isRow(command.control) ? command.control : command;
  const action = text(body.command);
  if (action === null) return settledUnreadable(file);
  const outcome = file.pending ? null : jsonOf(file.outcome);
  const at = text(body.issuedAt) ?? (outcome === null ? null : text(outcome.at)) ?? file.modifiedAt;
  if (at === null) return null;
  const entry = blankEntry(
    "command",
    text(body.id) ?? file.stem,
    at,
    action,
    file.pending ? "pending" : (outcome === null ? null : text(outcome.outcome)) ?? "unknown",
  );
  entry.detail = file.pending
    ? "waiting in the inbox for the loop's next poll"
    : outcome === null
      ? "settled, and its outcome file could not be read"
      : text(outcome.why);
  entry.reason = text(body.why);
  entry.run = text(body.run) ?? text(body.ralphRun);
  entry.via = text(body.via) ?? text(command.via);
  entry.issue = positive(body.issue);
  return entry;
}

/**
 * A file the loop settled without a command it could read (`malformed`, or not
 * a control command): the outcome file is still a recorded answer, so it is
 * listed. A file with neither is not an entry.
 */
function settledUnreadable(file: RawCommandFile): HistoryEntryView | null {
  const outcome = file.pending ? null : jsonOf(file.outcome);
  const recorded = outcome === null ? null : text(outcome.outcome);
  const at = (outcome === null ? null : text(outcome.at)) ?? file.modifiedAt;
  if (outcome === null || recorded === null || at === null) return null;
  const entry = blankEntry("command", text(outcome.key) ?? file.stem, at, text(outcome.command) ?? "unreadable command", recorded);
  entry.detail = text(outcome.why);
  return entry;
}

const isCheck = (value: unknown): value is InterruptCheckName =>
  typeof value === "string" && (INTERRUPT_CHECKS as readonly string[]).includes(value);
const isSignal = (value: unknown): value is InterruptSignal => value === "SIGTERM" || value === "SIGKILL";

/** Each Stop now attempt: the lines that share its id, folded into one entry. */
function signalEntries(raw: string): HistoryEntryView[] {
  const attempts = new Map<string, Row[]>();
  for (const row of rowsOf(raw)) {
    const id = text(row.id);
    if (id === null || text(row.at) === null) continue;
    attempts.set(id, [...(attempts.get(id) ?? []), row]);
  }
  return [...attempts].map(([id, rows]) => {
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const ended = [...rows].reverse().find((row) => text(row.outcome) !== null);
    const entry = blankEntry("signal", id, text(first.at)!, "stop-now", ended === undefined ? "pending" : text(ended.outcome)!);
    entry.detail = ended === undefined ? `signalled; no outcome was recorded (${text(last.detail) ?? "no detail"})` : text(ended.detail);
    entry.reason = text(first.reason);
    entry.run = text(first.run);
    entry.via = text(first.via);
    entry.signals = rows.filter((row) => row.event === "signal" && isSignal(row.signal)).map((row) => row.signal as InterruptSignal);
    const checks = Array.isArray(last.checks) ? last.checks.filter(isRow) : [];
    const failed = checks.find((check) => check.ok === false);
    entry.failedCheck = failed !== undefined && isCheck(failed.check) ? failed.check : null;
    return entry;
  });
}

/** The plugin doctor's repairs and Fix alls. Diagnoses are the Fix panel's, not an operator's act. */
function repairEntries(raw: string): HistoryEntryView[] {
  return rowsOf(raw).flatMap((row, index) => {
    const at = text(row.at);
    const plugin = text(row.plugin);
    if (at === null || plugin === null || (row.kind !== "repair" && row.kind !== "fix-all")) return [];
    const check = text(row.check);
    const action = row.kind === "fix-all" ? `${plugin} fix all` : `${plugin}${check === null ? "" : ` ${check}`}: ${text(row.action) ?? "repair"}`;
    const entry = blankEntry("repair", `${plugin}-${index}`, at, action, text(row.result) ?? "unknown");
    entry.detail = text(row.why);
    entry.run = text(row.run);
    entry.via = text(row.via);
    return [entry];
  });
}

/** A loop's audit history: every command, Stop now and repair, newest first. */
export function historyView(loop: string, raw: RawHistory, generatedAt: string): HistoryView {
  const problems: HistoryView["problems"] = [];
  const entries: HistoryEntryView[] = [];

  if (raw.commands.state === "read") {
    entries.push(...raw.commands.files.flatMap((file) => commandEntry(file) ?? []));
  } else {
    problems.push({ source: "command", problem: problemOf(raw.commands, "command record") });
  }
  if (raw.signals.state === "read") entries.push(...signalEntries(raw.signals.text));
  else problems.push({ source: "signal", problem: problemOf(raw.signals, "Stop now audit") });
  if (raw.repairs.state === "read") entries.push(...repairEntries(raw.repairs.text));
  else problems.push({ source: "repair", problem: problemOf(raw.repairs, "repair history") });

  return { loop, generatedAt, entries: entries.sort(newestFirst).slice(0, HISTORY_LIMIT), problems };
}
