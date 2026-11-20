/**
 * The clerk's store: what one clerk loop has read and handed over, durable
 * across restarts (felipearos/ralph#315).
 *
 * It lives in Git's common directory (`<git-common-dir>/ralph/clerk/<loop>.json`),
 * beside the claim, host-lease and ci-health stores, so it survives the loop's
 * worktree being recreated. Per loop, because a clerk is one loop on one
 * channel and nothing else writes it.
 *
 * Unlike the ci-health store it is NOT a cache. The cursor is what keeps a
 * restart from re-reading the channel's whole history, and the processed map
 * is what keeps a report from being handed over twice. A lost store is still
 * not a duplicate ticket — before every create the apply asks Jira for the
 * report's permalink — but it is a re-read, so an unreadable file is reported
 * rather than silently replaced: the gate starts from "now" and says so.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { emptyShadow, type Progress, type ShadowRecord } from "./apply";
import type { CodeContextApp } from "../project-config";
import type { AttachableFile } from "./files";
import type { App, Assignee, BatchReport, Difficulty, IssueType, Priority, StoryPoints } from "./plan";

export const CLERK_STORE_VERSION = 1 as const;

/** Under the common dir, beside the other role stores. */
export const clerkStoreRelativePath = (loop: string): string => `ralph/clerk/${loop}.json`;

/** What became of a report. Only `handed` is still open. */
export type ReportState = "handed" | "filed" | "commented" | "ignored";

export interface ProcessedReport {
  state: Exclude<ReportState, "handed">;
  /** The Jira key it was filed as or commented on (a `SHADOW-…` key in shadow), or null when ignored. */
  key: string | null;
  at: string;
  /** What became of it, one line, for the batch's journal entry. */
  line?: string;
  /** The top-level messages it was joined from: the threads watched for replies after it was processed. */
  roots?: string[];
  /** The newest reply in its threads already dealt with — copied to its ticket, or seen on an ignored report. */
  copiedThrough?: string;
  /**
   * Replies older than `copiedThrough` may still be owed to the ticket: a
   * filed report is watched from its first root, because a team member's
   * reply written before it was filed is in no ticket yet. These are the
   * replies that ARE already in what was filed — the report's own — and are
   * skipped rather than copied twice. Dropped once the watch is past them all.
   */
  inTicket?: string[];
  /** The OA key its intake ticket moved to, once seen: its thread's replies are copied there from then on. */
  movedTo?: string;
  /**
   * Its follow-up messages whose grouping reply ("Agregado al reporte de
   * arriba") failed to post: retried each live poll, and dropped once posted
   * or once the thread is no longer watched.
   */
  pendingFollowUps?: string[];
}

/** An ignored report a person asked to have filed: handed over again, with that person's name as the hint. */
export interface Reopened {
  /** Who asked, by Slack user id. */
  by: string;
  at: string;
  roots: string[];
  /** What it was before it was re-opened: restored if it cannot be handed over again. */
  outcome?: ProcessedReport;
}

/**
 * The batch the gate last handed to an iteration, kept whole so the session
 * reads exactly what the gate saw — and kept whole while it is applied, so the
 * plan is validated against the batch it was written for even after some of
 * its reports are done.
 */
export interface Batch {
  id: string;
  handedAt: string;
  /** How many times this batch has been handed over; a second invalid plan falls back. */
  attempt: number;
  reports: BatchReport[];
  /** Why the previous attempt's plan was refused, for the session to fix. */
  problems?: string[];
  /** Hand-overs in a row that ended with no plan written at all: a session that never ran. */
  misses?: number;
  /**
   * An HMAC of the batch's reports, keyed with a credential only the gate
   * holds. The store sits on a disk the session can write, and the candidates
   * in it are the boundary of what a report may be merged into; a batch whose
   * MAC no longer matches was changed after the gate handed it over.
   */
  mac?: string;
}

/**
 * The canvas the gate rebuilds, and when it last did.
 *
 * `id` is set only once the gate has created a canvas — the configured one was
 * gone, or none was configured — and is used for as long as the config still
 * names `configured`: a recreated canvas keeps receiving the rebuilds, while an
 * operator who points the config at another canvas is followed at once.
 */
