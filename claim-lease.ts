#!/usr/bin/env bun
/** Durable leases for claims made by the loops (Ralph, Rafa, Remo).
 *
 * The file lives in Git's common directory, rather than in a worktree.  It is
 * therefore shared by linked worktrees and remains available when the
 * checkout that made a claim is removed.
 *
 * Subcommands:
 *   status [--json]          print the store and change nothing
 *   heartbeat [--watch]      renew this run's lease, once or until the supervisor goes,
 *                            and with it any lease store the loop's role owns
 *   claim <n> [--label <l>]  claim one issue by number, atomically
 *
 * `claim` exits 0 when it claimed, 3 when the issue was already held, and 1 on
 * a fault. Three codes rather than two because losing a race is not a fault:
 * the caller that asked for a specific issue needs to tell "somebody else has
 * it" from "the claim could not be attempted", and act differently on each.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { renewRoleLeaseStore } from "./role-leases";

export const LEASE_VERSION = 1 as const;
export const DEFAULT_LEASE_SECONDS = 120;
export const DEFAULT_HEARTBEAT_SECONDS = 30;
export const RECONNECT_GRACE_SECONDS = 90;

export interface LeaseAttempt {
  issue: number;
  run: string;
  owner: string;
  loop: string;
  worktree: string;
  branch: string | null;
  claim: string;
  logs: string;
  usageLedger: string;
  claimedAt: string;
  releasedAt: string;
}

export interface LeaseReconnect {
  run: string;
  owner: string;
  pid: number | null;
  host: string;
  worktree: string;
  branch: string | null;
  reconnectedAt: string;
}

export interface ClaimLease {
  version: 1;
  issue: number;
  run: string;
  owner: string;
  loop: string;
  pid: number | null;
  host: string;
  worktree: string;
  branch: string | null;
  claim: string;
  logs: string;
  usageLedger: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  leaseMs?: number;
  attempt: number;
  history: LeaseAttempt[];
  reconnects?: LeaseReconnect[];
}

export interface LeaseStore {
  version: 1;
  leases: Record<string, ClaimLease>;
}

export type LeaseStatus = "active" | "reconnecting" | "slow" | "dead" | "expired";

export interface LeaseClock {
  nowMs: number;
  leaseMs?: number;
  reconnectGraceMs?: number;
  pidAlive?: (pid: number) => boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * When a process started, in epoch ms, from `/proc`; null where there is no
 * `/proc` to ask. `starttime` is field 22 of `/proc/<pid>/stat`, counted in
 * USER_HZ ticks since boot — fixed at 100 by the Linux ABI — and `btime` in
 * `/proc/stat` is the boot time in whole seconds. The command name (field 2)
 * may itself hold spaces or parentheses, so fields are counted after its
 * closing parenthesis, where field 3 starts.
 */
function processStartedAtMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3]);
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * Is the supervisor that holds this lease still running on this machine?
 *
 * The lease's pid means something only on the host that wrote it, so a lease
 * from another host is never judged live here. A pid that exists can still be
 * a stranger that reused the number after the supervisor died; the supervisor
 * was running when it last heartbeat, so a process that started after
 * `heartbeatAt` is not it. The one-second slack covers `btime` being whole
 * seconds. Without `/proc` the pid alone decides.
 */
function holderRunsHere(lease: ClaimLease): boolean {
  if (lease.pid === null) return false;
  if (lease.host !== hostname() && lease.host !== process.env.HOSTNAME) return false;
  if (!pidAlive(lease.pid)) return false;
  const started = processStartedAtMs(lease.pid);
  return started === null || started <= Date.parse(lease.heartbeatAt) + 1_000;
}

/**
 * `expiresAt` alone is not enough to call a lease expired. The heartbeat that
 * pushes it forward is one background process per supervisor, and it can go
 * quiet while its supervisor works on: it skips a pulse whenever the store's
 * lock is busy, its output goes to /dev/null, and nothing restarts it if it
 * dies. Two minutes of quiet used to lose the claim for good — `renewLease`
 * refuses an expired lease — and on loggd #1482 (2026-09-27) two loops reaped
 * each other's live claim mid-iteration that way. So a lease past its expiry whose
 * supervisor is still running on this host is `slow`, not `expired`: nobody may
 * take it, and its own heartbeat may still renew it. Once that supervisor is
 * gone the lease is expired, as before.
 */
