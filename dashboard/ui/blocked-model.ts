/**
 * Stuck tickets, split the way an operator acts on them: the ones waiting only
 * on a person applying a migration, the ones the ci-doctor will clear by
 * itself, and the ones stuck for any other reason — which is to say the ones
 * that actually need triage.
 *
 * A `ci-flake` has its own group because the operator has NOTHING to do about
 * it: `ci-doctor/unpark.ts` puts the ticket back in front of its coder once
 * the flake is diagnosed, and `prompts/ci-doctor.md` calls it, so it is work
 * in hand rather than work waiting. Until felipearos/ralph#157 landed that
 * route did not exist and this file sorted a flake with the other reasons for
 * exactly that reason; now it would be a ticket filed under "needs triage"
 * that needs none (felipearos/ralph#160, third acceptance criterion).
 *
 * An `unknown` reason still sorts with the other reasons: nothing says it is a
 * migration OR a flake, so it needs a look either way.
 *
 * The three groups are a PARTITION. An operator reads the counts as a split of
 * what is stuck, and a ticket in two groups would make the backlog look larger
 * than it is.
 */
import type { FrontierView, ParkCondition, ParkReason, StuckReason } from "../contracts";

export interface StuckGroups {
  /**
   * Parked on a wake condition a model-free probe watches (#776/#777): nobody
   * has to act until the condition holds or the budget runs out. Checked before
   * the kind split, so a live-parked migration ticket sits here and not in
   * `migration`; a spent park falls back to a group a person acts on — its
   * migration, or `other` (never `doctor`, whose panel says nobody acts).
   */
  parked: StuckReason[];
  migration: StuckReason[];
  /** Parked on a flaky test: the ci-doctor's to clear, not a person's. */
  doctor: StuckReason[];
  other: StuckReason[];
}

export function stuckGroups(view: FrontierView, nowMs: number): StuckGroups {
  const groups: StuckGroups = noStuckGroups();
  for (const reason of view.stuckReasons) {
    const group =
      reason.park !== null && parkLive(reason.park, nowMs)
        ? "parked"
        : reason.kind === "migration"
          ? "migration"
          : // A spent park on a flake is a person's now, not the doctor's:
            // the doctor's panel says nobody here acts, and that would hide it.
            reason.kind === "ci-flake" && reason.park === null
            ? "doctor"
            : "other";
    groups[group].push(reason);
  }
  return groups;
}

/**
 * The empty partition — what a backlog that could not be read shows.
 *
 * Exported so a caller never writes the literal out: an object literal with
 * the groups spelled by hand is how a reader came to be one group behind the
 * interface, which typechecks for every caller that only reads two of them.
 */
export const noStuckGroups = (): StuckGroups => ({ parked: [], migration: [], doctor: [], other: [] });

/** Each stuck ticket's reason by number, for the rows that only carry a label. */
export const stuckReasonsByNumber = (view: FrontierView): Map<number, StuckReason> =>
  new Map(view.stuckReasons.map((reason) => [reason.number, reason]));

/**
 * The short word a badge shows for a stuck ticket.
 *
 * Three readings, because they wait on three different things: a migration on a
 * person with database access, a `ci-flake` on the ci-doctor
 * (felipearos/ralph#155), and anything else on human triage, which keeps the
 * loop's label so the operator knows whose it is. Without the flake case a
 * ticket the doctor is already on reads identically to one waiting on a
 * person, which is the whole reason the kind exists. A park outranks all
 * three: while it is live nobody waits on a person, and once it is spent the
 * badge has to say so rather than fall back to a kind that hides it — except a
 * migration, whose "needs migration" already names the person's next step.
 */
export function stuckWord(label: string, reason: StuckReason | undefined, nowMs: number): string {
  if (reason?.park && parkLive(reason.park, nowMs)) return "parked";
  if (reason?.kind === "migration") return "needs migration";
  if (reason?.park) return "park ran out";
  if (reason?.kind === "ci-flake") return "flaky test";
  return label;
}

/**
 * Whether a park still holds the ticket: not expired, not escalated, and its
 * budget not run out by the page's own clock — the frontier view the park came
 * in can be older than the page, so its `expired` alone can lag.
 */
export function parkLive(park: ParkReason, nowMs: number): boolean {
  return !park.expired && park.escalatedAt === null && Date.parse(park.budgetUntil) > nowMs;
}

/** A wake condition in plain words, for a person reading why a ticket waits. */
export function conditionText(condition: ParkCondition): string {
  switch (condition.kind) {
    case "reference":
      return `${condition.ref} to land`;
    case "check":
      return `check ${condition.name} green ${condition.on === "pr" ? "on the PR" : "on main"}`;
    case "step":
      return `${condition.check} step ${condition.step} green`;
    case "label-removed":
      return `label ${condition.label} removed`;
  }
}

/**
 * A remaining span, as `backlog-model.ts`'s `duration` reads one. A local copy
 * because `backlog-model.ts` imports this module for `parkText`, and importing
 * it back would make the two a cycle.
 */
function remaining(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/**
 * One line on a park: what a live one waits for and how long it has left, or,
 * once spent, which condition never held — the thing a person now has to act
 * on.
 */
export function parkText(park: ParkReason, nowMs: number): string {
  if (parkLive(park, nowMs)) {
    return `parked: waiting for ${park.summary} · ${remaining(Date.parse(park.budgetUntil) - nowMs)} left`;
  }
  const spent = `park ran out: ${conditionText(park.condition)} never held`;
  return park.escalatedAt === null ? spent : `${spent} · escalated`;
}