export interface CanvasState {
  /** The canvas the gate created, or null while the configured one is in use. */
  id: string | null;
  /** The configured canvas `id` stands in for (null when none was configured). */
  configured: string | null;
  /** When the canvas was last replaced, or null before the first rebuild. */
  rebuiltAt: string | null;
  /**
   * When a live rebuild last failed (felipearos/ralph#322). A live rebuild
   * reads Jira, so a failing one waits the rebuild interval rather than
   * spending those reads again on every poll.
   */
  triedAt?: string | null;
}

export const emptyCanvas = (): CanvasState => ({ id: null, configured: null, rebuiltAt: null });

export interface ClerkStore {
  version: typeof CLERK_STORE_VERSION;
  /** The channel this store reads; a store for another channel is not this one's history. */
  channel: string;
  /** Every top-level message at or before this Slack ts is done with. Empty until the first poll. */
  cursor: string;
  /** Reports past the cursor that are done with, by report id. */
  processed: Record<string, ProcessedReport>;
  batch: Batch | null;
  /** How far each report being applied has got, by report id; dropped once it is processed. */
  progress: Record<string, Progress>;
  /** What shadow applies recorded: would-be tickets and intended writes. */
  shadow: ShadowRecord;
  /** Applies that failed in a row; three raise an alert (felipearos/ralph#320). */
  failures?: number;
  /** The canvas this loop rebuilds. Absent from a store written before felipearos/ralph#319, hence the default on read. */
  canvas: CanvasState;
  /** Ignored reports a person asked to have filed, by report id (felipearos/ralph#323). */
  reopened?: Record<string, Reopened>;
  /**
   * What the clerk determined for each ticket it filed, by ticket key
   * (felipearos/ralph#447): the snapshot a confirmation is compared against,
   * so a person's change of a field is told from the clerk's own value.
   * Absent from a store written before then, which reads as none.
   */
  determinations?: Record<string, Determination>;
  /**
   * The intake tickets the confirmation sweep has recorded, by ticket key
   * (felipearos/ralph#449): what keeps a rerun from writing a ticket's
   * `confirmed` or `rejected` event twice, and, in shadow, where nothing is
   * labelled, from acting on the same ticket on every poll.
   */
  confirmed?: Record<string, ConfirmedRecord>;
  /**
   * The outcome scan's memory (felipearos/ralph#450): which closes it has
   * recorded, so a rerun writes no second `closed` event, and the moved OA
   * tickets it is waiting on. Absent from a store written before then.
   */
  outcomes?: OutcomesRecord;
  /**
   * Every report or reply file queued onto a ticket, by ticket key and then
   * Slack file id (`clerk/attachments.ts`): what keeps a rerun from attaching
   * a file twice, and what a failed download or upload is retried from.
   * Absent from a store written before files were attached.
   */
  attachments?: Record<string, Record<string, AttachmentRecord>>;
  /**
   * The code-context queue (felipearos/ralph#499, `clerk/code-context.ts`):
   * one case per ticket filed for an app with a configured repo, and the one
   * handed to an iteration. Absent from a store written before then, or with
   * the feature off.
   */
  codeContext?: CodeContextQueue;
}

export interface CodeContextQueue {
  /** The key of the case handed to the last iteration, until the next poll settles it. */
  handed: string | null;
  /** Every case, by ticket key. */
  cases: Record<string, CodeContextCase>;
}

/** The ticket as it was filed: what the case shows the session. */
export interface CodeContextTicket {
  summary: string;
  description: string;
  app: App;
  type: IssueType;
  priority: Priority;
  labels: string[];
  permalink: string;
}

/**
 * One ticket on its way to a "Contexto de código" comment.
 *
 * - `queued`: waiting for a poll with no report batch to hand over, and, after
 *   a failed prepare, for `nextAt`;
 * - `handed`: its case written and handed to an iteration, settled by the next poll;
 * - `posting`: its result validated and the comment waiting to be posted
 *   (retried on a backoff, never re-asked of a session);
 * - `done`: posted, or in shadow recorded in `comment`;
 * - `dropped`: given up on, `why` saying why.
 */
