/**
 * The primitives a pr-medic uses to ADOPT a red or conflicting pull request
 * whose owning roster loop is unattended (#425): which loops are down, which
 * ticket an agent branch belongs to, the claim lease the medic takes over, the
 * orphan to take first, and the comments that say so on the pull request.
 *
 * Self-contained on purpose: the gate, `case.ts` and the push fence will
 * import this file, so it imports none of them.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimLease,
  currentLeaseOf,
  leaseBlocksClaim,
  leaseStatus,
  readLeaseStore,
  releaseLease,
  withLeaseStoreLock,
  writeLeaseStore,
} from "../claim-lease";
import { formatDuration } from "../frontier-gate";
import type { UnattendedLoop } from "../loop-state";

/* --------------------------------------------------------------------------
 * The unattended read.
 * ----------------------------------------------------------------------- */

/** The unattended loops, keyed by loop name. */
export type Unattended = ReadonlyMap<string, UnattendedLoop>;

export type UnattendedRunner = (command: string, args: string[]) => { status: number; stdout: string; stderr: string };

/**
 * `loop-state.ts unattended --json`, parsed. Pure. Null on anything that is
 * not exactly the contract's shape: adopting on a half-read answer would take
 * a pull request from a loop that may be live, so a doubtful read is no read.
 */
export function parseUnattended(stdout: string): Unattended | null {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(value)) return null;
  const loops = new Map<string, UnattendedLoop>();
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object") return null;
    const { loop, stopKind, downSince } = entry as Record<string, unknown>;
    if (typeof loop !== "string" || typeof downSince !== "string") return null;
    if (stopKind !== null && typeof stopKind !== "string") return null;
    loops.set(loop, { loop, stopKind: stopKind as UnattendedLoop["stopKind"], downSince });
  }
  return loops;
}

/**
 * Ask the harness which loops are unattended. Null when it could not be asked
 * or did not answer cleanly; never throws — the caller decides what an
 * unknown answer means (the gate adopts nothing, the push fence refuses).
 * The project is the runner's cwd (`liveUnattendedRunner`).
 */
export function readUnattended(run: UnattendedRunner): Unattended | null {
  // From the module URL rather than `import.meta.dir`, which only Bun sets:
  // vitest runs this file under Node.
  const harness = join(dirname(fileURLToPath(import.meta.url)), "..", "loop-state.ts");
  try {
    const ran = run("bun", [harness, "unattended", "--json"]);
    if (ran.status !== 0) return null;
    return parseUnattended(ran.stdout);
  } catch {
    return null;
  }
}

/** The real runner: `cwd` is the project root, so the CLI reads that project's worktrees. */
export function liveUnattendedRunner(root: string): UnattendedRunner {
  return (command, args) => {
    const ran = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 60_000, env: process.env });
    // A spawn error or a timeout leaves `status` null: report it as a failure.
    return { status: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
  };
}

