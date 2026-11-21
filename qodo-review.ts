#!/usr/bin/env bun
/**
 * Has Qodo reviewed this PR's head? The merge condition a Qodo project adds to
 * §5 step 6 of `prompt.md`, through its `.ralph/prompt.md` reviewer section.
 *
 * Qodo Code Review posts one summary comment per PR, "Code Review by Qodo",
 * and edits it in place as it reviews; inline findings arrive as review
 * threads, which `review-threads.ts` already makes a loop answer. What nothing
 * checked is whether that review had happened at all. The step 6 rule "do not
 * wait for a review that has not arrived" let a loop merge on a green `test`
 * while Qodo was still reviewing: on this repository a review took from 30
 * seconds to ten minutes, so a fast CI run merged unreviewed code. And when
 * Qodo's run fails, the comment reads "Sorry, something went wrong … comment
 * /agentic_review", which nothing answered.
 *
 * And the findings themselves: with the repository's Qodo settings they are
 * published in that summary only, as numbered `<details>` blocks under a
 * severity badge (High "Action required", Medium "Remediation recommended",
 * Low), with no inline thread for `review-threads.ts` to list. So a loop that
 * answered every review thread still never saw one (PR #26: seven findings,
 * two High, zero threads).
 *
 * So this reads the summary comment and says whether a FINISHED review covers
 * the PR head — the head commit's URL and a finished body (the counts line,
 * numbered findings, "no issues found" or "no open findings"), never a failed run — and lists
 * its open findings. A failed review, or one of an older commit, is asked
 * again with `/agentic_review`, once per head. The wait is bounded (house
 * rule 1): past `RALPH_QODO_REVIEW_MINUTES` (30) from when this tool first saw
 * the head, it stops waiting and says so, and the prompt hands the PR to a
 * person rather than merging it unreviewed. When it first saw each head, and
 * whether it already asked Qodo again for it, is kept in
 * `<git-common-dir>/ralph/qodo-review.json`; a commit's own date says nothing
 * about when it was pushed (PR #26 review).
 *
 *   bun qodo-review.ts <pr> [--repo owner/name] [--wait <seconds>] [--json]
 *
 * `--wait` polls every 30 s for at most that long (default 240, at most 480:
 * the model runs this in a Bash call with a 10-minute ceiling, and a throttled
 * read may add a minute) before answering "pending". Exit codes are the
 * contract; the prompt reads them:
 *   0  a finished review covers the head and lists no open finding
 *   1  a finished review covers the head; its open findings are listed
 *   3  pending — no finished review of the head yet; run it again
 *   4  gave up — no review of the head within the budget; hand the PR to a person
 *   5  unreadable — `gh` failed or answered something unexpected
 *  64  usage
 *  75  GitHub throttled the read past its budget — retry later
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  classifyRateLimit,
  isRateLimited,
  RATE_LIMITED_EXIT,
  retryPolicy,
  withRateLimitRetry,
  type RetryBudget,
  type RetryDeps,
} from "./frontier/github-rate-limit";

export interface IssueComment {
  author: string | null;
  body: string;
  createdAt: string;
  /** When the comment was last edited; Qodo edits its summary in place while it reviews. */
  updatedAt?: string;
  url: string;
}

export interface PrState {
  head: string;
  /** When the head commit was committed: only a fallback for `since`, see `HeadSeen`. */
  headAt: string;
  comments: IssueComment[];
}

/** What this host remembers about one PR head. */
export interface HeadSeen {
  /** When this tool first saw the head: the budget and the stale grace run from here. */
  firstSeen: string;
  /** Set once `/agentic_review` was posted for this head, so it is asked at most once. */
  askedAt?: string;
}

export interface Counts {
  bugs: number;
  rules: number;
  requirements: number;
}

export type Severity = "High" | "Medium" | "Low";

export interface Finding {
  number: number;
  title: string;
  /** "Bug", "Rule violation", "Requirement gap"…, as Qodo labels it. */
  type: string;
  severity: Severity | null;
  /** Qodo's own resolution marks: struck through, Resolved, Dismissed or Outdated. */
  resolved: boolean;
  /** The finding's "View" link on Qodo, when it has one. */
  view: string | null;
}

