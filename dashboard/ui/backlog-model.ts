/**
 * What the backlog's hover text and its For you list say, kept out of the
 * component so the wording and the joins can be tested without a DOM.
 *
 * Every age here is measured against the dashboard's own read time (`nowMs`),
 * not the browser's clock, so the page and its tooltips agree on "now".
 */
import type {
  DashboardLoop,
  FrontierDroppedReference,
  FrontierRead,
  FrontierView,
  HumanReason,
  StuckReason,
} from "../contracts";
import { parkLive, parkText } from "./blocked-model";

export type BacklogLoop = Pick<DashboardLoop, "loop" | "supervisor" | "claims" | "issue" | "phase" | "lastEvent">;

/** A span as an operator reads it: the two largest units, never seconds past a minute. */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** How long ago `iso` was, or null when it is missing or unreadable rather than a made-up zero. */
export function since(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : duration(nowMs - at);
}

/**
 * The claimed tickets a loop is working right now: claimed by a loop whose
 * supervisor is alive. A claim whose loop is down is still in flight on the
 * frontier, but nothing is moving it, and a spinner would say otherwise.
 */
export function runningTickets(view: FrontierView, loops: readonly Pick<DashboardLoop, "loop" | "supervisor">[]): Set<number> {
  const alive = new Set(loops.filter((entry) => entry.supervisor === "alive").map((entry) => entry.loop));
  return new Set(
    view.inFlight.filter((ticket) => ticket.loop !== null && alive.has(ticket.loop)).map((ticket) => ticket.number),
  );
}

/**
 * An in-flight ticket's hover text: who holds it, for how long, and what the
 * loop is doing on it now. The phase and last event are shown only when the
 * loop's current issue IS this ticket: a loop with two claims is working one.
 */
export function inFlightTip(
  ticket: FrontierView["inFlight"][number],
  loops: readonly BacklogLoop[],
  nowMs: number,
): string {
  const loop = ticket.loop === null ? undefined : loops.find((entry) => entry.loop === ticket.loop);
  if (loop === undefined) return `claimed by ${ticket.claim}`;
  const lines: string[] = [];
  lines.push(loop.supervisor === "alive" ? `${loop.loop} is working it` : `claimed by ${loop.loop}, whose loop is not running`);
  const age = since(loop.claims.find((claim) => claim.issue === ticket.number)?.claimedAt, nowMs);
  lines.push(age === null ? "claimed at an unknown time" : `claimed ${age} ago`);
  if (loop.issue === ticket.number) {
    if (loop.phase !== null) lines.push(`phase: ${loop.phase}`);
    if (loop.lastEvent !== null) {
      const what = loop.lastEvent.detail ?? loop.lastEvent.name;
      const when = since(loop.lastEvent.at, nowMs);
      lines.push(when === null ? `last: ${what}` : `last: ${what} (${when} ago)`);
    }
  }
  return lines.join("\n");
}

/**
 * A stuck ticket's hover text: the reason the loop wrote and how long it has
 * stood. A parked ticket leads with its park, since what it waits on (or which
 * condition never held) is what decides whether anyone has to act.
 */
export function stuckTip(reason: StuckReason | undefined, nowMs: number): string | undefined {
  const why = reason?.reason ?? (reason?.kind === "unknown" ? "no block reason found on the ticket" : undefined);
  const age = since(reason?.at, nowMs);
  if (reason?.park) {
    const lines = [parkText(reason.park, nowMs)];
    if (why !== undefined) lines.push(why);
    if (age !== null) lines.push(`stuck for ${age}`);
    return lines.join("\n\n");
  }
  if (age === null) return why;
  return why === undefined ? `stuck for ${age}` : `${why}\n\nstuck for ${age}`;
}

/**
 * Whether a block reason says a person has to act: the loop finished what it
 * could and wrote that the rest is a human's (an on-device pass, a manual
 * check). Such a ticket is the operator's as much as a `ready-for-human` one.
 */
const HUMAN_WORDS = /\b(needs?|requires?|waits? (on|for)) (a |an )?(human|person|operator|manual)\b|\bmanual(ly)? (pass|check|test|step|verification)\b/i;

