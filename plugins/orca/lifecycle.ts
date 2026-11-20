#!/usr/bin/env bun
/**
 * The loop's lifecycle, mirrored into Orca's orchestration graph.
 *
 * `ralph/loop-state.ts` answers "what is this loop doing?" for an operator who
 * is already in the worktree with a terminal open. Orca is where the same
 * operator actually looks: it is the thing showing every worktree on the
 * machine, and until now a Ralph or Rafa loop was invisible in it — a terminal
 * running something, in a checkout with a branch, and nothing else. The board
 * could not say which loop that was, which ticket it had taken, which
 * iteration was burning money, or whether the supervisor behind it had died an
 * hour ago.
 *
 * So every event the supervisor already records durably is *also* mirrored
 * here — handed over by the plugin host's `on-event` hook — onto the nouns
 * Orca already has:
 *
 *   Run       one supervisor invocation — `RALPH_RUN_ID`, the same id the usage
 *             ledger and the supervisor log key on.
 *   Task      one selected ticket, taken from the CLAIM LEASE rather than from
 *             the branch — see `ticketFor` for why the branch cannot answer
 *             this on the loop's most common path. A task is created when a
 *             ticket is taken, not once per iteration; an iteration that
 *             selected nothing has no task, which is the truth.
 *   Dispatch  one attempt on that ticket: one iteration, one runner
 *             invocation, attributable to the terminal it ran in.
 *   Terminal  `ORCA_TERMINAL_HANDLE` — the pane the supervisor was started
 *             from, inherited through `nohup` into every child.
 *   heartbeat what moves while `claude -p` holds a turn open and nothing else
 *             on disk does — which needs a timer, not a boundary, so the host
 *             offers a `pulse` event on one while the supervisor lives.
 *
 * Four properties are what make this safe to leave running:
 *
 * 1. **It mirrors; it never places.** Orca is told what happened, and is never
 *    asked to start anything. `worker-start`, `dispatch --inject` and
 *    `terminal send` are the three commands that would put an Orca-launched
 *    process — with Orca's permissions — where the loop's own runner belongs,
 *    and none of them is reachable from here: the verb allowlist below refuses
 *    them, so the Claude Code, OpenCode and read-only review fences in
 *    `ralph/delegate.sh` and `ralph/inspect.sh` stay the only thing deciding
 *    what a runner may do. The one destructive-sounding verb that IS used —
 *    `worker-stop` — performs no process action on an unsupervised dispatch;
 *    it fences the record and says so (`processAction: "none"`).
 *
 * 2. **Late events from replaced attempts are rejected.** Two fences, because
 *    the two ways a straggler arrives are different: an event carrying another
 *    run's `RALPH_RUN_ID` is a previous supervisor's, and an event carrying an
 *    older iteration index or a stale `RALPH_SESSION_ID` is a replaced
 *    attempt's. Both are refused *before* any Orca call, so a dead iteration
 *    cannot report progress on a live one's dispatch. Orca fences the same
 *    thing from its side — a `worker_done` for a settled dispatch comes back
 *    `inactive_dispatch` — and neither side is trusted to be the only one.
 *
 * 3. **Orca being unavailable is a degraded mode, not a failure.** No Orca
 *    CLI, no Orca terminal, a runtime that is not up, a call that times out:
 *    every one of them is recorded as a reason with a retry time and the loop
 *    continues untouched. A supervisor must never stop, wait, or gain
 *    permissions because a display was not there — the mirror is a display.
 *
 * 4. **It cannot fail a loop.** The plugin host bounds it, discards its output
 *    and records a failure against the plugin, and this file holds up its end
 *    anyway: every path exits 0, every subprocess is bounded, and a degraded
 *    mirror backs off rather than paying its timeout on every poll of a
 *    frontier gate.
 *
 * Usage (the plugin's `on-event` hook calls `mirrorEvent` and `heartbeat`;
 * these are for an operator or a test):
 *   plugins/orca/lifecycle.ts record --event <name> [--stage <stage>]
 *                                    [--iteration N] [--max N]
 *                                    [--stop <completed|blocked|failed>]
 *                                    [--why …] [--detail …]
 *   plugins/orca/lifecycle.ts heartbeat
 *   plugins/orca/lifecycle.ts status [--json | --line]
 *
 * `record` takes the flags `loop-state.ts record` takes, unchanged.
 * `RALPH_ORCA_LIFECYCLE=0` turns the mirror off entirely.
 */

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { currentLoop } from "../../frontier/next-tasks";
import { leasePathFromGit, readLeaseStore } from "../../claim-lease";
import {
  STAGES,
  STOP_KINDS,
  branchOf,
  writeJsonAtomically,
  type Stage,
  type StopKind,
} from "../../loop-state";
import { observeRun, presenceSummary } from "../../observe";
import { projectRoot } from "../../paths";
import type { PluginEvent } from "../../plugins";
import { resolveOrcaConsumer } from "./binding";
import { invokeOrca, type Called } from "./cli";
export { invokeOrca, type Called } from "./cli";

/** Where the mirror keeps its own record. Beside the durable loop state. */
export const ORCA_STATE_RELATIVE_PATH = ".ralph/logs/orca-lifecycle.json";

/**
 * How long the mirror stays quiet after Orca could not be reached.
 *
 * The reason this is not zero: a frontier-gated supervisor records a wait on
 * every poll, and paying a 15s timeout per poll would make an absent Orca cost
 * more than the thing it is mirroring. A minute is short enough that an Orca
 * started while the loop is running is picked up on the next event.
 */
const DEFAULT_RETRY_MS = 60_000;

/**
 * The verbs this mirror may run, and the reason it is a list rather than a
 * convention.
 *
 * The commands NOT here are the point. `orchestration worker-start` and
 * `orchestration dispatch --inject` both put a process where the loop's own
 * runner belongs, launched by Orca, under Orca's permissions rather than the
 * runner-specific fences `ralph/delegate.sh` and `ralph/inspect.sh` apply; and
 * `terminal send` types into a pane an iteration is using. A mirror that grew
 * one of those by accident would quietly widen what the loop can do, which is
 * exactly the failure this file must not have. So the guard is mechanical: an
 * unlisted verb throws before it is spawned.
 */
