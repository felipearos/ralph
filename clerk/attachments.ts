#!/usr/bin/env bun
/**
 * A report's files, copied onto its Jira ticket as attachments: every image,
 * video, PDF or anything else a reporter posted, so a person on the board
 * sees it without opening Slack.
 *
 * Two halves, so that filing a ticket never waits on a file:
 *
 * - **Queueing** (`queueAttachments`), in the same store write that records
 *   what was filed: a created ticket or a duplicate comment queues the
 *   report's files onto that ticket, and a thread reply copied to a ticket
 *   (felipearos/ralph#321) queues the reply's files beside its comment. The
 *   description or comment already names each file (`clerk/files.ts`); the
 *   report's own Slack permalink stays, and leads to every file in Slack.
 * - **Uploading** (`attachPending`), once per poll after the channel is read:
 *   each due file is downloaded from Slack with the bot token (`files:read`)
 *   to a temporary file, streamed, and uploaded from there to
 *   `POST /rest/api/3/issue/{key}/attachments`, under its original name.
 *
 * Nothing here fails or holds up a poll. A missing `files:read`, a failed
 * download or a failed upload is a note in the supervisor log and a retry
 * later, on a backoff (`RETRY_FIRST_MS`, doubling, at most `RETRY_MAX_MS`); a
 * file that has failed for `GIVE_UP_DAYS` is given up on, and its ticket
 * still names it and links the report. A file over `clerk.attachmentMaxMb` is
 * never downloaded: its line says it is too large and links it.
 *
 * Idempotent: the store records each file by ticket and Slack file id, so a
 * rerun queues nothing twice and uploads nothing twice. A kill between an
 * upload and its save is caught by reading the ticket's attachments first: one
 * with the same name and size is taken as this file.
 *
 * Modes, as everywhere: shadow records what it would attach (`state:
 * "shadow"`) and uploads nothing, because its port holds no client. Quiet and
 * live upload, since an attachment is a Jira write; downloading only reads
 * Slack, so quiet may, and nothing is posted in Slack either way.
 *
 * Usage (from a clerk loop's worktree, with the gate's secrets in the
 * environment; see the README's "Report files on the ticket"):
 *   bun "$RALPH_HOME/clerk/attachments.ts" --backfill   attach the files of reports already filed
 *
 * Exit codes: 0 · 1 a file could not be attached, or a token is missing · 3 the
 * project has no clerk · 64 usage.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOOP_NAME_RELATIVE_PATH, projectRoot } from "../paths";
import { clerkJira, clerkRules, loadProjectConfig, writesJira, type ClerkMode, type ClerkRules } from "../project-config";
import { INTAKE_LABEL, isPlaceholderKey } from "./apply";
import { attachableFiles, isTooLarge, maxBytesOf, tooLargeLine, type AttachableFile } from "./files";
import { JIRA_TOKEN_ENV, JiraError, jiraClient, jqlString, parseJiraToken, type JiraAttachment, type JiraClient } from "./jira";
import { FILES_SCOPE, SLACK_TOKEN_ENV, SlackError, slackClient, type SlackClient, type SlackMessage } from "./slack";
import { clerkStorePath, withClerkStore, type AttachmentRecord, type ClerkStore } from "./store";

/** The first retry of a failed file waits this long, doubling per failure. */
export const RETRY_FIRST_MS = 5 * 60_000;
/** And never longer than this between tries: a scope added at night is used by morning. */
export const RETRY_MAX_MS = 6 * 3_600_000;
/** How long a file is retried before it is given up on: the thread watch's two weeks. */
export const GIVE_UP_DAYS = 14;
/** How many files one poll attaches, so a burst of videos cannot keep a poll from handing work over. */
export const ATTACH_PER_POLL = 10;
/**
 * How long a file is claimed while it is being attached: past the download's
 * and the upload's timeouts, so a gate and a backfill never both attach it,
 * and a process killed mid-upload leaves it due again after this.
 */
export const IN_FLIGHT_MS = 25 * 60_000;

const DAY_MS = 86_400_000;

/** The wait after the `tries`-th failure. */
export const retryDelayMs = (tries: number): number => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, tries - 1));

/**
 * Queue `files` onto ticket `key`, each once: a file already recorded for
 * that ticket, in whatever state, is left alone. One over the cap is recorded
 * as too large and never downloaded; in shadow, or onto a key no board holds,
 * each is recorded as what would have been attached. How many were new.
 */
