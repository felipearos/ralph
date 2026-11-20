/**
 * The ci-doctor's classification rules (spec felipearos/ralph#132 §3), as
 * pure functions over the ci-health store. No network, no git: everything the
 * rules need was recorded on the store's build rows by the scan.
 *
 * Per test T (a test id), in order of precedence:
 *
 *   1. REGRESSION ON MAIN. T fails on the last 2+ main builds that ran its
 *      step, with the same kind and line, and on every queue build since the
 *      first of them. It outranks every flake rule, even for a timeout:
 *      consistent red on main is never a flake. The culprit is the first red
 *      main commit; it is unambiguous only when the main build before the run
 *      was green and on the culprit's parent exactly, no build in the run is
 *      infra, and the culprit names exactly one merged PR.
 *   2. PR-SPECIFIC, per branch. T fails on one PR branch, no other branch
 *      has the same failure, and the branch's diff touches T's file or T's
 *      line names a path the branch changes (a ratchet: "may only shrink;
 *      new paths: …"). Those rows are not flake evidence.
 *   3. FLAKE. A candidate is a failure whose kind is `timeout`/`hook-timeout`
 *      or whose assertion line appears in another build, on main or the
 *      queue, or on a PR build whose diff leaves T's file alone. It is
 *      confirmed by zero-cost evidence: the same tree passed T's step
 *      (another build, or a retry of the red job); T failed in 3+ builds on
 *      2+ branches and one of them went green next without touching T's
 *      file; or a red main build was followed by a green one that did not
 *      touch T's file. An unconfirmed candidate with nothing new for 48 h is
 *      retired.
 *
 * INFRASTRUCTURE is separate: a job that failed before its commands ran
 * (`bootstrap` rows, keyed by signature), a build that sat scheduled for more
 * than 30 min, and, from the gate's GitHub read, a non-Buildkite required
 * check red on 3+ PRs with one description (`checkIncidents`).
 */
import type { BuildRecord, Case, CaseState, CiHealthStore, Culprit, Evidence, Failure } from "./store";

export interface ClassifyOptions {
  baseBranch: string;
  /** A candidate with nothing new for this long is retired. */
  retireHours: number;
  /** A build that waited longer than this to start is an infra incident. */
  scheduledMinutes: number;
}

export const DEFAULT_CLASSIFY: ClassifyOptions = { baseBranch: "main", retireHours: 48, scheduledMinutes: 30 };

export const QUEUE_BRANCH = /^mergify\/merge-queue\//;

/** States a later stage owns: the scan never moves a case out of them. */
export const MANAGED_STATES: ReadonlySet<CaseState> = new Set(["filed", "fixing", "fixed", "handed-off"]);

/**
 * Does this case's rejection still stand against the evidence given (#240)?
 *
 * `recurred`'s mirror (`gate.ts`): a doctor's rejection is taken as of a build,
 * and only evidence from a LATER build overturns it. Strictly later — a
 * rejection taken as of build N was taken with build N already read.
 *
 * A case with no `rejectedAt` was never rejected, so nothing stands: that is
 * the answer for `classify.ts`'s own stale-retire, which reaches `retired`
 * without ever writing the field, and which must keep folding as it always has.
 *
 * Passing `[]` asks the narrower question "is this case rejected at all",
 * which is what the delete sweep needs — with no fresh rows, nothing can have
 * overtaken the boundary.
 */
export function rejectionStands(value: Case, evidence: readonly Evidence[]): boolean {
  const boundary = value.rejectedAt?.build;
  if (typeof boundary !== "number") return false;
  // `?? []` for `rejectedBuild`'s reason: the store is a cache whose version
  // gate guards only the top level, so a field can be missing on a read back.
  return !(evidence ?? []).some((seen) => seen.build > boundary);
}

const TIMEOUT_KINDS = new Set(["timeout", "hook-timeout"]);

