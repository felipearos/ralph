/**
 * The write side of the runtime adapter: the loop's local command inbox.
 *
 * `adapter.ts` owns the read-only commands the dashboard observes with. This
 * module is its sibling for the other direction — handing an operator's
 * command to a loop — and the only code on this side of the process boundary
 * that names the inbox path, the command file's JSON shape, the
 * `controls.ts` read-back, or the JSON shapes of the durable records
 * dispatch consults.
 *
 * A command is delivered as one file in the loop's own worktree,
 * `.ralph/control/inbox/<id>.json`, which the loop's control poller reads at
 * its next iteration boundary (see `ralph/control-inbox.ts` for the format and
 * the settle-after-record rule). It used to be a message on an external
 * orchestrator's mailbox, and that made every button on the page depend on a
 * bound consumer terminal the dashboard could neither see nor repair. The file
 * needs nothing but the disk the loop is already writing to.
 *
 * Dispatch above it builds nothing and spawns nothing: it asks this module to
 * deliver a command or to read the record back. The adapter owns the injected
 * `Executor`, guarded so no read ever rejects, and parses what came back.
 *
 * Nothing here imports a ralph TypeScript module. The records are read as
 * files and narrowed field by field; the CLI is spawned by absolute script
 * path. `controls.ts` prints `null` when the loop has no control record
 * yet, and that is a value this module returns rather than an error.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ADAPTER_ENV, defaultBunPath, isRecord } from "./adapter";
import { isSafeCommandId, type ControlScope, type DispatchAction } from "./command-requests";
import { PHASES, STOP_KINDS, type Env, type Phase, type StopKind } from "./contracts";
import { guarded, type ExecResult, type Executor, type Invocation } from "./executor";

// The dispatch vocabulary lives in the contracts-only parser leaf, `command-requests.ts`.
export { DISPATCH_ACTIONS, SCOPED_ACTIONS, isSafeCommandId } from "./command-requests";
export type { ControlScope, DispatchAction } from "./command-requests";
// The executor port moved to its own leaf; re-exported so every importer of it here keeps working.
export { createProcessExecutor, guarded } from "./executor";
export type { ExecResult, Executor, Invocation } from "./executor";

const phaseOf = (value: unknown): Phase | null =>
  typeof value === "string" && (PHASES as readonly string[]).includes(value) ? (value as Phase) : null;

/** The two actions that name a phase: which gate to arm or disarm. */
export const GATE_ACTIONS: readonly DispatchAction[] = ["arm-gate", "disarm-gate"];

/** The two actions that name a ticket: which claim to take back or give up. */
export const ISSUE_ACTIONS: readonly DispatchAction[] = ["abandon", "release"];

/** The recovery actions: the only ones the recovery poll below applies. */
export const RECOVERY_ACTIONS = ["retry", "abandon", "release"] as const satisfies readonly DispatchAction[];

/**
 * The control command surface — the write half, and a closed list.
 *
 * `inbox` is where a command file is written, relative to the loop's checkout;
 * the bun script is the durable record read back. `recoveryPoll` is the loop's
 * own poll, run on behalf of a supervisor that is gone: nothing else would
 * ever read the inbox then, and a dead supervisor is exactly when `abandon`
 * and `release` are needed. It is an operator's poll — never `--supervised`,
 * so it cannot confirm a stop it is not carrying out — with every plugin off,
 * so the page never reaches a plugin through it, and `--only` the recovery
 * actions, so a pause or stop left for the next supervisor stays its to apply.
 * It runs under `lock`, the lock `start.sh` takes and its wrapper holds for
 * the supervisor's life, so a supervisor that started after the page's
 * liveness read — the read can be a moment stale, the lock cannot — is found
 * rather than raced, and none can start mid-poll. `busy` is the status for
 * "a supervisor holds it", from the lock or from the poll's own check of the
 * recorded owner. Otherwise its exit status is one of three verdicts,
 * `verdicts`; any other is a fault.
 *
 * `interruptRecord` is how a Stop now writes down what it did, once its
 * signal has ended the supervisor: the loop's own `controls.ts interrupted`,
 * as the run on record, under the same lock and with every plugin off. It
 * records the stop `confirmed` with kind `interrupted` and refuses with `busy`
 * while a supervisor is alive, so it can never describe a loop that is
 * still running.
 * The set is asserted by a test so a write implemented anywhere else is a
 * deliberate deletion, not a drift.
 */
