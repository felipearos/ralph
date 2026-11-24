/**
 * A fake gh for the ci-doctor's GitHub Actions source (`actions-source.ts`):
 * it answers the `gh api` paths the source reads, as GitHub would at a given
 * moment, the way `fixture-replay.ts`'s `fakeBuildkite` answers Buildkite's.
 */
import type { ActionsJob, ActionsRun } from "../gh-actions-log";
import type { Gh, GhResult } from "../pr-wait";

export interface FakeActions {
  gh: Gh;
  /** Every `gh api` path requested, in order. */
  calls: string[];
  /** The moment the API answers for: runs updated later do not exist yet. */
  setNow(ms: number): void;
}

const ok = (body: unknown): GhResult => ({ status: 0, stdout: typeof body === "string" ? body : JSON.stringify(body), stderr: "" });
const notFound = (path: string): GhResult => ({ status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) ${path}` });

/**
 * A GitHub that knows `runs`, each run's jobs (every attempt's) in
 * `jobsByRun`, and each job's raw log in `logsByJob`.
 */
export function fakeActions(
  runs: readonly ActionsRun[],
  jobsByRun: Record<number, ActionsJob[]> = {},
  logsByJob: Record<number, string> = {},
): FakeActions {
  let now = Infinity;
  const calls: string[] = [];
  const gh: Gh = (args) => {
    if (args[0] !== "api") return notFound(args.join(" "));
    const path = args.filter((arg) => !arg.startsWith("--")).slice(1)[0] ?? "";
    calls.push(path);

    const list = /^repos\/[^/]+\/[^/]+\/actions\/(?:workflows\/([^/]+)\/)?runs\?(.*)$/.exec(path);
    if (list) {
      const query = new URLSearchParams(list[2]!);
      const created = (query.get("created") ?? "").replace(/^>=/, "");
      const status = query.get("status");
      const perPage = Number(query.get("per_page") ?? 30);
      const page = Number(query.get("page") ?? 1);
      const visible = runs
        .filter((run) => run.updated_at && Date.parse(run.updated_at) <= now)
        .filter((run) => (status === null ? true : run.status === status))
        .filter((run) => (run.created_at ?? "") >= created)
        .filter((run) => (list[1] ? String(run.workflow_id) === list[1] || run.name === list[1] : true))
        .sort((a, b) => b.id - a.id);
      const slice = visible.slice((page - 1) * perPage, page * perPage);
      return ok({ total_count: visible.length, workflow_runs: slice });
    }

    const jobs = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs\?(.*)$/.exec(path);
    if (jobs) {
      const id = Number(jobs[1]);
      const query = new URLSearchParams(jobs[2]!);
      const run = runs.find((candidate) => candidate.id === id);
      if (run === undefined) return notFound(path);
      const all = jobsByRun[id] ?? [];
      // GitHub's default (`latest`) hides what a re-run replaced.
      const listed = query.get("filter") === "all" ? all : all.filter((job) => (job.run_attempt ?? 1) === (run.run_attempt ?? 1));
      const perPage = Number(query.get("per_page") ?? 30);
      const page = Number(query.get("page") ?? 1);
      return ok({ total_count: listed.length, jobs: listed.slice((page - 1) * perPage, page * perPage) });
    }

    const log = /^repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (log && Number(log[1]) in logsByJob) return ok(logsByJob[Number(log[1])]!);
    return notFound(path);
  };
  return {
    gh,
    calls,
    setNow(ms: number) {
      now = ms;
    },
  };
}
