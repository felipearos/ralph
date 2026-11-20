/**
 * The dashboard's read of the ci-doctor's ci-health store.
 *
 * One JSON file off disk — `<git-common-dir>/ralph/ci-health.json`, the file
 * `ci-doctor/store.ts` owns — folded into `contracts.ts`'s vocabulary. No
 * subprocess, no `gh`, no network: ticket felipearos/ralph#160 asks for a
 * panel the operator can read while CI is down, so the store is the whole of
 * its source.
 *
 * It is a CACHE, and this module treats it as one. A missing, truncated,
 * half-written or wrong-version file folds to the empty view rather than
 * raising, because the next scan rebuilds it and an operator looking at a
 * project whose doctor has never run should see an empty panel, not an error.
 * `readStore` in `ci-doctor/store.ts` makes the same promise; this module
 * cannot call it (nothing under `dashboard/` may import a ralph module) and so
 * repeats it, one field at a time.
 *
 * The narrowing is deliberately paranoid for a second reason: `readStore`
 * itself returns `{ ...emptyStore(), ...value }`, so a store written by an
 * older doctor can reach the file with fields missing or of another shape, and
 * nothing upstream has validated it. Every unknown enum value DROPS its own
 * record and leaves the rest of the picture intact.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  CI_CASE_KINDS,
  CI_CASE_STATES,
  CI_KNOWN_FLAKE_STATES,
  CI_MAIN_STATES,
  CI_METRICS_TREND_DAYS,
  CI_RETRY_PER_DAY_DEFAULT,
  CI_REVERT_STATES,
  type CiCaseKind,
  type CiCaseState,
  type CiCaseView,
  type CiHealthRead,
  type CiHealthView,
  type CiLostTimeView,
  type CiMainState,
  type CiMetricsDayView,
  type CiMetricsView,
  type CiParkedView,
  type CiRevertState,
  type CiRevertView,
  type CiUnparkView,
  type CiWaitWindowView,
  type CiWaitsView,
} from "./contracts";

/**
 * Mirrors `STORE_RELATIVE_PATH` in `ci-doctor/store.ts`. Exported so
 * `dashboard/contract-parity.test.ts` can fence it: a store written somewhere
 * this never looks is a panel that is silently always empty.
 */
export const STORE_RELATIVE_PATH = join("ralph", "ci-health.json");

/**
 * Mirrors `CI_HEALTH_VERSION` in `ci-doctor/store.ts`. Exported for the same
 * fence, and it is the more dangerous of the two: a harness that bumped the
 * version while this said `1` would fold every live store to the EMPTY view
 * with no problem reported, so the panel would show a clean all-zero picture
 * of a project it could not read. `ci-doctor/store.ts` contemplates that bump
 * in its own comment on `gh`.
 */
export const STORE_VERSION = 1;

/** Mirrors `PROJECT_CONFIG_PATH` in `dashboard/adapter.ts`; declared here so this module imports nothing. */
const PROJECT_CONFIG_PATH = join(".ralph", "config.json");

/** The window every 24-hour figure below is taken over. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mirrors the directory `ralph.sh` and `merge-wait.ts` write wait results
 * into, and the filename they use: `pr-wait-<iteration key>-<round>.json`.
 * Fenced by `dashboard/contract-parity.test.ts`, because a pattern that stops
 * matching is a median that is silently always null.
 *
 * The `.jsonl` history `ralph.sh` also appends beside them holds the SAME
 * records and must never be read here — it would double every wait.
 */
export const WAIT_LOG_DIR = join(".ralph", "logs");
export const WAIT_RESULT = /^pr-wait-(.+)-(\d+)\.json$/;

/** Outcomes that mean the waiter could not read the PR, so it measured nothing. */
const UNMEASURED = new Set(["unreadable", "rounds-exhausted", "head-mismatch"]);

const KNOWN_FLAKE_STATES = new Set<string>(CI_KNOWN_FLAKE_STATES);

/* -------------------------------------------------------------- the path */

/**
 * The checkout's git common directory, by filesystem reads alone.
 *
 * Neither of the two existing answers fits. `ci-doctor/store.ts`'s
 * `storePathFromGit` shells out to `git rev-parse --git-common-dir`, and
 * nothing the adapter reaches may start a second process
 * (`dashboard/read-only.test.ts` pins that, and the pin reads this file's
 * source, so the words above avoid the names it looks for). `project-id.ts`'s `projectIdFor` walks the same `.git` file but
 * answers a different question — the main checkout's NAME, for the project
 * registry — where this wants its common directory. The two agree for every
 * ordinary checkout and every linked worktree, which is every project the
 * dashboard sees; a repository whose main checkout keeps its admin directory
 * elsewhere (`core.worktree`, a submodule) resolves through the `gitdir:`
 * branch below.
 *
 * Null when `.git` could not be read at all. That is the one case the panel
 * reports as unknown rather than as empty.
 */
