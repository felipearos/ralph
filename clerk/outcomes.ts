/**
 * The outcome scan on the clerk's Jira boards (felipearos/ralph#443, #450).
 *
 * A report is valuable once a person confirmed it and the work it became was
 * done; it is noise if that work was closed as won't do (`clerk/metrics.ts`
 * `outcomeOf`). The confirmation sweep (`clerk/confirm.ts`) records the first
 * half. This records the second: on every poll, after the sweep, it reads
 *
 * - the intake board's tickets in Jira's done category, other than the ones
 *   the sweep rejected or moved — those are a to-agent ticket the coder loops
 *   finished, or one a person closed straight off the board; and
 * - the OA tickets the sweep moved to-person tickets to, by their keys in
 *   batches (`key in (...)`), the least recently read first,
 *
 * and appends one `closed` event per ticket, with its resolution and status.
 * The store remembers the keys it recorded, so a rerun repeats no event.
 *
 * It only reads, so it runs in shadow too. It never throws out of a poll, and
 * never stops one: a Jira failure of any kind, a refused credential included,
 * is a note, and the scan is tried again on the next poll. The sweep is what
 * stops a live loop on a refused credential.
 *
 * A live clerk also tells the reporter: a confirmed ticket closed as done,
 * not as won't do, gets one reply in its Slack report's
 * thread (`resolvedReply`), so the person who reported it sees it paid off.
 * Done in Jira is not shipped: a loop that hands its PR to a person, or a
 * person who moves the ticket on review, closes it before the work is in. So
 * when the scan is handed the app repos' PRs (`clerk/pulls.ts`), the reply
 * waits until a merged PR names the ticket (its OA key or its intake key),
 * for up to `MERGE_WAIT_DAYS`. A ticket moved to the team's board is the
 * other way round: the team merges, then takes it through QA, so its OA
 * ticket stays open for days with the work already in. There the reply goes
 * out when the ticket reaches one of `clerk.jira.readyStatuses` ("LISTO PARA
 * QA"), the team's own word that it is delivered, with no PR to wait for;
 * the close that follows queues no second one. Only the live port carries the thread writer
 * the scan is handed, so shadow and quiet post nothing. The reply is queued in the store with the close, and
 * the thread is read for it before every post, so a kill between the post and
 * the save, or a rerun, posts it once; a Slack failure is a note, and the
 * reply is tried again on the next poll.
 */
import { clerkJira, type ClerkRules } from "../project-config";
import { MOVED_LABEL, INTAKE_LABEL, isPlaceholderKey } from "./apply";
import type { ThreadReplies } from "./apply";
import { ownsTicket, reportsByKey } from "./confirm";
import { JiraError, jqlString, type JiraClient, type JiraIssue } from "./jira";
import { pullsNaming, type PullRef, type PullsRead } from "./pulls";
import { DEFAULT_WONT_DO, type ClosedEvent, type MetricsEvent } from "./metrics";
import { withClerkStore, type OutcomesRecord, type PendingReply, type WatchedTicket } from "./store";

/** How many closed intake tickets one poll reads, most recently updated first. */
export const OUTCOMES_READ = 100;

/** How many moved OA tickets one poll reads, the least recently read first: the rest wait their turn. */
export const OA_PER_POLL = 100;

/** How many keys one `key in (...)` search names. */
export const OA_BATCH = 50;

/** How far back the intake board search looks, as the sweep's (`CONFIRM_WINDOW_DAYS`). */
export const OUTCOMES_WINDOW_DAYS = 90;

/** How long a recorded close is remembered: past the search's window, so nothing is recorded twice. */
export const RECORDED_KEEP_DAYS = 2 * OUTCOMES_WINDOW_DAYS;

/** How long a moved ticket is waited on before the scan gives up on it closing. */
export const WATCH_KEEP_DAYS = 365;

/** How many queued "resuelto" replies one poll posts, the oldest first: the rest wait their turn. */
export const REPLIES_PER_POLL = 20;

/** How long a queued reply is retried before the scan gives up on it: a week of Slack outage is past telling. */
export const REPLY_KEEP_DAYS = 7;

