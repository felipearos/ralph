/**
 * Lease stores a ROLE owns, and the one renewal the supervisor's heartbeat
 * makes on them.
 *
 * `claim-lease.ts` renews the issue claim — the lease every role holds, in the
 * store every loop shares. A role may also hold a lease in a store of its own:
 * the ci-doctor's case lease in `<git-common-dir>/ralph/ci-health.json`, which
 * says which doctor is working which CI case. That lease expires in 120s, so
 * something has to renew it while its iteration runs, and the heartbeat is
 * already the process that knows the run is alive and beats on a timer.
 *
 * Rather than teach the heartbeat about the ci-health store, a role REGISTERS
 * its store here and the heartbeat renews whatever the running loop's role
 * declares. Adding the next role's store is an entry in `ROLE_LEASE_STORES`,
 * not an edit to the heartbeat — the same reason intake lives on the role
 * descriptor (`roles.ts`) rather than in a `case` in `ralph.sh`.
 *
 * A role with no store is the ordinary case, and it costs nothing: a coder's
 * beat looks up `null` and reads no file.
 */
import { hostname } from "node:os";

import { CASE_LEASE_SECONDS, readStore as readCiHealthStore, storePathFromGit, withStore as withCiHealthStore } from "./ci-doctor/store";
import { ROLES, isRole, type Role } from "./roles";
import {
  ISSUE_LEASE_SECONDS,
  readStore as readSentinelStore,
  storePathFromGit as sentinelStorePathFromGit,
  withStore as withSentinelStore,
} from "./sentinel/store";
import {
  CHECK_IN_LEASE_SECONDS,
  readStore as readVerifierStore,
  storePathFromGit as verifierStorePathFromGit,
  withStore as withVerifierStore,
} from "./verifier/watches";

/** How long a renewal is good for when a role's registration names no other. */
export const DEFAULT_ROLE_LEASE_SECONDS = 120;

/**
 * One holder of a role lease. Structurally the ci-doctor's `Lease`
 * (`ci-doctor/store.ts`), on purpose: this module renews that store's leases
 * rather than owning a second shape of its own.
 *
 * That fit is safe in one direction only. This module never CONSTRUCTS a
 * lease — it moves `expiresAt` and deletes keys — so a field the owning store
 * adds rides through untouched. Write one here and every field this interface
 * does not name is silently dropped from a store that needs it; take the
 * owning store's own type for that, as its own code does.
 */
export interface RoleLease {
  run: string;
  loop: string;
  pid: number;
  host: string;
  expiresAt: string;
}

/** Any store with a `leases` map the heartbeat can renew. */
export interface RoleLeaseStore {
  leases?: Record<string, RoleLease>;
}

const thisHost = (): string => process.env.HOSTNAME ?? hostname();

/**
 * Is the holder still there? The rule is `host-lease.ts#partyAlive`'s, and for
 * its reason: a pid recorded by a loop on another host means nothing on this
 * one, so a holder somewhere else is taken as alive and left to its own expiry.
 *
 * Copied rather than imported, deliberately: `host-lease.ts` is the supervisor's
 * turn-taking machinery, and every heartbeat — one per boundary, all run long —
 * would pull it and its imports in for three lines. Change `partyAlive` and
 * change this with it; there is no type that will notice for you.
 */
export function holderAlive(holder: { pid: number; host: string }): boolean {
  if (holder.host !== thisHost() && holder.host !== hostname()) return true;
  try { process.kill(holder.pid, 0); return true; } catch { return false; }
}

/**
 * Renew this run's leases, and clear the ones nobody is behind any more.
 *
 * Pure, and the whole policy in one place: ownership is `run` AND `loop`
 * together, because two loops of one run are two agents, and renewing is
 * checked FIRST so a run can never prune itself on a host where its own pid
 * check is answered wrongly. Pruning is `host-lease.ts#prune`'s job in this
 * store: a dead holder's lease would otherwise keep a case held until its
 * expiry passed, and an expiry that nobody renews is the slower of the two
 * answers. An expired lease whose holder still runs is NOT pruned — that
 * holder is mid-turn and about to renew it.
 *
 * Narrower than `host-lease.ts#prune` in one way, and it matters to whoever
 * reads these leases next: a holder on ANOTHER host is taken as alive however
 * long ago it died, so its lease is cleared by nobody here. The reader must
 * still treat a lease past `expiresAt` as free. This function only keeps a
 * live holder's lease from reaching that point.
 */
export function renewRoleLeases(
  store: RoleLeaseStore,
  identity: { run: string; loop: string },
  nowMs: number,
  options: { leaseMs?: number; alive?: (holder: { pid: number; host: string }) => boolean } = {},
): { renewed: string[]; pruned: string[] } {
  const leases = store.leases;
  const renewed: string[] = [];
  const pruned: string[] = [];
  if (!leases) return { renewed, pruned };
  const leaseMs = options.leaseMs ?? DEFAULT_ROLE_LEASE_SECONDS * 1000;
  const alive = options.alive ?? holderAlive;
  for (const [key, lease] of Object.entries(leases)) {
    if (lease.run === identity.run && lease.loop === identity.loop) {
      lease.expiresAt = new Date(nowMs + leaseMs).toISOString();
      renewed.push(key);
      continue;
    }
    if (!alive({ pid: lease.pid, host: lease.host })) {
      delete leases[key];
      pruned.push(key);
    }
  }
  return { renewed, pruned };
}

