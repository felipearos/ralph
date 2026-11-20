#!/usr/bin/env bun
/**
 * The review threads on a pull request that still want an answer.
 *
 * Reviewers — Codex's GitHub connector above all — leave their findings as
 * inline review threads, and `gh pr view --comments` does not show those. So a
 * loop that "worked the review findings" from the PR's conversation never saw
 * them: between 2026-10-05 and 10-09 the loggd loops merged PRs with 52 of 74
 * Codex threads unanswered, 11 of them P1. This lists them, so §1 and §5 of
 * `prompt.md` can make answering every one a condition of the merge.
 *
 * A thread is OPEN when it is not resolved and nobody has replied since the
 * reviewer last spoke: its latest comment is not by the account the loop
 * posts as. A thread that account opened itself (the operator's own inline
 * note, written as the same user the loops post as) is open until somebody
 * replies to it. Outdated threads — the code moved under them, usually a
 * rebase — still count: the finding may still hold, and the reply says
 * whether it does.
 *
 *   bun review-threads.ts <pr> [--repo owner/name] [--json]
 *
 * Exit codes are the contract; the prompt reads them:
 *   0  no open threads
 *   1  open threads, listed on stdout
 *   5  unreadable — `gh` failed or answered something unexpected
 *  64  usage
 *  75  GitHub throttled the read; the tool already waited out its budget — retry later
 *
 * GitHub's GraphQL limit is shared by every loop on the account, and its
 * secondary limit answers `API rate limit already exceeded` while
 * `gh api rate_limit` still shows budget (PR #656, #658). As exit 5 that read
 * as "unreadable", and the prompt re-ran it at once into the same throttle.
 * So a throttle is waited out here on the frontier's retry policy, and only
 * when it outlasts that budget does the tool exit 75, which the prompt hands
 * back to the supervisor as a wait.
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

export interface ThreadComment {
  author: string | null;
  body: string;
  url: string;
  databaseId: number;
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: number;
  first: ThreadComment;
  latest: ThreadComment;
}

export interface OpenThread {
  /** The opening comment's id: `pulls/<pr>/comments/<id>/replies` answers it. */
  id: number;
  /** The reviewer's priority badge, `P1`–`P3`, or null when it carries none. */
  priority: string | null;
  title: string;
  path: string;
  line: number | null;
  outdated: boolean;
  reviewer: string | null;
  url: string;
}

/**
 * Codex marks a finding with a `![P1 Badge](…)` image. The Claude PR review
 * (the client repos' `revision-claude.yml`) writes the same shields.io badge,
 * but its comments arrive with the alt text emptied — `![](…/badge/P2-orange…)`
 * — so the badge URL counts as well. Other reviewers carry none.
 */
export function priorityOf(body: string): string | null {
  return (
    /!\[(P[0-3]) Badge\]/.exec(body)?.[1] ??
    /!\[[^\]]*\]\(https:\/\/img\.shields\.io\/badge\/(P[0-3])-/.exec(body)?.[1] ??
    null
  );
}

/** The finding's headline: its first bold run, else its first line of text. */
export function titleOf(body: string): string {
  const bold = /\*\*([^*]+?)\*\*/.exec(body.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<[^>]+>/g, ""));
  const text = bold?.[1]?.trim() || body.split("\n").find((line) => line.trim() !== "")?.trim() || "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Which threads still want an answer from `self`. Pure; the test table is the contract. */
export function openThreads(threads: ReviewThread[], self: string): OpenThread[] {
  return threads
    .filter((thread) => {
      if (thread.isResolved) return false;
      // The operator's own note, posted as the loops' account: open until a reply.
      if (thread.first.author === self) return thread.comments === 1;
      return thread.latest.author !== self;
    })
    .map((thread) => ({
      id: thread.first.databaseId,
      priority: priorityOf(thread.first.body),
      title: titleOf(thread.first.body),
      path: thread.path,
      line: thread.line,
      outdated: thread.isOutdated,
      reviewer: thread.first.author,
      url: thread.first.url,
    }));
}

const QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) { totalCount nodes { ...c } }
          last: comments(last: 1) { nodes { ...c } }
        }
      }
    }
  }
}
fragment c on PullRequestReviewComment { author { login } body url databaseId }
`;

type RawComment = { author: { login: string } | null; body: string; url: string; databaseId: number };
type RawThread = {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: { totalCount: number; nodes: RawComment[] };
  last: { nodes: RawComment[] };
};

const comment = (raw: RawComment): ThreadComment => ({
  author: raw.author?.login ?? null,
  body: raw.body,
  url: raw.url,
  databaseId: raw.databaseId,
});

/** One page of the GraphQL answer, narrowed. Throws on a shape it does not know. */
export function parsePage(raw: string): {
  viewer: string;
  threads: ReviewThread[];
  next: string | null;
} {
  const parsed = JSON.parse(raw) as {
    data?: {
      viewer?: { login?: string };
      repository?: {
        pullRequest?: {
          reviewThreads?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawThread[] };
        } | null;
      };
    };
  };
  const viewer = parsed.data?.viewer?.login;
  const page = parsed.data?.repository?.pullRequest?.reviewThreads;
  if (!viewer || !page) throw new Error("no reviewThreads in the answer; is the PR number right?");
  const threads = page.nodes.flatMap((node): ReviewThread[] => {
    const first = node.comments.nodes[0];
    const latest = node.last.nodes[0];
    if (!first || !latest) return [];
    return [
      {
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        line: node.line ?? node.originalLine,
        comments: node.comments.totalCount,
        first: comment(first),
        latest: comment(latest),
      },
    ];
  });
  return { viewer, threads, next: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null };
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

const classifyGhFailure = (error: unknown) => classifyRateLimit(error instanceof Error ? error.message : String(error));

/**
 * The most seconds one run sleeps on a throttle, whatever the frontier's
 * budget says. The model runs this tool through a Bash call whose default
 * timeout is 120 s; the frontier's default budget is 120 s of sleep alone, so
 * a throttle that spent it would be killed before it could exit 75, and the
 * model would see a bare timeout and re-run into the same throttle.
 */
const MAX_WAIT_SECONDS = 60;

/**
 * One `gh` read that rides out a throttle. The budget is the whole run's, so
 * the repo lookup and every thread page together wait at most the policy's
 * budget, never once per call.
 */
function ghPatiently(args: string[], budget: RetryBudget): Promise<string> {
  const policy = retryPolicy(process.env);
  const capped = { ...policy, budgetSeconds: Math.min(policy.budgetSeconds, MAX_WAIT_SECONDS) };
  return withRateLimitRetry(async () => gh(args), classifyGhFailure, retryDeps, capped, budget);
}

async function readThreads(pr: number, repo: string, budget: RetryBudget): Promise<{ viewer: string; threads: ReviewThread[] }> {
  const [owner, name] = repo.split("/");
  const threads: ReviewThread[] = [];
  let viewer = "";
  let after: string | null = null;
  // A PR with more than a few hundred threads is not one a loop should merge
  // on its own anyway; the cap only keeps a malformed cursor from looping.
  for (let page = 0; page < 10; page++) {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`];
    if (after !== null) args.push("-F", `after=${after}`);
    const read = parsePage(await ghPatiently(args, budget));
    viewer = read.viewer;
    threads.push(...read.threads);
    after = read.next;
    if (after === null) break;
  }
  return { viewer, threads };
}

export function render(pr: number, repo: string, open: OpenThread[]): string {
  if (open.length === 0) return `PR #${pr}: no open review threads`;
  const lines = [`PR #${pr}: ${open.length} open review thread${open.length === 1 ? "" : "s"}`];
  for (const thread of open) {
    const where = `${thread.path}${thread.line === null ? "" : `:${thread.line}`}`;
    lines.push(
      `  ${thread.priority ?? "--"} ${where}${thread.outdated ? " (outdated)" : ""} — ${thread.title}`,
      `     by ${thread.reviewer ?? "unknown"} · ${thread.url}`,
      `     reply: gh api repos/${repo}/pulls/${pr}/comments/${thread.id}/replies -F body=@<file>`,
    );
  }
  return lines.join("\n");
}

export function parseArgs(argv: string[]): { pr: number; repo: string | null; json: boolean } | string {
  let pr: number | null = null;
  let repo: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--repo") {
      repo = argv[++i] ?? null;
      if (repo === null || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return "--repo needs owner/name";
    } else if (/^\d+$/.test(arg) && pr === null) pr = Number(arg);
    else return `unexpected argument: ${arg}`;
  }
  if (pr === null) return "usage: review-threads.ts <pr> [--repo owner/name] [--json]";
  return { pr, repo, json };
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    console.error(options);
    return 64;
  }
  const budget: RetryBudget = { waitedSeconds: 0 };
  try {
    const repo =
      options.repo ??
      (await ghPatiently(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], budget)).trim();
    const { viewer, threads } = await readThreads(options.pr, repo, budget);
    const open = openThreads(threads, viewer);
    console.log(options.json ? JSON.stringify({ pr: options.pr, repo, self: viewer, open }) : render(options.pr, repo, open));
    return open.length === 0 ? 0 : 1;
  } catch (error) {
    if (isRateLimited(error)) {
      // Not "unreadable": the read is fine, GitHub asked us to come back later.
      // The message already carries the wait the retry gave up on.
      console.error(`review-threads: GitHub throttled the read and the wait outlasted its budget. ${error.message}`);
      return RATE_LIMITED_EXIT;
    }
    console.error(`review-threads: ${error instanceof Error ? error.message : String(error)}`);
    return 5;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
