/**
 * The unblocker chat's Fix gate and Stop & fix (#254).
 *
 * A Fix turn is code execution in a loop's checkout under the loop's own
 * executor rails, so it may only run while nothing else does: spec #251
 * decided that Fix needs a STOPPED loop. This module answers the two questions
 * that decision raises, and changes nothing in the chat itself — the routes
 * (`chat-routes.ts`) switch the mode on its answers.
 *
 * - **Is the loop stopped?** `fixGate` reads the supervisor's liveness through
 *   `lifecycle.ts`'s `readLiveness`, the same `loop-state status` read Resume
 *   work and restart make, which is `controls.ts`'s `ownerLiveness` check
 *   (`supervisorPidMatches`) seen from this side of the process boundary. Not
 *   a second liveness read: one that disagreed with Stop now's would let Fix
 *   run beside a supervisor the rest of the dashboard can see. `unknown` is
 *   closed, as it is for restart: "cannot tell" is not "stopped".
 * - **Stop it, then say when.** `stopForFix` sends the ORDINARY soft stop —
 *   `dispatch()`'s `stop`, iteration scope, the same command the Stop button
 *   sends — and waits for the supervisor to be gone, over the restart route's
 *   own window (`DEFAULT_RESTART_WAIT_MS`). Nothing is signalled: the stop is
 *   a message the supervisor obeys at its own boundary, and waiting is
 *   reading. A stop still pending at the deadline is reported as pending and
 *   nothing switches; the caller re-issues to keep waiting, and `send: false`
 *   on that re-issue is what keeps the stop to exactly one.
 */
import type { Liveness } from "./contracts";
import type { StopConfirmation } from "./control-adapter";
import { dispatch, type DispatchResult } from "./dispatch";
import { DEFAULT_RESTART_POLL_MS, DEFAULT_RESTART_WAIT_MS, readLiveness, readRecord, type LifecycleDeps } from "./lifecycle";

/**
 * What the gate and the stop run against for one loop's checkout: the same
 * control and lifecycle adapters the lifecycle routes build.
 */
export type FixFactory = (target: { loop: string; worktree: string; supervisor: Liveness }) => Omit<LifecycleDeps, "loop" | "now">;

export interface FixGate {
  /** True only for a supervisor the process table shows is gone. */
  open: boolean;
  liveness: Liveness;
  /** Why Fix is refused, in the operator's terms; empty when it is open. */
  why: string;
}

/** Whether a Fix turn may run in this loop's checkout now. */
export async function fixGate(deps: LifecycleDeps): Promise<FixGate> {
  const report = await readLiveness(deps);
  switch (report.liveness) {
    case "dead":
      return { open: true, liveness: "dead", why: "" };
    case "alive":
      return {
        open: false,
        liveness: "alive",
        why: `${deps.loop}'s supervisor is running: Fix needs a stopped loop — use Stop & fix, which stops it at the iteration boundary`,
      };
    default:
      return {
        open: false,
        liveness: report.liveness,
        why: `cannot tell whether ${deps.loop}'s supervisor is running (${report.why}), so Fix stays locked`,
      };
  }
}

export interface StopForFixRequest {
  /** The stop's idempotency key, held by the chat so a re-issue waits on the same stop. */
  key: string;
  /** False when this chat already sent its stop: wait, do not send another. */
  send: boolean;
  why?: string | null;
  /** Called once the loop has a stop to obey and the wait for its boundary begins. */
  onWaiting?: () => void;
}

/**
 * `exited` — the supervisor is gone and Fix may unlock;
 * `pending` — the window ran out before the boundary, nothing switched;
 * `refused` — the stop was not sent, or the loop recorded it refused;
 * `unknown` — liveness could not be read, so no stop was sent.
 */
export type StopForFixOutcome = "exited" | "pending" | "refused" | "unknown";

export interface StopForFixResult {
  outcome: StopForFixOutcome;
  why: string;
  /** The stop dispatch sent, or null when none was sent by this call. */
  stop: DispatchResult | null;
  /** True when this call delivered the stop; false when it was not needed or was already sent. */
  sent: boolean;
  /** The last confirmation read back for the stop, when there is one. */
  confirmation: StopConfirmation | null;
}

const STOP_WHY = "Stop & fix from the unblocker chat";

/**
 * Stop the loop at its next iteration boundary and wait for its supervisor to
 * exit, within the restart route's window.
 */
export async function stopForFix(deps: LifecycleDeps, request: StopForFixRequest): Promise<StopForFixResult> {
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = deps.waitTimeoutMs ?? DEFAULT_RESTART_WAIT_MS;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_RESTART_POLL_MS;
  const answer = (fields: Partial<StopForFixResult> & Pick<StopForFixResult, "outcome" | "why">): StopForFixResult => ({
    stop: null,
    sent: false,
    confirmation: null,
    ...fields,
  });

  const before = await readLiveness(deps);
  if (before.liveness === "dead") {
    return answer({ outcome: "exited", why: `${deps.loop}'s supervisor is not running, so no stop was needed` });
  }
  if (before.liveness === "unknown") {
    return answer({ outcome: "unknown", why: `cannot tell whether ${deps.loop}'s supervisor is running (${before.why}), so no stop was sent` });
  }

  let stop: DispatchResult | null = null;
  if (request.send) {
    stop = await dispatch(
      {
        adapter: deps.control,
        loop: deps.loop,
        supervisor: before.liveness,
        now: () => new Date(nowMs()),
        newKey: () => request.key,
      },
      {
        loop: deps.loop,
        action: "stop",
        // Whoever holds the loop now: the operator is stopping the loop the
        // chat is about, not a run they picked off a page.
        run: deps.control.readIdentity()?.ralphRun ?? null,
        why: request.why ?? STOP_WHY,
        scope: "iteration",
        id: request.key,
      },
    );
    if (stop.outcome !== "applied" && stop.outcome !== "replayed") {
      return answer({ outcome: "refused", why: `the stop was ${stop.outcome}: ${stop.why}`, stop, sent: false });
    }
  }
  const sent = request.send;
  request.onWaiting?.();

  const deadline = nowMs() + timeoutMs;
  for (;;) {
    // Liveness first, then the record, as restart reads them.
    const live = await readLiveness(deps);
    const record = await readRecord(deps);
    const entry = record?.applied.find((row) => row.key === request.key) ?? null;
    const confirmation: StopConfirmation | null = record?.stop?.key === request.key ? record.stop.confirmation : null;
    if (live.liveness === "dead") {
      return answer({ outcome: "exited", why: `${deps.loop}'s supervisor exited at the iteration boundary`, stop, sent, confirmation });
    }
    if (entry !== null && entry.outcome !== "applied") {
      return answer({ outcome: "refused", why: `the loop recorded the stop as ${entry.outcome}: ${entry.why}`, stop, sent, confirmation });
    }
    if (nowMs() >= deadline) {
      return answer({
        outcome: "pending",
        why: `the stop was still pending after ${Math.round(timeoutMs / 1000)}s — ${deps.loop}'s supervisor has not reached an iteration boundary; Stop & fix again keeps waiting on the same stop`,
        stop,
        sent,
        confirmation,
      });
    }
    await sleep(intervalMs);
  }
}