export interface CodeContextCase {
  key: string;
  /** The report it was filed from. */
  report: string;
  /** The apps whose code it reads, in verdict order (`pwa` before `Backoffice`). */
  apps: CodeContextApp[];
  ticket: CodeContextTicket;
  /** The report's Slack files, downloaded into the case when it is prepared. */
  files: AttachableFile[];
  state: "queued" | "handed" | "posting" | "done" | "dropped";
  queuedAt: string;
  /** Which session attempt the next hand-over is: 1, or 2 after a refused result. */
  attempt: number;
  /** Why the last attempt's result was refused, for the session to fix. */
  previousProblems: string[];
  /** Hand-overs of this attempt that ended with no result at all: a session that never ran. */
  misses?: number;
  handedAt?: string;
  /** Failed prepares or posts so far, and when the next try is due. */
  tries?: number;
  nextAt?: string;
  /** Why the last prepare or post failed, or why it was dropped. */
  why?: string;
  /** The validated comment: posted from here, and in shadow kept as the record of it. */
  comment?: string;
  doneAt?: string;
}

/** One file on its way to a ticket, or there. */
export interface AttachmentRecord {
  /** The original file name, which the ticket keeps. */
  name: string;
  size: number | null;
  type?: string;
  /** Where the bot downloads it from. */
  url: string;
  /** Its Slack permalink, for the line that says why it is not attached. */
  permalink: string;
  /** The report whose message or thread reply carried it. */
  report: string;
  /**
   * `pending` until it is attached (`uploaded`); `too-large` when it is over
   * `clerk.attachmentMaxMb` and is linked instead; `shadow` for what a shadow
   * clerk would have attached, which it never does; `gave-up` once it has
   * failed for `GIVE_UP_DAYS`, or its ticket is gone.
   */
  state: "pending" | "uploaded" | "too-large" | "shadow" | "gave-up";
  queuedAt: string;
  /** Failed attempts so far, and when the next is due: a backoff, so a missing scope is not asked every poll. */
  tries?: number;
  nextAt?: string;
  /** Why the last attempt failed, or why it was given up on. */
  why?: string;
  /** When it reached its final state. */
  doneAt?: string;
}

export interface OutcomesRecord {
  /** Tickets whose `closed` event is written, by the key that closed (intake or OA); pruned on `at`. */
  recorded: Record<string, { at: string; report: string }>;
  /**
   * Tickets a confirmation handed on and the scan waits on to close, by the
   * key it reads: the OA key of a moved ticket, the intake key of a to-agent
   * one. Copied from the confirmed records the poll they are finished, so the
   * report id survives the processed reports being pruned.
   */
  watched: Record<string, WatchedTicket>;
  /**
   * The "resuelto" replies a live clerk still owes, by the key that closed:
   * queued with the close, dropped once posted.
   * Absent from a store written before the replies.
   */
  replies?: Record<string, PendingReply>;
}

/** One reply owed in a report's thread. */
export interface PendingReply {
  /** The Slack report id: its first message's ts, the thread the reply goes in. */
  report: string;
  /** When it was queued; given up on this clock. */
  since: string;
  /** The intake key, when the ticket that closed is the OA one it moved to: a PR may name either. */
  intake?: string;
  /** Queued at the team board's ready status (`clerk.jira.readyStatuses`): no merged PR to wait for. */
  ready?: true;
}

export interface WatchedTicket {
  /** The Slack report id its events are filed under. */
  report: string;
  /** The intake ticket it came from (itself, for a to-agent one). */
  intake: string;
  board: "intake" | "oa";
  /** When the scan started watching it; pruned on this clock. */
  since: string;
  /** When its board was last read for it: the least recently read are read first. */
  checkedAt?: string;
  /** Jira says it does not exist: never asked again. */
  gone?: true;
  /** A moved ticket whose "resuelto" reply its ready status already queued: its later close queues none. */
  told?: true;
}

/** What the sweep has done with one intake ticket a person confirmed or rejected. */
export interface ConfirmedRecord {
  outcome: "to-agent" | "to-person" | "rejected";
  /** When the sweep first recorded it; pruned on this clock. */
  at: string;
  /** Whether the outcome's write is finished (always, for a rejection); until then every poll retries it. */
  done: boolean;
  /** The OA key a to-person ticket moved to, once known. */
  oaKey?: string;
  /** The confirmer's display name off the changelog, for the OA ticket's reason on a retried move. */
  by?: string;
}

