/**
 * The verifier's watch store (felipearos/ralph#563, spec #560): one watch per
 * merged PR whose production deploy has landed, with the check-ins the gate
 * will look at after it.
 *
 * It lives in git's common directory, beside the ci-health store, so every
 * worktree of the project shares one. Unlike ci-health it is NOT a cache: a
 * watch forgotten is a PR watched again from scratch, so an unreadable file is
 * refused on write rather than replaced by an empty store.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { VerifierMode } from "../project-config";
import type { GatheredHealth, GatheredTraffic } from "./sentry";
import type { AcceptanceResult, DeployedPr, VerdictKind } from "./verdict";

export const VERIFIER_WATCHES_VERSION = 1 as const;

export const STORE_RELATIVE_PATH = "ralph/verifier-watches.json";

const HOUR_MS = 3_600_000;

/**
 * How long a check-in lease is good for. The supervisor's heartbeat renews it
 * while the session runs (`role-leases.ts`), so a lease past its expiry means
 * the holder is gone, not slow.
 */
export const CHECK_IN_LEASE_SECONDS = 120;

/** What the gate gathered for a check-in, handed to the session as it was seen. */
export interface CheckInEvidence {
  /** ISO. */
  gatheredAt: string;
  health: GatheredHealth;
  traffic: GatheredTraffic;
  pr: DeployedPr;
  otherPrs: DeployedPr[];
}

/** What the session decided from that evidence. */
export interface CheckInDecision {
  /** ISO. */
  decidedAt: string;
  verdict: VerdictKind | "inconclusive";
  reason: string;
  act: boolean;
  priority: "normal" | "high";
  wouldHaveBeen?: VerdictKind;
}

export interface CheckInResult {
  /** ISO: when the gate leased the check-in and handed it over. */
  handedOverAt: string;
  evidence: CheckInEvidence;
  /** Null until the session records its verdict. */
  decision: CheckInDecision | null;
  /**
   * The acceptance check, run once per watch (#566) and stored on the check-in
   * that ran it, beside its decision. Optional, so a store written before it
   * reads as "not run yet" at the same version.
   */
  acceptance?: AcceptanceResult[];
  /** Why the acceptance check could not run (no test-account credential, sign-in failed): never a failed criterion. */
  acceptanceInconclusive?: string;
}

/** One acceptance check as the session reported it: its results, or why it could not run. */
export type AcceptanceRecord = { results: AcceptanceResult[] } | { inconclusive: string };

/** The watch's terminal verdict: never "pending", which is a check-in's answer, not a watch's. */
export interface WatchVerdict {
  verdict: VerdictKind;
  reason: string;
  act: boolean;
  wouldHaveBeen?: VerdictKind;
  offsetHours: number;
  /** ISO. */
  decidedAt: string;
}

/** One holder of a check-in lease; the shape of `ci-doctor/store.ts#Lease`, which the heartbeat renews. */
export interface Lease {
  run: string;
  loop: string;
  pid: number;
  host: string;
  expiresAt: string;
}

export interface CheckIn {
  offsetHours: number;
  /** ISO: the deploy time plus `offsetHours`. */
  dueAt: string;
  /** Null until the gate hands the check-in over with its evidence. */
  result: CheckInResult | null;
}

/**
 * The tracker writes report mode (#567) has already done for a watch, so a
 * gate that died between two of them retries only the rest. ISO strings.
 * Every key is absent until its write lands.
 */
export interface WatchReported {
  /** The "watching" comment on the ticket. */
  announcedAt?: string;
  /** The terminal-verdict comment on the ticket. */
  settledAt?: string;
  /** The fix ticket filed for a failed verdict. */
  fixTicket?: number;
  /** The `verifier-alert` push, sent at most once per watch. */
  alerted?: boolean;
  /**
   * Act mode (#568): when this watch began reverting, recorded BEFORE the push,
   * so a revert PR found on the verifier's branch later is known to be this
   * watch's own and adopted, not refused as a second revert.
   */
  revertStartedAt?: string;
  /** The revert PR this watch opened (or adopted). */
  revertPr?: number;
  revertUrl?: string;
  /**
   * Why act mode would not revert: the PR is itself a revert, or it was
   * already reverted (a revert PR exists, or the change is already undone on
   * the base branch).
   */
  revertRefused?: "twice" | "revert";
  /** The revert did not apply cleanly: the conflicting files and the later commits touching them. */
  revertConflict?: { files: string[]; commits: { sha: string; subject: string }[] };
  /**
   * When the root ticket was reopened for the coders to fix forward: only
   * once the revert PR merged, so nobody fixes forward on a base that still
   * holds the broken change.
   */
  rootReopenedAt?: string;
  /**
   * How the revert PR's merge stands. `proposed` (a person must merge it) and
   * `requested` (the merge command ran) keep the watch open, reading the PR's
   * fate each poll; `merged` reopens the root; `closed`, `red`, `stale` and
   * `failed` (the merge command refused) end the watch with the root left closed.
   */
  revertMerge?: "requested" | "proposed" | "merged" | "closed" | "red" | "stale" | "failed";
}