/**
 * Timeouts in this many unrelated groups in one job mean the job was starved
 * of host, not that each test is flaky. Loggd main build 3053 timed out 13
 * mobile tests across 8 screens at once, and "same tree, both colours" then
 * confirmed all 13 as flakes for the doctor to fix one per run (2026-10-07).
 * Four, not three: three is ordinary co-occurrence — library-merge build 2626
 * timed out a real flake beside two hook timeouts, and is evidence.
 */
export const STARVED_GROUPS = 4;

/** What one test belongs to: its file, or the describe block when the runner did not name the file (jest). */
const groupOf = (row: Failure): string => row.file ?? row.testId.split(" > ")[0]!;

/**
 * The timeout rows of every starved job, by `build:step`. Rule 0: these rows
 * are not evidence about any test — not flake, regression or PR-specific —
 * and become one `infra:starved-job` incident instead.
 */
export function starvedJobs(failures: readonly Failure[], minGroups = STARVED_GROUPS): Map<string, Failure[]> {
  const byJob = new Map<string, Failure[]>();
  for (const row of failures) {
    if (!TIMEOUT_KINDS.has(row.kind)) continue;
    const job = `${row.build}:${row.step ?? ""}`;
    byJob.set(job, [...(byJob.get(job) ?? []), row]);
  }
  for (const [job, rows] of byJob) {
    if (new Set(rows.map(groupOf)).size < minGroups) byJob.delete(job);
  }
  return byJob;
}

/* --------------------------------------------------------------------------
 * Small facts.
 * ----------------------------------------------------------------------- */

/** Does a list of repo paths include `file`? A runner may name it relative to a package (jest runs in `mobile/`). */
export function touches(files: readonly string[], file: string): boolean {
  return files.some((path) => path === file || path.endsWith(`/${file}`));
}

/** Repo paths a failure line names: `mobile/hooks/useLists.ts`, `src/a/b.test.ts`. */
export function pathsIn(line: string): string[] {
  return [...new Set(line.match(/[\w@.[\]-]+(?:\/[\w@.[\]-]+)+\.[A-Za-z]\w*/g) ?? [])];
}

const ms = (at: string | null | undefined): number => (at ? Date.parse(at) : NaN);

/** A build that tested the code: not a scheduled job run. */
const tested = (build: BuildRecord): boolean => build.source !== "schedule";

/** The step ran to an outcome in this build (not skipped, not cancelled before it started). */
const ranStep = (build: BuildRecord, step: string | null): boolean =>
  step === null ? build.state === "passed" || build.state === "failed" : build.steps[step] !== undefined && build.steps[step] !== "canceled";

const passedStep = (build: BuildRecord, step: string | null): boolean =>
  step === null ? build.state === "passed" : build.steps[step] === "passed";

const evidenceOf = (row: Failure): Evidence => ({ build: row.build, branch: row.branch, commit: row.commit, kind: row.kind, line: row.line });

const sameFailure = (a: Failure, b: Failure): boolean => a.kind === b.kind && a.line === b.line;

const newCase = (kind: Case["kind"], state: CaseState, rows: Failure[], builds: Map<number, BuildRecord>, baseBranch: string): Case => {
  const numbers = [...new Set(rows.filter((row) => !row.retried).map((row) => row.build))];
  const branchOf = (n: number): string => builds.get(n)?.branch ?? rows.find((row) => row.build === n)!.branch;
  return {
    kind,
    state,
    evidence: [...rows].sort((a, b) => a.build - b.build).map(evidenceOf),
    cost72h: {
      redBuilds: numbers.length,
      mainReds: numbers.filter((n) => branchOf(n) === baseBranch).length,
      dequeues: numbers.filter((n) => QUEUE_BRANCH.test(branchOf(n))).length,
    },
    issue: null,
    pr: null,
    fixAttempts: 0,
    unparks: {},
  };
};

/* --------------------------------------------------------------------------
 * The rules.
 * ----------------------------------------------------------------------- */