export const ALLOWED_VERBS = [
  "orchestration run-current",
  "orchestration run-use",
  "orchestration run-create",
  "orchestration task-create",
  "orchestration task-update",
  "orchestration dispatch",
  "orchestration send",
  "orchestration worker-stop",
  "orchestration worker-abandon",
] as const;
export type AllowedVerb = (typeof ALLOWED_VERBS)[number];

/** Flags that would turn a record into a placement. Refused with the verbs. */
export const FORBIDDEN_ARGS = ["--inject"] as const;

/* --------------------------------------------------------------------------
 * The record.
 * ----------------------------------------------------------------------- */

export interface MirroredAttempt {
  /** The iteration index this attempt is, as `ralph.sh` counts them. */
  index: number;
  /** `RALPH_SESSION_ID` — the token that tells a replacement from a straggler. */
  session: string | null;
  /** Null until a task exists to attach it to; see `TASK IS THE TICKET` below. */
  dispatch: string | null;
  /** Whether the runner's turn has ended. An ended attempt is settled next. */
  ended: boolean;
}

export interface MirroredTask {
  /** The GitHub issue this loop selected, read off the branch it created. */
  issue: number;
  id: string;
}

export interface Degraded {
  why: string;
  at: string;
  /** ISO 8601. Orca is not called again before this. */
  retryAt: string;
}

export interface AdapterState {
  /** Bumped only for a shape change a reader cannot absorb. */
  version: 1;
  /** `RALPH_RUN_ID`; the fence every non-iteration event is checked against. */
  ralphRun: string;
  loop: string;
  worktree: string;
  /** The Orca terminal the supervisor was started from, if there was one. */
  terminal: string | null;
  orcaRun: string | null;
  task: MirroredTask | null;
  attempt: MirroredAttempt | null;
  degraded: Degraded | null;
  /**
   * A Run this terminal was bound to before the loop's own Run displaced it.
   *
   * Only ever set for a supervisor started by hand from a pane that was
   * already coordinating something else; `ralph/start.sh` gives a loop its own
   * pane, where there is nothing to displace. Kept so the panel can print the
   * one command that puts it back.
   */
  displacedBinding: string | null;
  /** The last straggler this mirror refused, kept because it is evidence. */
  lastRejected: { event: string; why: string; at: string } | null;
  lastEvent: { name: string; at: string } | null;
}

/**
 * Read a record back, treating every unusable file as no record at all.
 *
 * Same contract as `parseLoopState`: this file is written by a mirror running
 * inside a supervisor that can be killed mid-write, and a reader that threw on
 * a truncated one would take the mirror down for the rest of the run.
 */
export function parseAdapterState(raw: string): AdapterState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1) return null;
  if (typeof value.ralphRun !== "string" || value.ralphRun === "") return null;
  const text = (key: string): string | null =>
    typeof value[key] === "string" ? (value[key]) : null;
  const attempt = ((): MirroredAttempt | null => {
    const raw = value.attempt;
    if (typeof raw !== "object" || raw === null) return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.index !== "number" || !Number.isInteger(a.index)) return null;
    return {
      index: a.index,
      session: typeof a.session === "string" ? a.session : null,
      dispatch: typeof a.dispatch === "string" ? a.dispatch : null,
      ended: a.ended === true,
    };
  })();
  const task = ((): MirroredTask | null => {
    const raw = value.task;
    if (typeof raw !== "object" || raw === null) return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.issue !== "number" || typeof t.id !== "string") return null;
    return { issue: t.issue, id: t.id };
  })();
  const degraded = ((): Degraded | null => {
    const raw = value.degraded;
    if (typeof raw !== "object" || raw === null) return null;
    const d = raw as Record<string, unknown>;
    if (typeof d.why !== "string" || typeof d.retryAt !== "string") return null;
    return { why: d.why, at: typeof d.at === "string" ? d.at : d.retryAt, retryAt: d.retryAt };
  })();
  return {
    version: 1,
    ralphRun: value.ralphRun,
    loop: text("loop") ?? "ralph",
    worktree: text("worktree") ?? "",
    terminal: text("terminal"),
    orcaRun: text("orcaRun"),
    task,
    attempt,
    degraded,
    displacedBinding: text("displacedBinding"),
    lastRejected: ((): AdapterState["lastRejected"] => {
      const raw = value.lastRejected;
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      if (typeof r.event !== "string" || typeof r.why !== "string") return null;
      return { event: r.event, why: r.why, at: typeof r.at === "string" ? r.at : "" };
    })(),
    lastEvent: ((): AdapterState["lastEvent"] => {
      const raw = value.lastEvent;
      if (typeof raw !== "object" || raw === null) return null;
      const e = raw as Record<string, unknown>;
      if (typeof e.name !== "string") return null;
      return { name: e.name, at: typeof e.at === "string" ? e.at : "" };
    })(),
  };
}

/**
 * The typed door onto the shared atomic write.
 *
 * A wrapper rather than a direct call at each site so this file's writes are
 * checked against `AdapterState` — `writeJsonAtomically` takes `unknown`,
 * which is right for a helper two records share and wrong for the one place
 * that knows the shape.
 */
export function writeAdapterState(path: string, state: AdapterState): void {
  writeJsonAtomically(path, state);
}

/* --------------------------------------------------------------------------
 * Pure decisions. Everything below is testable without an Orca on the machine.
 * ----------------------------------------------------------------------- */

export interface LifecycleEvent {
  name: string;
  /**
   * The supervisor's own stage and stop kind, from `loop-state.ts`'s rosters
   * rather than from a `string` here.
   *
   * Both mirrors are fed by one `record()` call site, and `loop-state.ts`
   * refuses a value outside its roster rather than writing one — so a mirror
   * that accepted `--stop notakind` would report a success (anything that is
   * not `failed` settles as `succeeded`) for an event the other mirror threw
   * away. Two mirrors of one run must not be able to disagree about whether it
   * ended well.
   */
  stage?: Stage;
  iteration?: number;
  max?: number | null;
  stop?: StopKind;
  why?: string;
  detail?: string;
  /** `RALPH_RUN_ID` at the moment the event was emitted. */
  run: string;
  /** `RALPH_SESSION_ID` at the moment the event was emitted, when inside one. */
  session: string | null;
}

/**
 * Which issue this loop has taken, read off the branch.
 *
 * `ralph/prompt.md` fixes the branch shape — `<loop>/<issue>`, optionally with
 * a slug — so a branch is evidence of a claim. Anything else (`main`, a
 * detached HEAD between iterations, the other loop's branch) is *no ticket
 * here*, never a guess: a mirror that guessed would file an attempt against a
 * ticket this loop never claimed.
 *
 * This is the SECOND source, not the first — see `ticketFor`. The branch is
 * transient, and the moment it matters most is the moment it is already gone.
 */