export function leaseStatus(lease: ClaimLease, clock: LeaseClock): LeaseStatus {
  const now = clock.nowMs;
  if (Date.parse(lease.expiresAt) <= now) {
    const live = lease.pid !== null && (clock.pidAlive ? clock.pidAlive(lease.pid) : holderRunsHere(lease));
    return live ? "slow" : "expired";
  }
  if (lease.pid === null) return "reconnecting";
  const alive = (clock.pidAlive ?? pidAlive)(lease.pid);
  const grace = clock.reconnectGraceMs ?? RECONNECT_GRACE_SECONDS * 1000;
  if (alive) return now - Date.parse(lease.heartbeatAt) > grace ? "slow" : "active";
  return now - Date.parse(lease.heartbeatAt) <= grace ? "reconnecting" : "dead";
}

export function leaseBlocksClaim(lease: ClaimLease, clock: LeaseClock): boolean {
  return leaseStatus(lease, clock) !== "expired";
}

export function leasePathFromGit(gitDir = process.cwd()): string {
  return commonStatePath("ralph-claim-leases.json", gitDir);
}

/**
 * `name` in git's common directory, which every worktree of the checkout
 * shares, so the loops on one host see one file; outside a git checkout,
 * `.<name>` in `gitDir` itself.
 */
export function commonStatePath(name: string, gitDir = process.cwd()): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: gitDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common) return join(common, name);
  } catch {}
  return join(resolve(gitDir), `.${name}`);
}

export function readLeaseStore(path: string): LeaseStore {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, leases: {} };
    throw error;
  }
  let value: Partial<LeaseStore>;
  try { value = JSON.parse(raw) as Partial<LeaseStore>; }
  catch { throw new Error(`invalid lease store: ${path}`); }
  if (value.version !== 1 || !value.leases || typeof value.leases !== "object") {
    throw new Error(`unsupported lease store: ${path}`);
  }
  return { version: 1, leases: value.leases };
}

