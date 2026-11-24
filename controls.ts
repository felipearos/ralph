#!/usr/bin/env bun
/**
 * The loop's control channel: what an operator may tell a loop.
 *
 * It reads commands an operator leaves in the loop's local inbox
 * (`ralph/control-inbox.ts`), applies the ones this loop owns, and answers
 * with a verdict `ralph.sh` acts on at the top of every iteration:
 *
 *   pause / resume     hold the loop at a boundary, and let it go again.
 *   stop               end the run at the next boundary, with a stop kind.
 *   request-approval   hold the loop until somebody approves or denies.
 *   approve / deny     release, or refuse, a hold taken for approval.
 *   arm-gate           hold for approval before a named phase, every time.
 *   disarm-gate        stop gating that phase.
 *   retry              open a linked attempt on a ticket whose last one failed.
 *   retry-phase        run the phase just finished again, while held after it.
 *   abandon            take an EXPIRED claim back from an owner that is gone.
 *   release            give up what this run holds, gracefully.
 *
 * The inbox is the only route in. The dashboard writes it, an operator can
 * write it by hand, and an enabled plugin can write it through the `inbox`
 * hook, which is offered at the start of every poll (`ralph/plugins.ts`). The
 * core cannot tell who wrote a file, so every command goes through the same
 * fences whatever carried it. Once the record is written, each settled command
 * is offered to plugins as a `control` event, so a plugin that delivered one
 * can answer it where it came from.
 *
 * Five properties carry the whole design, and each one is a failure that has
 * to be impossible rather than unlikely:
 *
 * 1. **A command is applied at most once, however often it arrives.** A writer
 *    may deliver the same command twice (a plugin re-reading a mailbox that
 *    replays until acknowledged is exactly that), so the fence is a durable
 *    set of applied keys. A file is moved aside only after the record naming
 *    its outcome is written.
 *
 * 2. **Ownership changes invalidate a command rather than redirecting it.** A
 *    `stop` an operator issued against run A, replayed after run A died and
 *    run B took the worktree, would stop a supervisor the operator never saw.
 *    A command naming a run is refused once the run has changed, and the
 *    operator re-issues it against the run they now mean. A command naming no
 *    run is addressed to whoever holds the loop, which is a different and
 *    equally legitimate thing to mean.
 *
 * 3. **An unexpired lease is not reclaimable.** `abandon` and `release` are
 *    recovery, and recovery that could take a live owner's claim is just a
 *    race with extra steps. The only reclaimable state is `expired` — the one
 *    state `claim-lease.ts` already says nobody may hold — and the refusal
 *    names the expiry so an operator can wait for it rather than guess.
 *
 *    Giving a claim back means the lease AND its `<loop>-wip` label. The
 *    frontier refuses any ticket carrying a WIP label, and clears one by
 *    itself only while an expired lease stands behind it, so a label left
 *    without its lease strands the ticket for every loop. The label goes
 *    first: if the tracker edit fails, nothing has changed, the command is
 *    refused with the tracker's answer, and sending it again is safe. Giving
 *    it back also clears the ticket's phase ledger (`ralph/phase.ts`), so a
 *    later claim starts from the top instead of resuming a phase nobody holds.
 *
 * 4. **A stop says whether it was confirmed.** A supervisor that applies its
 *    own stop is about to exit, and says so with `--supervised`. An operator
 *    recovering a worktree whose supervisor is gone cannot: the process may
 *    have died, or may be running somewhere `/proc` cannot see. Those are
 *    recorded as `confirmed` and `unreachable`, never collapsed.
 *
 * 5. **It cannot stop, wait, or fail a loop by accident.** The verdict is read
 *    off the durable record alone, so an existing hold keeps holding and an
 *    absent one never appears. A plugin that hangs or crashes is the host's to
 *    record against the plugin; this channel carries on without it.
 *
 * `pause`, `stop` and `request-approval` take a scope: `iteration`, the
 * default, applies at the next iteration boundary as it always has; `phase`
 * applies at the next boundary of either kind, so an operator can say "pause
 * after review" or "stop before it opens a PR". A scope nobody can read is the
 * default one. See "Phase boundaries" below.
 *
 * `arm-gate` and `disarm-gate` name a phase (`"phase": "finish"`) and apply at
 * any poll. An armed gate is kept in the record until it is disarmed, across
 * iterations and supervisor restarts alike, and asks once per iteration: the
 * supervisor's poll at the boundary before that phase — the iteration boundary
 * for `select` — finds it armed and takes an approval hold there, which the
 * ordinary `approve` and `deny` answer. See `gateAt`.
 *
 * Usage:
 *   ralph/controls.ts poll [--supervised] [--only <command,…>] [--json]
 *                          [--phase <next> [--after <finished>] | --in-iteration]
 *   ralph/controls.ts status [--json | --line]
 *   ralph/controls.ts interrupted --key <id> --why <reason> [--self <pid> [--signal <name>]]
 *
 * `--supervised` is the supervisor saying "I am about to act on the answer",
 * and it is what separates a `confirmed` stop from a `pending` one — see
 * property 4 and `applierFor`. `ralph.sh` passes it; an operator polling by
 * hand does not, and so cannot confirm a termination they are not carrying
 * out.
 *
 * `--only` limits the inbox to the named commands and leaves every other file
 * where it is. The dashboard's recovery poll passes `retry,abandon,release`
 * (with `RALPH_PLUGINS=` empty, so it reaches no plugin): it runs on behalf of
 * a supervisor that is gone, and a pause or a stop left for the next
 * supervisor is that supervisor's to apply, not a passer-by's. An operator's
 * `--only` poll also refuses outright — exit 75, nothing read or written —
 * when the loop's recorded owner is alive: the page judged it dead, and one
 * started since is the one poller this record may have. The dashboard runs it
 * under `start.sh`'s supervisor lock, which fences every supervisor `start.sh`
 * launched; this check only narrows the window for a `ralph.sh` started by
 * hand, which holds no lock and may record its pid after the check.
 *
 * `--phase` says the poll is the supervisor's checkpoint at a PHASE boundary,
 * with the phase about to start and the one just finished. There a pause, stop
 * or approval request of the default scope is left in the inbox for the
 * iteration boundary, unread — unless the loop is already held here, because
 * a parked loop is at a boundary whatever the command meant, and an operator
 * stopping a held loop should not have to resume it first. A hold or a stop
 * this poll answers with is stamped with the phase it is before, which is what
 * the dashboard's "held before `<phase>`" and the stop record read.
 *
 * `retry-phase` is the one command that needs the loop to be parked at a phase
 * boundary: it is accepted only by the supervisor's own `--phase` poll while a
 * hold stands at that boundary, and refused with the reason anywhere else. It
 * releases the hold, and that poll answers `retry` with the phase just
 * finished — exit 30 — so the supervisor runs that phase again in a fresh
 * session (`ralph/phase-prompt.ts`) instead of resuming the old one into the
 * next. The answer is the poll's own, not the record's: the record keeps the
 * retry in `phaseRetries` as history, and the next poll, which may be at the
 * very same boundary once the retried phase finishes, reads nothing from it.
 *
 * `interrupted` is not a command anybody sends: it is how the dashboard's
 * Stop now writes down what it did, once its signal has ended the supervisor.
 * It records a `confirmed` stop of kind `interrupted` — confirmed because the
 * operator carried the termination out and the process table agrees it
 * happened — with the iteration it cut short and the ticket this run holds,
 * and ends the loop state the same way. It refuses, exit 75 and nothing
 * written, while the recorded owner is alive, and it writes only as the run
 * the loop state names. The claim is left alone on purpose: a killed
 * iteration leaves commits, uncommitted files and a claim, and giving the
 * ticket back would let another loop start fresh over a half-finished branch.
 * The lease lapses on its own unless the loop is resumed in the same worktree.
 *
 * `--self <pid>` is the supervisor writing the same ending from its own signal
 * trap: a shutdown, a reboot or an operator's `kill` reaches `ralph.sh` as a
 * SIGTERM nobody records afterwards, and the dashboard's reconciler restarts
 * any loop that died without an ending. The owner is alive then — it is the
 * caller — so the liveness refusal is replaced by a narrower one: the loop
 * state's owner must be exactly `<pid>`. A Stop now that follows records over
 * it under its own key, and its reason replaces the trap's.
 *
 * `--signal <name>` (only with `--self`) names the signal the trap caught, and
 * the loop state's `stopReason` records it with `self: true` — an operator's
 * Stop now writes `self: false` and no signal — so the dashboard's reconciler
 * can tell a loop a host shutdown stopped from one an operator stopped (#6).
 *
 * A project put to sleep (`ralph/project-sleep.ts`) holds the loop too, with
 * the detail `sleep`, but only at a poll between iterations: one with
 * `--phase`, or with `--in-iteration` (the supervisor held for the host
 * between two turns), lets the iteration it is inside finish. The sleep is
 * read off its marker at every poll and never written into this record, so
 * waking the project releases every loop with nothing to clear here, and a
 * `resume` cannot wake one loop of a sleeping project.
 *
 * `poll` prints one machine line — `<verdict>\t<detail>\t<why>` — followed by
 * any notices worth showing an operator, and exits 0 for *continue*, 10 for
 * *hold*, 20 for *stop* and 30 for *retry* the phase named in `<detail>`. Any other status is a fault in this file, and
 * `ralph.sh` reads it as *continue*: see property 5.
 *
 * A command is one file in the inbox:
 *
 *   .ralph/control/inbox/<id>.json
 *     {"version":1,"id":"<id>","command":"pause","run":"<RALPH_RUN_ID>","why":"…",
 *      "scope":"phase"}
 *
 * `via` names the writer when it is not the local operator, and is carried on
 * the `control` event so the writer can recognise its own commands.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { currentLoop } from "./frontier/next-tasks";
import { leasePathFromGit, readLeaseStore, reclaimClaim, reclaimVerdict } from "./claim-lease";
import {
  readInbox,
  settleInboxEntry,
  settledOutcome,
  type InboxEntry,
  type InboxOutcome,
} from "./control-inbox";
import {
  STATE_RELATIVE_PATH,
  STOP_KINDS,
  applyRecord,
  branchOf,
  parseLoopState,
  supervisorPidMatches,
  writeJsonAtomically,
  writeState,
  type Liveness,
  type LoopState,
  type StopKind,
} from "./loop-state";
import { projectRoot } from "./paths";
import { projectTrackerConfig, runTrackerCli } from "./tracker/project";
import { clearLedger, isPhase, PHASES, type Phase } from "./phase";
import { baseEvent, offer, offerEvents, type PluginEvent } from "./plugins";
import { projectSleep, sleepReason, type ProjectSleep } from "./project-sleep";

/** Where the control record lives. Beside the other records, and gitignored. */
export const CONTROL_STATE_RELATIVE_PATH = ".ralph/logs/controls.json";