export function queueAttachments(
  store: ClerkStore,
  key: string,
  files: readonly AttachableFile[],
  options: { mode: ClerkMode; maxBytes: number; report: string; at: string },
): number {
  if (files.length === 0) return 0;
  store.attachments ??= {};
  const onTicket = (store.attachments[key] ??= {});
  let queued = 0;
  for (const file of files) {
    if (Object.hasOwn(onTicket, file.id)) continue;
    const state: AttachmentRecord["state"] = isTooLarge(file, options.maxBytes)
      ? "too-large"
      : options.mode === "shadow" || isPlaceholderKey(key)
        ? "shadow"
        : "pending";
    onTicket[file.id] = {
      name: file.name,
      size: file.size,
      ...(file.type === undefined ? {} : { type: file.type }),
      url: file.url,
      permalink: file.permalink,
      report: options.report,
      state,
      queuedAt: options.at,
      ...(state === "pending" ? {} : { doneAt: options.at }),
    };
    queued += 1;
  }
  if (Object.keys(onTicket).length === 0) delete store.attachments[key];
  return queued;
}

/** How long a finished record is kept: the processed reports' 90 days. */
export const ATTACHMENT_KEEP_DAYS = 90;

/** Forget finished records past the keep window; a pending one is given up on first, never dropped. */
export function pruneAttachments(store: ClerkStore, nowMs: number): void {
  for (const [key, files] of Object.entries(store.attachments ?? {})) {
    for (const [id, record] of Object.entries(files)) {
      if (record.state !== "pending" && nowMs - Date.parse(record.doneAt ?? record.queuedAt) > ATTACHMENT_KEEP_DAYS * DAY_MS) delete files[id];
    }
    if (Object.keys(files).length === 0) delete store.attachments![key];
  }
}

export interface AttachDeps {
  rules: ClerkRules;
  storePath: string;
  now: () => number;
  slack: Pick<SlackClient, "downloadFile">;
  jira: Pick<JiraClient, "attachments" | "attach">;
  /** The scopes the Slack token was granted (`auth.test`); null when Slack did not say. */
  scopes: readonly string[] | null;
  /** How many files to attach this call; `ATTACH_PER_POLL` by default. */
  limit?: number;
}

/** One file due this call, claimed. */
interface Due {
  key: string;
  id: string;
  record: AttachmentRecord;
}

/** What one file came to. */
type Result =
  | { kind: "uploaded"; adopted: boolean }
  | { kind: "too-large"; bytes: number }
  | { kind: "gone"; why: string }
  | { kind: "failed"; why: string; retryAfterMs?: number };

const failureOf = (error: unknown): { why: string; retryAfterMs?: number } => {
  if (error instanceof SlackError || error instanceof JiraError) {
    const { failure } = error;
    return failure.kind === "rate-limited" ? { why: failure.why, retryAfterMs: failure.retryAfterSeconds * 1000 } : { why: failure.why };
  }
  return { why: error instanceof Error ? error.message : String(error) };
};

/** Jira says the ticket is not there: deleted by hand, or a key no board holds. */
const isGone = (error: unknown): boolean => error instanceof JiraError && error.failure.kind === "denied" && error.failure.code === "jira_not_found";

/**
 * Attach the files that are due. Never throws: whatever goes wrong is a note,
 * and the file is tried again after its backoff. Returns the notes.
 */
export async function attachPending(deps: AttachDeps): Promise<string[]> {
  try {
    return await attachDue(deps);
  } catch (error) {
    // The store, or a defect: one poll's attachments, never the poll.
    return [`report files not attached this poll: ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`];
  }
}

