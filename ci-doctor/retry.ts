/**
 * Re-run a candidate flake's failed job, so the doctor can confirm it without
 * waiting for someone else's build.
 *
 * A candidate flake is a test the rules in `classify.ts` think is flaky and
 * cannot yet prove it of: one red, nothing green on the same tree to set
 * beside it. The proof it is missing is cheap — re-run that one job — and
 * until now the doctor could only wait for a natural rerun, which on a quiet
 * branch means the candidate ages out at `retireHours` with nothing learnt.
 *
 * Retrying is a WRITE, and the loops' Buildkite access has been read-only by
 * design. So this is the one narrow exception, and it is held by code rather
 * than by the model: the credential is `RALPH_BUILDKITE_RETRY_TOKEN`, whose
 * only scope is `write_builds` (`bk-log.ts --check-retry-token`), the
 * supervisor exports it to an intake GATE alone — the doctor's, and since
 * felipearos/ralph#245 the pr-medic's, never a model session — and this module is
 * handed a bound `put` rather than a token. Nothing here names the variable, so
 * no code path in it can print the value.
 *
 * Four fences, and each one is a thing that went wrong somewhere else first:
 *
 * - **Only a candidate.** A confirmed flake has nothing to learn, and a
 *   regression, an infra failure or a PR-specific failure is not flaky at all:
 *   re-running it rebuilds someone's broken commit and reports the same red.
 *   The pr-medic's `retryHead` is the one exception, and it is a different
 *   question: not "is this a flake?" but "is this operator PR red only on
 *   things the doctor already knows?" — which a re-run answers by going green.
 * - **Never a merge-queue branch.** `mergify/merge-queue/*` is deleted the
 *   moment the queue moves on, so a retry there either 404s or proves something
 *   about a branch that no longer exists.
 * - **Tightly capped**: one retry per candidate ever, six per UTC day across
 *   every doctor — and every pr-medic, whose `retryHead` below spends the same
 *   counter — counted in the shared store under its lock and lowerable from
 *   `ciDoctor.retry`. The caps are the whole reason the token can be trusted to
 *   code — `RETRY_CEILINGS` may be lowered by a project and never raised.
 * - **Only while the host is idle.** CI here runs on the same desktop the loops
 *   do, and a retry queued behind a coder's own build is the doctor spending
 *   the host its colleagues are waiting for. `host-lease.ts`'s `readCi` answers
 *   it, and an unreadable answer is busy.
 *
 * What a retry then means is already decided elsewhere, and deliberately not
 * re-decided here: the next scan records the retried job
 * (`scan.ts:318-343,408`), and `classify.ts:250-263` reads a PASS as "same
 * tree, both colours" — the rule that confirms — while a second failure is a
 * `retried: true` row that every rule excludes from its evidence. So a retry
 * can confirm a flake and can never, by itself, convict one.
 *
 * felipearos/ralph#161.
 */

import { RETRY_CEILINGS } from "../project-config";
import { QUEUE_BRANCH } from "./classify";
import {
  FINISHED_BUILD_STATES,
  readStore,
  subjectOf,
  utcDay,
  withStore,
  type CiHealthStore,
  type Failure,
} from "./store";

export interface Candidate {
  /** The store case key, `flake:<test id>`. */
  key: string;
  testId: string;
  build: number;
  /** The Buildkite job id — what the retry is addressed to. */
  job: string;
  branch: string;
  commit: string;
  step: string | null;
}

export interface EligibleOptions {
  baseBranch: string;
  /** `git ls-remote`'s answer for a branch, or null when it could not be read. */
  branchHead: (branch: string) => string | null;
  /** Clamped ceilings — `perCandidate` is read here, `perDay` by `budget`. */
  ceilings: Ceilings;
  now: number;
}

/**
 * Every retry the rules allow right now, newest red first. Pure but for
 * `branchHead`, which is asked only about a non-base branch and only after
 * every cheaper fence has passed.
 */
