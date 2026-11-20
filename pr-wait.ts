#!/usr/bin/env bun
/**
 * Wait on a pull request for the SUPERVISOR, so no model turn is spent doing it.
 *
 * An iteration used to block on CI and on the merge queue inside its own
 * `claude -p` session. Every poll there is a model turn, and every turn
 * re-reads the whole context: on 2026-09-18/19 the four loops spent 571 turns
 * on `sleep N; check`, at ~480K tokens of context each. The work was
 * deterministic, so it moved here. The session ends with
 * `<ralph>AWAIT_PR <pr> ci|merge</ralph>`, `ralph.sh` runs this, and a FRESH
 * session picks the outcome up with none of the implementation context.
 *
 * Two modes, named by the sigil:
 *
 *   ci     the head commit's required checks (`requiredChecks` in the project
 *          config, exported as RALPH_REQUIRED_CHECKS) until none is pending.
 *          Only the required ones: a merge queue posts check-runs of its own
 *          that stay pending by design, and waiting on those would wait out
 *          the deadline every time. With no list configured, every check
 *          counts. A PR that enters the queue meanwhile (a queue rule that
 *          enqueues settled PRs by itself) switches to merge mode.
 *   merge  the queue, exactly as `merge-wait.ts` judges it — this reuses its
 *          `judge`, so the two cannot disagree about what `dequeued` means.
 *
 * `--head <sha>` is the commit the session pushed. For a minute after a push
 * GitHub can still report the previous head, whose checks are green; a wait
 * that read those would hand the next session a false green. A head that
 * never matches is its own outcome rather than a guess.
 *
 * The output is one JSON object on stdout — the outcome and the evidence the
 * next session needs (failing checks and their links) — and the exit status is
 * 0 for every outcome, because every outcome is an answer. 64 is a usage
 * error. Progress goes to stderr. Always exits by itself.
 *
 * `gh pr view` is GraphQL, and GraphQL has its own quota. On 2026-11-04 the
 * loops exhausted it while PR #697 sat green: every read failed, the wait gave
 * up as `unreadable`, and REST would have answered all along. So a read that
 * GraphQL refuses for its rate limit is made again over REST (the PR, its head's
 * check-runs and its legacy status contexts), and when that fails too the
 * outcome names when the GraphQL quota resets, so the next session knows the
 * PR was never judged rather than guessing at why.
 */
import { spawnSync } from "node:child_process";

import {
  DEFAULT_DEQUEUED_LABEL,
  DEFAULT_GRACE_POLLS,
  DEFAULT_QUEUED_LABEL,
  MAX_CONSECUTIVE_FAILURES,
  judge,
  type Labels,
  type Progress,
} from "./merge-wait";

export type Mode = "ci" | "merge";
export type Outcome =
  | "green"
  | "red"
  | "no-checks"
  | "head-mismatch"
  | "merged"
  | "dequeued"
  | "closed"
  | "timeout"
  | "unreadable";

export type CheckState = "pass" | "fail" | "pending" | "skip";

export interface Check {
  name: string;
  state: CheckState;
  url: string | null;
}

export interface PrSnapshot {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  labels: string[];
  head: string;
  checks: Check[];
}

export interface WaitResult {
  outcome: Outcome;
  mode: Mode;
  pr: string;
  head: string | null;
  polls: number;
  elapsedSeconds: number;
  /** The checks the verdict was judged on, required ones only when configured. */
  checks: Check[];
  detail: string;
  /** When GitHub's GraphQL quota resets, if an exhausted quota is why the PR went unreadable. */
  resetAt?: string;
}

