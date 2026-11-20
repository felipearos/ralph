#!/usr/bin/env bun
/**
 * Code context (felipearos/ralph#499): a "Contexto de código" comment on every
 * ticket the clerk files for an app whose code it can read — which file or
 * component is involved, whether the bug is already fixed on the integration
 * branch, whether it works as designed.
 *
 * The clerk's session has no network and never sees the application code, so
 * the gate does everything that needs either, and a second kind of iteration
 * reads what it prepared:
 *
 * - **Queueing** (`queueCodeContext`), in the store write that records a
 *   filed ticket (live and quiet; shadow too, for its would-be ticket), when
 *   `clerk.codeContext` names a repo for the ticket's app. `none` is never
 *   queued; `both` reads both repos.
 * - **Handing over** (`handCodeContext`), at the end of a poll that handed no
 *   report batch: report intake always comes first. The oldest queued case is
 *   prepared — each repo fetched and checked out detached in its own worktree
 *   under `.ralph/logs/code/<app>`, the report's Slack files downloaded with
 *   the gate's token (a video's frames extracted when ffmpeg is there), the
 *   ticket's comments read — and written as `case.json`. The verdict is
 *   `code context <KEY> (<apps>)`.
 * - **Settling** (`settleCodeContext`), on the next poll: the session's
 *   `result.json` is validated (key, size, header, no emoji) and the comment
 *   posted on the ticket as Atlassian Document Format (`commentDoc`); shadow
 *   records it in the store instead. An invalid result is handed back once
 *   with its problems; a second is dropped with a note.
 *
 * Nothing here throws out of a poll or stops the loop: a clone that cannot be
 * fetched, a file that cannot be downloaded, a comment Jira will not take is
 * a note and a retry later on the attachments' backoff, and a case that has
 * failed for `GIVE_UP_DAYS` is dropped. The clone's own checkout and branches
 * are never touched: the gate only fetches it and adds worktrees to it.
 *
 * Usage (from the clerk loop's worktree):
 *   bun "$RALPH_HOME/clerk/code-context.ts" --show   the handed case, as JSON
 *
 * Exit codes for `--show`: 0 · 1 no case is waiting · 64 usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LOOP_NAME_RELATIVE_PATH, projectRoot } from "../paths";
import { clerkRules, loadProjectConfig, type ClerkRules, type CodeContextApp, type CodeContextRepo, type CodeContextRules } from "../project-config";
import { isPlaceholderKey, type NewIssue } from "./apply";
import { GIVE_UP_DAYS, retryDelayMs } from "./attachments";
import { isTooLarge, maxBytesOf, type AttachableFile } from "./files";
import { JiraError, type AdfNode, type JiraClient, type JiraComment } from "./jira";
import { FILES_SCOPE, SlackError, type SlackClient } from "./slack";
import { clerkStorePath, readClerkStore, withClerkStore, type ClerkStore, type CodeContextCase, type CodeContextQueue } from "./store";

/** How every code-context comment starts: the validator requires it, and a post already on the ticket is known by it. */
export const CODE_CONTEXT_HEADER = "Contexto de código";
export const COMMENT_MIN = 200;
export const COMMENT_MAX = 6000;
/** A refused result is handed back once; the second refusal drops the case. */
export const MAX_ATTEMPTS = 2;
/**
 * Hand-overs in a row that may end with no result at all before the attempt
 * counts as failed: a session that never ran (a pause, a restart, a runner
 * outage) has not failed anything, as `clerk/gate.ts` `MISSES_BEFORE_REFUSAL`
 * reasons for a batch.
 */
export const MISSES_BEFORE_FAILURE = 3;
/** How long a finished case is remembered: the processed reports' 90 days. */
export const CASE_KEEP_DAYS = 90;
/** The most frames one video gives the session: one every three seconds of its first minute and a half. */
export const MAX_FRAMES = 30;
/** One git call: a fetch of a big clone on a slow link, and no longer. */
export const GIT_TIMEOUT_MS = 180_000;

const DAY_MS = 86_400_000;

