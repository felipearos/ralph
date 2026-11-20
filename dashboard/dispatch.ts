/**
 * The command-dispatch layer: a GUI action plus a loop identity, turned into
 * one command in the loop's local inbox and a structured, recorded outcome.
 *
 * This is the single seam the operator GUI's write path is built on. The HTTP
 * handlers are thin adapters over it, and the layer itself is deliberately
 * split in two:
 *
 *   - `control-adapter.ts` below it is the only code that names the inbox, a
 *     flag, an environment variable or a JSON key. Dispatch asks it to deliver
 *     the command and to read the records back, and never names one itself.
 *   - the adapter's injected `Executor`, across the process boundary, runs
 *     the read-back subprocess and returns status/stdout/stderr. Unit tests
 *     hand it a recording façade, so nothing needs a supervisor or a real loop.
 *
 * What dispatch does NOT do is reimplement the control channel. It sends; the
 * loop's next `controls.ts poll` decides whether the command is applied,
 * refused, deferred, or refused for naming a run that has been replaced. The
 * outcome dispatch returns is read back from the loop's own record — never
 * inferred from a successful send. A command the loop has already handled comes
 * back `recorded: true`; one the channel has only accepted is the outcome
 * `applied` with `recorded: false`, and its stop is `pending` until a
 * supervisor confirms it. A delivered command is never reported as a completed
 * one.
 *
 * The one decision dispatch makes on its own is the safe one: a command naming
 * a run other than the loop's observed run is refused `needs-reconfirmation`
 * and not sent at all. Redirecting it to the current run would stop a
 * supervisor the operator never saw.
 *
 * One thing it runs on the loop's behalf: when the page reads the supervisor
 * as `dead`, nothing will ever poll the inbox — and that is exactly when
 * `retry`, `abandon` and `release` are wanted. So for those three, dispatch
 * runs the loop's own poll once, as an operator (never `--supervised`), as the
 * run on record, and with every plugin off, and reads the outcome it
 * recorded. The other commands are instructions to a supervisor and wait for
 * one. `alive` and `unknown` are left to the supervisor too: two pollers
 * racing one record is how a command gets applied twice.
 */
import { randomUUID } from "node:crypto";

import type { DispatchRequest } from "./command-requests";
import type { Liveness, StopKind } from "./contracts";
import {
  DISPATCH_ACTIONS,
  GATE_ACTIONS,
  ISSUE_ACTIONS,
  RECOVERY_ACTIONS,
  SCOPED_ACTIONS,
  isSafeCommandId,
  type RecoveryPollEnding,
  type ControlAdapter,
  type ControlRecordView,
  type ControlSendInput,
  type DispatchAction,
  type DispatchOutcome,
  type RecordedCommand,
  type StopConfirmation,
} from "./control-adapter";

/**
 * A request that cannot be answered with an outcome — not a refused command,
 * a malformed one. The HTTP layer maps it to a client error rather than a
 * recorded refusal, because there is no command to record.
 */
export class DispatchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRequestError";
  }
}

// The request shape lives in the contracts-only parser leaf, `command-requests.ts`.
export type { DispatchRequest } from "./command-requests";

export interface DispatchResult {
  loop: string;
  action: DispatchAction;
  key: string;
  /** The run named in the payload; null means "whoever holds the loop". */
  run: string | null;
  issue: number | null;
  outcome: DispatchOutcome;
  /** True when `outcome` was read from the loop's control record. */
  recorded: boolean;
  why: string;
  at: string;
  /**
   * Present for `stop` and `deny` once something exists to confirm — the
   * recorded stop, or `pending` for one this operator has sent. Never
   * `confirmed` without the record, and absent when nothing was sent.
   */
  stop: { kind: StopKind; confirmation: StopConfirmation } | null;
}