/* --------------------------------------------------------------------------
 * The ticket of an agent branch.
 * ----------------------------------------------------------------------- */

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The issue number in `<owner>/<n>-<slug>` or `<owner>/<n>`; null for any other branch. */
export function ticketOf(branch: string, owner: string): number | null {
  const match = new RegExp(`^${escapeRegExp(owner)}/([1-9]\\d*)(?:-.+)?$`).exec(branch);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/* --------------------------------------------------------------------------
 * The adopted claim lease.
 * ----------------------------------------------------------------------- */

export interface AdoptIdentity {
  run: string;
  loop: string;
  pid: number;
}

export type AdoptResult = { ok: true } | { ok: false; why: string };

export interface AdoptInput {
  issue: number;
  identity: AdoptIdentity;
  worktree: string;
  branch: string | null;
  nowMs: number;
  pidAlive?: (pid: number) => boolean;
}

/**
 * Take the claim lease on an adopted ticket, so the owner, should it come
 * back, and every other loop see it held. Never throws.
 */
export function takeAdoptedLease(path: string, input: AdoptInput): AdoptResult {
  const { issue, identity, worktree, branch, nowMs, pidAlive } = input;
  try {
    const result = withLeaseStoreLock(path, (): AdoptResult => {
      const store = readLeaseStore(path);
      // The supervisor's heartbeat renews only the run's newest lease, so a
      // second adoption would let the first one expire under the medic.
      const current = currentLeaseOf(store, identity);
      if (current !== null && current.issue !== issue) {
        return { ok: false, why: `${identity.loop} already holds the adopted lease on #${current.issue}` };
      }
      const existing = store.leases[String(issue)];
      const own = existing !== undefined && existing.run === identity.run && existing.loop === identity.loop;
      const clock = { nowMs, ...(pidAlive ? { pidAlive } : {}) };
      if (existing && !own && leaseBlocksClaim(existing, clock)) {
        return { ok: false, why: `#${issue} is held by ${existing.loop} (${leaseStatus(existing, clock)})` };
      }
      const claimed = claimLease(store, { issue, run: identity.run, loop: identity.loop, pid: identity.pid, worktree, branch, nowMs });
      if (claimed.outcome === "held") {
        return { ok: false, why: `#${issue} is held by ${claimed.lease.loop} (${claimed.status})` };
      }
      writeLeaseStore(path, store);
      return { ok: true };
    });
    return result ?? { ok: false, why: "the lease store is locked" };
  } catch (error) {
    return { ok: false, why: `the lease store could not be used: ${(error as Error).message}` };
  }
}

/**
 * Drop this run's adopted lease: `released`, `none` when this run held none
 * (already released, or expired), or `failed` when the store's lock was busy
 * or the store could not be used. A caller that forgets a `failed` release
 * strands the lease — the heartbeat keeps renewing it as the run's current
 * one, and the medic adopts nothing else for the rest of the run — so it
 * keeps whatever lets it try again.
 */
export function releaseAdoptedLease(
  path: string,
  issue: number,
  identity: { run: string; loop: string },
): "released" | "none" | "failed" {
  try {
    const released = withLeaseStoreLock(path, () => {
      const result = releaseLease(readLeaseStore(path), issue, identity);
      if (result.released) writeLeaseStore(path, result.store);
      return result.released;
    });
    if (released === undefined) return "failed";
    return released ? "released" : "none";
  } catch {
    return "failed";
  }
}

/**
 * Who adopts, from the supervisor's environment. The pid is the SUPERVISOR's:
 * the gate exits after its poll, and the heartbeat watcher renews a lease only
 * under the supervisor's pid, so a lease held under this process's pid would
 * be judged dead as soon as it exited.
 */
export function adoptIdentityFrom(env: NodeJS.ProcessEnv): AdoptIdentity | null {
  const run = env.RALPH_RUN_ID;
  const loop = env.RALPH_LOOP_NAME;
  const pidText = env.RALPH_SUPERVISOR_PID;
  if (!run || !loop || !pidText || !/^[1-9]\d*$/.test(pidText)) return null;
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) ? { run, loop, pid } : null;
}

/* --------------------------------------------------------------------------
 * Which orphan.
 * ----------------------------------------------------------------------- */

export const MIGRATION_APPLIED_LABEL = "migration-applied";

/**
 * The orphan to adopt first: one whose migration is already applied in
 * production reds every other pull request until it merges, so it goes
 * first; then the oldest, by number.
 */
export function pickOrphan<T extends { number: number; labels?: { name: string }[] }>(candidates: readonly T[]): T | null {
  const applied = (pr: T): boolean => (pr.labels ?? []).some((label) => label.name === MIGRATION_APPLIED_LABEL);
  let best: T | null = null;
  for (const pr of candidates) {
    if (best === null) { best = pr; continue; }
    const a = applied(pr);
    const b = applied(best);
    if ((a && !b) || (a === b && pr.number < best.number)) best = pr;
  }
  return best;
}

/* --------------------------------------------------------------------------
 * The comments.
 * ----------------------------------------------------------------------- */

/** Same shape as `case.ts`'s marker, so one search finds every medic comment. */
export const adoptionMarker = (verb: "adopt" | "handback", loop: string, head: string): string =>
  `<!-- pr-medic:${verb} ${loop} ${head} -->`;

export interface AdoptCommentInput {
  medic: string;
  owner: string;
  stopKind: string | null;
  downSince: string;
  nowMs: number;
  head: string;
}

export function adoptComment({ medic, owner, stopKind, downSince, nowMs, head }: AdoptCommentInput): string {
  const since = Date.parse(downSince);
  const seconds = Number.isFinite(since) ? Math.max(0, Math.floor((nowMs - since) / 1000)) : null;
  const down = seconds === null ? `since ${downSince}` : `for ${formatDuration(seconds)}`;
  const why = stopKind ?? "no recorded ending";
  return [
    `**${medic}** is adopting this pull request from **${owner}**, which has been down ${down} (${why}).`,
    "",
    `${medic} will work to get it green, but never merges it, and hands it back if ${owner} returns.`,
    "",
    adoptionMarker("adopt", medic, head),
  ].join("\n");
}

export function handbackComment({ medic, owner, head }: { medic: string; owner: string; head: string }): string {
  return [
    `**${owner}** is back, so **${medic}** hands this pull request back to it and drops its claim, with no push.`,
    "",
    adoptionMarker("handback", medic, head),
  ].join("\n");
}

/** Whether a comment carrying `mark` is already on the pull request. */
export function said(comments: { body?: string }[] | undefined, mark: string): boolean {
  return (comments ?? []).some((comment) => (comment.body ?? "").includes(mark));
}