export interface Context {
  store: CiHealthStore;
  builds: Map<number, BuildRecord>;
  /** Tested builds of each branch, oldest first. */
  byBranch: Map<string, BuildRecord[]>;
  options: ClassifyOptions;
  now: number;
}

export function context(store: CiHealthStore, now: number, options: ClassifyOptions): Context {
  const builds = new Map(store.builds.map((build) => [build.number, build]));
  const byBranch = new Map<string, BuildRecord[]>();
  for (const build of [...store.builds].sort((a, b) => a.number - b.number)) {
    if (!tested(build)) continue;
    const list = byBranch.get(build.branch) ?? [];
    list.push(build);
    byBranch.set(build.branch, list);
  }
  return { store, builds, byBranch, options, now };
}

/** The next tested build of a branch after `number` that ran `step`. */
function nextBuild(ctx: Context, branch: string, number: number, step: string | null): BuildRecord | null {
  return (ctx.byBranch.get(branch) ?? []).find((build) => build.number > number && ranStep(build, step)) ?? null;
}

/**
 * Did the build after a red one pass T's step, with no change in between to
 * T's file or to a path T's failure line names? A ratchet names the files it
 * checks ("may only shrink; new paths: …"): a rebase that changed them is a
 * fix, not a flip.
 */
function greenNextWithoutTouching(ctx: Context, red: Failure): boolean {
  if (red.file === null) return false;
  const next = nextBuild(ctx, red.branch, red.build, red.step);
  if (next === null || !passedStep(next, red.step)) return false;
  if (next.commit === red.commit) return true;
  const diff = next.sincePrevious;
  if (diff === null || diff.from !== red.commit) return false;
  return ![red.file, ...pathsIn(red.line)].some((path) => touches(diff.files, path));
}

export interface Regression {
  run: BuildRecord[];
  /** Queue builds since the first red main build: every one failed T too. */
  queue: BuildRecord[];
  culprit: Culprit;
}

/** Rule 1. `rows` are T's non-retried failures. */
export function regressionOf(ctx: Context, rows: Failure[]): Regression | null {
  const { baseBranch } = ctx.options;
  const step = rows[0]?.step ?? null;
  const main = (ctx.byBranch.get(baseBranch) ?? []).filter((build) => ranStep(build, step));
  const byBuild = new Map(rows.map((row) => [row.build, row]));
  const run: BuildRecord[] = [];
  for (let i = main.length - 1; i >= 0 && byBuild.has(main[i]!.number); i--) run.unshift(main[i]!);
  if (run.length < 2) return null;
  const first = byBuild.get(run[0]!.number)!;
  if (!run.every((build) => sameFailure(byBuild.get(build.number)!, first))) return null;
  const since = ms(run[0]!.createdAt);
  const queue = ctx.store.builds.filter(
    (build) => QUEUE_BRANCH.test(build.branch) && tested(build) && ms(build.createdAt) >= since && ranStep(build, step),
  );
  if (!queue.every((build) => byBuild.has(build.number) && sameFailure(byBuild.get(build.number)!, first))) return null;

  const culpritBuild = run[0]!;
  const before = (ctx.byBranch.get(baseBranch) ?? []).filter((build) => build.number < culpritBuild.number).at(-1) ?? null;
  const why: string[] = [];
  if (before === null) why.push("no main build before the run is in the window");
  else if (before.state !== "passed") why.push(`the main build before the run, #${before.number}, is ${before.state}`);
  if (culpritBuild.parent === null) why.push(`git could not name the parent of ${culpritBuild.commit.slice(0, 10)}`);
  else if (before !== null && before.commit !== culpritBuild.parent) {
    why.push(
      `main build #${before.number} is on ${before.commit.slice(0, 10)}, not the culprit's parent ${culpritBuild.parent.slice(0, 10)}: a main commit between them was never built`,
    );
  }
  const infra = run.filter((build) =>
    ctx.store.failures.some((row) => row.build === build.number && row.kind === "bootstrap") || waitedTooLong(build, ctx.options),
  );
  for (const build of infra) why.push(`build #${build.number} in the run is infra`);
  if (culpritBuild.prs.length !== 1) why.push(`the culprit commit names ${culpritBuild.prs.length} merged PRs`);
  return {
    run,
    queue,
    culprit: {
      commit: culpritBuild.commit,
      build: culpritBuild.number,
      parentBuild: before?.state === "passed" ? before.number : null,
      pr: culpritBuild.prs.length === 1 ? culpritBuild.prs[0]! : null,
      unambiguous: why.length === 0,
      why,
    },
  };
}