/** How long a closed ticket's reply waits for a merged PR to name it: a person's review can take weeks, not months. */
export const MERGE_WAIT_DAYS = 30;

/**
 * The reply a reporter gets in their report's thread once its work is done,
 * naming the ticket that closed: the OA key for a report moved to the team's
 * board, the intake key otherwise. Plain Spanish, no emoji, tagging nobody.
 */
export const resolvedReply = (key: string): string => `Resuelto: ${key} ya está listo. Gracias por reportarlo.`;

/** The reads the scan makes: all it is ever handed. */
export type OutcomesReader = Pick<JiraClient, "search">;

export interface OutcomesDeps {
  rules: ClerkRules;
  jira: OutcomesReader;
  storePath: string;
  now: () => number;
  /** Append one ledger event; false when it was lost. Absent, nothing is recorded. */
  ledger?: (event: MetricsEvent) => boolean;
  /**
   * The report threads' writer, which only the live port has (`clerk/gate.ts`
   * hands over `portFor(...).threads`). Absent — shadow, quiet, a test — no
   * reply is queued or posted.
   */
  threads?: ThreadReplies;
  /**
   * The app repos' PRs (`clerk/gate.ts` hands over the intake page's cached
   * read). Given, a reply waits for a merged PR naming its ticket. Absent —
   * no repos configured, a test — it goes out once the ticket closes.
   */
  pulls?: (nowMs: number) => Promise<PullsRead>;
}

/** A Slack report id is its first message's ts; a ticket filed by hand has its key standing in. */
const isSlackReport = (report: string): boolean => /^\d+\.\d+$/.test(report);

const WONT_DO = new Set(DEFAULT_WONT_DO.map((resolution) => resolution.trim().toLowerCase()));

/** Whether a close is work done, as `outcomeOf` counts it valuable: any resolution but a won't do. */
export const isDone = (resolution: string | null): boolean => resolution === null || !WONT_DO.has(resolution.trim().toLowerCase());

/**
 * The intake board's closed tickets the scan has not been told about some
 * other way: not rejected (already noise) and not moved (their OA ticket is
 * what closes).
 */
export const closedIntakeJql = (project: string, statuses: { rejected: string; moved: string }): string =>
  [
    `project = ${jqlString(project)}`,
    `labels = ${jqlString(INTAKE_LABEL)}`,
    "statusCategory = Done",
    `status not in (${jqlString(statuses.rejected)}, ${jqlString(statuses.moved)})`,
    `labels not in (${jqlString(MOVED_LABEL)})`,
    `updated >= -${OUTCOMES_WINDOW_DAYS}d`,
  ].join(" AND ") + " ORDER BY updated DESC";

/** The closed tickets among `keys`, and those at a ready status (`clerk.jira.readyStatuses`) when any is given. */
export const closedKeysJql = (keys: readonly string[], ready: readonly string[] = []): string =>
  `key in (${keys.map(jqlString).join(", ")}) AND ` + (ready.length === 0 ? "statusCategory = Done" : `(statusCategory = Done OR status in (${ready.map(jqlString).join(", ")}))`);

/**
 * One scan. Never throws: every failure is a note, and what it stopped on is
 * read again on the next poll.
 */
export async function scanOutcomes(deps: OutcomesDeps): Promise<string[]> {
  const notes: string[] = [];
  try {
    await scan(deps, notes);
  } catch (error) {
    // The store, or a defect: the scan is an observation, never a reason for the poll to fail.
    notes.push(`the outcome scan failed: ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`);
  }
  // Apart from the scan, so a Jira outage still lets a queued reply go out.
  if (deps.threads !== undefined) {
    try {
      await postReplies(deps, deps.threads, notes);
    } catch (error) {
      notes.push(`the resolved replies failed: ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`);
    }
  }
  return notes;
}