export function eligible(store: CiHealthStore, options: EligibleOptions): Candidate[] {
  const builds = new Map(store.builds.map((build) => [build.number, build]));
  const today = unscannedOrToday(store, utcDay(options.now));
  const out: Candidate[] = [];
  // One `git ls-remote` per BRANCH, not per row: a candidate with four reds on
  // one PR branch asked four times.
  const heads = new Map<string, string | null>();
  const branchHead = (branch: string): string | null => {
    if (!heads.has(branch)) heads.set(branch, options.branchHead(branch));
    return heads.get(branch) ?? null;
  };

  for (const [key, value] of Object.entries(store.cases)) {
    if (value.kind !== "flake" || value.state !== "candidate") continue;
    const testId = subjectOf(key);
    const mine = store.failures.filter((row) => row.testId === testId && row.kind !== "bootstrap");
    // `perCandidate`, and it does NOT reset with the day. The scan marks a
    // retried job's row `retried: true` and keeps it for the whole 72-hour
    // window (`scan.ts:408`), so counting those rows is the durable guard —
    // where `count` resets every UTC day. `byCase` covers the remaining gap,
    // between the retry and the next scan, before any row has been marked;
    // `unscannedOrToday` is the rule for which of its records still bind.
    if (mine.filter((row) => row.retried).length >= options.ceilings.perCandidate) continue;
    if (today[testId] !== undefined) continue;
    const rows = mine.filter((row) => !row.retried).sort((a, b) => b.build - a.build);
    const row = rows.find((candidate) => retryable(candidate, builds, options.baseBranch, branchHead));
    if (row !== undefined) {
      out.push({ key, testId, build: row.build, job: row.job, branch: row.branch, commit: row.commit, step: row.step });
    }
  }
  // Newest red first: the freshest evidence is the one a coder is waiting on.
  return out.sort((a, b) => b.build - a.build);
}

function retryable(
  row: Failure,
  builds: Map<number, CiHealthStore["builds"][number]>,
  baseBranch: string,
  branchHead: (branch: string) => string | null,
): boolean {
  if (row.job === "") return false;
  // A queue branch is gone as soon as the queue moves on, so a retry on it
  // either 404s or proves something about a branch nothing will merge.
  if (QUEUE_BRANCH.test(row.branch)) return false;
  const build = builds.get(row.build);
  // A build still running may yet finish the job on its own, and a build this
  // store has no record of cannot be shown to be finished at all.
  if (build === undefined || !FINISHED_BUILD_STATES.has(build.state)) return false;
  if (row.branch === baseBranch) return true;
  // A PR branch that has moved on: the retry would rebuild a commit nobody is
  // waiting for, and its colour says nothing about the branch's head. This is
  // the one question in the module that leaves the machine, which is why it is
  // asked last and memoised per branch.
  const head = branchHead(row.branch);
  return head !== null && head === row.commit;
}

/* --------------------------------------------------------------------------
 * The caps.
 * ----------------------------------------------------------------------- */

/**
 * `2026-10-05` — the UTC day `store.retries.count` covers. Re-exported from
 * the store, which is where the grammar lives now that the scan and the gate
 * key per-day metrics by it too.
 */
export { utcDay };

const sameDayAs = (store: CiHealthStore, day: string): boolean => store.retries.day === day;

/**
 * The per-candidate records that still bind: today's, plus any of an earlier
 * day's whose retried job the scan has neither marked nor forgotten.
 *
 * The carry-over is what closes a hole between the two per-candidate guards. A
 * retry made shortly before 00:00 UTC is guarded only by `byCase` until the
 * next scan marks its row `retried: true` — and `count`, the only thing a
 * rollover could key on, resets with the day, so the rollover alone would let
 * the same candidate be retried a second time.
 *
 * It is keyed on the job id, and a record is dropped as soon as the store stops
 * holding that job's row AT ALL — not only once the row is marked. Dropping
 * only on the marking read well and was wrong in both directions: a retry whose
 * PUT faulted, or whose job Buildkite never reports as retried, is never marked
 * by anything, so its record was carried across every rollover for ever. That
 * barred the candidate permanently and grew `byCase` without bound, while the
 * SUCCESSFUL path's guard — the marked row — expires with the store's 72-hour
 * window. The failed retry was the stricter of the two, which is backwards.
 */
export function unscannedOrToday(store: CiHealthStore, day: string): Record<string, string> {
  // Copied on both paths: this is exported, and returning the live object on
  // one of them would hand a caller a mutable handle on the store.
  if (sameDayAs(store, day)) return { ...store.retries.byCase };
  const held = new Set(store.failures.filter((row) => !row.retried).map((row) => row.job));
  return Object.fromEntries(Object.entries(store.retries.byCase).filter(([, job]) => held.has(job)));
}