export const CONTROL_SURFACE = {
  inbox: { dir: ".ralph/control", path: ".ralph/control/inbox" },
  controlStatus: { script: "controls.ts", args: ["status", "--json"] },
  recoveryPoll: {
    script: "controls.ts",
    args: ["poll", "--only", RECOVERY_ACTIONS.join(",")],
    lock: { command: "flock", path: ".ralph/logs/supervisor.lock" },
    busy: 75,
    verdicts: [0, 10, 20],
    env: { plugins: "RALPH_PLUGINS", run: "RALPH_RUN_ID", loop: "RALPH_LOOP_NAME" },
  },
  interruptRecord: {
    script: "controls.ts",
    args: ["interrupted"],
    flags: { key: "--key", why: "--why" },
    lock: { command: "flock", path: ".ralph/logs/supervisor.lock" },
    busy: 75,
    env: { plugins: "RALPH_PLUGINS", run: "RALPH_RUN_ID", loop: "RALPH_LOOP_NAME" },
  },
} as const;

/** The durable records dispatch resolves the loop's observed identity from. */
export const STATE_RELATIVE_PATH = ".ralph/logs/state.json";

/** The outcome vocabulary, mirroring the control record's own. */
export const DISPATCH_OUTCOMES = [
  "applied",
  "refused",
  "replayed",
  "needs-reconfirmation",
  "not-for-this-loop",
  "deferred",
] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const STOP_CONFIRMATIONS = ["confirmed", "unreachable", "pending"] as const;
export type StopConfirmation = (typeof STOP_CONFIRMATIONS)[number];

/** The loop's currently observed identity, from its durable records. */
export interface ObservedIdentity {
  loop: string;
  /** The Ralph run the loop observed last, the run a command is addressed to. */
  ralphRun: string | null;
  worktree: string;
}

export interface RecordedCommand {
  key: string;
  command: string;
  outcome: Exclude<DispatchOutcome, "deferred">;
  at: string;
  why: string;
}

export interface RecordedDeferral {
  key: string;
  command: string;
  since: string;
  attempts: number;
}

export interface RecordedHold {
  kind: "pause" | "approval";
  why: string;
  since: string;
  gate: string | null;
  /** For a hold at a phase boundary: the phase it is held before. */
  phase?: Phase;
  /** For a hold at a phase boundary: the phase just finished. */
  after?: Phase;
}

export interface RecordedStop {
  kind: StopKind;
  confirmation: StopConfirmation;
  why: string;
  at: string;
  key: string | null;
  /** For an `interrupted` stop: the iteration it cut short, and the ticket still claimed. */
  iteration: number | null;
  issue: number | null;
  /** For a stop carried out at a phase boundary: the phase it stopped before. */
  phase?: Phase;
}

/** A gate armed before a named phase. */
export interface RecordedGate {
  phase: Phase;
  since: string;
  why: string | null;
}

/** The parts of `controls status --json` dispatch needs, and no more. */
export interface ControlRecordView {
  ralphRun: string;
  loop: string;
  hold: RecordedHold | null;
  /** The armed gates; a gate naming no known phase is dropped. */
  gates: RecordedGate[];
  stop: RecordedStop | null;
  applied: RecordedCommand[];
  deferrals: RecordedDeferral[];
}