export const DEFAULT_CI_TIMEOUT_SECONDS = 1500;
export const DEFAULT_QUEUE_TIMEOUT_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 60;

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** One `statusCheckRollup` entry: a CheckRun or a legacy StatusContext. */
export function parseCheck(raw: unknown): Check | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.__typename === "StatusContext" || ("context" in entry && !("name" in entry))) {
    const name = text(entry.context);
    if (name === null) return null;
    const state = text(entry.state);
    return {
      name,
      state: state === "SUCCESS" ? "pass" : state === "FAILURE" || state === "ERROR" ? "fail" : "pending",
      url: text(entry.targetUrl),
    };
  }
  const name = text(entry.name);
  if (name === null) return null;
  const url = text(entry.detailsUrl);
  if (entry.status !== "COMPLETED") return { name, state: "pending", url };
  const conclusion = text(entry.conclusion);
  if (conclusion === "SUCCESS") return { name, state: "pass", url };
  if (conclusion === "NEUTRAL" || conclusion === "SKIPPED") return { name, state: "skip", url };
  if (conclusion !== null && FAILED_CONCLUSIONS.has(conclusion)) return { name, state: "fail", url };
  return { name, state: "pending", url };
}

/** Label names, or null when one is not a `{ name }` — GraphQL and REST spell labels alike. */
function labelNames(labels: readonly unknown[]): string[] | null {
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === "object" && label !== null ? (label as Record<string, unknown>).name : null;
    if (typeof name !== "string") return null;
    names.push(name);
  }
  return names;
}

/** `gh pr view --json state,mergedAt,labels,headRefOid,statusCheckRollup`, or null. */
export function parseSnapshot(raw: string): PrSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { state, mergedAt, labels, headRefOid, statusCheckRollup } = parsed as Record<string, unknown>;
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") return null;
  if (!Array.isArray(labels)) return null;
  const names = labelNames(labels);
  if (names === null) return null;
  const checks: Check[] = [];
  for (const entry of Array.isArray(statusCheckRollup) ? statusCheckRollup : []) {
    const check = parseCheck(entry);
    if (check !== null) checks.push(check);
  }
  return {
    state,
    mergedAt: text(mergedAt),
    labels: names,
    head: text(headRefOid) ?? "",
    checks,
  };
}

/**
 * The checks a CI verdict is judged on. A required check that has not reported
 * yet is pending, not absent: CI registers its checks some seconds after the
 * push, and "not there" must not read as "nothing to wait for".
 */
export function relevantChecks(checks: readonly Check[], required: readonly string[]): Check[] {
  if (required.length === 0) return [...checks];
  return required.map(
    (name) => checks.find((check) => check.name === name) ?? { name, state: "pending" as const, url: null },
  );
}

export type CiVerdict = "green" | "red" | "no-checks" | "wait";

/** What one read of the head commit's checks means. Pure; the test table is the contract. */
export function judgeCi(checks: readonly Check[], polls: number, gracePolls: number): CiVerdict {
  if (checks.length === 0) return polls >= gracePolls ? "no-checks" : "wait";
  if (checks.some((check) => check.state === "pending")) return "wait";
  return checks.some((check) => check.state === "fail") ? "red" : "green";
}

export interface Options {
  pr: string;
  mode: Mode;
  repo: string | null;
  head: string | null;
  required: string[];
  ciTimeoutSeconds: number;
  queueTimeoutSeconds: number;
  intervalSeconds: number;
  gracePolls: number;
  labels: Labels;
}

const USAGE =
  "usage: pr-wait.ts <pr> [--mode ci|merge] [--head sha] [--repo owner/name] [--required name]... " +
  "[--ci-timeout s] [--queue-timeout s] [--interval s] [--grace polls]";

const requiredFromEnv = (): string[] =>
  (process.env.RALPH_REQUIRED_CHECKS ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);

