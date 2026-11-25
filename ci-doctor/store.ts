/**
 * The ci-health store: what the ci-doctor knows about CI, shared by every
 * worktree of the project.
 *
 * It lives in Git's common directory (`<git-common-dir>/ralph/ci-health.json`),
 * beside the claim and host lease stores, so every loop on the project reads
 * the same file, and it is locked with the same `withStore` pattern as
 * `host-lease.ts`. It is a CACHE: deleted or unreadable, it starts empty and
 * the next scan rebuilds it from a full-window scan of Buildkite. Decisions
 * that must survive a lost store are written to GitHub by later stages, not
 * kept only here.
 *
 * Shape (spec felipearos/ralph#132 §2, plus two fields the scan needs):
 *
 *   - `builds`: every finished build in the window, failed or not. The flake
 *     rules need the green builds too (a main flip is a red main build and the
 *     next green one), and the git facts the rules read are recorded on them,
 *     so the classification stays a pure function of this file.
 *   - `backfill`: where a scan whose one builds call came back full resumes.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CI_HEALTH_VERSION = 1 as const;

/**
 * How many UTC days of `metrics` the store keeps — a fact about the store
 * rather than about the scan that prunes by it, so that a reader bounded by it
 * (`dashboard/contract-parity.test.ts` fences the panel's trend length against
 * this) can import one integer instead of the whole Buildkite scanner's
 * dependency graph. `ci-doctor/scan.ts` re-exports it for its own callers.
 */
export const METRICS_DAYS = 30;
export const STORE_RELATIVE_PATH = "ralph/ci-health.json";

export type FailureKind = "timeout" | "assertion" | "hook-timeout" | "bootstrap" | "no-marker";

/** One failing test in one job. Keyed by `testId`; `job` is never read twice. */
export interface Failure {
  /** `<file> > <test title>`, or `<file>` when the runner gave no title, or a bootstrap signature. */
  testId: string;
  /** The test's file as the runner named it, or null (a run-level error, a bootstrap). */
  file: string | null;
  build: number;
  branch: string;
  commit: string;
  job: string;
  step: string | null;
  kind: FailureKind;
  /** The first error line. */
  line: string;
  finishedAt: string;
  /** The job was retried: evidence of a red colour, never counted as a failure. */
  retried: boolean;
}

/** What `git` said about a build's commit when the scan recorded it. */
export interface BuildRecord {
  number: number;
  branch: string;
  commit: string;
  state: string;
  source: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string;
  pr: number | null;
  /** PR numbers the (main) commit message names as merged: the trailing `(#n)`. */
  prs: number[];
  /** Effective state per step key: the job that was not superseded by a retry. */
  steps: Record<string, string>;
  /**
   * GitHub Actions builds only: the plain names of the jobs in `steps`, which
   * are GitHub's check names. Absent on Buildkite records.
   */
  jobNames?: string[];
  /** The commit's tree, so an empty-commit rerun is the same tree. Null when git could not say. */
  tree: string | null;
  /** The commit's first parent, for a regression's culprit. */
  parent: string | null;
  /** Files changed since the previous build of this branch (`from` is that build's commit). */
  sincePrevious: { from: string; files: string[] } | null;
  /** Red PR builds only: `git diff --name-only <merge-base>..<commit>`. */
  changedFiles: string[] | null;
  /** Red PR builds only: every path where the commit's tree differs from the base branch's head at build time. */
  branchPaths: string[] | null;
}

/**
 * Build states at which nothing more will happen on its own.
 *
 * It lives beside `BuildRecord`, whose `state` it describes, rather than in the
 * scanner that writes them: `ci-doctor/scan.ts` records only these, and
 * `ci-doctor/retry.ts` may retry a job only of these, and the two disagreeing
 * is a real defect in both directions — a state missing from the retry's view
 * is a candidate flake that can never be confirmed, one missing from the
 * scan's is a build the store never holds. `scan.ts` imports `../bk-log`, so
 * the set could not be shared from there without pulling the whole helper into
 * every store reader (see `identify` below, which is here for the same
 * reason).
 */
