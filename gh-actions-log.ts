#!/usr/bin/env bun
/**
 * Read a GitHub Actions run's failure out of its job logs, for a session that
 * has a red Actions check — what `bk-log.ts` does for a Buildkite build (#50).
 *
 * A project whose CI is GitHub Actions (this repository's own) left a session
 * with a red check and only `gh run view` to go on, which no prompt names and
 * whose output is not the digest a session already knows how to read. So the
 * output here is bk-log's shape, printed by the same `formatDigest`.
 *
 *   bun gh-actions-log.ts <run>         a run id, a run URL (…/actions/runs/N)
 *                                       or a job URL (…/runs/N/job/M: its run)
 *   bun gh-actions-log.ts --pr <n>      the run the PR's failing Actions check
 *                                       links, a required check first
 *   bun gh-actions-log.ts --branch <b>  the branch's newest commit's red run
 *                                       (one per workflow), else its newest run
 *     --repo <owner/name>  else RALPH_PROJECT_REPO, else the project config's
 *     --full <dir>    also write each failed job's whole cleaned log to <dir>
 *     --json          the digest as JSON
 *     --job <name|id> one job's whole cleaned log, whatever its conclusion
 *       --grep <re>   only the lines that match, with their line numbers
 *     --rerun         re-run the run's failed jobs, once (see `rerunRefusal`);
 *                     with --pr, those of every red Actions run in the PR's rollup
 *   bun gh-actions-log.ts --check-token  can gh read this repo's runs and jobs?
 *
 * Every GitHub call goes through gh (`Gh` from `pr-wait.ts`), so the token is
 * gh's own and never passes through, or out of, this file.
 *
 * Exit: 0 digest, `--job` log or re-run printed (a passing run included), 1
 * nothing to resolve, no job matching `--job`, or a re-run refused (with
 * --pr: every run refused), 2 GitHub could not be read or a failed job's log
 * was unreadable (the rest is still printed), 3 gh's token cannot read Actions (`--check-token`), 64
 * usage, 75 GitHub rate-limited the read (retry later; nothing is wrong).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HelperError, cleanLog, digestLog, formatDigest, grepLog, projectFacts, type Digest } from "./bk-log";
import { isRateLimited, parseCheck, type Check, type Gh } from "./pr-wait";

/* --------------------------------------------------------------------------
 * URLs and logs. Pure.
 * ----------------------------------------------------------------------- */

export interface ActionsRef {
  /** `owner/name`. */
  repo: string;
  run: string;
  job?: string;
}