export function issueFromBranch(branch: string | null, loop: string): number | null {
  if (branch === null) return null;
  const match = new RegExp(`^${loop}/(\\d+)(?:-|$)`).exec(branch.trim());
  if (match === null) return null;
  const issue = Number(match[1]);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
}

/**
 * TASK IS THE TICKET: which ticket this run holds, and why the branch alone
 * could never answer it.
 *
 * The supervisor never learns the ticket number directly — the iteration
 * selects and claims it several layers down, inside a turn the supervisor only
 * sees the exit of. Sampling the branch at the two boundaries around that turn
 * looks like it should work, and on the loop's most common path it never does:
 * `prompt.md` §7 ends a finished ticket with `git switch --detach origin/main`
 * BEFORE the iteration returns. So a ticket taken and completed in one
 * iteration is on `<loop>/<issue>` at no instant the supervisor ever looks —
 * `iteration-start` is too early and `iteration-end` is too late — and the
 * whole Task/Dispatch half of this mirror silently produced nothing at all.
 *
 * The claim lease is the durable answer the branch is not. `next-tasks.ts`
 * writes it at claim time, keyed by issue and stamped with the claiming
 * `RALPH_RUN_ID`, into Git's common directory — so it survives the detach, the
 * iteration, and the worktree. Asking it "what does THIS run hold?" is exactly
 * the question, and it is answered locally.
 *
 * The branch stays as the fallback: a lease store that is missing, unreadable,
 * or from before this mechanism existed must not blank the board for a loop
 * that is plainly working on `ralph/702`.
 */
export function ticketFor(root: string, identity: Identity): number | null {
  return ticketFromLeases(root, identity) ?? issueFromBranch(identity.branch, identity.loop);
}

/** The newest ticket this run claimed, or null. Never throws: a lease store
 *  that cannot be read is one more absent source, not a fault. */
function ticketFromLeases(root: string, identity: Identity): number | null {
  try {
    const leases = Object.values(readLeaseStore(leasePathFromGit(root)).leases).filter(
      (lease) => lease.run === identity.run && lease.loop === identity.loop,
    );
    if (leases.length === 0) return null;
    const newest = leases.reduce((a, b) =>
      Date.parse(b.claimedAt) > Date.parse(a.claimedAt) ? b : a,
    );
    return Number.isSafeInteger(newest.issue) && newest.issue > 0 ? newest.issue : null;
  } catch {
    return null;
  }
}

export type Verdict =
  | { accept: true; restart: boolean }
  | { accept: false; why: string };

/**
 * Should this event be mirrored at all?
 *
 * The fence, and the reason it is here rather than left to Orca: a straggler
 * refused by Orca has already cost a subprocess and a network round trip, and
 * — worse — a straggler whose dispatch has NOT yet been fenced would be
 * accepted by Orca and reported as the live attempt's progress. The mirror has
 * the one fact Orca does not: which attempt this supervisor considers current.
 *
 * `supervisor-start` is the exception in both directions. It is always
 * accepted, because a new supervisor is entitled to replace the record; and it
 * is the only event that may, because every other event claiming an unknown
 * run is by definition from a supervisor this one replaced.
 */
export function fenceVerdict(previous: AdapterState | null, event: LifecycleEvent): Verdict {
  if (event.name === "supervisor-start") {
    return { accept: true, restart: previous?.ralphRun !== event.run };
  }
  if (previous === null) {
    // No record and not a start: the mirror was enabled, or its file removed,
    // mid-run. Adopt the run rather than refuse — refusing would blank the
    // board for the rest of a loop that is working fine.
    return { accept: true, restart: true };
  }
  if (previous.ralphRun !== event.run) {
    return { accept: false, why: `run ${event.run} was replaced by ${previous.ralphRun}` };
  }
  const attempt = previous.attempt;
  if (event.iteration === undefined || attempt === null) return { accept: true, restart: false };
  if (event.iteration < attempt.index) {
    return {
      accept: false,
      why: `iteration ${event.iteration} was replaced by iteration ${attempt.index}`,
    };
  }
  if (
    event.iteration === attempt.index &&
    attempt.session !== null &&
    event.session !== null &&
    event.session !== attempt.session
  ) {
    return {
      accept: false,
      why: `session ${event.session} was replaced by ${attempt.session} on iteration ${attempt.index}`,
    };
  }
  return { accept: true, restart: false };
}

/**
 * How an open attempt ends, given the event that arrived after it.
 *
 * The supervisor cannot report an outcome at `iteration-end`: it records that
 * boundary *before* it greps the log for a sigil, so at that instant nobody
 * knows whether the iteration worked or died. The next event does know — it is
 * either a failure stop (`needs-triage`, `no-sigil`, a broken gate) or the
 * loop carrying on, which only happens past a `DONE`. So an attempt is settled
 * one event late, by what that event turned out to be, rather than optimistically
 * at the boundary.
 */
export function settlementFor(event: LifecycleEvent): "succeeded" | "failed" {
  return event.stop === "failed" ? "failed" : "succeeded";
}

/**
 * Which task status a stopped loop has to say out loud about a ticket it is
 * still holding.
 *
 * `blocked`, in both the endings that are not a failure. A ticket the loop
 * stopped on top of is not finished and not broken — it is claimed, unworked
 * and waiting for whoever looks next, which is what `blocked` means here and
 * what an operator has to see to pick it up.
 *
 * A failure stop says so through the attempt's own `worker_done --outcome
 * failed`, which settles dispatch and task together; the guide is explicit
 * that a manual `task-update` must not follow a valid one. And a loop that had
 * already left the ticket says nothing at all — the report that released it
 * settled it.
 */
export function taskStatusFor(stop: string | undefined, onTicket: boolean): string | null {
  if (!onTicket || stop === undefined || stop === "failed") return null;
  return "blocked";
}

/**
 * The phase name a heartbeat carries. The supervisor's own stage where it gave
 * one, the event name where it did not — an event with no stage is a boundary
 * rather than a state, and naming it is more useful than naming its neighbour.
 */
export function phaseFor(event: LifecycleEvent): string {
  return event.stage ?? event.name;
}

/* --------------------------------------------------------------------------
 * The Orca CLI seam.
 * ----------------------------------------------------------------------- */