export const FINISHED_BUILD_STATES: ReadonlySet<string> = new Set([
  "passed",
  "failed",
  "timed_out",
  "canceled",
  "errored",
  "expired",
]);

export type CaseKind = "flake" | "regression" | "infra" | "pr-specific" | "parked";
export type CaseState = "candidate" | "confirmed" | "filed" | "fixing" | "fixed" | "retired" | "handed-off";

/**
 * The case states that make a failing test a KNOWN flake, for the metrics the
 * scan rolls up. Deliberately not `classify.ts`'s `MANAGED_STATES`, which is a
 * different question (which states `mergeCases` must not overwrite): that set
 * carries `handed-off` and lacks `confirmed`. A `candidate` is not yet known,
 * and a `retired` one never was.
 */
export const KNOWN_FLAKE_STATES: ReadonlySet<CaseState> = new Set<CaseState>([
  "confirmed",
  "filed",
  "fixing",
  "fixed",
]);

export interface Evidence {
  build: number;
  branch: string;
  commit: string;
  kind: string;
  line: string;
  /**
   * The step the row failed in, so a rejection can ask whether that step has
   * gone green since (#57). Optional: evidence written before it has none,
   * and a null step is never read as "passed" — any green build would do.
   */
  step?: string | null;
}

/**
 * `kind|line` with what changes from build to build normalised away — ISO
 * timestamps, UUIDs, hex runs of 12+ characters mixing digits and letters
 * (full commit SHAs, container ids), digit runs of 10+ (epoch times, large
 * ids), durations — and whitespace collapsed (#57). Shorter hex-looking
 * values stay: `expected abcdef0` and `expected deadbee` are an assertion's
 * values, two different failures. Error codes (`XX000`, `08006`,
 * `ECONNREFUSED`) and `file:line` positions are KEPT: they are what tells one
 * failure from another. A doctor's rejection holds while new reds carry the
 * signatures it was taken against, so a step red on every build for one
 * reason does not reopen the case on every build.
 *
 * Here, in the leaf, because `classify.ts` (which reads it) and
 * `case-issue.ts` (which records it) must agree on the grammar.
 */
export function failureSignature(kind: string, line: string): string {
  const normalised = String(line ?? "")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\b\d{10,}\b/g, "<num>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<duration>")
    .replace(/\s+/g, " ")
    .trim();
  return `${kind}|${normalised}`;
}

export interface Culprit {
  commit: string;
  build: number;
  /** The last green main build before the run, if any. */
  parentBuild: number | null;
  pr: number | null;
  unambiguous: boolean;
  /** Why it is ambiguous; empty when it is not. */
  why: string[];
}