export interface Ceilings {
  perCandidate: number;
  perDay: number;
}

/**
 * The project's ceilings, never above `RETRY_CEILINGS`.
 *
 * `project-config.ts` already refuses a config that raises them, but this
 * clamps as well: the config is read leniently here (the gate does the same at
 * `gate.ts:775`), so an unvalidated object must not be able to buy the doctor
 * more writes than the code allows.
 */
export function ceilings(config: unknown): Ceilings {
  const block = (config as { ciDoctor?: { retry?: { perCandidate?: unknown; perDay?: unknown } } } | null)?.ciDoctor?.retry;
  const read = (value: unknown, ceiling: number): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, ceiling) : ceiling;
  return {
    perCandidate: read(block?.perCandidate, RETRY_CEILINGS.perCandidate),
    perDay: read(block?.perDay, RETRY_CEILINGS.perDay),
  };
}

export interface Budget {
  allowed: number;
  why: string;
}

/** How many retries are left today, and why that is the number. */
export function budget(store: CiHealthStore, config: unknown, now: number): Budget {
  const limits = ceilings(config);
  if (limits.perCandidate === 0) return { allowed: 0, why: "ciDoctor.retry.perCandidate is 0: retries are off" };
  if (limits.perDay === 0) return { allowed: 0, why: "ciDoctor.retry.perDay is 0: retries are off" };
  const day = utcDay(now);
  const spent = sameDayAs(store, day) ? store.retries.count : 0;
  const allowed = Math.max(0, limits.perDay - spent);
  return allowed === 0
    ? { allowed, why: `${limits.perDay} retries already spent on ${day}` }
    : { allowed, why: `${allowed} of ${limits.perDay} retries left on ${day}` };
}

/* --------------------------------------------------------------------------
 * Doing it.
 * ----------------------------------------------------------------------- */

export type RetryOutcome = "retried" | "none" | "busy" | "capped" | "no-budget" | "fault";

export interface Retried extends Candidate {
  path: string;
}

export interface RetryResult {
  outcome: RetryOutcome;
  why: string;
  retried: Retried | null;
  /**
   * `gh` calls this attempt RESERVED, for the caller to record.
   *
   * Reserved, not counted: `readCi` can bail after its first call
   * (`host-lease.ts:433`) and does not say how many it made, so this is
   * `ciReadCalls` whenever the read was entered at all. Over-reporting is the
   * safe direction — the doctor gate's allowance
   * (`ci-doctor/gh-budget.ts`) is the one thing standing between four loops on
   * one account and the throttling of 2026-09-28 — and under-reporting would
   * spend the account's goodwill rather than the gate's budget.
   */
  ghCalls: number;
}

export interface RetryDeps {
  storePath: string;
  /**
   * The Buildkite organization, resolved only when there is a retry to make.
   *
   * Lazy because resolving it is itself one or two Buildkite reads: resolving
   * eagerly meant every poll paid them whatever the fences said, and a project
   * whose organization is genuinely ambiguous logged a `fault` every five
   * minutes with no candidate in sight.
   */
  org: () => Promise<string>;
  pipeline: string;
  baseBranch: string;
  /** The project config, read leniently: this module clamps whatever it finds. */
  config: unknown;
  now: () => number;
  /** `Buildkite.put`, bound to the RETRY token by the caller. */
  put: (path: string) => Promise<void>;
  readCi: () => { busy: boolean; detail: string };
  /** `gh` calls one `readCi` costs — `host-lease.ts`'s `CI_READ_GH_CALLS`. */
  ciReadCalls: number;
  /** May this attempt spend `calls` GitHub calls of the gate's allowance? */
  afford: (calls: number) => boolean;
  /** Is a host lease held, or anybody queued for one? */
  hostLeaseBusy: () => { busy: boolean; detail: string };
  branchHead: (branch: string) => string | null;
  /**
   * Where the write goes, when it is not Buildkite's job retry: an Actions
   * project re-runs one job via `repos/<repo>/actions/jobs/<id>/rerun`.
   * Unset, the module's Buildkite `retryPath`.
   */
  retryPath?: (org: string, pipeline: string, build: number, job: string) => string;
  /**
   * GitHub calls one `put` costs, charged whether it succeeds or faults: an
   * Actions re-run is a `gh api` POST on the gate's allowance. Buildkite's
   * write costs none; unset is 0.
   */
  putGhCalls?: number;
}

