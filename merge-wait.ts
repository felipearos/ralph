#!/usr/bin/env bun
/**
 * Wait for a pull request to actually merge.
 *
 * `main` merges through a merge queue (Mergify; the project's
 * docs/merge-gates.md), so the enqueue returns at once and the merge lands only
 * after the queue has built main-plus-PR on a temporary draft PR. Everything an
 * iteration does after "merge" — the done labels, closing the issue by hand,
 * the journal, detaching onto the base branch for the next ticket — is wrong if
 * it happens before the merge, so §6 of prompt.md runs this between the
 * enqueue and step 7.
 *
 * It reads only `gh pr view` and the queue's labels — `queued` while embarked,
 * `dequeued` after a failed attempt — which is what Mergify leaves on the PR
 * itself. Nothing here talks to Mergify.
 *
 * Exit codes are the contract; the prompt reads them:
 *   0  merged     — state MERGED; prints `merged <mergedAt>`
 *   2  dequeued   — still OPEN and out of the queue: the queue's build failed,
 *                   or the PR never entered it (a grace of a few polls covers
 *                   the seconds between the command and Mergify's label)
 *   3  closed     — CLOSED without merging
 *   4  timeout    — still queued at the deadline
 *   5  unreadable — `gh` failed too many times in a row
 *  64  usage
 *
 * `--timeout` and `--interval` (seconds) and `--grace` (polls) exist so a test
 * can prove the cap without waiting one out. Always exits by itself; nothing
 * here can hang an iteration past the deadline.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Type-only, so there is no runtime cycle with `pr-wait.ts` — which imports
// `judge` and the labels from here. The point of importing the type rather
// than restating the shape is that the queue waits this records must stay
// byte-compatible with the supervisor's own results: the dashboard's CI-time
// medians (#163) read both out of one directory and cannot tell them apart.
import type { WaitResult } from "./pr-wait";

export const EXIT = {
  merged: 0,
  dequeued: 2,
  closed: 3,
  timeout: 4,
  unreadable: 5,
  usage: 64,
} as const;

export const DEFAULT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 60;
export const DEFAULT_GRACE_POLLS = 3;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const DEFAULT_QUEUED_LABEL = "queued";
export const DEFAULT_DEQUEUED_LABEL = "dequeued";

export interface Snapshot {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  labels: string[];
}

export interface Progress {
  /** Successful reads so far, the current one included. */
  polls: number;
  /** Whether any read so far, the current one included, carried the queued label. */
  sawQueued: boolean;
}

export interface Labels {
  queued: string;
  dequeued: string;
}

export type Verdict = "merged" | "closed" | "dequeued" | "wait";

/**
 * What one read means, given what was seen before. Pure, so the table of
 * cases in merge-wait.test.ts is the whole contract.
 *
 * "Not queued" is ambiguous for a few polls: right after the command Mergify
 * has not answered yet, and after a re-queue a stale `dequeued` from the last
 * round can still sit on the PR. Both resolve inside the grace window. A PR
 * still bare after it never got in; a PR that was queued and no longer is fell
 * out — and that one needs no grace, the label swap is atomic on Mergify's side.
 */
export function judge(snapshot: Snapshot, progress: Progress, labels: Labels, gracePolls: number): Verdict {
  if (snapshot.state === "MERGED") return "merged";
  if (snapshot.state === "CLOSED") return "closed";
  if (snapshot.labels.includes(labels.queued)) return "wait";
  if (progress.sawQueued) return "dequeued";
  return progress.polls >= gracePolls ? "dequeued" : "wait";
}

/** A snapshot from `gh pr view --json state,mergedAt,labels`, or null for anything that is not one. */
export function parseSnapshot(raw: string): Snapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { state, mergedAt, labels } = parsed as Record<string, unknown>;
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") return null;
  if (mergedAt !== undefined && mergedAt !== null && typeof mergedAt !== "string") return null;
  if (!Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label !== "object" || label === null) return null;
    const name = (label as Record<string, unknown>).name;
    if (typeof name !== "string") return null;
    names.push(name);
  }
  return { state, mergedAt: typeof mergedAt === "string" ? mergedAt : null, labels: names };
}

export type Read = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