export interface Case {
  kind: CaseKind;
  state: CaseState;
  evidence: Evidence[];
  cost72h: { redBuilds: number; mainReds: number; dequeues: number };
  issue: number | null;
  pr: number | null;
  fixAttempts: number;
  /**
   * On a `parked:<n>` case: diagnosis key → when this ticket was unparked for
   * it. Read by `ci-doctor/gate.ts:194` to stop offering a ticket twice for
   * one diagnosis, and written by `ci-doctor/unpark.ts`, which is its only
   * writer.
   */
  unparks: Record<string, string[]>;
  /** Which zero-cost rule confirmed a flake, or what made the case what it is. */
  rule?: string | null;
  /**
   * For a `parked:<n>` case: what the ticket is parked ON, as `parkedFrom` in
   * `ci-doctor/gate.ts` decides it — `"flake"`, `"migration"`, `"other"` or
   * `"unknown"`. A plain string rather than `block-reason.ts`'s `BlockKind` so
   * the store stays a leaf nothing has to import a classifier to read, and
   * deliberately NOT that enum's spelling: this is the doctor's own reading of
   * the record, which is broader than its lead line. `block-reason.ts` derives
   * the kind from the first line alone, so the canonical CI block §6 of the
   * coder prompt asks for — `blocked: PR #1681 red twice in CI` with the
   * failing test quoted beneath — classifies as `other`, and it is a flake
   * park by any useful reading.
   *
   * `rule` cannot stand in for it. `rule` is the TEST ID the record names, and
   * `testIdOf`'s fallback matches ANY `*.test.ts` token anywhere in the body —
   * so `blocked: waiting on review, the diff touches src/a.test.ts` has a
   * `rule` without being parked on a flake at all. Optional, because stores
   * written before #163 have parked cases without it; a reader with no value
   * falls back to `rule !== null`, which is the looser answer but the only one
   * such a store can give.
   */
  parkedOn?: string | null;
  /** A regression's culprit. */
  culprit?: Culprit | null;
  /**
   * The build the fix landed after, written when a case becomes `fixed`. It is
   * the boundary the gate's recurrence check needs (#156, selection priority
   * 6): the 72-hour window still holds the reds from BEFORE the fix, so
   * `cost72h` alone cannot tell a recurrence from stale evidence.
   *
   * Written by the fix-and-file path (#159/#162), not by the gate. Until
   * something writes it the gate reads its absence as "no recurrence known"
   * and starts no iteration — a false recurrence would spend a whole model
   * turn re-fixing a flake that is already fixed.
   */
  fixedAt?: { build: number; at: string } | null;
  /**
   * The moment a doctor turned this case down, with the reason in its own
   * words (#240).
   *
   * The state a rejected case takes is the existing `retired` — but `retired`
   * is also what `classify.ts` proposes for a candidate whose evidence simply
   * went stale, so the state cannot carry the distinction. This field is the
   * mark: the stale-retire never writes one.
   *
   * `build` is the newest build the case had evidence for when it was
   * rejected, which makes it the boundary `mergeCases` and the gate compare
   * against, exactly as `fixedAt.build` is for a recurrence. Without it a
   * rejection could not survive a scan: the fold would read the same confirming
   * evidence again and move the case back to `confirmed`, and the gate would
   * offer it on the next poll — forever, since a confirmed flake is sticky.
   * That cost one doctor about 450k tokens per iteration on three consecutive
   * iterations before this existed.
   *
   * `signatures` (#57) are the `failureSignature`s of the evidence the case
   * held when rejected. A newer build overturns the rejection only when it
   * fails with a signature not among them, or once the step has passed on a
   * tested build after the boundary — the same reds on new builds keep it
   * rejected. Before #57 any newer evidence overturned it, and a step red on
   * every build of an outage (one doctor: 50 iterations, 7 reopenings) came
   * back on every build. A record without `signatures`, or with a malformed
   * one, keeps that older rule: newer evidence overturns it.
   *
   * Optional and absent from `emptyStore` for `rounds`' reason: bumping
   * `CI_HEALTH_VERSION` to add it would make `readStore` discard a live
   * 72-hour window on deploy.
   */
  rejectedAt?: { build: number; at: string; reason: string; signatures?: string[] } | null;
  /**
   * The continuous red run that kept this case from being a flake (#57): the
   * step (or the test id when the step is unknown), the green build the run
   * started after, and how many builds it holds. Set on the retired
   * `flake:` case and on the `infra:red-run:<step>` case `classify` proposes
   * instead. `last` is the newest build the run counted: the next scan
   * extends the run past a pruned green only while that build is still in a
   * red streak (#57). Optional, for `rejectedAt`'s reason.
   */
  redRun?: { step: string; since: number; builds: number; last?: number } | null;
  /**
   * The `ci-incident` occurrence this infra case was already notified as
   * (#156). An infra case starts no iteration, so the notification is the
   * whole of the doctor's response to it, and the criterion is one per
   * SIGNATURE — which `push-notification.ts` cannot promise on its own,
   * because its own dedupe record is per run and lives in the worktree.
   */
  notified?: string | null;
  /**
   * The case key the marker in this case's GitHub issue actually carries, when
   * that is no longer this case's own key (#237).
   *
   * `case-issue.ts` makes the filing identity a hash of the case key in the
   * issue body, deliberately, so that AC 2 survives a lost store. The #237
   * rekey changes a case key, which breaks that in the one direction the hash
   * cannot: `readCaseIssue` re-checks the marker against the key it was asked
   * about, so the rekeyed case reads its own issue as somebody else's and files
   * a second one. This field is the bridge — `ensureCaseIssue` looks the old
   * key up as well, and RE-STAMPS the body with the new marker when it finds
   * it there, after which the field is cleared and GitHub carries the new
   * identity on its own again.
   *
   * Optional, and absent on everything but a rekeyed case, for the reason `gh`
   * below is: a store written before it existed simply has no field, and
   * bumping `CI_HEALTH_VERSION` to add one would make `readStore` discard a
   * live 72-hour window on deploy. Absent means "the marker is this key's",
   * which is true of every case that was never rekeyed.
   */
  filedAs?: string | null;
}