export interface Watch {
  pr: number;
  ticket: number;
  /**
   * The root ticket of the fix-ticket chain this watch belongs to, for the
   * watch of a fix ticket; null when `ticket` is itself the root. Additive to
   * version 1: a store written before #567 reads as null.
   */
  root: number | null;
  /** The ticket as the tracker spells it, e.g. "#184" or "OA-410". */
  ticketRef: string;
  mergeCommit: string;
  /** ISO. */
  mergedAt: string;
  deployId: string;
  /** ISO. */
  deployedAt: string;
  deployUrl: string | null;
  checkIns: CheckIn[];
  /**
   * The failure round this watch's verdict would be for the root ticket: 1
   * and an empty lineage for a first watch.
   */
  round: number;
  /** TICKET numbers, root first, of every earlier ticket in the fix-ticket chain. */
  lineage: number[];
  /** The mode when the watch was opened, so a later config change does not rewrite what it may do. */
  mode: VerifierMode;
  /** ISO. */
  openedAt: string;
  /** The terminal verdict; null while check-ins remain to be decided. */
  verdict: WatchVerdict | null;
  /** What report mode has already written; `{}` until it writes. Additive to version 1, like `root`. */
  reported: WatchReported;
}

export interface WatchStore {
  version: typeof VERIFIER_WATCHES_VERSION;
  /** Keyed by PR number: a PR is watched at most once. */
  watches: Record<string, Watch>;
  /**
   * Check-in leases, keyed by {@link checkInKey}, so two gates never hand the
   * same check-in to two sessions. Additive to version 1: a store written
   * before #565 has none, and reads as `{}`.
   */
  leases: Record<string, Lease>;
}

/** What the gate knows of a PR when it opens a watch for it. */
export type WatchCandidate = Omit<Watch, "checkIns" | "openedAt" | "verdict" | "round" | "lineage" | "root" | "reported"> &
  Partial<Pick<Watch, "round" | "lineage" | "root">>;

export const emptyStore = (): WatchStore => ({ version: VERIFIER_WATCHES_VERSION, watches: {}, leases: {} });

/* --------------------------------------------------------------------------
 * Pure helpers.
 * ----------------------------------------------------------------------- */

export function checkInSchedule(deployedAt: string, offsets: number[]): CheckIn[] {
  const base = Date.parse(deployedAt);
  return offsets.map((offsetHours) => ({
    offsetHours,
    dueAt: new Date(base + offsetHours * HOUR_MS).toISOString(),
    result: null,
  }));
}

/**
 * Add a watch for each candidate whose PR has none yet, and return the ones
 * added. A PR already watched is left exactly as it is: re-opening is a no-op.
 */
export function openWatches(store: WatchStore, candidates: WatchCandidate[], offsets: number[], now: Date): Watch[] {
  const added: Watch[] = [];
  for (const candidate of candidates) {
    const key = String(candidate.pr);
    if (store.watches[key] !== undefined) continue;
    const watch: Watch = {
      ...candidate,
      checkIns: checkInSchedule(candidate.deployedAt, offsets),
      round: candidate.round ?? 1,
      lineage: candidate.lineage ?? [],
      root: candidate.root ?? null,
      openedAt: now.toISOString(),
      verdict: null,
      reported: {},
    };
    store.watches[key] = watch;
    added.push(watch);
  }
  return added;
}

/** The root ticket of the chain a watch belongs to. */
export const rootOf = (watch: Watch): number => watch.root ?? watch.ticket;