const ACTIONS_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?(?:[/?#]|$)/;

/** A run or job URL of GitHub Actions, or null for anything else (a Buildkite link, a commit status). */
export function parseActionsUrl(url: string): ActionsRef | null {
  const match = ACTIONS_URL.exec(url.trim());
  if (!match) return null;
  const ref: ActionsRef = { repo: `${match[1]!}/${match[2]!}`, run: match[3]! };
  if (match[4]) ref.job = match[4];
  return ref;
}

// Every line of a job log starts with one: `2026-11-24T10:00:00.1234567Z `.
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/**
 * A job log as `digestLog` reads it: timestamps gone, and the runner's
 * markers turned into what bk-log already recognises. `##[group]Run <cmd>`
 * becomes `$ <cmd>` (the digest's `command:`), `##[endgroup]` goes, and
 * `##[error]…` keeps its text — `Process completed with exit code 1.` is the
 * exit line, anything else is the failure message the step printed.
 */
export function cleanActionsLog(raw: string): string {
  const lines = raw.split("\n").flatMap((line) => {
    const text = line.replace(TIMESTAMP, "");
    if (/^##\[endgroup\]\s*$/.test(text)) return [];
    const run = /^##\[group\]Run (.*)$/.exec(text);
    if (run) return [`$ ${run[1]!}`];
    return [text.replace(/^##\[(?:group|error|warning|notice|debug)\]/, "")];
  });
  return cleanLog(lines.join("\n"));
}

/* --------------------------------------------------------------------------
 * Runs and jobs.
 * ----------------------------------------------------------------------- */

export interface Step {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

export interface ActionsJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  steps?: Step[];
  /** The attempt this job belongs to; with `filter=all` a re-run run lists every attempt's jobs. */
  run_attempt?: number;
  /** When this attempt's job started; the earliest across attempts is when the run first started. */
  started_at?: string | null;
}

export interface ActionsRun {
  id: number;
  name?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  status: string;
  conclusion: string | null;
  run_attempt?: number;
  html_url?: string | null;
  event?: string;
  workflow_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  run_started_at?: string | null;
  head_commit?: { message?: string | null } | null;
  pull_requests?: Array<{ number: number }> | null;
}

/**
 * The conclusions that make a job red. `cancelled` counts: a fail-fast matrix
 * cancels a failing job's siblings, a run's check shows red for it (pr-wait's
 * FAILED_CONCLUSIONS has CANCELLED too), and GitHub's `rerun-failed-jobs`
 * re-runs cancelled jobs. `action_required` counts too — pr-wait reads its
 * check as failed, so the digest must list the job a session is stuck on —
 * but a re-run cannot clear it (RERUNNABLE_CONCLUSIONS).
 */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/** What `rerun-failed-jobs` can turn green: everything red but a pending approval. */
const RERUNNABLE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);

export function failedActionsJobs(jobs: readonly ActionsJob[]): ActionsJob[] {
  return jobs.filter((job) => job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion));
}

/** The first step that failed, as the jobs API reports it — the one the log's last `$ …` belongs to. */
export function failedStep(job: ActionsJob): Step | null {
  return (job.steps ?? []).find((step) => step.conclusion === "failure") ?? null;
}

/**
 * Why `--rerun` must not re-run this run, or null when it may. The limit the
 * Buildkite path observes: one re-run per red. A second red on the same
 * commit is evidence; a third attempt only buys another night of waiting.
 */
export function rerunRefusal(run: ActionsRun, jobs: readonly ActionsJob[], prHead: string | null): string | null {
  if (run.status !== "completed") return `run #${run.id} is ${run.status}, not completed; wait for it to finish`;
  const failed = failedActionsJobs(jobs);
  if (failed.length === 0) return `run #${run.id} has no failed job to re-run`;
  if (!failed.some((job) => RERUNNABLE_CONCLUSIONS.has(job.conclusion!))) {
    const named = failed.map((job) => `job ${job.name} is ${job.conclusion}`).join(", ");
    return `run #${run.id}: ${named}, which a re-run cannot clear; a person must approve it`;
  }
  const attempt = run.run_attempt ?? 1;
  if (attempt > 1) {
    return `run #${run.id} was already re-run (attempt ${attempt}); one re-run per red is the limit — read the new attempt's log`;
  }
  if (prHead !== null && run.head_sha !== prHead) {
    return `run #${run.id} is of ${(run.head_sha ?? "?").slice(0, 10)}, not the PR's head ${prHead.slice(0, 10)}; a re-run of an old commit proves nothing about the head`;
  }
  return null;
}

export interface ActionsJobReport {
  job: ActionsJob;
  digest: Digest | null;
  error: string | null;
  saved: string | null;
}

function runHeader(run: ActionsRun): string {
  const state = run.status === "completed" ? (run.conclusion ?? run.status) : run.status;
  const sha = run.head_sha ? ` @ ${run.head_sha.slice(0, 10)}` : "";
  return `Run #${run.id} ${state} — ${run.name ?? "?"} on ${run.head_branch ?? "?"}${sha} (attempt ${run.run_attempt ?? 1})`;
}

function jobHeader(job: ActionsJob): string {
  const step = failedStep(job);
  const conclusion = job.conclusion ?? job.status;
  return `== ${job.name} [${job.id}] — ${conclusion}${step && FAILED_CONCLUSIONS.has(conclusion) ? `, step "${step.name}"` : ""}`;
}

export function formatActionsReport(run: ActionsRun, reports: readonly ActionsJobReport[], total: number): string {
  const out = [runHeader(run)];
  if (run.html_url) out.push(run.html_url);
  if (reports.length === 0) {
    out.push(`no failed jobs (of ${total})`);
    out.push("a passing job's output: --job <name> [--grep <regex>]");
    return out.join("\n");
  }
  out.push(`${reports.length} failed job${reports.length === 1 ? "" : "s"} (of ${total})`);
  for (const { job, digest, error, saved } of reports) {
    out.push("", jobHeader(job));
    if (job.html_url) out.push(`   ${job.html_url}`);
    if (saved) out.push(`   full log: ${saved}`);
    if (error) {
      out.push(`   log unreadable: ${error}`);
      continue;
    }
    if (digest !== null) out.push(...formatDigest(digest));
  }
  return out.join("\n");
}

/* --------------------------------------------------------------------------
 * I/O, through gh.
 * ----------------------------------------------------------------------- */

const scopeHint = (repo: string): string =>
  `gh's token needs Actions read on ${repo} (classic: repo; fine-grained: Actions read)`;

// gh does not print its token, but an error message is the one place text
// from outside lands in our output; strip anything shaped like one anyway.
const redact = (text: string): string =>
  text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]");

type Called = { ok: true; stdout: string } | { ok: false; error: string };

function call(gh: Gh, args: string[]): Called {
  const result = gh(args);
  if (result.error) return { ok: false, error: redact(result.error.message) };
  if (result.status !== 0) return { ok: false, error: redact((result.stderr || result.stdout || `gh exited ${result.status}`).trim()) };
  return { ok: true, stdout: result.stdout };
}

const denied = (error: string): boolean => /HTTP 40[34]\b|Resource not accessible|Not Found/i.test(error);

/** stdout of a read, or the HelperError its failure maps to. */
function read(gh: Gh, repo: string, args: string[]): string {
  return stdoutOf(call(gh, args), repo, args);
}

function stdoutOf(result: Called, repo: string, args: string[]): string {
  if (result.ok) return result.stdout;
  if (isRateLimited(result.error)) throw new HelperError(`GitHub rate-limited the read: ${result.error}`, 75);
  if (denied(result.error)) throw new HelperError(`gh ${args.join(" ")} failed: ${result.error}; ${scopeHint(repo)}`, 2);
  throw new HelperError(`gh ${args.join(" ")} failed: ${result.error}`, 2);
}

function readJson<T>(gh: Gh, repo: string, args: string[]): T {
  const stdout = read(gh, repo, args);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new HelperError(`gh ${args.join(" ")}: unparseable output`, 2);
  }
}

export function readRun(gh: Gh, repo: string, run: string): ActionsRun {
  return readJson<ActionsRun>(gh, repo, ["api", `repos/${repo}/actions/runs/${run}`]);
}

const JOBS_PER_PAGE = 100;
// A matrix past 2000 jobs is not a run a session reads; the cap keeps a
// misbehaving API from paging forever.
const MAX_JOB_PAGES = 20;

/**
 * Every job of a run, page by page: a big matrix's failing job may sit past
 * the first 100. `filter: "all"` lists earlier attempts' jobs too (GitHub's
 * default, `latest`, hides what a re-run replaced).
 */
export function readJobs(gh: Gh, repo: string, run: string, filter?: "latest" | "all"): ActionsJob[] {
  const jobs: ActionsJob[] = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const body = readJson<{ jobs?: ActionsJob[]; total_count?: number }>(gh, repo, [
      "api",
      `repos/${repo}/actions/runs/${run}/jobs?per_page=${JOBS_PER_PAGE}&page=${page}${filter ? `&filter=${filter}` : ""}`,
    ]);
    const batch = Array.isArray(body.jobs) ? body.jobs : [];
    jobs.push(...batch);
    if (batch.length < JOBS_PER_PAGE) break;
    if (typeof body.total_count === "number" && jobs.length >= body.total_count) break;
  }
  return jobs;
}