async function scan(deps: OutcomesDeps, notes: string[]): Promise<void> {
  const intake = clerkJira(deps.rules.jira);
  const project = intake.intakeProject;
  if (project === null) return;
  const nowIso = new Date(deps.now()).toISOString();

  // Bring the watch list up to date with what the sweep finished, and read
  // what the search needs, in one critical section.
  const { recorded, watched, reports } = await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
    const outcomes: OutcomesRecord = (store.outcomes ??= { recorded: {}, watched: {} });
    outcomes.recorded ??= {};
    outcomes.watched ??= {};
    const reports = reportsByKey(store);
    for (const [key, record] of Object.entries(store.confirmed ?? {})) {
      if (!record.done || record.outcome === "rejected") continue;
      const read = record.outcome === "to-agent" ? key : record.oaKey;
      if (read === undefined || isPlaceholderKey(read)) continue;
      if (Object.hasOwn(outcomes.watched, read) || Object.hasOwn(outcomes.recorded, read)) continue;
      outcomes.watched[read] = { report: reports[key] ?? key, intake: key, board: record.outcome === "to-agent" ? "intake" : "oa", since: nowIso };
    }
    prune(outcomes, deps.now());
    return { recorded: structuredClone(outcomes.recorded), watched: structuredClone(outcomes.watched), reports };
  });

  /** `confirmed`: a person confirmed it, so its close counts — the watched tickets. `told`: a merged PR already queued its reply. */
  const closes: { ticket: JiraIssue; report: string; intake: string; oa: boolean; confirmed: boolean; told?: boolean }[] = [];

  // The intake board: one search, newest first.
  try {
    const found = await deps.jira.search(closedIntakeJql(project, intake.statuses), OUTCOMES_READ);
    for (const ticket of found) {
      if (Object.hasOwn(recorded, ticket.key)) continue;
      // Another channel's loop records its own tickets' closes (`ownsTicket`).
      if (!ownsTicket(ticket, deps.rules.channel, { ...reports, ...watched })) continue;
      // A ticket filed by hand has no report: its key stands in, as the sweep's does.
      const report = watched[ticket.key]?.report ?? reports[ticket.key] ?? ticket.key;
      closes.push({ ticket, report, intake: ticket.key, oa: false, confirmed: Object.hasOwn(watched, ticket.key) });
    }
  } catch (error) {
    notes.push(failureNote(error, `the intake board ${project} could not be searched for closed tickets`));
  }

  // The OA tickets moved there, in turn.
  const due = Object.entries(watched)
    .filter(([key, entry]) => entry.board === "oa" && entry.gone !== true && !Object.hasOwn(recorded, key))
    .sort(([a, one], [b, other]) => (one.checkedAt ?? "").localeCompare(other.checkedAt ?? "") || a.localeCompare(b))
    .slice(0, OA_PER_POLL);
  const checked: string[] = [];
  const gone: string[] = [];
  /** Moved tickets at a ready status, not closed: their reply is owed now, their close later. */
  const ready: { key: string; report: string; intake: string }[] = [];
  for (let at = 0; at < due.length; at += OA_BATCH) {
    const batch = due.slice(at, at + OA_BATCH);
    const keys = batch.map(([key]) => key);
    const read = await readBatch(deps.jira, keys, deps.rules.jira.project, intake.readyStatuses, notes);
    if (read === null) break;
    checked.push(...read.checked);
    gone.push(...read.gone);
    for (const ticket of read.closed) {
      const entry = watched[ticket.key];
      if (entry === undefined) continue;
      if (ticket.statusCategory !== "done") {
        if (entry.told !== true) ready.push({ key: ticket.key, report: entry.report, intake: entry.intake });
        continue;
      }
      closes.push({ ticket, report: entry.report, intake: entry.intake, oa: true, confirmed: true, told: entry.told === true });
    }
  }

  if (closes.length === 0 && checked.length === 0 && gone.length === 0 && ready.length === 0) return;
  // Saved before the events are written, as the apply and the sweep do: a
  // kill in between costs the lines, never a second one.
  await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
    const outcomes: OutcomesRecord = (store.outcomes ??= { recorded: {}, watched: {} });
    for (const key of checked) if (outcomes.watched[key]) outcomes.watched[key]!.checkedAt = nowIso;
    for (const key of gone) if (outcomes.watched[key]) outcomes.watched[key]!.gone = true;
    // Told at the ready status, with no merge to wait for: the team says it is delivered.
    if (deps.threads !== undefined) {
      for (const one of ready) {
        const entry = outcomes.watched[one.key];
        if (entry === undefined || entry.told === true || !isSlackReport(one.report)) continue;
        (outcomes.replies ??= {})[one.key] = { report: one.report, since: nowIso, intake: one.intake, ready: true };
        entry.told = true;
      }
    }
    for (const close of closes) {
      outcomes.recorded[close.ticket.key] = { at: nowIso, report: close.report };
      delete outcomes.watched[close.ticket.key];
      // Queued with the close, in the same save: recorded, it is never read
      // again, so a reply not queued here would never be.
      if (deps.threads !== undefined && close.confirmed && close.told !== true && isDone(close.ticket.resolution) && isSlackReport(close.report)) {
        (outcomes.replies ??= {})[close.ticket.key] = { report: close.report, since: nowIso, ...(close.oa ? { intake: close.intake } : {}) };
      }
    }
  });

  let lost = 0;
  for (const close of closes) {
    const event: ClosedEvent = {
      v: 1,
      at: nowIso,
      kind: "closed",
      report: close.report,
      key: close.intake,
      mode: deps.rules.mode,
      resolution: close.ticket.resolution,
      status: close.ticket.status,
      ...(close.oa ? { oaKey: close.ticket.key } : {}),
    };
    notes.push(`${close.ticket.key} closed in '${close.ticket.status}'${close.ticket.resolution === null ? "" : ` as '${close.ticket.resolution}'`}: recorded`);
    if (deps.ledger === undefined) continue;
    let written = false;
    try {
      written = deps.ledger(event);
    } catch {}
    if (!written) lost += 1;
  }
  if (lost > 0) notes.push(`the intake metrics ledger could not be written: ${lost} event${lost === 1 ? "" : "s"} lost`);
}