export function writeLeaseStore(path: string, store: LeaseStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

/** Best-effort pulse lock. Claim writers hold the same file through next-tasks.
 *  `undefined` means the lock was held: the caller retries rather than writing
 *  anyway. */
/**
 * Exported for `ci-doctor/case-issue.ts`, which releases the doctor's claim
 * when it hands a case to the coders: the hand-off removes the `-wip` label,
 * and a lease left behind would then make the ticket visible to every coder
 * and claimable by none.
 */
export function withLeaseStoreLock<T>(path: string, critical: () => T): T | undefined {
  const lock = join(dirname(path), "next-tasks-claim.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); } catch { return undefined; }
  try { return critical(); } finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
}

export interface LeaseClaimInput {
  issue: number;
  run: string;
  loop: string;
  pid: number | null;
  host?: string;
  worktree: string;
  branch: string | null;
  claim?: string;
  logs?: string;
  usageLedger?: string;
  nowMs: number;
  leaseMs?: number;
}

export type ClaimLeaseResult =
  | { outcome: "claimed" | "replaced"; lease: ClaimLease; previous?: ClaimLease }
  | { outcome: "held"; lease: ClaimLease; status: LeaseStatus };

export function claimLease(store: LeaseStore, input: LeaseClaimInput): ClaimLeaseResult {
  const key = String(input.issue);
  const existing = store.leases[key];
  // The run already holding the lease may claim it again: after merging a
  // partial PR its ticket stays open, and the heartbeat keeps that lease live
  // for as long as the supervisor runs — refusing the holder fenced the ticket
  // from every loop, the holder included. A re-claim is the same attempt.
  const own = existing !== undefined && existing.run === input.run && existing.loop === input.loop;
  if (existing && !own && leaseBlocksClaim(existing, { nowMs: input.nowMs })) {
    return { outcome: "held", lease: existing, status: leaseStatus(existing, { nowMs: input.nowMs }) };
  }
  const previous = own ? undefined : existing;
  const attempt = own ? existing.attempt : (previous?.attempt ?? 0) + 1;
  const claimedAt = iso(input.nowMs);
  const lease: ClaimLease = {
    version: LEASE_VERSION,
    issue: input.issue,
    run: input.run,
    owner: `${input.loop}@${input.host ?? hostname()}`,
    loop: input.loop,
    pid: input.pid,
    host: input.host ?? hostname(),
    worktree: resolve(input.worktree),
    branch: input.branch,
    claim: input.claim ?? `${input.loop}-wip`,
    logs: input.logs ?? ".ralph/logs",
    usageLedger: input.usageLedger ?? ".ralph/logs/usage-ledger.tsv",
    claimedAt,
    heartbeatAt: claimedAt,
    expiresAt: iso(input.nowMs + (input.leaseMs ?? DEFAULT_LEASE_SECONDS * 1000)),
    leaseMs: input.leaseMs ?? DEFAULT_LEASE_SECONDS * 1000,
    attempt,
    history: [
      ...(existing?.history ?? []),
      ...(previous ? [{
        issue: previous.issue, run: previous.run, owner: previous.owner, loop: previous.loop,
        worktree: previous.worktree, branch: previous.branch, claimedAt: previous.claimedAt,
        claim: previous.claim, logs: previous.logs, usageLedger: previous.usageLedger,
        releasedAt: claimedAt,
      }] : []),
    ],
    reconnects: existing?.reconnects ?? [],
  };
  store.leases[key] = lease;
  // A run works one ticket at a time, so claiming the next one ends every
  // other lease it holds. Those tickets already shipped or were parked — their
  // `-done` / `-blocked` label says which — and a lease left in place was
  // renewed by the heartbeat for the rest of the run, so the dashboard showed
  // every ticket the run had ever touched as an active claim.
  for (const [other, held] of Object.entries(store.leases)) {
    if (other !== key && held.run === input.run && held.loop === input.loop) delete store.leases[other];
  }
  return { outcome: previous ? "replaced" : "claimed", lease, ...(previous ? { previous } : {}) };
}

/**
 * Drop a lease this run holds, so the next claimant does not wait out its TTL.
 *
 * Pure, and deliberately narrow: only a lease whose run AND loop match is
 * removed. A lease is a claim, and releasing somebody else's is the one thing
 * the whole store exists to prevent. A lease that is not there is not an
 * error — a release after an expiry is the normal case, not a fault.
 */
export function releaseLease(
  store: LeaseStore,
  issue: number,
  identity: { run: string; loop: string },
): { store: LeaseStore; released: boolean } {
  const key = String(issue);
  const held = store.leases[key];
  if (held === undefined || held.run !== identity.run || held.loop !== identity.loop) {
    return { store, released: false };
  }
  const leases = { ...store.leases };
  delete leases[key];
  return { store: { version: 1, leases }, released: true };
}

/**
 * The ticket a run is working on: its most recently claimed lease, or null.
 * Only this one is renewed; any other lease the run still holds is a ticket
 * it has moved past.
 */
export function currentLeaseOf(store: LeaseStore, identity: { run: string; loop: string }): ClaimLease | null {
  let current: ClaimLease | null = null;
  for (const lease of Object.values(store.leases)) {
    if (lease.run !== identity.run || lease.loop !== identity.loop) continue;
    if (current === null || Date.parse(lease.claimedAt) > Date.parse(current.claimedAt)) current = lease;
  }
  return current;
}

export function renewLease(
  store: LeaseStore,
  issue: number,
  identity: { run: string; loop: string; pid?: number | null },
  nowMs: number,
  details: { worktree?: string; branch?: string | null } = {},
): ClaimLease | null {
  const lease = store.leases[String(issue)];
  if (lease?.run !== identity.run || lease.loop !== identity.loop) return null;
  if (identity.pid !== undefined && lease.pid !== identity.pid) return null;
  if (leaseStatus(lease, { nowMs }) === "expired") return null;
  const duration = lease.leaseMs && lease.leaseMs > 0 ? lease.leaseMs : DEFAULT_LEASE_SECONDS * 1000;
  lease.heartbeatAt = iso(nowMs);
  lease.expiresAt = iso(nowMs + duration);
  if (details.worktree) lease.worktree = resolve(details.worktree);
  if (details.branch !== undefined) lease.branch = details.branch;
  return lease;
}

/**
 * Reconnect a restarted supervisor in the same checkout without starting an attempt.
 *
 * `resume` is Resume work after a Stop now (`RALPH_RESUME_WORK=1`): the kill
 * kept the claim, and its lease may have lapsed while the operator looked at
 * what the iteration left. A lapsed lease still in the store has not been
 * taken — a claim by another run replaces it, and `abandon` deletes it — so
 * the same loop resuming in the same worktree may pick it back up. An
 * ordinary restart past the expiry may not, and neither may a resume for any
 * ticket but the one it resumes: the caller passes `resume` for that one.
 */
export function reconnectLease(
  store: LeaseStore,
  issue: number,
  identity: { run: string; loop: string; pid: number | null; host: string; worktree: string; branch: string | null },
  nowMs: number,
  clock: Omit<LeaseClock, "nowMs"> & { resume?: boolean } = {},
): ClaimLease | null {
  const lease = store.leases[String(issue)];
  if (lease?.loop !== identity.loop || resolve(lease.worktree) !== resolve(identity.worktree)) return null;
  const status = leaseStatus(lease, { ...clock, nowMs });
  const reconnectable = status === "reconnecting" || status === "dead" || (status === "expired" && clock.resume === true);
  if (!reconnectable) return null;
  lease.reconnects = [...(lease.reconnects ?? []), {
    run: lease.run, owner: lease.owner, pid: lease.pid, host: lease.host,
    worktree: lease.worktree, branch: lease.branch, reconnectedAt: iso(nowMs),
  }];
  const duration = lease.leaseMs && lease.leaseMs > 0 ? lease.leaseMs : DEFAULT_LEASE_SECONDS * 1000;
  lease.run = identity.run;
  lease.owner = `${identity.loop}@${identity.host}`;
  lease.pid = identity.pid;
  lease.host = identity.host;
  lease.heartbeatAt = iso(nowMs);
  lease.expiresAt = iso(nowMs + duration);
  return lease;
}

/* --------------------------------------------------------------------------
 * Operator recovery.
 * ----------------------------------------------------------------------- */

export type ReclaimVerdict =
  | { ok: true; lease: ClaimLease }
  | { ok: false; outcome: "already" | "held"; why: string };

/**
 * May operator recovery take this claim?
 *
 * The single rule, and the reason it is a rule rather than a heuristic: only
 * an EXPIRED lease may be reclaimed. `leaseBlocksClaim` already treats every
 * other state — active, slow, reconnecting, even dead — as blocking a claim,
 * because a supervisor whose heartbeat is late is overwhelmingly more likely
 * to be inside a long turn than to be gone. Recovery that could override that
 * would let one command hand a ticket to two loops at once, and a lease nobody
 * may take is worth much more than a recovery that is quick.
 *
 * `dead` is the tempting exception and it is refused too: the pid check that
 * produces it runs on THIS machine, and a lease written by a loop on another
 * host has a pid that means nothing here. Waiting for expiry costs at most the
 * lease duration and is right on every host.
 *
 * `release` is the exception that proves the rule. A run giving up its OWN
 * claim is not recovery — it is the owner leaving, which is always allowed and
 * is the whole difference between releasing and abandoning. And it is only
 * ever that: a run releasing somebody else's claim is refused even once the
 * claim has expired, because taking a lapsed claim that is not yours is
 * recovery, and recovery is `abandon`.
 */
export function reclaimVerdict(
  lease: ClaimLease | undefined,
  nowMs: number,
  what: "abandon" | "release",
  owner: { run: string } | null = null,
): ReclaimVerdict {
  if (lease === undefined) {
    return { ok: false, outcome: "already", why: "no claim lease is held for that issue" };
  }
  const status = leaseStatus(lease, { nowMs });
  if (what === "release" && owner !== null) {
    if (lease.run === owner.run) return { ok: true, lease };
    return {
      ok: false,
      outcome: "held",
      why:
        status === "expired"
          ? `issue #${lease.issue} is claimed by run ${lease.run}, not ${owner.run}; it expired at ${lease.expiresAt}, so abandon takes it back`
          : `issue #${lease.issue} is claimed by run ${lease.run}, not ${owner.run}, until ${lease.expiresAt}`,
    };
  }
  if (status === "expired") return { ok: true, lease };
  return {
    ok: false,
    outcome: "held",
    why: `issue #${lease.issue} is held by ${lease.owner} (run ${lease.run}, ${status}) until ${lease.expiresAt}`,
  };
}

export type ReclaimOutcome =
  | { outcome: "reclaimed"; lease: ClaimLease }
  | { outcome: "already" | "held" | "busy"; why: string };

/**
 * Take one claim out of the store, under the verdict above and under the lock.
 *
 * Here rather than in the caller because it is this file's data: the store's
 * shape, its lock and the policy deciding who may take a lease are one thing,
 * and a recovery command that reached in to `delete store.leases[...]` itself
 * would be a second place that has to be right about all three.
 *
 * `busy` is not a refusal. The lock is held by the claim writer or by a
 * heartbeat, both of which finish in milliseconds, so the caller retries
 * rather than forcing a write past whoever is mid-update.
 */
export function reclaimClaim(
  path: string,
  issue: number,
  what: "abandon" | "release",
  nowMs: number,
  owner: { run: string } | null = null,
): ReclaimOutcome {
  const done = withLeaseStoreLock(path, (): ReclaimOutcome => {
    const store = readLeaseStore(path);
    const verdict = reclaimVerdict(store.leases[String(issue)], nowMs, what, owner);
    if (!verdict.ok) return { outcome: verdict.outcome, why: verdict.why };
    delete store.leases[String(issue)];
    writeLeaseStore(path, store);
    return { outcome: "reclaimed", lease: verdict.lease };
  });
  return done ?? { outcome: "busy", why: "the lease store was busy; will retry" };
}

export function currentGitDetails(cwd = process.cwd()): { worktree: string; branch: string | null } {
  const run = (args: string[]): string | null => {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
    catch { return null; }
  };
  return { worktree: run(["rev-parse", "--show-toplevel"]) ?? resolve(cwd), branch: run(["symbolic-ref", "--quiet", "--short", "HEAD"]) };
}

/**
 * `status [--json]`: print the lease store, and nothing else.
 *
 * The read-only projection the operator dashboard consumes across its process
 * boundary. It takes no lock and needs no run identity, because it changes
 * nothing; `RALPH_STATE_ROOT` picks the checkout whose git common directory
 * holds the store, as it does for `loop-state status`.
 */
function runStatus(argv: string[]): void {
  const path = leasePathFromGit(process.env.RALPH_STATE_ROOT ?? process.cwd());
  const leases = Object.values(readLeaseStore(path).leases).sort((a, b) => a.issue - b.issue);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ version: LEASE_VERSION, path, leases }, null, 2));
    return;
  }
  for (const lease of leases) {
    console.log(`#${lease.issue}\t${lease.loop}\t${lease.run}\texpires ${lease.expiresAt}`);
  }
}