export function readSnapshot(pr: string, repo: string | null): Read {
  const args = ["pr", "view", pr, "--json", "state,mergedAt,labels"];
  if (repo !== null) args.push("--repo", repo);
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `gh exited ${result.status}`).trim() };
  }
  const snapshot = parseSnapshot(result.stdout);
  if (snapshot === null) return { ok: false, error: `unparseable gh output: ${result.stdout.trim().slice(0, 200)}` };
  return { ok: true, snapshot };
}

export interface Options {
  pr: string;
  repo: string | null;
  timeoutSeconds: number;
  intervalSeconds: number;
  gracePolls: number;
  labels: Labels;
}

const USAGE =
  "usage: merge-wait.ts <pr> [--repo owner/name] [--timeout seconds] [--interval seconds] [--grace polls] [--queued-label name] [--dequeued-label name]";

/** Parsed options, or the usage error as a string. */
export function parseArgs(argv: string[]): Options | string {
  const options: Options = {
    pr: "",
    repo: null,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    gracePolls: DEFAULT_GRACE_POLLS,
    labels: { queued: DEFAULT_QUEUED_LABEL, dequeued: DEFAULT_DEQUEUED_LABEL },
  };
  const number = (flag: string, value: string | undefined): number | string => {
    const parsed = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0) {
      return `${flag} needs a non-negative number, got ${value === undefined ? "nothing" : JSON.stringify(value)}`;
    }
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    const value = argv[i + 1];
    switch (arg) {
      case "--repo":
        if (value === undefined) return "--repo needs owner/name";
        options.repo = value;
        i += 1;
        break;
      case "--timeout": {
        const parsed = number(arg, value);
        if (typeof parsed === "string") return parsed;
        options.timeoutSeconds = parsed;
        i += 1;
        break;
      }
      case "--interval": {
        const parsed = number(arg, value);
        if (typeof parsed === "string") return parsed;
        options.intervalSeconds = parsed;
        i += 1;
        break;
      }
      case "--grace": {
        const parsed = number(arg, value);
        if (typeof parsed === "string") return parsed;
        options.gracePolls = parsed;
        i += 1;
        break;
      }
      case "--queued-label":
        if (value === undefined) return "--queued-label needs a name";
        options.labels.queued = value;
        i += 1;
        break;
      case "--dequeued-label":
        if (value === undefined) return "--dequeued-label needs a name";
        options.labels.dequeued = value;
        i += 1;
        break;
      default:
        if (arg.startsWith("-")) return `unknown flag ${arg}`;
        if (options.pr !== "") return `one pull request at a time, got ${options.pr} and ${arg}`;
        options.pr = arg;
    }
  }
  if (options.pr === "") return "which pull request? pass its number, URL or branch";
  return options;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------------------
 * The result file (#163).
 * ----------------------------------------------------------------------- */

export const RESULT_DIR = join(".ralph", "logs");

/**
 * Where this wait's result goes: `.ralph/logs/pr-wait-session-<key>-<round>.json`,
 * the same directory and the same `pr-wait-<key>-<round>.json` shape
 * `ralph.sh:1312` writes the supervisor's CI waits into.
 *
 * It has to be that shape because the dashboard's median CI and queue minutes
 * per iteration (#163) are computed from those files and nothing else — and a
 * queue wait run INSIDE an iteration's session, which is how §6 of the coder
 * prompt uses this script, is invisible to the supervisor that writes them.
 *
 * **The key is the run and the iteration**, `RALPH_RUN_ID` and
 * `RALPH_ITERATION`, both of which `ralph.sh:1901` exports. It is not the
 * session, which would be wrong for a reason easy to miss: `ralph.sh` mints a
 * FRESH session inside one iteration on a phase retry, so a session key would
 * split one iteration's queue waits across two pseudo-iterations, inflating
 * `queueIterations` and deflating each per-iteration sum — the opposite of the
 * "summed per iteration" the metric is.
 *
 * It cannot be the supervisor's own `<ts>-<pid>-<iteration>` — this process
 * knows neither its timestamp nor its pid — so a queue wait never groups with
 * the same iteration's CI waits. That is fine and not a compromise: the two
 * medians are taken per MODE, so a queue wait only ever has to group with the
 * other queue waits of its own iteration, which run-plus-iteration does
 * exactly.
 *
 * The round is the lowest number not already filed, so two rounds of §6 in one
 * iteration sum into one iteration rather than reading as two, and neither
 * overwrites the other.
 */
export function resultPath(env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const clean = (value: string | undefined): string => (value ?? "").replace(/[^A-Za-z0-9]/g, "");
  const run = clean(env.RALPH_RUN_ID);
  const iteration = clean(env.RALPH_ITERATION);
  const session = clean(env.RALPH_SESSION_ID).slice(0, 12);
  // Run and iteration first; the session is the fallback for a hand-run
  // script, and a pid-and-clock key the last resort for one with neither.
  const key =
    run !== "" && iteration !== "" ? `${run}-${iteration}` : session !== "" ? session : `pid${process.pid}-${now}`;
  const dir = join(env.RALPH_PROJECT ?? process.cwd(), RESULT_DIR);
  const named = (round: number): string => join(dir, `pr-wait-session-${key}-${round}.json`);
  let round = 1;
  // `existsSync` per candidate rather than one `readdirSync` count: two
  // results could be filed under one key, and counting them would hand the
  // second the same round as the first.
  while (round < 1000 && existsSync(named(round))) round += 1;
  return named(round);
}

/**
 * File the result, and never let filing it change the wait's answer. A missing
 * or unwritable log directory costs the metric one data point; failing the
 * merge over it would cost an iteration.
 */
export function record(result: WaitResult, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const path = resultPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result)}\n`);
    return path;
  } catch (error) {
    console.error(`merge-wait: could not record the wait: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    console.error(`merge-wait: ${options}\n${USAGE}`);
    return EXIT.usage;
  }

  const started = Date.now();
  const deadline = started + options.timeoutSeconds * 1000;
  const progress: Progress = { polls: 0, sawQueued: false };
  let failures = 0;
  const seconds = (): number => Math.round((Date.now() - started) / 1000);
  const elapsed = (): string => `${seconds()}s`;

  /**
   * Print the terminal line, file the result for the CI-time metric, and hand
   * back the exit code. One helper for every ending so none of them can be the
   * one that forgets — `checks` is empty and `head` null because a queue wait
   * judges the queue's labels, not the head's checks.
   */
  const end = (outcome: WaitResult["outcome"], detail: string, code: number): number => {
    console.log(detail);
    record({
      outcome,
      mode: "merge",
      pr: options.pr,
      head: null,
      polls: progress.polls,
      elapsedSeconds: seconds(),
      checks: [],
      detail,
    });
    return code;
  };

  for (;;) {
    const read = readSnapshot(options.pr, options.repo);
    if (!read.ok) {
      failures += 1;
      console.error(`merge-wait: #${options.pr} unreadable (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${read.error}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        return end("unreadable", `unreadable after ${failures} consecutive failures: ${read.error}`, EXIT.unreadable);
      }
    } else {
      failures = 0;
      const { snapshot } = read;
      progress.polls += 1;
      if (snapshot.labels.includes(options.labels.queued)) progress.sawQueued = true;
      const verdict = judge(snapshot, progress, options.labels, options.gracePolls);
      const tags = snapshot.labels.length > 0 ? ` [${snapshot.labels.join(", ")}]` : "";
      console.error(`merge-wait: #${options.pr} ${snapshot.state}${tags} — poll ${progress.polls}, ${elapsed()} elapsed → ${verdict}`);

      if (verdict === "merged") {
        return end("merged", `merged ${snapshot.mergedAt ?? ""}`.trim(), EXIT.merged);
      }
      if (verdict === "closed") {
        return end("closed", `closed: #${options.pr} was closed without merging`, EXIT.closed);
      }
      if (verdict === "dequeued") {
        return end(
          "dequeued",
          progress.sawQueued
            ? `dequeued: #${options.pr} left the queue — its build failed or it was removed; read Mergify's comment on the PR`
            : `dequeued: #${options.pr} never entered the queue within ${progress.polls} polls — its queue conditions did not hold; read Mergify's comment on the PR`,
          EXIT.dequeued,
        );
      }
    }

    if (Date.now() >= deadline) {
      return end("timeout", `timeout: #${options.pr} still not merged after ${options.timeoutSeconds}s`, EXIT.timeout);
    }
    await sleep(options.intervalSeconds * 1000);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`merge-wait: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT.unreadable;
    },
  );
}