/**
 * Post the queued "resuelto" replies, the oldest first, each once its work is
 * merged (`mergedAt`). The thread is read before each post, so one a kill
 * left posted and still queued is only dropped. A Slack failure stops the
 * round with a note: the rest are tried again on the next poll, until
 * `REPLY_KEEP_DAYS` after the merge gives up on them. A reply no merged PR
 * names waits, and is given up on after `MERGE_WAIT_DAYS`. One queued at a
 * ready status waits for no PR.
 */
async function postReplies(deps: OutcomesDeps, threads: ThreadReplies, notes: string[]): Promise<void> {
  const nowMs = deps.now();
  const merged = await mergedAt(deps, nowMs, notes);
  const { due, expired } = await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
    const replies: Record<string, PendingReply> = store.outcomes?.replies ?? {};
    const expired: { key: string; entry: PendingReply; why: string }[] = [];
    const ready: [string, PendingReply][] = [];
    for (const [key, entry] of Object.entries(replies)) {
      const since = Date.parse(entry.since);
      const at = merged(key, entry);
      if (at === null) {
        if (nowMs - since > MERGE_WAIT_DAYS * 86_400_000) expired.push({ key, entry, why: `: no merged PR named it in ${MERGE_WAIT_DAYS} days` });
      } else if (nowMs - Math.max(since, at) > REPLY_KEEP_DAYS * 86_400_000) {
        expired.push({ key, entry, why: ` after ${REPLY_KEEP_DAYS} days` });
      } else {
        ready.push([key, entry]);
      }
    }
    for (const { key } of expired) delete replies[key];
    const due = ready.sort(([a, one], [b, other]) => one.since.localeCompare(other.since) || a.localeCompare(b)).slice(0, REPLIES_PER_POLL);
    return { due, expired };
  });
  for (const { key, entry, why } of expired) notes.push(`${key}: gave up on telling report ${entry.report} it is resolved${why}`);
  const done = (key: string): Promise<void> =>
    withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      if (store.outcomes?.replies) delete store.outcomes.replies[key];
    });
  for (const [key, entry] of due) {
    const text = resolvedReply(key);
    try {
      if (!(await threads.hasReply(entry.report, text))) {
        await threads.reply(entry.report, text);
        notes.push(`${key}: told report ${entry.report} in its thread that it is resolved`);
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      notes.push(`${key}: the resolved reply in report ${entry.report}'s thread could not be posted: ${why}; tried again at the next poll`);
      return;
    }
    await done(key);
  }
}