async function attachDue(deps: AttachDeps): Promise<string[]> {
  const { rules } = deps;
  const notes: string[] = [];
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const lacksScope = deps.scopes !== null && !deps.scopes.includes(FILES_SCOPE);
  const due = await withClerkStore(deps.storePath, rules.channel, (store) => {
    const out: Due[] = [];
    for (const [key, files] of Object.entries(store.attachments ?? {})) {
      for (const [id, record] of Object.entries(files)) {
        if (record.state !== "pending") continue;
        if (nowMs - Date.parse(record.queuedAt) > GIVE_UP_DAYS * DAY_MS) {
          Object.assign(record, { state: "gave-up", doneAt: at });
          notes.push(`${key}: gave up attaching ${record.name} after ${GIVE_UP_DAYS} days (${record.why ?? "never attached"}); the ticket names it and links the report`);
          continue;
        }
        if (record.nextAt !== undefined && Date.parse(record.nextAt) > nowMs) continue;
        out.push({ key, id, record: { ...record } });
      }
    }
    out.sort((a, b) => Date.parse(a.record.queuedAt) - Date.parse(b.record.queuedAt));
    const claimed = out.slice(0, deps.limit ?? ATTACH_PER_POLL);
    for (const { key, id } of claimed) {
      const record = store.attachments![key]![id]!;
      if (lacksScope) {
        // Not even asked: Slack would answer its sign-in page. The backoff
        // keeps a token without the scope from costing a note every poll.
        record.tries = (record.tries ?? 0) + 1;
        record.nextAt = new Date(nowMs + retryDelayMs(record.tries)).toISOString();
        record.why = `the Slack token lacks ${FILES_SCOPE}`;
      } else {
        record.nextAt = new Date(nowMs + IN_FLIGHT_MS).toISOString();
      }
    }
    return claimed;
  });
  if (due.length === 0) return notes;
  if (lacksScope) {
    notes.push(
      `${due.length} report file${due.length === 1 ? "" : "s"} not attached: the Slack token lacks ${FILES_SCOPE}; add it to the clerk's Slack app, reinstall it and store the new bot token as ${SLACK_TOKEN_ENV} (the tickets link the reports meanwhile, and the files are tried again later)`,
    );
    return notes;
  }
  const maxBytes = maxBytesOf(rules);
  const dir = mkdtempSync(join(tmpdir(), "clerk-attach-"));
  try {
    const onTicket = new Map<string, JiraAttachment[] | { gone: string } | { failed: string; retryAfterMs?: number }>();
    for (let index = 0; index < due.length; index++) {
      const { key, id, record } = due[index]!;
      if (!onTicket.has(key)) {
        try {
          onTicket.set(key, await deps.jira.attachments(key));
        } catch (error) {
          onTicket.set(key, isGone(error) ? { gone: failureOf(error).why } : { failed: failureOf(error).why, ...pick(failureOf(error)) });
        }
      }
      const existing = onTicket.get(key)!;
      let result: Result;
      if ("gone" in existing) result = { kind: "gone", why: existing.gone };
      else if ("failed" in existing) result = { kind: "failed", why: existing.failed, ...(existing.retryAfterMs === undefined ? {} : { retryAfterMs: existing.retryAfterMs }) };
      else result = await attachOne(deps, dir, index, key, record, existing, maxBytes);
      await settle(deps, key, id, result, notes);
      if (result.kind === "failed" && result.retryAfterMs !== undefined) {
        // Rate limited: the rest wait out the same window rather than each
        // spend a call learning it.
        await release(deps, due.slice(index + 1), nowMs + result.retryAfterMs);
        break;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return notes;
}

const pick = (failure: { retryAfterMs?: number }): { retryAfterMs?: number } => (failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs });

/** Download one file and upload it, unless the ticket already holds it. */
async function attachOne(deps: AttachDeps, dir: string, index: number, key: string, record: AttachmentRecord, existing: JiraAttachment[], maxBytes: number): Promise<Result> {
  // Same name and size: this file, attached by a run killed before it saved.
  // Name alone is not enough: every pasted screenshot is `image.png`.
  if (existing.some((one) => one.filename === record.name && (record.size === null || one.size === record.size))) return { kind: "uploaded", adopted: true };
  const path = join(dir, `${index}`);
  try {
    const downloaded = await deps.slack.downloadFile(record.url, path, maxBytes);
    if (downloaded.kind === "too-large") return { kind: "too-large", bytes: downloaded.bytes };
    await deps.jira.attach(key, { path, name: record.name, ...(record.type === undefined ? {} : { type: record.type }) });
    existing.push({ id: "", filename: record.name, size: downloaded.bytes });
    return { kind: "uploaded", adopted: false };
  } catch (error) {
    if (isGone(error)) return { kind: "gone", why: failureOf(error).why };
    return { kind: "failed", ...failureOf(error) };
  } finally {
    rmSync(path, { force: true });
  }
}

/** Record what one file came to, and the note it leaves. */
async function settle(deps: AttachDeps, key: string, id: string, result: Result, notes: string[]): Promise<void> {
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const maxBytes = maxBytesOf(deps.rules);
  await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
    const record = store.attachments?.[key]?.[id];
    if (record === undefined) return;
    if (result.kind === "uploaded") {
      Object.assign(record, { state: "uploaded", doneAt: at });
      delete record.nextAt;
      delete record.why;
      notes.push(`${key}: attached ${record.name}${result.adopted ? " (already on the ticket)" : ""}`);
    } else if (result.kind === "too-large") {
      Object.assign(record, { state: "too-large", doneAt: at, why: `larger than clerk.attachmentMaxMb` });
      delete record.nextAt;
      notes.push(`${key}: not attached — ${tooLargeLine(record, result.bytes, maxBytes)}`);
    } else if (result.kind === "gone") {
      Object.assign(record, { state: "gave-up", doneAt: at, why: result.why });
      delete record.nextAt;
      notes.push(`${key}: ${record.name} not attached, the ticket is gone (${result.why})`);
    } else {
      record.tries = (record.tries ?? 0) + 1;
      const wait = Math.max(retryDelayMs(record.tries), result.retryAfterMs ?? 0);
      record.nextAt = new Date(nowMs + wait).toISOString();
      record.why = result.why;
      notes.push(`${key}: ${record.name} not attached yet (${result.why}); tried again in ${Math.round(wait / 60_000)}m`);
    }
  });
}