export const retryPath = (org: string, pipeline: string, build: number, job: string): string =>
  `/organizations/${org}/pipelines/${pipeline}/builds/${build}/jobs/${job}/retry`;

/**
 * The last fences before a retry's write: the GitHub calls that show the host
 * idle, that read, and the host lease asked a second time. Shared by the
 * doctor's `retryOnce` and the medic's `retryHead`, because a retry is the
 * same write on the same host whichever role spends it, and two copies of
 * "is the host idle" is how one of them would come to skip a fence.
 *
 * `ghCalls` is what the caller reports to its gate's ledger — reserved, not
 * counted (see `RetryResult.ghCalls`) — and is non-zero whenever `readCi` was
 * entered, including when it then said busy.
 */
function confirmIdle(deps: RetryDeps): { stop: { outcome: RetryOutcome; why: string } | null; ghCalls: number } {
  // Immediately before the call: the GitHub calls that show the host idle must
  // be affordable on the gate's own allowance before they are made.
  if (!deps.afford(deps.ciReadCalls)) {
    return {
      stop: {
        outcome: "no-budget",
        why: `the gate's GitHub allowance has no room for the ${deps.ciReadCalls} calls that show the host idle`,
      },
      ghCalls: 0,
    };
  }
  const spentGh = deps.ciReadCalls;
  const ci = deps.readCi();
  if (ci.busy) return { stop: { outcome: "busy", why: `CI is busy or unreadable: ${ci.detail}` }, ghCalls: spentGh };

  // The lease again, IMMEDIATELY before the write. The caller's earlier read is
  // the cheap refusal that saves its remote calls on a busy host; this one is
  // the fence the spec asks for, because `readCi` (and the doctor's
  // `eligible`) leave the machine and a coder can take the lease while they are
  // out. It is a local file, so asking twice costs nothing.
  const still = deps.hostLeaseBusy();
  if (still.busy) {
    return { stop: { outcome: "busy", why: `the host lease was taken while reading: ${still.detail}` }, ghCalls: spentGh };
  }
  return { stop: null, ghCalls: spentGh };
}

/**
 * At most ONE retry, and the next poll takes the next one.
 *
 * The slot is claimed under the store lock BEFORE the call, and the lock is
 * released before it. That order spends a retry on a crash between the two,
 * which is the safe direction: the other order lets two doctors sharing a store
 * read the same count and both call, which is exactly the cap this is here to
 * hold. A spent slot costs the doctor one of six writes a day; a double call
 * costs the host a build nobody asked for.
 */
