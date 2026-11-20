/**
 * The project's sleep on the page, as pure functions: what the header shows
 * for a read of `GET /api/sleep`, the bodies the toggle posts, and what one
 * toggle's answer means. The view (`project-sleep.tsx`) only draws these.
 *
 * Sleeping is soft, and the words say so: no agent is stopped mid-iteration,
 * each parks at its next iteration boundary until the project is woken.
 */
import { PROJECT_SLEEP_WHY_MAX, type ProjectSleepView } from "../contracts";
import { EMPTY_ANSWER, noticeText, type CommandError, type Result } from "./command-model";
import type { Read } from "./query-reads";

/** What the confirmation says before a sleep: the one thing an operator must know first. */
export const SLEEP_EXPLANATION =
  "Every agent finishes what it is doing, then waits before its next iteration until you wake the project.";

export type SleepState =
  /** Nothing to show: still loading, the remote page (no read), or a server without the route. */
  | { kind: "hidden" }
  /** The sleep could not be read; no toggle, since its effect would be a guess. */
  | { kind: "unknown"; problem: string }
  | { kind: "awake" }
  | { kind: "asleep"; since: string; why: string | null; by: string | null; line: string };

/** How an instant reads in the banner; injected so a test does not depend on the host's locale. */
export type FormatInstant = (iso: string) => string;

const localTime: FormatInstant = (iso) => new Date(iso).toLocaleString();

/** "Asleep since <time> — <why>", the why left out when none was given. */
export function asleepLine(view: Pick<ProjectSleepView, "since" | "why">, format: FormatInstant = localTime): string {
  const since = view.since === null ? "" : ` since ${format(view.since)}`;
  return `Asleep${since}${view.why === null ? "" : ` — ${view.why}`}`;
}

function stateOf(view: ProjectSleepView, format: FormatInstant): SleepState {
  if (view.problem !== null) return { kind: "unknown", problem: view.problem };
  if (!view.asleep || view.since === null) return { kind: "awake" };
  return { kind: "asleep", since: view.since, why: view.why, by: view.by, line: asleepLine(view, format) };
}

export function sleepState(read: Read<ProjectSleepView>, format: FormatInstant = localTime): SleepState {
  if (read.state === "loading") return { kind: "hidden" };
  if (read.state === "ready") return stateOf(read.data, format);
  // A dashboard older than the route: nothing to offer, and nothing wrong to say.
  if (read.status === 404) return { kind: "hidden" };
  // A failed poll after a good one keeps the last answer: the marker rarely
  // changes, and a blip should not hide an asleep banner.
  if (read.data !== null) return stateOf(read.data, format);
  return { kind: "unknown", problem: read.message };
}

/** The body a sleep posts; a blank reason is left out rather than sent empty. */
export function sleepBody(why: string): { asleep: true; why?: string } {
  const reason = why.trim().replace(/\s+/g, " ");
  return reason === "" ? { asleep: true } : { asleep: true, why: reason };
}

export const WAKE_BODY = { asleep: false } as const;

/** Why the reason cannot be sent as typed, or null. The route is the judge; this saves a round trip. */
export function whyHint(why: string): string | null {
  const length = why.trim().replace(/\s+/g, " ").length;
  return length > PROJECT_SLEEP_WHY_MAX ? `Keep the reason under ${PROJECT_SLEEP_WHY_MAX} characters (it is ${length}).` : null;
}

/**
 * One toggle's answer: ok only when the CLI ran and the project is now in the
 * state asked for. A view carrying a `problem` is a 200 the page must still
 * show as a failure, since the marker may not have been written.
 */
export function settleToggle(
  wanted: boolean,
  result: Result<ProjectSleepView | null, CommandError>,
): { ok: true } | { ok: false; message: string } {
  if (!result.ok) return { ok: false, message: noticeText(result.error) };
  const view = result.value;
  if (view === null) return { ok: false, message: noticeText(EMPTY_ANSWER) };
  if (view.problem !== null) return { ok: false, message: view.problem };
  if (view.asleep !== wanted) return { ok: false, message: `The project is still ${view.asleep ? "asleep" : "awake"}.` };
  return { ok: true };
}