export interface DispatchDeps {
  adapter: ControlAdapter;
  /** The loop this dispatcher serves. A request naming another is not-for-this-loop. */
  loop: string;
  /**
   * The supervisor's liveness as the page read it. Only `dead` makes dispatch
   * apply the command itself; absent is treated as not known.
   */
  supervisor?: Liveness;
  now?: () => Date;
  newKey?: () => string;
}

const STOP_ACTIONS: readonly DispatchAction[] = ["stop", "deny"];

/**
 * Read the loop's control record through the adapter, as no record when the
 * read fails. An unreadable record is not a reason to refuse a command: the
 * loop may simply never have been commanded before.
 */
function readRecord(deps: DispatchDeps): Promise<ControlRecordView | null> {
  return deps.adapter.readControlRecord();
}

/**
 * Recovery polls in flight, by loop: one at a time, so two operators pressing
 * buttons together cannot race each other through one record. Module state
 * rather than a dependency on purpose: dispatch's deps are built per request,
 * and a queue that lived in them would serialize nothing.
 *
 * A supervisor is fenced by the poll itself, not by this queue: it runs under
 * the supervisor's own lock, and refuses a recorded owner that is alive (see
 * `CONTROL_SURFACE.recoveryPoll`).
 */
const recoveries = new Map<string, Promise<unknown>>();

/**
 * Apply the inbox on behalf of a supervisor that is gone. A poll that did not
 * run is not a failed command — the file is still in the inbox.
 */
async function recover(deps: DispatchDeps, run: string): Promise<RecoveryPollEnding> {
  const previous = recoveries.get(deps.loop) ?? Promise.resolve();
  const polled = previous.then((): Promise<RecoveryPollEnding> => deps.adapter.recoveryPoll(run, deps.loop));
  recoveries.set(deps.loop, polled);
  try {
    return await polled;
  } finally {
    if (recoveries.get(deps.loop) === polled) recoveries.delete(deps.loop);
  }
}

/**
 * May a recovery poll run as `run`? Only when the control record is known to
 * be that run's, or known to be absent. `readRecord` folds an unreadable
 * record into "none", which is right for classifying a command and wrong
 * here: a poll adopts whatever record is really on disk.
 */
async function recordIsRuns(deps: DispatchDeps, run: string): Promise<boolean> {
  const read = await deps.adapter.readControlStatus();
  return read.kind === "none" || (read.kind === "record" && read.record.ralphRun === run);
}

/**
 * Why a recovery command the page meant to apply itself is still waiting in
 * the inbox — `pollAs` null when it did not poll, `ending` how the poll ended.
 */
function waitingWhy(
  action: DispatchAction,
  loop: string,
  pollAs: string | null,
  ending: RecoveryPollEnding | null,
): string {
  if (ending?.kind === "busy") {
    return `${action} is waiting in the inbox: ${loop}'s supervisor lock is held — a supervisor is running or starting — so the page left it alone. That supervisor applies it at its next boundary, or refuses it if it is a new run, and the record will say which`;
  }
  const because =
    ending?.kind === "failed"
      ? `the loop's poll failed (${ending.why})`
      : pollAs === null
        ? "the loop's records do not agree on which run holds it"
        : "the loop's poll did not record it";
  return `${action} is waiting in the inbox: no supervisor is running ${loop}, and ${because}. A new run will refuse it as naming a replaced run; re-issue it then`;
}

/** The recorded command for a key, if the fence already holds it. */
const recordedFor = (
  record: ControlRecordView | null,
  key: string,
): RecordedCommand | null => record?.applied.find((entry) => entry.key === key) ?? null;

/** The deferral for a key, if the channel is still waiting on it. */
const deferredFor = (record: ControlRecordView | null, key: string) =>
  record?.deferrals.find((entry) => entry.key === key) ?? null;

/**
 * Classify a command the record already holds, before anything is sent.
 *
 * A recorded `applied` is a `replayed` command: the operator asked for
 * something the channel already did, and nothing is sent. Any other recorded
 * outcome — `refused`, `needs-reconfirmation`, `not-for-this-loop` — is
 * returned as itself, because the operator has an action to take and calling it
 * a replay would hide why.
 */
