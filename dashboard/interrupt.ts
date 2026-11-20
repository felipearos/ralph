/**
 * Stop now: end a loop mid-iteration, and write down that it happened.
 *
 * The ordinary `stop` ends a run at the next iteration boundary, and a model
 * holding a turn open can put that boundary most of an hour away. Stop now is
 * the emergency version an operator used to perform by hand, made safe and
 * recorded. The sequence, and the reason for each step:
 *
 * 1. **Address it.** A request naming a run other than the one on record is
 *    refused `needs-reconfirmation` before anything is looked at, as dispatch
 *    refuses one: the operator was looking at a supervisor that is gone.
 * 2. **Check the target** (`interrupt-adapter.ts`): the pid in the checkout's
 *    `supervisor.pid` is alive, is `ralph.sh`, works in this checkout, and
 *    leads — or its `start.sh` wrapper leads — a group that is not the
 *    dashboard's. A failed check is refused with the mismatch named, and
 *    nothing is sent.
 * 3. **Record, then signal.** Each signal's audit entry is written before the
 *    signal is sent; a signal that cannot be recorded is not sent. SIGTERM
 *    first, to the whole group, so the orchestrator and its children can end
 *    their own sessions; SIGKILL to the group only if something is still
 *    there after the grace period — a child that ignored SIGTERM included —
 *    *and* the group number is provably still the loop's: the supervisor
 *    itself, re-verified, is alive, or the adapter can show the number has
 *    not been reused since the check. Members of a group it cannot vouch
 *    for are reported, never killed: the number may name somebody else's.
 * 4. **Write down the stop** through the loop's own `controls.ts
 *    interrupted`, once the supervisor is gone: a `confirmed` stop of kind
 *    `interrupted`, carrying the iteration and the ticket. The claim is kept —
 *    a killed iteration leaves commits, uncommitted files and a claim, and
 *    releasing it would let another loop start fresh over a half-finished
 *    branch. The lease lapses on its own; Resume work or Release decides the
 *    rest (`lifecycle.ts`, `dispatch.ts`).
 *
 * The answer is always the observed one: `interrupted` only when the
 * supervisor is gone, `recorded` only when the loop's record holds the stop.
 */
import { randomUUID } from "node:crypto";

import type { StopNowRequest } from "./command-requests";
import type { InterruptSignal, InterruptTarget, StopNowResult } from "./contracts";
import type { ControlAdapter } from "./control-adapter";
import { SIGNAL_SURFACE, type InspectedTarget, type InterruptAdapter, type SignalAuditEntry } from "./interrupt-adapter";

/** How long the group gets to end on SIGTERM before SIGKILL. */
export const DEFAULT_TERM_GRACE_MS = 10_000;
/** How long SIGKILL gets before the supervisor is reported to have survived it. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_SIGNAL_POLL_MS = 200;

export interface InterruptDeps {
  interrupt: InterruptAdapter;
  control: ControlAdapter;
  /** The loop this dispatcher serves. A request naming another is not-for-this-loop. */
  loop: string;
  now?: () => Date;
  newKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
  termGraceMs?: number;
  killGraceMs?: number;
  pollIntervalMs?: number;
}

// The request shape lives in the contracts-only parser leaf, `command-requests.ts`.
export type { StopNowRequest } from "./command-requests";

const DEFAULT_WHY = "stopped now from the dashboard";

/** The failed check's detail: the mismatch, named. */
const refusalOf = (target: InspectedTarget): string =>
  target.checks.find((check) => !check.ok)?.detail ?? "the target could not be checked";