/** Hand claimed files back, due at `atMs`. */
async function release(deps: AttachDeps, rest: readonly Due[], atMs: number): Promise<void> {
  if (rest.length === 0) return;
  await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
    for (const { key, id } of rest) {
      const record = store.attachments?.[key]?.[id];
      if (record?.state === "pending") record.nextAt = new Date(atMs).toISOString();
    }
  });
}

/* --------------------------------------------------------------------------
 * Backfill: the files of reports filed before files were attached.
 * ----------------------------------------------------------------------- */

/** The most intake tickets one backfill reads. */
export const BACKFILL_MAX = 1000;

/** Every ticket the clerk filed on the intake board. */
export const filedIntakeJql = (project: string): string => `project = ${jqlString(project)} AND labels = ${jqlString(INTAKE_LABEL)} ORDER BY created ASC`;

/** The Slack message ts a permalink in `channel` names, or null. */
export function tsOfPermalink(link: string, channel: string): string | null {
  const match = new RegExp(`/archives/${channel}/p(\\d{10})(\\d{6})(?![\\d])`).exec(link);
  return match === null ? null : `${match[1]}.${match[2]}`;
}

/**
 * The reports a ticket carries, by their first message's ts: the one it was
 * filed for (`Reportado por … en Slack:` in its description), and each one
 * folded into it as a duplicate (`Nuevo reporte del mismo problema por … en
 * Slack:` in a comment). Thread replies are not counted apart: they are in
 * their report's thread, which the backfill reads whole.
 */
export function reportsOnTicket(description: string, comments: readonly string[], channel: string): string[] {
  const out: string[] = [];
  const add = (text: string, prefix: RegExp): void => {
    for (const match of text.matchAll(prefix)) {
      const ts = tsOfPermalink(match[1]!, channel);
      if (ts !== null && !out.includes(ts)) out.push(ts);
    }
  };
  add(description, /Reportado por .*? en Slack: (\S+)/g);
  for (const comment of comments) add(comment, /Nuevo reporte del mismo problema por .*? en Slack: (\S+)/g);
  return out;
}

export interface BackfillDeps {
  rules: ClerkRules;
  storePath: string;
  now: () => number;
  slack: SlackClient;
  jira: JiraClient;
  /** Wait out a rate limit: the backfill is run by hand and may take its time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Backfilled {
  tickets: number;
  queued: number;
  lines: string[];
  /** Files that could not be attached this run and are left for the gate to retry. */
  failed: number;
}

/**
 * Queue the files of every report the clerk filed on the intake board, then
 * attach them. Reading the board rather than the store finds reports whose
 * record the store has pruned; the store still says which messages a report
 * was joined from. Idempotent as the gate is: a file queued before is left
 * alone, and one already on the ticket is not attached again.
 */