/**
 * A job's raw log. A test runner colours its output, and gh refuses to print
 * a response carrying terminal escapes unless told it may ("the response
 * contains terminal escape sequences"), which made every vitest log
 * unreadable. `cleanActionsLog` strips the escapes. A gh too old to know the
 * flag is asked again without it.
 */
export function readLog(gh: Gh, repo: string, job: number): string {
  const path = `repos/${repo}/actions/jobs/${job}/logs`;
  const args = ["api", "--allow-escape-sequences", path];
  const result = call(gh, args);
  if (!result.ok && /unknown flag/i.test(result.error)) return read(gh, repo, ["api", path]);
  return stdoutOf(result, repo, args);
}

export type ProbeResult = { status: "ok" } | { status: "denied"; why: string } | { status: "unreachable"; why: string };

/**
 * Can gh read `repo`'s Actions runs and their jobs? Never throws, so a
 * preflight can call it and fall back on any answer.
 */
export function probeActionsRead(repo: string, gh: Gh): ProbeResult {
  const judge = (error: string): ProbeResult =>
    denied(error) && !isRateLimited(error)
      ? { status: "denied", why: `${error}; ${scopeHint(repo)}` }
      : { status: "unreachable", why: error };
  const runs = call(gh, ["api", `repos/${repo}/actions/runs?per_page=1`]);
  if (!runs.ok) return judge(runs.error);
  let first: number | null = null;
  try {
    const body = JSON.parse(runs.stdout) as { workflow_runs?: Array<{ id?: number }> };
    first = body.workflow_runs?.[0]?.id ?? null;
  } catch {
    return { status: "unreachable", why: `gh api repos/${repo}/actions/runs: unparseable output` };
  }
  if (first === null) return { status: "ok" };
  const jobs = call(gh, ["api", `repos/${repo}/actions/runs/${first}/jobs?per_page=1`]);
  return jobs.ok ? { status: "ok" } : judge(jobs.error);
}

