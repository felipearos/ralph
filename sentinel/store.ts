/**
 * The sentinel's issue store (felipearos/ralph#681, spec #678): one record per
 * error-reporter issue the sentinel has looked at, with what it saw, how many
 * sessions it was handed to, and the ticket it drafted or filed for it.
 *
 * It lives in git's common directory, beside the verifier's watch store, so
 * every worktree of the project shares one. It is NOT a cache: an issue
 * forgotten is an issue drafted (or filed) a second time, so an unreadable file
 * is refused on write rather than replaced by an empty store.
 *
 * The leases exist because two gates on one host must never hand one issue to
 * two sessions. The gate exits once it hands an issue over, so a lease names
 * the SUPERVISOR, and the heartbeat (`role-leases.ts`) renews it while the
 * session runs; a lease past its expiry means the holder is gone, not slow.
 *
 * The day ledger counts the tickets filed per UTC day, so the gate can hold
 * file mode to its daily cap and alert about reaching it once, not every pass.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { SentinelMode } from "../project-config";
import type { Candidate, Evidence, ReporterKind } from "../reporter/types";

export const SENTINEL_ISSUES_VERSION = 1 as const;

export const STORE_RELATIVE_PATH = "ralph/sentinel-issues.json";

/** How long an issue lease is good for; the supervisor's heartbeat renews it while the session runs. */
export const ISSUE_LEASE_SECONDS = 120;

export type IssueState = "observed" | "drafted" | "filed" | "failed";

/** Longest title accepted; a tracker title is one scannable line, not a paragraph. */
export const TITLE_MAX_CHARS = 200;

/** The ticket the sentinel filed, or in observe mode would have filed. */
export interface Draft {
  title: string;
  body: string;
  /** ISO. */
  at: string;
}

export interface IssueRecord {
  /** The reporter kind, e.g. "sentry". */
  reporter: string;
  /** The reporter's issue id. */
  id: string;
  state: IssueState;
  /** The last candidate row the gate saw. */
  candidate: Candidate;
  evidence: Evidence | null;
  /** Sessions handed this issue. */
  attempts: number;
  /** The tracker ref once filed. */
  ticket: string | null;
  /** What was, or would have been, filed. */
  draft: Draft | null;
  /** The mode at the time of the last state change. */
  mode: SentinelMode;
  /** ISO: the first time the gate recorded it. */
  observedAt: string;
  /** ISO. */
  updatedAt: string;
  /*
   * The fields below came with recurrences (felipearos/ralph#683). They are
   * optional because stores written before then have none; every reader
   * treats an absent one as its default.
   */
  /** The tracker number of `ticket`; absent on older records, read through {@link ticketNumberOf}. */
  ticketNumber?: number | null;
  /** 0 for the first ticket, +1 per regression after a closed ticket. Absent reads as 0. */
  cycle?: number;
  /** The ref of the closed ticket the current cycle regressed after. */
  regressedAfter?: string | null;
  /** Refs of every earlier cycle's ticket, oldest first. */
  previousTickets?: string[];
  /** What the gate knows of the issue coming back while its ticket is open. */
  recurrence?: Recurrence;
}

/** How many recurrence comments a record keeps; older ones are on the ticket itself. */
export const RECURRENCE_COMMENTS_KEPT = 10;

/** One comment the gate posted, or in observe mode would have posted, on an open ticket. */
export interface RecurrenceComment {
  /** ISO. */
  at: string;
  events: number;
  users: number;
  lastSeen: string;
  release: string | null;
  body: string;
  /** False for observe mode's would-be comment. */
  posted: boolean;
}

/** What the gate counted of an issue while its ticket is open, and the comments it made. */
export interface Recurrence {
  /** The events count last posted, or counted at filing: the next comment needs double this. */
  baseline: number;
  /** The {@link utcDay} of the last comment (posted or would-be), or of a pending reservation. */
  commentedOn: string | null;
  /** ISO: when the gate last read the ticket's state, so the checks rotate fairly. */
  checkedAt: string | null;
  /** The last {@link RECURRENCE_COMMENTS_KEPT} comments, oldest first. */
  comments: RecurrenceComment[];
}

/** One holder of an issue lease; the shape `role-leases.ts` renews in any store with `leases`. */
export interface Lease {
  run: string;
  loop: string;
  pid: number;
  host: string;
  expiresAt: string;
}

