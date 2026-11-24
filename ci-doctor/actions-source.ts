/**
 * The ci-doctor's event source for a project whose CI is GitHub Actions (#52):
 * the `BuildSource` `scan.ts` polls, over gh, in the shape Buildkite builds
 * already have. One workflow run is one build (its id is the build number),
 * each of its jobs one job, and a job of an earlier attempt is a retried job —
 * what a re-run replaced, as a Buildkite retry is.
 *
 * Every GitHub call goes through gh (`Gh` from `pr-wait.ts`), as
 * `gh-actions-log.ts` does, whose readers and log cleaning this reuses.
 */
import { HelperError, type Job } from "../bk-log";
import { cleanActionsLog, failedStep, readJobs, readLog, type ActionsJob, type ActionsRun } from "../gh-actions-log";
import { projectProvider } from "../ci-log";
import type { Gh } from "../pr-wait";
import type { ApiBuild, BuildSource } from "./scan";

// How far back the runs list reaches by creation: `scan.ts`'s WINDOW_HOURS,
// spelled here rather than imported because scan.ts imports this module. The
// runs API filters on creation only, and a re-run moves `updated_at`, never
// `created_at`: a run created days before the cursor and re-run since must
// still be listed, so the reach is the scan's whole window, not a slack past
// the cursor. The store dedupes builds by number and jobs by id, and runs not
// updated since the cursor are not read, so the overlap costs one list page.
const LOOKBACK_HOURS = 72;

// Pages of runs one list reads: a thousand runs in the look-back is far past
// any project the doctor watches, and the cap keeps a misbehaving API from
// paging forever. Past it, the oldest-created runs go unread this poll.
const MAX_RUN_PAGES = 10;

/** Steps that run before the job's own commands: a red here is infrastructure, not a test. */
const SETUP_STEP = /^Set up job$|^Initialize containers$|^(Post )?Run actions\/checkout@/;

/** A conclusion in Buildkite's words, or null when the run is not finished in the ci-doctor's sense. */
function stateOf(conclusion: string | null | undefined): string | null {
  switch (conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "passed";
    case "failure":
      return "failed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "canceled";
    case "startup_failure":
      return "errored";
    default:
      return null;
  }
}

/** Did the job's own commands run? No when a setup step failed, or nothing past setup ever concluded. */
function ranCommands(job: ActionsJob): boolean {
  const failed = failedStep(job);
  if (failed !== null) return !SETUP_STEP.test(failed.name);
  return (job.steps ?? []).some(
    (step) => !SETUP_STEP.test(step.name) && step.conclusion !== null && step.conclusion !== "skipped",
  );
}

/**
 * Did a re-run replace this job? Only when the run lists a later attempt of a
 * job with the same name: a partial re-run leaves the jobs it did not re-run
 * at their old attempt number, and those still stand as the run's result.
 */
const replaced = (job: ActionsJob, all: readonly ActionsJob[]): boolean =>
  all.some((other) => other.name === job.name && (other.run_attempt ?? 1) > (job.run_attempt ?? 1));

function jobOf(run: ActionsRun, job: ActionsJob, all: readonly ActionsJob[]): Job {
  const state = job.conclusion === "skipped" ? "skipped" : (stateOf(job.conclusion) ?? job.conclusion ?? job.status);
  return {
    id: String(job.id),
    type: "script",
    name: job.name,
    state,
    // One commit has one run per workflow; the workflow's name keeps two
    // workflows' same-named jobs apart.
    step_key: `${run.name ?? "?"}/${job.name}`,
    // The exit code is only in the log, which is read later and only for a red job.
    exit_status: null,
    soft_failed: false,
    retried: replaced(job, all),
    web_url: job.html_url ?? null,
    ran: ranCommands(job),
  };
}

/**
 * When the run first started. GitHub resets `run_started_at` to the newest
 * attempt's start while `created_at` keeps the first creation, so a run
 * re-run an hour later would read as an hour's wait for an agent
 * (`infra:scheduled-wait`). The earliest job start is the first attempt's;
 * without one, `run_started_at` is only trusted on a first attempt.
 */
function firstStart(run: ActionsRun, jobs: readonly ActionsJob[]): string | null {
  const starts = jobs.map((job) => job.started_at).filter((at): at is string => typeof at === "string" && at !== "");
  if (starts.length > 0) return starts.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  return (run.run_attempt ?? 1) === 1 ? (run.run_started_at ?? null) : null;
}