/** What the supervisor matches on the gate's verdict line to know the iteration is a code-context one. */
export const CASE_PATTERN = /^code context ([A-Z][A-Z0-9]*-[0-9]+) \(/;

export const caseWhy = (key: string, apps: readonly CodeContextApp[]): string => `code context ${key} (${apps.join(", ")})`;

/** Where a case lives, inside the loop's worktree, ignored by git. */
export const caseDirOf = (root: string, key: string): string => join(root, ".ralph", "logs", "code-context", key);
/** Where an app's read-only checkout lives: one per app, re-pointed for every case. */
export const codeDirOf = (root: string, app: CodeContextApp): string => join(root, ".ralph", "logs", "code", app);

/** The repos a ticket of `app` reads, in verdict order; none for `none` or an app with no repo configured. */
export function appsOf(app: string, rules: CodeContextRules): CodeContextApp[] {
  const wanted: CodeContextApp[] = app === "both" ? ["pwa", "Backoffice"] : app === "pwa" || app === "Backoffice" ? [app] : [];
  return wanted.filter((one) => rules.repos[one] !== undefined);
}

/**
 * Queue a case for ticket `key`, once: a ticket already queued, in whatever
 * state, is left alone, so a rerun of the same apply queues nothing twice.
 * Whether it was queued.
 */
export function queueCodeContext(
  store: ClerkStore,
  rules: CodeContextRules | null | undefined,
  input: { key: string; report: string; issue: NewIssue; files: readonly AttachableFile[]; at: string },
): boolean {
  if (rules == null) return false;
  const apps = appsOf(input.issue.app, rules);
  if (apps.length === 0) return false;
  store.codeContext ??= { handed: null, cases: {} };
  if (Object.hasOwn(store.codeContext.cases, input.key)) return false;
  const { issue } = input;
  store.codeContext.cases[input.key] = {
    key: input.key,
    report: input.report,
    apps,
    ticket: { summary: issue.summary, description: issue.description, app: issue.app, type: issue.type, priority: issue.priority, labels: [...issue.labels], permalink: issue.permalink },
    files: [...input.files],
    state: "queued",
    queuedAt: input.at,
    attempt: 1,
    previousProblems: [],
  };
  return true;
}

/** Forget finished cases past the keep window. A queued one is given up on first (`handCodeContext`), never dropped here. */
export function pruneCodeContext(store: ClerkStore, nowMs: number): void {
  const queue = store.codeContext;
  if (queue === undefined) return;
  for (const [key, one] of Object.entries(queue.cases)) {
    if ((one.state === "done" || one.state === "dropped") && nowMs - Date.parse(one.doneAt ?? one.queuedAt) > CASE_KEEP_DAYS * DAY_MS) delete queue.cases[key];
  }
}

/* --------------------------------------------------------------------------
 * The result and the comment.
 * ----------------------------------------------------------------------- */

export type ResultValidated = { ok: true; comment: string } | { ok: false; problems: string[] };

/**
 * The session's `result.json`, judged: `raw` is the parsed file, or a string
 * saying why it could not be read. Every problem is listed, so a second
 * attempt can fix them all at once.
 */
export function validateResult(raw: unknown, key: string): ResultValidated {
  if (typeof raw === "string") return { ok: false, problems: [raw] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["result.json must be a JSON object with 'key' and 'comment_es'"] };
  const value = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (value.key !== key) problems.push(`'key' must be ${JSON.stringify(key)}; got ${JSON.stringify(value.key)}`);
  const comment = value.comment_es;
  if (typeof comment !== "string") {
    problems.push(`'comment_es' must be a string; got ${JSON.stringify(comment)?.slice(0, 80) ?? "nothing"}`);
    return { ok: false, problems };
  }
  const text = comment.trim();
  if (text.length < COMMENT_MIN || text.length > COMMENT_MAX) problems.push(`'comment_es' must be ${COMMENT_MIN} to ${COMMENT_MAX} characters; got ${text.length}`);
  if (!text.startsWith(CODE_CONTEXT_HEADER)) problems.push(`the first line of 'comment_es' must start with "${CODE_CONTEXT_HEADER}"; got ${JSON.stringify(text.split("\n")[0]!.slice(0, 80))}`);
  const emoji = text.match(/\p{Extended_Pictographic}/gu);
  if (emoji !== null) problems.push(`'comment_es' must carry no emoji; found ${[...new Set(emoji)].join(" ")}`);
  return problems.length === 0 ? { ok: true, comment: text } : { ok: false, problems };
}

/** `result.json`, parsed, or why it could not be; undefined when the session wrote none. */
export function readResult(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    return `result.json is not JSON: ${(error as Error).message}`;
  }
}