/** Parsed options, or the usage error as a string. */
export function parseArgs(argv: string[]): Options | string {
  const options: Options = {
    pr: "",
    mode: "ci",
    repo: process.env.RALPH_PROJECT_REPO?.trim() || null,
    head: null,
    required: [],
    ciTimeoutSeconds: DEFAULT_CI_TIMEOUT_SECONDS,
    queueTimeoutSeconds: DEFAULT_QUEUE_TIMEOUT_SECONDS,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    gracePolls: DEFAULT_GRACE_POLLS,
    labels: { queued: DEFAULT_QUEUED_LABEL, dequeued: DEFAULT_DEQUEUED_LABEL },
  };
  let requiredGiven = false;
  const number = (flag: string, value: string | undefined): number | string => {
    const parsed = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0) {
      return `${flag} needs a non-negative number, got ${value === undefined ? "nothing" : JSON.stringify(value)}`;
    }
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    const take = (): string | undefined => {
      i += 1;
      return value;
    };
    switch (arg) {
      case "--mode":
        if (value !== "ci" && value !== "merge") return `--mode must be ci or merge, got ${JSON.stringify(value)}`;
        options.mode = value;
        take();
        break;
      case "--head":
        if (!value) return "--head needs a commit sha";
        options.head = take()!;
        break;
      case "--repo":
        if (!value) return "--repo needs owner/name";
        options.repo = take()!;
        break;
      case "--required":
        if (!value) return "--required needs a check name";
        options.required.push(take()!);
        requiredGiven = true;
        break;
      case "--ci-timeout":
      case "--queue-timeout":
      case "--interval":
      case "--grace": {
        const parsed = number(arg, value);
        if (typeof parsed === "string") return parsed;
        take();
        if (arg === "--ci-timeout") options.ciTimeoutSeconds = parsed;
        else if (arg === "--queue-timeout") options.queueTimeoutSeconds = parsed;
        else if (arg === "--interval") options.intervalSeconds = parsed;
        else options.gracePolls = parsed;
        break;
      }
      default:
        if (arg.startsWith("-")) return `unknown flag ${arg}`;
        if (options.pr !== "") return `one pull request at a time, got ${options.pr} and ${arg}`;
        options.pr = arg;
    }
  }
  if (options.pr === "") return "which pull request? pass its number";
  if (!requiredGiven) options.required = requiredFromEnv();
  return options;
}

/**
 * A read, and whether it went over REST. `resetAt` is when the GraphQL quota
 * resets, set only when that quota refused the read and REST failed as well.
 */
export type Read =
  | { ok: true; snapshot: PrSnapshot; via?: "rest" }
  | { ok: false; error: string; via?: "rest"; resetAt?: string };

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type Gh = (args: string[]) => GhResult;

export const runGh: Gh = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};

/** stdout of a successful gh call, or why it failed. */
const call = (gh: Gh, args: string[]): { ok: true; stdout: string } | { ok: false; error: string } => {
  const result = gh(args);
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `gh exited ${result.status}`).trim() };
  }
  return { ok: true, stdout: result.stdout };
};

/** GraphQL's primary and secondary rate limits, as gh reports them. */
export const isRateLimited = (error: string): boolean => /rate limit|submitted too quickly/i.test(error);

const json = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const upper = (value: unknown): string | null => (typeof value === "string" ? value.toUpperCase() : null);

/**
 * The REST answers, as one snapshot, or null. REST spells statuses and
 * conclusions lowercase; they are uppercased into the GraphQL shape so
 * `parseCheck` stays the only rule table.
 */
export function parseRestSnapshot(pullRaw: string, runsRaw: string, statusRaw: string): PrSnapshot | null {
  const pull = json(pullRaw);
  const runs = json(runsRaw);
  const status = json(statusRaw);
  if (pull === null || runs === null || status === null) return null;
  const head = (pull.head as Record<string, unknown> | null | undefined)?.sha;
  if (typeof head !== "string" || head === "") return null;
  const mergedAt = text(pull.merged_at);
  const state = mergedAt !== null ? "MERGED" : pull.state === "closed" ? "CLOSED" : pull.state === "open" ? "OPEN" : null;
  if (state === null || !Array.isArray(pull.labels)) return null;
  const names = labelNames(pull.labels);
  if (names === null) return null;
  if (!Array.isArray(runs.check_runs) || !Array.isArray(status.statuses)) return null;
  const checks: Check[] = [];
  for (const raw of runs.check_runs) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const check = parseCheck({
      __typename: "CheckRun",
      name: entry.name,
      status: upper(entry.status),
      conclusion: upper(entry.conclusion),
      detailsUrl: entry.details_url,
    });
    if (check !== null) checks.push(check);
  }
  for (const raw of status.statuses) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const check = parseCheck({
      __typename: "StatusContext",
      context: entry.context,
      state: upper(entry.state),
      targetUrl: entry.target_url,
    });
    if (check !== null) checks.push(check);
  }
  return { state, mergedAt, labels: names, head, checks };
}