/** How large the heartbeat's log may grow before it is rotated to `<log>.1`. */
export const HEARTBEAT_LOG_MAX_BYTES = 256 * 1024;

/**
 * The watcher's own record of what it did not do: a pulse skipped because the
 * lock was busy, a pulse that threw, the reason it stopped. It used to write
 * nowhere, so when the watcher went quiet mid-iteration on loggd #1482 nothing
 * said why.
 *
 * Bounded by rotation: past `maxBytes` the file becomes `<log>.1`, replacing
 * the previous one, so a watcher that fails every pulse for days holds at most
 * twice the limit on disk. Every line goes through `redact` first. Logging
 * never throws — a heartbeat that died of its own diagnostics would be the
 * failure it exists to explain.
 */
export function heartbeatLogger(
  path: string,
  options: { maxBytes?: number; redact?: (line: string) => string; now?: () => Date } = {},
): (message: string) => void {
  const maxBytes = options.maxBytes ?? HEARTBEAT_LOG_MAX_BYTES;
  const redactLine = options.redact ?? ((line: string) => line);
  const now = options.now ?? (() => new Date());
  return (message: string): void => {
    try {
      const line = `${now().toISOString()} ${redactLine(message.replace(/\s*\n\s*/g, " "))}\n`;
      mkdirSync(dirname(path), { recursive: true });
      let size = 0;
      try { size = statSync(path).size; } catch {}
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(path, `${path}.1`);
      appendFileSync(path, line);
    } catch {}
  };
}