export function buildOf(run: ActionsRun, jobs: readonly ActionsJob[], state: string): ApiBuild {
  const pr = run.pull_requests?.[0];
  return {
    number: run.id,
    state,
    branch: run.head_branch ?? "",
    commit: run.head_sha ?? "",
    web_url: run.html_url ?? undefined,
    message: run.head_commit?.message ?? null,
    source: run.event ?? null,
    created_at: run.created_at ?? null,
    started_at: firstStart(run, jobs),
    finished_at: run.updated_at ?? null,
    pull_request: pr ? { id: String(pr.number) } : null,
    jobs: jobs.map((job) => jobOf(run, job, jobs)),
  };
}

export interface ActionsSourceOptions {
  /** A workflow file or id: only its runs are listed. */
  workflow?: string | null;
  /**
   * The project's required check names. A run with none of them among its
   * jobs (CodeQL, Dependabot, Pages) is not the project's CI, and reading it
   * as a build would let a green side workflow call a red main green. Empty:
   * every run counts.
   */
  required?: readonly string[];
  now?: () => number;
  /** How far back by creation the list reaches; `scan.ts`'s WINDOW_HOURS by default. */
  lookbackHours?: number;
}

/** An ISO instant without milliseconds: GitHub's `created` qualifier is not documented to take fractions. */
const wholeSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function actionsSource(gh: Gh, repo: string, options: ActionsSourceOptions = {}): BuildSource {
  const runsPath = options.workflow ? `repos/${repo}/actions/workflows/${options.workflow}/runs` : `repos/${repo}/actions/runs`;
  const required = new Set(options.required ?? []);
  const now = options.now ?? Date.now;
  const lookbackMs = (options.lookbackHours ?? LOOKBACK_HOURS) * 3_600_000;
  return {
    // Every list call reads the whole look-back, so the scan must never page
    // this source: a page cycle advances the cursor past a run that finished on
    // an earlier page after that page was read, and loses it for good.
    exhaustive: true,
    async list(cursor, page, perPage) {
      // A backfill page left by an older store: the first page already read it all.
      if (page > 1) return [];
      const since = wholeSeconds(Math.min(Date.parse(cursor), now() - lookbackMs));
      const runs: ActionsRun[] = [];
      for (let listPage = 1; listPage <= MAX_RUN_PAGES; listPage += 1) {
        const args = ["api", `${runsPath}?status=completed&created=>=${since}&per_page=${perPage}&page=${listPage}`];
        const result = gh(args);
        if (result.error || result.status !== 0) {
          const why = (result.error?.message ?? (result.stderr || result.stdout || `gh exited ${result.status}`)).trim();
          throw new HelperError(`gh ${args.join(" ")} failed: ${why}`, 2);
        }
        let batch: ActionsRun[];
        try {
          const body = JSON.parse(result.stdout) as { workflow_runs?: ActionsRun[] };
          batch = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
        } catch {
          throw new HelperError(`gh ${args.join(" ")}: unparseable output`, 2);
        }
        runs.push(...batch);
        if (batch.length < perPage) break;
      }
      const builds: ApiBuild[] = [];
      for (const run of runs) {
        const state = stateOf(run.conclusion);
        // A run that finished before the cursor was read already, and one with
        // no finished conclusion is not a build yet.
        if (state === null || !run.updated_at || Date.parse(run.updated_at) < Date.parse(cursor)) continue;
        // A jobs read that fails throws, failing the whole poll: skipping the
        // run would let the cursor pass it for good. The next poll retries.
        const jobs = readJobs(gh, repo, String(run.id), "all");
        // Another workflow's run is no build of this project's CI.
        if (required.size > 0 && !jobs.some((job) => required.has(job.name))) continue;
        builds.push(buildOf(run, jobs, state));
      }
      return builds;
    },
    async log(_build, job) {
      return cleanActionsLog(readLog(gh, repo, Number(job.id)));
    },
  };
}

/**
 * Is this project's CI GitHub Actions? `ci-log.ts`'s rule (no required
 * `buildkite/…` check), except that a named Buildkite pipeline always wins: a
 * Buildkite project that sets `RALPH_BUILDKITE_PIPELINE` but whose required
 * checks are unreadable must keep its Buildkite doctor, not lose it to gh.
 */
export function isActionsProject(required: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (env.RALPH_BUILDKITE_PIPELINE?.trim()) return false;
  return projectProvider(required) === "actions";
}