export async function stopNow(deps: InterruptDeps, request: StopNowRequest): Promise<StopNowResult> {
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pollMs = deps.pollIntervalMs ?? DEFAULT_SIGNAL_POLL_MS;
  const key = request.id ?? deps.newKey?.() ?? randomUUID();
  const why = request.why ?? DEFAULT_WHY;
  const at = new Date(nowMs()).toISOString();
  const run = deps.control.readIdentity()?.ralphRun ?? null;
  const signals: InterruptSignal[] = [];
  let target: InspectedTarget = { pidFile: "", pid: null, group: null, checks: [], ok: false };
  const aimedAt = (): InterruptTarget => ({ pidFile: target.pidFile, pid: target.pid, group: target.group });

  const answer = (fields: Pick<StopNowResult, "outcome" | "why"> & Partial<StopNowResult>): StopNowResult => ({
    loop: deps.loop,
    action: "stop-now",
    key,
    worktree: deps.interrupt.worktree,
    run,
    at,
    target: aimedAt(),
    checks: target.checks,
    signals: [...signals],
    recorded: false,
    stop: null,
    audit: SIGNAL_SURFACE.audit.path,
    ...fields,
  });
  const audit = (event: SignalAuditEntry["event"], fields: Partial<SignalAuditEntry>): string | null =>
    deps.interrupt.audit({
      id: key,
      at: new Date(nowMs()).toISOString(),
      event,
      loop: deps.loop,
      run,
      reason: why,
      target: aimedAt(),
      checks: target.checks,
      signal: null,
      outcome: null,
      detail: "",
      ...(request.via == null ? {} : { via: request.via }),
      ...fields,
    });

  if (request.loop !== deps.loop) {
    return answer({ outcome: "not-for-this-loop", why: `addressed to ${request.loop}; this is ${deps.loop}` });
  }
  const named = request.run ?? null;
  if (named !== null && run !== null && named !== run && request.reconfirm !== true) {
    const refusal = `issued against run ${named}, which ${run} replaced — nothing was signalled; re-issue it against ${run}`;
    // Nothing was looked at, but the refusal is still the operator's act, and
    // the history reads it from here — under the run the operator named.
    const failed = audit("refused", { run: named, outcome: "needs-reconfirmation", detail: refusal });
    return answer({
      outcome: "needs-reconfirmation",
      why: failed === null ? refusal : `${refusal} (and the audit file could not be written: ${failed})`,
    });
  }

  target = deps.interrupt.inspect();
  const withAuditFailure = (said: string, failed: string | null): string =>
    failed === null ? said : `${said} (and the audit file could not be written: ${failed})`;
  if (!target.ok || target.pid === null || target.group === null) {
    const refusal = `nothing was signalled: ${refusalOf(target)}`;
    return answer({ outcome: "refused", why: withAuditFailure(refusal, audit("refused", { outcome: "refused", detail: refusal })) });
  }
  const { pid, group } = target;

  /** Wait until nothing of the target is left, or the time is up; answer what is left. */
  const waitForExit = async (graceMs: number): Promise<{ supervisor: boolean; group: boolean; ours: boolean }> => {
    const deadline = nowMs() + graceMs;
    for (;;) {
      const left = deps.interrupt.remaining({ pid, group });
      if ((!left.supervisor && !left.group) || nowMs() >= deadline) return left;
      await sleep(pollMs);
    }
  };
  /** Record, then send. `null` when sent; otherwise why nothing was. */
  const send = (signal: InterruptSignal): string | null => {
    const unrecorded = audit("signal", { signal, detail: `sending ${signal} to process group ${group}` });
    if (unrecorded !== null) return `${signal} was not sent because it could not be recorded: ${unrecorded}`;
    const failed = deps.interrupt.signal(group, signal);
    if (failed === null) signals.push(signal);
    return failed;
  };

  const termFailed = send("SIGTERM");
  if (signals.length === 0) {
    const refusal = `nothing was signalled: ${termFailed}`;
    return answer({ outcome: "refused", why: withAuditFailure(refusal, audit("outcome", { outcome: "refused", detail: refusal })) });
  }
  let left = await waitForExit(deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
  if (left.supervisor || (left.group && left.ours)) {
    // A failed SIGKILL is not the end of it: what is left is read either way.
    send("SIGKILL");
    left = await waitForExit(deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  }
  if (left.supervisor) {
    const said = `pid ${pid} is still running after ${signals.join(" and ")} to process group ${group}`;
    return answer({ outcome: "survived", why: withAuditFailure(said, audit("outcome", { outcome: "survived", signal: signals.at(-1) ?? null, detail: said })) });
  }

  // The supervisor is gone. Now the loop's own record says so.
  const stragglers = !left.group
    ? ""
    : left.ours
      ? `; process group ${group} still has members after SIGKILL`
      : `; process group ${group} still has members, left running because the group number can no longer be shown to be the loop's`;
  let recorded = false;
  let stop: StopNowResult["stop"] = null;
  let said: string;
  if (run === null) {
    said = `${deps.loop} was interrupted, but no run is on record to write the stop against`;
  } else {
    const ending = await deps.control.recordInterrupt(run, deps.loop, key, why);
    if (ending.kind === "recorded" && ending.stop !== null) {
      recorded = true;
      stop = {
        kind: ending.stop.kind,
        confirmation: ending.stop.confirmation,
        iteration: ending.stop.iteration,
        issue: ending.stop.issue,
      };
      said = `${deps.loop} was interrupted${stop.iteration === null ? "" : ` in iteration ${stop.iteration}`}${stop.issue === null ? "" : `; #${stop.issue} stays claimed until it is resumed or released`}`;
    } else {
      said =
        ending.kind === "busy"
          ? `${deps.loop} was interrupted, but the stop was not recorded: a supervisor holds the loop's lock again`
          : `${deps.loop} was interrupted, but the stop was not recorded: ${ending.kind === "failed" ? ending.why : "the loop printed no stop"}`;
    }
  }
  said += `${stragglers} (${signals.join(", then ")} to process group ${group})`;
  const failed = audit("outcome", { outcome: "interrupted", signal: signals.at(-1) ?? null, detail: `${said}; recorded: ${String(recorded)}` });
  return answer({ outcome: "interrupted", why: withAuditFailure(said, failed), recorded, stop });
}