/**
 * How long a case lease is good for. Declared beside the lease it bounds, so
 * the code that TAKES one and `role-leases.ts`, which renews it on the
 * supervisor's heartbeat, cannot drift apart: a renewal longer or shorter than
 * the grant would hand the case to two doctors or drop it mid-diagnosis.
 */
export const CASE_LEASE_SECONDS = 120;

export interface Lease {
  run: string;
  loop: string;
  pid: number;
  host: string;
  expiresAt: string;
}

/**
 * At most this many `gh` calls per rolling hour of an idle doctor gate.
 *
 * Three 15-minute standing reads (open pull requests with their check rollup,
 * the `ci-health` registry, and one search over every coder's `-blocked`
 * label) account for all twelve of an IDLE hour. A non-idle hour has a newly
 * parked ticket's block comments to read as well, and those compete on the
 * same counter — so a cadence slips by one poll rather than the ceiling
 * moving. That is the right way round: the ceiling is what the account is
 * protected by, and a registry read five minutes late decides the same way.
 *
 * The number is a ceiling because four loops on one GitHub account were
 * throttled together on 2026-09-28, and a gate that polls forever is the one
 * caller with no natural stopping point.
 */
export const GH_CALLS_PER_HOUR = 12;

/**
 * The doctor gate's GitHub spend, persisted so that a restarted gate does not
 * get itself a fresh budget. `hourStart` anchors the hour `count` covers; `at`
 * maps a cadence key to the time that read last ran, and survives the hour
 * rollover — reset with the count, every hour boundary would re-run both
 * standing reads at once, which is the opposite of a cadence.
 */
export interface GhLedger {
  hourStart: string;
  count: number;
  at: Record<string, string>;
}

export interface Revert {
  case: string;
  issue: number;
  pr: number | null;
  forwardIssue: number | null;
  state: "open" | "merged" | "abandoned";
  /**
   * How many times this revert's pull request has been red or dequeued, from
   * `ci-doctor/revert.ts`, which is its only writer. Two is the end of the
   * road for that culprit (`MAX_REVERT_ROUNDS`).
   *
   * Optional, and absent until the first round, for the reason `gh` below is:
   * a store written before it existed simply has no field, and bumping
   * `CI_HEALTH_VERSION` to add one would make `readStore` discard a live
   * 72-hour window on deploy. A lost count fails safe — the culprit's single
   * attempt is already spent, so the next run refuses on the revert that
   * exists rather than opening a second one.
   */
  rounds?: number;
}