/**
 * When a queued reply's work was merged (ms), or null while no merged PR
 * names its ticket. Without `deps.pulls` every reply counts as merged when it
 * was queued. A PR read that fails leaves the replies waiting, never posted
 * early: the read is tried again on the next poll.
 */
async function mergedAt(deps: OutcomesDeps, nowMs: number, notes: string[]): Promise<(key: string, entry: PendingReply) => number | null> {
  const queued = (entry: PendingReply): number => Date.parse(entry.since);
  if (deps.pulls === undefined) return (_key, entry) => queued(entry);
  let pulls: PullRef[] = [];
  try {
    const read = await deps.pulls(nowMs);
    pulls = read.pulls;
    if (read.note !== null) notes.push(read.note);
  } catch (error) {
    notes.push(`the resolved replies wait: pull requests not read — ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`);
  }
  const merges = pulls.filter((pull) => pull.state === "mergeado");
  return (key, entry) => {
    if (entry.ready === true) return queued(entry);
    const named = pullsNaming(merges, entry.intake === undefined ? [key] : [key, entry.intake]);
    if (named.length === 0) return null;
    const at = Date.parse(named[named.length - 1]!.at ?? "");
    return Number.isNaN(at) ? nowMs : at;
  };
}

interface BatchRead {
  /** Closed, or at a ready status: `statusCategory` tells them apart. */
  closed: JiraIssue[];
  /** Every key Jira answered for, closed or not. */
  checked: string[];
  /** Keys Jira says do not exist. */
  gone: string[];
}

/**
 * Read one batch of OA keys. Jira refuses a whole `key in (...)` search when
 * any one key does not exist, so a refused batch is read key by key, and a
 * key refused alone is gone. Null when the board could not be read at all:
 * the rest of the scan waits for the next poll.
 */
async function readBatch(jira: OutcomesReader, keys: readonly string[], project: string, ready: readonly string[], notes: string[]): Promise<BatchRead | null> {
  try {
    return { closed: await jira.search(closedKeysJql(keys, ready), keys.length), checked: [...keys], gone: [] };
  } catch (error) {
    if (!isRefusedQuery(error)) {
      notes.push(failureNote(error, `${project} could not be searched for the moved tickets' closes`));
      return null;
    }
  }
  const out: BatchRead = { closed: [], checked: [], gone: [] };
  for (const key of keys) {
    try {
      out.closed.push(...(await jira.search(closedKeysJql([key], ready), 1)));
      out.checked.push(key);
    } catch (error) {
      if (!isRefusedQuery(error)) {
        notes.push(failureNote(error, `${project} could not be searched for the moved tickets' closes`));
        return out;
      }
      out.gone.push(key);
      notes.push(`${key} is not on ${project} any more: its close is not watched for`);
    }
  }
  return out;
}

/** A 400: Jira refused the query itself, most often for a key it does not have. */
const isRefusedQuery = (error: unknown): boolean =>
  error instanceof JiraError && error.failure.kind === "denied" && error.failure.code === "jira_bad_request";

function failureNote(error: unknown, what: string): string {
  const why = error instanceof JiraError ? error.failure.why : error instanceof Error ? error.message : String(error);
  return `${what}: ${why}; tried again at the next poll`;
}

/** Forget recorded closes past their window, and moved tickets that never closed. */
function prune(outcomes: OutcomesRecord, nowMs: number): void {
  for (const [key, entry] of Object.entries(outcomes.recorded)) {
    if (nowMs - Date.parse(entry.at) > RECORDED_KEEP_DAYS * 86_400_000) delete outcomes.recorded[key];
  }
  for (const [key, entry] of Object.entries(outcomes.watched) as [string, WatchedTicket][]) {
    if (nowMs - Date.parse(entry.since) > WATCH_KEEP_DAYS * 86_400_000) delete outcomes.watched[key];
  }
}
