/**
 * Is an operator PR red only on things the ci-doctor already knows?
 *
 * The medic's job is the red that belongs to the branch: a stale base, a
 * conflict, a failure from the branch's own diff. A confirmed flake or an
 * open infrastructure incident is not that — felipearos/ralph#244 leaves both
 * to the doctor — and spending a fresh-context iteration to rediscover it is
 * the waste the intake gate exists to prevent. So before the gate claims a red
 * PR it asks this module, and a PR whose every failure is KNOWN gets the
 * doctor's capped re-run (`ci-doctor/retry.ts`'s `retryHead`) instead of an
 * iteration.
 *
 * "Known" is read the way a coder reads it, off the same `known:` verdicts
 * `bk-log.ts` prints (`ci-doctor/known.ts`'s `knownNotes` over the ci-health
 * store), and it is deliberately narrow:
 *
 * - a failing test is known when its verdict says **confirmed flake** — a
 *   candidate is not, and a test the store also has as red only on this
 *   branch ("likely the diff") is not, whatever else it says;
 * - a failed job with no test failure in it (an agent that would not boot, a
 *   setup step) is known only when an open infra incident in the store has
 *   evidence on THIS build or this head commit. `bk-log.ts` prints every open
 *   incident under `known infra:` whatever the build, which is right for a
 *   reader and wrong for a decision: a false "known" here costs the operator
 *   the medic on that head commit, because the retry is once and then the
 *   gate waits.
 *
 * Anything the module cannot read is NOT known, and comes back as `wait` or
 * `unknown` depending on whether an iteration could do better: a Buildkite
 * read that failed is a `wait` (the iteration would hit the same wall), a red
 * check outside Buildkite or a project with no read token is `unknown`
 * (nothing here could ever call it known, so the iteration diagnoses it).
 */
import {
  Buildkite,
  buildUrlFromRollup,
  cleanLog,
  configuredPipeline,
  digestLog,
  failedJobs,
  parseBuildRef,
  projectFacts,
  resolveOrg,
  tokenFrom,
  type Build,
  type Digest,
} from "../bk-log";
import { knownNotes, type FailureRef } from "../ci-doctor/known";
import type { HeadTarget } from "../ci-doctor/retry";
import { FINISHED_BUILD_STATES, identify, readStore, type CiHealthStore } from "../ci-doctor/store";

export type KnownVerdict =
  /** Every failure is known: retry once, spend no iteration. */
  | { kind: "known"; target: HeadTarget; why: string }
  /** Something here is the branch's own, or cannot be judged by code: an iteration's. */
  | { kind: "unknown"; why: string }
  /** Could not be read, or is not finished: neither retry nor spawn this poll. */
  | { kind: "wait"; why: string };

/** One failed job of the PR's build, as the judgement needs it. */
export interface JobRead {
  id: string;
  /** The job's digest, or null when its log could not be read. */
  digest: Digest | null;
}

/** What the PR is, for the judgement and the retry target. */
export interface PrHead {
  pr: number;
  sha: string;
  branch: string;
}

/** A failing test is known when the doctor has it as a confirmed flake and nothing says it is the diff's. */
export const confirmedFlake = (lines: readonly string[]): boolean =>
  lines.some((line) => /\bconfirmed flake\b/.test(line)) && !lines.some((line) => /likely the diff/.test(line));

/**
 * An open infra incident with evidence on this build or this head. Open is
 * `known.ts`'s reading — not `retired`, not `fixed` — plus not rejected by a
 * doctor (#240), which the gate's own reading excludes too.
 */
export function infraOnBuild(store: CiHealthStore, build: number, sha: string): string | null {
  for (const [key, value] of Object.entries(store.cases ?? {})) {
    if (value?.kind !== "infra" || value.state === "retired" || value.state === "fixed") continue;
    if ((value.rejectedAt ?? null) !== null) continue;
    if ((value.evidence ?? []).some((seen) => seen.build === build || seen.commit === sha)) return key;
  }
  return null;
}

/**
 * The verdict on one finished build's failed jobs. Pure: the store and the
 * logs are read by the caller.
 */