/** Rule 2: the PR branches on which T's failure is the branch's own. */
export function prSpecificBranches(ctx: Context, rows: Failure[]): string[] {
  const { baseBranch } = ctx.options;
  const branches = [...new Set(rows.map((row) => row.branch))].filter((branch) => branch !== baseBranch && !QUEUE_BRANCH.test(branch));
  return branches.filter((branch) => {
    const own = rows.filter((row) => row.branch === branch);
    const elsewhere = rows.filter((row) => row.branch !== branch);
    const recurs = own.some((row) =>
      elsewhere.some((other) => (TIMEOUT_KINDS.has(row.kind) ? TIMEOUT_KINDS.has(other.kind) : sameFailure(row, other))),
    );
    if (recurs) return false;
    return own.some((row) => {
      const build = ctx.builds.get(row.build);
      const changed = build?.changedFiles ?? null;
      if (changed !== null && row.file !== null && touches(changed, row.file)) return true;
      const paths = [...(changed ?? []), ...(build?.branchPaths ?? [])];
      return pathsIn(row.line).some((path) => touches(paths, path));
    });
  });
}

/** Is a row flake-shaped (rule 3's candidate test)? `rows` are T's other non-retried failures. */
function candidateRow(ctx: Context, row: Failure, rows: Failure[]): boolean {
  const shaped = TIMEOUT_KINDS.has(row.kind) || rows.some((other) => other.build !== row.build && sameFailure(other, row));
  if (!shaped) return false;
  const { baseBranch } = ctx.options;
  if (row.branch === baseBranch || QUEUE_BRANCH.test(row.branch)) return true;
  const changed = ctx.builds.get(row.build)?.changedFiles ?? null;
  return changed !== null && row.file !== null && !touches(changed, row.file);
}

export interface FlakeVerdict {
  state: "candidate" | "confirmed" | "retired";
  rule: string | null;
  candidates: Failure[];
}

/** Rule 3. `rows` are T's non-retried failures outside PR-specific branches; `retried` its retried ones. */
export function flakeOf(ctx: Context, rows: Failure[], retried: Failure[]): FlakeVerdict | null {
  const candidates = rows.filter((row) => candidateRow(ctx, row, rows));
  const retriedCandidates = retried.filter((row) => candidateRow(ctx, row, rows));
  if (candidates.length === 0 && retriedCandidates.length === 0) return null;
  const { baseBranch } = ctx.options;

  const rules: string[] = [];

  // Main flip.
  if (candidates.some((row) => row.branch === baseBranch && greenNextWithoutTouching(ctx, row))) rules.push("main flip");

  // Same tree, both colours: another build of the same tree passed T's step, or the red job's retry did.
  const reds = [...candidates, ...retriedCandidates];
  const sameTree = reds.some((red) => {
    const own = ctx.builds.get(red.build);
    if (red.retried && own !== undefined && passedStep(own, red.step)) return true;
    return ctx.store.builds.some(
      (build) =>
        build.number !== red.build &&
        (build.commit === red.commit || (own?.tree != null && build.tree === own.tree)) &&
        passedStep(build, red.step) &&
        !rows.some((row) => row.build === build.number),
    );
  });
  if (sameTree) rules.push("same tree, both colours");

  // Cross-branch recurrence.
  const builds = new Set(rows.map((row) => row.build));
  const branches = new Set(rows.map((row) => row.branch));
  if (builds.size >= 3 && branches.size >= 2 && rows.some((row) => greenNextWithoutTouching(ctx, row))) {
    rules.push("cross-branch recurrence");
  }

  if (rules.length > 0) return { state: "confirmed", rule: rules.join("; "), candidates };

  const newest = Math.max(...reds.map((row) => ms(row.finishedAt)));
  const stale = ctx.now - newest > ctx.options.retireHours * 3_600_000;
  return { state: stale ? "retired" : "candidate", rule: null, candidates };
}

