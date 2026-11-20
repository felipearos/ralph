/**
 * The words and tones of the notification feed and the audit history, kept
 * out of the components so they can be tested without rendering.
 */
import type { DeliveryView, HistoryEntryView, HistoryView, NotificationFeed, NotificationView, RecordProblem } from "../contracts";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export const DELIVERY_TONE: Record<DeliveryView["state"], Tone> = {
  delivered: "good",
  failed: "bad",
  skipped: "warn",
  unconfirmed: "warn",
};

export const DELIVERY_WORD: Record<DeliveryView["state"], string> = {
  delivered: "delivered",
  failed: "not delivered",
  skipped: "not sent",
  unconfirmed: "unconfirmed",
};

/** A delivery as one line: `board: not delivered — no run to send the alert to`. */
export function deliveryLine(delivery: DeliveryView): string {
  const name = delivery.channel === "github" ? "ticket comment" : delivery.name;
  const word = DELIVERY_WORD[delivery.state];
  return delivery.why === null ? `${name}: ${word}` : `${name}: ${word} — ${delivery.why}`;
}

/** The newest alert's time: what "mark read" marks through, so an alert arriving meanwhile stays unread. */
export function newestAt(alerts: NotificationView[]): string | null {
  let newest: string | null = null;
  for (const alert of alerts) {
    if (newest === null || Date.parse(alert.at) > Date.parse(newest)) newest = alert.at;
  }
  return newest;
}

/** The loops with unread alerts, each with the time to mark it read through. */
export function unreadMarks(feeds: NotificationFeed[]): { loop: string; through: string }[] {
  return feeds.flatMap((feed) => {
    const through = newestAt(feed.notifications.filter((alert) => !alert.read));
    return feed.unread > 0 && through !== null ? [{ loop: feed.loop, through }] : [];
  });
}

/** Why a feed is empty, in the operator's words. */
export function emptyFeed(problem: RecordProblem | null): { text: string; tone: Tone } {
  if (problem === null) return { text: "No alerts in the feed.", tone: "neutral" };
  if (problem.kind === "missing") return { text: "This loop has raised no alerts yet.", tone: "neutral" };
  if (problem.kind === "no-checkout") return { text: "No checkout is attributed to this loop, so it keeps no feed.", tone: "neutral" };
  return { text: `The feed could not be read: ${problem.detail}`, tone: "warn" };
}

export const HISTORY_OUTCOME_TONE: Record<string, Tone> = {
  applied: "good",
  interrupted: "good",
  repaired: "good",
  healthy: "good",
  replayed: "neutral",
  pending: "info",
  refused: "bad",
  failed: "bad",
  survived: "bad",
  "not-repairable": "bad",
  "not-for-this-loop": "bad",
  "needs-reconfirmation": "warn",
  stopped: "warn",
};

export const outcomeTone = (outcome: string): Tone => HISTORY_OUTCOME_TONE[outcome] ?? "neutral";

export const SOURCE_WORD: Record<HistoryEntryView["source"], string> = {
  command: "command",
  signal: "signal",
  repair: "repair",
};

/** Why an outcome came out the way it did, when that is the part that matters. */
export function refusalLine(entry: HistoryEntryView): string | null {
  if (entry.failedCheck !== null) return `failed the ${entry.failedCheck} check`;
  return null;
}

/**
 * What the history says when it has nothing to list, and what it adds below a
 * list: only records that exist and could not be read. A record that was
 * never written is the ordinary state of a loop nobody has touched.
 */
export function historyNotes(view: HistoryView): { empty: string; warnings: string[] } {
  const warnings = view.problems
    .filter((entry) => entry.problem.kind === "unreadable")
    .map((entry) => `${SOURCE_WORD[entry.source]}s: ${entry.problem.detail}`);
  const noCheckout = view.problems.some((entry) => entry.problem.kind === "no-checkout");
  const empty = noCheckout
    ? "No checkout is attributed to this loop, so it keeps no history."
    : "No commands, signals or repairs have been recorded for this loop.";
  return { empty, warnings };
}
