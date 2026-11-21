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
 * So this reads the summary comment and says whether it covers the PR head:
 * a finished review embeds the reviewed commit's URL. A failed review, or one
 * of an older commit, is asked again with `/agentic_review`, once per head.
 * The wait is bounded (house rule 1): past `RALPH_QODO_REVIEW_MINUTES` (30)
 * from the head commit, the tool stops waiting and says so, and the prompt
 * hands the PR to a person rather than merging it unreviewed.
 *
 *   bun qodo-review.ts <pr> [--repo owner/name] [--wait <seconds>] [--json]
 *
 * `--wait` polls every 30 s for at most that long (default 240, at most 540:
 * the model runs this in a Bash call with a 10-minute ceiling) before
 * answering "pending". Exit codes are the contract; the prompt reads them:
 *   0  the review covers the head; its finding counts are printed
 *   3  pending — no finished review of the head yet; run it again
 *   4  gave up — no review of the head within the budget; hand the PR to a person
 *   5  unreadable — `gh` failed or answered something unexpected
 *  64  usage
 *  75  GitHub throttled the read past its budget — retry later
 */
import { spawnSync } from "node:child_process";
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
  url: string;
}

export interface PrState {
  head: string;
  /** When the head commit was committed: the review budget runs from it. */
  headAt: string;
  /** The account the loop posts as. */
  self: string;
  comments: IssueComment[];
}

export interface Counts {
  bugs: number;
  rules: number;
  requirements: number;
}

export type Verdict =
  | { kind: "reviewed"; counts: Counts | null; url: string }
  | { kind: "pending"; why: string; retrigger: boolean }
  | { kind: "gave-up"; why: string };

/** The command Qodo's own failure message asks for; also what a push re-review runs. */
export const RETRIGGER = "/agentic_review";
export const DEFAULT_BUDGET_MINUTES = 30;
/** How long after a push a stale review is left for Qodo's own push review before asking. */
export const STALE_GRACE_MINUTES = 5;

const isQodo = (login: string | null): boolean => login !== null && /^qodo(-code-review|-merge)?(\[bot\])?$/i.test(login);

/** The finding counts on the summary's first line, or null when it has none (a failed or unfinished run). */
export function countsOf(body: string): Counts | null {
  const n = (label: string) => /\((\d+)\)/.exec(body.slice(body.indexOf(label)))?.[1];
  if (!body.includes("Bugs (") || !body.includes("Rule violations (") || !body.includes("Requirement gaps (")) return null;
  return { bugs: Number(n("Bugs (")), rules: Number(n("Rule violations (")), requirements: Number(n("Requirement gaps (")) };
}

/** Every commit a summary comment says it reviewed. */
export function reviewedCommits(body: string): string[] {
  return [...body.matchAll(/\/commit\/([0-9a-f]{40})\b/g)].map((m) => m[1]!);
}

/** What the PR's Qodo review says about its head. Pure; the test table is the contract. */
export function judge(state: PrState, now: Date, budgetMinutes: number = DEFAULT_BUDGET_MINUTES): Verdict {
  const summary = [...state.comments].reverse().find((c) => isQodo(c.author) && c.body.includes("Code Review by Qodo"));
  if (summary && reviewedCommits(summary.body).includes(state.head)) {
    return { kind: "reviewed", counts: countsOf(summary.body), url: summary.url };
  }
  const headAt = Date.parse(state.headAt);
  const minutes = Number.isNaN(headAt) ? 0 : (now.getTime() - headAt) / 60_000;
  const short = state.head.slice(0, 8);
  if (minutes > budgetMinutes) {
    return { kind: "gave-up", why: `no finished Qodo review of ${short} within ${budgetMinutes} minutes of the commit` };
  }
  const asked = state.comments.some(
    (c) => c.author === state.self && c.body.trim().startsWith(RETRIGGER) && Date.parse(c.createdAt) >= headAt,
  );
  if (!summary) return { kind: "pending", why: `Qodo has not commented on ${short} yet`, retrigger: false };
  if (/something went wrong/i.test(summary.body)) {
    return { kind: "pending", why: `Qodo's review failed${asked ? "; already asked again for this head" : ""}`, retrigger: !asked };
  }
  const stale = reviewedCommits(summary.body).length > 0;
  return {
    kind: "pending",
    why: stale ? `Qodo's last review covers an older commit, not ${short}` : `Qodo is still reviewing ${short}`,
    retrigger: stale && !asked && minutes >= STALE_GRACE_MINUTES,
  };
}