/**
 * Where the record lived under its old name. Read, never written,
 * so a hold taken before the upgrade still holds after it: a supervisor
 * restart must not be a way to defeat a pause.
 */
export const LEGACY_CONTROL_STATE_RELATIVE_PATH = ".ralph/logs/orca-controls.json";

/**
 * How many applied keys are kept.
 *
 * The fence only has to outlive a replay, and a replay is bounded by what one
 * writer re-delivers at once — a mailbox batch is at most 50 messages. Several
 * hundred is orders of magnitude past that while keeping the record small
 * enough to rewrite on every poll. A file whose key has aged out is still
 * answered from its outcome file; see `readLocalInbox`.
 */
export const APPLIED_LIMIT = 256;

/* --------------------------------------------------------------------------
 * The commands.
 * ----------------------------------------------------------------------- */

export const COMMANDS = [
  "pause",
  "resume",
  "stop",
  "request-approval",
  "approve",
  "deny",
  "arm-gate",
  "disarm-gate",
  "retry",
  "abandon",
  "release",
  "retry-phase",
] as const;
export type Command = (typeof COMMANDS)[number];

const isCommand = (value: unknown): value is Command =>
  typeof value === "string" && (COMMANDS as readonly string[]).includes(value);

/**
 * The stop kinds a `stop` command may ask for. `interrupted` is not one: it
 * says a signal ended the supervisor, and only the `interrupted` subcommand,
 * run after that signal took effect, may record it.
 */
export const ORDERLY_STOP_KINDS = STOP_KINDS.filter(
  (kind): kind is Exclude<StopKind, "interrupted"> => kind !== "interrupted",
);

/**
 * Where a scoped command takes effect. `iteration` is the default and the only
 * behaviour there was before phases; `phase` is the next boundary of either
 * kind, whichever comes first.
 */
export const SCOPES = ["iteration", "phase"] as const;
export type Scope = (typeof SCOPES)[number];

/** The commands that take a scope. Every other command applies at any poll. */
export const SCOPED_COMMANDS: readonly Command[] = ["pause", "stop", "request-approval"];

export interface ControlCommand {
  /** The idempotency key: the writer's own `id`, else the file's name. */
  key: string;
  command: Command;
  /** The loop the command names, when it names one. */
  loop: string | null;
  /** The run it was issued against, when it names one. See property 2. */
  run: string | null;
  /** The ticket, for the two recovery commands that need one. */
  issue: number | null;
  why: string | null;
  /** How a `stop` should read in the durable record. */
  stopKind: StopKind;
  /** The operator re-issuing a command they know names a replaced run. */
  reconfirm: boolean;
  /**
   * Where a `pause`, `stop` or `request-approval` takes effect. Anything but
   * `phase` reads as `iteration`, so a malformed scope is the old behaviour.
   */
  scope: Scope;
  /**
   * What an approval is about: set by `request-approval`, and matched by an
   * `approve` or `deny` that names one, so an answer to one question cannot
   * release a hold taken for another.
   */
  gate: string | null;
  /** The phase `arm-gate` and `disarm-gate` name; null when none was readable. */
  phase: Phase | null;
  /** Who wrote it, when that was not the local operator. Carried, never trusted. */
  via: string | null;
}

/**
 * Read a command out of one inbox file, or decide it is not one.
 *
 * The key falls back to the file's name, which the writer chose to be the
 * command's id.
 */
export function commandFromInbox(entry: { stem: string; value: Record<string, unknown> }): ControlCommand | null {
  const envelope = controlEnvelope(entry.value);
  if (envelope === null) return null;
  return commandIn(envelope, entry.stem, text(entry.value.via));
}

function commandIn(
  envelope: Record<string, unknown>,
  fallbackKey: string | null,
  via: string | null,
): ControlCommand | null {
  const command = envelope.command;
  if (!isCommand(command)) return null;
  const key = text(envelope.id) ?? fallbackKey;
  if (key === null) return null;
  const stopKind = text(envelope.stop);
  return {
    key,
    command,
    loop: text(envelope.loop),
    run: text(envelope.run) ?? text(envelope.ralphRun),
    issue: integer(envelope.issue),
    why: text(envelope.why),
    stopKind:
      stopKind !== null && (ORDERLY_STOP_KINDS as readonly string[]).includes(stopKind)
        ? (stopKind as StopKind)
        : "blocked",
    reconfirm: envelope.reconfirm === true,
    scope: text(envelope.scope) === "phase" ? "phase" : "iteration",
    gate: text(envelope.gate),
    phase: isPhase(envelope.phase) ? envelope.phase : null,
    via: text(envelope.via) ?? via,
  };
}

/**
 * The `control` object inside a payload, whether the payload arrived as a JSON
 * string or as an already-parsed object.
 *
 * `{"command": …}` at the top level is accepted too. An operator typing the
 * command by hand writes the shorter one first, and a channel that ignored it
 * would look broken for the most likely first use.
 */