export interface CiHealthStore {
  version: 1;
  /** `finished_from` of the next scan. Empty: a full-window scan. */
  cursor: string;
  /** job id → build number */
  jobsSeen: Record<string, number>;
  failures: Failure[];
  builds: BuildRecord[];
  /** key: "flake:<test id>" | "regression:<test id>" | "infra:<signature>" | "pr-specific:<branch>:<test id>" | "parked:<issue>" */
  cases: Record<string, Case>;
  main: { state: "green" | "red" | "unknown"; since: string; build: number };
  leases: Record<string, Lease>;
  /**
   * The doctor's retry spend (#161), written by `ci-doctor/retry.ts` alone.
   *
   * `day` is the UTC day `count` covers, and `count` resets with it. `byCase`
   * does NOT: it maps a test id to the job retried for it, and on a day
   * rollover it keeps the records whose job still has an unretried row here —
   * the retry has happened and no scan has marked it yet, which is a window
   * `count` cannot express. So the two fields deliberately do not describe the
   * same day, and `retry.ts`'s `unscannedOrToday` owns the rule.
   */
  retries: { day: string; count: number; byCase: Record<string, string> };
  /** culprit sha → its revert */
  reverts: Record<string, Revert>;
  /** UTC day → daily rollup, kept 30 days */
  metrics: Record<string, { knownFlakeReds: number; parkedOnFlake: number }>;
  /** A full builds page leaves older builds to fetch: the next scan asks for `page`, and `high` is the newest finish seen so far. */
  backfill: { page: number; high: string } | null;
  /**
   * Each doctor gate's GitHub budget, by loop name (#156).
   *
   * Per loop, not shared, even though the store is: two doctors sharing one
   * allowance would starve each other, because the cadence marks say a read
   * has just run while the second doctor has none of its ANSWER. A project
   * runs one doctor by design; what protects the account when it runs two is
   * GitHub's own throttle, which the gate answers by starting no iteration.
   *
   * Optional, and deliberately absent from `emptyStore`: a store written
   * before it existed simply has no field, and bumping `CI_HEALTH_VERSION` to
   * add one would make `readStore` discard a live 72-hour window on deploy.
   * Every reader goes through `ci-doctor/gh-budget.ts`, which treats absent
   * and malformed alike.
   */
  gh?: Record<string, GhLedger>;
  /**
   * The pr-medic gate's retries of a red operator PR (felipearos/ralph#246),
   * keyed `<pr>@<head sha>` — written by `ci-doctor/retry.ts`'s `retryHead`
   * alone, under the same lock and against the same `retries.count` as the
   * doctor's own, so the two roles spend ONE daily cap between them.
   *
   * Its own field rather than more `retries.byCase` entries, because that map
   * is keyed by test id and its day rollover keeps only records whose job the
   * scan still holds unretried — a rule about the doctor's candidates that
   * would forget a medic retry overnight and let the same head be retried
   * again the next UTC day. The medic's promise is once per head commit, full
   * stop, so these records age out on time (`HEAD_RETRY_KEEP_DAYS`) instead.
   *
   * Optional, and absent from `emptyStore`, for `gh`'s reason above.
   */
  prRetries?: Record<string, { at: string; build: number; jobs: string[] }>;
  /**
   * The unattended loop's pull request each pr-medic has adopted
   * (felipearos/ralph#425), keyed by medic loop: one adoption per medic at a
   * time, because the supervisor's heartbeat renews only one lease per run.
   * Written by `pr-medic/gate.ts` when it claims an adoption and cleared once
   * the PR it names no longer carries that medic's `-wip`.
   *
   * Optional, and absent from `emptyStore`, for `gh`'s reason above.
   */
  medicAdoptions?: Record<string, { pr: number; head: string; issue: number }>;
}

/** `mainReds×3 + dequeues×2 + redBuilds` — what a case has cost in 72 hours. */
export const weigh = (cost: Case["cost72h"] | undefined): number =>
  cost === undefined ? 0 : cost.mainReds * 3 + cost.dequeues * 2 + cost.redBuilds;

/**
 * `2026-10-05` — the UTC day a per-day counter covers. It lives here, beside
 * the store it keys, because three writers need the same grammar: the retry
 * cap (`retry.ts`), the per-day metrics the scan rolls up (`scan.ts`) and the
 * gate's parked count (`gate.ts`). The dashboard keeps its own mirror, fenced
 * by `dashboard/contract-parity.test.ts`, because it may not import a ralph
 * module.
 */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** `flake:src/a.test.ts > flaps` → `src/a.test.ts > flaps`. */
