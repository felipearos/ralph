/**
 * The words of a loop's retry state, kept out of the component so they can
 * be tested without rendering. The next time stays ISO: the component
 * localises it, so this model reads neither the clock nor the locale.
 */
import type { LoopRetryView } from "../contracts";

export interface RetryLine {
  /** `2 of 7`. */
  attempt: string;
  cause: string;
  next: { kind: "at"; at: string } | { kind: "spent" };
}

/** A loop's retry as one line, or null when the loop carries none. */
export function retryLine(retry: LoopRetryView | undefined): RetryLine | null {
  if (retry === undefined) return null;
  // Branch on `spent`, the reconciler's own verdict; a null next time on an
  // unspent retry is a malformed record with nothing to show a time for, so
  // it reads as spent rather than as a fake time. A past next time is shown
  // as is, with no "overdue": the reconcile pass may run late, and a loop a
  // retry brought back keeps its line until it finishes an iteration.
  const next: RetryLine["next"] = retry.spent || retry.nextAt === null ? { kind: "spent" } : { kind: "at", at: retry.nextAt };
  return { attempt: `${retry.attempt} of ${retry.of}`, cause: retry.cause, next };
}