/** The same snapshot over REST, which has its own quota. */
export function readRestSnapshot(pr: string, repo: string | null, gh: Gh = runGh): Read {
  // gh api fills {owner}/{repo} from the checkout's remote, as `gh pr view` does without --repo.
  const base = `repos/${repo ?? "{owner}/{repo}"}`;
  const pull = call(gh, ["api", `${base}/pulls/${pr}`]);
  if (!pull.ok) return { ok: false, error: pull.error, via: "rest" };
  const sha = (json(pull.stdout)?.head as Record<string, unknown> | null | undefined)?.sha;
  if (typeof sha !== "string" || sha === "") {
    return { ok: false, error: `unparseable gh api output: ${pull.stdout.trim().slice(0, 200)}`, via: "rest" };
  }
  const runs = call(gh, ["api", `${base}/commits/${sha}/check-runs?per_page=100`]);
  if (!runs.ok) return { ok: false, error: runs.error, via: "rest" };
  const status = call(gh, ["api", `${base}/commits/${sha}/status`]);
  if (!status.ok) return { ok: false, error: status.error, via: "rest" };
  const snapshot = parseRestSnapshot(pull.stdout, runs.stdout, status.stdout);
  if (snapshot === null) return { ok: false, error: "unparseable gh api output for the PR's checks", via: "rest" };
  return { ok: true, snapshot, via: "rest" };
}

/** When the exhausted GraphQL quota resets, as ISO; `rate_limit` does not count against any quota. Null when unknown or not exhausted. */
export function graphqlResetAt(gh: Gh = runGh): string | null {
  const got = call(gh, ["api", "rate_limit"]);
  if (!got.ok) return null;
  const resources = json(got.stdout)?.resources as Record<string, unknown> | null | undefined;
  const graphql = resources?.graphql as Record<string, unknown> | null | undefined;
  // A secondary limit refuses reads with quota left, and lifts in about a
  // minute: naming the quota's hourly reset then would send the next session
  // to wait out a block that is already gone.
  if (graphql?.remaining !== 0) return null;
  const reset = graphql.reset;
  if (typeof reset !== "number" || !Number.isFinite(reset)) return null;
  const date = new Date(reset * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.000Z$/, "Z");
}