/** The fields the clerk set on a ticket it filed, as it set them. */
export interface Determination {
  type: IssueType;
  priority: Priority;
  app: App;
  assignee: Assignee;
  difficulty: Difficulty;
  /** Null when nobody sized it: an unclassified report. */
  storyPoints: StoryPoints | null;
  /** When it was filed; pruned on the processed reports' clock. */
  filedAt: string;
  /**
   * The summary and the description as filed, the description as Jira reads
   * it back (`adfText(toAdf(body))`), so an edit by the confirmer is told
   * from the round trip (felipearos/ralph#449). Absent from a snapshot taken
   * before then, which compares no text.
   */
  summary?: string;
  description?: string;
  /** The report's Slack permalink, for the OA ticket a person's work moves to. */
  permalink?: string;
}

/** Keep what the clerk determined for `key`. A rerun that finds the ticket already filed keeps the first record. */
export function recordDetermination(store: ClerkStore, key: string, determination: Determination): void {
  store.determinations ??= {};
  if (!Object.hasOwn(store.determinations, key)) store.determinations[key] = determination;
}

export const emptyStore = (channel: string): ClerkStore => ({
  version: CLERK_STORE_VERSION,
  channel,
  cursor: "",
  processed: {},
  batch: null,
  progress: {},
  shadow: emptyShadow(),
  canvas: emptyCanvas(),
});

export function clerkStorePath(loop: string, cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, clerkStoreRelativePath(loop)) : join(resolve(cwd), ".ralph-clerk", `${loop}.json`);
}

export type StoreRead = { store: ClerkStore; problem: string | null };

/**
 * What a store written for another channel hands on to `channel`'s.
 *
 * The channel's reading position is the old channel's alone and is dropped:
 * its cursor is a ts in another channel's history (kept, it would skip or
 * re-read the new one's), its processed reports and re-opened ones are ids of
 * messages the new channel does not hold (kept, their threads would be
 * watched in a channel that does not have them), and a handed batch and its
 * progress are reports from the old channel, which filed in the new one's
 * name would carry permalinks to the wrong place.
 *
 * What is keyed by ticket is not the channel's and is kept: the shadow
 * would-be tickets, what the clerk determined for each ticket it filed, the
 * confirmation sweep's and the outcome scan's records, the files queued onto
 * each ticket, the code-context cases, and the canvas. They
 * describe tickets on the Jira board, which a channel move does not change;
 * dropping them would let the sweep write a ticket's `confirmed` or `closed`
 * event a second time. The outcome scan's owed replies are the exception:
 * they name threads of the old channel, which a reply in the new one cannot
 * reach.
 */
function withoutReplies(outcomes: OutcomesRecord): OutcomesRecord {
  const { replies: _threadsOfTheOldChannel, ...kept } = outcomes;
  return kept;
}

function movedChannel(previous: Partial<ClerkStore>, channel: string): ClerkStore {
  return {
    ...emptyStore(channel),
    ...(previous.shadow === undefined ? {} : { shadow: previous.shadow }),
    ...(previous.canvas === undefined ? {} : { canvas: previous.canvas }),
    ...(previous.determinations === undefined ? {} : { determinations: previous.determinations }),
    ...(previous.confirmed === undefined ? {} : { confirmed: previous.confirmed }),
    ...(previous.outcomes === undefined ? {} : { outcomes: withoutReplies(previous.outcomes) }),
    ...(previous.attachments === undefined ? {} : { attachments: previous.attachments }),
    // Keyed by ticket, like the attachments: a channel move changes no ticket.
    ...(previous.codeContext === undefined ? {} : { codeContext: previous.codeContext }),
  };
}

/**
 * The store for `channel`. A missing file is a first start. An unreadable one
 * starts over from an empty store, and one written for another channel starts
 * that channel's reading over (`movedChannel`); both say why — the gate prints
 * it, because starting over moves the cursor to "now" unless an operator has
 * set it (`clerk/cursor.ts --since`).
 */