export type Verdict =
  | { kind: "reviewed"; counts: Counts | null; findings: Finding[]; url: string }
  | { kind: "pending"; why: string; retrigger: boolean }
  | { kind: "gave-up"; why: string };

/** The command Qodo's own failure message asks for; also what a push re-review runs. */
export const RETRIGGER = "/agentic_review";
export const DEFAULT_BUDGET_MINUTES = 30;
/** How long a stale review is left for Qodo's own push review before asking. */
export const STALE_GRACE_MINUTES = 5;
export const MAX_WAIT_SECONDS = 480;
/**
 * How long Qodo's summary must have gone unedited before a finished-looking
 * review counts. Qodo rewrites the summary in place group by group, and an
 * intermediate edit already names the new head and reads "Nice, no open
 * findings for this group": on PR #26 the gate passed on such an edit, the
 * PR merged at 19:18:44, and the finished review, with a High finding,
 * landed at 19:18:59.
 */
export const DEFAULT_QUIET_MINUTES = 5;

const isQodo = (login: string | null): boolean => login !== null && /^qodo(-code-review|-merge)?(\[bot\])?$/i.test(login);

/** The finding counts line of a clean review, or null when it has none. */
export function countsOf(body: string): Counts | null {
  const count = (label: string): number | null => {
    const match = new RegExp(`${label} \\((\\d+)\\)`).exec(body);
    return match ? Number(match[1]) : null;
  };
  const bugs = count("Bugs");
  const rules = count("Rule violations");
  const requirements = count("Requirement gaps");
  return bugs === null || rules === null || requirements === null ? null : { bugs, rules, requirements };
}

/** Every commit a summary comment says it reviewed. */
export function reviewedCommits(body: string): string[] {
  return [...body.matchAll(/\/commit\/([0-9a-f]{40})\b/g)].map((m) => m[1]!);
}

const BADGE = /<img[^>]*(?:badge\/(High|Medium|Low)-|alt="(Action required|Remediation recommended|Advisory)")[^>]*>/g;
const ALT: Record<string, Severity> = { "Action required": "High", "Remediation recommended": "Medium", Advisory: "Low" };
const FINDING = /<summary>\s*(\d+)\.\s+([\s\S]*?)<\/summary>/g;
const strip = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * The numbered findings of a summary, each under the severity badge that
 * precedes it. Qodo groups findings by severity, each group opened by its
 * badge, so the last badge before a finding is its severity.
 */
export function findingsOf(body: string): Finding[] {
  const badges = [...body.matchAll(BADGE)].map((m) => ({ at: m.index!, severity: (m[1] as Severity | undefined) ?? ALT[m[2]!]! }));
  const matches = [...body.matchAll(FINDING)];
  return matches.map((match, i) => {
    const at = match.index!;
    const severity = badges.filter((b) => b.at < at).at(-1)?.severity ?? null;
    const summary = match[2]!;
    const type = /<code>([^<]*)<\/code>\s*$/.exec(summary.trim())?.[1] ?? "";
    // Its own block runs to the next finding; the "View" link sits at its end.
    const rest = body.slice(at, matches[i + 1]?.index);
    return {
      number: Number(match[1]),
      title: strip(summary.replace(/<code>[^<]*<\/code>\s*$/, "")),
      type: type.replace(/^[^A-Za-z]+/, "").trim(),
      severity,
      // Qodo's marks, not the words: a title may say "Outdated" and still be open.
      resolved: /<s>|<del>|[\u2713\u2717\u2296]\s*(?:Resolved|Dismissed|Outdated)/.test(summary),
      view: /\[View[^\]]*\]\((https:[^)]+)\)/.exec(rest)?.[1] ?? null,
    };
  });
}

/**
 * Whether a summary is a FINISHED review of `head`: it names the commit, it
 * is not a failed run, and it carries what only a finished review has — the
 * counts line, numbered findings, or "no issues found". A commit URL alone is
 * not enough (PR #26 review: an unfinished summary would have passed).
 */
export function finishedReviewOf(body: string, head: string): boolean {
  if (/something went wrong/i.test(body)) return false;
  if (!reviewedCommits(body).includes(head)) return false;
  // A clean re-review drops the counts line and says, per severity group,
  // "Nice, no open findings for this group" (PR #26, third review).
  return countsOf(body) !== null || findingsOf(body).length > 0 || /no issues found|no open findings/i.test(body);
}