function waitedTooLong(build: BuildRecord, options: ClassifyOptions): boolean {
  const waited = ms(build.startedAt) - ms(build.createdAt);
  return Number.isFinite(waited) && waited > options.scheduledMinutes * 60_000;
}

export interface Classification {
  cases: Record<string, Case>;
  main: CiHealthStore["main"];
}

/** Every case the rows support right now. Pure. */
export function classify(store: CiHealthStore, now: number, options: ClassifyOptions = DEFAULT_CLASSIFY): Classification {
  const ctx = context(store, now, options);
  const cases: Record<string, Case> = {};

  const starved = starvedJobs(store.failures);
  const starvedRows = new Set([...starved.values()].flat());

  const byTest = new Map<string, Failure[]>();
  for (const row of store.failures) {
    if (row.kind === "bootstrap" || starvedRows.has(row)) continue;
    const list = byTest.get(row.testId) ?? [];
    list.push(row);
    byTest.set(row.testId, list);
  }

  for (const [testId, all] of byTest) {
    const rows = all.filter((row) => !row.retried).sort((a, b) => a.build - b.build);
    const retried = all.filter((row) => row.retried);
    const regression = rows.length === 0 ? null : regressionOf(ctx, rows);
    if (regression !== null) {
      const inRun = new Set([...regression.run, ...regression.queue].map((build) => build.number));
      const runRows = rows.filter((row) => inRun.has(row.build));
      cases[`regression:${testId}`] = {
        ...newCase("regression", "confirmed", runRows, ctx.builds, options.baseBranch),
        rule: `red on ${regression.run.length} consecutive main builds`,
        culprit: regression.culprit,
      };
      continue;
    }

    const own = new Set(prSpecificBranches(ctx, rows));
    for (const branch of own) {
      cases[`pr-specific:${branch}:${testId}`] = {
        ...newCase("pr-specific", "confirmed", rows.filter((row) => row.branch === branch), ctx.builds, options.baseBranch),
        rule: "fails on this branch only, and the branch changes what it checks",
      };
    }

    const rest = rows.filter((row) => !own.has(row.branch));
    const retriedRest = retried.filter((row) => !own.has(row.branch));
    const flake = flakeOf(ctx, rest, retriedRest);
    if (flake !== null) {
      cases[`flake:${testId}`] = { ...newCase("flake", flake.state, [...rest, ...retriedRest], ctx.builds, options.baseBranch), rule: flake.rule };
    }
  }

  // Infrastructure: one case per bootstrap signature, one for long waits to start.
  const bootstraps = new Map<string, Failure[]>();
  for (const row of store.failures) {
    if (row.kind !== "bootstrap" || row.retried) continue;
    bootstraps.set(row.testId, [...(bootstraps.get(row.testId) ?? []), row]);
  }
  for (const [signature, rows] of bootstraps) {
    cases[`infra:${signature}`] = { ...newCase("infra", "confirmed", rows, ctx.builds, options.baseBranch), rule: "failed before the runner started" };
  }
  if (starved.size > 0) {
    // One row per starved job, like `scheduled-wait`: the incident is the job,
    // and its evidence line says how wide the starvation was.
    const rows: Failure[] = [...starved.values()].map((timeouts) => {
      const first = timeouts[0]!;
      const groups = new Set(timeouts.map(groupOf)).size;
      return {
        ...first,
        testId: "starved-job",
        file: null,
        retried: timeouts.every((row) => row.retried),
        line: `${timeouts.length} tests in ${groups} unrelated groups timed out together in ${first.step ?? "the build"}`,
      };
    });
    cases["infra:starved-job"] = {
      ...newCase("infra", "confirmed", rows, ctx.builds, options.baseBranch),
      rule: `${STARVED_GROUPS}+ unrelated groups timed out in one job`,
    };
  }

  const waited = store.builds.filter((build) => waitedTooLong(build, options));
  if (waited.length > 0) {
    const rows: Failure[] = waited.map((build) => ({
      testId: "scheduled-wait",
      file: null,
      build: build.number,
      branch: build.branch,
      commit: build.commit,
      job: "",
      step: null,
      kind: "bootstrap",
      line: `scheduled for ${Math.round((ms(build.startedAt) - ms(build.createdAt)) / 60_000)} min before it started`,
      finishedAt: build.finishedAt,
      retried: false,
    }));
    cases["infra:scheduled-wait"] = {
      ...newCase("infra", "confirmed", rows, ctx.builds, options.baseBranch),
      cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
      rule: `a build sat scheduled for more than ${options.scheduledMinutes} min`,
    };
  }

  return { cases, main: mainState(ctx) };
}