export function controlEnvelope(payload: unknown): Record<string, unknown> | null {
  let value: unknown = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const nested = row.control;
  if (typeof nested === "object" && nested !== null) return nested as Record<string, unknown>;
  return typeof row.command === "string" ? row : null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const integer = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/* --------------------------------------------------------------------------
 * The record.
 * ----------------------------------------------------------------------- */

export type AppliedOutcome =
  | "applied"
  | "refused"
  | "replayed"
  | "needs-reconfirmation"
  | "not-for-this-loop";

/**
 * What applying a command produced, including the one answer that is never
 * written down.
 *
 * `deferred` means "the lease store was locked; ask me again". It has to be
 * outside `AppliedOutcome` because the applied set is the REPLAY FENCE: an
 * entry there — of any outcome, including `refused` — makes the next delivery
 * of that command a no-op. Recording a deferral as applied therefore dropped
 * it permanently, which is the exact opposite of the retry the deferral is
 * asking for. The type is what stops the two being confused again.
 */
export type ApplyOutcome = AppliedOutcome | "deferred";

export interface AppliedCommand {
  key: string;
  command: Command;
  at: string;
  outcome: AppliedOutcome;
  why: string;
}

export interface Hold {
  /** `pause` is an operator holding the loop; `approval` is a question holding it. */
  kind: "pause" | "approval";
  why: string;
  since: string;
  /** The command that took the hold, when a command did. */
  key: string | null;
  /** What an approval hold is waiting on, as `request-approval` named it. */
  gate: string | null;
  /**
   * The phase boundary the loop is parked at: the phase it is held before, and
   * the one it just finished. Absent for a hold taken between iterations.
   */
  phase?: Phase;
  after?: Phase;
}

/**
 * A requested stop and — the part that is not decoration — whether anybody
 * confirmed it took effect.
 *
 * `confirmed` is a supervisor that read the command and is exiting on it.
 * `unreachable` is an operator recovering a worktree whose owner cannot be
 * found in the process table. `pending` is the honest third answer: the
 * command is recorded, and this machine cannot see well enough to say which of
 * the other two it is — a `/proc` that is not readable, most often.
 */
export interface StopRequest {
  kind: StopKind;
  why: string;
  at: string;
  key: string | null;
  confirmation: "confirmed" | "unreachable" | "pending";
  /** For an `interrupted` stop: the iteration the signal cut short. */
  iteration?: number | null;
  /** For an `interrupted` stop: the ticket the run held, and still holds. */
  issue?: number | null;
  /**
   * For a stop carried out at a phase boundary: the phase it stopped before.
   * The iteration ends there with its claim, branch, note and ledger kept.
   */
  phase?: Phase;
}

/**
 * One attempt linked to the attempt it retries.
 *
 * The predecessor is copied rather than referenced. Its log is rotated, its
 * dispatch is settled and its session id is reused by nothing — so a link that
 * only named the predecessor would, a day later, name something an operator
 * can no longer look up. What is worth keeping is small, so it is kept.
 */
export interface RetryLink {
  /** `<run>/attempt-<n>`, the identity this retry opens. */
  attempt: string;
  /** The same shape for the attempt it replaces, or null if there was none. */
  predecessor: string | null;
  evidence: {
    iteration: number | null;
    session: string | null;
    log: string | null;
    outcome: string | null;
    why: string | null;
    at: string | null;
  };
  requestedAt: string;
  key: string | null;
}

/**
 * A phase an operator had run again, kept as history: the record's side of the
 * audit trail whose other side is the phase ledger's superseded attempt.
 */
export interface PhaseRetry {
  /** The phase run again: the one just finished when the command landed. */
  phase: Phase;
  /** The phase the loop was held before, which the retried phase leads into again. */
  next: Phase;
  at: string;
  key: string | null;
  why: string;
}

/**
 * A gate before a named phase: an approval the loop asks for every time it
 * reaches that phase, until an operator disarms it.
 */
export interface ArmedGate {
  phase: Phase;
  /** What the operator said when arming it, if anything. */
  why: string | null;
  since: string;
  key: string | null;
  /**
   * The boundary this gate last asked at (`gatePassFor`), so a gate that has
   * been answered does not ask again at the same one. Null until it first asks.
   */
  asked: string | null;
}

/** A claim taken back from an owner that was gone, kept as evidence. */
export interface AbandonedClaim {
  issue: number;
  run: string;
  owner: string;
  worktree: string;
  claimedAt: string;
  expiredAt: string;
  abandonedAt: string;
  key: string | null;
}

/**
 * A command this loop has accepted and not yet been able to apply.
 *
 * Kept because the alternative is silence. A deferral leaves the command's
 * file in the inbox so it is read again, which is right while the lock is held
 * for the milliseconds a claim writer holds it — and wrong for ever if a
 * writer was SIGKILLed and left `next-tasks-claim.lock` behind, because
 * `claim-lease.ts` never breaks a lock. From the operator's side those two look
 * identical: a command that simply never happens. So the attempts are counted,
 * and once they stop being explicable as contention the loop says so.
 */
export interface Deferral {
  key: string;
  command: Command;
  since: string;
  attempts: number;
}

export interface ControlState {
  version: 1;
  /** The run this record currently belongs to. */
  ralphRun: string;
  loop: string;
  /** When the run last changed under a record that outlived it. Property 2. */
  ownerChangedAt: string | null;
  applied: AppliedCommand[];
  hold: Hold | null;
  stop: StopRequest | null;
  retries: RetryLink[];
  abandoned: AbandonedClaim[];
  released: number[];
  deferrals: Deferral[];
  /** Every phase an operator had run again, oldest first. */
  phaseRetries: PhaseRetry[];
  /** The armed gates, one per phase. Adopted by a new run like a hold. */
  gates: ArmedGate[];
  lastPolledAt: string | null;
}

/**
 * How many polls a command may be deferred before the channel gives up on it.
 *
 * Five, so an ordinary lock collision — held for the milliseconds a claim
 * writer or a heartbeat holds it — never gets near it.
 *
 * There has to be a limit: `claim-lease.ts` deliberately never breaks a lock,
 * so a writer killed with SIGKILL leaves a lock that is never coming back, and
 * a command waiting on it for ever is an inbox file that never settles and a
 * board that reports it as pending for ever.
 *
 * At the limit the command is given up on, said out loud with the remedy, and
 * its file settled as refused — so one stuck command costs itself and five
 * polls.
 */
export const DEFERRAL_LIMIT = 5;

export function blankControlState(run: string, loop: string): ControlState {
  return {
    version: 1,
    ralphRun: run,
    loop,
    ownerChangedAt: null,
    applied: [],
    hold: null,
    stop: null,
    retries: [],
    abandoned: [],
    released: [],
    deferrals: [],
    phaseRetries: [],
    gates: [],
    lastPolledAt: null,
  };
}

/**
 * Read a record back, treating every unusable file as no record at all.
 *
 * The same contract as the other records in `.ralph/logs/`: this one is
 * written by a poll running inside a supervisor that can be killed mid-write,
 * and a reader that threw on a truncated one would take the control channel
 * down for the rest of the run — which, since the verdict falls back to the
 * record, would silently release a hold.
 */
export function parseControlState(raw: string): ControlState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1) return null;
  const run = text(value.ralphRun);
  if (run === null) return null;
  const list = <T>(raw: unknown, of: (row: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(raw)
      ? raw
          .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
          .map(of)
          .filter((row): row is T => row !== null)
      : [];
  return {
    version: 1,
    ralphRun: run,
    loop: text(value.loop) ?? "ralph",
    ownerChangedAt: text(value.ownerChangedAt),
    applied: list<AppliedCommand>(value.applied, (row) => {
      const key = text(row.key);
      return key === null || !isCommand(row.command)
        ? null
        : {
            key,
            command: row.command,
            at: text(row.at) ?? "",
            outcome: (text(row.outcome) ?? "applied") as AppliedOutcome,
            why: text(row.why) ?? "",
          };
    }),
    hold: ((): Hold | null => {
      const raw = value.hold;
      if (typeof raw !== "object" || raw === null) return null;
      const row = raw as Record<string, unknown>;
      if (row.kind !== "pause" && row.kind !== "approval") return null;
      return {
        kind: row.kind,
        why: text(row.why) ?? "held",
        since: text(row.since) ?? "",
        key: text(row.key),
        gate: text(row.gate),
        ...(isPhase(row.phase) ? { phase: row.phase } : {}),
        ...(isPhase(row.after) ? { after: row.after } : {}),
      };
    })(),
    stop: ((): StopRequest | null => {
      const raw = value.stop;
      if (typeof raw !== "object" || raw === null) return null;
      const row = raw as Record<string, unknown>;
      const kind = text(row.kind);
      if (kind === null || !(STOP_KINDS as readonly string[]).includes(kind)) return null;
      const confirmation = text(row.confirmation);
      return {
        kind: kind as StopKind,
        why: text(row.why) ?? "stopped by an operator",
        at: text(row.at) ?? "",
        key: text(row.key),
        confirmation:
          confirmation === "confirmed" || confirmation === "unreachable"
            ? confirmation
            : "pending",
        ...(kind === "interrupted" ? { iteration: counted(row.iteration), issue: counted(row.issue) } : {}),
        ...(isPhase(row.phase) ? { phase: row.phase } : {}),
      };
    })(),
    retries: list<RetryLink>(value.retries, (row) => {
      const attempt = text(row.attempt);
      if (attempt === null) return null;
      const evidence =
        typeof row.evidence === "object" && row.evidence !== null
          ? (row.evidence as Record<string, unknown>)
          : {};
      return {
        attempt,
        predecessor: text(row.predecessor),
        evidence: {
          iteration: integer(evidence.iteration),
          session: text(evidence.session),
          log: text(evidence.log),
          outcome: text(evidence.outcome),
          why: text(evidence.why),
          at: text(evidence.at),
        },
        requestedAt: text(row.requestedAt) ?? "",
        key: text(row.key),
      };
    }),
    abandoned: list<AbandonedClaim>(value.abandoned, (row) => {
      const issue = integer(row.issue);
      return issue === null
        ? null
        : {
            issue,
            run: text(row.run) ?? "",
            owner: text(row.owner) ?? "",
            worktree: text(row.worktree) ?? "",
            claimedAt: text(row.claimedAt) ?? "",
            expiredAt: text(row.expiredAt) ?? "",
            abandonedAt: text(row.abandonedAt) ?? "",
            key: text(row.key),
          };
    }),
    released: Array.isArray(value.released)
      ? value.released.map(integer).filter((issue): issue is number => issue !== null)
      : [],
    deferrals: list<Deferral>(value.deferrals, (row) => {
      const key = text(row.key);
      return key === null || !isCommand(row.command)
        ? null
        : {
            key,
            command: row.command,
            since: text(row.since) ?? "",
            attempts: integer(row.attempts) ?? 1,
          };
    }),
    phaseRetries: list<PhaseRetry>(value.phaseRetries, (row) =>
      isPhase(row.phase) && isPhase(row.next)
        ? { phase: row.phase, next: row.next, at: text(row.at) ?? "", key: text(row.key), why: text(row.why) ?? "" }
        : null,
    ),
    // A gate naming no phase this file knows is dropped, and a second one for
    // the same phase too: a malformed gate is no gate, never a hold.
    gates: list<ArmedGate>(value.gates, (row) =>
      isPhase(row.phase)
        ? {
            phase: row.phase,
            why: text(row.why),
            since: text(row.since) ?? "",
            key: text(row.key),
            asked: text(row.asked),
          }
        : null,
    ).filter((gate, at, all) => all.findIndex((other) => other.phase === gate.phase) === at),
    lastPolledAt: text(value.lastPolledAt),
  };
}

/** A recorded number, where `null` must stay null rather than read as 0. */
const counted = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/* --------------------------------------------------------------------------
 * Pure decisions.
 * ----------------------------------------------------------------------- */

export type CommandVerdict =
  | { accept: true }
  | { accept: false; outcome: Exclude<AppliedOutcome, "applied" | "refused">; why: string };

/**
 * May this command be applied?
 *
 * Three refusals, and the difference between them is what the operator has to
 * do next, which is the only reason to distinguish them at all:
 *
 * - `replayed` — already applied. Nothing to do; a writer delivering twice is
 *   what the fence is for, not a mistake.
 * - `not-for-this-loop` — addressed to the other loop. Nothing to do here; the
 *   loop it names will apply it from its own record.
 * - `needs-reconfirmation` — issued against a run that has since been
 *   replaced. Re-issue it against the run that holds the loop now, or set
 *   `"reconfirm": true` to mean it regardless.
 */
export function commandVerdict(
  state: ControlState,
  command: ControlCommand,
  identity: { run: string; loop: string },
): CommandVerdict {
  if (state.applied.some((entry) => entry.key === command.key)) {
    return { accept: false, outcome: "replayed", why: "already applied" };
  }
  if (command.loop !== null && command.loop !== identity.loop) {
    return {
      accept: false,
      outcome: "not-for-this-loop",
      why: `addressed to ${command.loop}; this is ${identity.loop}`,
    };
  }
  if (command.run !== null && command.run !== identity.run && !command.reconfirm) {
    return {
      accept: false,
      outcome: "needs-reconfirmation",
      why: `issued against run ${command.run}, which ${identity.run} replaced — re-issue it against ${identity.run}, or send it again with "reconfirm": true`,
    };
  }
  return { accept: true };
}

/**
 * What the supervisor should do now.
 *
 * `detail` is the second field of the machine line `ralph.sh` reads, and it is
 * a union rather than a `string` because the supervisor turns it straight back
 * into a stop kind: a value outside this set would be recorded as one.
 */
export interface ControlVerdict {
  action: "continue" | "hold" | "stop" | "retry";
  /** For `retry`, the phase to run again. */
  detail: StopKind | Hold["kind"] | Phase | "sleep" | "-";
  why: string;
}

/**
 * What the supervisor should do right now, read off the record alone.
 *
 * Off the record ALONE is the point: this is what makes an absent writer
 * harmless. A poll with nothing new in its inbox writes no new hold and clears
 * none, so a loop that was told to pause stays paused, and one that was not is
 * never paused by a writer being gone.
 */
export function verdictFor(state: ControlState, retry: PhaseRetry | null = null): ControlVerdict {
  // A stop outranks a hold. An operator who paused a loop and then stopped it
  // means the second thing, and a supervisor parked in a hold that ignored the
  // stop would sit there until somebody resumed it just to let it exit.
  if (state.stop !== null) {
    return { action: "stop", detail: state.stop.kind, why: state.stop.why };
  }
  // A retry this poll applied released the hold it was taken under; one sent
  // after it in the same batch holds the loop again once the retry has run.
  if (retry !== null) {
    return { action: "retry", detail: retry.phase, why: retry.why };
  }
  if (state.hold !== null) {
    return { action: "hold", detail: state.hold.kind, why: state.hold.why };
  }
  return { action: "continue", detail: "-", why: "no operator control is holding this loop" };
}

/**
 * The verdict once the project's sleep (`ralph/project-sleep.ts`) is weighed.
 *
 * It only ever turns a `continue` into a hold, and only at a poll between
 * iterations: a stop, a retry and an operator's own hold
 * all say more than "the project is asleep", and a poll at a phase boundary
 * is inside an iteration the sleep lets finish. That is what makes it soft.
 */
export function sleepingVerdict(
  verdict: ControlVerdict,
  betweenIterations: boolean,
  asleep: ProjectSleep | null,
): ControlVerdict {
  if (verdict.action !== "continue" || !betweenIterations || asleep === null) return verdict;
  return { action: "hold", detail: "sleep", why: sleepReason(asleep) };
}

/** An operator's `--only` poll found the loop's own supervisor alive. */
export const BUSY_EXIT = 75;

/** The exit status `ralph.sh` reads. See the header for the contract. */
export const EXIT_FOR: Record<ControlVerdict["action"], number> = {
  continue: 0,
  hold: 10,
  stop: 20,
  retry: 30,
};

/** The identity one attempt is known by, in the record and on the board. */
export function attemptIdFor(run: string, index: number): string {
  return `${run}/attempt-${index}`;
}

/**
 * How a stop reads, given what can be seen of the loop's owner.
 *
 * The distinction the operator actually needs: did somebody read this command
 * and act on it, or is it a note left for a supervisor nobody can find? A
 * board that showed both as "stopped" would be telling an operator a machine
 * is quiet when it may well still be spending money.
 */
export function stopConfirmationFor(
  applier: "supervisor" | "operator",
  owner: Liveness,
): StopRequest["confirmation"] {
  if (applier === "supervisor") return "confirmed";
  return owner === "dead" ? "unreachable" : "pending";
}

/**
 * Settle one command: newest-last in the applied fence, capped, and no longer
 * waiting for anything.
 *
 * The deferral is dropped HERE rather than on the path that applied it,
 * because settling has more endings than that one. A command deferred by a
 * held lock and then refused on the next poll — `needs-reconfirmation` after
 * the run changed underneath it is the realistic case — never reaches an
 * applied branch at all, and an entry left behind reported it as still waiting
 * on the board for the life of the record. An entry in this fence means the
 * command is finished, whatever finished it.
 */
export function remember(state: ControlState, entry: AppliedCommand): ControlState {
  const applied = [...state.applied, entry];
  return {
    ...state,
    applied: applied.slice(Math.max(0, applied.length - APPLIED_LIMIT)),
    deferrals: state.deferrals.filter((row) => row.key !== entry.key),
  };
}

/* --------------------------------------------------------------------------
 * Identity, and the record this one reads.
 * ----------------------------------------------------------------------- */

export interface Identity {
  loop: string;
  run: string;
  worktree: string;
  branch: string | null;
  /** Whether this poll is the supervisor's own, or an operator's recovery. */
  applier: "supervisor" | "operator";
  host: string;
}

/**
 * Is this poll the supervisor's own, or an operator's recovery?
 *
 * Declared by the caller with `--supervised`, and deliberately NOT inferred.
 * The first version of this compared `RALPH_SUPERVISOR_PID` to `process.ppid`,
 * which is wrong in exactly the way the supervisor invokes it: `ralph.sh` runs
 * `out="$(bun ralph/controls.ts poll 2>/dev/null)"`, and the redirection
 * inside a command substitution defeats bash's exec optimisation — so the
 * parent is the substitution's subshell, never the supervisor. Every stop the
 * supervisor read for itself was therefore recorded `pending` instead of
 * `confirmed`.
 *
 * A flag cannot be defeated by a subshell, and it says the thing that actually
 * matters: the caller is about to ACT on the verdict it gets back. An operator
 * polling by hand does not pass it, and so cannot confirm a termination they
 * are not carrying out.
 */
function applierFor(argv: string[]): "supervisor" | "operator" {
  return argv.includes("--supervised") ? "supervisor" : "operator";
}

function identityFor(root: string, applier: Identity["applier"]): Identity {
  return {
    loop: currentLoop(process.env, join(root, ".ralph/loop-name")),
    run: process.env.RALPH_RUN_ID ?? "adhoc",
    worktree: resolve(root),
    branch: branchOf(root),
    applier,
    host: hostname(),
  };
}

const readJson = <T>(path: string, parse: (raw: string) => T | null): T | null =>
  existsSync(path) ? parse(readFileSync(path, "utf8").toString()) : null;

/** The control record, from its path or — before the first write — its old one. */
export function readControlState(root: string): ControlState | null {
  return (
    readJson(join(root, CONTROL_STATE_RELATIVE_PATH), parseControlState) ??
    readJson(join(root, LEGACY_CONTROL_STATE_RELATIVE_PATH), parseControlState)
  );
}

/**
 * How alive the loop's owner is, from the durable record and the process
 * table — never from the record alone.
 *
 * `loop-state.ts` re-derives liveness this way for the same reason: a state
 * file says a run was alive when it was last written, and pids are reused, so
 * a file naming a recycled pid is exactly how a dead loop comes to be reported
 * as running. `unknown` is a real answer here and is carried through to the
 * stop's confirmation rather than flattened into `dead`.
 */
export function ownerLiveness(loop: LoopState | null, worktree: string): Liveness {
  const pid = loop?.owner.pid ?? null;
  if (pid === null) return "unknown";
  return supervisorPidMatches(pid, worktree);
}

/* --------------------------------------------------------------------------
 * Applying one command.
 * ----------------------------------------------------------------------- */

interface Context {
  root: string;
  identity: Identity;
  nowIso: string;
  loop: LoopState | null;
  /** The phase boundary the supervisor's poll is at; null anywhere else. */
  boundary: PhaseBoundary | null;
  /** Notices worth putting in front of whoever is reading the terminal. */
  notices: string[];
}

interface Applied {
  state: ControlState;
  outcome: ApplyOutcome;
  why: string;
}

function apply(state: ControlState, command: ControlCommand, context: Context): Applied {
  const { identity, nowIso } = context;
  const why = command.why ?? `${command.command} issued ${command.via === null ? "from the local inbox" : `via ${command.via}`}`;
  const ok = (next: ControlState, said: string): Applied => ({
    state: next,
    outcome: "applied",
    why: said,
  });
  const no = (said: string): Applied => ({ state, outcome: "refused", why: said });
  // Not a refusal: the lock is held by the claim writer or a heartbeat, both
  // of which finish in milliseconds. Left unrecorded so the next poll sees the
  // same command again — the one place a replay is what we want.
  const later = (said: string): Applied => ({ state, outcome: "deferred", why: said });
  // An answer naming what it answers must match what is being asked.
  const answers = (): string | null =>
    state.hold?.kind !== "approval"
      ? "nothing is waiting for approval"
      : command.gate !== null && state.hold.gate !== null && command.gate !== state.hold.gate
        ? `the approval waiting is ${state.hold.gate}, not ${command.gate}`
        : null;

  switch (command.command) {
    case "pause":
      return ok(
        {
          ...state,
          hold: { kind: "pause", why, since: nowIso, key: command.key, gate: null },
        },
        `paused — ${why}`,
      );

    case "resume":
      if (state.hold === null) return ok(state, "already running; nothing was holding it");
      return ok({ ...state, hold: null }, `resumed — ${why}`);

    case "request-approval":
      // A pause an operator took by hand outranks a request: replacing it with
      // an approval hold that an `approve` would then clear would lose the
      // operator's own instruction. The writer asks again once it is lifted.
      if (state.hold !== null) {
        return no(`already held (${state.hold.kind}) — ask again once it is lifted`);
      }
      return ok(
        {
          ...state,
          hold: { kind: "approval", why, since: nowIso, key: command.key, gate: command.gate },
        },
        `waiting for approval — ${why}`,
      );

    case "approve": {
      // Narrower than `resume` on purpose: approving is an answer to a
      // question, and answering a question nobody asked should say so rather
      // than quietly release an unrelated pause an operator still means.
      const refused = answers();
      if (refused !== null) return no(refused);
      return ok({ ...state, hold: null }, `approved — ${why}`);
    }

    case "deny": {
      const refused = answers();
      if (refused !== null) return no(refused);
      return ok(
        {
          ...state,
          hold: null,
          stop: {
            kind: "blocked",
            why: `approval denied — ${why}`,
            at: nowIso,
            key: command.key,
            confirmation: stopConfirmationFor(
              identity.applier,
              ownerLiveness(context.loop, identity.worktree),
            ),
          },
        },
        `denied — ${why}`,
      );
    }

    case "arm-gate": {
      const phase = command.phase;
      if (phase === null) return no(`arm-gate needs a phase: one of ${PHASES.join(", ")}`);
      if (state.gates.some((gate) => gate.phase === phase)) return ok(state, `the gate before ${phase} was already armed`);
      const gate: ArmedGate = { phase, why: command.why, since: nowIso, key: command.key, asked: null };
      // Kept in phase order, so the record and the board list them the way
      // an iteration meets them.
      const gates = [...state.gates, gate].sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
      return ok({ ...state, gates }, `armed a gate before ${phase} — ${why}`);
    }

    case "disarm-gate": {
      const phase = command.phase;
      if (phase === null) return no(`disarm-gate needs a phase: one of ${PHASES.join(", ")}`);
      if (!state.gates.some((gate) => gate.phase === phase)) return ok(state, `no gate before ${phase} was armed`);
      // A question the gate already asked is left standing: disarming says
      // "stop asking", and the answer to the one waiting is still approve or deny.
      const waiting = state.hold?.kind === "approval" && state.hold.gate === gateName(phase);
      return ok(
        { ...state, gates: state.gates.filter((gate) => gate.phase !== phase) },
        `disarmed the gate before ${phase}${waiting ? "; the approval it is waiting on still needs an answer" : ""} — ${why}`,
      );
    }

    case "stop": {
      const confirmation = stopConfirmationFor(
        identity.applier,
        ownerLiveness(context.loop, identity.worktree),
      );
      return ok(
        {
          ...state,
          stop: { kind: command.stopKind, why, at: nowIso, key: command.key, confirmation },
        },
        `stopping (${command.stopKind}, ${confirmation}) — ${why}`,
      );
    }

    case "retry": {
      // Only a failure is retried. The ending is read the way the link reads
      // its evidence: the durable loop state first, then a stop on record.
      const ending = context.loop?.stopReason ?? state.stop ?? null;
      if (ending?.kind !== "failed") {
        return no(
          ending === null
            ? "nothing to retry: no attempt of this loop is recorded as failed"
            : `nothing to retry: the last attempt ended ${ending.kind} — ${ending.why}`,
        );
      }
      // One link per failure. The loop state keeps saying `failed` until a
      // supervisor starts again, so a second retry sent in that window would
      // otherwise open a second attempt past the same ending.
      const earlier = state.retries.find(
        (row) => row.evidence.outcome === "failed" && row.evidence.at === ending.at && row.evidence.why === ending.why,
      );
      if (earlier !== undefined) {
        return no(`already retrying past that failure as ${earlier.attempt}`);
      }
      const link = retryLink(state, command, context);
      return ok(
        {
          ...state,
          retries: [...state.retries, link],
          // A retry is a decision that the last attempt's ending is not the
          // run's ending, so it clears the stop it is retrying past. It does
          // NOT clear a pause: those are different instructions from possibly
          // different people, and "try again" has never meant "and unpause".
          stop: null,
          hold: state.hold?.kind === "approval" ? null : state.hold,
        },
        `retrying as ${link.attempt}${link.predecessor === null ? "" : ` after ${link.predecessor}`} — ${why}`,
      );
    }

    case "retry-phase": {
      // Only a loop parked between two phases has a phase to run again and a
      // session to leave: anywhere else the command would be carried out at
      // some later boundary, on work it was never about.
      const boundary = identity.applier === "supervisor" ? context.boundary : null;
      if (boundary === null) {
        return no("not held at a phase boundary: retry-phase applies only while the loop is parked between two phases — pause it at the next phase first");
      }
      if (boundary.after === null) return no(`the boundary before ${boundary.next} names no finished phase to retry`);
      if (state.hold === null) {
        return no(`not held at the boundary before ${boundary.next}: pause it at the next phase first, then retry the phase it finished`);
      }
      if (state.hold.phase !== undefined && state.hold.phase !== boundary.next) {
        return no(`the hold was taken before ${state.hold.phase}, not at this boundary before ${boundary.next}`);
      }
      const retried: PhaseRetry = { phase: boundary.after, next: boundary.next, at: nowIso, key: command.key, why };
      return ok(
        { ...state, hold: null, phaseRetries: [...state.phaseRetries, retried] },
        `retrying ${boundary.after} in a fresh session, then on to ${boundary.next} — ${why}`,
      );
    }

    case "abandon": {
      const issue = command.issue;
      if (issue === null) return no("abandon needs --issue: which claim to take back");
      const path = leasePathFromGit(context.root);
      // Asked before the label is touched, so an unexpired claim keeps its
      // label too; `reclaimClaim` asks again under the lock.
      const verdict = reclaimVerdict(readLeaseStore(path).leases[String(issue)], Date.now(), "abandon");
      if (!verdict.ok) {
        return verdict.outcome === "already"
          ? ok(state, `#${issue} was already free — ${verdict.why}`)
          : no(verdict.why);
      }
      // Unlocked between here and `reclaimClaim`: a frontier replacing the
      // lapsed lease in that window keeps its lease but can lose this label,
      // and the abandon is then refused as held. The lease still fences the
      // ticket, which is the property that matters; a lock held across a
      // network call would stall every claim writer instead.
      const cleared = removeClaimLabel(context.root, issue, verdict.lease.claim);
      if (!cleared.ok) {
        return no(`#${issue} not abandoned: could not remove ${verdict.lease.claim} — ${cleared.why}`);
      }
      const taken = reclaimClaim(path, issue, "abandon", Date.now());
      if (taken.outcome !== "reclaimed") {
        return taken.outcome === "already"
          ? ok(state, `#${issue} was already free — ${taken.why}`)
          : taken.outcome === "busy"
            ? later(taken.why)
            : no(taken.why);
      }
      const lease = taken.lease;
      // The ticket's phases went with its owner: a loop that claims it next
      // starts from the top, not from a ledger it never wrote.
      forgetPhases(issue, context.root, lease.worktree);
      return ok(
        {
          ...state,
          abandoned: [
            ...state.abandoned,
            {
              issue: lease.issue,
              run: lease.run,
              owner: lease.owner,
              worktree: lease.worktree,
              claimedAt: lease.claimedAt,
              expiredAt: lease.expiresAt,
              abandonedAt: nowIso,
              key: command.key,
            },
          ],
        },
        `abandoned #${lease.issue}, expired at ${lease.expiresAt} under ${lease.owner}`,
      );
    }

    case "release": {
      const issue = command.issue;
      if (issue === null) return no("release needs --issue: which claim to give up");
      // No early answer for an issue already on the record: a label left by
      // an earlier release, or a claim taken again since, is still this
      // command's to give back. Replays are the key fence's job, not this list's.
      const released = state.released.includes(issue) ? state.released : [...state.released, issue];
      const path = leasePathFromGit(context.root);
      const owner = { run: identity.run };
      const verdict = reclaimVerdict(readLeaseStore(path).leases[String(issue)], Date.now(), "release", owner);
      if (!verdict.ok && verdict.outcome === "held") return no(verdict.why);
      // With no lease left to name a label, the only one this run may take is
      // its own loop's: any other WIP label belongs to a claim it never held.
      const label = verdict.ok ? verdict.lease.claim : `${identity.loop}-wip`;
      const cleared = removeClaimLabel(context.root, issue, label);
      if (!cleared.ok) return no(`#${issue} not released: could not remove ${label} — ${cleared.why}`);
      // Given back, the ticket's phases are over: the label is gone, so no
      // iteration of this loop resumes it, and a later claim starts afresh.
      forgetPhases(issue, context.root, verdict.ok ? verdict.lease.worktree : null);
      if (!verdict.ok) {
        return ok(
          { ...state, released },
          cleared.removed
            ? `#${issue} had no claim lease; removed the leftover ${label}`
            : `#${issue} was already free — ${verdict.why}`,
        );
      }
      const given = reclaimClaim(path, issue, "release", Date.now(), owner);
      if (given.outcome === "busy") return later(given.why);
      if (given.outcome === "held") return no(given.why);
      return ok(
        { ...state, released },
        given.outcome === "reclaimed"
          ? `released #${issue}`
          : `#${issue} was already free — ${given.why}`,
      );
    }
  }
}

/**
 * Clear a given-up ticket's phase ledger and handoff notes (`ralph/phase.ts`)
 * in this worktree and in the one its lease was held from, which for an
 * abandon is another loop's. Best effort: `clearLedger` never throws, and a
 * ledger left behind is still checked against the worktree before a resume.
 */
function forgetPhases(issue: number, root: string, worktree: string | null): void {
  for (const where of new Set([resolve(root), ...(worktree ? [resolve(worktree)] : [])])) clearLedger(where, issue);
}

type LabelRemoval = { ok: true; removed: boolean } | { ok: false; why: string };

/**
 * Take one claim label off an issue, if it is there.
 *
 * Looked up first so a ticket without the label costs no edit, and so a label
 * the repository no longer has is not an error. Synchronous like the rest of
 * `apply`; `gh` resolves the repository from `root`, as the frontier does from
 * its own checkout.
 */
function removeClaimLabel(root: string, issue: number, label: string): LabelRemoval {
  // A Linear or Jira project's claim is on its own tracker (#334); GitHub keeps
  // the two `gh` calls below, argv for argv.
  const tracker = projectTrackerConfig(root);
  if (tracker !== null && tracker.kind !== "github") return removeTrackerLabel(root, issue, label);
  const gh = (args: string[]): { ok: true; stdout: string } | { ok: false; why: string } => {
    // Two calls must fit inside the dashboard's 30s recovery poll, or the page
    // shows a poll failure instead of this command's recorded outcome.
    const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
    if (result.error) return { ok: false, why: result.error.message };
    if (result.status !== 0) {
      return { ok: false, why: (result.stderr || result.stdout || `gh exited ${result.status}`).trim() };
    }
    return { ok: true, stdout: result.stdout };
  };
  const viewed = gh(["issue", "view", String(issue), "--json", "labels"]);
  if (!viewed.ok) return viewed;
  let labels: string[];
  try {
    const parsed = JSON.parse(viewed.stdout) as { labels?: { name?: unknown }[] };
    labels = (parsed.labels ?? []).map((row) => String(row.name));
  } catch {
    return { ok: false, why: `unreadable gh output: ${viewed.stdout.trim().slice(0, 200)}` };
  }
  if (!labels.includes(label)) return { ok: true, removed: false };
  const edited = gh(["issue", "edit", String(issue), "--remove-label", label]);
  return edited.ok ? { ok: true, removed: true } : edited;
}

/** `removeClaimLabel` through `tracker.ts`, under the same two-call budget. */
function removeTrackerLabel(root: string, issue: number, label: string): LabelRemoval {
  const viewed = runTrackerCli(root, ["view", String(issue), "--json"], { timeoutMs: 10_000 });
  if (!viewed.ok) return { ok: false, why: viewed.why };
  let labels: string[];
  try {
    labels = ((JSON.parse(viewed.stdout) as { labels?: unknown[] }).labels ?? []).map(String);
  } catch {
    return { ok: false, why: `unreadable tracker output: ${viewed.stdout.trim().slice(0, 200)}` };
  }
  if (!labels.includes(label)) return { ok: true, removed: false };
  const edited = runTrackerCli(root, ["label", "remove", String(issue), label], { timeoutMs: 10_000 });
  return edited.ok ? { ok: true, removed: true } : { ok: false, why: edited.why };
}

/**
 * The link a retry opens, and the evidence it preserves.
 *
 * Read from the durable record rather than from the command: an operator
 * asking for a retry knows which loop they are looking at and nothing else,
 * and asking them to type a session id is asking them to get it wrong.
 */
function retryLink(
  state: ControlState,
  command: ControlCommand,
  context: Context,
): RetryLink {
  const index = context.loop?.iteration?.index ?? 0;
  const predecessor = index > 0 ? attemptIdFor(context.identity.run, index) : null;
  return {
    attempt: attemptIdFor(context.identity.run, index + 1),
    predecessor,
    evidence: {
      iteration: index > 0 ? index : null,
      session: context.loop?.session ?? null,
      // `iteration-end` records the log path as its detail, which makes the
      // record the only place the failed attempt's transcript is named.
      log: context.loop?.lastEvent?.detail ?? null,
      outcome: context.loop?.stopReason?.kind ?? state.stop?.kind ?? null,
      why: context.loop?.stopReason?.why ?? state.stop?.why ?? null,
      at: context.loop?.stopReason?.at ?? state.stop?.at ?? null,
    },
    requestedAt: context.nowIso,
    key: command.key,
  };
}

/* --------------------------------------------------------------------------
 * One poll.
 * ----------------------------------------------------------------------- */

/** An inbox file to move aside once the record naming its outcome is written. */
export interface InboxSettlement {
  entry: Pick<InboxEntry, "name" | "stem" | "path">;
  outcome: InboxOutcome;
}

/**
 * What a settled command is offered to plugins as.
 *
 * `outcome` is the fence's, plus `carried-out` for a stop this supervisor
 * adopted from an earlier record and is now exiting on.
 */
export interface ControlSettled {
  key: string | null;
  command: Command;
  outcome: AppliedOutcome | "carried-out";
  why: string;
  via: string | null;
  issue: number | null;
  gate: string | null;
  /** The stop's confirmation as the record now holds it, when there is a stop. */
  confirmation: StopRequest["confirmation"] | null;
  /** Set when the channel gave up on a command a lock kept deferring. */
  givenUp: boolean;
  /** For an applied `retry`: the attempt it opened and the one it replaces. */
  attempt: string | null;
  retryOf: string | null;
}

export interface Polled {
  /** The phase retry this poll applied, which its verdict answers with; else null. */
  retry: PhaseRetry | null;
  state: ControlState;
  notices: string[];
  /**
   * Settled AFTER the state is written, never before: a file moved aside for a
   * command the record does not yet hold is a command lost to a crash, and one
   * left in place for a command it does hold is merely a replay.
   */
  settle: InboxSettlement[];
  /** Offered to plugins after the record is written, never before. */
  settled: ControlSettled[];
}

/**
 * The phase boundary a supervisor's poll is at: the phase about to start, and
 * the one just finished. Null for a poll between iterations.
 */
export interface PhaseBoundary {
  next: Phase;
  after: Phase | null;
}

export function pollOnce(
  root: string,
  identity: Identity,
  only: readonly Command[] | null = null,
  boundary: PhaseBoundary | null = null,
): Polled {
  const nowIso = new Date().toISOString();
  const previous = readControlState(root);

  // The record OUTLIVES the run. A pause an operator took is an instruction
  // about the work, and a supervisor restart — which the operator did not ask
  // for and may not know about — must not be a way to defeat it. So a new run
  // adopts the record, keeps the hold and the applied fence, and notes that
  // ownership moved so a refusal can cite it.
  //
  // A stop is adopted too, but only while it is UNCONFIRMED. That asymmetry is
  // the point: a stop nobody confirmed has not happened yet, and the new
  // supervisor is the first process able to carry it out — while a stop that
  // was confirmed is finished, and carrying it out twice would mean an
  // operator who deliberately ran `ralph/start.sh` again watched it exit at
  // its first checkpoint on last night's command, with only `retry` as an
  // undocumented way back.
  let state: ControlState =
    previous === null
      ? blankControlState(identity.run, identity.loop)
      : previous.ralphRun === identity.run
        ? previous
        : {
            ...previous,
            ralphRun: identity.run,
            loop: identity.loop,
            ownerChangedAt: nowIso,
            stop: previous.stop?.confirmation === "confirmed" ? null : previous.stop,
          };
  state = { ...state, lastPolledAt: nowIso };

  const context: Context = {
    root,
    identity,
    nowIso,
    loop: readJson(join(root, STATE_RELATIVE_PATH), parseLoopState),
    boundary,
    notices: [],
  };

  const retriesBefore = state.phaseRetries.length;
  const inbox = readLocalInbox(state, context, only, boundary);
  state = inbox.state;
  const settled = inbox.settled;
  // Only the supervisor's own checkpoint is a boundary a gate can ask at: an
  // operator's poll, or a recovery poll with `--only`, is at none.
  // A retry applied this poll leaves the boundary to run the finished phase
  // again, so the gate asks when that phase is done rather than now.
  if (identity.applier === "supervisor" && only === null && state.phaseRetries.length === retriesBefore) {
    state = gateAt(state, boundary, gatePassFor(identity, context.loop, state.phaseRetries.length), nowIso);
  }
  if (boundary !== null && identity.applier === "supervisor") state = atBoundary(state, boundary);

  // A stop this supervisor is about to carry out becomes a CONFIRMED one,
  // whoever recorded it. Without this an `unreachable` stop — one an operator
  // left for a loop nobody could find — stayed unreachable forever, so every
  // later `ralph/start.sh` in that worktree exited at its first checkpoint on
  // a command that had, by then, been obeyed several times. Confirmation is a
  // statement about a stop having been carried out, and this is the process
  // carrying it out.
  const stop = state.stop;
  if (identity.applier === "supervisor" && stop !== null && stop.confirmation !== "confirmed") {
    state = { ...state, stop: { ...stop, confirmation: "confirmed" } };
    context.notices.push(`carrying out a ${stop.confirmation} stop — ${stop.why}`);
    // Offered as its own settlement: this path is only ever an ADOPTED stop,
    // one nothing has answered yet, and whoever issued it has no other way to
    // learn that it finally took.
    settled.push({
      key: stop.key,
      command: "stop",
      outcome: "carried-out",
      why: `${identity.run} is exiting on a stop recorded ${stop.at} as ${stop.confirmation}: ${stop.why}`,
      via: null,
      issue: null,
      gate: null,
      confirmation: "confirmed",
      givenUp: false,
      attempt: null,
      retryOf: null,
    });
  }
  const retry = state.phaseRetries.length > retriesBefore ? (state.phaseRetries.at(-1) ?? null) : null;
  return { state, retry, notices: context.notices, settle: inbox.settle, settled };
}

/**
 * Apply what is waiting in the local inbox, and say which files are finished.
 *
 * Every file ends one of three ways. A command is applied through the fence —
 * the applied set, the run check, the deferral — and its file is settled with
 * whatever the fence now records for its key. A command that DEFERRED is not
 * in the fence, so its file stays where it is, and the next poll reading it
 * again is the retry. And a file that is not a command at all is settled as
 * `malformed` and said out loud, because a control channel that silently
 * dropped a file is one an operator cannot trust.
 */
function readLocalInbox(
  state: ControlState,
  context: Context,
  only: readonly Command[] | null,
  boundary: PhaseBoundary | null = null,
): { state: ControlState; settle: InboxSettlement[]; settled: ControlSettled[] } {
  const settle: InboxSettlement[] = [];
  const waiting: { entry: InboxEntry; command: ControlCommand }[] = [];
  for (const entry of readInbox(context.root)) {
    const command = entry.kind === "command" ? commandFromInbox(entry) : null;
    // Not this poll's to settle, malformed files included: the supervisor's
    // own poll reads everything and says so.
    if (only !== null && (command === null || !only.includes(command.command))) continue;
    // Left for the iteration boundary, unread: see `waitsForIteration`.
    if (command !== null && waitsForIteration(command, state, boundary)) continue;
    if (command === null) {
      // Already recorded by an earlier poll that could not move it: retry the
      // move quietly, rather than saying the same thing at every boundary.
      const earlier = settledOutcome(context.root, entry.stem);
      if (earlier !== null && earlier.outcome === "malformed" && earlier.key === null) {
        settle.push({ entry, outcome: earlier });
        continue;
      }
      const why = entry.kind === "malformed" ? entry.why : "not a control command";
      context.notices.push(`skipped ${entry.name} in the control inbox: ${why}`);
      settle.push({
        entry,
        outcome: { key: null, command: null, outcome: "malformed", why, at: context.nowIso },
      });
      continue;
    }
    // Moved aside by an earlier poll that died between writing its outcome
    // and moving the file. The outcome stands; only the move is left to do.
    const settled = settledOutcome(context.root, entry.stem);
    if (settled !== null && settled.key === command.key) {
      settle.push({ entry, outcome: settled });
      continue;
    }
    waiting.push({ entry, command });
  }

  const batch = applyBatch(
    state,
    waiting.map((row) => row.command),
    context,
  );
  for (const { entry, command } of waiting) {
    // The newest entry for the key: the fence is append-only and capped, so
    // that is the one this poll wrote, or the one an earlier poll did.
    const fenced = [...batch.state.applied].reverse().find((row) => row.key === command.key);
    if (fenced === undefined) continue;
    settle.push({
      entry,
      outcome: {
        key: fenced.key,
        command: fenced.command,
        outcome: fenced.outcome,
        why: fenced.why,
        at: fenced.at,
      },
    });
  }
  return { state: batch.state, settle, settled: batch.settled };
}

/**
 * Is this a command the phase boundary must leave for the iteration boundary?
 *
 * A scoped command of the default scope means "between iterations", and a
 * phase boundary is inside one: applying it here would put a hold or a stop on
 * the record, and on the board, that the loop is not going to act on until the
 * iteration ends. So it stays in the inbox, and the iteration boundary's poll
 * reads it exactly as it did before phases existed.
 *
 * Except while the loop is already held here. A parked loop is at a boundary
 * whatever the command meant, and an operator who stops a paused loop means
 * now, not after a resume they would have to send just to let it exit.
 */
export function waitsForIteration(
  command: ControlCommand,
  state: ControlState,
  boundary: PhaseBoundary | null,
): boolean {
  return (
    boundary !== null &&
    state.hold === null &&
    command.scope === "iteration" &&
    SCOPED_COMMANDS.includes(command.command)
  );
}

/**
 * The record once the supervisor answers at a phase boundary: a hold says
 * which phase it is held before, and a stop which phase it stopped before.
 *
 * Stamped only where nothing already is, so a hold that has been parked here
 * across several polls keeps the boundary it was first taken at, and a stop a
 * later boundary reads again still names the phase the iteration ended before.
 */
export function atBoundary(state: ControlState, boundary: PhaseBoundary): ControlState {
  const stamp = { phase: boundary.next, ...(boundary.after === null ? {} : { after: boundary.after }) };
  if (state.stop !== null) {
    return state.stop.phase === undefined ? { ...state, stop: { ...state.stop, phase: boundary.next } } : state;
  }
  if (state.hold !== null && state.hold.phase === undefined) {
    return { ...state, hold: { ...state.hold, ...stamp } };
  }
  return state;
}

/** The gate name an armed gate's approval hold carries, which `approve` and `deny` may name. */
export const gateName = (phase: Phase): string => `before-${phase}`;

/**
 * Which pass through a gate this is: the run and the iteration the loop state
 * records for it. A gate asks once per pass, so the answer to it — approve, or
 * a resume — is not followed by the same question at the same boundary, and
 * the next iteration, a later run, or the same boundary after a phase retry
 * is asked again.
 *
 * The top of an iteration still reads the previous iteration's index, which is
 * what makes a gate before `select` ask once per iteration too; a phase
 * boundary reads the current one.
 */
export function gatePassFor(identity: Pick<Identity, "run">, loop: LoopState | null, retries = 0): string {
  const index = loop?.run === identity.run ? loop.iteration?.index : undefined;
  // A phase retried since is new work to approve: the count makes it a new pass.
  return `${identity.run}#${index ?? "-"}${retries > 0 ? `+${retries}` : ""}`;
}

/**
 * The record once an armed gate has had its say at this boundary: an approval
 * hold before the phase it gates, or the record unchanged.
 *
 * `boundary` null is the iteration boundary, which is the one before `select`.
 * A gate never asks over a stop or another hold — a stop outranks it, and a
 * pause lifted at the same boundary lets the gate ask then — nor twice in one
 * pass. With no gate armed this is the identity, which is the whole of the
 * "unattended loops behave as before" guarantee.
 */
export function gateAt(
  state: ControlState,
  boundary: PhaseBoundary | null,
  pass: string,
  nowIso: string,
): ControlState {
  if (state.stop !== null || state.hold !== null) return state;
  const next = boundary?.next ?? "select";
  const gate = state.gates.find((row) => row.phase === next);
  if (gate === undefined || gate.asked === pass) return state;
  const name = gateName(next);
  return {
    ...state,
    gates: state.gates.map((row) => (row === gate ? { ...row, asked: pass } : row)),
    // Worded the way a decision gate is, so the board reads the question out
    // of it (`gateQuestion` in the dashboard's control adapter).
    hold: {
      kind: "approval",
      why: `decision gate ${name}: continue into ${next}?${gate.why === null ? "" : ` (${gate.why})`}`,
      since: nowIso,
      key: gate.key,
      gate: name,
      phase: next,
      ...(boundary?.after == null ? {} : { after: boundary.after }),
    },
  };
}

/**
 * Apply one batch of commands, in order.
 *
 * `settled` lists every command this batch finished, for plugins to hear
 * about — not replays, which were finished before, and not deferrals, which
 * are not finished yet.
 */
function applyBatch(
  initial: ControlState,
  commands: ControlCommand[],
  context: Context,
): { state: ControlState; settled: ControlSettled[] } {
  const { identity, nowIso } = context;
  let state = initial;
  const settled: ControlSettled[] = [];
  const said = (
    command: ControlCommand,
    outcome: AppliedOutcome,
    why: string,
    extra: Partial<ControlSettled> = {},
  ): void => {
    settled.push({
      key: command.key,
      command: command.command,
      outcome,
      why,
      via: command.via,
      issue: command.issue,
      gate: command.gate,
      confirmation: state.stop?.confirmation ?? null,
      givenUp: false,
      attempt: null,
      retryOf: null,
      ...extra,
    });
  };
  for (const command of commands) {
    const verdict = commandVerdict(state, command, identity);
    if (!verdict.accept) {
      if (verdict.outcome === "replayed") continue;
      // Remembered so it is refused once rather than on every poll.
      state = remember(state, {
        key: command.key,
        command: command.command,
        at: nowIso,
        outcome: verdict.outcome,
        why: verdict.why,
      });
      if (verdict.outcome === "needs-reconfirmation") {
        context.notices.push(`refused ${command.command}: ${verdict.why}`);
      }
      said(command, verdict.outcome, verdict.why);
      continue;
    }
    const applied = apply(state, command, context);
    context.notices.push(`${command.command}: ${applied.why}`);
    if (applied.outcome === "deferred") {
      const waited = deferring(state, command, applied.why, nowIso, context);
      state = waited.state;
      // Below the limit the command's file is left where it is so it comes
      // back. At it, the command is remembered as refused and let go — see
      // `DEFERRAL_LIMIT` for why holding out for ever is the worse failure.
      if (!waited.givenUp) continue;
      state = remember(state, {
        key: command.key,
        command: command.command,
        at: nowIso,
        outcome: "refused",
        why: waited.why,
      });
      said(command, "refused", waited.why, { givenUp: true });
      continue;
    }
    state = remember(applied.state, {
      key: command.key,
      command: command.command,
      at: nowIso,
      outcome: applied.outcome,
      why: applied.why,
    });
    const link =
      command.command === "retry" && applied.outcome === "applied"
        ? (state.retries[state.retries.length - 1] ?? null)
        : null;
    said(command, applied.outcome, applied.why, {
      attempt: link?.attempt ?? null,
      retryOf: link?.predecessor ?? null,
    });
  }
  return { state, settled };
}

/**
 * Record one more failed attempt at a command, and decide whether the channel
 * should keep waiting for it.
 *
 * Only one thing happens here that an operator sees, and it is at the limit:
 * the loop says what is stuck and how to unstick it, and stops waiting for it.
 * Below the limit a deferral is silent, because below the limit it is ordinary
 * lock contention and saying so on every collision would be noise.
 */
function deferring(
  state: ControlState,
  command: ControlCommand,
  why: string,
  nowIso: string,
  context: Context,
): { state: ControlState; givenUp: boolean; why: string } {
  const previous = state.deferrals.find((row) => row.key === command.key);
  const attempts = (previous?.attempts ?? 0) + 1;
  const deferral: Deferral = {
    key: command.key,
    command: command.command,
    since: previous?.since ?? nowIso,
    attempts,
  };
  const others = state.deferrals.filter((row) => row.key !== command.key);
  if (attempts < DEFERRAL_LIMIT) {
    return { state: { ...state, deferrals: [...others, deferral] }, givenUp: false, why };
  }
  const said = `${command.command} was waiting from ${deferral.since} and has been given up after ${attempts} attempts — ${why}. The lease store's lock may have been left behind by a process that died: check next-tasks-claim.lock in the Git common directory, then issue the command again.`;
  context.notices.push(said);
  // Dropped from the deferral list at the same moment: it is remembered as a
  // refusal by the caller, and an entry left here would report a command as
  // still waiting when nothing is waiting for it any more.
  return { state: { ...state, deferrals: others }, givenUp: true, why: said };
}

/** The `control` events a poll offers plugins, one per settled command. */
export function controlEvents(root: string, identity: Identity, settled: ControlSettled[]): PluginEvent[] {
  return settled.map((row) => ({
    ...baseEvent(root, "control"),
    run: identity.run,
    loop: identity.loop,
    control: { ...row },
  }));
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

/** One line, for `ralph/status.sh` and for the supervisor's startup banner. */
export function lineFor(state: ControlState | null): string {
  if (state === null) return "Controls: listening — nothing issued yet";
  if (state.stop !== null) {
    const before = state.stop.phase === undefined ? "" : ` before ${state.stop.phase}`;
    return `Controls: stop (${state.stop.kind}, ${state.stop.confirmation})${before} — ${state.stop.why}`;
  }
  if (state.hold !== null) {
    const before = state.hold.phase === undefined ? "" : ` held before ${state.hold.phase},`;
    return `Controls: ${state.hold.kind}${before} since ${state.hold.since} — ${state.hold.why}`;
  }
  const parts: string[] = ["running"];
  if (state.retries.length > 0) {
    const last = state.retries[state.retries.length - 1]!;
    parts.push(`last retry ${last.attempt}${last.predecessor ? ` after ${last.predecessor}` : ""}`);
  }
  if (state.abandoned.length > 0) parts.push(`${state.abandoned.length} claim(s) abandoned`);
  if (state.gates.length > 0) parts.push(`gated before ${state.gates.map((gate) => gate.phase).join(", ")}`);
  for (const waiting of state.deferrals) {
    parts.push(
      `${waiting.command} waiting since ${waiting.since} (${waiting.attempts}/${DEFERRAL_LIMIT})`,
    );
  }
  return `Controls: ${parts.join(", ")}`;
}

/**
 * `--phase <next> [--after <finished>]`, or null for a poll between iterations.
 * A phase nobody can read is a fault — exit 1, which `ralph.sh` reads as
 * continue — rather than a guess at which boundary this is.
 */
function phaseBoundaryIn(argv: string[]): PhaseBoundary | null {
  if (!argv.includes("--phase")) return null;
  const next = flagValue(argv, "phase");
  const after = flagValue(argv, "after");
  if (!isPhase(next)) throw new Error(`--phase must be one of ${PHASES.join(", ")}; got '${next ?? ""}'`);
  if (after !== null && !isPhase(after)) throw new Error(`--after must be one of ${PHASES.join(", ")}; got '${after}'`);
  return { next, after };
}

function runPoll(root: string, argv: string[]): number {
  const identity = identityFor(root, applierFor(argv));
  const at = argv.indexOf("--only");
  const only = at === -1 ? null : (argv[at + 1] ?? "").split(",").filter(isCommand);
  // A typo must not read as "nothing to do": say so, and apply nothing.
  if (only !== null && only.length === 0) {
    throw new Error(`--only needs a comma-separated list of ${COMMANDS.join(", ")}`);
  }
  const boundary = phaseBoundaryIn(argv);
  if (only !== null && identity.applier === "operator") {
    const loop = readJson(join(root, STATE_RELATIVE_PATH), parseLoopState);
    if (ownerLiveness(loop, identity.worktree) === "alive") {
      console.error(`controls: a supervisor (pid ${loop?.owner.pid}) is running this loop; it applies the inbox itself`);
      return BUSY_EXIT;
    }
  }
  // Plugins deliver first, so what they write this poll is applied this poll.
  // Bounded and never fatal: the host records a plugin that hangs or crashes
  // against the plugin, and this poll reads the inbox either way.
  offer(root, "inbox", { run: identity.run, loop: identity.loop, worktree: identity.worktree });
  const { state, retry, notices, settle, settled } = pollOnce(root, identity, only, boundary);
  writeJsonAtomically(join(root, CONTROL_STATE_RELATIVE_PATH), state);
  for (const { entry, outcome } of settle) {
    const failed = settleInboxEntry(root, entry, outcome);
    if (failed !== null) notices.push(failed);
  }
  // Only once the record is written and the files moved: a plugin told about
  // a command the record does not hold would be answering for one that a
  // crash here could still lose.
  offerEvents(root, controlEvents(root, identity, settled));
  // Read after the inbox, so a resume and a wake that cross each other both
  // count: the loop goes on only once neither its own hold nor the project's
  // sleep stands.
  // `--in-iteration` is the supervisor's checkpoint between two turns of one
  // iteration (held for the host): not a phase boundary, but not between
  // iterations either, so the sleep lets it go on like a phase poll does.
  // And only the supervisor's own poll: an operator's (the dashboard's
  // recovery poll of a loop whose supervisor is gone) is about the inbox, and
  // a hold there would misreport the abandon or release it was run for.
  const betweenIterations =
    identity.applier === "supervisor" && boundary === null && !argv.includes("--in-iteration");
  const verdict = sleepingVerdict(
    verdictFor(state, retry),
    betweenIterations,
    betweenIterations ? projectSleep(root) : null,
  );
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ verdict, notices, state }, null, 2));
  } else {
    // The machine line first, always, and tab-separated: `ralph.sh` reads it
    // with `IFS=$'\t' read`, and a line that moved would be read as a field.
    console.log(`${verdict.action}\t${verdict.detail}\t${verdict.why}`);
    for (const notice of notices) console.log(notice);
  }
  return EXIT_FOR[verdict.action];
}