export interface SentinelStore {
  version: typeof SENTINEL_ISSUES_VERSION;
  /** Keyed by {@link issueKey}. */
  issues: Record<string, IssueRecord>;
  /** Issue leases, keyed by {@link issueKey}, so two gates never hand one issue to two sessions. */
  leases: Record<string, Lease>;
  /** Keyed by {@link utcDay}: the tickets filed that day, and whether the cap alert went out. */
  days: Record<string, DayLedger>;
}

export interface DayLedger {
  filed: number;
  alerted: boolean;
}

export const emptyStore = (): SentinelStore => ({ version: SENTINEL_ISSUES_VERSION, issues: {}, leases: {}, days: {} });

/** How many days of the ledger to keep; the cap only ever reads today's. */
export const DAY_LEDGER_DAYS = 14;

/* --------------------------------------------------------------------------
 * Pure helpers.
 * ----------------------------------------------------------------------- */

/** The key of one reporter issue: ids are only unique within a reporter. */
export const issueKey = (reporter: ReporterKind | string, id: string): string => `${reporter}:${id}`;

/** Drafted or filed: the gate never hands that issue over again. */
export const handled = (record: IssueRecord): boolean => record.state === "drafted" || record.state === "filed";

/**
 * Record what the gate saw of an issue. A new issue starts `observed`; a known
 * one only has its candidate row refreshed — seeing it again is not progress,
 * so its state and attempts stay as they were.
 */
export function recordCandidate(
  store: SentinelStore,
  reporter: ReporterKind | string,
  candidate: Candidate,
  mode: SentinelMode,
  now: Date,
): IssueRecord {
  const key = issueKey(reporter, candidate.id);
  const at = now.toISOString();
  const existing = store.issues[key];
  if (existing !== undefined) {
    existing.candidate = candidate;
    existing.updatedAt = at;
    return existing;
  }
  const record: IssueRecord = {
    reporter,
    id: candidate.id,
    state: "observed",
    candidate,
    evidence: null,
    attempts: 0,
    ticket: null,
    draft: null,
    mode,
    observedAt: at,
    updatedAt: at,
  };
  store.issues[key] = record;
  return record;
}

function findRecord(store: SentinelStore, key: string): IssueRecord {
  const record = store.issues[key];
  if (record === undefined) throw new Error(`no sentinel issue record for ${key}`);
  return record;
}

/**
 * Store the evidence the gate gathered as it hands the issue to a session, and
 * count the attempt. The mode is recorded with it: whether failed attempts may
 * end in a templated ticket depends on the mode they were made in.
 */
export function recordHandover(store: SentinelStore, key: string, evidence: Evidence, mode: SentinelMode, now: Date): IssueRecord {
  const record = findRecord(store, key);
  record.evidence = evidence;
  record.attempts += 1;
  record.mode = mode;
  record.updatedAt = now.toISOString();
  return record;
}

/**
 * Record the session's draft and free the issue's lease: the work it was held
 * for is done. A filed issue is refused — its ticket already exists, and a new
 * draft would no longer describe it.
 */
export function recordDraft(store: SentinelStore, key: string, draft: Draft, mode: SentinelMode, now: Date): IssueRecord {
  const record = findRecord(store, key);
  if (record.state === "filed") throw new Error(`sentinel issue ${key} is already filed; refusing to replace its draft`);
  record.draft = draft;
  record.state = "drafted";
  record.mode = mode;
  record.updatedAt = now.toISOString();
  delete store.leases[key];
  return record;
}

/** The ledger key of `now`: the cap is per UTC day, so every host agrees on when a day ends. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** Tickets filed on `day` (a {@link utcDay}). */
export function filedOn(store: SentinelStore, day: string): number {
  return wellFormed(store.days[day])?.filed ?? 0;
}

/**
 * The entry when it has the ledger's shape, else null. A hand-edited ledger
 * must not turn the gate's filing path into a throw: a malformed entry reads
 * as a day with nothing filed and no alert sent, and is replaced on write.
 */
function wellFormed(entry: unknown): DayLedger | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const { filed, alerted } = entry as Partial<DayLedger>;
  return typeof filed === "number" && Number.isFinite(filed) && typeof alerted === "boolean" ? (entry as DayLedger) : null;
}

/**
 * The day's entry, created when absent. Every write to the ledger goes through
 * here and drops the days older than {@link DAY_LEDGER_DAYS} first: the store
 * is read and rewritten whole on every pass, and a key per day would grow it
 * forever for a cap that only reads today.
 */