/** Main's colour: the newest tested main build that passed or failed, and since when it has been that colour. */
export function mainState(ctx: Context): CiHealthStore["main"] {
  const main = (ctx.byBranch.get(ctx.options.baseBranch) ?? []).filter((build) => build.state === "passed" || build.state === "failed");
  const last = main.at(-1);
  if (last === undefined) return { state: "unknown", since: "", build: 0 };
  let first = last;
  for (let i = main.length - 1; i >= 0 && main[i]!.state === last.state; i--) first = main[i]!;
  return { state: last.state === "passed" ? "green" : "red", since: first.finishedAt, build: first.number };
}

/**
 * Fold a fresh classification into the store's cases. What later stages own
 * (issue, PR, fix attempts, unparks, and a filed/fixing/fixed/handed-off
 * state) is kept. A confirmed flake stays confirmed. A case the rows no longer
 * support is dropped unless a later stage owns it or it is a confirmed flake,
 * whose 72 h cost then reads zero. A regression drops T's unowned flake case:
 * it outranks every flake rule.
 */
export function mergeCases(store: CiHealthStore, next: Classification): void {
  const cases = store.cases;
  for (const [key, proposed] of Object.entries(next.cases)) {
    const prev = cases[key];
    if (prev === undefined) {
      cases[key] = proposed;
      continue;
    }
    // A doctor's rejection, while it stands, outranks whatever the rows now
    // propose — but not a later stage, so `MANAGED_STATES` stays first: a case
    // rejected and then filed belongs to the filing.
    const stands = rejectionStands(prev, proposed.evidence);
    const state: CaseState = MANAGED_STATES.has(prev.state)
      ? prev.state
      : stands
        ? "retired"
        : prev.state === "confirmed" && proposed.kind === "flake"
          ? "confirmed"
          : proposed.state;
    cases[key] = {
      ...proposed,
      state,
      rule: proposed.rule ?? prev.rule ?? null,
      issue: prev.issue,
      pr: prev.pr,
      fixAttempts: prev.fixAttempts,
      unparks: prev.unparks,
      // The fields a scan cannot know and must not erase (#156): which
      // incident was already paged, and the build a fix landed after. Dropping
      // them meant the gate re-paged one incident on every poll, and made the
      // recurrence boundary unwritable by anyone.
      notified: prev.notified ?? proposed.notified ?? null,
      fixedAt: prev.fixedAt ?? proposed.fixedAt ?? null,
      // Carried only while it stands. Clearing it once overtaken is what lets
      // the case come back CLEAN (#240, AC 2): a stale boundary left on a
      // re-opened case would suppress it again at the next poll, and would
      // make a second rejection unreadable from the first.
      rejectedAt: stands ? (prev.rejectedAt ?? null) : null,
    };
  }
  for (const [key, prev] of Object.entries(cases)) {
    // `parked:` is the gate's record of a coder ticket and `infra:check:` its
    // record of a GitHub check — a scan proposes neither, so a scan must not
    // delete either. Before #156 the check cases were swept away on every
    // poll and rewritten, which is how the "one page per incident" record kept
    // vanishing.
    if (key in next.cases || prev.kind === "parked" || key.startsWith(CHECK_CASE_PREFIX)) continue;
    // A rejected case is kept for the reason a confirmed flake is: deleting it
    // drops the only record of the decision, and the next red build would
    // rebuild the case with the rejection gone and offer it again.
    //
    // This is wider than the clause above it, and deliberately so: it keeps a
    // rejected case of ANY kind, including a `regression:`, a plain `infra:`
    // or a `pr-specific:` one that this branch used to delete. What bounds it
    // is not traffic but the doctor's own hand — a rejection is a manual act,
    // one per case ever, so the keys retained here are as few as the
    // rejections taken. `runReject` refuses the two prefixes the scan never
    // re-proposes, so everything kept here can still be cleared by the fold
    // above once a newer build overtakes the boundary.
    if (
      MANAGED_STATES.has(prev.state) ||
      (prev.kind === "flake" && prev.state === "confirmed") ||
      // `[]`: with no fresh rows for this key, nothing can have overtaken the
      // boundary, so this reads as "is it rejected at all".
      rejectionStands(prev, [])
    ) {
      prev.cost72h = { redBuilds: 0, mainReds: 0, dequeues: 0 };
      continue;
    }
    delete cases[key];
  }
  for (const key of Object.keys(next.cases)) {
    if (!key.startsWith("regression:")) continue;
    const flake = `flake:${key.slice("regression:".length)}`;
    if (cases[flake] !== undefined && !MANAGED_STATES.has(cases[flake]!.state)) delete cases[flake];
  }
  store.main = next.main;
}