/** A URL ends at whitespace and before trailing punctuation, as `clerk/jira.ts` reads one. */
const TOKEN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s|<>`]*[^\s|<>`.,;:!?)\]"'])/g;
/**
 * A leading `Label:` that the comment shows bold: at most six words and no
 * comma or full stop before the colon, so a sentence that happens to hold a
 * colon is not bolded whole.
 */
const LABEL = /^([^\s`*:,.][^`*:,.\n]{0,39}):(?=\s|$)/;
const LABEL_WORDS = 6;

const textNode = (text: string, marks?: AdfNode[]): AdfNode => ({ type: "text", text, ...(marks === undefined ? {} : { marks }) });

/** One line's inline nodes: `code`, **bold**, links, and a bold leading label. */
function inlineNodes(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let rest = line;
  const label = LABEL.exec(rest);
  // A label that is itself a URL scheme or code is not a label.
  if (label !== null && !/^https?$/i.test(label[1]!) && label[1]!.trim().split(/\s+/).length <= LABEL_WORDS) {
    nodes.push(textNode(`${label[1]}:`, [{ type: "strong" }]));
    rest = rest.slice(label[0].length);
  }
  let at = 0;
  for (const match of rest.matchAll(TOKEN)) {
    if (match.index! > at) nodes.push(textNode(rest.slice(at, match.index)));
    if (match[1] !== undefined) nodes.push(textNode(match[1], [{ type: "code" }]));
    else if (match[2] !== undefined) nodes.push(textNode(match[2], [{ type: "strong" }]));
    else nodes.push(textNode(match[3]!, [{ type: "link", attrs: { href: match[3] } }]));
    at = match.index! + match[0].length;
  }
  if (at < rest.length) nodes.push(textNode(rest.slice(at)));
  // ADF refuses an empty text node.
  return nodes.filter((node) => node.text !== "");
}

/**
 * The comment's markdown subset as Atlassian Document Format: one paragraph
 * per line, consecutive `- ` lines one bullet list, `` `code` ``, `**bold**`,
 * links, and a leading `Label:` in bold. `clerk/jira.ts` `toAdf` keeps the
 * clerk's plain text plain; this comment is written to be skimmed, and its
 * file names read as code.
 */
export function commentDoc(text: string): AdfNode {
  const content: AdfNode[] = [];
  let list: AdfNode[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      list = null;
      continue;
    }
    if (line.startsWith("- ")) {
      if (list === null) {
        list = [];
        content.push({ type: "bulletList", content: list });
      }
      list.push({ type: "listItem", content: [{ type: "paragraph", content: inlineNodes(line.slice(2)) }] });
      continue;
    }
    list = null;
    content.push({ type: "paragraph", content: inlineNodes(line) });
  }
  return { type: "doc", version: 1, content };
}

/* --------------------------------------------------------------------------
 * Preparing a case.
 * ----------------------------------------------------------------------- */

export type Git = (args: readonly string[]) => { ok: boolean; stdout: string; why: string };