function commonDirOf(root: string): string | null {
  const dotGit = join(resolve(root), ".git");
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (gitdir === undefined || gitdir === "") return null;
  const admin = resolve(dirname(dotGit), gitdir);
  // A linked worktree's admin directory is `<main>/.git/worktrees/<name>`, and
  // the common directory is the `.git` two levels above it.
  return basename(dirname(admin)) === "worktrees" && basename(dirname(dirname(admin))) === ".git"
    ? dirname(dirname(admin))
    : admin;
}

/* ----------------------------------------------------------- narrowing */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A whole number at or above zero, else the fallback. Never `NaN`, never negative. */
const count = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : fallback;

/** A positive integer identifier (an issue or PR number), else null. */
const reference = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const member = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;

/** A parsable ISO timestamp as milliseconds, else null. */
const instant = (value: unknown): number | null => {
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
};

/** `flake:src/a.test.ts > flaps` → `src/a.test.ts > flaps`. Mirrors `subjectOf` in `ci-doctor/store.ts`. */
const subjectOf = (key: string): string => key.slice(key.indexOf(":") + 1);

/**
 * `mainReds×3 + dequeues×2 + redBuilds` — mirrors `weigh` in
 * `ci-doctor/store.ts`. Exported so the parity test can check the two agree on
 * sample costs; a drift here only reorders rows, but it would reorder them
 * away from the order the doctor itself works cases in.
 */
export const weigh = (view: Pick<CiCaseView, "mainReds" | "dequeues" | "redBuilds">): number =>
  view.mainReds * 3 + view.dequeues * 2 + view.redBuilds;

/**
 * The case states that are no longer anything wrong — a case in one of them is
 * history. Used to keep a fixed incident out of the OPEN incident list.
 */
const CLOSED_STATES = new Set<CiCaseState>(["fixed", "retired"]);

/** The UTC day of an instant, as `ci-doctor`'s `retries.day` spells it. */
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Worst first, then by key so the order is total and a poll cannot reshuffle equal rows. */
const byCost = (left: CiCaseView, right: CiCaseView): number =>
  weigh(right) - weigh(left) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

/* ---------------------------------------------------------------- views */

/**
 * The empty picture: what a project whose doctor has never run looks like.
 *
 * `cap` is required rather than defaulted. A default would be reached only from
 * tests, and it would let an assertion pass because two copies of the same
 * number happen to agree rather than because the fold used the cap it was
 * handed. `nowMs` is required for the same reason and a sharper one: the
 * 14-day trend below ends on the day of the read, so a defaulted clock would
 * make an assertion against a fixed `NOW` fail at midnight UTC.
 */
export function emptyCiHealthView(cap: number, nowMs: number): CiHealthView {
  return {
    main: { state: "unknown", since: null, build: null },
    cases: [],
    incidents: [],
    parked: [],
    retries: { day: null, count: 0, cap, today: false },
    reverts: [],
    lostTime: { reds: 0, medianBuildMinutes: null, minutes: null },
    // Still a full 14-day series of zeros, not an empty one: the panel draws
    // the same shape whether or not a doctor has ever run here, and
    // `recorded: false` is what says which.
    metrics: metricsView(null, nowMs),
    waits: { day: emptyWaitWindow(), week: emptyWaitWindow(), unreadable: [] },
    held: [],
  };
}

const emptyWaitWindow = (): CiWaitWindowView => ({
  ciIterations: 0,
  ciMinutes: null,
  queueIterations: 0,
  queueMinutes: null,
});

/**
 * The doctor whose UNEXPIRED lease holds `key`, or null.
 *
 * Shared by every case shape rather than inlined, because a parked ticket is
 * leasable too and the first version of this read the lease only where a
 * `CiCaseView` was built — so a doctor mid-unpark held a lease nothing looked
 * at. An expired lease holds nothing.
 */
function holderOf(key: string, leases: Record<string, unknown>, nowMs: number): string | null {
  const lease = leases[key];
  if (!isObject(lease)) return null;
  const expiresAt = instant(lease.expiresAt);
  return expiresAt !== null && expiresAt > nowMs ? text(lease.loop) : null;
}