/* --------------------------------------------------------------------------
 * Non-Buildkite checks (read by the gate from GitHub, not by the scan).
 * ----------------------------------------------------------------------- */

export interface CheckReading {
  pr: number;
  name: string;
  state: "success" | "failure" | "pending" | string;
  description: string;
}

/**
 * A required check outside Buildkite (`Vercel`) red on at least `minPrs` PRs
 * with the same description is an infrastructure incident, not the PRs'
 * fault. Returns `infra:check:<name>:<description>` cases.
 */
/** The key prefix of a case that comes from GitHub's checks, not from a build. */
export const CHECK_CASE_PREFIX = "infra:check:";

export function checkIncidents(readings: readonly CheckReading[], minPrs = 3): Record<string, Case> {
  const groups = new Map<string, Set<number>>();
  for (const reading of readings) {
    if (reading.state !== "failure" || reading.name.startsWith("buildkite")) continue;
    const key = `${CHECK_CASE_PREFIX.slice("infra:".length)}${reading.name}:${reading.description.trim()}`;
    groups.set(key, (groups.get(key) ?? new Set()).add(reading.pr));
  }
  const cases: Record<string, Case> = {};
  for (const [signature, prs] of groups) {
    if (prs.size < minPrs) continue;
    cases[`infra:${signature}`] = {
      kind: "infra",
      state: "confirmed",
      evidence: [...prs].sort((a, b) => a - b).map((pr) => ({ build: 0, branch: `PR #${pr}`, commit: "", kind: "check", line: signature })),
      cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
      issue: null,
      pr: null,
      fixAttempts: 0,
      unparks: {},
      rule: `red on ${prs.size} PRs with one description`,
    };
  }
  return cases;
}
