/**
 * Who holds which CI case.
 *
 * The gate hands at most one case to an iteration, and two doctors on one
 * store must not hand out the same one. The claim is a lease in the store's
 * `leases` map, keyed by the case key, taken under the store lock and good for
 * `CASE_LEASE_SECONDS`. The supervisor's heartbeat renews it for as long as
 * the iteration runs (`role-leases.ts`, #138), so an expiry that has passed
 * means the holder is gone rather than busy.
 *
 * A lease rather than a label because the case is not a GitHub object: a
 * confirmed flake has no issue yet, and filing one to claim it would be a
 * write the gate is not allowed to make. It is also why this is a lease and
 * not a lock file — the holder is an ITERATION that outlives the gate process
 * that started it.
 *
 * Two rules, both from `role-leases.ts` and repeated here because a reader of
 * these leases needs both: ownership is `run` AND `loop` together, and a lease
 * past `expiresAt` is free even when its holder looks alive from another host.
 */
import { hostname } from "node:os";

import { supervisorPidFrom } from "../frontier-gate";
import { holderAlive } from "../role-leases";
import { CASE_LEASE_SECONDS, withStore, type Lease } from "./store";

/** Who a lease would name. `run` and `loop` together are the owner. */
export interface Holder {
  run: string;
  loop: string;
  pid?: number;
  host?: string;
}

/**
 * The pid a lease records is the SUPERVISOR's, never the gate's own.
 *
 * The gate exits the instant it prints its verdict, and the case it just
 * leased is worked by the iteration the supervisor then spawns. Recorded with
 * `process.pid`, the lease named a process that was already gone: a second
 * doctor's next poll read the holder as dead and took the case out from under
 * a live iteration, which is the one thing this module exists to prevent.
 * `claim-lease.ts` sets the precedent — it records `RALPH_SUPERVISOR_PID` and
 * the heartbeat rewrites it on every beat.
 */
export function supervisorPid(env: NodeJS.ProcessEnv = process.env): number {
  // One reading of `RALPH_SUPERVISOR_PID` for the whole harness: the gates ask
  // `frontier-gate.ts` the same question to decide whether to keep polling, and
  // a lease recorded against a different pid than the one being watched is the
  // disagreement this module exists to prevent. Only the fallback differs — the
  // gate is spawned by the supervisor, so its parent is the next best answer,
  // and `process.pid` is the last resort, right only for a hand run.
  return supervisorPidFrom(env, process.ppid || process.pid);
}

export const holderOf = (holder: Holder): Required<Holder> => ({
  run: holder.run,
  loop: holder.loop,
  pid: holder.pid ?? supervisorPid(),
  host: holder.host ?? process.env.HOSTNAME ?? hostname(),
});

/** Is this lease this holder's own? */
export const mine = (lease: Lease, holder: Holder): boolean =>
  lease.run === holder.run && lease.loop === holder.loop;

/**
 * Is `key` free for `holder` to take? Its own lease counts as free — a doctor
 * resuming its own case must not be fenced out by the lease it took last poll.
 *
 * `alive` is injected so the race test can fake a holder that is still there;
 * it defaults to the pid-and-host check the heartbeat prunes with.
 */
export function free(
  leases: Record<string, Lease>,
  key: string,
  holder: Holder,
  nowMs: number,
  alive: (h: { pid: number; host: string }) => boolean = holderAlive,
): boolean {
  const lease = leases[key];
  if (lease === undefined) return true;
  if (mine(lease, holder)) return true;
  // Both answers, in the order `role-leases.ts` gives them. Expiry is the
  // answer that always arrives: a holder on another host is taken as alive
  // however long ago it died, so nothing but the clock frees its lease.
  // Liveness is the faster one where it applies, and it is why a doctor killed
  // mid-case does not hold it for the remaining two minutes.
  const expires = Date.parse(lease.expiresAt);
  if (Number.isFinite(expires) && expires <= nowMs) return true;
  return !alive({ pid: lease.pid, host: lease.host });
}

/** Every case key `holder` may not have, so `decide` can skip them all at once. */
export function heldElsewhere(
  leases: Record<string, Lease>,
  holder: Holder,
  nowMs: number,
  alive: (h: { pid: number; host: string }) => boolean = holderAlive,
): string[] {
  return Object.keys(leases)
    .filter((key) => !free(leases, key, holder, nowMs, alive))
    .sort();
}

export interface TakeResult {
  /** Did this holder end up with the lease? */
  taken: boolean;
  /** Who has it when `taken` is false. */
  holder: Lease | null;
}

/*
 * There is deliberately no prune here. `role-leases.ts#renewRoleLeases` owns
 * clearing this store's dead holders on the supervisor's heartbeat, and a
 * second implementation of a writer policy is how the two stop agreeing. The
 * gate only needs to know whether ONE key is free, which `free` answers from
 * the expiry and the holder's liveness without writing anything.
 */

/**
 * Take the lease on one case, or report who has it.
 *
 * The whole read-decide-write runs inside `withStore`, which is the only
 * reason two doctors polling the same store cannot both be handed one case:
 * checking outside the lock and writing inside it is exactly the race this
 * closes.
 */
export async function takeCaseLease(
  path: string,
  key: string,
  holder: Holder,
  options: { nowMs?: number; leaseSeconds?: number; alive?: (h: { pid: number; host: string }) => boolean } = {},
): Promise<TakeResult> {
  const nowMs = options.nowMs ?? Date.now();
  const seconds = options.leaseSeconds ?? CASE_LEASE_SECONDS;
  const who = holderOf(holder);
  const alive = options.alive ?? holderAlive;
  return withStore(path, (store) => {
    if (!free(store.leases, key, who, nowMs, alive)) {
      return { taken: false, holder: store.leases[key] ?? null };
    }
    store.leases[key] = { ...who, expiresAt: new Date(nowMs + seconds * 1000).toISOString() };
    return { taken: true, holder: store.leases[key] };
  });
}