/** The runner-failure redactor, or none when it cannot load: the lines are the watcher's own. */
async function loadRedactor(): Promise<(line: string) => string> {
  try {
    const { buildRedactor, loadSignalConfig } = await import("./runner-failure");
    return buildRedactor(process.env, loadSignalConfig());
  } catch {
    return (line) => line;
  }
}

/** How `claim` reports an issue somebody else already holds. Not a fault — see the header. */
export const CLAIM_REFUSED_EXIT = 3;

/**
 * `claim <n> [--label <label>]`: claim one issue by number, for a caller whose
 * intake found the issue somewhere other than the frontier.
 *
 * The work is `claimByNumberWithLock` in `frontier/next-tasks.ts`, which holds
 * the same claim lock and writes the same lease every other claim path does.
 * It is reached through a DYNAMIC import: `next-tasks.ts` imports this module,
 * so a static import here would close a cycle. Importing it runs nothing —
 * its CLI is behind `import.meta.main`.
 *
 * Note that this reaches the CHECKOUT's copy, where `frontier/next.ts`
 * deliberately pins its payload to the harness's `origin/main`. A harness parked
 * on a branch can therefore make the two claim paths disagree — the same
 * staleness that launcher exists to remove, and the same exposure `heartbeat`
 * already has.
 *
 * No run identity is required, unlike `heartbeat`: `leaseClaim` falls back to
 * `<loop>-manual-<pid>` for a claim made by hand.
 */