/* --------------------------------------------------------------------------
 * A stop an operator carried out with a signal.
 * ----------------------------------------------------------------------- */

/**
 * The control record once an interrupted stop is written into it: confirmed,
 * with what it cut short, and fenced under its key like any command, so the
 * dashboard reads it back the way it reads every other answer.
 */
export function interruptedState(
  state: ControlState,
  stop: { key: string; why: string; nowIso: string; iteration: number | null; issue: number | null },
): ControlState {
  const said = `interrupted${stop.iteration === null ? "" : ` in iteration ${stop.iteration}`}${stop.issue === null ? "" : ` on #${stop.issue}`} — ${stop.why}`;
  return remember(
    {
      ...state,
      stop: {
        kind: "interrupted",
        why: stop.why,
        at: stop.nowIso,
        key: stop.key,
        confirmation: "confirmed",
        iteration: stop.iteration,
        issue: stop.issue,
      },
    },
    { key: stop.key, command: "stop", at: stop.nowIso, outcome: "applied", why: said },
  );
}

/** The ticket `run` holds for this worktree, from the lease store; null for none. */
function heldTicket(root: string, run: string): number | null {
  let leases;
  try {
    leases = Object.values(readLeaseStore(leasePathFromGit(root)).leases);
  } catch {
    return null;
  }
  const mine = leases
    .filter((lease) => lease.run === run && resolve(lease.worktree) === resolve(root))
    .sort((a, b) => a.issue - b.issue);
  return mine[0]?.issue ?? null;
}