/** git with a timeout and no prompt: a clone asking for a password must fail, not wait all night. */
export const runGit: Git = (args) => {
  const out = spawnSync("git", args, {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const why = out.error !== undefined ? out.error.message : (out.stderr ?? "").trim().split("\n").pop() || `exit ${out.status}`;
  return { ok: out.status === 0 && out.error === undefined, stdout: (out.stdout ?? "").trim(), why };
};

/** A video's frames as JPEGs in `dir`, oldest first; none when ffmpeg is missing or fails. */
export function ffmpegFrames(video: string, dir: string): string[] {
  try {
    mkdirSync(dir, { recursive: true });
    spawnSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video, "-vf", "fps=1/3,scale='min(1280,iw)':-2", "-frames:v", String(MAX_FRAMES), join(dir, "%03d.jpg")],
      { stdio: "ignore", timeout: 120_000 },
    );
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jpg"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** What the gate wires in; tests hand in fakes for git and ffmpeg. */
export interface CodeContextDeps {
  /** The loop's worktree: cases and checkouts live under its `.ralph/logs`. */
  root: string;
  git?: Git;
  frames?: (video: string, dir: string) => string[];
}

/** What one poll hands the code-context steps. */
export interface CodeContextIo {
  rules: ClerkRules;
  storePath: string;
  now: () => number;
  deps: CodeContextDeps;
  slack: Pick<SlackClient, "downloadFile">;
  /** Null in shadow without a credential: no comments read, nothing posted (shadow posts nothing anyway). */
  jira: Pick<JiraClient, "comments" | "commentEntries" | "addDocComment"> | null;
  /** The Slack token's scopes; null when Slack did not say. */
  scopes: readonly string[] | null;
}

/** One repo of a case, as the session reads it. */
export interface CaseRepo {
  app: CodeContextApp;
  path: string;
  ref: string;
  sha: string;
  mainRef: string;
}

/** One file of a case: `path` null when it could not be downloaded; `frames` only for a video. */
export interface CaseFile {
  name: string;
  path: string | null;
  type: string;
  frames?: string[];
}

/** `case.json`, as the contract between the gate and the session pins it. */
export interface CaseJson {
  key: string;
  attempt: number;
  previousProblems: string[];
  ticket: CodeContextCase["ticket"] & { comments: JiraComment[] };
  repos: CaseRepo[];
  files: CaseFile[];
  result: string;
}

/** A failure that is the ticket's, not the poll's: it is gone, and the case with it. */
class TicketGone extends Error {}

/**
 * Point the app's worktree at `repo.ref`, freshly fetched. Throws with why on
 * anything git refuses; the caller retries the case later.
 */
export function checkoutRepo(app: CodeContextApp, repo: CodeContextRepo, root: string, git: Git = runGit): CaseRepo {
  if (!existsSync(repo.path)) throw new Error(`the ${app} clone ${repo.path} does not exist`);
  const fetched = git(["-C", repo.path, "fetch", "--quiet", "origin"]);
  if (!fetched.ok) throw new Error(`git fetch in ${repo.path} failed: ${fetched.why}`);
  const resolved = git(["-C", repo.path, "rev-parse", "--verify", "--quiet", `${repo.ref}^{commit}`]);
  if (!resolved.ok || resolved.stdout === "") throw new Error(`${repo.ref} is not a commit in ${repo.path}`);
  const sha = resolved.stdout;
  const dir = codeDirOf(root, app);
  const fresh = (): void => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, ".."), { recursive: true });
    // A worktree whose directory was deleted is still registered; pruned, its path is free again.
    git(["-C", repo.path, "worktree", "prune"]);
    const added = git(["-C", repo.path, "worktree", "add", "--quiet", "--detach", dir, sha]);
    if (!added.ok) throw new Error(`git worktree add ${dir} failed: ${added.why}`);
  };
  if (existsSync(join(dir, ".git"))) {
    // `--force` and a clean: whatever a session left in its read-only view is
    // not the code at this commit.
    const moved = git(["-C", dir, "checkout", "--quiet", "--detach", "--force", sha]);
    if (moved.ok) git(["-C", dir, "clean", "-ffdq"]);
    else fresh();
  } else {
    fresh();
  }
  return { app, path: dir, ref: repo.ref, sha, mainRef: repo.mainRef };
}

const isVideo = (file: Pick<AttachableFile, "name" | "type">): boolean => (file.type ?? "").startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);

/** A file name safe as one path segment. */
const safeName = (name: string, index: number): string => name.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_").slice(0, 200) || `file-${index + 1}`;

/** Download the case's files into `dir`; one that cannot be had is `path: null` and a note, never a failure of the case. */
async function downloadFiles(io: CodeContextIo, key: string, files: readonly AttachableFile[], dir: string, notes: string[]): Promise<CaseFile[]> {
  rmSync(dir, { recursive: true, force: true });
  if (files.length === 0) return [];
  mkdirSync(dir, { recursive: true });
  const maxBytes = maxBytesOf(io.rules);
  const lacksScope = io.scopes !== null && !io.scopes.includes(FILES_SCOPE);
  const frames = io.deps.frames ?? ffmpegFrames;
  const used = new Set<string>();
  const out: CaseFile[] = [];
  for (const [index, file] of files.entries()) {
    let name = safeName(file.name, index);
    if (used.has(name)) name = `${index + 1}-${name}`;
    used.add(name);
    const dest = join(dir, name);
    const entry: CaseFile = { name: file.name, path: null, type: file.type ?? "application/octet-stream" };
    if (lacksScope) {
      notes.push(`${key}: ${file.name} not downloaded for code context: the Slack token lacks ${FILES_SCOPE}`);
    } else if (isTooLarge(file, maxBytes)) {
      notes.push(`${key}: ${file.name} not downloaded for code context: larger than clerk.attachmentMaxMb`);
    } else {
      try {
        const downloaded = await io.slack.downloadFile(file.url, dest, maxBytes);
        if (downloaded.kind === "too-large") {
          rmSync(dest, { force: true });
          notes.push(`${key}: ${file.name} not downloaded for code context: larger than clerk.attachmentMaxMb`);
        } else {
          entry.path = dest;
        }
      } catch (error) {
        rmSync(dest, { force: true });
        notes.push(`${key}: ${file.name} not downloaded for code context (${error instanceof SlackError ? error.failure.why : (error as Error).message})`);
      }
    }
    if (isVideo(file)) entry.frames = entry.path === null ? [] : frames(entry.path, `${entry.path}.frames`);
    out.push(entry);
  }
  return out;
}