function dayEntry(store: SentinelStore, day: string): DayLedger {
  const cutoff = new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_LEDGER_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const key of Object.keys(store.days)) {
    if (key < cutoff) delete store.days[key];
  }
  const entry = wellFormed(store.days[day]) ?? { filed: 0, alerted: false };
  store.days[day] = entry;
  return entry;
}

/**
 * Record the ticket filed for an issue and free its lease. Only a new ticket
 * counts toward the day's cap: adopting one an earlier pass created (found by
 * its marker) files nothing, and counting it would spend the cap twice on one
 * ticket. A filed issue is refused — it already has its ticket.
 */
export function recordFiled(
  store: SentinelStore,
  key: string,
  filed: { ticket: string; number: number; draft: Draft | null; adopted: boolean },
  mode: SentinelMode,
  now: Date,
): IssueRecord {
  const record = findRecord(store, key);
  if (record.state === "filed") throw new Error(`sentinel issue ${key} is already filed as ${record.ticket}; refusing to file it again`);
  record.state = "filed";
  record.ticket = filed.ticket;
  record.ticketNumber = filed.number;
  // The baseline is what was counted at filing, so the first comment needs
  // the issue to double from there. The comment history outlives the reset:
  // it is what the issue did, whichever ticket it was posted on.
  record.recurrence = {
    baseline: record.candidate.events,
    commentedOn: null,
    checkedAt: null,
    comments: record.recurrence?.comments ?? [],
  };
  if (filed.draft !== null) record.draft = filed.draft;
  record.mode = mode;
  record.updatedAt = now.toISOString();
  delete store.leases[key];
  if (!filed.adopted) dayEntry(store, utcDay(now)).filed += 1;
  return record;
}

/* --------------------------------------------------------------------------
 * Recurrences (felipearos/ralph#683): a filed issue that comes back.
 *
 * Pure helpers on a store the caller holds inside `withStore`; each throws
 * like `findRecord` on an unknown key.
 * ----------------------------------------------------------------------- */

/**
 * The tracker number of the record's ticket: the stored one, else the
 * trailing digits of the ref (`#12`, `AND-12`) for records filed before the
 * number was stored, else null.
 */
/** The record's cycle; absent on records written before recurrences (#683), which is cycle 0. */
export const cycleOf = (record: IssueRecord): number => record.cycle ?? 0;

export function ticketNumberOf(record: IssueRecord): number | null {
  if (typeof record.ticketNumber === "number" && Number.isInteger(record.ticketNumber)) return record.ticketNumber;
  const match = typeof record.ticket === "string" ? /(\d+)$/.exec(record.ticket.trim()) : null;
  return match === null ? null : Number(match[1]);
}

/** Does `events` at least double the last counted baseline? A baseline of 0 still needs 2. */
export const doubled = (recurrence: Recurrence, events: number): boolean => events >= 2 * Math.max(recurrence.baseline, 1);

function recurrenceOf(record: IssueRecord, baseline = record.candidate.events): Recurrence {
  record.recurrence ??= { baseline, commentedOn: null, checkedAt: null, comments: [] };
  return record.recurrence;
}

/**
 * The recurrence, created with `events` as its baseline when absent. Records
 * filed before recurrences existed have none, and their first check must set
 * the baseline rather than comment on it.
 */
export function ensureBaseline(store: SentinelStore, key: string, events: number): Recurrence {
  return recurrenceOf(findRecord(store, key), events);
}

/** Record when the gate last read the ticket's state. */
export function markChecked(store: SentinelStore, key: string, now: Date): Recurrence {
  const recurrence = recurrenceOf(findRecord(store, key));
  recurrence.checkedAt = now.toISOString();
  return recurrence;
}

/**
 * Reserve today's one comment before posting it, under the lock, so two gates
 * never post twice on one day. False when today's is already taken; otherwise
 * the previous `commentedOn` (possibly null), which {@link releaseComment}
 * restores if the post fails.
 */
export function reserveComment(store: SentinelStore, key: string, day: string): Recurrence["commentedOn"] | false {
  const recurrence = recurrenceOf(findRecord(store, key));
  if (recurrence.commentedOn === day) return false;
  const previous = recurrence.commentedOn;
  recurrence.commentedOn = day;
  return previous;
}

/**
 * Roll a failed reservation back. Only this day's reservation is undone: a
 * later day's belongs to a pass that came after, and is not this caller's.
 */
export function releaseComment(store: SentinelStore, key: string, day: string, previous: Recurrence["commentedOn"]): void {
  const recurrence = recurrenceOf(findRecord(store, key));
  if (recurrence.commentedOn === day) recurrence.commentedOn = previous;
}

