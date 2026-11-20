/**
 * Lifecycle dispatch: `start`, `restart-to-apply` and `resume-work`, over the lifecycle and control adapters.
 *
 * The other half of the command-dispatch layer. `dispatch.ts` sends the
 * controls a running loop reads at its next boundary; this module starts a
 * loop, and restarts one so a model-lineup edit takes effect — the lineup is
 * resolved only at supervisor startup, so an edit does nothing until the
 * supervisor is replaced.
 *
 * It names and runs no command. `lifecycle-adapter.ts` runs `start.sh`, the
 * liveness read and the checkout report's git reads; `control-adapter.ts` runs
 * the control record read; the stop itself goes through `dispatch()` unchanged, so
 * addressing, replay and the refusal of a replaced run are the #12 layer's and
 * are not re-told here.
 *
 * Three properties carry restart, and each is a way to end up with two
 * supervisors in one worktree or with lost work:
 *
 * 1. **Start only after a confirmed stop and a gone supervisor.** Both, read
 *    back from the records: `confirmed` is the supervisor saying it read the
 *    stop and is exiting, and the liveness read is the process table agreeing
 *    it has. A send is not a stop, and a confirmed stop whose supervisor is
 *    still finishing is not an empty worktree.
 * 2. **An unconfirmed stop halts the sequence.** `unreachable` halts at once;
 *    `pending` halts at the deadline, or as soon as the supervisor is gone
 *    without confirming. Starting then would either race a supervisor nobody
 *    can see, or hand the new one a stop it adopts and exits on.
 * 3. **The worktree is reported, never repaired.** A dirty or mid-ticket
 *    checkout is described in the result; commits, claims and uncommitted
 *    files stay where the old supervisor left them for the new one to recover.
 *
 * No process is signalled. The stop is a message the supervisor obeys at its
 * own iteration boundary, and waiting is reading.
 *
 * `resume-work` is the way back from a Stop now (`interrupt.ts`): start the
 * loop again in the same worktree, telling the supervisor to leave HEAD where
 * the interrupted iteration left it, so the new run picks up the branch and
 * reconnects the claim instead of starting over from the base branch. It
 * starts only over a gone supervisor and a confirmed `interrupted` stop on the
 * record: an unconfirmed stop would be adopted by the new supervisor, as for
 * restart, and any other ending is an ordinary Start's.
 */
import { randomUUID } from "node:crypto";

import type { RestartRequest, ResumeWorkRequest, StartRequest } from "./command-requests";
import type { ControlAdapter, ControlRecordView, StopConfirmation } from "./control-adapter";
import { dispatch, type DispatchResult } from "./dispatch";
import type { CheckoutReport, LifecycleAdapter, StartOutcome, StartReport, SupervisorReport } from "./lifecycle-adapter";