/** The ticket's comments, read live; none for a would-be shadow ticket, which no board holds. */
async function ticketComments(io: CodeContextIo, key: string): Promise<JiraComment[]> {
  if (io.rules.mode === "shadow" || isPlaceholderKey(key) || io.jira === null) return [];
  try {
    return await io.jira.commentEntries(key);
  } catch (error) {
    if (isGone(error)) throw new TicketGone(`${key} no longer exists`);
    throw error;
  }
}

const isGone = (error: unknown): boolean => error instanceof JiraError && error.failure.kind === "denied" && error.failure.code === "jira_not_found";

const whyOf = (error: unknown): string =>
  error instanceof SlackError || error instanceof JiraError ? error.failure.why : error instanceof Error ? error.message : String(error);

/** Write the case for `one`: checkouts, files, comments, then `case.json`, with any stale result removed first. */
export async function prepareCase(io: CodeContextIo, one: CodeContextCase, notes: string[]): Promise<CaseJson> {
  const repos = io.rules.codeContext?.repos ?? {};
  const root = io.deps.root;
  const dir = caseDirOf(root, one.key);
  mkdirSync(dir, { recursive: true });
  const result = join(dir, "result.json");
  // A result left from the attempt before must never be read as this one's.
  rmSync(result, { force: true });
  const checked: CaseRepo[] = [];
  for (const app of one.apps) {
    const repo = repos[app];
    if (repo === undefined) continue;
    checked.push(checkoutRepo(app, repo, root, io.deps.git ?? runGit));
  }
  if (checked.length === 0) throw new Error(`no configured repo for ${one.apps.join(", ")} any more`);
  const comments = await ticketComments(io, one.key);
  const files = await downloadFiles(io, one.key, one.files, join(dir, "files"), notes);
  const json: CaseJson = {
    key: one.key,
    attempt: one.attempt,
    previousProblems: one.previousProblems,
    ticket: { ...one.ticket, comments },
    repos: checked,
    files,
    result,
  };
  writeFileSync(join(dir, "case.json"), `${JSON.stringify(json, null, 2)}\n`);
  return json;
}

/* --------------------------------------------------------------------------
 * The poll's two steps.
 * ----------------------------------------------------------------------- */

const queueOf = (store: ClerkStore): CodeContextQueue => (store.codeContext ??= { handed: null, cases: {} });

/**
 * Hand the oldest due case over, after a poll that handed no report batch.
 * Returns the verdict's `why`, or null with nothing handed. Never throws: a
 * case that cannot be prepared is a note and a retry on the backoff.
 */
export async function handCodeContext(io: CodeContextIo): Promise<{ why: string | null; notes: string[] }> {
  const notes: string[] = [];
  try {
    return { why: await handDue(io, notes), notes };
  } catch (error) {
    // The store, or a defect: one poll's code context, never the poll.
    notes.push(`code context not handed over this poll: ${whyOf(error)}; tried again at the next poll`);
    return { why: null, notes };
  }
}