/** Record a comment made (or would-be) under a reservation: its count is the next baseline. */
export function confirmComment(store: SentinelStore, key: string, comment: RecurrenceComment): Recurrence {
  const recurrence = recurrenceOf(findRecord(store, key));
  recurrence.baseline = comment.events;
  recurrence.comments = [...recurrence.comments, comment].slice(-RECURRENCE_COMMENTS_KEPT);
  return recurrence;
}

/**
 * Start a new cycle for a filed issue whose ticket was closed and which came
 * back: the record goes back to `observed`, so the gate hands it over again
 * and files a new ticket linking the closed one. The closed ticket moves to
 * `previousTickets`. The recurrence restarts from `events`, this poll's count,
 * and keeps its comment history —
 * the counts and dates stay worth reading, and `recordFiled` sets a fresh
 * baseline when the new ticket is filed. A lease on the key is dropped: it
 * was taken for the old cycle's work.
 */
export function reopenRecord(store: SentinelStore, key: string, now: Date, events: number): IssueRecord {
  const record = findRecord(store, key);
  if (record.state !== "filed" || record.ticket === null) {
    throw new Error(`sentinel issue ${key} is ${record.state}, not filed; refusing to start a new cycle for it`);
  }
  record.previousTickets = [...(record.previousTickets ?? []), record.ticket];
  record.regressedAfter = record.ticket;
  record.cycle = cycleOf(record) + 1;
  record.state = "observed";
  record.attempts = 0;
  record.evidence = null;
  record.draft = null;
  record.ticket = null;
  record.ticketNumber = null;
  // This poll's count, not 0 and not the stored candidate's, which may be
  // weeks old: a would-be ticket in observe mode is checked for doubling
  // before any new ticket resets the baseline.
  record.recurrence = { baseline: events, commentedOn: null, checkedAt: null, comments: record.recurrence?.comments ?? [] };
  record.updatedAt = now.toISOString();
  delete store.leases[key];
  return record;
}

/** Mark the day's cap alert as sent: true when this call set it, false when it already was. */
export function markCapAlerted(store: SentinelStore, day: string): boolean {
  const entry = dayEntry(store, day);
  if (entry.alerted) return false;
  entry.alerted = true;
  return true;
}

/* --------------------------------------------------------------------------
 * Issue leases.
 *
 * The verifier's check-in lease rules: ownership is `run` AND `loop`, a
 * holder's own lease is free to it, and a lease is free once expired or once
 * its holder is gone.
 * ----------------------------------------------------------------------- */

/** Who a lease would name. `run` and `loop` together are the owner. */
export interface Holder {
  run: string;
  loop: string;
  pid?: number;
  host?: string;
}

type Alive = (holder: { pid: number; host: string }) => boolean;

const thisHost = (): string => process.env.HOSTNAME ?? hostname();

/**
 * Copied from `verifier/watches.ts#holderAlive` (itself `role-leases.ts`'s):
 * a pid recorded on another host means nothing here, so that holder is alive
 * and left to its expiry. Change those and change this with them.
 */
function holderAlive(holder: { pid: number; host: string }): boolean {
  if (holder.host !== thisHost() && holder.host !== hostname()) return true;
  try { process.kill(holder.pid, 0); return true; } catch { return false; }
}

/**
 * Copied from `verifier/watches.ts#supervisorPid`: the lease names the
 * SUPERVISOR, since the gate exits the moment it hands the issue over and the
 * session it hands it to is the supervisor's child.
 */
function supervisorPid(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RALPH_SUPERVISOR_PID?.trim();
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : process.ppid || process.pid;
}

/** Copied from `verifier/watches.ts#holderOf`. */
const holderOf = (holder: Holder): Required<Holder> => ({
  run: holder.run,
  loop: holder.loop,
  pid: holder.pid ?? supervisorPid(),
  host: holder.host ?? thisHost(),
});

/** Is the issue `key` free for `holder` to take? Pure, so the gate can skip held ones before locking. */
export function issueFree(
  leases: Record<string, Lease>,
  key: string,
  holder: Holder,
  nowMs: number,
  alive: Alive = holderAlive,
): boolean {
  const lease = leases[key];
  if (lease === undefined) return true;
  if (lease.run === holder.run && lease.loop === holder.loop) return true;
  // Expiry first: it is the answer that always arrives, even for a holder on
  // another host that liveness takes as alive forever.
  const expires = Date.parse(lease.expiresAt);
  if (Number.isFinite(expires) && expires <= nowMs) return true;
  return !alive({ pid: lease.pid, host: lease.host });
}