export function readSnapshot(pr: string, repo: string | null, gh: Gh = runGh): Read {
  const args = ["pr", "view", pr, "--json", "state,mergedAt,labels,headRefOid,statusCheckRollup"];
  if (repo !== null) args.push("--repo", repo);
  const got = call(gh, args);
  if (!got.ok) {
    if (!isRateLimited(got.error)) return got;
    const rest = readRestSnapshot(pr, repo, gh);
    if (rest.ok) return rest;
    const resetAt = graphqlResetAt(gh);
    return resetAt === null ? rest : { ...rest, resetAt };
  }
  const snapshot = parseSnapshot(got.stdout);
  if (snapshot === null) return { ok: false, error: `unparseable gh output: ${got.stdout.trim().slice(0, 200)}` };
  return { ok: true, snapshot };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function wait(options: Options, read: typeof readSnapshot = readSnapshot): Promise<WaitResult> {
  const started = Date.now();
  let mode: Mode = options.mode;
  let deadline = started + (mode === "ci" ? options.ciTimeoutSeconds : options.queueTimeoutSeconds) * 1000;
  const queue: Progress = { polls: 0, sawQueued: false };
  let ciPolls = 0;
  let mismatchPolls = 0;
  let failures = 0;
  let last: PrSnapshot | null = null;
  const elapsed = (): number => Math.round((Date.now() - started) / 1000);
  const result = (outcome: Outcome, detail: string): WaitResult => ({
    outcome,
    mode,
    pr: options.pr,
    head: last?.head || null,
    polls: queue.polls + ciPolls,
    elapsedSeconds: elapsed(),
    checks: last === null ? [] : relevantChecks(last.checks, options.required),
    detail,
  });

  for (;;) {
    const got = read(options.pr, options.repo);
    if (got.via === "rest") {
      console.error(`pr-wait: #${options.pr} GraphQL is rate limited — ${got.ok ? "read over REST" : "REST failed too"}`);
    }
    if (!got.ok) {
      failures += 1;
      console.error(`pr-wait: #${options.pr} unreadable (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${got.error}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        if (got.resetAt !== undefined) {
          return {
            ...result(
              "unreadable",
              `GitHub's GraphQL quota is exhausted until ${got.resetAt} and the REST read failed too: ${got.error}`,
            ),
            resetAt: got.resetAt,
          };
        }
        return result("unreadable", `gh failed ${failures} times in a row: ${got.error}`);
      }
    } else {
      failures = 0;
      const snapshot = got.snapshot;
      last = snapshot;
      if (snapshot.state === "MERGED") return result("merged", `merged ${snapshot.mergedAt ?? ""}`.trim());
      if (snapshot.state === "CLOSED") return result("closed", `#${options.pr} was closed without merging`);

      if (mode === "ci" && snapshot.labels.includes(options.labels.queued)) {
        mode = "merge";
        deadline = Date.now() + options.queueTimeoutSeconds * 1000;
        console.error(`pr-wait: #${options.pr} entered the queue — waiting for the merge instead`);
      }

      if (mode === "merge") {
        queue.polls += 1;
        if (snapshot.labels.includes(options.labels.queued)) queue.sawQueued = true;
        const verdict = judge(snapshot, queue, options.labels, options.gracePolls);
        console.error(`pr-wait: #${options.pr} merge poll ${queue.polls}, ${elapsed()}s → ${verdict}`);
        if (verdict === "dequeued") {
          return result(
            "dequeued",
            queue.sawQueued
              ? "left the queue: its build failed or it was removed; read the queue's comment on the PR"
              : `never entered the queue within ${queue.polls} polls; its queue conditions did not hold`,
          );
        }
      } else if (options.head !== null && snapshot.head !== options.head) {
        mismatchPolls += 1;
        console.error(`pr-wait: #${options.pr} head is ${snapshot.head.slice(0, 12)}, expected ${options.head.slice(0, 12)}`);
        if (mismatchPolls >= options.gracePolls) {
          return result(
            "head-mismatch",
            `the PR head is ${snapshot.head} but the pushed commit was ${options.head}; was the push made?`,
          );
        }
      } else {
        ciPolls += 1;
        const checks = relevantChecks(snapshot.checks, options.required);
        const verdict = judgeCi(checks, ciPolls, options.gracePolls);
        const pending = checks.filter((check) => check.state === "pending").map((check) => check.name);
        console.error(
          `pr-wait: #${options.pr} ci poll ${ciPolls}, ${elapsed()}s → ${verdict}${pending.length ? ` (pending: ${pending.join(", ")})` : ""}`,
        );
        if (verdict === "green") return result("green", "every judged check passed");
        if (verdict === "red") {
          const failed = checks.filter((check) => check.state === "fail").map((check) => check.name);
          return result("red", `failed: ${failed.join(", ")}`);
        }
        if (verdict === "no-checks") return result("no-checks", `no checks reported on the head after ${ciPolls} polls`);
      }
    }

    if (Date.now() >= deadline) {
      return result(
        "timeout",
        mode === "ci"
          ? `checks still pending after ${options.ciTimeoutSeconds}s`
          : `still not merged after ${options.queueTimeoutSeconds}s in the queue`,
      );
    }
    await sleep(options.intervalSeconds * 1000);
  }
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    console.error(`pr-wait: ${options}\n${USAGE}`);
    return 64;
  }
  console.log(JSON.stringify(await wait(options)));
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`pr-wait: ${message}`);
      console.log(JSON.stringify({ outcome: "unreadable", detail: message }));
      process.exitCode = 0;
    },
  );
}