/** How a role declares the store the heartbeat should renew for it. */
export interface RoleLeaseRegistration {
  /** What the store is called in a heartbeat log line. */
  what: string;
  /** Where the store lives, given a cwd. */
  path: (cwd?: string) => string;
  /** Read it without the lock, to see whether there is anything to do at all. */
  read: (path: string) => RoleLeaseStore;
  /** Read-modify-write the store under its own lock. */
  withStore: <T>(path: string, critical: (store: RoleLeaseStore) => T) => Promise<T>;
  leaseMs: number;
}

/**
 * The roles that own a lease store. Absent is the answer for a coder and a
 * triager: they hold the issue claim and nothing else, and the heartbeat must
 * stay free for them.
 */
export const ROLE_LEASE_STORES: Readonly<Partial<Record<Role, RoleLeaseRegistration>>> = {
  "ci-doctor": {
    what: "the ci-health store",
    path: storePathFromGit,
    read: readCiHealthStore,
    withStore: (path, critical) => withCiHealthStore(path, critical),
    leaseMs: CASE_LEASE_SECONDS * 1000,
  },
  // The check-in a verifier session is deciding stays leased to it for as long
  // as the session runs, so a second gate does not hand it over again (#565).
  verifier: {
    what: "the verifier watch store",
    path: verifierStorePathFromGit,
    read: readVerifierStore,
    withStore: (path, critical) => withVerifierStore(path, critical),
    leaseMs: CHECK_IN_LEASE_SECONDS * 1000,
  },
  // The reporter issue a sentinel session is drafting stays leased to it while
  // the session runs, so a second gate does not hand the same issue over again.
  sentinel: {
    what: "the sentinel issue store",
    path: sentinelStorePathFromGit,
    read: readSentinelStore,
    withStore: (path, critical) => withSentinelStore(path, critical),
    leaseMs: ISSUE_LEASE_SECONDS * 1000,
  },
};

export interface RoleLeaseRenewal {
  what: string;
  path: string;
  renewed: string[];
  pruned: string[];
}

/**
 * The one call the heartbeat makes: renew the running role's own leases, if it
 * has any.
 *
 * `null` for a role that registers no store, and it is a cheap null — nothing
 * is resolved, opened or created — because every coder's beat takes this path.
 *
 * An unknown role is NOT that case, and throws. `RALPH_LOOP_ROLE` is a string
 * from the roster, and a typo or a renamed role would otherwise read as "this
 * role owns no store": the ci-doctor's case lease would lapse mid-iteration,
 * silently, which is the one failure this module exists to prevent.
 *
 * A store error is thrown rather than swallowed too: the heartbeat logs what
 * it could not do, and deciding that here would hide it from the one log that
 * exists to say why a pulse went quiet.
 *
 * The store is read WITHOUT the lock first, and the lock is taken only when
 * that read found work. Two reasons, both about the store's real owner: the
 * registration's `withStore` writes whatever the critical section leaves, so
 * an unconditional beat would rewrite the whole ci-health cache every 30s,
 * create it on a worktree where no scan has ever run, and — if this harness
 * read a version it does not know, which `readStore` answers with an empty
 * store — truncate the scanner's cache to nothing. And the lock is the
 * scanner's; a beat with nothing to renew must not queue behind it for the
 * ten seconds `withStore` is willing to wait. A lease taken between the read
 * and the next beat is renewed by that next beat.
 */
export async function renewRoleLeaseStore(
  role: string | null | undefined,
  identity: { run: string; loop: string },
  options: { nowMs?: number; cwd?: string } = {},
): Promise<RoleLeaseRenewal | null> {
  if (!role) return null;
  if (!isRole(role)) throw new Error(`unknown role '${role}'; this project's roles are ${ROLES.join(", ")}`);
  const registration = ROLE_LEASE_STORES[role];
  if (!registration) return null;
  const path = registration.path(options.cwd);
  const nowMs = options.nowMs ?? Date.now();
  const preview = renewRoleLeases(structuredClone(registration.read(path)), identity, nowMs, {
    leaseMs: registration.leaseMs,
  });
  if (preview.renewed.length === 0 && preview.pruned.length === 0) {
    return { what: registration.what, path, renewed: [], pruned: [] };
  }
  const done = await registration.withStore(path, (store) =>
    renewRoleLeases(store, identity, nowMs, { leaseMs: registration.leaseMs }),
  );
  return { what: registration.what, path, renewed: done.renewed, pruned: done.pruned };
}