/** What the PR's Qodo review says about its head. Pure; the test table is the contract. */
export function judge(
  state: PrState,
  seen: HeadSeen | null,
  now: Date,
  budgetMinutes: number = DEFAULT_BUDGET_MINUTES,
  quietMinutes: number = DEFAULT_QUIET_MINUTES,
): Verdict {
  const summary = [...state.comments].reverse().find((c) => isQodo(c.author) && c.body.includes("Code Review by Qodo"));
  const finished = summary !== undefined && finishedReviewOf(summary.body, state.head);
  const editedAt = Date.parse(summary?.updatedAt ?? summary?.createdAt ?? "");
  // An unknown edit time cannot prove the summary settled; it waits like a fresh edit.
  const settledFor = Number.isNaN(editedAt) ? 0 : (now.getTime() - editedAt) / 60_000;
  if (summary && finished && settledFor >= quietMinutes) {
    return { kind: "reviewed", counts: countsOf(summary.body), findings: findingsOf(summary.body), url: summary.url };
  }
  // The budget runs from when the head was first seen here, which is after it
  // was pushed; a commit's date can be hours earlier (local checks, review).
  const since = Date.parse(seen?.firstSeen ?? state.headAt);
  const minutes = Number.isNaN(since) ? 0 : (now.getTime() - since) / 60_000;
  const short = state.head.slice(0, 8);
  if (minutes > budgetMinutes) {
    return { kind: "gave-up", why: `no finished Qodo review of ${short} within ${budgetMinutes} minutes of first seeing it` };
  }
  const asked = seen?.askedAt !== undefined;
  if (!summary) return { kind: "pending", why: `Qodo has not commented on ${short} yet`, retrigger: false };
  if (finished) {
    const ago = Math.max(0, Math.round(settledFor * 60));
    return { kind: "pending", why: `Qodo edited its review of ${short} ${ago}s ago; waiting ${quietMinutes} min for it to settle`, retrigger: false };
  }
  if (/something went wrong/i.test(summary.body)) {
    return { kind: "pending", why: `Qodo's review failed${asked ? "; already asked again for this head" : ""}`, retrigger: !asked };
  }
  const stale = reviewedCommits(summary.body).length > 0 && !reviewedCommits(summary.body).includes(state.head);
  return {
    kind: "pending",
    why: stale ? `Qodo's last review covers an older commit, not ${short}` : `Qodo is still reviewing ${short}`,
    retrigger: stale && !asked && minutes >= STALE_GRACE_MINUTES,
  };
}

/** What the PR alone says about a head, for when the host-local record is unavailable. */
export function fallbackSeen(state: PrState): HeadSeen {
  const since = Date.parse(state.headAt);
  const ask = state.comments.find((c) => c.body.trim().startsWith(RETRIGGER) && Date.parse(c.createdAt) >= since);
  return { firstSeen: state.headAt, ...(ask ? { askedAt: ask.createdAt } : {}) };
}

/** The exit code a verdict maps to. */
export function exitOf(verdict: Verdict): number {
  if (verdict.kind === "reviewed") return verdict.findings.some((f) => !f.resolved) ? 1 : 0;
  return verdict.kind === "gave-up" ? 4 : 3;
}

export function render(pr: number, verdict: Verdict): string {
  if (verdict.kind === "gave-up") return `PR #${pr}: gave up waiting for Qodo — ${verdict.why}`;
  if (verdict.kind === "pending") return `PR #${pr}: Qodo review pending — ${verdict.why}`;
  const open = verdict.findings.filter((f) => !f.resolved);
  const lines = [
    open.length === 0
      ? `PR #${pr}: Qodo reviewed the head — no open findings`
      : `PR #${pr}: Qodo reviewed the head — ${open.length} open finding${open.length === 1 ? "" : "s"}`,
    `  summary: ${verdict.url}`,
  ];
  const c = verdict.counts;
  const by = (type: string) => verdict.findings.filter((f) => f.type.startsWith(type)).length;
  lines.push(
    c === null
      ? `  counts: ${by("Bug")} bugs, ${by("Rule")} rule violations, ${by("Requirement")} requirement gaps (from the findings)`
      : `  counts: ${c.bugs} bugs, ${c.rules} rule violations, ${c.requirements} requirement gaps`,
  );
  for (const f of open) {
    lines.push(`  ${f.number}. [${f.severity ?? "?"}] ${f.type || "finding"} — ${f.title}${f.view ? `\n     ${f.view}` : ""}`);
  }
  const resolved = verdict.findings.length - open.length;
  if (resolved > 0) lines.push(`  (${resolved} finding${resolved === 1 ? "" : "s"} marked resolved or dismissed by Qodo)`);
  return lines.join("\n");
}