/** One case, or null when it is not a case this dashboard can say anything about. */
function caseView(key: string, raw: unknown, leases: Record<string, unknown>, nowMs: number): CiCaseView | null {
  if (!isObject(raw)) return null;
  const kind = member<CiCaseKind>(CI_CASE_KINDS, raw.kind);
  const state = member<CiCaseState>(CI_CASE_STATES, raw.state);
  if (kind === null || state === null) return null;
  const cost = isObject(raw.cost72h) ? raw.cost72h : {};
  return {
    key,
    subject: subjectOf(key),
    kind,
    state,
    redBuilds: count(cost.redBuilds),
    mainReds: count(cost.mainReds),
    dequeues: count(cost.dequeues),
    issue: reference(raw.issue),
    pr: reference(raw.pr),
    rule: text(raw.rule),
    heldBy: holderOf(key, leases, nowMs),
    notified: text(raw.notified) !== null,
  };
}

/**
 * A parked ticket's unpark history, flattened and newest first.
 *
 * The store nests it as diagnosis key → timestamps, so one diagnosis can carry
 * several attempts; the panel reads it as a list of events, which is what an
 * operator asking "has this been unparked before, and for what" wants.
 */
function unparkViews(raw: unknown): CiUnparkView[] {
  if (!isObject(raw)) return [];
  const entries: (CiUnparkView & { at: string })[] = [];
  for (const [diagnosis, times] of Object.entries(raw)) {
    if (!Array.isArray(times)) continue;
    for (const at of times) {
      if (typeof at === "string" && instant(at) !== null) entries.push({ diagnosis, at });
    }
  }
  return entries.sort(
    (left, right) =>
      Date.parse(right.at) - Date.parse(left.at) ||
      (left.diagnosis < right.diagnosis ? -1 : left.diagnosis > right.diagnosis ? 1 : 0),
  );
}

/** A parked case, or null when its key names no issue. */
function parkedView(key: string, raw: unknown, leases: Record<string, unknown>, nowMs: number): CiParkedView | null {
  if (!isObject(raw)) return null;
  const state = member<CiCaseState>(CI_CASE_STATES, raw.state);
  // `Number` would take `0x10` and `1e3`, and the key grammar is decimal: a
  // store that drifted would link to an issue that is not the parked ticket.
  const subject = subjectOf(key);
  const issue = /^\d+$/.test(subject) ? Number(subject) : 0;
  if (state === null || issue <= 0) return null;
  return {
    issue,
    state,
    rule: text(raw.rule),
    unparks: unparkViews(raw.unparks),
    heldBy: holderOf(key, leases, nowMs),
  };
}

function revertView(culprit: string, raw: unknown): CiRevertView | null {
  // The key is the reverted commit. A blank or whitespace-only one renders an
  // empty cell with an empty tooltip — a row that says nothing at all — so the
  // check matches the stated intent rather than merely rejecting "".
  if (!isObject(raw) || !/^[0-9a-f]{7,40}$/i.test(culprit)) return null;
  const state = member<CiRevertState>(CI_REVERT_STATES, raw.state);
  const issue = reference(raw.issue);
  const kase = text(raw.case);
  if (state === null || issue === null || kase === null) return null;
  return { culprit, case: kase, issue, pr: reference(raw.pr), forwardIssue: reference(raw.forwardIssue), state };
}

/**
 * The median of a sample, as the mean of the two middles when it is of even
 * length. One decimal place: the inputs are wall-clock minutes and a second
 * decimal would claim a precision a build's own queueing does not have.
 */
function median(sample: number[]): number | null {
  if (sample.length === 0) return null;
  const sorted = [...sample].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const value = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value * 10) / 10;
}

/**
 * What known flakes cost CI in the trailing 24 hours.
 *
 * `reds` counts EVIDENCE entries rather than distinct builds, which is the
 * formula the ticket names (reds × a duration) and which over-states two
 * flakes in one build. The alternative under-states, and an over-statement on
 * a figure already labelled an estimate is the error an operator can see.
 *
 * An evidence entry naming a build the store no longer holds is not counted:
 * it is older than the scan's window, or pruned, and either way its duration
 * is unknowable.
 */