/**
 * The refusals that mean the fence already did its work.
 *
 * Matched exactly, against codes actually observed from the runtime rather
 * than against a pattern that might catch an unrelated one. `inactive_dispatch`
 * is what a `worker_done` for a settled dispatch comes back as; a settled
 * dispatch handed to `worker-stop` is not an error at all — it answers `ok`
 * with `alreadySettled: true`.
 *
 * A settled-refusal code this set has not seen costs one degraded window and
 * is picked up on the next event, which is the right way round: a set that
 * guessed would swallow a real outage as agreement.
 */
const SETTLED_CODES = new Set(["inactive_dispatch"]);

/**
 * Is this failure the fence already having done its work?
 *
 * Both sides refuse late lifecycle calls, and they can reach one dispatch from
 * different directions — this mirror's own record, and Orca's settled-dispatch
 * check. So a refusal naming a settled dispatch is the agreement working, not
 * an outage to degrade on. One predicate, because the call sites that ask this
 * used to spell it three different ways.
 */
export function isAlreadySettled(called: Called): boolean {
  return called.code !== null && SETTLED_CODES.has(called.code);
}

const retryMs = (): number => {
  const raw = Number(process.env.RALPH_ORCA_RETRY_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : DEFAULT_RETRY_MS;
};

/**
 * Run one `orca` command, bounded, never throwing, and never trusting the exit
 * status.
 *
 * That last one is not paranoia. `orca` reports a *refused* mutation as exit 0
 * with `{"ok": false, "error": {...}}` — a late `worker_done` on a fenced
 * dispatch comes back `inactive_dispatch` exactly that way — so a caller
 * reading `status === 0` would record every rejection as a success. The
 * envelope is the answer; the exit status is only how the process left.
 */
export function callOrca(verb: AllowedVerb, args: string[]): Called {
  return invokeOrca(verb, args, ALLOWED_VERBS, "orca-lifecycle", FORBIDDEN_ARGS);
}

/** `result.<key>.<field>`, for a receipt field that is not the id. */
export function textFrom(
  result: Record<string, unknown> | null,
  key: string,
  field: string,
): string | null {
  const nested = result?.[key];
  if (typeof nested !== "object" || nested === null) return null;
  const value = (nested as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** `result.<key>.id`, the shape every mutation receipt uses. */
export function idFrom(result: Record<string, unknown> | null, key: string): string | null {
  const nested = result?.[key];
  if (typeof nested !== "object" || nested === null) return null;
  const id = (nested as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/* --------------------------------------------------------------------------
 * Mirroring one event.
 * ----------------------------------------------------------------------- */

interface Identity {
  loop: string;
  run: string;
  worktree: string;
  branch: string | null;
  terminal: string | null;
  /** `ORCA_WORKTREE_ID`, carried in payloads so a message names its checkout. */
  worktreeId: string | null;
  /** The supervisor, the way the durable record identifies one. */
  pid: number | null;
  host: string;
}

/**
 * The Run's objective, which is also its identity: `run-create` takes no
 * idempotency key, so a Run is recognised as this supervisor's by it. Shared
 * with the doctor, whose re-registration must be one the mirror adopts.
 */
export const objectiveFor = (identity: { loop: string; run: string; worktree: string }): string =>
  `${identity.loop} loop ${identity.run} — Loggd backlog in ${identity.worktree}`;

/** One shape for a refusal, built in the two places that refuse things. */
const rejection = (event: string, why: string, at: string): AdapterState["lastRejected"] => ({
  event,
  why,
  at,
});

export function blank(identity: Pick<Identity, "run" | "loop" | "worktree" | "terminal">, nowIso: string): AdapterState {
  return {
    version: 1,
    ralphRun: identity.run,
    loop: identity.loop,
    worktree: identity.worktree,
    terminal: identity.terminal,
    orcaRun: null,
    task: null,
    attempt: null,
    degraded: null,
    displacedBinding: null,
    lastRejected: null,
    lastEvent: { name: "", at: nowIso },
  };
}

/**
 * The mirror itself.
 *
 * Written as one pass over the state rather than as a plan-then-execute pair,
 * because every step's arguments are ids the previous step returned, and the
 * only honest way to stop is *where* Orca stopped answering: a run that was
 * created but whose task was not is a real intermediate state, and the record
 * has to be able to hold it.
 */
function mirror(root: string, event: LifecycleEvent, identity: Identity): AdapterState {
  const statePath = join(root, ORCA_STATE_RELATIVE_PATH);
  const nowIso = new Date().toISOString();
  const previous = existsSync(statePath)
    ? parseAdapterState(readFileSync(statePath, "utf8").toString())
    : null;

  const verdict = fenceVerdict(previous, event);
  if (!verdict.accept) {
    // Refused before any Orca call: a replaced attempt must not be able to
    // report on the live one's dispatch, and the cheapest place to guarantee
    // that is here, where the current attempt is already known.
    return { ...(previous ?? blank(identity, nowIso)), lastRejected: rejection(event.name, verdict.why, nowIso) };
  }

  // A restart starts clean, INCLUDING the back-off. A degraded window belongs
  // to the supervisor that hit it: inheriting one meant a fresh run started
  // inside the window skipped Orca entirely and printed a dead supervisor's
  // reason for it — a loop reported as unmirrored on evidence from a process
  // that is gone. A new run asks again, and pays one bounded probe to do it.
  const state: AdapterState = verdict.restart
    ? blank(identity, nowIso)
    : { ...previous!, terminal: identity.terminal, worktree: identity.worktree };
  state.lastEvent = { name: event.name, at: nowIso };

  // What the PREVIOUS supervisor was unable to mirror, kept across the blanking
  // above: a loop whose supervisor died while Orca was unreachable leaves a Run
  // that simply stops, and the gap is exactly as worth naming there as it is
  // when one supervisor recovers within its own run.
  const unmirroredSince = previous?.degraded ?? null;

  // A supervisor that died mid-iteration left an attempt nobody settled. It is
  // abandoned rather than stopped: `worker-abandon` fences an uncertain worker
  // without claiming it stopped, which is exactly what is true — this process
  // has no idea what became of the last one's runner.
  const orphanedAttempt =
    verdict.restart && previous?.attempt?.dispatch != null ? previous.attempt.dispatch : null;

  // Degraded and still inside its retry window: bookkeeping advances, Orca is
  // not called. A frontier-gated loop records a wait on every poll, and paying
  // a timeout on each of them would cost more than the display is worth.
  //
  // Except for the loop's ENDING, which is exempt. A stop swallowed by the
  // back-off is never mirrored at all — there is no later event to recover
  // into — so the board keeps an open Run, an unsettled Task and a live
  // dispatch for a loop that has exited, which is precisely the "died or just
  // dark?" ambiguity this whole degraded path exists to remove. One bounded
  // timeout is affordable for a supervisor that is leaving anyway.
  const degraded = state.degraded;
  if (
    degraded !== null &&
    event.stop === undefined &&
    Date.parse(degraded.retryAt) > Date.parse(nowIso)
  ) {
    return applyLocal(state, event);
  }

  if (identity.terminal === null) {
    return degrade(
      applyLocal(state, event),
      "not started from an Orca-managed terminal",
      nowIso,
    );
  }

  const fail = (why: string): AdapterState => degrade(applyLocal(state, event), why, nowIso);

  if (orphanedAttempt !== null) {
    const abandoned = callOrca("orchestration worker-abandon", ["--dispatch", orphanedAttempt]);
    // A failed abandon is not worth degrading over: the attempt belongs to a
    // supervisor that is already gone, and the new run's own bookkeeping is
    // what an operator is reading now.
    if (!abandoned.ok && abandoned.kind === "missing-cli") return fail(abandoned.why);
  }

  // --- Run ----------------------------------------------------------------
  if (state.orcaRun === null) {
    // `run-create` BINDS the calling terminal to the new Run, and that is not
    // an effect this mirror can undo. Binding IS lifecycle authority in Orca:
    // handing the terminal back with `run-use` was tried, and it fences the
    // Run just created — every subsequent mutation comes back
    // `consumer_fenced`. A supervisor that owns a Run has to hold its
    // terminal's binding.
    //
    // Which is correct for how a loop is actually started — `ralph/start.sh`
    // gives it its own pane in its own worktree, and there the supervisor IS
    // the coordinator of its own Run. It is only wrong for a supervisor run by
    // hand from a pane that was already coordinating something else, so the
    // binding it displaces is read first and reported with the one command
    // that puts it back. Stated, with a remedy, rather than silent.
    const objective = objectiveFor(identity);
    const bound = callOrca("orchestration run-current", []);
    const previousBinding = bound.ok ? idFrom(bound.result, "run") : null;
    // Adopted rather than created again when the bound Run is already THIS
    // supervisor's. `run-create` is a mutation with no idempotency key, so a
    // call that commits in Orca and then times out before its receipt arrives
    // leaves a Run this record knows nothing about — and a blind retry would
    // create a second Run for one supervisor, orphan the first, and then tell
    // the operator to "restore" a binding to the orphan. The objective names
    // the run id, so it is the key the CLI does not offer.
    if (previousBinding !== null && textFrom(bound.result, "run", "objective") === objective) {
      state.orcaRun = previousBinding;
    } else {
      const created = callOrca("orchestration run-create", ["--objective", objective]);
      if (!created.ok) return fail(created.why);
      state.orcaRun = idFrom(created.result, "run");
      if (state.orcaRun === null) return fail("orca run-create returned no run id");
      if (previousBinding !== null && previousBinding !== state.orcaRun) {
        state.displacedBinding = previousBinding;
      }
    }
  }
  const run = state.orcaRun;

  // Two different questions, two different sources. WHICH ticket this run
  // holds outlives the iteration, so it comes from the claim lease. Whether
  // the iteration is still ON it is a statement about right now, so it comes
  // from the branch — and it has to, because the lease still names a ticket
  // after `prompt.md` §7 detaches, which is precisely when the attempt should
  // be reported as done rather than held.
  const issue = ticketFor(root, identity);
  const branchIssue = issueFromBranch(identity.branch, identity.loop);

  // --- Attempt boundaries -------------------------------------------------
  // Is the loop still ON the ticket it has a task for? The branch is the
  // evidence, and it is the evidence for stops too — which is the correction
  // that matters here. Treating every stop as "done with the ticket" meant a
  // mid-ticket `cap-reached` sent `worker_done --outcome succeeded` and Orca
  // completed a Task for work the loop demonstrably had not finished: it was
  // still on `<loop>/<issue>`, it just ran out of iterations.
  //
  // `prompt.md` §1 detaches only after a ticket is finished, so being back on
  // `main` or on another issue is what "released it" actually looks like.
  const onTicket = branchIssue !== null && state.task !== null && state.task.issue === branchIssue;
  const releasing = !onTicket;
  // Settled before the new attempt opens, so a task never has two live
  // dispatches and Orca's own fence agrees with this one.
  if (event.name === "iteration-start") {
    const settled = settleAttempt(state, run, event, identity, releasing);
    if (settled !== null) return fail(settled);
    state.attempt = {
      index: event.iteration ?? (state.attempt?.index ?? 0) + 1,
      session: event.session,
      dispatch: null,
      ended: false,
    };
  } else if (state.attempt?.ended === true || event.stop !== undefined) {
    const settled = settleAttempt(state, run, event, identity, releasing);
    if (settled !== null) return fail(settled);
  }

  // --- Task, and the attempt's dispatch onto it ---------------------------
  // Only while an attempt is open, because a task exists to hold attempts. A
  // loop sitting at the frontier gate on a branch it has already finished with
  // would otherwise have a fresh, empty ticket created for it on every poll,
  // and a stopped loop would leave one behind as its last act.
  if (issue !== null && state.attempt !== null && state.task?.issue !== issue) {
    const created = callOrca("orchestration task-create", [
      "--run",
      run,
      "--task-title",
      `#${issue}`,
      "--display-name",
      `${identity.loop} #${issue}`,
      "--spec",
      [
        `Loggd issue #${issue}, selected by the ${identity.loop} loop.`,
        `Worktree ${identity.worktree}, branch ${identity.branch}.`,
        "Worked by the loop's own runners; Orca mirrors this task, it does not place it.",
      ].join(" "),
    ]);
    if (!created.ok) return fail(created.why);
    const id = idFrom(created.result, "task");
    if (id === null) return fail("orca task-create returned no task id");
    state.task = { issue, id };
  }

  if (state.attempt !== null && state.attempt.dispatch === null && state.task !== null) {
    const consumer = resolveOrcaConsumer(
      root,
      state,
      { ralphRun: identity.run, worktree: identity.worktree },
      identity.terminal,
    );
    if (consumer === null) return fail("no Orca consumer is available for the attempt");
    const dispatched = callOrca("orchestration dispatch", [
      "--run",
      run,
      "--task",
      state.task.id,
      "--to",
      consumer,
    ]);
    if (!dispatched.ok) return fail(dispatched.why);
    state.attempt = { ...state.attempt, dispatch: idFrom(dispatched.result, "dispatch") };
  }

  // --- The gap the mirror was dark for ------------------------------------
  // Said on the board, once, on the way back. Degraded mode is only half
  // reported if the local panel knows and Orca does not: a Run that simply
  // stops receiving heartbeats looks exactly like a loop that died, and the
  // one thing an operator needs to know is that those hours are missing rather
  // than idle.
  const gap = state.degraded ?? unmirroredSince;
  if (gap !== null) {
    // Result deliberately dropped, unlike every other call in this pass: this
    // is a note about an outage that has just ended, and failing to deliver it
    // is not itself worth declaring a new outage over. The heartbeat directly
    // below is the call that decides whether Orca is really back.
    callOrca("orchestration send", [
      "--run",
      run,
      "--type",
      "status",
      "--subject",
      `${identity.loop} mirror recovered`,
      "--body",
      `not mirrored since ${gap.at} — ${gap.why}. The loop itself was unaffected.`,
    ]);
  }

  // --- Heartbeat ----------------------------------------------------------
  // Dispatch-scoped where there is a dispatch, a Run-wide `status` where there
  // is not. `heartbeat` is the type Orca reads as liveness for one attempt;
  // sending it without an attempt would claim an attempt exists.
  //
  // Both carry the worktree and branch as structured payload rather than only
  // as prose in the body: those are two of the nouns the board is meant to be
  // able to show, and a reader that has to regex them back out of a sentence
  // cannot show them as anything.
  const where = {
    loop: identity.loop,
    // The owner, not only the loop: two supervisors of one loop, or the same
    // loop on another host, are otherwise indistinguishable on the board —
    // and `loop-state.ts` has modelled owner as {loop, pid, host} since #700.
    pid: identity.pid,
    host: identity.host,
    ralphRun: identity.run,
    worktree: identity.worktreeId ?? identity.worktree,
    branch: identity.branch,
    phase: phaseFor(event),
    ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
  };
  const beat =
    state.attempt?.dispatch != null && state.task !== null
      ? callOrca("orchestration send", [
          "--run",
          run,
          "--type",
          "heartbeat",
          "--subject",
          `${identity.loop} ${phaseFor(event)}`,
          "--payload",
          JSON.stringify({
            taskId: state.task.id,
            dispatchId: state.attempt.dispatch,
            ...where,
          }),
        ])
      : callOrca("orchestration send", [
          "--run",
          run,
          "--type",
          "status",
          "--subject",
          `${identity.loop} ${phaseFor(event)}`,
          "--body",
          describe(event, identity),
          "--payload",
          JSON.stringify(where),
        ]);
  if (!beat.ok) return fail(beat.why);

  // --- The loop's own ending ----------------------------------------------
  // Only for the one ending `worker_done` cannot express. It carries an
  // outcome of `succeeded` or `failed` and nothing else, and a *blocked*
  // ticket is neither — the work exists, it could not be taken, and a human
  // has to widen something. So that one is fenced and then said explicitly;
  // the other two are already settled by the report above, and the guide is
  // clear that a manual `task-update` must not follow a valid `worker_done`.
  const taskStatus = taskStatusFor(event.stop, onTicket);
  if (taskStatus !== null && state.task !== null) {
    const updated = callOrca("orchestration task-update", [
      "--run",
      run,
      "--id",
      state.task.id,
      "--status",
      taskStatus,
      "--result",
      JSON.stringify({ why: event.why ?? event.name, loop: identity.loop, run: identity.run }),
    ]);
    if (!updated.ok) return fail(updated.why);
  }

  state.degraded = null;
  return applyLocal(state, event);
}

/** What a Run-wide `status` message says when there is no attempt to scope it to. */
function describe(event: LifecycleEvent, identity: Identity): string {
  const parts = [event.why ?? event.detail ?? event.name];
  if (event.iteration !== undefined) {
    parts.push(`iteration ${event.iteration}${event.max != null ? `/${event.max}` : ""}`);
  }
  // The branch stays, because `worker_done` carries no payload and its body is
  // the only place an attempt's branch is written down. The worktree id does
  // not: it travels as payload on everything that has one, and repeating it
  // here only made the body long.
  parts.push(`branch ${identity.branch ?? "detached"}`);
  return parts.join(" — ");
}

/**
 * Settle the open attempt, if there is one to settle.
 *
 * Three endings, because the three are genuinely different and only one of
 * them is a completed ticket:
 *
 * - **Replaced before its runner returned** (`ended` is false): fenced with
 *   `worker-stop`. There is no outcome to claim — this process does not know
 *   what became of that runner — and on an unsupervised dispatch the fence
 *   touches no process at all (`processAction: "none"`). Afterwards every late
 *   event from that attempt is `inactive_dispatch` on Orca's side as well as
 *   refused on this one.
 * - **Ended, and the loop is leaving the ticket**: `worker_done` with the
 *   outcome, which settles the dispatch AND the task in one move, with the
 *   provenance Orca shows on the board.
 * - **Ended, and another attempt on the same ticket is coming**: fenced, and
 *   the outcome said as an ordinary `status`. This case is why the first two
 *   cannot be collapsed — a `worker_done` here would complete the ticket
 *   underneath the next iteration, and Orca would then refuse to dispatch it.
 *
 * Returns null on success, or the reason to degrade.
 */
function settleAttempt(
  state: AdapterState,
  run: string,
  event: LifecycleEvent,
  identity: Identity,
  releasing: boolean,
): string | null {
  const attempt = state.attempt;
  if (attempt === null) return null;
  const outcome = settlementFor(event);
  // Reported as done when the loop is off the ticket with a finished attempt,
  // or when it is failing — in either case there is an outcome to state.
  //
  // A `succeeded` report for a ticket the loop is still standing on would
  // complete, in Orca, work that is not done; `worker_done` has no word for
  // that third ending, a ticket held and unfinished, so the caller marks it
  // `blocked` instead.
  //
  // A failure stop reports even when the attempt never reached its end, which
  // is the one case where this process CAN speak for a runner it did not see
  // finish: the supervisor is exiting on that failure, so the attempt died
  // with it. Everywhere else an unfinished attempt is fenced rather than
  // reported, because "I do not know what became of it" is the truth.
  const reports = event.stop === "failed" || (attempt.ended && releasing);
  if (attempt.dispatch !== null && state.task !== null) {
    const call = reports
      ? callOrca("orchestration send", [
          "--run",
          run,
          "--type",
          "worker_done",
          "--subject",
          `${identity.loop} iteration ${attempt.index} ${outcome}`,
          // Named as the settlement of THAT attempt by THIS event, because an
          // attempt is settled one event late and a body that only described
          // the later event reads as a report about the wrong iteration.
          "--body",
          `iteration ${attempt.index} settled by ${event.name}: ${describe(event, identity)}`,
          "--task-id",
          state.task.id,
          "--dispatch-id",
          attempt.dispatch,
          "--outcome",
          outcome,
        ])
      : callOrca("orchestration worker-stop", ["--dispatch", attempt.dispatch]);
    // An already-settled dispatch is the fence working, not a fault: Orca and
    // this mirror both refuse late lifecycle calls, and they can reach the
    // same dispatch from different sides. Anything else is a real outage.
    if (!call.ok && !isAlreadySettled(call)) return call.why;
    if (!releasing && event.stop === undefined) {
      // Fencing a dispatch leaves its task `blocked`, and Orca dispatches only
      // `ready` tasks — so a ticket the loop is keeping has to be handed back
      // as ready or the next attempt on it cannot be opened at all. It is also
      // the true statement: the attempt is over, the ticket is not.
      const ready = callOrca("orchestration task-update", [
        "--run",
        run,
        "--id",
        state.task.id,
        "--status",
        "ready",
      ]);
      if (!ready.ok && !isAlreadySettled(ready)) return ready.why;
    }
    if (!reports && attempt.ended) {
      // The outcome still has to be recorded somewhere an operator reading the
      // Run can see it; a fence alone says the attempt stopped and not how.
      callOrca("orchestration send", [
        "--run",
        run,
        "--type",
        "status",
        "--subject",
        `${identity.loop} iteration ${attempt.index} ${outcome}`,
        "--body",
        `iteration ${attempt.index} settled by ${event.name}: ${describe(event, identity)}`,
      ]);
    }
    // A reported task is settled in Orca and cannot take another dispatch, so
    // it must not be carried forward as this loop's current ticket.
    if (reports) state.task = null;
  }
  state.attempt = null;
  return null;
}

/** Bookkeeping that happens whether or not Orca answered. */
function applyLocal(state: AdapterState, event: LifecycleEvent): AdapterState {
  if (event.name === "iteration-end" && state.attempt !== null) {
    return { ...state, attempt: { ...state.attempt, ended: true } };
  }
  return state;
}

function degrade(state: AdapterState, why: string, nowIso: string): AdapterState {
  return {
    ...state,
    degraded: { why, at: nowIso, retryAt: new Date(Date.parse(nowIso) + retryMs()).toISOString() },
  };
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const present = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

function identityFor(root: string, pid: number | null = parentPid()): Identity {
  return {
    loop: currentLoop(process.env, join(root, ".ralph/loop-name")),
    run: process.env.RALPH_RUN_ID ?? "adhoc",
    worktree: resolve(root),
    branch: branchOf(root),
    // Empty is absent, not present-and-blank: a terminal exported with no
    // value is what a shell that inherited the variable through something
    // that cleared it looks like, and an empty handle addresses nothing.
    terminal: present(process.env.ORCA_TERMINAL_HANDLE),
    worktreeId: present(process.env.ORCA_WORKTREE_ID),
    pid,
    host: hostname(),
  };
}

/** Run by hand from a supervisor's shell, the supervisor is this process's parent. */
const parentPid = (): number | null =>
  Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null;

/**
 * Mirror one event the host handed over, and write the record.
 *
 * The event's own fields are trusted only as far as `loop-state.ts` trusts
 * them: an off-roster stage or stop kind is refused and kept as evidence, for
 * the reason `runRecord` gives. The pid is the supervisor the host named, or
 * none — never this process's parent, which is the host.
 */
export function mirrorEvent(root: string, event: PluginEvent): void {
  if (!enabled()) return;
  const args = [
    "--event",
    event.name,
    ...(event.stage !== undefined ? ["--stage", event.stage] : []),
    ...(event.iteration !== undefined ? ["--iteration", String(event.iteration)] : []),
    ...(event.max != null ? ["--max", String(event.max)] : []),
    ...(event.stop !== undefined ? ["--stop", event.stop] : []),
    ...(event.why !== undefined ? ["--why", event.why] : []),
    ...(event.detail !== undefined ? ["--detail", event.detail] : []),
  ];
  runRecord(root, args, { run: event.run, session: event.session, pid: event.pid });
}

interface Carried {
  run: string;
  session: string | null;
  pid: number | null;
}

function runRecord(root: string, argv: string[], carried: Carried = fromEnvironment()): void {
  const name = flag(argv, "event");
  if (name === undefined) return;
  const iterationRaw = flag(argv, "iteration");
  const maxRaw = flag(argv, "max");
  // Refused here, exactly where `loop-state.ts record` refuses it and for the
  // same reason widened by one: the other mirror writes NOTHING for a value
  // outside its roster, so a mirror that accepted one would put an event on
  // the Orca board that the durable record does not have — and a bad `--stop`
  // in particular would be mirrored as a *success*, since everything that is
  // not `failed` settles as `succeeded`.
  const stage = flag(argv, "stage");
  const stop = flag(argv, "stop");
  const offRoster =
    stage !== undefined && !(STAGES as readonly string[]).includes(stage)
      ? `--stage must be one of ${STAGES.join(", ")}; got '${stage}'`
      : stop !== undefined && !(STOP_KINDS as readonly string[]).includes(stop)
        ? `--stop must be one of ${STOP_KINDS.join(", ")}; got '${stop}'`
        : null;
  if (offRoster !== null) {
    // Refused, and recorded as refused. Dropping it silently would be the one
    // rejection in this file with nothing to show for it, and a mistyped flag
    // that produces no evidence anywhere is exactly the bug that hides.
    const statePath = join(root, ORCA_STATE_RELATIVE_PATH);
    const previous = existsSync(statePath)
      ? parseAdapterState(readFileSync(statePath, "utf8").toString())
      : null;
    if (previous !== null) {
      writeAdapterState(statePath, {
        ...previous,
        lastRejected: rejection(name, offRoster, new Date().toISOString()),
      });
    }
    return;
  }
  // Resolved after the refusal above, not before it: `branchOf` is a `git`
  // subprocess, and an event this mirror is about to throw away should not pay
  // for an identity it never uses.
  const identity = { ...identityFor(root, carried.pid), run: carried.run };
  const event: LifecycleEvent = {
    name,
    stage: stage as Stage | undefined,
    ...(iterationRaw !== undefined && Number.isInteger(Number(iterationRaw))
      ? { iteration: Number(iterationRaw) }
      : {}),
    max: maxRaw !== undefined && Number.isInteger(Number(maxRaw)) ? Number(maxRaw) : null,
    stop: stop as StopKind | undefined,
    why: flag(argv, "why"),
    detail: flag(argv, "detail"),
    run: identity.run,
    session: carried.session,
  };
  writeAdapterState(join(root, ORCA_STATE_RELATIVE_PATH), mirror(root, event, identity));
}

const fromEnvironment = (): Carried => ({
  run: process.env.RALPH_RUN_ID ?? "adhoc",
  session: process.env.RALPH_SESSION_ID ?? null,
  pid: parentPid(),
});

/** One line, for the plugin's status and the supervisor's startup banner. */
export function lineFor(state: AdapterState | null, enabled: boolean): string {
  if (!enabled) return "Orca lifecycle: off (RALPH_ORCA_LIFECYCLE=0)";
  if (state === null) return "Orca lifecycle: nothing mirrored yet";
  if (state.degraded !== null) {
    return `Orca lifecycle: degraded — ${state.degraded.why} (retrying after ${state.degraded.retryAt})`;
  }
  const parts = [`run ${state.orcaRun ?? "—"}`];
  if (state.task !== null) parts.push(`task ${state.task.id} (#${state.task.issue})`);
  if (state.attempt !== null) {
    parts.push(
      `attempt ${state.attempt.index}${state.attempt.dispatch !== null ? ` ${state.attempt.dispatch}` : " (no dispatch yet)"}`,
    );
  }
  if (state.terminal !== null) parts.push(`terminal ${state.terminal}`);
  const line = `Orca lifecycle: ${parts.join(", ")}`;
  // Said every time it is printed, not once at startup: binding is lifecycle
  // authority in Orca and cannot be handed back without fencing this loop's
  // own Run, so the displaced one stays displaced until somebody restores it.
  return state.displacedBinding === null
    ? line
    : `${line}\n  displaced this terminal's Run binding — restore it with: orca orchestration run-use --id ${state.displacedBinding}`;
}

/**
 * A heartbeat sent while the runner is still working.
 *
 * `record` only fires at the boundaries around `claude -p`, and that turn runs
 * for tens of minutes — so between `iteration-start` and `iteration-end` the
 * Run received nothing at all, and a healthy hour-long iteration was
 * indistinguishable on the board from a supervisor that died right after its
 * first event. That is the exact signal a heartbeat exists to carry, so the
 * plugin sends one on every `pulse` the host offers.
 *
 * Deliberately narrow. It sends a heartbeat for an attempt that already exists
 * and does nothing else: it never creates a Run, a Task or a Dispatch, and it
 * never writes the state file — the foreground `record` owns that file, and a
 * background writer racing it is how a record comes to be half of each.
 */
export function heartbeat(root: string, run: string): void {
  if (!enabled()) return;
  const statePath = join(root, ORCA_STATE_RELATIVE_PATH);
  if (!existsSync(statePath)) return;
  const state = parseAdapterState(readFileSync(statePath, "utf8").toString());
  if (state === null || state.orcaRun === null) return;
  // The same fence the recorder applies: a pulse from a previous supervisor's
  // watcher must not report liveness for the run that replaced it.
  if (state.ralphRun !== run) return;
  if (state.degraded !== null && Date.parse(state.degraded.retryAt) > Date.now()) return;
  if (state.attempt?.dispatch == null || state.task === null) return;
  let presence = null;
  try {
    presence = observeRun(root);
  } catch {
    // The lifecycle pulse remains valid when its optional display data is not.
  }
  const actors =
    presence?.actors.map((actor) => ({
      stage: actor.stage,
      state: actor.state,
      runner: actor.runner,
      model: actor.model,
      action: actor.lastAction,
      activityAt: actor.activityAt,
    })) ?? [];
  callOrca("orchestration send", [
    "--run",
    state.orcaRun,
    "--type",
    "heartbeat",
    "--subject",
    presence && actors.length > 0
      ? presenceSummary(presence)
      : `${state.loop} iteration ${state.attempt.index} working`,
    "--payload",
    JSON.stringify({
      taskId: state.task.id,
      dispatchId: state.attempt.dispatch,
      phase: "iteration",
      loop: state.loop,
      ralphRun: state.ralphRun,
      issue: presence?.issue ?? null,
      supervisor: presence?.supervisor ?? null,
      actors,
    }),
  ]);
}

function runStatus(root: string, argv: string[]): void {
  const statePath = join(root, ORCA_STATE_RELATIVE_PATH);
  const state = existsSync(statePath)
    ? parseAdapterState(readFileSync(statePath, "utf8").toString())
    : null;
  if (argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(lineFor(state, enabled()));
  if (!argv.includes("--line") && state?.lastRejected != null) {
    console.log(`  last refused: ${state.lastRejected.event} — ${state.lastRejected.why}`);
  }
}

export const enabled = (): boolean => (process.env.RALPH_ORCA_LIFECYCLE ?? "1") !== "0";

function main(): void {
  // Anchored like `ralph.sh` and `loop-state.ts`: the record belongs to the
  // worktree holding this file, not to wherever it was invoked from.
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  process.chdir(root);
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "record") {
    if (!enabled()) return;
    runRecord(root, argv.slice(1));
  } else if (command === "heartbeat") {
    heartbeat(root, process.env.RALPH_RUN_ID ?? "adhoc");
  } else if (command === "status" || command === undefined) {
    runStatus(root, argv.slice(1));
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    // Reported, never fatal: a mirror that could end a loop would be worse
    // than no mirror at all.
    console.error(`orca-lifecycle: ${error instanceof Error ? error.message : String(error)}`);
  }
}