export const subjectOf = (key: string): string => key.slice(key.indexOf(":") + 1);

/**
 * A digest failure's test id and file — the `testId` every case key above is
 * built from. It lives here, with the key grammar it serves, rather than in
 * the scanner that writes those keys: a reader of the store (`bk-log.ts`) must
 * be able to resolve a failure title to a key without importing the scan, and
 * `ci-doctor/scan.ts` imports `../bk-log`, so the other direction is a cycle.
 *
 * `file` is what the digest knows about THIS failure — for a jest `●` block,
 * the path from the `FAIL <path>` header jest printed above it (#237). It wins
 * over the guess below, which can only resolve a file when the whole job named
 * exactly one test file: a mobile job runs hundreds, so every failure from one
 * used to land with `file: null` and a test id of only `describe > test`,
 * colliding across files that share a describe title and leaving the flake
 * rules that need a file unable to confirm anything. Callers that cannot know
 * it (the dashboard, which reads report strings) pass nothing and get the old
 * behaviour.
 */
export function identify(
  title: string,
  files: readonly string[],
  file?: string | null,
): { testId: string; file: string | null } {
  const vitest = /^FAIL (\S+) > (.+)$/.exec(title);
  if (vitest) return { testId: `${vitest[1]!} > ${vitest[2]!}`, file: vitest[1]! };
  const whole = /^FAIL (\S+) \(whole file\)$/.exec(title);
  if (whole) return { testId: whole[1]!, file: whole[1]! };
  const playwright = /^\[[^\]]+\]\s+›\s+(\S+?):\d+(?::\d+)?\s+›\s+(.+)$/.exec(title);
  if (playwright) return { testId: `${playwright[1]!} > ${playwright[2]!.split(/\s+›\s+/).join(" > ")}`, file: playwright[1]! };
  const jest = /^●\s+(.+)$/.exec(title);
  if (jest) {
    const name = jest[1]!.split(/\s+›\s+/).join(" > ");
    if (file) return { testId: `${file} > ${name}`, file };
    const testFiles = files.filter((candidate) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidate));
    return testFiles.length === 1 ? { testId: `${testFiles[0]!} > ${name}`, file: testFiles[0]! } : { testId: name, file: null };
  }
  return { testId: title, file: null };
}

export const emptyStore = (): CiHealthStore => ({
  version: 1,
  cursor: "",
  jobsSeen: {},
  failures: [],
  builds: [],
  cases: {},
  main: { state: "unknown", since: "", build: 0 },
  leases: {},
  retries: { day: "", count: 0, byCase: {} },
  reverts: {},
  metrics: {},
  backfill: null,
});

/* --------------------------------------------------------------------------
 * The file and its lock.
 * ----------------------------------------------------------------------- */

export function storePathFromGit(cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, STORE_RELATIVE_PATH) : join(resolve(cwd), ".ralph-ci-health.json");
}

/**
 * The store, or an empty one when the file is missing, unparseable or of
 * another version. It is a cache: a bad file is rebuilt, never a reason to
 * stop a loop.
 */
export function readStore(path: string): CiHealthStore {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const value = JSON.parse(raw) as Partial<CiHealthStore>;
    if (value?.version !== CI_HEALTH_VERSION) return emptyStore();
    return { ...emptyStore(), ...value } as CiHealthStore;
  } catch {
    return emptyStore();
  }
}

function writeStore(path: string, store: CiHealthStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Read-modify-write under an exclusive lock file, as `host-lease.ts` does.
 * Keep the critical section short: no network inside it. A lock older than
 * 30s belongs to a process that died inside one, and is broken.
 */
export async function withStore<T>(path: string, critical: (store: CiHealthStore) => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (attempt > 200) throw new Error(`the ci-health store is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      const store = readStore(path);
      const result = critical(store);
      writeStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}