function lostTime(cases: Record<string, unknown>, builds: unknown, nowMs: number): CiLostTimeView {
  const since = nowMs - DAY_MS;
  const finishedWithin = new Map<number, number | null>();
  const durations: number[] = [];
  if (Array.isArray(builds)) {
    for (const record of builds) {
      if (!isObject(record)) continue;
      const number = count(record.number, -1);
      const finishedAt = instant(record.finishedAt);
      if (number < 0 || finishedAt === null || finishedAt < since) continue;
      const startedAt = instant(record.startedAt);
      const minutes = startedAt === null ? null : (finishedAt - startedAt) / 60_000;
      finishedWithin.set(number, minutes);
      // Only a FAILED build's duration belongs in the median: a flake costs a
      // re-run, a green build is the time CI would have spent anyway, and a
      // `canceled` or `blocked` build's short wall time would drag the median
      // — and so the estimate — down.
      if (minutes !== null && minutes > 0 && record.state === "failed") durations.push(minutes);
    }
  }
  let reds = 0;
  for (const raw of Object.values(cases)) {
    if (!isObject(raw)) continue;
    if (raw.kind !== "flake" || typeof raw.state !== "string" || !KNOWN_FLAKE_STATES.has(raw.state)) continue;
    if (!Array.isArray(raw.evidence)) continue;
    for (const entry of raw.evidence) {
      if (!isObject(entry)) continue;
      const number = count(entry.build, -1);
      if (number >= 0 && finishedWithin.has(number)) reds += 1;
    }
  }
  const medianBuildMinutes = median(durations);
  return {
    reds,
    medianBuildMinutes,
    minutes: medianBuildMinutes === null ? null : Math.round(reds * medianBuildMinutes),
  };
}

/* ------------------------------------------------- the per-day metrics */

/**
 * The last `CI_METRICS_TREND_DAYS` UTC days of the store's own metrics, oldest
 * first and ending on the day of the read.
 *
 * Zero-filled rather than sparse: `ci-doctor/scan.ts` writes a day only when
 * it counted something, so a quiet day is simply absent from the store — and a
 * trend with holes in it reads as missing data when it actually means nothing
 * went wrong. `recorded` carries the difference the zeros erase.
 */
function metricsView(raw: unknown, nowMs: number): CiMetricsView {
  const stored = isObject(raw) ? raw : {};
  const days: CiMetricsDayView[] = [];
  let reds = 0;
  let parkedPeak = 0;
  for (let back = CI_METRICS_TREND_DAYS - 1; back >= 0; back -= 1) {
    const day = utcDay(nowMs - back * DAY_MS);
    const value = stored[day];
    const entry: CiMetricsDayView = {
      day,
      knownFlakeReds: isObject(value) ? count(value.knownFlakeReds) : 0,
      parkedOnFlake: isObject(value) ? count(value.parkedOnFlake) : 0,
    };
    reds += entry.knownFlakeReds;
    parkedPeak = Math.max(parkedPeak, entry.parkedOnFlake);
    days.push(entry);
  }
  return { days, reds, parkedPeak, recorded: Object.keys(stored).length > 0 };
}

/* ------------------------------------------------------- the wait times */

/** One wait result, reduced to what the medians need. */
interface Wait {
  /** The iteration the filename groups it under. */
  key: string;
  mode: "ci" | "merge";
  seconds: number;
  /** When the file was written — the only clock a `WaitResult` has. */
  at: number;
}

/**
 * Every wait result under one worktree's `.ralph/logs`.
 *
 * The window has to come from the file's mtime: a `WaitResult` carries
 * `elapsedSeconds` but no timestamp, and the leading stamp in the filename is
 * LOCAL time, which cannot be compared against a UTC `nowMs` without knowing
 * the supervisor's zone. mtime is the moment the wait ended, which is the
 * moment the window is about.
 *
 * An ABSENT `.ralph/logs` is no waits, not a failure: a worktree whose loop has
 * never opened a PR has no log directory, and that is the ordinary state of a
 * fresh checkout. Only a directory that exists and still could not be listed —
 * a permission, a dangling symlink — comes back null, so a caller can tell a
 * worktree where nobody waited apart from one where nobody looked.
 */