function gh(args: string[]): string {
  const run = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`gh ${args[0]} failed: ${(run.stderr || run.error?.message || "").trim()}`);
  return run.stdout;
}

const retryDeps: RetryDeps = {
  sleep: (seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000)),
  random: Math.random,
};

/** When this run must have answered by: `--wait` plus one poll of slack. Set by `main`. */
let deadline = Number.POSITIVE_INFINITY;

function ghPatiently(args: string[], budget: RetryBudget): Promise<string> {
  const policy = retryPolicy(process.env);
  // Same cap as review-threads.ts, and never past the caller's --wait: a
  // throttle that outlasts it ends as exit 75 rather than overrunning.
  const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
  const capped = { ...policy, budgetSeconds: Math.min(policy.budgetSeconds, 60, left) };
  const classify = (error: unknown) => classifyRateLimit(error instanceof Error ? error.message : String(error));
  return withRateLimitRetry(async () => gh(args), classify, retryDeps, capped, budget);
}

/** `gh api --paginate --jq '.[] | …'` output: one JSON comment per line. */
export function parseComments(lines: string): IssueComment[] {
  return lines
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const c = JSON.parse(line) as { author?: string | null; body?: string; createdAt?: string; updatedAt?: string; url?: string };
      return {
        author: c.author ?? null,
        body: String(c.body ?? ""),
        createdAt: String(c.createdAt ?? ""),
        ...(c.updatedAt ? { updatedAt: String(c.updatedAt) } : {}),
        url: String(c.url ?? ""),
      };
    });
}

/** `gh pr view --json headRefOid,commits`, narrowed. Throws on a shape it does not know. */
export function parseHead(raw: string): { head: string; headAt: string } {
  const pr = JSON.parse(raw) as { headRefOid?: string; commits?: { committedDate?: string; oid?: string }[] };
  const last = pr.commits?.at(-1);
  if (typeof pr.headRefOid !== "string" || typeof last?.committedDate !== "string") {
    throw new Error("no pull request head in the answer; is the PR number right?");
  }
  return { head: pr.headRefOid, headAt: last.committedDate };
}

type SeenFile = Record<string, HeadSeen>;

/**
 * The host-local record of heads seen, in git's common directory beside the
 * claim leases. Unreadable or malformed reads as empty, and a failed write is
 * ignored: the worst case is a budget counted from the commit date and one
 * extra `/agentic_review`, never a stuck loop.
 */
export function seenStore(path: string | null) {
  const read = (): SeenFile => {
    if (path === null) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SeenFile) : {};
    } catch {
      return {};
    }
  };
  const write = (all: SeenFile): void => {
    if (path === null) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(tmp, path);
    } catch {
      // see above
    }
  };
  return {
    get: (key: string): HeadSeen | null => read()[key] ?? null,
    set: (key: string, value: HeadSeen): void => write({ ...read(), [key]: value }),
  };
}

function defaultSeenPath(): string | null {
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return run.status === 0 && run.stdout.trim() !== "" ? join(run.stdout.trim(), "ralph", "qodo-review.json") : null;
}

export interface Options {
  pr: number;
  repo: string | null;
  json: boolean;
  waitSeconds: number;
}

export function parseArgs(argv: string[]): Options | string {
  const usage = "usage: qodo-review.ts <pr> [--repo owner/name] [--wait <seconds>] [--json]";
  const options: Options = { pr: 0, repo: null, json: false, waitSeconds: 240 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") options.json = true;
    else if (arg === "--repo") {
      const repo = argv[++i];
      if (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return "--repo needs owner/name";
      options.repo = repo;
    } else if (arg === "--wait") {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) return "--wait needs a number of seconds";
      options.waitSeconds = Math.min(Number(raw), MAX_WAIT_SECONDS);
    } else if (/^\d+$/.test(arg) && options.pr === 0) options.pr = Number(arg);
    else return `unexpected argument: ${arg}\n${usage}`;
  }
  return options.pr === 0 ? usage : options;
}