export interface Options {
  target: string | null;
  pr: string | null;
  branch: string | null;
  repo: string | null;
  full: string | null;
  json: boolean;
  rerun: boolean;
  checkToken: boolean;
  job: string | null;
  grep: RegExp | null;
}

export const USAGE =
  "usage: gh-actions-log.ts <run-url|job-url|run-id> | --pr <n> | --branch <name>  [--repo <owner/name>] [--full <dir>] [--json]\n" +
  "       gh-actions-log.ts <run-url|job-url|run-id> | --pr <n> | --branch <name>  --job <name|id> [--grep <regex>] [--full <dir>]\n" +
  "       gh-actions-log.ts <run-url|job-url|run-id> | --pr <n> | --branch <name>  --rerun\n" +
  "       gh-actions-log.ts --check-token [--repo <owner/name>]";

export function parseArgs(argv: string[]): Options | string {
  const options: Options = {
    target: null, pr: null, branch: null, repo: null, full: null, json: false, rerun: false, checkToken: false,
    job: null, grep: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--pr":
      case "--branch":
      case "--repo":
      case "--full":
      case "--job":
      case "--grep":
        if (!value || value.startsWith("--")) return `${arg} needs a value`;
        i += 1;
        if (arg === "--pr") options.pr = value.replace(/^#/, "");
        else if (arg === "--branch") options.branch = value;
        else if (arg === "--repo") options.repo = value;
        else if (arg === "--job") options.job = value;
        else if (arg === "--grep") {
          try {
            options.grep = new RegExp(value);
          } catch {
            return `--grep is not a valid regex: ${value}`;
          }
        } else options.full = value;
        break;
      case "--json":
        options.json = true;
        break;
      case "--rerun":
        options.rerun = true;
        break;
      case "--check-token":
        options.checkToken = true;
        break;
      case "-h":
      case "--help":
        return "help";
      default:
        if (arg.startsWith("-")) return `unknown flag ${arg}`;
        if (options.target !== null) return `one run at a time, got ${options.target} and ${arg}`;
        options.target = arg;
    }
  }
  const targets = [options.target, options.pr, options.branch].filter((target) => target !== null).length;
  if (options.checkToken) return targets === 0 ? options : "--check-token takes no run";
  if (targets !== 1) return "name one run: a run id, a run or job URL, --pr <n> or --branch <name>";
  if (options.target !== null && !/^\d+$/.test(options.target) && parseActionsUrl(options.target) === null) {
    return `not a run id or a GitHub Actions run/job URL: ${options.target}`;
  }
  if (options.grep !== null && options.job === null) return "--grep reads one job's log; name it with --job";
  if (options.job !== null && options.json) return "--job prints the log itself; --json is for the digest";
  if (options.rerun && (options.job !== null || options.json || options.full !== null)) {
    return "--rerun re-runs the failed jobs and reads no log; drop --job, --json and --full";
  }
  if (options.pr !== null && !/^\d+$/.test(options.pr)) return `--pr needs a PR number, got ${options.pr}`;
  return options;
}

function repoFrom(options: Options, env: NodeJS.ProcessEnv): string {
  const repo = options.repo ?? projectFacts(env).repo;
  if (repo === null) throw new HelperError("no repo: pass --repo <owner/name>, or run from a project checkout", 1);
  return repo;
}

interface Resolved {
  repo: string;
  run: string;
  /** The PR's head commit, with `--pr`: what a re-run must be of. */
  prHead: string | null;
}

/**
 * The Actions check a PR's rollup points at: a failing required one first,
 * then any failing one, then — like bk-log on a green build — any at all.
 */