export const LIFECYCLE_ACTIONS = ["start", "restart-to-apply", "resume-work"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Why a restart stopped short of starting. */
export const RESTART_HALTS = [
  "stop-refused",
  "stop-unreachable",
  "stop-pending",
  "supervisor-running",
  "supervisor-unknown",
] as const;
export type RestartHalt = (typeof RESTART_HALTS)[number];

/** How long restart waits for the boundary by default. Re-issue with the same id to keep waiting. */
export const DEFAULT_RESTART_WAIT_MS = 120_000;
export const DEFAULT_RESTART_POLL_MS = 2_000;

export interface LifecycleDeps {
  control: ControlAdapter;
  lifecycle: LifecycleAdapter;
  /** The loop this dispatcher serves. A request naming another is not-for-this-loop. */
  loop: string;
  now?: () => Date;
  newKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

// The request shapes live in the contracts-only parser leaf, `command-requests.ts`.
export type { RestartRequest, ResumeWorkRequest, StartRequest } from "./command-requests";

export interface StartResult {
  loop: string;
  action: "start";
  worktree: string;
  outcome: StartOutcome | "refused" | "not-for-this-loop";
  pid: number | null;
  why: string;
  at: string;
}

export interface ResumeWorkResult {
  loop: string;
  action: "resume-work";
  worktree: string;
  /** `refused` started nothing; `why` says what stood in the way. */
  outcome: StartOutcome | "refused" | "not-for-this-loop";
  pid: number | null;
  why: string;
  at: string;
  /** What the resumed run picks up: the branch, uncommitted changes, unpushed commits, claims. */
  checkout: CheckoutReport | null;
}

export interface RestartResult {
  loop: string;
  action: "restart-to-apply";
  key: string;
  worktree: string;
  /** `halted` means nothing was started; `halt` says why. */
  outcome: StartOutcome | "halted" | "not-for-this-loop";
  halt: RestartHalt | null;
  why: string;
  at: string;
  /** The stop dispatch sent, or null when none was needed or none was sent. */
  stop: DispatchResult | null;
  /** The last confirmation read back for this restart's stop, or an older one that halted it. */
  confirmation: StopConfirmation | null;
  start: StartReport | null;
  checkout: CheckoutReport | null;
}

/** The loop's control record, or null when it cannot be read. Stop & fix (`chat-fix.ts`) reads it too. */
export const readRecord = (deps: Pick<LifecycleDeps, "control">): Promise<ControlRecordView | null> =>
  deps.control.readControlRecord();

/**
 * The supervisor's liveness: `loop-state status --json`, whose per-worktree
 * answer is `supervisorPidMatches` — the process-table check `controls.ts`
 * `ownerLiveness` makes. The unblocker chat's Fix gate (`chat-fix.ts`) reads
 * this one rather than a second.
 */
export const readLiveness = (deps: Pick<LifecycleDeps, "lifecycle">): Promise<SupervisorReport> =>
  deps.lifecycle.supervisor();

/**
 * What a restart would leave in the worktree, read on its own so the operator
 * sees the warning before confirming one. Read-only, like the report every
 * restart result carries.
 */
export const readCheckout = (deps: Pick<LifecycleDeps, "lifecycle">): Promise<CheckoutReport> =>
  deps.lifecycle.checkout();

/** What the restart left in place, said once so every answer carries it. */
function checkoutNote(checkout: CheckoutReport): string {
  const parts: string[] = [];
  if (!checkout.readable) parts.push("git status could not be read");
  if (checkout.dirty) parts.push(`${checkout.changes.length} uncommitted change(s)`);
  if (checkout.midTicket) {
    parts.push(`mid-ticket on ${checkout.claims.map((claim) => `#${claim.issue}`).join(", ")}`);
  }
  return parts.length === 0 ? "" : ` (worktree left as it is: ${parts.join("; ")})`;
}

/** Start the loop through `start.sh`, reporting its worktree lock's answer. */
export async function start(deps: LifecycleDeps, request: StartRequest): Promise<StartResult> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const base = { loop: deps.loop, action: "start" as const, worktree: deps.lifecycle.worktree, at };
  if (request.loop !== deps.loop) {
    return {
      ...base,
      outcome: "not-for-this-loop",
      pid: null,
      why: `addressed to ${request.loop}; this is ${deps.loop}`,
    };
  }
  const report = await deps.lifecycle.start();
  return { ...base, outcome: report.outcome, pid: report.pid, why: report.why };
}

/**
 * Start the loop again over the work an interrupted run left in its worktree.
 *
 * Refused, with nothing started, while a supervisor is alive or its liveness
 * cannot be seen, and while the record holds a stop nobody confirmed — a new
 * supervisor adopts one of those and exits on it. The checkout report is read
 * first so the answer says what the new run picks up.
 */
export async function resumeWork(deps: LifecycleDeps, request: ResumeWorkRequest): Promise<ResumeWorkResult> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const base = { loop: deps.loop, action: "resume-work" as const, worktree: deps.lifecycle.worktree, at };
  if (request.loop !== deps.loop) {
    return { ...base, outcome: "not-for-this-loop", pid: null, why: `addressed to ${request.loop}; this is ${deps.loop}`, checkout: null };
  }
  const checkout = await readCheckout(deps);
  const refused = (why: string): ResumeWorkResult => ({ ...base, outcome: "refused", pid: null, why, checkout });

  const liveness = await readLiveness(deps);
  if (liveness.liveness === "alive") return refused(`${deps.loop}'s supervisor is running; there is nothing to resume`);
  if (liveness.liveness === "unknown") {
    return refused(`cannot tell whether ${deps.loop}'s supervisor is running (${liveness.why}), so nothing was started`);
  }
  const stop = (await readRecord(deps))?.stop ?? null;
  if (stop !== null && stop.confirmation !== "confirmed") {
    return refused(
      `an earlier ${stop.kind} stop is still ${stop.confirmation} on ${deps.loop}'s record — a new supervisor would adopt it and exit`,
    );
  }
  // Keeping HEAD is for work a Stop now cut short. After any other ending the
  // supervisor's own freshness rules apply, and that is a plain Start.
  if (stop?.kind !== "interrupted") {
    return refused(`${deps.loop} was not stopped now, so there is no interrupted work to resume; use Start`);
  }
  const report = await deps.lifecycle.start({ resume: { issue: stop.issue } });
  return { ...base, outcome: report.outcome, pid: report.pid, why: `${report.why}${checkoutNote(checkout)}`, checkout };
}

/**
 * Stop the loop at its next iteration boundary, wait for the stop to be
 * confirmed and the supervisor gone, and only then start it again.
 */
export async function restartToApply(deps: LifecycleDeps, request: RestartRequest): Promise<RestartResult> {
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = deps.waitTimeoutMs ?? DEFAULT_RESTART_WAIT_MS;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_RESTART_POLL_MS;
  const key = request.id ?? deps.newKey?.() ?? randomUUID();
  const at = new Date(nowMs()).toISOString();
  const base = {
    loop: deps.loop,
    action: "restart-to-apply" as const,
    key,
    worktree: deps.lifecycle.worktree,
    at,
  };

  if (request.loop !== deps.loop) {
    return {
      ...base,
      outcome: "not-for-this-loop",
      halt: null,
      why: `addressed to ${request.loop}; this is ${deps.loop}`,
      stop: null,
      confirmation: null,
      start: null,
      checkout: null,
    };
  }

  const checkout = await readCheckout(deps);
  const note = checkoutNote(checkout);
  const answer = (fields: Partial<RestartResult> & Pick<RestartResult, "outcome" | "why">): RestartResult => ({
    ...base,
    halt: null,
    stop: null,
    confirmation: null,
    start: null,
    checkout,
    ...fields,
    why: `${fields.why}${note}`,
  });
  const halted = (halt: RestartHalt, why: string, fields: Partial<RestartResult> = {}): RestartResult =>
    answer({ ...fields, outcome: "halted", halt, why: `${why}; nothing was started` });
  const started = async (why: string, fields: Partial<RestartResult> = {}): Promise<RestartResult> => {
    const report = await deps.lifecycle.start();
    return answer({ ...fields, outcome: report.outcome, start: report, why: `${why} — ${report.why}` });
  };

  const before = await readLiveness(deps);
  if (before.liveness === "unknown") {
    return halted("supervisor-unknown", `cannot tell whether ${deps.loop}'s supervisor is running (${before.why}), so no stop was sent`);
  }

  if (before.liveness === "dead") {
    // Nothing to stop. But a stop left unconfirmed on the record is adopted by
    // the next supervisor, which would exit on it at its first checkpoint.
    const old = (await readRecord(deps))?.stop ?? null;
    if (old !== null && old.confirmation !== "confirmed") {
      return halted(
        old.confirmation === "unreachable" ? "stop-unreachable" : "stop-pending",
        `an earlier ${old.kind} stop is still ${old.confirmation} on ${deps.loop}'s record — a new supervisor would adopt it and exit`,
        { confirmation: old.confirmation },
      );
    }
    return started(`${deps.loop}'s supervisor was not running, so no stop was needed`);
  }

  const stop = await dispatch(
    { adapter: deps.control, loop: deps.loop, now: () => new Date(nowMs()), newKey: () => key },
    {
      loop: deps.loop,
      action: "stop",
      run: request.run ?? deps.control.readIdentity()?.ralphRun ?? null,
      why: request.why ?? "restart to apply a model-lineup edit",
      stopKind: request.stopKind ?? "blocked",
      reconfirm: request.reconfirm === true,
      id: key,
      ...(request.via == null ? {} : { via: request.via }),
    },
  );
  if (stop.outcome !== "applied" && stop.outcome !== "replayed") {
    return halted("stop-refused", `the stop was ${stop.outcome}: ${stop.why}`, { stop });
  }

  const deadline = nowMs() + timeoutMs;
  for (;;) {
    // Liveness first, then the record: a supervisor writes its confirmation
    // before it exits, so a record read after a "dead" answer cannot miss one.
    const live = await readLiveness(deps);
    const record = await readRecord(deps);
    const entry = record?.applied.find((row) => row.key === key) ?? null;
    if (entry !== null && entry.outcome !== "applied") {
      return halted("stop-refused", `the loop recorded the stop as ${entry.outcome}: ${entry.why}`, { stop });
    }
    const recorded = record?.stop?.key === key ? record.stop : null;
    const confirmation: StopConfirmation = recorded?.confirmation ?? "pending";

    if (confirmation === "unreachable") {
      return halted(
        "stop-unreachable",
        `the stop was recorded unreachable — no supervisor confirmed it, and one may still be running where it cannot be seen`,
        { stop, confirmation },
      );
    }
    if (confirmation === "confirmed" && live.liveness === "dead") {
      return started(`${deps.loop}'s supervisor confirmed the stop and exited`, { stop, confirmation });
    }
    if (confirmation === "pending" && live.liveness === "dead") {
      return halted(
        "stop-pending",
        `${deps.loop}'s supervisor is gone but the stop is still pending — a new supervisor would read it and exit`,
        { stop, confirmation },
      );
    }
    if (nowMs() >= deadline) {
      const waited = `${Math.round(timeoutMs / 1000)}s`;
      if (confirmation === "confirmed") {
        return live.liveness === "unknown"
          ? halted("supervisor-unknown", `the stop was confirmed but whether the supervisor exited cannot be seen (${live.why}) after ${waited}`, { stop, confirmation })
          : halted("supervisor-running", `the stop was confirmed but the supervisor was still running after ${waited}; re-issue restart with id ${key} to keep waiting`, { stop, confirmation });
      }
      return halted(
        "stop-pending",
        `the stop was still pending after ${waited} — the supervisor has not reached an iteration boundary; re-issue restart with id ${key} to keep waiting`,
        { stop, confirmation },
      );
    }
    await sleep(intervalMs);
  }
}