export function readClerkStore(path: string, channel: string): StoreRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { store: emptyStore(channel), problem: null };
  }
  try {
    const value = JSON.parse(raw) as Partial<ClerkStore>;
    if (value?.version !== CLERK_STORE_VERSION) {
      return { store: emptyStore(channel), problem: `the clerk store ${path} is of another version; starting over` };
    }
    if (value.channel !== channel) {
      return {
        store: movedChannel(value, channel),
        problem: `the clerk store ${path} is for ${value.channel}, not ${channel}; starting ${channel}'s history over (the old channel's cursor and processed reports are dropped, the tickets' records kept)`,
      };
    }
    return { store: { ...emptyStore(channel), ...value } as ClerkStore, problem: null };
  } catch {
    return { store: emptyStore(channel), problem: `the clerk store ${path} is not JSON; starting over` };
  }
}

function writeClerkStore(path: string, store: ClerkStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Read-modify-write under an exclusive lock, as `ci-doctor/store.ts` does. The
 * gate and the read CLI both open it, so a write is never half-seen. No network
 * inside the critical section; a lock older than 30s belongs to a process that
 * died holding it and is broken.
 */
export async function withClerkStore<T>(path: string, channel: string, critical: (store: ClerkStore, problem: string | null) => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx");
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
      } catch {}
      // Waits past the 30s after which a lock is broken, so a lock left by a
      // process that died is cleared here rather than costing polls.
      if (attempt > 700) throw new Error(`the clerk store is locked: ${lock}`);
      await pause(50);
      continue;
    }
    try {
      const { store, problem } = readClerkStore(path, channel);
      const result = critical(store, problem);
      writeClerkStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {}
    }
  }
}

/**
 * Record that `reportId` is done with. Called once per report as it is
 * applied, so a run stopped halfway leaves exactly the reports it finished
 * marked. The batch itself is cleared by the gate once its journal entry is
 * written, so a crash between the last report and the journal still journals.
 */
export function markProcessed(store: ClerkStore, reportId: string, outcome: ProcessedReport): void {
  store.processed[reportId] = outcome;
  delete store.progress[reportId];
  if (store.reopened !== undefined) delete store.reopened[reportId];
}

/** Slack ts order: `"1760961600.000100"` after `"1760961600.000099"`, and anything after the empty cursor. */
const tsAfter = (ts: string, cursor: string): boolean => cursor === "" || Number(ts) > Number(cursor);

/**
 * Forget what the clerk decided for this channel's reports posted after
 * `cursor`, so the next polls hand them over and they are classified again
 * (`clerk/cursor.ts --since … --redo`). Only ever run in shadow: dropped
 * there, a decision was never a real ticket; dropped live, the reports would
 * be filed a second time.
 *
 * Dropped: the processed and re-opened reports, and the shadow records of
 * them — the would-be tickets, the intended writes and what the clerk
 * determined for each would-be ticket. A shadow ticket is this channel's when
 * its permalink names the channel, so the would-be tickets a store kept from
 * an earlier channel (`movedChannel`) are left alone. A kept would-be ticket
 * that a dropped report was folded into as a duplicate loses that report's
 * count. Returns the report ids dropped, oldest first.
 */
export function dropShadowDecisionsAfter(store: ClerkStore, cursor: string): string[] {
  const dropped = new Set<string>();
  const inChannel = (permalink: string): boolean => permalink.includes(`/archives/${store.channel}/`);
  for (const [id, outcome] of Object.entries(store.processed)) {
    if (!tsAfter(id, cursor)) continue;
    dropped.add(id);
    delete store.processed[id];
    const into = outcome.state === "commented" && outcome.key !== null ? store.shadow.tickets[outcome.key] : undefined;
    if (into !== undefined && into.report !== id) into.reports = Math.max(1, into.reports - 1);
  }
  for (const id of Object.keys(store.reopened ?? {})) {
    if (!tsAfter(id, cursor)) continue;
    dropped.add(id);
    delete store.reopened![id];
  }
  for (const [key, ticket] of Object.entries(store.shadow.tickets)) {
    if (!dropped.has(ticket.report) && !(inChannel(ticket.permalink) && tsAfter(ticket.report, cursor))) continue;
    dropped.add(ticket.report);
    delete store.shadow.tickets[key];
    if (store.determinations !== undefined) delete store.determinations[key];
  }
  store.shadow.writes = store.shadow.writes.filter((entry) => !dropped.has(entry.report));
  return [...dropped].sort((a, b) => Number(a) - Number(b));
}