export function actionsCheckFromRollup(rollup: unknown, required: readonly string[]): (Check & { ref: ActionsRef }) | null {
  const checks = (Array.isArray(rollup) ? rollup : [])
    .map(parseCheck)
    .flatMap((check) => {
      const ref = check?.url ? parseActionsUrl(check.url) : null;
      return check && ref ? [{ ...check, ref }] : [];
    });
  const isRequired = (check: Check): boolean => required.includes(check.name);
  const failing = checks.filter((check) => check.state === "fail");
  return failing.find(isRequired) ?? failing[0] ?? checks.find(isRequired) ?? checks[0] ?? null;
}

/**
 * The run `--branch` reads, from the branch's runs newest first. The newest
 * run alone is whichever workflow finished last — often a green lint beside a
 * red test — so: the newest commit's runs, the newest per workflow, the first
 * red of those, else the newest run.
 */
export function branchRun(runs: readonly ActionsRun[]): ActionsRun | null {
  const newest = runs.find((entry) => typeof entry?.id === "number");
  if (newest === undefined) return null;
  const seen = new Set<string>();
  const latest = runs.filter((entry) => {
    if (typeof entry?.id !== "number" || (entry.head_sha ?? null) !== (newest.head_sha ?? null)) return false;
    const workflow = entry.workflow_id != null ? `id:${entry.workflow_id}` : `name:${entry.name ?? ""}`;
    if (seen.has(workflow)) return false;
    seen.add(workflow);
    return true;
  });
  return latest.find((entry) => entry.conclusion !== null && FAILED_CONCLUSIONS.has(entry.conclusion)) ?? newest;
}

interface PrView {
  rollup: unknown;
  head: string | null;
}

function readPrView(gh: Gh, repo: string, pr: string): PrView {
  const view = readJson<{ statusCheckRollup?: unknown; headRefOid?: string }>(gh, repo, [
    "pr", "view", pr, "--repo", repo, "--json", "statusCheckRollup,headRefOid",
  ]);
  return { rollup: view.statusCheckRollup, head: view.headRefOid ?? null };
}

function resolve(options: Options, env: NodeJS.ProcessEnv, gh: Gh): Resolved {
  if (options.target !== null) {
    const ref = parseActionsUrl(options.target);
    if (ref !== null) return { repo: options.repo ?? ref.repo, run: ref.run, prHead: null };
    return { repo: repoFrom(options, env), run: options.target, prHead: null };
  }
  const repo = repoFrom(options, env);
  if (options.branch !== null) {
    const body = readJson<{ workflow_runs?: ActionsRun[] }>(gh, repo, [
      "api",
      `repos/${repo}/actions/runs?branch=${encodeURIComponent(options.branch)}&per_page=20`,
    ]);
    const picked = branchRun(Array.isArray(body.workflow_runs) ? body.workflow_runs : []);
    if (picked === null) throw new HelperError(`no GitHub Actions run on branch ${options.branch} of ${repo}`, 1);
    return { repo, run: String(picked.id), prHead: null };
  }
  const pr = options.pr!;
  const view = readPrView(gh, repo, pr);
  const check = actionsCheckFromRollup(view.rollup, projectFacts(env).checks);
  if (check === null) throw new HelperError(`PR #${pr} has no GitHub Actions check; its checks: ${checkNames(view.rollup)}`, 1);
  return { repo: check.ref.repo, run: check.ref.run, prHead: view.head };
}

function checkNames(rollup: unknown): string {
  const names = (Array.isArray(rollup) ? rollup : [])
    .map(parseCheck)
    .flatMap((entry) => (entry ? [`${entry.name} (${entry.state})`] : []));
  return names.join(", ") || "none";
}

/** The distinct Actions runs the rollup's failing checks link, in rollup order. Pure. */
export function failingActionsRuns(rollup: unknown): ActionsRef[] {
  const seen = new Set<string>();
  const refs: ActionsRef[] = [];
  for (const check of (Array.isArray(rollup) ? rollup : []).map(parseCheck)) {
    if (check === null || check.state !== "fail" || !check.url) continue;
    const ref = parseActionsUrl(check.url);
    if (ref === null) continue;
    const key = `${ref.repo.toLowerCase()}#${ref.run}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ repo: ref.repo, run: ref.run });
  }
  return refs;
}

/** POST a run's re-run; a failure throws as main reports it. */
function postRerun(gh: Gh, repo: string, actionsRun: ActionsRun): string {
  const id = actionsRun.id;
  const result = call(gh, ["api", "-X", "POST", `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`]);
  if (!result.ok) {
    if (isRateLimited(result.error)) throw new HelperError(`GitHub rate-limited the re-run: ${result.error}`, 75);
    throw new HelperError(`gh could not re-run run #${id}: ${result.error}`, 2);
  }
  const url = actionsRun.html_url ?? `https://github.com/${repo}/actions/runs/${id}`;
  const next = (actionsRun.run_attempt ?? 1) + 1;
  return `re-ran the failed jobs of run #${id} (attempt ${next} will follow): ${url}`;
}

