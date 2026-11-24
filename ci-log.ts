#!/usr/bin/env bun
/**
 * Read a red check's failure, whatever CI ran it (#50): the one command a
 * session's prompt names, so a prompt does not have to know whether the
 * project's CI is Buildkite (`bk-log.ts`) or GitHub Actions
 * (`gh-actions-log.ts`).
 *
 *   bun ci-log.ts <build-or-run> | --pr <n> | --branch <name>  [the reader's flags]
 *
 * The arguments go to the reader of the check's provider, less the one flag
 * that reader does not know: `--repo <owner/name>` is stripped for bk-log (it
 * reads the project's repo itself) and `--no-history` for gh-actions-log (it
 * has no build history to skip). The reader's output and exit code are
 * ci-log's own: for a Buildkite project this is `bk-log.ts` with the same
 * arguments. ci-log prints nothing of its own before routing, so a session
 * reads the same digest it always did.
 *
 * Routing: an Actions run/job URL → Actions; a Buildkite URL → Buildkite;
 * `--pr` → the provider of the PR's failing checks (both, Buildkite first, when
 * both are red); a bare number, `--branch`, or a PR with nothing failing → the
 * project's: Buildkite when `RALPH_BUILDKITE_PIPELINE` is set or a required
 * check is `buildkite/…`, else Actions.
 *
 * Exit: the reader's (on a two-reader route, the first non-zero — except that
 * with `--job` one reader's 1, "no job by that name", yields to the other's
 * 0: the job lives in one CI, not both); 1 for `--rerun` on a Buildkite check (no session re-run
 * there); 2 for an unexpected error in ci-log itself.
 */
import { main as buildkiteMain, parseBuildRef, projectFacts } from "./bk-log";
import { main as actionsMain, parseActionsUrl } from "./gh-actions-log";
import { parseCheck, runGh, type Gh } from "./pr-wait";

export type Provider = "actions" | "buildkite";

/** Which readers run, in order. Two only when a PR has both kinds of check failing. */
export type Route = Provider[];

export const USAGE =
  "usage: ci-log.ts <build|run> | --pr <n> | --branch <name>  [flags]  — the same arguments as bk-log.ts / gh-actions-log.ts,\n" +
  "       passed (less --repo for bk-log, --no-history for gh-actions-log) to gh-actions-log.ts for a GitHub Actions check and to bk-log.ts for a Buildkite one\n" +
  "       (by the URL, else by the PR's failing checks, else by the project's required checks; --rerun is Actions-only)";

export const BUILDKITE_RERUN_REFUSAL =
  "ci-log: no re-run from a session for a Buildkite check; re-run CI the way the prompt says " +
  "(the project's retry, else an empty commit)";

/**
 * The project's CI: a named Buildkite pipeline (`RALPH_BUILDKITE_PIPELINE`) or
 * a required `buildkite/…` check means Buildkite runs it. The pipeline wins
 * because a Buildkite project whose required checks are unreadable or name no
 * `buildkite/` check must keep its Buildkite reader; the ci-doctor's scan
 * (`isActionsProject`) asks this same function, so the two never disagree.
 */
export function projectProvider(requiredChecks: readonly string[], env: NodeJS.ProcessEnv = {}): Provider {
  if (env.RALPH_BUILDKITE_PIPELINE?.trim()) return "buildkite";
  return requiredChecks.some((name) => name.startsWith("buildkite/")) ? "buildkite" : "actions";
}

// Only a URL names its provider: parseBuildRef also takes a bare number, which
// both readers accept, so a ref without an organization is not evidence.
const isBuildkiteUrl = (url: string): boolean => parseBuildRef(url)?.org != null;

export interface RouteInput {
  /** The positional build/run argument, if any. */
  target: string | null;
  /** The PR's `statusCheckRollup` with `--pr`; undefined when there is no PR or it could not be read. */
  rollup?: unknown;
  requiredChecks: readonly string[];
  /** The named Buildkite pipeline (`RALPH_BUILDKITE_PIPELINE`), if any: it makes the project Buildkite's. */
  buildkitePipeline?: string | null;
}

/** Which reader(s) a red check goes to. Pure. */
export function routeFor(input: RouteInput): Route {
  const byProject: Route = [projectProvider(input.requiredChecks, { RALPH_BUILDKITE_PIPELINE: input.buildkitePipeline ?? undefined })];
  if (input.target !== null) {
    if (parseActionsUrl(input.target) !== null) return ["actions"];
    if (isBuildkiteUrl(input.target)) return ["buildkite"];
    return byProject;
  }
  if (input.rollup === undefined) return byProject;
  const failing = (Array.isArray(input.rollup) ? input.rollup : [])
    .map(parseCheck)
    .filter((check) => check !== null && check.state === "fail" && check.url !== null);
  // The failing REQUIRED checks decide when there are any: a red optional
  // workflow beside a red required Buildkite build must not swap the reader a
  // Buildkite project has always got, nor add a second one to its output.
  const required = failing.filter((check) => input.requiredChecks.includes(check!.name));
  const deciding = required.length > 0 ? required : failing;
  const buildkite = deciding.some((check) => isBuildkiteUrl(check!.url!));
  const actions = deciding.some((check) => parseActionsUrl(check!.url!) !== null);
  if (buildkite && actions) return ["buildkite", "actions"];
  if (buildkite) return ["buildkite"];
  if (actions) return ["actions"];
  return byProject;
}