/** Record report-mode writes that landed, merging `patch` into the watch's `reported`. */
export function markReported(store: WatchStore, pr: number, patch: Partial<WatchReported>): Watch {
  const watch = store.watches[String(pr)];
  if (watch === undefined) throw new Error(`no verifier watch for PR #${pr}`);
  watch.reported = { ...watch.reported, ...patch };
  return watch;
}

/** The lease key of one check-in. */
export const checkInKey = (pr: number, offsetHours: number): string => `${pr}@${offsetHours}`;

/** The watch's first check-in without a decision: check-ins of one watch are decided in order. */
const nextUndecided = (watch: Watch): CheckIn | undefined =>
  watch.checkIns.find((checkIn) => checkIn.result?.decision == null);

/**
 * The check-ins the gate may hand over now: due, undecided, of an open watch,
 * and only the earliest undecided one of each watch, ordered by due time then PR.
 */
export function dueCheckIns(store: WatchStore, now: Date): { watch: Watch; checkIn: CheckIn }[] {
  const nowMs = now.getTime();
  const due: { watch: Watch; checkIn: CheckIn }[] = [];
  for (const watch of Object.values(store.watches)) {
    if (watch.verdict !== null) continue;
    const checkIn = nextUndecided(watch);
    if (checkIn === undefined || Date.parse(checkIn.dueAt) > nowMs) continue;
    due.push({ watch, checkIn });
  }
  return due.sort((a, b) => Date.parse(a.checkIn.dueAt) - Date.parse(b.checkIn.dueAt) || a.watch.pr - b.watch.pr);
}

export function moreCheckInsAfter(watch: Watch, offsetHours: number): boolean {
  return watch.checkIns.some((checkIn) => checkIn.offsetHours > offsetHours);
}

/**
 * The watch's acceptance check, from the earliest decided check-in that
 * recorded one, or null while it has not run. Later check-ins are judged with
 * it rather than repeating it.
 */
export function recordedAcceptance(watch: Watch): (AcceptanceRecord & { offsetHours: number }) | null {
  for (const checkIn of [...watch.checkIns].sort((a, b) => a.offsetHours - b.offsetHours)) {
    const result = checkIn.result;
    if (result == null || result.decision == null) continue;
    if (result.acceptanceInconclusive !== undefined) return { inconclusive: result.acceptanceInconclusive, offsetHours: checkIn.offsetHours };
    if (result.acceptance !== undefined) return { results: result.acceptance, offsetHours: checkIn.offsetHours };
  }
  return null;
}

function findCheckIn(store: WatchStore, pr: number, offsetHours: number): { watch: Watch; checkIn: CheckIn } {
  const watch = store.watches[String(pr)];
  if (watch === undefined) throw new Error(`no verifier watch for PR #${pr}`);
  const checkIn = watch.checkIns.find((c) => c.offsetHours === offsetHours);
  if (checkIn === undefined) throw new Error(`PR #${pr} has no +${offsetHours}h check-in`);
  return { watch, checkIn };
}

/**
 * Store the evidence the gate gathered for a check-in. An earlier undecided
 * result is overwritten: a session that died left the check-in to be gathered
 * again. A decided one is refused — the verdict was drawn from that evidence.
 */
export function recordEvidence(store: WatchStore, pr: number, offsetHours: number, evidence: CheckInEvidence, now: Date): CheckIn {
  const { checkIn } = findCheckIn(store, pr, offsetHours);
  if (checkIn.result?.decision != null) {
    throw new Error(`PR #${pr}'s +${offsetHours}h check-in is already decided; refusing to replace its evidence`);
  }
  checkIn.result = { handedOverAt: now.toISOString(), evidence, decision: null };
  return checkIn;
}

/**
 * Record the session's decision on a check-in, and close the watch when it is
 * terminal. "inconclusive" with a later check-in left keeps the watch open —
 * that is how an unreachable Sentry waits for the next look — and is terminal
 * only at the last one. "pending" is never terminal, and at the last check-in
 * there is nothing left to be pending for, so it is refused.
 *
 * `acceptance`, when given, is stored on the same check-in in the same write,
 * so a decision is never recorded without the acceptance check it was judged
 * by. A watch runs that check once: a second one is refused.
 */