function waitsIn(worktree: string): Wait[] | null {
  let names: string[];
  try {
    names = readdirSync(join(worktree, WAIT_LOG_DIR));
  } catch (error) {
    const code = isObject(error) ? error.code : null;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : null;
  }
  const out: Wait[] = [];
  for (const name of names) {
    const match = WAIT_RESULT.exec(name);
    if (match === null) continue;
    const path = join(worktree, WAIT_LOG_DIR, name);
    let raw: unknown;
    let at: number;
    try {
      at = statSync(path).mtimeMs;
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!isObject(raw)) continue;
    const mode = raw.mode === "ci" || raw.mode === "merge" ? raw.mode : null;
    const seconds = count(raw.elapsedSeconds, -1);
    // Two different non-waits, from two different writers. `ralph.sh:1314,1327`
    // files `rounds-exhausted` and `unreadable` itself, with no mode and no
    // elapsed time at all — those fall out on the fields above. But
    // `merge-wait.ts` files an `unreadable` of its own WITH a real elapsed
    // time, and that one has to be named: the script spent those seconds
    // failing to read `gh`, not waiting on a queue, and a median that counted
    // it would describe the loops' GitHub trouble as the queue's latency.
    if (mode === null || seconds < 0 || UNMEASURED.has(text(raw.outcome) ?? "")) continue;
    // The worktree is part of the key: two loops' supervisors can mint the
    // same `<ts>-<pid>-<iteration>` and those are different iterations.
    out.push({ key: `${worktree}\u0000${match[1]!}`, mode, seconds, at });
  }
  return out;
}

/** The medians over one window: summed per iteration and mode, then medianed. */
function waitWindow(waits: readonly Wait[], since: number): CiWaitWindowView {
  const totals = new Map<string, number>();
  for (const wait of waits) {
    if (wait.at < since) continue;
    const key = `${wait.mode}\u0000${wait.key}`;
    totals.set(key, (totals.get(key) ?? 0) + wait.seconds);
  }
  const minutes = (mode: "ci" | "merge"): number[] =>
    [...totals.entries()]
      .filter(([key]) => key.startsWith(`${mode}\u0000`))
      .map(([, seconds]) => seconds / 60);
  const ci = minutes("ci");
  const queue = minutes("merge");
  return {
    ciIterations: ci.length,
    ciMinutes: median(ci),
    queueIterations: queue.length,
    queueMinutes: median(queue),
  };
}

/**
 * Median CI and queue minutes per coder iteration, over 24 hours and 7 days,
 * across every worktree handed in. Filesystem reads only — no process, no API.
 */
export function readCiWaits(worktrees: readonly string[], nowMs: number = Date.now()): CiWaitsView {
  const waits: Wait[] = [];
  const unreadable: string[] = [];
  for (const worktree of worktrees) {
    const read = waitsIn(worktree);
    if (read === null) unreadable.push(worktree);
    else waits.push(...read);
  }
  return {
    day: waitWindow(waits, nowMs - DAY_MS),
    week: waitWindow(waits, nowMs - 7 * DAY_MS),
    unreadable: unreadable.sort(),
  };
}

/**
 * The pure fold: a store's parsed JSON, the retry cap it is read against, and
 * "now", to the picture a panel renders.
 *
 * Separate from the disk read above it so the whole derivation is testable
 * against a literal, and so slice C's model and `dashboard/preview.ts` can
 * build a picture without a filesystem.
 */