export const needsHuman = (reason: StuckReason): boolean => reason.reason !== null && HUMAN_WORDS.test(reason.reason);

/**
 * Whether a stuck ticket is the operator's: a live park keeps it off whatever
 * its reason says (a probe watches it), a spent one puts it on (the condition
 * never held), and without a park the reason's words decide. One rule for the
 * For you list and the Stuck panel's chip, so the two cannot disagree.
 */
export const forPerson = (reason: StuckReason, nowMs: number): boolean =>
  reason.park === null ? needsHuman(reason) : !parkLive(reason.park, nowMs);

/** One row of the For you list: labelled for a person, or stuck on a step only a person can take. */
export type ForYouRow =
  | { number: number; title: string; kind: "human"; reason: HumanReason }
  | { number: number; title: string; kind: "stuck"; stuck: StuckReason };

/**
 * The tickets waiting on the operator, labelled ones first; a ticket appears
 * once. A live park keeps a stuck ticket off the list whatever its reason says
 * — a probe watches it, nobody waits on a person yet — and a spent one puts it
 * on, since the condition never held and only a person can move it now.
 */
export function forYouRows(view: FrontierView, nowMs: number): ForYouRow[] {
  const rows: ForYouRow[] = view.human.map((ticket) => ({
    number: ticket.number,
    title: ticket.title,
    kind: "human",
    reason: ticket.reason,
  }));
  const listed = new Set(rows.map((row) => row.number));
  for (const reason of view.stuckReasons) {
    if (listed.has(reason.number)) continue;
    if (!forPerson(reason, nowMs)) continue;
    listed.add(reason.number);
    rows.push({ number: reason.number, title: reason.title, kind: "stuck", stuck: reason });
  }
  return rows;
}

/**
 * How `frontier/github-rate-limit.ts:RateLimitedError` starts its message, on
 * any line: the census may print warnings to stderr before it.
 */
const RATE_LIMITED = /^GitHub rate limit\b/m;

/**
 * The line above a backlog that is the last good census, kept because the
 * latest refresh failed; null when the backlog is fresh or there is none. A
 * GitHub throttle is named as one, since it is the usual cause and lifts by
 * itself; `time` formats the kept read's clock time.
 */
export function staleNote(frontier: FrontierRead, time: (iso: string) => string): string | null {
  if (frontier.view === null || !frontier.failedAt) return null;
  const cause = RATE_LIMITED.test(frontier.problem ?? "") ? "GitHub is rate-limiting the read" : "the latest read failed";
  return `Stale since ${time(frontier.readAt)}: ${cause}, retrying every minute.`;
}

/**
 * The references the frontier dropped, by ticket: built once per view, read per
 * row. An absent field reads as none: the hosted remote page renders the
 * snapshot an older host dashboard stored, which may predate it.
 */
export const droppedByNumber = (view: FrontierView): Map<number, FrontierDroppedReference[]> =>
  new Map((view.dropped ?? []).map((ticket) => [ticket.number, ticket.references]));

/** The chip's word on a ticket with dropped references. */
export const droppedWord = (references: readonly FrontierDroppedReference[]): string =>
  references.length === 1 ? "ignored ref" : "ignored refs";

/**
 * The chip's hover text: each dropped reference and why, and what that means.
 * Said per heading, because a dropped parent is no blocker: it changes which
 * spec the ticket is grouped under, not whether it looks free.
 */
export function droppedTip(references: readonly FrontierDroppedReference[]): string {
  const lines = references.map((ref) => `${ref.heading}: ${ref.reference} — ${ref.reason}`);
  const notes: string[] = [];
  if (references.some((ref) => ref.heading === "Blocked by")) {
    notes.push("A dropped blocker is not counted, so this ticket may only look unblocked.");
  }
  if (references.some((ref) => ref.heading === "Parent")) {
    notes.push("A dropped parent is not counted, so this ticket is not grouped under that spec.");
  }
  return [lines.join("\n"), ...notes].join("\n\n");
}