export function recordDecision(
  store: WatchStore,
  pr: number,
  offsetHours: number,
  decision: CheckInDecision,
  acceptance?: AcceptanceRecord,
): Watch {
  const { watch, checkIn } = findCheckIn(store, pr, offsetHours);
  if (checkIn.result === null) throw new Error(`PR #${pr}'s +${offsetHours}h check-in has no evidence recorded`);
  if (checkIn.result.decision !== null) throw new Error(`PR #${pr}'s +${offsetHours}h check-in is already decided`);
  const more = moreCheckInsAfter(watch, offsetHours);
  if (decision.verdict === "pending" && !more) {
    throw new Error(`PR #${pr}'s +${offsetHours}h check-in is the last one; it cannot be pending`);
  }
  if (acceptance !== undefined) {
    const earlier = recordedAcceptance(watch);
    if (earlier !== null) {
      throw new Error(`PR #${pr}'s acceptance check was already recorded at +${earlier.offsetHours}h; later check-ins do not repeat it`);
    }
    if ("inconclusive" in acceptance) checkIn.result.acceptanceInconclusive = acceptance.inconclusive;
    else checkIn.result.acceptance = acceptance.results;
  }
  checkIn.result.decision = decision;
  const terminal = decision.verdict !== "pending" && !(decision.verdict === "inconclusive" && more);
  if (terminal) {
    watch.verdict = {
      verdict: decision.verdict,
      reason: decision.reason,
      act: decision.act,
      ...(decision.wouldHaveBeen !== undefined ? { wouldHaveBeen: decision.wouldHaveBeen } : {}),
      offsetHours,
      decidedAt: decision.decidedAt,
    };
  }
  return watch;
}

/* --------------------------------------------------------------------------
 * Check-in leases.
 *
 * `ci-doctor/case-lease.ts`'s rules, for `ci-doctor/case-lease.ts`'s reasons:
 * ownership is `run` AND `loop`, a holder's own lease is free to it, and a
 * lease is free once expired or once its holder is gone. The helpers below are
 * copied rather than imported because `case-lease.ts`, `role-leases.ts` and
 * `frontier-gate.ts` all reach `role-leases.ts`, which imports this module to
 * register the store — and that cycle would leave `CHECK_IN_LEASE_SECONDS`
 * unset when `role-leases.ts` builds its registry.
 * ----------------------------------------------------------------------- */

/** Who a lease would name. `run` and `loop` together are the owner. */
export interface Holder {
  run: string;
  loop: string;
  pid?: number;
  host?: string;
}

type Alive = (holder: { pid: number; host: string }) => boolean;

const thisHost = (): string => process.env.HOSTNAME ?? hostname();

/**
 * Copied from `role-leases.ts#holderAlive` (itself `host-lease.ts#partyAlive`):
 * a pid recorded on another host means nothing here, so that holder is alive
 * and left to its expiry. Change those and change this with them.
 */
function holderAlive(holder: { pid: number; host: string }): boolean {
  if (holder.host !== thisHost() && holder.host !== hostname()) return true;
  try { process.kill(holder.pid, 0); return true; } catch { return false; }
}

/**
 * Copied from `ci-doctor/case-lease.ts#supervisorPid` (and
 * `frontier-gate.ts#supervisorPidFrom`): the lease names the SUPERVISOR, since
 * the gate exits the moment it hands the check-in over and the session it
 * hands it to is the supervisor's child.
 */
function supervisorPid(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RALPH_SUPERVISOR_PID?.trim();
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : process.ppid || process.pid;
}

const holderOf = (holder: Holder): Required<Holder> => ({
  run: holder.run,
  loop: holder.loop,
  pid: holder.pid ?? supervisorPid(),
  host: holder.host ?? thisHost(),
});

/** Is the check-in `key` free for `holder` to take? Pure, so the gate can skip held ones before locking. */
export function checkInFree(
  leases: Record<string, Lease>,
  key: string,
  holder: Holder,
  nowMs: number,
  alive: Alive = holderAlive,
): boolean {
  const lease = leases[key];
  if (lease === undefined) return true;
  if (lease.run === holder.run && lease.loop === holder.loop) return true;
  // Expiry first: it is the answer that always arrives, even for a holder on
  // another host that liveness takes as alive forever.
  const expires = Date.parse(lease.expiresAt);
  if (Number.isFinite(expires) && expires <= nowMs) return true;
  return !alive({ pid: lease.pid, host: lease.host });
}

export interface TakeResult {
  /** Did this holder end up with the lease? */
  taken: boolean;
  /** Who has it when `taken` is false. */
  holder: Lease | null;
}