export interface TakeResult {
  /** Did this holder end up with the lease? */
  taken: boolean;
  /** Who has it when `taken` is false; null when nobody does but the issue is already handled. */
  holder: Lease | null;
}

/**
 * Take the lease on one issue, or report who has it. The read, the check and
 * the write all run inside `withStore`: checking outside the lock is the race
 * that would hand one issue to two sessions. A handled issue is refused here
 * too, since the gate's own read of the store may predate another's draft.
 * `allowDrafted` lets the gate lease a drafted issue while it files it; a
 * filed one is refused either way.
 */
export async function takeIssueLease(
  path: string,
  key: string,
  holder: Holder,
  options: { nowMs?: number; leaseSeconds?: number; alive?: Alive; allowDrafted?: boolean } = {},
): Promise<TakeResult> {
  const nowMs = options.nowMs ?? Date.now();
  const seconds = options.leaseSeconds ?? ISSUE_LEASE_SECONDS;
  const who = holderOf(holder);
  const alive = options.alive ?? holderAlive;
  return withStore(path, (store) => {
    const record = store.issues[key];
    const refused = record !== undefined && (options.allowDrafted ? record.state === "filed" : handled(record));
    if (refused) return { taken: false, holder: null };
    if (!issueFree(store.leases, key, who, nowMs, alive)) {
      return { taken: false, holder: store.leases[key] ?? null };
    }
    store.leases[key] = { ...who, expiresAt: new Date(nowMs + seconds * 1000).toISOString() };
    return { taken: true, holder: store.leases[key] };
  });
}

/* --------------------------------------------------------------------------
 * The file and its lock.
 * ----------------------------------------------------------------------- */

export function storePathFromGit(cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, STORE_RELATIVE_PATH) : join(resolve(cwd), ".ralph-sentinel-issues.json");
}

export type Loaded = { kind: "ok"; store: SentinelStore } | { kind: "missing" } | { kind: "unreadable"; why: string };

const isRecord = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

/** Exported for read-only views that must tell an unreadable store from an empty one. */
export function loadStore(path: string): Loaded {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  // An empty file is what a crash between create and write leaves; it holds no issue to lose.
  if (raw.trim() === "") return { kind: "missing" };
  try {
    const value = JSON.parse(raw) as Partial<SentinelStore>;
    if (value?.version !== SENTINEL_ISSUES_VERSION) {
      return { kind: "unreadable", why: `version ${JSON.stringify(value?.version)}, expected ${SENTINEL_ISSUES_VERSION}` };
    }
    if (!isRecord(value.issues)) return { kind: "unreadable", why: "'issues' is not an object" };
    if (value.leases !== undefined && !isRecord(value.leases)) return { kind: "unreadable", why: "'leases' is not an object" };
    // `days` came after the first stores were written; one without it has filed nothing.
    if (value.days !== undefined && !isRecord(value.days)) return { kind: "unreadable", why: "'days' is not an object" };
    return {
      kind: "ok",
      store: {
        version: SENTINEL_ISSUES_VERSION,
        issues: value.issues as Record<string, IssueRecord>,
        leases: value.leases ?? {},
        days: value.days ?? {},
      },
    };
  } catch (error) {
    return { kind: "unreadable", why: `not JSON: ${(error as Error).message}` };
  }
}

/**
 * The store, or an empty one when the file is missing or unreadable — for
 * reporting only. Writes go through {@link withStore}, which refuses a file
 * it cannot read instead of forgetting its issues.
 */
export function readStore(path: string): SentinelStore {
  const loaded = loadStore(path);
  return loaded.kind === "ok" ? loaded.store : emptyStore();
}

function writeStore(path: string, store: SentinelStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Read-modify-write under an exclusive lock file, as `verifier/watches.ts`
 * does. Keep the critical section short: no network inside it. A lock older
 * than 30s belongs to a process that died inside one, and is broken. An
 * unreadable store throws: overwriting it would forget every issue it held,
 * and each would be drafted again.
 */
export async function withStore<T>(path: string, critical: (store: SentinelStore) => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (attempt > 200) throw new Error(`the sentinel issue store is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      const loaded = loadStore(path);
      if (loaded.kind === "unreadable") {
        throw new Error(`the sentinel issue store at ${path} is unreadable (${loaded.why}); refusing to overwrite it — fix or move the file by hand`);
      }
      const store = loaded.kind === "ok" ? loaded.store : emptyStore();
      const result = critical(store);
      writeStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}