async function handDue(io: CodeContextIo, notes: string[]): Promise<string | null> {
  const { rules } = io;
  const nowMs = io.now();
  const at = new Date(nowMs).toISOString();
  const picked = await withClerkStore(io.storePath, rules.channel, (store) => {
    if (store.codeContext === undefined) return null;
    const queue = queueOf(store);
    // One case at a time: a handed case is settled before another goes out.
    if (queue.handed !== null) return null;
    const due: CodeContextCase[] = [];
    for (const one of Object.values(queue.cases)) {
      if (one.state !== "queued") continue;
      if (nowMs - Date.parse(one.queuedAt) > GIVE_UP_DAYS * DAY_MS) {
        Object.assign(one, { state: "dropped", doneAt: at, why: `never prepared in ${GIVE_UP_DAYS} days${one.why === undefined ? "" : ` (${one.why})`}` });
        notes.push(`${one.key}: code context dropped — ${one.why}`);
        continue;
      }
      if (one.nextAt !== undefined && Date.parse(one.nextAt) > nowMs) continue;
      due.push(one);
    }
    due.sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt));
    return due[0] === undefined ? null : structuredClone(due[0]);
  });
  if (picked === null) return null;
  try {
    await prepareCase(io, picked, notes);
  } catch (error) {
    const gone = error instanceof TicketGone;
    const why = whyOf(error);
    await withClerkStore(io.storePath, rules.channel, (store) => {
      const one = store.codeContext?.cases[picked.key];
      if (one === undefined) return;
      if (gone) {
        Object.assign(one, { state: "dropped", doneAt: at, why });
        notes.push(`${one.key}: code context dropped — ${why}`);
        return;
      }
      one.tries = (one.tries ?? 0) + 1;
      const wait = retryDelayMs(one.tries);
      one.nextAt = new Date(nowMs + wait).toISOString();
      one.why = why;
      notes.push(`${one.key}: code context not prepared (${why}); tried again in ${Math.round(wait / 60_000)}m`);
    });
    return null;
  }
  return withClerkStore(io.storePath, rules.channel, (store) => {
    const queue = queueOf(store);
    const one = queue.cases[picked.key];
    if (one === undefined || one.state !== "queued") return null;
    one.state = "handed";
    one.handedAt = at;
    delete one.tries;
    delete one.nextAt;
    delete one.why;
    queue.handed = one.key;
    return caseWhy(one.key, one.apps);
  });
}

/**
 * Settle what the last code-context iteration left, and post the comments
 * waiting to be posted. Runs on every poll that got through, whatever it hands
 * over: a result never waits on the report channel. Never throws.
 */
export async function settleCodeContext(io: CodeContextIo): Promise<string[]> {
  const notes: string[] = [];
  try {
    await settleHanded(io, notes);
    await postPending(io, notes);
  } catch (error) {
    notes.push(`code context not settled this poll: ${whyOf(error)}; tried again at the next poll`);
  }
  return notes;
}

async function settleHanded(io: CodeContextIo, notes: string[]): Promise<void> {
  const { rules } = io;
  const handed = await withClerkStore(io.storePath, rules.channel, (store) => store.codeContext?.handed ?? null);
  if (handed === null) return;
  const raw = readResult(join(caseDirOf(io.deps.root, handed), "result.json"));
  const at = new Date(io.now()).toISOString();
  const finished = await withClerkStore(io.storePath, rules.channel, (store): boolean => {
    const queue = queueOf(store);
    queue.handed = null;
    const one = queue.cases[handed];
    if (one === undefined || one.state !== "handed") return false;
    let problems: string[];
    if (raw === undefined) {
      one.misses = (one.misses ?? 0) + 1;
      if (one.misses < MISSES_BEFORE_FAILURE) {
        one.state = "queued";
        notes.push(`${one.key}: no code-context result was written; handed over again later`);
        return false;
      }
      problems = [`no result.json was written after ${one.misses} hand-overs`];
    } else {
      const validated = validateResult(raw, one.key);
      if (validated.ok) {
        one.state = "posting";
        one.comment = validated.comment;
        delete one.misses;
        return false;
      }
      problems = validated.problems;
    }
    if (one.attempt < MAX_ATTEMPTS) {
      Object.assign(one, { state: "queued", attempt: one.attempt + 1, previousProblems: problems, misses: 0 });
      notes.push(`${one.key}: the code-context result was refused (${problems.join("; ")}); handed over again`);
      return false;
    }
    Object.assign(one, { state: "dropped", doneAt: at, why: `refused ${MAX_ATTEMPTS} times: ${problems.join("; ")}` });
    notes.push(`${one.key}: code context dropped after ${MAX_ATTEMPTS} failed attempts — ${problems.join("; ")}`);
    return true;
  });
  if (finished) dropFiles(io, handed);
}

/** A finished case's downloaded files: a video is a lot of disk to keep for a case nobody reads again. */
function dropFiles(io: CodeContextIo, key: string): void {
  try {
    rmSync(join(caseDirOf(io.deps.root, key), "files"), { recursive: true, force: true });
  } catch {}
}

