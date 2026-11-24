#!/usr/bin/env bun
/**
 * The ci-doctor's event source: one Buildkite poll into the ci-health store.
 *
 * Every poll makes ONE builds-list call,
 * `GET /organizations/<org>/pipelines/<p>/builds?finished_from=<cursor>&per_page=100`,
 * which returns main, the merge queue (`mergify/merge-queue/*`) and PR builds
 * alike. It then opens the log of each newly failed job exactly once, keyed by
 * job id, with `bk-log.ts`'s pure `failedJobs`, `cleanLog` and `digestLog`. A
 * job id already in the store is never fetched again. A retried job
 * (`retried: true`) is recorded as a retry, not a failure: evidence of a red
 * colour for "same tree, both colours", never a count.
 *
 * Each failure becomes one row keyed by test id (`<file> > <test title>`, or
 * `<file>`). Each red PR build gets the PR's changed files from the local
 * clone after one `git fetch` (no GitHub call), and every build the tree and
 * parent the rules compare. Rows and builds older than the window
 * (`windowHours`, 72) are pruned, and the cases are reclassified
 * (`classify.ts`).
 *
 * The network and git run outside the store lock; only the merge of their
 * results runs under it. A full builds page means older builds are still
 * unread: the cursor holds, and the next poll asks for the next page.
 *
 *   bun ci-doctor/scan.ts [--json]
 *
 * Token, organization and pipeline as `bk-log.ts`: `RALPH_BUILDKITE_READ_TOKEN`,
 * `RALPH_BUILDKITE_ORG` / `RALPH_BUILDKITE_PIPELINE` or the project's
 * `buildkite/<slug>` required check. Exit: 0 scanned, 1 no token or no
 * pipeline, 2 Buildkite unreadable (the store is untouched), 64 usage.
 */
import { spawnSync } from "node:child_process";

import {
  Buildkite,
  HelperError,
  TIMEOUT,
  cleanLog,
  configuredPipeline,
  digestLog,
  failedJobs,
  resolveOrg,
  tokenFrom,
  type Build,
  type Failure as DigestFailure,
  type Job,
} from "../bk-log";
import { projectRoot } from "../paths";
import { loadProjectConfig } from "../project-config";
import { DEFAULT_CLASSIFY, QUEUE_BRANCH, classify, mergeCases, type ClassifyOptions } from "./classify";
import { rekeyJestIdentities } from "./rekey";
import {
  FINISHED_BUILD_STATES,
  KNOWN_FLAKE_STATES,
  METRICS_DAYS,
  identify,
  readStore,
  storePathFromGit,
  utcDay,
  withStore,
  type BuildRecord,
  type CiHealthStore,
  type Failure,
  type FailureKind,
} from "./store";

export const PER_PAGE = 100;
export const WINDOW_HOURS = 72;
export { METRICS_DAYS } from "./store";