/**
 * `--pr --rerun`: the failed jobs of EVERY red Actions run in the PR's rollup,
 * each once and each at the PR's head. The flake rule re-runs CI once when
 * every failure is a flake, so re-running only the first red run would leave
 * the others red and the PR waiting on nothing. A run whose link names
 * another repository is refused: a check's URL must not aim the POST
 * elsewhere than the repository the PR was read in.
 */
function rerunPr(options: Options, env: NodeJS.ProcessEnv, gh: Gh): RunResult {
  const repo = repoFrom(options, env);
  const pr = options.pr!;
  const view = readPrView(gh, repo, pr);
  const refs = failingActionsRuns(view.rollup);
  if (refs.length === 0) {
    throw new HelperError(`not re-running: PR #${pr} has no red GitHub Actions run; its checks: ${checkNames(view.rollup)}`, 1);
  }
  const lines: string[] = [];
  const refused: string[] = [];
  let rerun = 0;
  for (const ref of refs) {
    if (ref.repo.toLowerCase() !== repo.toLowerCase()) {
      refused.push(`not re-running run #${ref.run}: its check links ${ref.repo}, not ${repo} where PR #${pr} lives; a check link must not send a re-run to another repository`);
      continue;
    }
    const actionsRun = readRun(gh, repo, ref.run);
    const refusal = rerunRefusal(actionsRun, readJobs(gh, repo, ref.run), view.head);
    if (refusal !== null) {
      refused.push(`not re-running: ${refusal}`);
      continue;
    }
    try {
      lines.push(postRerun(gh, repo, actionsRun));
    } catch (error) {
      // Say what was already re-run, so a retry does not count it twice.
      if (error instanceof HelperError && lines.length > 0) throw new HelperError(`${error.message} (already: ${lines.join("; ")})`, error.code);
      throw error;
    }
    rerun += 1;
  }
  if (rerun === 0) throw new HelperError(refused.join("\n"), 1);
  return { text: [...lines, ...refused].join("\n"), json: null, unreadable: 0 };
}

const safeName = (value: string): string => value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";