export interface ControlSendInput {
  loop: string;
  command: DispatchAction;
  key: string;
  /** The Ralph run to address, or null for "whoever holds the loop". */
  run: string | null;
  why: string | null;
  stopKind: StopKind | null;
  /** The ticket `abandon` and `release` act on; null for every other command. */
  issue: number | null;
  reconfirm: boolean;
  /** Where a pause or stop applies; only `phase` is written, `iteration` is the default. */
  scope?: ControlScope;
  /** The phase `arm-gate` and `disarm-gate` name. */
  phase?: Phase;
  /** When the operator issued it, kept in the file for whoever reads it later. */
  issuedAt: string;
  /** Who wrote it when it was not the local operator (`"remote"` for a relayed command). */
  via?: string;
}

/**
 * The control surface one loop's checkout offers. Every read and run here
 * RESOLVES to its failure answer rather than rejecting: dispatch's per-loop
 * recovery queue and Stop now carry no catch of their own and rely on it.
 */
export interface ControlAdapter {
  /** Read the loop's observed identity from its durable records. */
  readIdentity(): ObservedIdentity | null;
  /** Write one command into the loop's inbox: did it land? */
  deliver(input: ControlSendInput): { accepted: boolean; why: string };
  /** Read `controls status --json`: the record, or null when there is none or it is unreadable. */
  readControlRecord(): Promise<ControlRecordView | null>;
  /** Read `controls status --json` with its three honest answers, read-only. */
  readControlStatus(): Promise<ControlStatusRead>;
  /** Run the operator's poll that applies the inbox as `run`, with every plugin off. */
  recoveryPoll(run: string, loop: string): Promise<RecoveryPollEnding>;
  /** Run the loop's own record of a Stop now, as `run`, with every plugin off. */
  recordInterrupt(run: string, loop: string, key: string, why: string): Promise<InterruptRecordEnding>;
}