export async function backfill(deps: BackfillDeps): Promise<Backfilled> {
  const { rules } = deps;
  const project = clerkJira(rules.jira).intakeProject;
  if (project === null) throw new Error("the clerk has no 'clerk.jira.intakeProject': there is no intake board to backfill");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const patient = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const failure = error instanceof SlackError || error instanceof JiraError ? error.failure : null;
        if (failure?.kind !== "rate-limited" || attempt >= 5) throw error;
        await sleep(failure.retryAfterSeconds * 1000);
      }
    }
  };
  const identity = await deps.slack.authTest();
  const tickets = await patient(() => deps.jira.search(filedIntakeJql(project), BACKFILL_MAX));
  const lines: string[] = [];
  const roots = await withClerkStore(deps.storePath, rules.channel, (store) =>
    Object.fromEntries(Object.entries(store.processed).map(([id, outcome]) => [id, outcome.roots ?? [id]])),
  );
  const me = { userId: identity.userId, botId: identity.botId };
  const maxBytes = maxBytesOf(rules);
  let queued = 0;
  for (const ticket of tickets) {
    let comments = ticket.commentTexts;
    // The search returns the first comments only; a ticket with more is read whole.
    if (ticket.comments > comments.length) comments = await patient(() => deps.jira.comments(ticket.key));
    const reports = reportsOnTicket(ticket.description, comments, rules.channel);
    for (const report of reports) {
      const files: AttachableFile[] = [];
      for (const root of roots[report] ?? [report]) {
        let thread: SlackMessage[];
        try {
          thread = await patient(() => deps.slack.replies(rules.channel, root));
        } catch (error) {
          lines.push(`${ticket.key}: the report ${root} could not be read from Slack (${failureOf(error).why}); run the backfill again`);
          continue;
        }
        for (const message of thread) {
          // The clerk's own replies carry no reporter's files.
          if ((me.userId !== "" && message.user === me.userId) || (me.botId !== null && message.bot_id === me.botId)) continue;
          files.push(...attachableFiles(message.files));
        }
      }
      const added = await withClerkStore(deps.storePath, rules.channel, (store) =>
        queueAttachments(store, ticket.key, files, { mode: rules.mode, maxBytes, report, at: new Date(deps.now()).toISOString() }),
      );
      if (added > 0) lines.push(`${ticket.key}: ${added} file${added === 1 ? "" : "s"} of report ${report} queued${rules.mode === "shadow" ? " (shadow: recorded, not attached)" : ""}`);
      queued += added;
    }
  }
  let failed = 0;
  if (writesJira(rules.mode)) {
    // Every due file, a batch at a time, until none is due: one that fails
    // waits its backoff, so it is not retried within this run.
    for (;;) {
      const notes = await attachPending({ rules, storePath: deps.storePath, now: deps.now, slack: deps.slack, jira: deps.jira, scopes: identity.scopes.length === 0 ? null : identity.scopes, limit: 25 });
      lines.push(...notes);
      if (notes.length === 0) break;
      const left = await withClerkStore(deps.storePath, rules.channel, (store) => dueCount(store, deps.now()));
      if (left === 0) break;
    }
    failed = await withClerkStore(deps.storePath, rules.channel, (store) =>
      Object.values(store.attachments ?? {}).reduce((sum, files) => sum + Object.values(files).filter((record) => record.state === "pending").length, 0),
    );
  }
  return { tickets: tickets.length, queued, lines, failed };
}

/** How many pending files are due now. */
const dueCount = (store: ClerkStore, nowMs: number): number =>
  Object.values(store.attachments ?? {}).reduce(
    (sum, files) => sum + Object.values(files).filter((record) => record.state === "pending" && (record.nextAt === undefined || Date.parse(record.nextAt) <= nowMs)).length,
    0,
  );

/** The loop this worktree runs as: the environment, else `.ralph/loop-name`, as `ralph.sh` reads it. */
function loopName(root: string): string {
  const fromEnv = process.env.RALPH_LOOP_NAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(root, LOOP_NAME_RELATIVE_PATH), "utf8").trim() || "clerk";
  } catch {
    return "clerk";
  }
}

const USAGE = 'usage: bun "$RALPH_HOME/clerk/attachments.ts" --backfill';

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "--backfill") {
    console.error(USAGE);
    return 64;
  }
  const root = projectRoot();
  const rules = clerkRules(loadProjectConfig(root));
  if (rules === null) {
    console.error("clerk-attachments: the project's .ralph/config.json has no 'clerk' block");
    return 3;
  }
  const token = process.env[SLACK_TOKEN_ENV]?.trim() ?? "";
  const credential = parseJiraToken(process.env[JIRA_TOKEN_ENV]);
  if (token === "" || credential === null) {
    console.error(
      `clerk-attachments: the backfill needs the clerk gate's secrets, ${SLACK_TOKEN_ENV} and ${JIRA_TOKEN_ENV} ('<email>:<API token>'); run it under the project's secrets scope, e.g. doppler run -p <project> -c <config> -- bun "$RALPH_HOME/clerk/attachments.ts" --backfill`,
    );
    return 1;
  }
  const result = await backfill({
    rules,
    storePath: clerkStorePath(loopName(root), root),
    now: () => Date.now(),
    slack: slackClient(token, fetch, rules.channel),
    jira: jiraClient(rules.jira.site, credential),
  });
  for (const line of result.lines) console.log(`clerk-attachments: ${line}`);
  console.log(
    `clerk-attachments: ${result.tickets} intake ticket${result.tickets === 1 ? "" : "s"} read, ${result.queued} file${result.queued === 1 ? "" : "s"} queued${
      rules.mode === "shadow" ? " (shadow: nothing attached)" : result.failed === 0 ? ", nothing left to attach" : `, ${result.failed} left for the gate to retry`
    }`,
  );
  return result.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`clerk-attachments: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