/** One job's cleaned log, saved under `full` when given. Never throws: an unreadable log is that job's `error`. */
function readJobLog(
  gh: Gh,
  repo: string,
  run: string,
  job: ActionsJob,
  jobs: readonly ActionsJob[],
  full: string | null,
): { log: string | null; saved: string | null; error: string | null } {
  try {
    const log = cleanActionsLog(readLog(gh, repo, job.id));
    let saved: string | null = null;
    if (full !== null) {
      // Two jobs can share a name (a re-run's, a matrix entry's); the id keeps their files apart.
      const shared = jobs.filter((other) => other.name === job.name).length > 1;
      mkdirSync(full, { recursive: true });
      saved = join(full, `gha-${run}-${safeName(shared ? `${job.name}-${job.id}` : job.name)}.log`);
      writeFileSync(saved, log);
    }
    return { log, saved, error: null };
  } catch (error) {
    // A rate limit is the whole run's problem, not this job's: let main say so.
    if (error instanceof HelperError && error.code === 75) throw error;
    return { log: null, saved: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What `main` prints; `unreadable` counts the requested job logs that could not be read (exit 2). */
export interface RunResult {
  text: string;
  json: unknown;
  unreadable: number;
}

export function run(options: Options, env: NodeJS.ProcessEnv, gh: Gh): RunResult {
  if (options.rerun && options.pr !== null) return rerunPr(options, env, gh);
  const { repo, run: id, prHead } = resolve(options, env, gh);
  const actionsRun = readRun(gh, repo, id);
  const jobs = readJobs(gh, repo, id);
  if (options.rerun) {
    const refusal = rerunRefusal(actionsRun, jobs, prHead);
    if (refusal !== null) throw new HelperError(`not re-running: ${refusal}`, 1);
    return { text: postRerun(gh, repo, actionsRun), json: null, unreadable: 0 };
  }
  if (options.job !== null) return jobLogs(options, options.job, repo, actionsRun, jobs, gh);
  const failed = failedActionsJobs(jobs);
  const reports: ActionsJobReport[] = failed.map((job) => {
    const { log, saved, error } = readJobLog(gh, repo, id, job, failed, options.full);
    return { job, digest: log === null ? null : digestLog(log), error, saved };
  });
  return {
    text: formatActionsReport(actionsRun, reports, jobs.length),
    unreadable: reports.filter((report) => report.error !== null).length,
    json: {
      run: {
        repo,
        id: actionsRun.id,
        name: actionsRun.name ?? null,
        status: actionsRun.status,
        conclusion: actionsRun.conclusion,
        attempt: actionsRun.run_attempt ?? 1,
        branch: actionsRun.head_branch ?? null,
        commit: actionsRun.head_sha ?? null,
        url: actionsRun.html_url ?? null,
      },
      total: jobs.length,
      failed: reports.map(({ job, digest, error, saved }) => ({
        name: job.name,
        id: job.id,
        conclusion: job.conclusion,
        step: failedStep(job)?.name ?? null,
        url: job.html_url ?? null,
        saved,
        error,
        ...digest,
      })),
    },
  };
}

/** `--job`: the named jobs' logs, whole or grepped, under the digest's `== name [id] — conclusion` header. */
function jobLogs(
  options: Options,
  key: string,
  repo: string,
  actionsRun: ActionsRun,
  jobs: readonly ActionsJob[],
  gh: Gh,
): RunResult {
  const named = jobs.filter((job) => job.name === key || String(job.id) === key);
  if (named.length === 0) {
    const list = jobs.map((job) => `"${job.name}" [${job.id}] (${job.conclusion ?? job.status})`);
    throw new HelperError(`no job of run #${actionsRun.id} is named ${key}; its jobs: ${list.join(", ") || "none"}`, 1);
  }
  const out = [runHeader(actionsRun)];
  let unreadable = 0;
  for (const job of named) {
    const { log, saved, error } = readJobLog(gh, repo, String(actionsRun.id), job, named, options.full);
    out.push("", `== ${job.name} [${job.id}] — ${job.conclusion ?? job.status}`);
    if (saved) out.push(`   full log: ${saved}`);
    if (log === null) {
      out.push(`   log unreadable: ${error}`);
      unreadable += 1;
      continue;
    }
    const lines = options.grep === null ? [log] : grepLog(log, options.grep);
    out.push(...(lines.length > 0 ? lines : [`(no line matches ${options.grep})`]));
  }
  return { text: out.join("\n"), json: null, unreadable };
}

/**
 * `runGh` with room for a job log. Its 30s timeout and the default output cap
 * suit a JSON read, but a verbose test job's log runs to megabytes, and a log
 * cut off there reads as "unreadable" and sends the session to re-run what it
 * could have read. Exported for the ci-doctor's Actions scan, which reads the
 * same logs.
 */
export const runGhForLogs: Gh = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, gh: Gh = runGhForLogs): number {
  const options = parseArgs(argv);
  if (options === "help") {
    console.log(USAGE);
    return 0;
  }
  if (typeof options === "string") {
    console.error(`gh-actions-log: ${options}\n${USAGE}`);
    return 64;
  }
  try {
    if (options.checkToken) {
      const repo = repoFrom(options, env);
      const probe = probeActionsRead(repo, gh);
      if (probe.status === "ok") {
        console.log(`gh-actions-log: gh can read ${repo}'s Actions runs and job logs`);
        return 0;
      }
      console.error(`gh-actions-log: gh cannot read ${repo}'s Actions runs: ${probe.why}`);
      return probe.status === "denied" ? 3 : 2;
    }
    const result = run(options, env, gh);
    console.log(options.json ? JSON.stringify(result.json, null, 2) : result.text);
    // The partial output stands, but a session must not read "exit 0" as
    // "every failed job was read": an unreadable log is a failed read.
    if (result.unreadable > 0) {
      console.error(`gh-actions-log: ${result.unreadable} job log${result.unreadable === 1 ? "" : "s"} could not be read`);
      return 2;
    }
    return 0;
  } catch (error) {
    if (error instanceof HelperError) {
      console.error(`gh-actions-log: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`gh-actions-log: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
