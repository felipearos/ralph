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
import type { Gh } from "../pr-wait";
import type { ApiBuild, BuildSource } from "./scan";

// A run created before the cursor may finish after it, and the runs API
// filters on creation only. The store dedupes builds by number and jobs by id,
// so reading the overlap again is harmless.
const CREATED_SLACK_MS = 6 * 3_600_000;

/** Steps that run before the job's own commands: a red here is infrastructure, not a test. */
const SETUP_STEP = /^Set up job$|^Initialize containers$|checkout/i;

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

function jobOf(run: ActionsRun, job: ActionsJob): Job {
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
    retried: (job.run_attempt ?? 1) < (run.run_attempt ?? 1),
    web_url: job.html_url ?? null,
    ran: ranCommands(job),
  };
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
    started_at: run.run_started_at ?? null,
    finished_at: run.updated_at ?? null,
    pull_request: pr ? { id: String(pr.number) } : null,
    jobs: jobs.map((job) => jobOf(run, job)),
  };
}

export function actionsSource(gh: Gh, repo: string, options: { workflow?: string | null } = {}): BuildSource {
  const runsPath = options.workflow ? `repos/${repo}/actions/workflows/${options.workflow}/runs` : `repos/${repo}/actions/runs`;
  return {
    async list(cursor, page, perPage) {
      const since = new Date(Date.parse(cursor) - CREATED_SLACK_MS).toISOString();
      const args = ["api", `${runsPath}?status=completed&created=>=${since}&per_page=${perPage}&page=${page}`];
      const result = gh(args);
      if (result.error || result.status !== 0) {
        const why = (result.error?.message ?? (result.stderr || result.stdout || `gh exited ${result.status}`)).trim();
        throw new HelperError(`gh ${args.join(" ")} failed: ${why}`, 2);
      }
      let runs: ActionsRun[];
      try {
        const body = JSON.parse(result.stdout) as { workflow_runs?: ActionsRun[] };
        runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
      } catch {
        throw new HelperError(`gh ${args.join(" ")}: unparseable output`, 2);
      }
      return runs.map((run) => {
        const state = stateOf(run.conclusion);
        // A run that finished before the cursor was read already, and one with
        // no finished conclusion is not a build yet. Both stay in the page as
        // unfinished placeholders, unread, because the page's LENGTH is what
        // tells the scan a page was full and older runs are still unread.
        if (state === null || !run.updated_at || Date.parse(run.updated_at) < Date.parse(cursor)) {
          return { number: run.id, state: "unfinished", branch: run.head_branch ?? "", commit: run.head_sha ?? "" };
        }
        // A jobs read that fails throws, failing the whole poll: skipping the
        // run would let the cursor pass it for good. The next poll retries.
        return buildOf(run, readJobs(gh, repo, String(run.id), "all"), state);
      });
    },
    async log(_build, job) {
      return cleanActionsLog(readLog(gh, repo, Number(job.id)));
    },
  };
}