export function judgeBuild(
  head: PrHead,
  build: Build,
  jobs: readonly JobRead[],
  store: CiHealthStore,
  repoSlug: string | null,
): KnownVerdict {
  if (jobs.length === 0) {
    return { kind: "unknown", why: `build #${build.number} has no failed script job to judge` };
  }
  const unread = jobs.find((job) => job.digest === null);
  if (unread !== undefined) {
    return { kind: "wait", why: `job ${unread.id} of build #${build.number} could not be read` };
  }
  const refs: FailureRef[] = jobs.flatMap(({ digest }) =>
    digest!.failures.map((failure) => ({ title: failure.title, files: digest!.files, file: failure.file ?? null })),
  );
  const notes = knownNotes(store, refs, { branch: head.branch, repoSlug });
  const flakes = new Set<string>();
  const incidents = new Set<string>();
  for (const { id, digest } of jobs) {
    if (digest!.failures.length === 0) {
      const incident = infraOnBuild(store, build.number, head.sha);
      if (incident === null) {
        return { kind: "unknown", why: `job ${id} failed with no test failure and no open infra incident on build #${build.number}` };
      }
      incidents.add(incident);
      continue;
    }
    for (const failure of digest!.failures) {
      const { testId } = identify(failure.title, digest!.files, failure.file);
      if (!confirmedFlake(notes.byTestId[testId] ?? [])) {
        return { kind: "unknown", why: `${testId} is not a known flake` };
      }
      flakes.add(testId);
    }
  }
  const parts = [
    flakes.size > 0 ? `${flakes.size} confirmed flake${flakes.size === 1 ? "" : "s"}` : null,
    incidents.size > 0 ? `known infra ${[...incidents].sort().join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return {
    kind: "known",
    target: { pr: head.pr, sha: head.sha, branch: head.branch, build: build.number, jobs: jobs.map((job) => job.id) },
    why: `red only on ${parts.join(" and ")} (build #${build.number})`,
  };
}

/** The Buildkite reads `readKnownRed` makes, injectable for tests. */
export interface BuildkiteReads {
  build: (org: string, pipeline: string, number: number) => Promise<Build>;
  log: (org: string, pipeline: string, number: number, job: string) => Promise<string>;
  org: (pipeline: string) => Promise<string>;
}

export interface KnownDeps {
  /** Null when the project has no read token or no single Buildkite pipeline: nothing can be known. */
  buildkite: (BuildkiteReads & { pipeline: string }) | null;
  storePath: string;
  repoSlug: string | null;
}

/**
 * The verdict for one red PR: which required checks are red, and the rollup
 * they came from. Never throws — every failure is a `wait` or an `unknown`.
 */
export async function readKnownRed(
  deps: KnownDeps,
  head: PrHead,
  red: readonly string[],
  rollup: unknown,
): Promise<KnownVerdict> {
  if (deps.buildkite === null) return { kind: "unknown", why: "no Buildkite read token or pipeline: nothing can be known" };
  const { pipeline } = deps.buildkite;
  const foreign = red.filter((name) => name !== `buildkite/${pipeline}`);
  if (foreign.length > 0) return { kind: "unknown", why: `red on ${foreign.join(", ")}, which is not Buildkite` };
  const url = buildUrlFromRollup(rollup, pipeline);
  const ref = url === null ? null : parseBuildRef(url);
  if (ref === null) return { kind: "unknown", why: `the buildkite/${pipeline} check links no build` };
  try {
    const slug = ref.pipeline ?? pipeline;
    const org = ref.org ?? (await deps.buildkite.org(slug));
    const build = await deps.buildkite.build(org, slug, ref.number);
    // The rollup is the head commit's, so this only fails on a check GitHub
    // has not caught up on; a build of another commit says nothing about this one.
    if (build.commit !== undefined && build.commit !== head.sha) {
      return { kind: "unknown", why: `build #${build.number} ran ${build.commit.slice(0, 10)}, not the head` };
    }
    if (!FINISHED_BUILD_STATES.has(build.state)) {
      return { kind: "wait", why: `build #${build.number} is still ${build.state}` };
    }
    const jobs: JobRead[] = [];
    for (const job of failedJobs(build)) {
      try {
        jobs.push({ id: job.id, digest: digestLog(cleanLog(await deps.buildkite.log(org, slug, build.number, job.id))) });
      } catch {
        jobs.push({ id: job.id, digest: null });
      }
    }
    return judgeBuild(head, build, jobs, readStore(deps.storePath), deps.repoSlug);
  } catch (error) {
    return { kind: "wait", why: `Buildkite could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The real reads, with the READ token. Null when there is no token or no pipeline. */
export function knownDepsFrom(env: NodeJS.ProcessEnv, storePath: string): KnownDeps {
  const token = tokenFrom(env);
  const pipeline = configuredPipeline(env);
  const repo = projectFacts(env).repo ?? "";
  const slash = repo.indexOf("/");
  const repoSlug = slash === -1 ? null : repo.slice(slash + 1);
  if (token === null || pipeline === null) return { buildkite: null, storePath, repoSlug };
  const api = new Buildkite(token);
  // Resolved at most once per process, as the doctor's retry does: unless
  // RALPH_BUILDKITE_ORG is set it is itself one or two Buildkite reads. A
  // failure is forgotten rather than memoised: the gate runs for days, and one
  // Buildkite blip must not make every later poll a `wait`.
  let org: Promise<string> | null = null;
  return {
    storePath,
    repoSlug,
    buildkite: {
      pipeline,
      org: (slug) =>
        (org ??= resolveOrg(api, env, slug).catch((error: unknown) => {
          org = null;
          throw error;
        })),
      build: (o, p, n) => api.json<Build>(`/organizations/${o}/pipelines/${p}/builds/${n}`),
      log: (o, p, n, job) => api.text(`/organizations/${o}/pipelines/${p}/builds/${n}/jobs/${job}/log`),
    },
  };
}