export interface ApiBuild extends Build {
  source?: string | null;
  message?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

/* --------------------------------------------------------------------------
 * A job's log → failure rows. Pure.
 * ----------------------------------------------------------------------- */

const RAN_COMMANDS = /^\s*~~~ Running commands/m;
const HOOK_TIMEOUT = /Hook timed out in \d+ ?ms/i;

/**
 * Why a job failed before its commands ran, or null when they ran. Buildkite
 * prints `~~~ Running commands` when the job's own command starts; a log
 * without it failed in bootstrap (checkout, a hook, docker, a lost agent). An
 * agent lost mid-run (exit -1) with no test failure in the log is infra too.
 */
export function bootstrapReason(job: Job, log: string): { reason: string; line: string } | null {
  // A source without the marker (GitHub Actions) says whether the commands ran.
  const ran = typeof job.ran === "boolean" ? job.ran : RAN_COMMANDS.test(log);
  if (ran && !(job.exit_status === -1 && digestLog(log).failures.length === 0)) return null;
  const lines = log.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const errorLine =
    lines.find((line) => /^fatal:|Error response from daemon/i.test(line)) ??
    [...lines].reverse().find((line) => /error|fatal|failed|lost|exited|denied|refused/i.test(line)) ??
    null;
  const text = errorLine ?? "";
  const reason = /docker|Error response from daemon/i.test(text)
    ? "docker"
    : /fatal:|checkout|clone|git fetch/i.test(text)
      ? "checkout"
      : /hook/i.test(text)
        ? "hook"
        : job.exit_status === -1 || lines.length === 0 || /lost/i.test(text)
          ? "agent-lost"
          : `exit-${job.exit_status ?? "unknown"}`;
  return { reason, line: (errorLine ?? `exit ${job.exit_status ?? "?"}`).slice(0, 240) };
}

export function kindOf(detail: readonly string[]): FailureKind {
  if (detail.some((line) => HOOK_TIMEOUT.test(line))) return "hook-timeout";
  if (detail.some((line) => TIMEOUT.test(line))) return "timeout";
  return "assertion";
}

const firstErrorLine = (failure: DigestFailure): string =>
  failure.detail.find((line) => !/^Retry #\d+/.test(line)) ?? failure.title;

/** The failure rows one failed job's cleaned log holds. */
export function rowsFromLog(build: ApiBuild, job: Job, log: string, retried: boolean): Failure[] {
  const base = {
    build: build.number,
    branch: build.branch ?? "",
    commit: build.commit ?? "",
    job: job.id,
    step: job.step_key ?? null,
    finishedAt: build.finished_at ?? "",
    retried,
  };
  const boot = bootstrapReason(job, log);
  if (boot !== null) return [{ ...base, testId: `bootstrap:${boot.reason}`, file: null, kind: "bootstrap", line: boot.line }];
  const digest = digestLog(log);
  const rows: Failure[] = [];
  const add = (row: Failure): void => {
    if (!rows.some((other) => other.testId === row.testId)) rows.push(row);
  };
  for (const failure of digest.failures) {
    add({ ...base, ...identify(failure.title, digest.files, failure.file), kind: kindOf(failure.detail), line: firstErrorLine(failure) });
  }
  if (rows.length > 0) return rows;
  // No failure marker the digest knows: the runner's per-file summary, else the step itself.
  const fallback = digest.summary[0] ?? digest.exit[0] ?? digest.tail.at(-1) ?? `exit ${job.exit_status ?? "?"}`;
  for (const file of digest.files) add({ ...base, testId: file, file, kind: "no-marker", line: fallback });
  if (rows.length === 0) add({ ...base, testId: `step:${job.step_key ?? job.name ?? job.id}`, file: null, kind: "no-marker", line: fallback });
  return rows;
}

/** The PR numbers a squash-merged main commit names: its trailing `(#n)`. */
export function mergedPrs(message: string | null | undefined): number[] {
  const first = (message ?? "").split("\n")[0] ?? "";
  const trailing = /\(#(\d+)\)\s*$/.exec(first) ?? /^Merge (?:of|pull request) #(\d+)\b/.exec(first);
  return trailing ? [Number(trailing[1])] : [];
}

/* --------------------------------------------------------------------------
 * Git: the local clone answers what GitHub would have.
 * ----------------------------------------------------------------------- */

/** Run git; stdout trimmed, or null on any failure. */
export type GitRun = (args: string[]) => string | null;

export function gitIn(cwd: string): GitRun {
  return (args) => {
    const out = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
    return out.status === 0 ? out.stdout.trim() : null;
  };
}

/** The facts the rules need, each one a local git call. Every answer may be null: the rule then does not fire. */
export class GitFacts {
  private fetched = false;
  private readonly present = new Map<string, boolean>();

  constructor(
    private readonly git: GitRun,
    private readonly baseBranch: string,
  ) {}

  /** One fetch per poll, before the first question. A failed fetch leaves what the clone already has. */
  private ensureFetched(): void {
    if (this.fetched) return;
    this.fetched = true;
    this.git(["fetch", "--quiet", "--no-tags", "origin"]);
  }

  /** Is the commit here? A commit no branch holds any more (a force-pushed PR) is fetched by sha, once. */
  private has(sha: string): boolean {
    this.ensureFetched();
    const known = this.present.get(sha);
    if (known !== undefined) return known;
    let ok = this.git(["cat-file", "-e", `${sha}^{commit}`]) !== null;
    if (!ok && /^[0-9a-f]{40}$/.test(sha)) ok = this.git(["fetch", "--quiet", "--no-tags", "origin", sha]) !== null;
    this.present.set(sha, ok);
    return ok;
  }

  tree(sha: string): string | null {
    return this.has(sha) ? this.git(["rev-parse", `${sha}^{tree}`]) : null;
  }

  parent(sha: string): string | null {
    return this.has(sha) ? this.git(["rev-parse", `${sha}^`]) : null;
  }

  mergeBase(sha: string): string | null {
    return this.has(sha) ? this.git(["merge-base", `origin/${this.baseBranch}`, sha]) : null;
  }

  diff(from: string, to: string): string[] | null {
    if (from === to) return [];
    if (!this.has(from) || !this.has(to)) return null;
    const out = this.git(["diff", "--name-only", from, to]);
    return out === null ? null : out.split("\n").filter((line) => line !== "");
  }
}

/* --------------------------------------------------------------------------
 * The poll.
 * ----------------------------------------------------------------------- */

export interface ScanOptions {
  org: string;
  pipeline: string;
  baseBranch: string;
  windowHours: number;
  perPage: number;
  retireHours: number;
  scheduledMinutes: number;
}

export const defaultScanOptions = (org: string, pipeline: string, overrides: Partial<ScanOptions> = {}): ScanOptions => ({
  org,
  pipeline,
  baseBranch: DEFAULT_CLASSIFY.baseBranch,
  windowHours: WINDOW_HOURS,
  perPage: PER_PAGE,
  retireHours: DEFAULT_CLASSIFY.retireHours,
  scheduledMinutes: DEFAULT_CLASSIFY.scheduledMinutes,
  ...overrides,
});

/** What one poll read, before it is merged into the store. */
export interface Batch {
  builds: BuildRecord[];
  rows: Failure[];
  /** job id → build number, for every job whose log this poll read (or tried to). */
  seen: Record<string, number>;
  /** Jobs read on an earlier poll that have since been retried. */
  retriedJobs: string[];
  /** How many builds the one call returned, and which page it was. */
  listed: number;
  page: number;
  logsRead: number;
}

/** `store.ts`'s set, which `ci-doctor/retry.ts` reads too. */
const FINISHED = FINISHED_BUILD_STATES;
const FAILED_JOB = new Set(["failed", "timed_out", "expired", "errored"]);

const iso = (ms: number): string => new Date(ms).toISOString();
const windowStart = (now: number, options: ScanOptions): string => iso(now - options.windowHours * 3_600_000);

export function buildsPath(options: ScanOptions, cursor: string, page: number): string {
  const query = `finished_from=${encodeURIComponent(cursor)}&per_page=${options.perPage}${page > 1 ? `&page=${page}` : ""}`;
  return `/organizations/${options.org}/pipelines/${options.pipeline}/builds?${query}`;
}

/**
 * Where a poll reads builds from: Buildkite (`buildkiteSource`) or GitHub
 * Actions (`actions-source.ts`). The store and the rules never know which.
 */
export interface BuildSource {
  /** One page of FINISHED builds whose finish is at or after `cursor` (ISO), newest first or any order. Throws HelperError when unreadable. */
  list(cursor: string, page: number, perPage: number): Promise<ApiBuild[]>;
  /** A failed job's CLEANED log (what `cleanLog` returns for Buildkite). Throws when unreadable. */
  log(build: ApiBuild, job: Job): Promise<string>;
}

export function buildkiteSource(api: Buildkite, options: ScanOptions): BuildSource {
  const base = `/organizations/${options.org}/pipelines/${options.pipeline}/builds`;
  return {
    async list(cursor, page, perPage) {
      const listed = await api.json<ApiBuild[]>(buildsPath({ ...options, perPage }, cursor, page));
      return Array.isArray(listed) ? listed : [];
    },
    async log(build, job) {
      return cleanLog(await api.text(`${base}/${build.number}/jobs/${job.id}/log`));
    },
  };
}

const sourceOf = (api: Buildkite | BuildSource, options: ScanOptions): BuildSource =>
  api instanceof Buildkite ? buildkiteSource(api, options) : api;

function recordOf(build: ApiBuild, baseBranch: string): BuildRecord {
  const steps: Record<string, string> = {};
  for (const job of build.jobs ?? []) {
    if (job.type !== "script" || !job.step_key || job.retried || job.state === "broken") continue;
    steps[job.step_key] = job.state;
  }
  return {
    number: build.number,
    branch: build.branch ?? "",
    commit: build.commit ?? "",
    state: build.state,
    source: build.source ?? null,
    createdAt: build.created_at ?? build.finished_at ?? "",
    startedAt: build.started_at ?? null,
    finishedAt: build.finished_at ?? "",
    pr: build.pull_request?.id ? Number(build.pull_request.id) : null,
    prs: build.branch === baseBranch ? mergedPrs(build.message) : [],
    steps,
    tree: null,
    parent: null,
    sincePrevious: null,
    changedFiles: null,
    branchPaths: null,
  };
}

const isPrBranch = (branch: string, baseBranch: string): boolean =>
  branch !== baseBranch && !QUEUE_BRANCH.test(branch);

/**
 * Read one page of finished builds and the logs of their newly failed jobs.
 * Network and git only; the store is read, never written. Throws
 * `HelperError` when the builds list cannot be read.
 */
export async function readBatch(
  api: Buildkite | BuildSource,
  git: GitFacts | null,
  snapshot: CiHealthStore,
  options: ScanOptions,
  now: number,
): Promise<Batch> {
  const page = snapshot.backfill?.page ?? 1;
  const cursor = snapshot.cursor || windowStart(now, options);
  const source = sourceOf(api, options);
  const listed = await source.list(cursor, page, options.perPage);
  const finished = (Array.isArray(listed) ? listed : [])
    .filter((build) => FINISHED.has(build.state) && build.finished_at)
    .sort((a, b) => a.number - b.number);

  const batch: Batch = { builds: [], rows: [], seen: {}, retriedJobs: [], listed: Array.isArray(listed) ? listed.length : 0, page, logsRead: 0 };
  for (const build of finished) {
    batch.builds.push(recordOf(build, options.baseBranch));
    const jobs = [
      ...failedJobs(build).filter((job) => job.state !== "canceled").map((job) => ({ job, retried: false })),
      ...(build.jobs ?? [])
        .filter((job) => job.type === "script" && job.retried && FAILED_JOB.has(job.state) && !job.soft_failed)
        .map((job) => ({ job, retried: true })),
    ];
    for (const { job, retried } of jobs) {
      if (job.id in snapshot.jobsSeen || job.id in batch.seen) {
        if (retried) batch.retriedJobs.push(job.id);
        continue;
      }
      batch.seen[job.id] = build.number;
      let log: string;
      try {
        batch.logsRead += 1;
        log = await source.log(build, job);
      } catch (error) {
        // Read once, as promised: an unreadable log is a row that says so, not a retry every poll.
        const why = error instanceof Error ? error.message : String(error);
        batch.rows.push({
          testId: `step:${job.step_key ?? job.id}`, file: null, build: build.number, branch: build.branch ?? "",
          commit: build.commit ?? "", job: job.id, step: job.step_key ?? null, kind: "no-marker",
          line: `log unreadable: ${why}`.slice(0, 240), finishedAt: build.finished_at ?? "", retried,
        });
        continue;
      }
      batch.rows.push(...rowsFromLog(build, job, log, retried));
    }
  }
  if (git !== null && batch.builds.length > 0) addGitFacts(git, snapshot, batch, options);
  return batch;
}

/** Record on each build what git knows about it; repair a later build whose previous build arrived late. */
function addGitFacts(git: GitFacts, snapshot: CiHealthStore, batch: Batch, options: ScanOptions): void {
  const fresh = new Set(batch.builds.map((build) => build.number));
  const view = new Map(snapshot.builds.map((build) => [build.number, build]));
  for (const build of batch.builds) {
    const old = view.get(build.number);
    // A build seen before (re-finished after a retry) keeps what git said about its commit.
    if (old !== undefined && old.commit === build.commit) {
      build.tree = old.tree;
      build.parent = old.parent;
      build.changedFiles = old.changedFiles;
      build.branchPaths = old.branchPaths;
      build.sincePrevious = old.sincePrevious;
    }
    view.set(build.number, build);
  }
  const ordered = [...view.values()].sort((a, b) => a.number - b.number);
  const tested = ordered.filter((build) => build.source !== "schedule");
  const redNumbers = new Set([...snapshot.failures, ...batch.rows].map((row) => row.build));
  const isRed = (build: BuildRecord): boolean => build.state !== "passed" || redNumbers.has(build.number);

  for (const build of batch.builds) {
    if (build.commit === "") continue;
    if (build.tree === null) build.tree = git.tree(build.commit);
    if (build.branch === options.baseBranch && build.parent === null) build.parent = git.parent(build.commit);
    if (isPrBranch(build.branch, options.baseBranch) && isRed(build) && build.changedFiles === null) {
      const mergeBase = git.mergeBase(build.commit);
      build.changedFiles = mergeBase === null ? null : git.diff(mergeBase, build.commit);
      // The base as CI saw it: the newest main build created before this one.
      const baseHead = tested.filter((other) => other.branch === options.baseBranch && other.createdAt <= build.createdAt).at(-1)?.commit ?? mergeBase;
      build.branchPaths = baseHead === null ? null : git.diff(baseHead, build.commit);
    }
  }
  // Files changed since the previous build of the branch, where that build was red: what a flip or a green-next rule reads.
  const byBranch = new Map<string, BuildRecord[]>();
  for (const build of tested) byBranch.set(build.branch, [...(byBranch.get(build.branch) ?? []), build]);
  for (const list of byBranch.values()) {
    for (let i = 1; i < list.length; i++) {
      const build = list[i]!;
      const previous = list[i - 1]!;
      if (!isRed(previous) || build.sincePrevious?.from === previous.commit) continue;
      const files = git.diff(previous.commit, build.commit);
      if (files === null) continue;
      build.sincePrevious = { from: previous.commit, files };
      if (!fresh.has(build.number)) {
        batch.builds.push(build);
        fresh.add(build.number);
      }
    }
  }
}

/** Merge one poll into the store, prune the window, and reclassify. */
export function applyBatch(store: CiHealthStore, batch: Batch, now: number, options: ScanOptions): void {
  const builds = new Map(store.builds.map((build) => [build.number, build]));
  for (const build of batch.builds) builds.set(build.number, build);
  store.builds = [...builds.values()].sort((a, b) => a.number - b.number);

  const retried = new Set(batch.retriedJobs);
  for (const row of store.failures) if (retried.has(row.job)) row.retried = true;
  for (const row of batch.rows) {
    if (row.job in store.jobsSeen) continue;
    store.failures.push(row);
  }
  for (const [job, number] of Object.entries(batch.seen)) store.jobsSeen[job] = number;

  const newest = batch.builds.reduce((max, build) => (build.finishedAt > max ? build.finishedAt : max), "");
  const high = [store.backfill?.high ?? "", newest].reduce((a, b) => (b > a ? b : a), "");
  if (batch.listed >= options.perPage) {
    store.backfill = { page: batch.page + 1, high };
  } else {
    store.backfill = null;
    if (high > store.cursor) store.cursor = high;
  }
  if (store.cursor === "") store.cursor = windowStart(now, options);

  prune(store, now, options);
  // BEFORE the classification, and after this poll's rows are in: the rekey
  // reads the rows for its mapping and rewrites the ones that predate #237, so
  // a classification run first would propose both the old key and the new one
  // and the case issue would be filed twice.
  rekeyJestIdentities(store);
  mergeCases(store, classify(store, now, classifyOptions(options)));
  // AFTER `mergeCases`, and that ordering is load-bearing: before it the cases
  // are the PREVIOUS poll's, so this poll's builds would be judged against
  // stale state and a just-confirmed flake would not count until the next poll.
  rollUpFlakeReds(store);
}

/**
 * Record, per UTC day, how many red builds that day failed only on tests the
 * doctor already knows are flakes — the success measure #163 asks for. A build
 * counts once, however many flaky tests it failed on, and one unknown failing
 * test disqualifies the whole build: the point of the number is reds that cost
 * the loops time and told them nothing.
 *
 * "Red" is not read off `build.state` here. A build counts when it has at
 * least one failure ROW and every distinct test id among those rows has a
 * `flake:<test id>` case in a known state. That is the same evidence
 * `bk-log.ts` shows an iteration, so the metric and the digest cannot disagree
 * about what a build failed on — and it is this module's OWN notion of red,
 * `isRed` above, which counts a build with failure rows whatever state it
 * finished in. The case that distinction decides: a build whose flaky job was
 * retried green finishes `passed`, and counting it is right, because the
 * iteration waited for both runs and learned nothing from either.
 *
 * **Per day it keeps the maximum of what is stored and what this pass saw.**
 * `prune` has already dropped builds older than the 72-hour window by the time
 * this runs, so a straight assignment would undercount a day that is half out
 * of the window and would zero out whole days on a rebuild from nothing. The
 * series is therefore monotonic: a case later reclassified out of a flake
 * state does not lower a past day. That is the accepted cost of keeping 30 days
 * of metrics over a 72-hour window of evidence.
 */
export function rollUpFlakeReds(store: CiHealthStore): void {
  const failing = new Map<number, Set<string>>();
  for (const row of store.failures) {
    const seen = failing.get(row.build);
    if (seen === undefined) failing.set(row.build, new Set([row.testId]));
    else seen.add(row.testId);
  }

  const counted = new Map<string, number>();
  for (const build of store.builds) {
    const tests = failing.get(build.number);
    if (tests === undefined || tests.size === 0) continue;
    const allKnown = [...tests].every((testId) => {
      const state = store.cases[`flake:${testId}`]?.state;
      return state !== undefined && KNOWN_FLAKE_STATES.has(state);
    });
    if (!allKnown) continue;
    const finished = Date.parse(build.finishedAt);
    // A build with no readable finish is skipped rather than filed under a
    // bogus day; the window it belongs to is exactly what we do not know.
    if (!Number.isFinite(finished)) continue;
    const day = utcDay(finished);
    counted.set(day, (counted.get(day) ?? 0) + 1);
  }

  for (const [day, reds] of counted) {
    const existing = store.metrics[day] ?? { knownFlakeReds: 0, parkedOnFlake: 0 };
    store.metrics[day] = { ...existing, knownFlakeReds: Math.max(existing.knownFlakeReds, reds) };
  }
}

export const classifyOptions = (options: ScanOptions): ClassifyOptions => ({
  baseBranch: options.baseBranch,
  retireHours: options.retireHours,
  scheduledMinutes: options.scheduledMinutes,
});

/** Drop what fell out of the window: builds, rows, seen jobs, and metrics past 30 days. */
export function prune(store: CiHealthStore, now: number, options: ScanOptions): void {
  const start = windowStart(now, options);
  store.builds = store.builds.filter((build) => build.finishedAt >= start);
  store.failures = store.failures.filter((row) => row.finishedAt >= start);
  const kept = new Set(store.builds.map((build) => build.number));
  const oldest = store.builds[0]?.number ?? Infinity;
  for (const [job, number] of Object.entries(store.jobsSeen)) {
    if (!kept.has(number) && number < oldest) delete store.jobsSeen[job];
  }
  const metricsStart = iso(now - METRICS_DAYS * 86_400_000).slice(0, 10);
  for (const day of Object.keys(store.metrics)) if (day < metricsStart) delete store.metrics[day];
}

export interface ScanResult {
  listed: number;
  page: number;
  logsRead: number;
  newFailures: number;
  cursor: string;
  backfill: CiHealthStore["backfill"];
  cases: Record<string, { kind: string; state: string }>;
  main: CiHealthStore["main"];
}

/** One poll: read outside the lock, merge under it. */
export async function scan(
  api: Buildkite | BuildSource,
  git: GitFacts | null,
  path: string,
  options: ScanOptions,
  now: number = Date.now(),
): Promise<ScanResult> {
  const snapshot = readStore(path);
  const batch = await readBatch(api, git, snapshot, options, now);
  return withStore(path, (store) => {
    const before = store.failures.length;
    applyBatch(store, batch, now, options);
    return {
      listed: batch.listed,
      page: batch.page,
      logsRead: batch.logsRead,
      newFailures: store.failures.length - before,
      cursor: store.cursor,
      backfill: store.backfill,
      cases: Object.fromEntries(Object.entries(store.cases).map(([key, value]) => [key, { kind: value.kind, state: value.state }])),
      main: store.main,
    };
  });
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    console.error(`ci-doctor/scan: unknown argument ${unknown[0]}\nusage: ci-doctor/scan.ts [--json]`);
    return 64;
  }
  const token = tokenFrom(env);
  if (token === null) {
    console.error("ci-doctor/scan: no Buildkite token — RALPH_BUILDKITE_READ_TOKEN is not set");
    return 1;
  }
  const pipeline = configuredPipeline(env);
  if (pipeline === null) {
    console.error("ci-doctor/scan: which pipeline? set RALPH_BUILDKITE_PIPELINE, or require a buildkite/<slug> check");
    return 1;
  }
  const root = projectRoot(process.cwd(), env);
  let baseBranch = env.RALPH_BASE_BRANCH?.trim() || "";
  if (baseBranch === "") {
    try {
      baseBranch = loadProjectConfig(root).baseBranch;
    } catch {
      baseBranch = DEFAULT_CLASSIFY.baseBranch;
    }
  }
  const api = new Buildkite(token);
  try {
    const org = await resolveOrg(api, env, pipeline);
    const options = defaultScanOptions(org, pipeline, { baseBranch });
    const result = await scan(api, new GitFacts(gitIn(root), baseBranch), storePathFromGit(root), options);
    if (argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const open = Object.entries(result.cases).filter(([, value]) => value.state !== "retired");
      console.log(
        `ci-doctor/scan: ${result.listed} build(s) listed (page ${result.page}), ${result.logsRead} log(s) read, ` +
          `${result.newFailures} new failure row(s); main ${result.main.state}; ${open.length} open case(s)` +
          (result.backfill ? `; backfilling page ${result.backfill.page} next` : ""),
      );
      for (const [key, value] of open) console.log(`  ${value.state.padEnd(9)} ${key}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof HelperError) {
      console.error(`ci-doctor/scan: ${error.message}`);
      return error.code === 64 ? 64 : error.code === 1 ? 1 : 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`ci-doctor/scan: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