function flagValue(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : text(argv[at + 1]);
}

/**
 * Write down a Stop now once its signal has taken effect: the control record's
 * confirmed `interrupted` stop, and the loop state's ending. Both writes are
 * idempotent under the key, so a re-issue after a crash between them finishes
 * the job rather than doubling it. Exit 75 while the owner is alive.
 */
function runInterrupted(root: string, argv: string[]): number {
  const key = flagValue(argv, "key");
  const why = flagValue(argv, "why");
  if (key === null || why === null) throw new Error("interrupted needs --key <id> and --why <reason>");
  const identity = identityFor(root, "operator");
  const loop = readJson(join(root, STATE_RELATIVE_PATH), parseLoopState);
  if (loop === null) throw new Error("no loop state in this worktree: there is no run to record as interrupted");
  if (loop.run !== identity.run) {
    throw new Error(`the loop state belongs to run ${loop.run}, not ${identity.run}; nothing was recorded`);
  }
  const self = flagValue(argv, "self");
  if (self !== null) {
    if (String(loop.owner.pid) !== self) {
      throw new Error(`the loop state's owner is pid ${String(loop.owner.pid)}, not ${self}; nothing was recorded`);
    }
  } else {
    const owner = ownerLiveness(loop, identity.worktree);
    if (owner === "alive") {
      console.error(`controls: a supervisor (pid ${loop.owner.pid}) is still running this loop; nothing was recorded`);
      return BUSY_EXIT;
    }
    if (owner === "unknown") {
      throw new Error("cannot tell whether the loop's supervisor is gone, so the stop cannot be confirmed");
    }
  }
  const nowIso = new Date().toISOString();
  // The loop state names this run, so a control record naming another is an
  // earlier run's that this one had not polled yet. It is adopted as a poll
  // adopts it: the hold and the fence kept, a finished stop dropped.
  const previous = readControlState(root);
  const current =
    previous === null
      ? blankControlState(identity.run, identity.loop)
      : previous.ralphRun === identity.run
        ? previous
        : {
            ...previous,
            ralphRun: identity.run,
            loop: identity.loop,
            ownerChangedAt: nowIso,
            stop: previous.stop?.confirmation === "confirmed" ? null : previous.stop,
          };
  const replay = current.applied.some((entry) => entry.key === key);
  const state = replay
    ? current
    : interruptedState(current, {
        key,
        why,
        nowIso,
        iteration: loop.iteration?.index ?? null,
        issue: heldTicket(root, identity.run),
      });
  if (state !== previous) writeJsonAtomically(join(root, CONTROL_STATE_RELATIVE_PATH), state);
  // The loop state keeps the run and the owner it already names: the owner
  // is the supervisor that was stopped, not this process. A Stop now's SIGTERM
  // fires the supervisor's trap first, so an `interrupted` ending already
  // there is the trap's, and the operator's reason is the one worth keeping.
  // A replay under a key already applied changes neither record.
  const replaces = loop.stopReason?.kind === "interrupted" && self === null && !replay;
  const signal = flagValue(argv, "signal");
  if (loop.stopReason === null || replaces) {
    const detail = self === null ? `stopped now by an operator (${key})` : `stopped by a signal (${key})`;
    writeState(
      join(root, STATE_RELATIVE_PATH),
      applyRecord(
        loop,
        {
          event: "interrupted",
          detail,
          stop: {
            kind: "interrupted",
            why,
            self: self !== null,
            ...(signal !== null && self !== null ? { signal } : {}),
          },
        },
        { run: loop.run, loop: loop.owner.loop, pid: loop.owner.pid, host: loop.owner.host, worktree: loop.worktree },
        nowIso,
      ),
    );
  }
  console.log(JSON.stringify({ stop: state.stop }, null, 2));
  return 0;
}

function runStatus(root: string, argv: string[]): void {
  const state = readControlState(root);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(lineFor(state));
  if (!argv.includes("--line")) {
    // Not on `--line`: that one is a single line, and `status.sh` reads it so.
    const asleep = projectSleep(root);
    if (asleep !== null) console.log(`Project: asleep — ${sleepReason(asleep)}`);
    for (const entry of state?.applied.slice(-3) ?? []) {
      console.log(`  ${entry.at} ${entry.command} — ${entry.outcome}: ${entry.why}`);
    }
  }
}

function main(): number {
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  process.chdir(root);
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "poll") return runPoll(root, argv.slice(1));
  if (command === "interrupted") return runInterrupted(root, argv.slice(1));
  runStatus(root, argv.slice(command === "status" ? 1 : 0));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    // Reported, never fatal, and never a hold: an exception in the control
    // channel must read as "no control", not as "stop". `ralph.sh` treats any
    // status but 10 and 20 as continue, and this is the path that produces it.
    console.error(`controls: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