/**
 * Take the lease on one check-in, or report who has it. The read, the check
 * and the write all run inside `withStore`: checking outside the lock is the
 * race that would hand one check-in to two sessions.
 */
export async function takeCheckInLease(
  path: string,
  key: string,
  holder: Holder,
  options: { nowMs?: number; leaseSeconds?: number; alive?: Alive } = {},
): Promise<TakeResult> {
  const nowMs = options.nowMs ?? Date.now();
  const seconds = options.leaseSeconds ?? CHECK_IN_LEASE_SECONDS;
  const who = holderOf(holder);
  const alive = options.alive ?? holderAlive;
  return withStore(path, (store) => {
    if (!checkInFree(store.leases, key, who, nowMs, alive)) {
      return { taken: false, holder: store.leases[key] ?? null };
    }
    store.leases[key] = { ...who, expiresAt: new Date(nowMs + seconds * 1000).toISOString() };
    return { taken: true, holder: store.leases[key] };
  });
}

/* --------------------------------------------------------------------------
 * The file and its lock.
 * ----------------------------------------------------------------------- */

export function storePathFromGit(cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, STORE_RELATIVE_PATH) : join(resolve(cwd), ".ralph-verifier-watches.json");
}

export type Loaded = { kind: "ok"; store: WatchStore } | { kind: "missing" } | { kind: "unreadable"; why: string };

/**
 * Every watch with `root` and `reported`: a watch written before #567 has
 * neither, and was opened for its own ticket with nothing reported yet.
 * A record that is not an object is left as it is, for the reader to judge.
 */
function withReportFields(watches: Record<string, Watch>): Record<string, Watch> {
  const out: Record<string, Watch> = {};
  for (const [key, watch] of Object.entries(watches)) {
    out[key] = typeof watch === "object" && watch !== null && !Array.isArray(watch)
      ? { ...watch, root: watch.root ?? null, reported: watch.reported ?? {} }
      : watch;
  }
  return out;
}

/** Exported for read-only views that must tell an unreadable store from an empty one. */
export function loadStore(path: string): Loaded {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  // An empty file is what a crash between create and write leaves; it holds no watch to lose.
  if (raw.trim() === "") return { kind: "missing" };
  try {
    const value = JSON.parse(raw) as Partial<WatchStore>;
    if (value?.version !== VERIFIER_WATCHES_VERSION) {
      return { kind: "unreadable", why: `version ${JSON.stringify(value?.version)}, expected ${VERIFIER_WATCHES_VERSION}` };
    }
    if (typeof value.watches !== "object" || value.watches === null || Array.isArray(value.watches)) {
      return { kind: "unreadable", why: "'watches' is not an object" };
    }
    if (value.leases !== undefined && (typeof value.leases !== "object" || value.leases === null || Array.isArray(value.leases))) {
      return { kind: "unreadable", why: "'leases' is not an object" };
    }
    // No `leases` is every store written before #565: none were held.
    return { kind: "ok", store: { version: VERIFIER_WATCHES_VERSION, watches: withReportFields(value.watches), leases: value.leases ?? {} } };
  } catch (error) {
    return { kind: "unreadable", why: `not JSON: ${(error as Error).message}` };
  }
}

/**
 * The store, or an empty one when the file is missing or unreadable — for
 * reporting only. Writes go through {@link withStore}, which refuses a file
 * it cannot read instead of forgetting its watches.
 */
export function readStore(path: string): WatchStore {
  const loaded = loadStore(path);
  return loaded.kind === "ok" ? loaded.store : emptyStore();
}

function writeStore(path: string, store: WatchStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Read-modify-write under an exclusive lock file, as `ci-doctor/store.ts`
 * does. Keep the critical section short: no network inside it. A lock older
 * than 30s belongs to a process that died inside one, and is broken. An
 * unreadable store throws: overwriting it would reopen every watch it held.
 */
export async function withStore<T>(path: string, critical: (store: WatchStore) => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (attempt > 200) throw new Error(`the verifier watch store is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      const loaded = loadStore(path);
      if (loaded.kind === "unreadable") {
        throw new Error(`the verifier watch store at ${path} is unreadable (${loaded.why}); refusing to overwrite it — fix or move the file by hand`);
      }
      const store = loaded.kind === "ok" ? loaded.store : emptyStore();
      const result = critical(store);
      writeStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}