/** Post every validated comment that is due: shadow records it, live and quiet write it on the ticket. */
async function postPending(io: CodeContextIo, notes: string[]): Promise<void> {
  const { rules } = io;
  const nowMs = io.now();
  const due = await withClerkStore(io.storePath, rules.channel, (store) =>
    Object.values(store.codeContext?.cases ?? {})
      .filter((one) => one.state === "posting" && (one.nextAt === undefined || Date.parse(one.nextAt) <= nowMs))
      .map((one) => ({ key: one.key, comment: one.comment ?? "" })),
  );
  for (const { key, comment } of due) {
    let outcome: { kind: "done"; line: string } | { kind: "gone"; why: string } | { kind: "failed"; why: string; retryAfterMs?: number };
    if (rules.mode === "shadow" || isPlaceholderKey(key)) {
      outcome = { kind: "done", line: `${key}: code-context comment recorded (shadow: not posted)` };
    } else if (io.jira === null) {
      // Live and quiet without a credential are denied before a poll gets here.
      continue;
    } else {
      try {
        // A post that landed before its save was lost: the ticket already carries it.
        if ((await io.jira.comments(key)).some((text) => text.startsWith(CODE_CONTEXT_HEADER))) {
          outcome = { kind: "done", line: `${key}: code-context comment already on the ticket` };
        } else {
          await io.jira.addDocComment(key, commentDoc(comment));
          outcome = { kind: "done", line: `${key}: code-context comment posted` };
        }
      } catch (error) {
        if (isGone(error)) outcome = { kind: "gone", why: whyOf(error) };
        else {
          const failure = error instanceof JiraError ? error.failure : null;
          outcome = { kind: "failed", why: whyOf(error), ...(failure?.kind === "rate-limited" ? { retryAfterMs: failure.retryAfterSeconds * 1000 } : {}) };
        }
      }
    }
    const at = new Date(io.now()).toISOString();
    const settled = outcome;
    await withClerkStore(io.storePath, rules.channel, (store) => {
      const one = store.codeContext?.cases[key];
      if (one === undefined || one.state !== "posting") return;
      if (settled.kind === "done") {
        Object.assign(one, { state: "done", doneAt: at });
        delete one.nextAt;
        delete one.why;
        delete one.tries;
        notes.push(settled.line);
      } else if (settled.kind === "gone") {
        Object.assign(one, { state: "dropped", doneAt: at, why: settled.why });
        notes.push(`${key}: code-context comment not posted, the ticket is gone (${settled.why})`);
      } else {
        one.tries = (one.tries ?? 0) + 1;
        const wait = Math.max(retryDelayMs(one.tries), settled.retryAfterMs ?? 0);
        one.nextAt = new Date(nowMs + wait).toISOString();
        one.why = settled.why;
        notes.push(`${key}: code-context comment not posted yet (${settled.why}); tried again in ${Math.round(wait / 60_000)}m`);
      }
    });
    if (settled.kind !== "failed") dropFiles(io, key);
    // Rate limited: the rest wait for a later poll rather than each learn it.
    if (settled.kind === "failed" && settled.retryAfterMs !== undefined) break;
  }
}

/* --------------------------------------------------------------------------
 * CLI: the session's one window onto its case.
 * ----------------------------------------------------------------------- */

export const NO_CASE = "no code-context case is waiting";

/** `case.json` of the handed case, or null when none is waiting. */
export function showCase(root: string, storePath: string, channel: string): string | null {
  const { store } = readClerkStore(storePath, channel);
  const key = store.codeContext?.handed ?? null;
  if (key === null || store.codeContext?.cases[key]?.state !== "handed") return null;
  try {
    return readFileSync(join(caseDirOf(root, key), "case.json"), "utf8");
  } catch {
    return null;
  }
}

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

function main(argv: string[]): number {
  if (argv.length !== 1 || argv[0] !== "--show") {
    console.error('usage: bun "$RALPH_HOME/clerk/code-context.ts" --show');
    return 64;
  }
  const root = projectRoot();
  const rules = clerkRules(loadProjectConfig(root));
  const shown = rules === null ? null : showCase(root, clerkStorePath(loopName(root), root), rules.channel);
  if (shown === null) {
    console.error(NO_CASE);
    return 1;
  }
  process.stdout.write(shown);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // Whatever went wrong, the session's answer is the same: there is no case to read.
    console.error(NO_CASE);
    console.error(`clerk-code-context: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