export function foldCiHealth(raw: unknown, cap: number, nowMs: number, waits?: CiWaitsView): CiHealthView {
  const empty = emptyCiHealthView(cap, nowMs);
  const waitsView = waits ?? empty.waits;
  // A store of another version tells us nothing about the doctor — but the
  // wait times are read from the loops' own logs and are still true, so they
  // survive the bail.
  if (!isObject(raw) || raw.version !== STORE_VERSION) return { ...empty, waits: waitsView };
  const rawCases = isObject(raw.cases) ? raw.cases : {};
  const leases = isObject(raw.leases) ? raw.leases : {};
  const cases: CiCaseView[] = [];
  const incidents: CiCaseView[] = [];
  const parked: CiParkedView[] = [];
  const held: CiCaseView[] = [];
  for (const [key, value] of Object.entries(rawCases)) {
    if (!isObject(value)) continue;
    // Built for EVERY case, whatever list it ends up drawn in, so `held` below
    // cannot miss one the way a per-list search did.
    const view = caseView(key, value, leases, nowMs);
    if (view !== null && view.heldBy !== null) held.push(view);
    if (value.kind === "parked") {
      const parkedEntry = parkedView(key, value, leases, nowMs);
      if (parkedEntry !== null) parked.push(parkedEntry);
      continue;
    }
    if (view === null) continue;
    if (view.kind === "infra") {
      // A fixed or retired incident is history, and the panel heads this list
      // "open". The scan keeps a managed case for ever, so without this filter
      // an incident cleared weeks ago sits there claiming to be open.
      if (!CLOSED_STATES.has(view.state)) incidents.push(view);
      continue;
    }
    cases.push(view);
  }
  const reverts: CiRevertView[] = [];
  for (const [culprit, value] of Object.entries(isObject(raw.reverts) ? raw.reverts : {})) {
    const view = revertView(culprit, value);
    if (view !== null) reverts.push(view);
  }
  const main = isObject(raw.main) ? raw.main : {};
  const retries = isObject(raw.retries) ? raw.retries : {};
  return {
    main: {
      state: member<CiMainState>(CI_MAIN_STATES, main.state) ?? "unknown",
      // Through `instant` and not merely `text`: the panel renders this with
      // `new Date(...).toLocaleString()`, so an unparsable string reaches the
      // operator as the literal words "Invalid Date". Every other timestamp in
      // this file is checked the same way.
      since: instant(main.since) === null ? null : text(main.since),
      // The store writes build `0` beside an empty `since` on `unknown`, and
      // "build 0" is not a build.
      build: count(main.build, 0) > 0 ? count(main.build) : null,
    },
    cases: cases.sort(byCost),
    incidents: incidents.sort(byCost),
    parked: parked.sort((left, right) => left.issue - right.issue),
    retries: ((day: string | null) => ({ day, count: count(retries.count), cap, today: day === utcDay(nowMs) }))(
      text(retries.day),
    ),
    // Open first: the issue asks for "open or recent" reverts and the store
    // records no timestamp, so open-ness is the only ordering it can support.
    reverts: reverts.sort(
      (left, right) =>
        Number(right.state === "open") - Number(left.state === "open") ||
        (left.culprit < right.culprit ? -1 : left.culprit > right.culprit ? 1 : 0),
    ),
    lostTime: lostTime(rawCases, raw.builds, nowMs),
    metrics: metricsView(raw.metrics, nowMs),
    waits: waitsView,
    held: held.sort(byCost),
  };
}

/* ------------------------------------------------------------ the reads */

/**
 * `ciDoctor.retry.perDay` from the checkout's project config, else the
 * documented default. An unreadable or malformed config is the default: the
 * cap is shown as the scale the count is read against, and refusing to show
 * the panel over a config typo would be the wrong trade.
 */
function retryCap(root: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, PROJECT_CONFIG_PATH), "utf8"));
  } catch {
    return CI_RETRY_PER_DAY_DEFAULT;
  }
  if (!isObject(parsed) || !isObject(parsed.ciDoctor)) return CI_RETRY_PER_DAY_DEFAULT;
  const retry = parsed.ciDoctor.retry;
  if (!isObject(retry)) return CI_RETRY_PER_DAY_DEFAULT;
  // Clamped, because `project-config.ts` REFUSES a raised value: the key may be
  // lowered but never raised past `RETRY_CEILINGS.perDay`. This module reads the
  // raw file rather than the validator, so without the clamp the panel would
  // show a cap the harness would not start with.
  return Math.min(count(retry.perDay, CI_RETRY_PER_DAY_DEFAULT), CI_RETRY_PER_DAY_DEFAULT);
}

/**
 * One read of the project's ci-health store, from the checkout at `root`.
 *
 * The temporary file the writer renames over the store (`ci-health.json.<pid>.tmp`)
 * is a different path and is never read, and the rename is atomic, so this
 * read needs no cooperation with `withStore`'s lock: it either sees the whole
 * previous store or the whole new one.
 */
export function readCiHealth(
  root: string,
  nowMs: number = Date.now(),
  worktrees: readonly string[] = [root],
): CiHealthRead {
  const readAt = new Date(nowMs).toISOString();
  const cap = retryCap(root);
  const common = commonDirOf(root);
  if (common === null) {
    return { readAt, view: null, problem: `could not read ${join(resolve(root), ".git")}` };
  }
  // After that guard, not before it: a `view: null` has nowhere to put the
  // waits, so reading them first would walk every worktree's log directory to
  // throw the answer away. They are read from EVERY worktree rather than just
  // `root` — one `.ralph/logs` per coder — and they survive a store this
  // cannot use, which is why `foldCiHealth` takes them separately.
  const waits = readCiWaits(worktrees, nowMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(common, STORE_RELATIVE_PATH), "utf8"));
  } catch {
    // Missing or unreadable: the doctor has not run here, or its cache is
    // gone. Either way the empty picture is the true one.
    return { readAt, view: { ...emptyCiHealthView(cap, nowMs), waits }, problem: null };
  }
  return { readAt, view: foldCiHealth(parsed, cap, nowMs, waits), problem: null };
}