export function render(pr: number, verdict: Verdict): string {
  if (verdict.kind === "reviewed") {
    const c = verdict.counts;
    const found = c === null ? "finding counts unreadable" : `${c.bugs} bugs, ${c.rules} rule violations, ${c.requirements} requirement gaps`;
    return [
      `PR #${pr}: Qodo reviewed the head — ${found}`,
      `  summary: ${verdict.url}`,
      "  inline findings are review threads: answer them as review-threads.ts lists them.",
    ].join("\n");
  }
  if (verdict.kind === "gave-up") return `PR #${pr}: gave up waiting for Qodo — ${verdict.why}`;
  return `PR #${pr}: Qodo review pending — ${verdict.why}`;
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

function ghPatiently(args: string[], budget: RetryBudget): Promise<string> {
  const policy = retryPolicy(process.env);
  // Same cap as review-threads.ts: the Bash call running this must outlive the wait.
  const capped = { ...policy, budgetSeconds: Math.min(policy.budgetSeconds, 60) };
  const classify = (error: unknown) => classifyRateLimit(error instanceof Error ? error.message : String(error));
  return withRateLimitRetry(async () => gh(args), classify, retryDeps, capped, budget);
}

const QUERY = `
query($owner: String!, $name: String!, $pr: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      headRefOid
      commits(last: 1) { nodes { commit { committedDate } } }
      comments(last: 100) { nodes { author { login } body createdAt url } }
    }
  }
}`;

/** The GraphQL answer, narrowed. Throws on a shape it does not know. */
export function parseState(raw: string): PrState {
  const data = (JSON.parse(raw) as { data?: any }).data;
  const pr = data?.repository?.pullRequest;
  const self = data?.viewer?.login;
  const headAt = pr?.commits?.nodes?.[0]?.commit?.committedDate;
  if (!pr || typeof self !== "string" || typeof pr.headRefOid !== "string" || typeof headAt !== "string") {
    throw new Error("no pull request in the answer; is the PR number right?");
  }
  const comments = (pr.comments?.nodes ?? []).map(
    (c: any): IssueComment => ({ author: c.author?.login ?? null, body: String(c.body ?? ""), createdAt: String(c.createdAt), url: String(c.url) }),
  );
  return { head: pr.headRefOid, headAt, self, comments };
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
      options.waitSeconds = Math.min(Number(raw), 540);
    } else if (/^\d+$/.test(arg) && options.pr === 0) options.pr = Number(arg);
    else return `unexpected argument: ${arg}\n${usage}`;
  }
  return options.pr === 0 ? usage : options;
}

export interface Io {
  read(pr: number, repo: string): Promise<PrState>;
  retrigger(pr: number, repo: string): Promise<void>;
  repo(): Promise<string>;
  sleep(seconds: number): Promise<void>;
  now(): Date;
  log(line: string): void;
}

const POLL_SECONDS = 30;

function budgetMinutes(env: Record<string, string | undefined>): number {
  const raw = Number(env.RALPH_QODO_REVIEW_MINUTES);
  // A malformed knob falls back to the default, never to "no wait" or "forever".
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_MINUTES;
}

export async function run(options: Options, io: Io, env: Record<string, string | undefined> = process.env): Promise<number> {
  const repo = options.repo ?? (await io.repo());
  const budget = budgetMinutes(env);
  const started = io.now().getTime();
  for (;;) {
    const verdict = judge(await io.read(options.pr, repo), io.now(), budget);
    if (verdict.kind === "pending" && verdict.retrigger) {
      await io.retrigger(options.pr, repo);
      io.log(`qodo-review: asked Qodo to review PR #${options.pr} again (${RETRIGGER}): ${verdict.why}`);
    }
    const waited = (io.now().getTime() - started) / 1000;
    if (verdict.kind !== "pending" || waited + POLL_SECONDS > options.waitSeconds) {
      io.log(options.json ? JSON.stringify({ pr: options.pr, repo, ...verdict }) : render(options.pr, verdict));
      return verdict.kind === "reviewed" ? 0 : verdict.kind === "gave-up" ? 4 : 3;
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
  const io: Io = {
    repo: async () => (await ghPatiently(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], budget)).trim(),
    read: async (pr, repo) => {
      const [owner, name] = repo.split("/");
      return parseState(await ghPatiently(["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`], budget));
    },
    retrigger: async (pr, repo) => {
      gh(["pr", "comment", String(pr), "--repo", repo, "--body", RETRIGGER]);
    },
    sleep: retryDeps.sleep,
    now: () => new Date(),
    log: (line) => console.log(line),
  };
  try {
    return await run(options, io);
  } catch (error) {
    if (isRateLimited(error)) {
      console.error(`qodo-review: GitHub throttled the read and the wait outlasted its budget. ${error.message}`);
      return RATE_LIMITED_EXIT;
    }
    console.error(`qodo-review: ${error instanceof Error ? error.message : String(error)}`);
    return 5;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