export interface Io {
  read(pr: number, repo: string): Promise<PrState>;
  retrigger(pr: number, repo: string): Promise<void>;
  repo(): Promise<string>;
  seen: { get(key: string): HeadSeen | null; set(key: string, value: HeadSeen): void };
  sleep(seconds: number): Promise<void>;
  now(): Date;
  log(line: string): void;
}

const POLL_SECONDS = 30;

function minutesKnob(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = Number(env[name]);
  // A malformed knob falls back to the default, never to "no wait" or "forever".
  return env[name] !== undefined && env[name] !== "" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function budgetMinutes(env: Record<string, string | undefined>): number {
  const raw = minutesKnob(env, "RALPH_QODO_REVIEW_MINUTES", DEFAULT_BUDGET_MINUTES);
  return raw > 0 ? raw : DEFAULT_BUDGET_MINUTES;
}

export async function run(options: Options, io: Io, env: Record<string, string | undefined> = process.env): Promise<number> {
  const repo = options.repo ?? (await io.repo());
  const budget = budgetMinutes(env);
  const quiet = minutesKnob(env, "RALPH_QODO_QUIET_MINUTES", DEFAULT_QUIET_MINUTES);
  const started = io.now().getTime();
  for (;;) {
    const state = await io.read(options.pr, repo);
    const key = `${repo}#${options.pr}@${state.head}`;
    let seen = io.seen.get(key);
    if (seen === null) {
      io.seen.set(key, { firstSeen: io.now().toISOString() });
      // A store that cannot keep the record must not restart the budget, or
      // re-ask Qodo, on every poll: fall back to what GitHub itself shows —
      // the commit date, and any /agentic_review posted since (PR #26 review).
      seen = io.seen.get(key) ?? fallbackSeen(state);
    }
    const verdict = judge(state, seen, io.now(), budget, quiet);
    if (verdict.kind === "pending" && verdict.retrigger) {
      // Recorded only once the post succeeded: a post that failed is asked again next time.
      await io.retrigger(options.pr, repo);
      io.seen.set(key, { ...seen, askedAt: io.now().toISOString() });
      io.log(`qodo-review: asked Qodo to review PR #${options.pr} again (${RETRIGGER}): ${verdict.why}`);
    }
    const waited = (io.now().getTime() - started) / 1000;
    if (verdict.kind !== "pending" || waited + POLL_SECONDS > options.waitSeconds) {
      io.log(options.json ? JSON.stringify({ pr: options.pr, repo, ...verdict }) : render(options.pr, verdict));
      return exitOf(verdict);
    }
    await io.sleep(POLL_SECONDS);
  }
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    console.error(options);
    return 64;
  }
  const budget: RetryBudget = { waitedSeconds: 0 };
  deadline = Date.now() + (options.waitSeconds + POLL_SECONDS) * 1000;
  const io: Io = {
    repo: async () => (await ghPatiently(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], budget)).trim(),
    read: async (pr, repo) => {
      const { head, headAt } = parseHead(await ghPatiently(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,commits"], budget));
      // Every page: on a busy PR the summary can sit past the last hundred comments.
      const jq = ".[] | {author: .user.login, body, createdAt: .created_at, updatedAt: .updated_at, url: .html_url}";
      const comments = parseComments(await ghPatiently(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", jq], budget));
      return { head, headAt, comments };
    },
    retrigger: async (pr, repo) => {
      await ghPatiently(["pr", "comment", String(pr), "--repo", repo, "--body", RETRIGGER], budget);
    },
    seen: seenStore(defaultSeenPath()),
    sleep: retryDeps.sleep,
    now: () => new Date(),
    log: (line) => console.log(line),
  };
  try {
    return await run(options, io);
  } catch (error) {
    if (isRateLimited(error)) {
      console.error(`qodo-review: GitHub throttled a call and the wait outlasted its budget. ${error.message}`);
      return RATE_LIMITED_EXIT;
    }
    console.error(`qodo-review: ${error instanceof Error ? error.message : String(error)}`);
    return 5;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
