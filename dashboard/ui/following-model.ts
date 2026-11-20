/**
 * The Following panel's derivations (felipearos/ralph#569).
 *
 * What the verifier is following into production, read from its watch store
 * by the aggregation and already on the `Dashboard`: the watches still
 * checking in, the ones it has judged, what observe mode held back, and the
 * criteria no check-in could verify live. `.tsx` has no tests, so every
 * string this panel draws is decided here.
 */
import { FOLLOWING_WOULD_BE, verifiers, type Dashboard, type FollowingWatchView, type FollowingWouldBe } from "../contracts";

/** A watch still checking in. */
export interface FollowingProgressRow {
  key: string;
  ticket: number;
  ticketRef: string;
  pr: number;
  mode: string;
  round: number;
  /** `2/4`. */
  checkIns: string;
  /** Null when the store names no next check-in for a watch still in progress. */
  next: { label: string; dueAt: string; relative: string; overdue: boolean } | null;
}

/** A watch the verifier has judged. */
export interface FollowingFinishedRow {
  key: string;
  ticket: number;
  ticketRef: string;
  pr: number;
  /** Null for a finished watch the store recorded no verdict on. */
  verdict: string | null;
  reason: string | null;
  /**
   * What the mode changed, or null when the verdict was acted on as computed:
   * `observe mode: held back, nothing was done` or
   * `report mode: would have been revert`.
   */
  note: string | null;
}

/** One action observe mode held back. */
export interface FollowingWouldBeRow {
  key: string;
  ticket: number;
  ticketRef: string;
  pr: number;
  verdict: FollowingWouldBe;
  reason: string;
  /** `at +6 h check-in`, or `final verdict`. */
  where: string;
}

/** One acceptance criterion a check-in could not verify against production. */
export interface FollowingUnverifiableRow {
  key: string;
  ticket: number;
  ticketRef: string;
  criterion: string;
  detail: string | null;
}

export interface FollowingPanelView {
  /** Why the view is unknown; null whenever the lists below are real. */
  problem: string | null;
  /** When the read was taken; null when none was. */
  readAt: string | null;
  /**
   * The sentence for an empty store, or null when there is something to show.
   * An empty store is a complete answer, never an error: a verifier that has
   * not been handed a merge yet has nothing to follow.
   */
  empty: string | null;
  inProgress: FollowingProgressRow[];
  finished: FollowingFinishedRow[];
  wouldHaveActed: FollowingWouldBeRow[];
  notVerifiableLive: FollowingUnverifiableRow[];
}

const MINUTE = 60_000;

/** A duration as the panel says it: minutes under an hour, whole hours past it. */
const span = (ms: number): string => {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
};

/**
 * When a check-in is due, relative to `now`. Under a minute either way is
 * "due now": the verifier polls, so a check-in a few seconds late is on time
 * and "overdue by 0 min" would read as an alarm.
 */
export function dueWord(dueAt: string, now: Date): { relative: string; overdue: boolean } {
  const at = new Date(dueAt).getTime();
  if (Number.isNaN(at)) return { relative: "due at an unreadable time", overdue: false };
  const delta = at - now.getTime();
  if (Math.abs(delta) < MINUTE) return { relative: "due now", overdue: false };
  return delta > 0 ? { relative: `in ${span(delta)}`, overdue: false } : { relative: `overdue by ${span(-delta)}`, overdue: true };
}

/** Where a held-back action came from: a numbered check-in, or the terminal verdict. */
export const whereWord = (at: number | null): string => (at === null ? "final verdict" : `at +${at} h check-in`);

const progressRow = (watch: FollowingWatchView, now: Date): FollowingProgressRow => ({
  key: `${watch.pr}`,
  ticket: watch.ticket,
  ticketRef: watch.ticketRef,
  pr: watch.pr,
  mode: watch.mode,
  round: watch.round,
  checkIns: `${watch.checkInsDone}/${watch.checkInsTotal}`,
  next:
    watch.nextCheckIn === null
      ? null
      : {
          label: `+${watch.nextCheckIn.offsetHours} h`,
          dueAt: watch.nextCheckIn.dueAt,
          ...dueWord(watch.nextCheckIn.dueAt, now),
        },
});

// The verdicts that would have written to the tracker or the repository.
const ACTIONS: readonly string[] = FOLLOWING_WOULD_BE;

/**
 * What the watch's mode did to its verdict. Observe records the verdict it
 * computed with `act: false` and `wouldHaveBeen` equal to it, so a held-back
 * revert must say so here or the row reads as a revert that happened. Report
 * turns a revert into a ticket and keeps the revert in `wouldHaveBeen`.
 */
function modeNote(watch: FollowingWatchView): string | null {
  const verdict = watch.verdict;
  if (verdict === null) return null;
  if (verdict.wouldHaveBeen !== null && verdict.wouldHaveBeen !== verdict.verdict) {
    return `${watch.mode} mode: would have been ${verdict.wouldHaveBeen}`;
  }
  if (!verdict.act && ACTIONS.includes(verdict.verdict)) return `${watch.mode} mode: held back, nothing was done`;
  return null;
}

const finishedRow = (watch: FollowingWatchView): FollowingFinishedRow => ({
  key: `${watch.pr}`,
  ticket: watch.ticket,
  ticketRef: watch.ticketRef,
  pr: watch.pr,
  verdict: watch.verdict?.verdict ?? null,
  reason: watch.verdict?.reason ?? null,
  note: modeNote(watch),
});

const degraded = (problem: string, readAt: string | null): FollowingPanelView => ({
  problem,
  readAt,
  empty: null,
  inProgress: [],
  finished: [],
  wouldHaveActed: [],
  notVerifiableLive: [],
});

/**
 * The panel, or null when this project staffs no verifier.
 *
 * Null rather than an empty panel for the reason `ciHealthPanel` gives: with
 * no verifier nobody is following merges, and "nothing is being followed"
 * would read as all clear rather than as a question nobody is asking.
 */
export function followingPanel(data: Dashboard, now: Date): FollowingPanelView | null {
  if (verifiers(data.loops).length === 0) return null;
  const read = data.following ?? null;
  if (read === null) return degraded("the adapter supplied no Following read", null);
  if (read.view === null) return degraded(read.problem ?? "no reason was reported", read.readAt);
  const watches = read.view.watches;
  return {
    problem: null,
    readAt: read.readAt,
    empty: watches.length === 0 ? "nothing is being followed" : null,
    inProgress: watches.filter((watch) => watch.state === "in-progress").map((watch) => progressRow(watch, now)),
    finished: watches.filter((watch) => watch.state === "finished").map(finishedRow),
    wouldHaveActed: watches.flatMap((watch) =>
      watch.wouldBe.map((entry, index) => ({
        key: `${watch.pr}-${index}`,
        ticket: watch.ticket,
        ticketRef: watch.ticketRef,
        pr: watch.pr,
        verdict: entry.verdict,
        reason: entry.reason,
        where: whereWord(entry.at),
      })),
    ),
    notVerifiableLive: watches.flatMap((watch) =>
      watch.notVerifiableLive.map((entry, index) => ({
        key: `${watch.pr}-${index}`,
        ticket: watch.ticket,
        ticketRef: watch.ticketRef,
        criterion: entry.criterion,
        detail: entry.detail,
      })),
    ),
  };
}