function classifyRecorded(entry: RecordedCommand): DispatchOutcome {
  return entry.outcome === "applied" ? "replayed" : entry.outcome;
}

/**
 * The stop a result carries: the recorded one when the loop wrote it, else the
 * honest `pending` for a stop this operator has sent but no supervisor has
 * confirmed. An operator poll can never confirm a termination it is not
 * carrying out, so nothing here is ever reported `confirmed`.
 */
function stopFor(
  record: ControlRecordView | null,
  key: string,
  action: DispatchAction,
  stopKind: StopKind | null | undefined,
): DispatchResult["stop"] {
  const recorded = record?.stop;
  if (recorded != null && recorded.key === key) {
    return { kind: recorded.kind, confirmation: recorded.confirmation };
  }
  if (!STOP_ACTIONS.includes(action)) return null;
  return { kind: stopKind ?? "blocked", confirmation: "pending" };
}

/**
 * Dispatch one command.
 *
 * The order is the safety order. Address it to the right loop; do not re-send
 * what the fence already holds; refuse a stale run rather than redirect it; and
 * only then send, reading the outcome back from the record.
 */
export async function dispatch(
  deps: DispatchDeps,
  request: DispatchRequest,
): Promise<DispatchResult> {
  if (!DISPATCH_ACTIONS.includes(request.action)) {
    throw new DispatchRequestError(`unknown control action '${String(request.action)}'`);
  }
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const key = request.id ?? deps.newKey?.() ?? randomUUID();
  if (!isSafeCommandId(key)) {
    throw new DispatchRequestError(
      `'id' must be letters, digits, '.', '_' or '-' (at most 128, not starting with a dot): it names the command's file`,
    );
  }
  const action = request.action;
  const issue = request.issue ?? null;
  if (ISSUE_ACTIONS.includes(action)) {
    if (issue === null) throw new DispatchRequestError(`'issue' is required: the ticket whose claim ${action} acts on`);
    if (!Number.isSafeInteger(issue) || issue <= 0) throw new DispatchRequestError("'issue' must be a positive whole number");
  } else if (issue !== null) {
    throw new DispatchRequestError(`'issue' applies only to ${ISSUE_ACTIONS.join(" and ")}`);
  }
  const scope = request.scope ?? "iteration";
  if (scope === "phase" && !SCOPED_ACTIONS.includes(action)) {
    throw new DispatchRequestError(`'scope' applies only to ${SCOPED_ACTIONS.join(" and ")}`);
  }
  const phase = request.phase ?? null;
  if (GATE_ACTIONS.includes(action)) {
    if (phase === null) throw new DispatchRequestError(`'phase' is required: the phase ${action} names`);
  } else if (phase !== null) {
    throw new DispatchRequestError(`'phase' applies only to ${GATE_ACTIONS.join(" and ")}`);
  }
  // A phase retry is applied only while the loop is held at a phase boundary,
  // and a gate command is not scoped: the loop's next poll of either kind applies it.
  const boundary = scope === "phase" || action === "retry-phase" || phase !== null ? "phase" : "iteration";
  const base = { loop: deps.loop, action, key, issue, at };

  if (request.loop !== deps.loop) {
    return {
      ...base,
      run: request.run ?? null,
      outcome: "not-for-this-loop",
      recorded: false,
      why: `addressed to ${request.loop}; this is ${deps.loop}`,
      stop: null,
    };
  }

  const record = await readRecord(deps);
  const alreadyRecorded = recordedFor(record, key);
  if (alreadyRecorded !== null) {
    // The fence already holds this exact command. A recorded success is a
    // replay of something already done; a recorded refusal keeps its reason.
    return {
      ...base,
      run: request.run ?? null,
      outcome: classifyRecorded(alreadyRecorded),
      recorded: true,
      why: alreadyRecorded.why,
      stop: stopFor(record, key, action, request.stopKind),
    };
  }
  const deferred = deferredFor(record, key);
  if (deferred !== null) {
    return {
      ...base,
      run: request.run ?? null,
      outcome: "deferred",
      recorded: true,
      why: `${deferred.command} has been waiting since ${deferred.since} (attempt ${deferred.attempts})`,
      stop: stopFor(record, key, action, request.stopKind),
    };
  }

  const identity = deps.adapter.readIdentity();
  // The durable loop state first, then the control record's own run: both are
  // the loop's record of what it observed, and either alone is enough to judge
  // a named run against.
  const observedRun = identity?.ralphRun ?? record?.ralphRun ?? null;
  const namedRun = request.run ?? null;

  if (namedRun !== null && observedRun !== null && namedRun !== observedRun && !request.reconfirm) {
    // Refused, not redirected: the run the operator named is not the run that
    // holds the loop now, and sending it on would stop a supervisor they never
    // saw. Nothing is sent, so there is nothing to confirm.
    return {
      ...base,
      run: namedRun,
      outcome: "needs-reconfirmation",
      recorded: false,
      why: `issued against run ${namedRun}, which ${observedRun} replaced — re-issue it against ${observedRun}, or send it again with "reconfirm": true`,
      stop: null,
    };
  }

  const input: ControlSendInput = {
    loop: deps.loop,
    command: action,
    key,
    run: namedRun,
    why: request.why ?? null,
    stopKind: action === "stop" ? (request.stopKind ?? "blocked") : null,
    issue,
    reconfirm: request.reconfirm === true,
    ...(scope === "phase" ? { scope } : {}),
    ...(phase === null ? {} : { phase }),
    issuedAt: at,
    ...(request.via == null ? {} : { via: request.via }),
  };
  const delivered = deps.adapter.deliver(input);
  if (!delivered.accepted) {
    return {
      ...base,
      run: namedRun,
      outcome: "refused",
      recorded: false,
      why: delivered.why,
      stop: null,
    };
  }

  // Nobody else will read the inbox: apply it now, as the run on record. Only
  // as the run the control record already belongs to — or with no record yet
  // — because a poll as any other run adopts the record, and adopting it back
  // from a newer run would drop that run's confirmed stop.
  const unattended = deps.supervisor === "dead" && (RECOVERY_ACTIONS as readonly DispatchAction[]).includes(action);
  const pollAs =
    unattended && observedRun !== null && (await recordIsRuns(deps, observedRun)) ? observedRun : null;
  const pollEnding = pollAs === null ? null : await recover(deps, pollAs);

  // Read back. A command the loop has already polled is reported with its real
  // outcome and confirmation; one it has not is reported as accepted — the
  // channel took it, and whether the loop applied it is the `recorded` flag,
  // never a claim that a pending stop has happened.
  const after = await readRecord(deps);
  const entry = recordedFor(after, key);
  if (entry !== null) {
    return {
      ...base,
      run: namedRun,
      outcome: entry.outcome,
      recorded: true,
      why: entry.why,
      stop: stopFor(after, key, action, request.stopKind),
    };
  }
  const late = deferredFor(after, key);
  if (late !== null) {
    return {
      ...base,
      run: namedRun,
      outcome: "deferred",
      recorded: true,
      why: `${late.command} has been waiting since ${late.since}`,
      stop: stopFor(after, key, action, request.stopKind),
    };
  }
  return {
    ...base,
    run: namedRun,
    outcome: "applied",
    recorded: false,
    why: unattended
      ? waitingWhy(action, deps.loop, pollAs, pollEnding)
      : namedRun === null
        ? `${action} queued for whoever holds ${deps.loop}; it applies at the next ${boundary} boundary`
        : `${action} queued for ${namedRun}; it applies at the next ${boundary} boundary`,
    stop: stopFor(after, key, action, request.stopKind),
  };
}