export interface ControlAdapterConfig {
  /** Absolute directory holding the ralph CLI scripts. */
  cliDir: string;
  /** The configured repo/checkout root a command is anchored at. */
  root: string;
  bunPath?: string;
  env?: Env;
  /** Runs every read-back; wrapped in `guarded` so a throw is a failed read, never a rejection. */
  exec: Executor;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const integer = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? (value as number) : null;

const readJsonObject = (path: string): Record<string, unknown> | null => {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Read a loop's observed identity from its durable loop state.
 *
 * The state is the loop's own record of what it observed. It can be missing —
 * a loop that has not started — and a missing record is `null`, never a
 * guessed run.
 */
export function readObservedIdentity(root: string): ObservedIdentity | null {
  const state = readJsonObject(join(root, STATE_RELATIVE_PATH));
  if (state?.version !== 1) return null;
  return {
    loop: (isRecord(state.owner) ? text(state.owner.loop) : null) ?? "ralph",
    ralphRun: text(state.run),
    worktree: text(state.worktree) ?? resolve(root),
  };
}

/** Narrow a recorded stop, or null for one of a kind or confirmation this dashboard does not know. */
function narrowStop(value: unknown): RecordedStop | null {
  if (!isRecord(value)) return null;
  const kind = text(value.kind);
  const confirmation = text(value.confirmation);
  if (kind === null || !(STOP_KINDS as readonly string[]).includes(kind)) return null;
  if (confirmation === null || !(STOP_CONFIRMATIONS as readonly string[]).includes(confirmation)) return null;
  return {
    kind: kind as StopKind,
    confirmation: confirmation as StopConfirmation,
    why: text(value.why) ?? "stopped",
    at: text(value.at) ?? "",
    key: text(value.key),
    iteration: integer(value.iteration),
    issue: integer(value.issue),
    ...(phaseOf(value.phase) === null ? {} : { phase: phaseOf(value.phase)! }),
  };
}

/**
 * Parse `controls status --json`.
 *
 * A loop with no record prints `null`; a record of another version is not this
 * dashboard's to read. Both return null rather than throwing: the control
 * channel's absence is a normal state, and a reader that failed on it would
 * take the write path down with it.
 */
export function parseControlRecord(stdout: string): ControlRecordView | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;
  const ralphRun = text(value.ralphRun);
  if (ralphRun === null) return null;

  const applied: RecordedCommand[] = Array.isArray(value.applied)
    ? value.applied
        .filter(isRecord)
        .map((row): RecordedCommand | null => {
          const key = text(row.key);
          const outcome = text(row.outcome);
          if (
            key === null ||
            outcome === null ||
            !(DISPATCH_OUTCOMES as readonly string[]).includes(outcome) ||
            outcome === "deferred"
          ) {
            return null;
          }
          return {
            key,
            command: text(row.command) ?? "",
            outcome: outcome as Exclude<DispatchOutcome, "deferred">,
            at: text(row.at) ?? "",
            why: text(row.why) ?? "",
          };
        })
        .filter((row): row is RecordedCommand => row !== null)
    : [];

  const deferrals: RecordedDeferral[] = Array.isArray(value.deferrals)
    ? value.deferrals
        .filter(isRecord)
        .map((row): RecordedDeferral | null => {
          const key = text(row.key);
          if (key === null) return null;
          return {
            key,
            command: text(row.command) ?? "",
            since: text(row.since) ?? "",
            attempts: integer(row.attempts) ?? 1,
          };
        })
        .filter((row): row is RecordedDeferral => row !== null)
    : [];

  const hold: RecordedHold | null = ((): RecordedHold | null => {
    if (!isRecord(value.hold)) return null;
    const kind = value.hold.kind;
    if (kind !== "pause" && kind !== "approval") return null;
    const phase = phaseOf(value.hold.phase);
    const after = phaseOf(value.hold.after);
    return {
      kind,
      why: text(value.hold.why) ?? "held",
      since: text(value.hold.since) ?? "",
      gate: text(value.hold.gate),
      ...(phase === null ? {} : { phase }),
      ...(after === null ? {} : { after }),
    };
  })();

  const gates: RecordedGate[] = Array.isArray(value.gates)
    ? value.gates
        .filter(isRecord)
        .map((row): RecordedGate | null => {
          const phase = phaseOf(row.phase);
          return phase === null ? null : { phase, since: text(row.since) ?? "", why: text(row.why) };
        })
        .filter((row): row is RecordedGate => row !== null)
    : [];

  return {
    ralphRun,
    loop: text(value.loop) ?? "ralph",
    hold,
    gates,
    stop: narrowStop(value.stop),
    applied,
    deferrals,
  };
}

/** The control channel's degraded window, as the record holds it. */
export interface RecordedDegraded {
  why: string;
  at: string;
  retryAt: string;
}

/**
 * A command the channel deferred until it gave up on it. The channel records
 * it as `refused`, with the attempts and the remedy written into its why.
 */
export interface RecordedGiveUp {
  key: string;
  command: string;
  at: string;
  attempts: number;
  remedy: string;
}

/**
 * The control record as the read-only control view needs it: dispatch's view,
 * plus the degraded window, the question an approval hold is waiting on, and
 * the commands the channel gave up on.
 */
export interface ControlStatusView extends ControlRecordView {
  degraded: RecordedDegraded | null;
  /** The decision gate's question, when an approval hold names one. */
  gateQuestion: string | null;
  givenUp: RecordedGiveUp[];
}

/**
 * One read of `controls status --json`, with its three honest answers:
 * the loop has no record yet (`null`), a record, or nothing readable at all —
 * a CLI that failed or printed something that is not a version 1 record. The
 * last is a degraded control channel, never a reason to fail a response.
 */
export type ControlStatusRead =
  | { kind: "none" }
  | { kind: "record"; record: ControlStatusView }
  | { kind: "unreadable"; why: string };

/** How `controls.ts` words a deferral it has given up on. */
const GIVEN_UP = /has been given up after (\d+) attempts/;

/** Parse the result of `controls status --json`, read-only. */
export function parseControlStatus(result: ExecResult): ControlStatusRead {
  if (result.status !== 0) {
    return {
      kind: "unreadable",
      why: result.stderr.trim() || `controls status exited ${String(result.status)}`,
    };
  }
  const stdout = result.stdout.trim();
  if (stdout === "null") return { kind: "none" };
  const record = parseControlRecord(stdout);
  if (record === null) {
    return { kind: "unreadable", why: "controls status did not print a version 1 control record" };
  }
  // `parseControlRecord` already proved this is a JSON object.
  const value = JSON.parse(stdout) as Record<string, unknown>;

  const degraded = ((): RecordedDegraded | null => {
    if (!isRecord(value.degraded)) return null;
    const why = text(value.degraded.why);
    const retryAt = text(value.degraded.retryAt);
    if (why === null || retryAt === null) return null;
    return { why, at: text(value.degraded.at) ?? retryAt, retryAt };
  })();

  // A gate hold's why is `decision gate <id>: <question>`.
  const hold = record.hold;
  const gatePrefix = hold?.kind === "approval" && hold.gate !== null ? `decision gate ${hold.gate}: ` : null;
  const gateQuestion =
    hold !== null && gatePrefix !== null && hold.why.startsWith(gatePrefix)
      ? hold.why.slice(gatePrefix.length)
      : null;

  const givenUp = record.applied
    .filter((entry) => entry.outcome === "refused")
    .map((entry): RecordedGiveUp | null => {
      const attempts = GIVEN_UP.exec(entry.why)?.[1];
      if (attempts === undefined) return null;
      return {
        key: entry.key,
        command: entry.command,
        at: entry.at,
        attempts: Number(attempts),
        remedy: entry.why,
      };
    })
    .filter((entry): entry is RecordedGiveUp => entry !== null);

  return { kind: "record", record: { ...record, degraded, gateQuestion, givenUp } };
}

/**
 * Write one command file into the loop's inbox, atomically.
 *
 * Written to a dotted temp name in the inbox itself and renamed into place, so
 * the poller — which reads only `*.json` names that do not start with a dot —
 * never sees half a command, and the rename cannot cross a filesystem. The
 * control directory is created with a `.gitignore` of `*`, so a project that
 * commits `.ralph/` never commits a pending command.
 *
 * A write that fails is an answer, not an exception: the operator is told the
 * command did not land, and nothing claims it did.
 */
export function deliverToInbox(root: string, input: ControlSendInput): { accepted: boolean; why: string } {
  if (!isSafeCommandId(input.key)) {
    return { accepted: false, why: `'${input.key}' cannot name a command file` };
  }
  const command = {
    version: 1,
    id: input.key,
    command: input.command,
    loop: input.loop,
    ...(input.run === null ? {} : { run: input.run }),
    ...(input.why === null ? {} : { why: input.why }),
    ...(input.stopKind === null ? {} : { stop: input.stopKind }),
    ...(input.issue === null ? {} : { issue: input.issue }),
    ...(input.reconfirm ? { reconfirm: true } : {}),
    ...(input.scope === "phase" ? { scope: "phase" } : {}),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    issuedAt: input.issuedAt,
    ...(input.via === undefined ? {} : { via: input.via }),
  };
  const inbox = join(root, CONTROL_SURFACE.inbox.path);
  try {
    mkdirSync(inbox, { recursive: true });
    const ignore = join(root, CONTROL_SURFACE.inbox.dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    const temp = join(inbox, `.${input.key}.json.${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify(command, null, 2)}\n`);
    renameSync(temp, join(inbox, `${input.key}.json`));
    return { accepted: true, why: "" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      accepted: false,
      why: `could not write the command to ${CONTROL_SURFACE.inbox.path}: ${code ?? (error instanceof Error ? error.message : String(error))}`,
    };
  }
}

/** How a recovery poll ended: a verdict, a supervisor in the way, or a fault. */
export type RecoveryPollEnding = { kind: "polled" } | { kind: "busy" } | { kind: "failed"; why: string };

export function recoveryPollEnding(result: ExecResult): RecoveryPollEnding {
  const surface = CONTROL_SURFACE.recoveryPoll;
  if (result.status === surface.busy) return { kind: "busy" };
  if ((surface.verdicts as readonly (number | null)[]).includes(result.status)) return { kind: "polled" };
  return { kind: "failed", why: result.stderr.trim() || `controls poll exited ${String(result.status)}` };
}

/** How the loop's record of a Stop now ended: written, a supervisor in the way, or a fault. */
export type InterruptRecordEnding =
  | { kind: "recorded"; stop: RecordedStop | null }
  | { kind: "busy" }
  | { kind: "failed"; why: string };

/** Narrow `controls.ts interrupted`: exit 0 prints `{ stop }`, `busy` is a live supervisor. */
export function parseInterruptRecord(result: ExecResult): InterruptRecordEnding {
  const surface = CONTROL_SURFACE.interruptRecord;
  if (result.status === surface.busy) return { kind: "busy" };
  if (result.status !== 0) {
    return { kind: "failed", why: result.stderr.trim() || `controls interrupted exited ${String(result.status)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { kind: "failed", why: "controls interrupted did not print JSON" };
  }
  return { kind: "recorded", stop: isRecord(value) ? narrowStop(value.stop) : null };
}

/** Build the adapter over one configured root and harness CLI directory. */
export function createRalphControlAdapter(config: ControlAdapterConfig): ControlAdapter {
  const cliDir = resolve(config.cliDir);
  const root = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const baseEnv: Env = { ...process.env, ...config.env };

  const scriptInvocation = (script: string, args: readonly string[], env: Env = {}): Invocation => ({
    command: bunPath,
    args: [join(cliDir, script), ...args],
    cwd: root,
    env: { ...baseEnv, [ADAPTER_ENV.loopStateRoot]: root, ...env },
  });
  const recovery = CONTROL_SURFACE.recoveryPoll;
  const interrupt = CONTROL_SURFACE.interruptRecord;
  // `-n`: never wait on a supervisor; `-E`: its holding the lock is `busy`.
  const underLock = (invocation: Invocation, lock: { command: string; path: string }, busy: number): Invocation => ({
    ...invocation,
    command: lock.command,
    args: ["-n", "-E", String(busy), join(root, lock.path), invocation.command, ...invocation.args],
  });

  const exec = guarded(config.exec);
  const controlStatusInvocation = (): Invocation =>
    scriptInvocation(CONTROL_SURFACE.controlStatus.script, CONTROL_SURFACE.controlStatus.args);
  const recoveryPollInvocation = (run: string, loop: string): Invocation =>
    underLock(
      scriptInvocation(recovery.script, recovery.args, {
        [recovery.env.plugins]: "",
        [recovery.env.run]: run,
        [recovery.env.loop]: loop,
      }),
      recovery.lock,
      recovery.busy,
    );
  const interruptRecordInvocation = (run: string, loop: string, key: string, why: string): Invocation =>
    underLock(
      scriptInvocation(
        interrupt.script,
        [...interrupt.args, interrupt.flags.key, key, interrupt.flags.why, why],
        { [interrupt.env.plugins]: "", [interrupt.env.run]: run, [interrupt.env.loop]: loop },
      ),
      interrupt.lock,
      interrupt.busy,
    );

  return {
    readIdentity: () => readObservedIdentity(root),
    readControlRecord: async () => {
      const result = await exec(controlStatusInvocation());
      return result.status === 0 ? parseControlRecord(result.stdout) : null;
    },
    readControlStatus: async () => parseControlStatus(await exec(controlStatusInvocation())),
    recoveryPoll: async (run: string, loop: string) => recoveryPollEnding(await exec(recoveryPollInvocation(run, loop))),
    recordInterrupt: async (run: string, loop: string, key: string, why: string) =>
      parseInterruptRecord(await exec(interruptRecordInvocation(run, loop, key, why))),
    deliver: (input: ControlSendInput) => deliverToInbox(root, input),
  };
}