export async function retryOnce(deps: RetryDeps): Promise<RetryResult> {
  const now = deps.now();
  const store = readStore(deps.storePath);
  const limits = ceilings(deps.config);
  // The cap is asked FIRST, and it is a fact whether or not anything is
  // eligible: it is cheaper than `eligible` (which asks git about a PR
  // branch's head), and `capped` names the ceiling that stopped the doctor
  // where `none` would send an operator looking for a candidate instead.
  const room = budget(store, deps.config, now);
  if (room.allowed === 0) return { outcome: "capped", why: room.why, retried: null, ghCalls: 0 };

  // Cheapest first, and `eligible` is NOT cheap: it asks `git ls-remote` about
  // every candidate's PR branch, which leaves the machine. The host-lease store
  // is a local file, so on the common case for this harness — a busy desktop,
  // the lease held — a poll now refuses without a single remote call.
  const lease = deps.hostLeaseBusy();
  if (lease.busy) return { outcome: "busy", why: `the host lease is in use: ${lease.detail}`, retried: null, ghCalls: 0 };

  const ready = eligible(store, { baseBranch: deps.baseBranch, branchHead: deps.branchHead, ceilings: limits, now });
  if (ready.length === 0) {
    return { outcome: "none", why: "no candidate flake has a retryable failed job", retried: null, ghCalls: 0 };
  }

  const idle = confirmIdle(deps);
  if (idle.stop !== null) return { ...idle.stop, retried: null, ghCalls: idle.ghCalls };
  const spentGh = idle.ghCalls;

  const pick = ready[0]!;
  const day = utcDay(now);
  // Re-check inside the lock: another doctor may have spent the last slot
  // between the read above and here.
  const claimed = await withStore(deps.storePath, (open) => {
    // The rollover carries forward any record whose retry the scan has not
    // seen yet, which is `unscannedOrToday`'s whole purpose; wiping `byCase`
    // here would reopen the hole it closes.
    if (open.retries.day !== day) open.retries = { day, count: 0, byCase: unscannedOrToday(open, day) };
    if (open.retries.byCase[pick.testId] !== undefined) {
      return `another doctor retried ${pick.testId} between the read and the claim`;
    }
    if (budget(open, deps.config, now).allowed === 0) return `another doctor took the last retry of ${day}`;
    open.retries.count += 1;
    open.retries.byCase[pick.testId] = pick.job;
    return null;
  });
  // Two different races, and they had one message: an operator told "the last
  // retry of today is gone" when five of six remain would go looking for a
  // ceiling that had not moved.
  if (claimed !== null) return { outcome: "capped", why: claimed, retried: null, ghCalls: spentGh };

  let path: string;
  try {
    path = (deps.retryPath ?? retryPath)(await deps.org(), deps.pipeline, pick.build, pick.job);
  } catch (error) {
    // Asked after the claim, so this spends a slot. That is the lesser evil:
    // asking before it would read Buildkite on every poll that had nothing to
    // retry, which is what the eager version did.
    return {
      outcome: "fault",
      why: `the CI organization could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      retried: null,
      ghCalls: spentGh,
    };
  }
  const putGh = deps.putGhCalls ?? 0;
  try {
    await deps.put(path);
  } catch (error) {
    // The slot stays spent. A non-2xx does not say whether Buildkite started
    // the job, so rolling the claim back here could retry it twice.
    return {
      outcome: "fault",
      why: `retrying ${pick.testId} failed: ${error instanceof Error ? error.message : String(error)}`,
      retried: null,
      ghCalls: spentGh + putGh,
    };
  }
  return {
    outcome: "retried",
    why: `retried ${pick.job} of build #${pick.build} (${pick.branch}) for ${pick.testId}; ${room.why}`,
    retried: { ...pick, path },
    ghCalls: spentGh + putGh,
  };
}

/* --------------------------------------------------------------------------
 * The pr-medic's retry: one per head commit of a red operator PR.
 * ----------------------------------------------------------------------- */

/**
 * A red operator PR whose every failure the doctor already knows — a confirmed
 * flake, or an open infrastructure incident — at one head commit. The medic
 * gate (`pr-medic/gate.ts`) builds it from the PR's Buildkite build; nothing
 * here re-derives that verdict.
 */
export interface HeadTarget {
  pr: number;
  /** The PR's head commit, which the build ran on. */
  sha: string;
  branch: string;
  build: number;
  /**
   * Every failed job of the build. ALL of them, not the first: the check stays
   * red while any one does, so retrying a subset spends a slot on a build that
   * cannot go green.
   */
  jobs: string[];
}

/** `2197@<sha>` — a `prRetries` key. */
export const headKey = (pr: number, sha: string): string => `${pr}@${sha}`;

/**
 * How long a medic retry record is kept. The record is what makes "once per
 * head commit" hold, and a head commit that is still red and unpushed after
 * two weeks is a pull request nobody is working; letting it be retried once
 * more then costs one slot of one day, where never pruning grows the store for
 * ever.
 */
export const HEAD_RETRY_KEEP_DAYS = 14;

/** Has this PR's head commit already had its one retry? */
export const headRetried = (store: CiHealthStore, pr: number, sha: string): boolean =>
  store.prRetries?.[headKey(pr, sha)] !== undefined;

export interface HeadRetryResult {
  outcome: RetryOutcome;
  why: string;
  retried: (HeadTarget & { paths: string[] }) | null;
  /** As `RetryResult.ghCalls`: reserved for the caller's ledger. */
  ghCalls: number;
}

/**
 * Re-run every failed job of one red operator PR build, at most once per head
 * commit, on the doctor's daily cap.
 *
 * The cap is the doctor's own and is SHARED rather than copied: the slots are
 * counted in `store.retries.count` under the store lock exactly as
 * `retryOnce` counts them, against the same `ceilings(config)`, so a project
 * running both roles gets six retries a day between them and not six each
 * (felipearos/ralph#244, "shares doc's daily retry cap"). One slot per job,
 * because each PUT is one rebuild on the host the cap protects.
 *
 * The fences are `retryOnce`'s, in its order and for its reasons — cap, host
 * lease, the idle read on the gate's allowance, the lease again — with the
 * doctor's candidate rules replaced by the medic's single one: this head has
 * not been retried before. A crash between the claim and the call spends the
 * slots and the head's one retry, which is the safe direction for the reason
 * `retryOnce` gives.
 */
export async function retryHead(deps: RetryDeps, target: HeadTarget): Promise<HeadRetryResult> {
  const now = deps.now();
  const store = readStore(deps.storePath);
  const key = headKey(target.pr, target.sha);
  const none = (outcome: RetryOutcome, why: string, ghCalls = 0): HeadRetryResult => ({ outcome, why, retried: null, ghCalls });
  if (headRetried(store, target.pr, target.sha)) {
    return none("none", `PR #${target.pr}'s head ${target.sha.slice(0, 10)} was already retried once`);
  }
  if (target.jobs.length === 0) return none("none", `build #${target.build} has no failed job to retry`);
  const room = budget(store, deps.config, now);
  if (room.allowed < target.jobs.length) {
    return none(
      "capped",
      room.allowed === 0 ? room.why : `${target.jobs.length} failed jobs and only ${room.allowed} retries left today`,
    );
  }
  const lease = deps.hostLeaseBusy();
  if (lease.busy) return none("busy", `the host lease is in use: ${lease.detail}`);

  const idle = confirmIdle(deps);
  if (idle.stop !== null) return none(idle.stop.outcome, idle.stop.why, idle.ghCalls);
  const spentGh = idle.ghCalls;

  const day = utcDay(now);
  const claimed = await withStore(deps.storePath, (open) => {
    // The doctor's rollover, so a medic retry on a new day keeps the doctor's
    // unscanned records exactly as `retryOnce` would.
    if (open.retries.day !== day) open.retries = { day, count: 0, byCase: unscannedOrToday(open, day) };
    if (headRetried(open, target.pr, target.sha)) {
      return `another gate retried PR #${target.pr}'s head between the read and the claim`;
    }
    if (budget(open, deps.config, now).allowed < target.jobs.length) return "another gate took today's last retries";
    open.retries.count += target.jobs.length;
    const cutoff = now - HEAD_RETRY_KEEP_DAYS * 86_400_000;
    // Read leniently: a hand-edited record with no parseable `at` is dropped
    // rather than kept for ever.
    const kept = Object.entries(open.prRetries ?? {}).filter(([, record]) => {
      const at = Date.parse(record?.at ?? "");
      return Number.isFinite(at) && at >= cutoff;
    });
    open.prRetries = {
      ...Object.fromEntries(kept),
      [key]: { at: new Date(now).toISOString(), build: target.build, jobs: [...target.jobs] },
    };
    return null;
  });
  if (claimed !== null) return none("capped", claimed, spentGh);

  let org: string;
  try {
    org = await deps.org();
  } catch (error) {
    return none(
      "fault",
      `the CI organization could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      spentGh,
    );
  }
  const paths: string[] = [];
  let putGh = 0;
  for (const job of target.jobs) {
    const path = (deps.retryPath ?? retryPath)(org, deps.pipeline, target.build, job);
    putGh += deps.putGhCalls ?? 0;
    try {
      await deps.put(path);
    } catch (error) {
      // The slots and the head's one retry stay spent: a non-2xx does not say
      // whether Buildkite started the job (see `retryOnce`).
      return none(
        "fault",
        `retrying job ${job} of build #${target.build} failed: ${error instanceof Error ? error.message : String(error)}`,
        spentGh + putGh,
      );
    }
    paths.push(path);
  }
  return {
    outcome: "retried",
    why: `retried ${target.jobs.length} failed job(s) of build #${target.build} (PR #${target.pr}, ${target.branch} @ ${target.sha.slice(0, 10)}); ${room.why}`,
    retried: { ...target, paths },
    ghCalls: spentGh + putGh,
  };
}