/**
 * The argv one reader gets: each reader refuses a flag only the other knows,
 * so a session that names both (`--repo` for a PR in another repo,
 * `--no-history` to skip Buildkite's history) would otherwise get a usage
 * error from whichever reader the route picked.
 */
export function readerArgv(provider: Provider, argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (provider === "buildkite" && arg === "--repo") {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) i += 1;
      continue;
    }
    if (provider === "actions" && arg === "--no-history") continue;
    out.push(arg);
  }
  return out;
}

interface Args {
  target: string | null;
  pr: string | null;
  repo: string | null;
  job: boolean;
  rerun: boolean;
  help: boolean;
  checkRetryToken: boolean;
}

// The readers' flags that take a value: their value is not a positional target.
const VALUED = new Set(["--pr", "--branch", "--full", "--job", "--grep", "--repo"]);

/** Just enough of the readers' arguments to route; validating them is the reader's job. */
function scan(argv: readonly string[]): Args {
  const args: Args = { target: null, pr: null, repo: null, job: false, rerun: false, help: false, checkRetryToken: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (VALUED.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) continue;
      i += 1;
      if (arg === "--pr") args.pr = value.replace(/^#/, "");
      else if (arg === "--repo") args.repo = value;
      else if (arg === "--job") args.job = true;
    } else if (arg === "--rerun") args.rerun = true;
    else if (arg === "--check-retry-token") args.checkRetryToken = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (!arg.startsWith("-") && args.target === null) args.target = arg;
  }
  return args;
}

/** The PR's rollup, or undefined when gh cannot give it: routing then falls back to the project. */
function readRollup(gh: Gh, pr: string, repo: string | null): unknown {
  const ghArgs = ["pr", "view", pr];
  if (repo) ghArgs.push("--repo", repo);
  ghArgs.push("--json", "statusCheckRollup");
  try {
    const result = gh(ghArgs);
    if (result.error || result.status !== 0) return undefined;
    const rollup = (JSON.parse(result.stdout) as { statusCheckRollup?: unknown }).statusCheckRollup;
    return Array.isArray(rollup) ? rollup : undefined;
  } catch {
    return undefined;
  }
}

export interface Deps {
  gh?: Gh;
  actions?: (argv: string[], env: NodeJS.ProcessEnv) => number;
  buildkite?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: Deps = {}): Promise<number> {
  const gh = deps.gh ?? runGh;
  const actions = deps.actions ?? ((args: string[], readerEnv: NodeJS.ProcessEnv) => actionsMain(args, readerEnv));
  const buildkite = deps.buildkite ?? ((args: string[], readerEnv: NodeJS.ProcessEnv) => buildkiteMain(args, readerEnv));
  try {
    const args = scan(argv);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    const facts = projectFacts(env);
    let route: Route;
    // The retry-token check exists in bk-log only; Actions has no such token.
    if (args.checkRetryToken) route = ["buildkite"];
    else {
      const rollup = args.target === null && args.pr !== null ? readRollup(gh, args.pr, args.repo ?? facts.repo) : undefined;
      route = routeFor({ target: args.target, rollup, requiredChecks: facts.checks, buildkitePipeline: env.RALPH_BUILDKITE_PIPELINE ?? null });
    }
    // A re-run with an Actions run on the route is that run's re-run: printing
    // the Buildkite refusal beside it would read as "nothing was re-run" and
    // send the session to push an empty commit over the re-run it just started.
    if (args.rerun && route.includes("actions")) route = ["actions"];
    const results: number[] = [];
    for (const provider of route) {
      let result: number;
      if (provider === "buildkite") {
        // A session may re-run an Actions run (gh-actions-log guards it), but a
        // Buildkite retry token is the ci-doctor's alone: refuse before bk-log.
        if (args.rerun) {
          console.error(BUILDKITE_RERUN_REFUSAL);
          result = 1;
        } else result = await buildkite(readerArgv("buildkite", argv), env);
      } else result = actions(readerArgv("actions", argv), env);
      results.push(result);
    }
    // A named job lives in one CI: the other reader's "no job by that name"
    // (1) is not a failure when the one that has the job printed it.
    const counted = args.job && results.length > 1 && results.includes(0) ? results.filter((result) => result !== 1) : results;
    return counted.find((result) => result !== 0) ?? 0;
  } catch (error) {
    console.error(`ci-log: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`ci-log: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