async function runClaim(argv: string[]): Promise<void> {
  const number = Number(argv[0]);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`claim needs an issue number, not ${argv[0] === undefined ? "nothing" : `"${argv[0]}"`}`);
  }
  const flag = argv.indexOf("--label");
  const label = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && (label === undefined || label.startsWith("--"))) {
    throw new Error("--label needs a label");
  }
  const { claimByNumberWithLock } = await import("./frontier/next-tasks");
  const outcome = await claimByNumberWithLock(number, { label });
  if (!outcome.claimed) {
    console.error(`claim-lease: #${outcome.number} refused — ${outcome.refusal ?? "unknown"}`);
    process.exitCode = CLAIM_REFUSED_EXIT;
    return;
  }
  console.log(`claim-lease: claimed #${outcome.number} with ${outcome.label}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "status") { runStatus(process.argv.slice(3)); return; }
  if (command === "claim") { await runClaim(process.argv.slice(3)); return; }
  const path = leasePathFromGit();
  const run = process.env.RALPH_RUN_ID;
  const loop = process.env.RALPH_LOOP_NAME;
  // Named for the command the caller actually ran: `release` reaches this too,
  // and a refusal naming `heartbeat` sends them looking at the wrong thing.
  if (!run || !loop) throw new Error(`${command ?? "this command"} needs RALPH_RUN_ID and RALPH_LOOP_NAME`);
  if (command === "release") {
    const issue = Number(process.argv[3]);
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("release needs an issue number");
    const outcome = withLeaseStoreLock(path, () => {
      const result = releaseLease(readLeaseStore(path), issue, { run, loop });
      if (result.released) writeLeaseStore(path, result.store);
      return result.released;
    });
    if (outcome === undefined) throw new Error("claim-lease: the lease store was locked; try again");
    console.log(`claim-lease: ${outcome ? "released" : "no lease to release for"} #${issue}`);
    return;
  }
  if (command === "heartbeat") {
    // Resume work after a Stop now: this run may pick the interrupted ticket's
    // lapsed claim back up — that one ticket, never the store's other old
    // leases for this worktree, which are never deleted and would all revive.
    const resumeIssue = process.env.RALPH_RESUME_WORK === "1" ? Number(process.env.RALPH_RESUME_ISSUE) : NaN;
    const watch = process.argv.includes("--watch");
    // Only the watcher logs: the one-shot renewals at each state boundary are
    // many, and the supervisor already records those boundaries itself.
    const logPath = process.env.RALPH_LEASE_HEARTBEAT_LOG?.trim();
    const log = watch && logPath
      ? heartbeatLogger(logPath, { redact: await loadRedactor() })
      : (message: string): void => { console.error(`claim-lease: ${message}`); };
    if (watch) log(`watching for run ${run} (loop ${loop}, supervisor pid ${process.env.RALPH_SUPERVISOR_PID ?? "unset"}, lease store ${path})`);
    const pulse = (): void => {
      const supervisorPid = Number(process.env.RALPH_SUPERVISOR_PID);
      if (!Number.isInteger(supervisorPid) || supervisorPid <= 0 || !pidAlive(supervisorPid)) {
        if (watch) log(`stopping: supervisor pid ${process.env.RALPH_SUPERVISOR_PID ?? "unset"} is not running`);
        process.exit(0);
      }
      // One failed pulse must not end the watcher: an exception thrown out of
      // a timer kills the process, and with its output discarded and nothing
      // to restart it, every later pulse of the run was lost with it.
      try {
        const done = withLeaseStoreLock(path, (): true => {
        const current = readLeaseStore(path);
        const details = currentGitDetails();
        const identity = {
          run, loop, pid: supervisorPid,
          host: process.env.HOSTNAME ?? hostname(), ...details,
        };
        let renewed = 0;
        const working = currentLeaseOf(current, { run, loop })?.issue ?? null;
        for (const lease of Object.values(current.leases)) {
          if ((lease.issue === working && renewLease(current, lease.issue, { run, loop, pid: supervisorPid }, Date.now(), details)) ||
              reconnectLease(current, lease.issue, identity, Date.now(), { resume: lease.issue === resumeIssue })) renewed++;
        }
        if (renewed > 0) writeLeaseStore(path, current);
        return true;
        });
        if (done === undefined && watch) log(`pulse skipped: the lease store lock is busy (${join(dirname(path), "next-tasks-claim.lock")})`);
      } catch (error) {
        log(`heartbeat pulse failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!watch) process.exitCode = 1;
      }
    };
    // The role's own lease store, if it declares one (`role-leases.ts`). The
    // ci-doctor's case lease expires in 120s and this beat is the only thing
    // that says its holder is still there, so it rides on the same pulse and
    // has exactly the claim lease's lifetime: this run's. Two things end it,
    // and neither is a clock — the watcher exits with the supervisor, and a
    // lease the role has released is no longer this run's to renew. A role
    // that registers no store answers null here and reads nothing, which is
    // every coder's beat.
    const role = process.env.RALPH_LOOP_ROLE?.trim() || null;
    let renewingRole = false;
    const roleBeat = async (): Promise<void> => {
      // The store's lock is held for milliseconds, so an overlap means the
      // last beat is still waiting on somebody else. Skipping is right —
      // whoever holds it is about to let this one through.
      if (role === null || renewingRole) return;
      renewingRole = true;
      try {
        const done = await renewRoleLeaseStore(role, { run, loop });
        if (done && watch && (done.renewed.length > 0 || done.pruned.length > 0)) {
          log(`${role}: renewed ${done.renewed.length} and pruned ${done.pruned.length} lease(s) in ${done.what} (${done.path})`);
        }
      } catch (error) {
        // Same rule as the claim pulse above: one failure must not end the
        // watcher, and the one-shot caller learns of it through its exit code.
        log(`role lease renewal failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!watch) process.exitCode = 1;
      } finally {
        renewingRole = false;
      }
    };
    pulse();
    if (watch) {
      const seconds = Number(process.env.RALPH_LEASE_HEARTBEAT_SECONDS ?? DEFAULT_HEARTBEAT_SECONDS);
      // `.catch` on the floating promise as well as inside it: `log` writes to
      // a file for a watcher, and a throw from THAT would escape as an
      // unhandled rejection and take down the process this guard exists to
      // keep alive.
      const beat = (): void => { void roleBeat().catch(() => {}); };
      beat();
      setInterval(() => { pulse(); beat(); }, (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_HEARTBEAT_SECONDS) * 1000);
      return;
    }
    await roleBeat();
    return;
  }
  throw new Error("expected claim, heartbeat or status");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`claim-lease: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
