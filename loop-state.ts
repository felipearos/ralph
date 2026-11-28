#!/usr/bin/env bun
/**
 * Durable loop state, and the Git worktree registry read back against disk.
 *
 * `status.sh` used to answer "what is Ralph doing?" from the process table
 * alone, and the process table can only say *running* or *not running*. Every
 * question an operator actually has at 2am is finer than that: did the loop
 * finish the backlog or die mid-ticket? Is this worktree idle between
 * iterations, waiting on a frontier that has nothing in it, or gone? Is that
 * third checkout under `/home/faros/` a second loop or a corpse Git still
 * lists? A supervisor that has exited answers *all* of those the same way —
 * "NOT running" — and an operator reading that has to reconstruct the rest
 * from log archaeology.
 *
 * So the supervisor writes down what it is doing as it does it, and this
 * module reads that back. Three properties are what make the record worth
 * trusting:
 *
 * 1. **The state is durable, and the process is not.** The record outlives the
 *    terminal it was started from, the supervisor, and — deliberately — the
 *    worktree itself. `stale`, `failed` and `completed` are answers only a
 *    written record can give, because in all three the process is equally
 *    gone.
 *
 * 2. **The record is evidence, never authority.** A state file says a run was
 *    alive when it was last written; it cannot say it is alive now. So every
 *    liveness claim here is re-derived from the process table, and the pid in
 *    the file is checked against `/proc` before it is believed — pids are
 *    reused, and a state file naming a recycled pid is exactly how a dead loop
 *    comes to be reported as running. Where the record and the world disagree,
 *    the world wins.
 *
 * 3. **Missing and corrupt are ordinary answers.** The file is written by a
 *    shell loop that can be killed between `>` and its content; it lives in
 *    `.ralph/logs/`, which an operator may delete at any time. Neither is a
 *    fault, and neither may be allowed to take the panel down: both fall back
 *    to process inspection, which is exactly what the panel could do before
 *    this file existed.
 *
 * The worktree half exists for the same reason. `git worktree list` is a
 * registry, not an observation: it will happily list a path that was deleted
 * from disk months ago, and a checkout whose loop died is indistinguishable
 * there from one running right now. Reconciling the registry against disk is
 * what separates *live*, *stale*, *prunable* and *orphaned* — and the whole
 * point of surfacing the last two is that they must never be counted as loops
 * that are working.
 *
 * Usage:
 *   ralph/loop-state.ts record --event <name> [--stage <stage>]
 *                              [--iteration N] [--max N] [--phase <phase>] [--resumed-at <phase>]
 *                              [--stop <completed|blocked|failed|interrupted>] [--why …]
 *   ralph/loop-state.ts status [--json]
 *
 * `record` is called by `ralph.sh` and never fails a loop: a supervisor that
 * died because its bookkeeping could not be written would be a worse outcome
 * than any missing panel. `status` is read-only.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { currentLoop } from "./frontier/next-tasks";
import { isPhase, PHASES, type Phase } from "./phase";
import { readTimeline, type TimelineRead, type TimelineActivity } from "./timeline";
import { projectRoot } from "./paths";

/**
 * A fully resolved path, or the best available answer for one that is gone.
 *
 * Every path comparison in this file is against `/proc/<pid>/cwd`, which is
 * always fully resolved — so a worktree reached through a symlink that is
 * compared unresolved never matches, and every supervisor on the machine reads
 * as dead. A path that cannot be resolved (an orphaned worktree, most often)
 * still has to produce something printable, hence the fallback.
 */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Where each worktree keeps its own record. Gitignored, like the rest of it. */
export const STATE_RELATIVE_PATH = ".ralph/logs/state.json";

/**
 * The other thing the supervisor's worktree accumulates as it works.
 *
 * The record above is written at iteration BOUNDARIES — `iteration-start`,
 * then nothing until `iteration-end` — because those are the only moments
 * `ralph.sh` is running rather than blocked on the orchestrator. An iteration
 * is an hour, so for that hour the panel says `iteration-start 70m ago` and an
 * operator cannot tell a working loop from a wedged one.
 *
 * New runs write a merged event timeline from inside the iteration, once per
 * harness event. Older runs have only `usage.py`'s ledger rows, once per billed
 * step. The panel reads the timeline first and uses this ledger only when no
 * timeline exists for the recorded run and iteration.
 *
 * Both are activity records, not heartbeats. A tool call that has run for 40
 * minutes and a loop that died 40 minutes ago look the same in either file.
 * Liveness stays the process table's answer.
 */
export const LEDGER_RELATIVE_PATH = ".ralph/logs/usage-ledger.tsv";

/** The last step this run reported: what it was, and when it was recorded. */
export interface LedgerStep {
  index: number;
  label: string;
  at: string;
}

/**
 * The last reported step of one run, read out of the shared ledger.
 *
 * Shared is the word that shapes this: every run of every loop in a worktree
 * appends to one file, so the run id is a filter and not an assumption, and
 * the rows for this run are not necessarily at the end of it. `usage.py` also
 * emits one row PER MODEL per step, so the last row and the last step are
 * different things. The step number is taken from the row, never counted.
 *
 * Every malformed row is skipped rather than fatal. The writer is a Python
 * script appending under a loop that can be killed mid-line, the reader is a
 * panel, and a half-written final row must cost an operator the step label,
 * not the table.
 */
export function lastLedgerStep(tsv: string, run: string): LedgerStep | null {
  let best: LedgerStep | null = null;
  for (const line of tsv.split("\n")) {
    const parts = line.split("\t");
    // The token-only writer has 11 columns. Legacy rows have a trailing
    // cost_usd column, which does not affect the positional fields read here.
    if (parts.length < 11 || parts[0] !== run) continue;
    const index = Number(parts[2]);
    if (!Number.isInteger(index)) continue;
    if (Number.isNaN(Date.parse(parts[3] ?? ""))) continue;
    // Last wins by position, not by step number: a resumed run can re-book an
    // earlier step, and what an operator asked was "what is it doing NOW".
    best = { index, label: parts[4] ?? "", at: parts[3] ?? "" };
  }
  return best;
}

/** The ledger of one worktree, or null when there is nothing readable there. */
function readLastStep(worktreePath: string, run: string): LedgerStep | null {
  try {
    return lastLedgerStep(readFileSync(join(worktreePath, LEDGER_RELATIVE_PATH), "utf8"), run);
  } catch {
    return null;
  }
}

/** How long any one `git` read may take. A hung panel is worse than a blank one. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * How long a record may go untouched before the loop that wrote it is treated
 * as gone, when the process table cannot say either way.
 * `RALPH_STALE_AFTER_SECONDS` overrides it.
 *
 * An hour, because the thing being timed is an iteration: `claude -p` holds a
 * single turn open for tens of minutes, and the heartbeat only advances at the
 * boundaries around it. This window is the *fallback* — where `/proc` is
 * readable, liveness comes from there and the window is never consulted — so
 * it is tuned to avoid a false "stale" on the one platform that needs it,
 * rather than to detect death quickly.
 */
const DEFAULT_LOOP_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * How long a checkout may sit with nobody touching it before it is called
 * abandoned. `RALPH_WORKTREE_STALE_AFTER_SECONDS` overrides it.
 *
 * Days, not the hour above, because the two windows time unrelated things and
 * sharing one made every ordinary checkout nobody had run a git command in
 * since lunch report as `stale`. A loop's heartbeat is paced by an iteration;
 * a worktree's activity is paced by an operator, who may reasonably not open
 * one for a week and still be using it.
 */
const DEFAULT_WORKTREE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One roster per union, and the type is derived from it.
 *
 * The alternative — a union here and a string array at each place that has to
 * validate one — is how a sixth stage comes to be accepted by the writer and
 * rejected by the reader. A project's roster is one list (`loops` in its
 * config) for the same reason.
 */
export const STAGES = [
  "starting",
  "preflight",
  "gate",
  "iteration",
  // Held by an operator rather than by the work: a pause an operator issued,
  // or an approval nobody has given yet. It is its own stage rather than a
  // flavour of `gate` because the two are answered by different people — an
  // empty frontier widens when the backlog does, and a hold ends when a human
  // says so — and an operator scanning the panel has to be able to tell which
  // of those a parked loop is waiting on.
  "paused",
  "stopped",
] as const;
export type Stage = (typeof STAGES)[number];

const isStage = (value: unknown): value is Stage =>
  typeof value === "string" && (STAGES as readonly string[]).includes(value);

/**
 * Why a loop stopped, in the four kinds an operator acts on differently.
 *
 * `completed` is a loop that ran out of work — nothing to do. `blocked` is a
 * loop that had work it could not take, which is a triage request. `failed` is
 * a loop that broke, which is a repair request. `interrupted` is a loop an
 * operator ended mid-iteration with a signal (the dashboard's Stop now), which
 * is a recovery request: the killed iteration's commits, uncommitted files and
 * claim are still in the worktree. Collapsing them into one "stopped" is how a
 * broken supervisor comes to look like a finished one.
 *
 * Only `controls.ts interrupted` writes `interrupted`, after the signal has
 * taken effect; an orderly stop is never one.
 */
export const STOP_KINDS = ["completed", "blocked", "failed", "interrupted"] as const;
export type StopKind = (typeof STOP_KINDS)[number];

const isStopKind = (value: unknown): value is StopKind =>
  typeof value === "string" && (STOP_KINDS as readonly string[]).includes(value);

export interface StopReason {
  kind: StopKind;
  why: string;
  at: string;
  /**
   * The signal that ended the supervisor ("SIGTERM"), and whether the
   * supervisor's own trap recorded the stop (`true`) or an operator's Stop now
   * did (`false`). The dashboard's reconciler reads them to restart a loop a
   * host shutdown stopped before the current boot (#6). Absent on records
   * written before they existed, and on a malformed value.
   */
  signal?: string;
  self?: boolean;
}

export interface LoopEvent {
  name: string;
  at: string;
  detail?: string;
}

export interface LoopState {
  /** Bumped only for a shape change a reader cannot absorb; see `parseLoopState`. */
  version: 1;
  /** `RALPH_RUN_ID` — what the usage ledger and the supervisor log key on. */
  run: string;
  owner: {
    /** One of the project's `loops`; the loops share one tracker and one process table. */
    loop: string;
    /** The supervisor's pid, re-checked against `/proc` before it is believed. */
    pid: number | null;
    host: string;
  };
  /** Absolute, resolved: it is compared against the Git registry's paths. */
  worktree: string;
  branch: string | null;
  stage: Stage;
  iteration: { index: number; max: number | null } | null;
  /** ISO 8601, advanced by every `record` call. */
  heartbeat: string;
  lastEvent: LoopEvent | null;
  /** Null while the loop is still going. Set exactly once, at the exit. */
  stopReason: StopReason | null;
  /**
   * `RALPH_SESSION_ID` of the iteration in progress, or of the last one. Kept
   * because `lastEvent.detail` names it only until the next event replaces
   * it, and the dashboard reads usage for this session. Absent until an
   * iteration records one.
   */
  session?: string;
  /**
   * The phase the iteration in progress is in (`ralph/phase.ts`). Meaningful
   * only inside an iteration: a record that moves the loop to any other stage
   * drops it unless it names one itself. Absent from records older than phases.
   */
  phase?: Phase;
  /**
   * Set when the iteration in progress resumed an interrupted ticket from its
   * phase ledger rather than starting it from the top: the phase it resumed
   * at. Kept only while the iteration is still in that phase.
   */
  resumedAt?: Phase;
  /**
   * ISO 8601: when this loop last finished an iteration (its last
   * `iteration-end`). Unlike every other field it outlives the run that wrote
   * it; see `applyRecord`. Absent until the loop has finished one.
   */
  lastIterationEndAt?: string;
}

/**
 * What an operator is told about one loop.
 *
 * `running` and `idle` both mean alive: the difference is whether an iteration
 * is burning money right now or the supervisor is sitting in a wait. `blocked`
 * is alive-but-parked or stopped-on-blocked — either way it is the frontier
 * that needs a human, not the loop. `stale` is a record whose supervisor is
 * gone without having written an ending: a killed terminal, an OOM, a reboot.
 * `interrupted` is the one kill that did write an ending, because the operator
 * who sent it recorded one: its work is waiting in the worktree to be resumed
 * or released. `orphaned` is a record whose worktree is gone. `unknown` is the honest
 * answer when there is no record and no process to inspect.
 */
export type LoopStatus =
  | "running"
  | "idle"
  | "blocked"
  | "stale"
  | "orphaned"
  | "failed"
  | "completed"
  | "interrupted"
  | "unknown";

/**
 * Whether a pid is a live supervisor — with `unknown` as a first-class answer.
 *
 * On a machine with no readable `/proc`, "I cannot tell" is the truth, and
 * collapsing it into `false` would report every loop on that machine as dead.
 * The classifier treats it as a signal to fall back to the heartbeat rather
 * than as an observation.
 */
export type Liveness = "alive" | "dead" | "unknown";

/**
 * How a registered worktree relates to what is actually on disk.
 *
 * `live` — the directory is there and something is using it.
 * `stale` — the directory is there and nothing has touched it in a long time.
 * `prunable` — Git itself says `git worktree prune` would remove it.
 * `orphaned` — the registry names a path that does not exist, and Git has NOT
 *   offered to prune it (a locked worktree, or metadata retained after the
 *   directory was deleted by hand). This is the case that must never be shown
 *   as a working loop: the entry looks completely normal in `git worktree
 *   list`, right up until you `cd` into it.
 */
export type WorktreeStatus = "live" | "stale" | "prunable" | "orphaned";

export interface RegistryEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** The reason Git gave, or `""` when it gave none. Null when not locked. */
  lockedReason: string | null;
  prunableReason: string | null;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * The format is line-oriented records separated by blank lines, where the
 * `worktree` line opens a record and the rest are optional attributes that may
 * or may not carry a value (`locked`, `prunable` and `detached` often do not).
 * Parsed rather than pattern-matched because the attributes that matter here —
 * `prunable`, `locked` — are exactly the ones a `grep` would miss when Git
 * emits them bare.
 */
export function parseWorktreeRegistry(porcelain: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  let current: RegistryEntry | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        lockedReason: null,
        prunableReason: null,
      };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.lockedReason = value;
    else if (key === "prunable") current.prunableReason = value;
  }
  if (current) entries.push(current);
  return entries;
}

export interface WorktreeObservation {
  /** Does the path exist on disk right now? The registry cannot answer this. */
  directoryExists: boolean;
  /**
   * The newest of: this worktree's loop heartbeat, and the mtime of its Git
   * metadata. Git touches that metadata on every operation, so it is the one
   * "somebody was here" signal available for a checkout no loop ever ran in.
   * Null when neither could be read.
   */
  lastActivityMs: number | null;
  /** Whether a supervisor is running in it. Alive short-circuits every timer. */
  supervisor: Liveness;
}

export interface Clock {
  nowMs: number;
  /** How long a record may go untouched before its loop is presumed gone. */
  loopStaleAfterMs: number;
  /** How long a checkout may sit untouched before it is called abandoned. */
  worktreeStaleAfterMs: number;
}

/**
 * Reconcile one registry entry against disk.
 *
 * Order matters and it is not arbitrary: *gone* outranks *idle* outranks
 * *fine*. A directory that does not exist can never be `stale` — staleness is
 * a statement about a checkout you could still walk into — and a worktree with
 * a live supervisor can never be anything but `live`, whatever its timestamps
 * say, because a running iteration writes nothing for tens of minutes at a
 * stretch.
 */
export function classifyWorktree(
  entry: RegistryEntry,
  observation: WorktreeObservation,
  clock: Clock,
): WorktreeStatus {
  // Git's own verdict first: it has seen the gitdir this entry points at and
  // knows whether `prune` would take it. Reporting such an entry as `orphaned`
  // on our own timer would tell an operator to investigate something Git has
  // already offered to clean up.
  if (entry.prunableReason !== null) return "prunable";
  // The registry entry survives, the directory does not. Git has not offered
  // to prune it — a lock, or metadata that outlived a hand-deleted directory —
  // so nothing but this reconciliation will ever surface it.
  if (!observation.directoryExists) return "orphaned";
  if (observation.supervisor === "alive") return "live";
  if (observation.lastActivityMs === null) return "stale";
  return clock.nowMs - observation.lastActivityMs > clock.worktreeStaleAfterMs ? "stale" : "live";
}

/**
 * Read a state file, treating every way it can be unusable as the same answer.
 *
 * Truncated JSON, a half-written object, a file from a future version, a
 * hand-edited one with `iteration: "3"` — an operator does not care which, and
 * a reader that threw on any of them would take the panel down for a file
 * whose entire purpose is to make the panel better. Null means "no usable
 * record", and every caller has a process-inspection path for that.
 *
 * Validated field by field rather than cast: the file is written by a shell
 * loop that can be killed mid-write, so "parses as JSON" is a much weaker
 * guarantee here than it looks.
 */
export function parseLoopState(raw: string): LoopState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (fields.version !== 1) return null;
  const owner =
    typeof fields.owner === "object" && fields.owner !== null
      ? (fields.owner as Record<string, unknown>)
      : null;
  if (!owner || typeof owner.loop !== "string" || owner.loop === "") return null;
  if (typeof fields.run !== "string" || fields.run === "") return null;
  if (typeof fields.worktree !== "string" || fields.worktree === "") return null;
  if (typeof fields.heartbeat !== "string" || Number.isNaN(Date.parse(fields.heartbeat))) {
    return null;
  }
  if (!isStage(fields.stage)) return null;
  const heartbeat = fields.heartbeat;

  const iterationRaw =
    typeof fields.iteration === "object" && fields.iteration !== null
      ? (fields.iteration as Record<string, unknown>)
      : null;
  const iteration =
    iterationRaw && typeof iterationRaw.index === "number"
      ? {
          index: iterationRaw.index,
          max: typeof iterationRaw.max === "number" ? iterationRaw.max : null,
        }
      : null;

  const eventRaw =
    typeof fields.lastEvent === "object" && fields.lastEvent !== null
      ? (fields.lastEvent as Record<string, unknown>)
      : null;
  const lastEvent =
    eventRaw && typeof eventRaw.name === "string" && typeof eventRaw.at === "string"
      ? {
          name: eventRaw.name,
          at: eventRaw.at,
          ...(typeof eventRaw.detail === "string" ? { detail: eventRaw.detail } : {}),
        }
      : null;

  const stopRaw =
    typeof fields.stopReason === "object" && fields.stopReason !== null
      ? (fields.stopReason as Record<string, unknown>)
      : null;
  const stopReason =
    stopRaw && isStopKind(stopRaw.kind)
      ? {
          kind: stopRaw.kind,
          why: typeof stopRaw.why === "string" ? stopRaw.why : "",
          at: typeof stopRaw.at === "string" ? stopRaw.at : heartbeat,
          // The reconciler restarts a self-recorded SIGTERM by when it was
          // stopped. With no stop time of its own, the heartbeat stands in for
          // the page only, so the restart metadata is dropped and it stays down.
          ...(typeof stopRaw.at === "string" && typeof stopRaw.signal === "string" && stopRaw.signal !== ""
            ? { signal: stopRaw.signal }
            : {}),
          ...(typeof stopRaw.at === "string" && typeof stopRaw.self === "boolean" ? { self: stopRaw.self } : {}),
        }
      : null;

  return {
    version: 1,
    run: fields.run,
    owner: {
      loop: owner.loop,
      pid: typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : null,
      host: typeof owner.host === "string" ? owner.host : "",
    },
    worktree: fields.worktree,
    branch: typeof fields.branch === "string" ? fields.branch : null,
    stage: fields.stage,
    iteration,
    heartbeat,
    lastEvent,
    stopReason,
    ...(typeof fields.session === "string" && fields.session.trim() !== "" ? { session: fields.session } : {}),
    ...(isPhase(fields.phase) ? { phase: fields.phase } : {}),
    ...(isPhase(fields.resumedAt) ? { resumedAt: fields.resumedAt } : {}),
    ...(typeof fields.lastIterationEndAt === "string" && !Number.isNaN(Date.parse(fields.lastIterationEndAt))
      ? { lastIterationEndAt: fields.lastIterationEndAt }
      : {}),
  };
}

export interface LoopObservation {
  /** Null when the file is absent, unreadable, or does not parse. */
  state: LoopState | null;
  /** Whether the worktree the record names still exists. */
  worktreeExists: boolean;
  /** Liveness of a supervisor in that worktree, from the process table. */
  supervisor: Liveness;
}

/**
 * Turn a record plus the world into the one word an operator reads.
 *
 * The ordering is the whole design, so it is written out rather than left to
 * be inferred from the `if`s:
 *
 *   1. **No worktree** → `orphaned`, before anything else is consulted. A
 *      record saying "iteration 4 of 50, heartbeat two minutes ago" is
 *      perfectly consistent with a worktree somebody has since deleted, and
 *      reporting that as `running` is precisely the failure this exists to
 *      prevent — as is reporting a *recordless* missing worktree as merely
 *      unknown, when the registry can say exactly what is wrong with it.
 *   2. **No record** → the process table is all there is. This is the old
 *      behaviour, kept intact, and it is what makes a deleted `.ralph/logs/`
 *      or a half-written file a non-event.
 *   3. **A stop reason** → the loop wrote its own ending; nothing observed
 *      later can improve on it. A supervisor process still alive at this point
 *      is one on its way out through its final lines.
 *   4. **A live supervisor** → `running` inside an iteration, `idle`
 *      otherwise, except that a loop parked because everything is blocked
 *      reports `blocked` — the operator's next action differs.
 *   5. **A dead supervisor and no ending** → `stale`. Something took the loop
 *      away without letting it write: a closed terminal, a reboot, a `kill -9`.
 *   6. **Liveness unknown** → fall back to the heartbeat clock.
 */
export function classifyLoop(observation: LoopObservation, clock: Clock): LoopStatus {
  const { state, worktreeExists, supervisor } = observation;
  // Before the record is consulted at all, and before the fallback: a loop
  // whose worktree is gone is orphaned whether it left a record behind or not,
  // and no later signal can make it anything else.
  if (!worktreeExists) return "orphaned";
  if (!state) return supervisor === "alive" ? "running" : "unknown";
  // Every stop kind is already a status word; naming them twice would be a map
  // whose only job is to agree with itself.
  if (state.stopReason) return state.stopReason.kind;
  // What an alive loop is doing: parked on a blocked frontier, inside an
  // iteration, or in one of the waits. Written once, because both the observed
  // and the inferred liveness paths below reach the same answer.
  const whileAlive: LoopStatus =
    // A held loop is `blocked` for the same reason a parked one is: it is
    // alive, it is doing nothing, and the thing that would unstick it is a
    // human. `idle` would read as "between iterations, carry on".
    // A backoff is the same shape: parked until something external clears.
    // So is a usage wait: the account's limit rejected a turn and the loop is
    // alive, holding its claim until the reset — never `failed` (#407).
    // So is a plan usage stop's park (`usage-stop.ts`): alive, holding its
    // claim, waiting for the window it watches to reset.
    // So is a gate hold past its budget (#771): the gate has answered the same
    // verdict for so long that only a person will change it. A hold inside its
    // budget records other events and stays `idle` — waiting there is normal.
    state.stage === "paused" ||
    (state.stage === "gate" &&
      (state.lastEvent?.name === "blocked-wait" ||
        state.lastEvent?.name === "backoff-wait" ||
        state.lastEvent?.name === "usage-wait" ||
        state.lastEvent?.name === "usage-stop" ||
        state.lastEvent?.name === "gate-hold-exhausted"))
      ? "blocked"
      : state.stage === "iteration"
        ? "running"
        : "idle";
  if (supervisor === "alive") return whileAlive;
  if (supervisor === "dead") return "stale";
  // Liveness unknown: the heartbeat is the only clock left.
  const beat = Date.parse(state.heartbeat);
  if (Number.isNaN(beat) || clock.nowMs - beat > clock.loopStaleAfterMs) return "stale";
  return whileAlive;
}

/* --------------------------------------------------------------------------
 * The world: process table, disk, git.
 * ----------------------------------------------------------------------- */

/** What one `/proc` entry is, judged once and compared against any worktree. */
type ProcessJudgement = { kind: "supervisor"; cwd: string } | "not-supervisor" | "dead" | "unknown";

/**
 * Judge one pid: a Ralph supervisor (with its resolved cwd), something else,
 * gone, or unreadable. Shared by `supervisorPidMatches` and `scanSupervisors`
 * so a recorded pid and a `/proc` scan can never disagree about a process.
 */
function judgeProcess(pid: number, proc: string): ProcessJudgement {
  const procDir = join(proc, String(pid));
  let argv: string;
  try {
    argv = readFileSync(join(procDir, "cmdline"), "utf8");
  } catch (error) {
    // ENOENT here means "no such process", which is an answer. Anything else —
    // a `/proc` that is not mounted, a permission wall — is not.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unknown";
  }
  const args = argv.split("\0").filter((part) => part !== "");
  // A supervisor is `bash …/ralph/ralph.sh N`. A shell running `-c` whose
  // command line merely mentions the path — routinely, the status panel's own
  // parent — is not.
  if (args.includes("-c")) return "not-supervisor";
  // Every loop on a machine runs the SAME shared `$RALPH_HOME/ralph.sh`, so
  // the script path alone names no worktree; the cwd check is what does. The
  // basename is matched rather than the exact harness path so a supervisor
  // started from an older in-repo copy (`<worktree>/ralph/ralph.sh`) still
  // reads as the live loop it is.
  if (!args.some((arg) => arg === "ralph.sh" || arg.endsWith("/ralph.sh"))) return "not-supervisor";
  try {
    return { kind: "supervisor", cwd: realpathSync(join(procDir, "cwd")) };
  } catch (error) {
    // ENOENT is the process exiting between the two reads — routine on a host
    // with live loops, whose `$(…)` subshells carry `ralph.sh` in argv and
    // last milliseconds. That is "dead", like a missing `cmdline` above;
    // calling it unknown let one short-lived subshell anywhere on the machine
    // mark every dead loop as running. A permission wall stays unknown.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unknown";
  }
}

/**
 * Is this pid a Ralph supervisor running in this worktree?
 *
 * Both halves are load-bearing. Pids are reused, so a state file naming a pid
 * that now belongs to somebody's editor must not read as a running loop —
 * hence the argv check. And `pgrep -f ralph/ralph.sh` is machine-wide, so with
 * two loops running it would report the OTHER worktree's supervisor as this
 * one's — hence the cwd check, resolved on both sides because `/proc/<pid>/cwd`
 * is always fully resolved while a worktree reached through a symlink is not.
 */
export function supervisorPidMatches(pid: number, worktree: string, proc = "/proc"): Liveness {
  const judgement = judgeProcess(pid, proc);
  if (judgement === "unknown") return "unknown";
  if (judgement === "dead" || judgement === "not-supervisor") return "dead";
  return judgement.cwd === resolved(worktree) ? "alive" : "dead";
}

/**
 * Every supervisor on the host, from one pass over `/proc`: the resolved cwds
 * they run in, and whether any process could not be judged. `null` is a
 * `/proc` that cannot be listed at all.
 */
export type SupervisorScan = { cwds: ReadonlySet<string>; sawUnknown: boolean } | null;

/**
 * Scan `/proc` once. A panel with forty idle worktrees used to walk the whole
 * process table once per worktree (#64); one scan answers them all.
 */
export function scanSupervisors(proc = "/proc"): SupervisorScan {
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const cwds = new Set<string>();
  let sawUnknown = false;
  for (const pid of pids) {
    const judgement = judgeProcess(Number(pid), proc);
    if (judgement === "unknown") sawUnknown = true;
    else if (typeof judgement === "object") cwds.add(judgement.cwd);
  }
  return { cwds, sawUnknown };
}

/**
 * Memoise a scan so one panel read walks `/proc` at most once, and not at all
 * when every recorded pid checks out. A `null` (unreadable `/proc`) is
 * remembered too: retrying it per worktree would cost the same walk again.
 */
export function lazyScan(scan: () => SupervisorScan = scanSupervisors): () => SupervisorScan {
  let done = false;
  let result: SupervisorScan = null;
  return () => {
    if (!done) {
      result = scan();
      done = true;
    }
    return result;
  };
}

/**
 * Find a supervisor running in `worktree`, without trusting any recorded pid.
 *
 * This is the fallback path — what the panel had before there were records —
 * and it is also the check that keeps a record honest. `/proc` unreadable is
 * `unknown`, never `dead`; a supervisor found here wins over any process that
 * could not be judged.
 */
export function findSupervisor(worktree: string, scan: SupervisorScan = scanSupervisors()): Liveness {
  if (scan === null) return "unknown";
  if (scan.cwds.has(resolved(worktree))) return "alive";
  return scan.sawUnknown ? "unknown" : "dead";
}

/** Liveness for a worktree, preferring the recorded pid and verifying it. */
function livenessFor(worktree: string, recordedPid: number | null, scan: () => SupervisorScan): Liveness {
  if (recordedPid !== null) {
    const verdict = supervisorPidMatches(recordedPid, worktree);
    // A recorded pid that is dead does not end the question: the operator may
    // have restarted the loop by hand, and that supervisor is the live one.
    if (verdict === "alive") return verdict;
  }
  return findSupervisor(worktree, scan());
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** The mtime of a worktree's Git metadata — "somebody used this checkout". */
function lastGitActivityMs(worktreePath: string): number | null {
  // A linked worktree has a `.git` FILE pointing at the real gitdir; the
  // primary one has the directory itself. Either way its mtime moves on every
  // git operation, which is the only activity signal a checkout no loop ever
  // ran in has.
  const dotGit = join(worktreePath, ".git");
  try {
    return statSync(dotGit).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The record a worktree keeps — but only if it is that worktree's own.
 *
 * The record names the worktree it was written for, and a copied or
 * `git worktree move`d checkout carries somebody else's `state.json` with it.
 * Adopting that would report another loop's run, iteration and ending under
 * this path, which is worse than the "no durable state" row an operator gets
 * instead. The path is the record's identity, so it is checked.
 */
function readState(worktreePath: string): { state: LoopState | null; problem: Problem } {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, STATE_RELATIVE_PATH), "utf8");
  } catch {
    return { state: null, problem: "missing" };
  }
  const state = parseLoopState(raw);
  if (!state) return { state: null, problem: "unreadable" };
  if (resolved(state.worktree) !== resolved(worktreePath)) {
    return { state: null, problem: "foreign" };
  }
  return { state, problem: null };
}

type Problem = LoopReport["stateProblem"];

export interface LoopReport {
  worktree: string;
  worktreeStatus: WorktreeStatus;
  loopStatus: LoopStatus;
  branch: string | null;
  state: LoopState | null;
  /**
   * Set when a record was found but could not be used. `foreign` is a record
   * that names a different worktree — a copied or moved checkout — which is a
   * different diagnosis from a corrupt one and a different thing to fix.
   */
  stateProblem: "missing" | "unreadable" | "foreign" | null;
  /**
   * The last step this worktree's run reported, when the ledger has one. Null
   * covers "no ledger", "no rows for this run" and "nothing reported yet" alike:
   * all three mean the same thing to a reader, which is that the record's own
   * event is the most recent thing known.
   */
  lastStep: LedgerStep | null;
  /** The newest tool or prose event in this run's current iteration. */
  lastActivity: TimelineActivity | null;
  /** True when this iteration has a persisted timeline, even if it has no renderable event yet. */
  timelineExists: boolean;
  supervisor: Liveness;
  registryEntry: RegistryEntry;
}

export interface Snapshot {
  /** The worktree the panel was run from, resolved. */
  self: string;
  loops: LoopReport[];
  /**
   * Registered worktrees whose directory is gone. Repeated out of `loops` on
   * purpose: this is the answer to "why does my worktree count not match", and
   * an operator should not have to scan a table for it.
   */
  reconciliation: { orphaned: string[]; prunable: string[] };
}

/**
 * Every registered worktree, reconciled against disk and against its record.
 *
 * Driven by the Git registry rather than by a scan for state files, because a
 * worktree Git has forgotten and a worktree that never ran a loop are both
 * things an operator needs to see, and only one of them has a state file.
 */
function worktreeRegistry(root: string): { self: string; entries: RegistryEntry[] } {
  const porcelain = git(["worktree", "list", "--porcelain"], root);
  const entries = porcelain === null ? [] : parseWorktreeRegistry(porcelain);
  const self = resolved(root);
  // The registry is the only source of worktrees, so a `git` that could not be
  // read leaves this worktree as the only one we can honestly report on.
  if (entries.length === 0) {
    entries.push({
      path: self,
      head: null,
      branch: null,
      detached: false,
      bare: false,
      lockedReason: null,
      prunableReason: null,
    });
  }

  return { self, entries };
}

/** Read one registered worktree using the same reconciliation as the full panel. */
export function worktreeReport(
  root: string,
  clock: Clock,
  options: { scan?: () => SupervisorScan } = {},
): { report: LoopReport; timeline: TimelineRead } | null {
  const { self, entries } = worktreeRegistry(root);
  const entry = entries.find((entry) => !entry.bare && resolved(entry.path) === self);
  return entry ? reportForEntry(entry, clock, lazyScan(options.scan)) : null;
}

function reportForEntry(
  entry: RegistryEntry,
  clock: Clock,
  scan: () => SupervisorScan,
): { report: LoopReport; timeline: TimelineRead } {
  const directoryExists = existsSync(entry.path);
  // A worktree that is gone has no record to have a problem with: its row is
  // about the missing directory, and "no state file" underneath it would be
  // a second complaint about the same absence.
  const { state, problem: stateProblem } = directoryExists
    ? readState(entry.path)
    : { state: null, problem: null };
  const supervisor = directoryExists
    ? livenessFor(entry.path, state?.owner.pid ?? null, scan)
    : // A worktree that is gone cannot be hosting a supervisor whose cwd is
      // inside it, and `findSupervisor` would answer `dead` for the right
      // reason anyway. Said explicitly so the orphan path never depends on
      // scanning `/proc` for a directory that no longer exists.
      "dead";
  const heartbeatMs = state ? Date.parse(state.heartbeat) : Number.NaN;
  const lastActivityMs = ((): number | null => {
    const touched = directoryExists ? lastGitActivityMs(entry.path) : null;
    const beat = Number.isNaN(heartbeatMs) ? null : heartbeatMs;
    if (touched === null) return beat;
    if (beat === null) return touched;
    return Math.max(touched, beat);
  })();
  const worktreeStatus = classifyWorktree(
    entry,
    { directoryExists, lastActivityMs, supervisor },
    clock,
  );
  const loopStatus = classifyLoop(
    { state, worktreeExists: directoryExists, supervisor },
    clock,
  );
  const timeline =
    state && directoryExists
      ? readTimeline(entry.path, {
          run: state.run,
          ...(state.iteration ? { iteration: state.iteration.index } : {}),
        })
      : { exists: false, path: null, events: [], activities: [] };
  const report: LoopReport = {
    worktree: entry.path,
    worktreeStatus,
    loopStatus,
    branch: state?.branch ?? entry.branch,
    state,
    stateProblem,
    // Keyed on the record's run, so a worktree whose record could not be
    // read gets no step either: an unattributed row out of a shared ledger
    // could belong to any run that ever worked here.
    lastStep:
      state && directoryExists && !timeline.exists
        ? readLastStep(entry.path, state.run)
        : null,
    lastActivity: timeline.activities.at(-1) ?? null,
    timelineExists: timeline.exists,
    supervisor,
    registryEntry: entry,
  };
  return { report, timeline };
}

/** Reconcile all non-bare worktrees in the Git registry. */
export function snapshot(root: string, clock: Clock, options: { scan?: () => SupervisorScan } = {}): Snapshot {
  const { self, entries } = worktreeRegistry(root);
  // One scan for the whole panel, taken only if some worktree needs it.
  const scan = lazyScan(options.scan);
  const loops = entries.filter((entry) => !entry.bare).map((entry) => reportForEntry(entry, clock, scan).report);
  return {
    self,
    loops,
    reconciliation: {
      orphaned: loops.filter((l) => l.worktreeStatus === "orphaned").map((l) => l.worktree),
      prunable: loops.filter((l) => l.worktreeStatus === "prunable").map((l) => l.worktree),
    },
  };
}

/* --------------------------------------------------------------------------
 * Unattended loops.
 * ----------------------------------------------------------------------- */

/**
 * How long a loop may sit errored or dead before it is called unattended.
 * Overridden by `RALPH_UNATTENDED_AFTER_SECONDS`.
 */
export const DEFAULT_UNATTENDED_AFTER_MS = 30 * 60 * 1000;

/**
 * A loop that died rather than decided to stop, and has stayed down past the
 * threshold. The three key names are a contract: another tool parses them.
 */
export interface UnattendedLoop {
  loop: string;
  stopKind: StopKind | null;
  /** ISO 8601: the ending's time, else the last heartbeat. */
  downSince: string;
}

/** One worktree's verdict, before the reports are folded by loop name. */
function unattendedReport(report: LoopReport, nowMs: number, thresholdMs: number): UnattendedLoop | null {
  const { state } = report;
  // No record means no name and nothing to judge — an orphaned worktree
  // without a record lands here.
  if (state === null) return null;
  // An alive supervisor is attended however old its stop reason: it is the
  // one that will write the next one.
  if (report.supervisor === "alive") return null;
  const stop = state.stopReason;
  // Only a death counts, never a decision: `completed`, `blocked` and
  // `interrupted` are endings somebody chose. With no ending at all, `unknown`
  // liveness is not enough — `classifyLoop` still calls such a loop running or
  // idle until the stale window, because the heartbeat does not advance inside
  // an iteration.
  const died =
    stop !== null
      ? stop.kind === "failed"
      : report.supervisor === "dead" || report.loopStatus === "stale";
  if (!died) return null;
  // The stop KIND is not enough: an operator may stop a loop as `failed`
  // through the remote/API path (parsed by dashboard/command-requests.ts for
  // both the local routes and the remote function), which
  // ralph.sh records as `control-stop`. The dashboard's own buttons send
  // `blocked`, which the rule above already drops.
  if (state.lastEvent?.name === "control-stop") return null;
  // For an ending-less loop the heartbeat does not advance inside an
  // iteration, so `downSince` is a lower bound on how long it has really been
  // quiet.
  const downSince = stop !== null ? stop.at : state.heartbeat;
  const downMs = Date.parse(downSince);
  // A timestamp that cannot be read degrades to attended: adopting a loop on
  // a guess is the expensive mistake.
  if (Number.isNaN(downMs) || nowMs - downMs <= thresholdMs) return null;
  return { loop: state.owner.loop, stopKind: stop?.kind ?? null, downSince };
}

/**
 * The loops that have been errored or dead for longer than `thresholdMs`.
 *
 * One answer per loop NAME. `snapshot()` makes one report per worktree, stale
 * ones included, so an old worktree left behind can carry the same name as
 * the live one. A name is unattended only when EVERY report naming it is:
 * getting this wrong would let pr-medic adopt, and push to, a LIVE loop's PR.
 * When all are, the entry is the one with the latest `downSince` — the
 * shortest time down, the least that can honestly be claimed.
 *
 * Scope: `snapshot()` reads one clone's `git worktree list`, so a loop in
 * another clone or on another host is never seen and never adopted — the
 * safe direction.
 */
export function unattendedLoops(reports: LoopReport[], clock: Clock, thresholdMs: number): UnattendedLoop[] {
  const nowMs = clock.nowMs;
  // A live supervisor with no usable record yet — a fresh start before its
  // first `record`, or a corrupt file — cannot say which loop it is, so it
  // could be the live owner of any name below. Name nothing rather than guess.
  if (reports.some((report) => report.state === null && report.supervisor === "alive")) return [];
  const byName = new Map<string, UnattendedLoop | null>();
  for (const report of reports) {
    if (report.state === null) continue;
    const name = report.state.owner.loop;
    const verdict = unattendedReport(report, nowMs, thresholdMs);
    if (!byName.has(name)) {
      byName.set(name, verdict);
      continue;
    }
    const previous = byName.get(name) ?? null;
    // Once any report of a name is attended, the name stays attended.
    if (previous === null || verdict === null) {
      byName.set(name, null);
      continue;
    }
    if (Date.parse(verdict.downSince) > Date.parse(previous.downSince)) byName.set(name, verdict);
  }
  return [...byName.values()].filter((entry): entry is UnattendedLoop => entry !== null);
}

/* --------------------------------------------------------------------------
 * Reporting.
 * ----------------------------------------------------------------------- */

const ago = (iso: string | null, nowMs: number): string => {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "unknown";
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};

/** When the record was last touched — the event's own time, else the beat. */
const lastEventAt = (state: LoopState): string => state.lastEvent?.at ?? state.heartbeat;

/**
 * The lines `status.sh` prints. One row per worktree, then whatever needs a
 * human — an unreadable record, a stop reason, a registry that disagrees with
 * the disk. A healthy machine prints the table and nothing else.
 */
export function report(snap: Snapshot, clock: Clock): string[] {
  const lines: string[] = [];
  for (const loop of snap.loops) {
    // Both sides resolved: `snap.self` is, and a registry path reached through
    // a symlink is not, so comparing them raw is how the marker silently stops
    // appearing on exactly the machines that have one.
    const here = resolved(loop.worktree) === snap.self ? " (this worktree)" : "";
    // The loop's own name, or a dash. A worktree with no record is not a loop
    // called anything — labelling it with its directory name would invent an
    // identity the claim fence has never heard of, next to two that are real.
    const name = loop.state?.owner.loop ?? "—";
    const where = loop.state?.iteration
      ? ` iteration ${loop.state.iteration.index}${
          loop.state.iteration.max ? `/${loop.state.iteration.max}` : ""
        }${loop.state.phase ? ` · ${loop.state.resumedAt === loop.state.phase ? "resuming at " : ""}${loop.state.phase}` : ""}`
      : "";
    lines.push(
      `${name.padEnd(8)} ${loop.loopStatus.padEnd(9)} worktree ${loop.worktreeStatus.padEnd(8)}` +
        ` ${loop.branch ?? "-"}${where}${here}`,
    );
    if (loop.state) {
      lines.push(
        `         run ${loop.state.run} — ${loop.state.lastEvent?.name ?? "no event"}` +
          ` ${ago(loop.state.lastEvent?.at ?? loop.state.heartbeat, clock.nowMs)}`,
      );
      if (
        loop.lastActivity &&
        Date.parse(loop.lastActivity.at) > Date.parse(lastEventAt(loop.state))
      ) {
        lines.push(
          `         activity ${loop.lastActivity.stage}: ${loop.lastActivity.label}` +
            ` — observed ${ago(loop.lastActivity.at, clock.nowMs)}; process table decides liveness`,
        );
      } else if (
        !loop.timelineExists &&
        loop.lastStep &&
        Date.parse(loop.lastStep.at) > Date.parse(lastEventAt(loop.state))
      ) {
        lines.push(
          `         step ${loop.lastStep.index}: ${loop.lastStep.label}` +
            ` — reported ${ago(loop.lastStep.at, clock.nowMs)}`,
        );
      }
      if (loop.state.stopReason) {
        lines.push(`         stopped (${loop.state.stopReason.kind}): ${loop.state.stopReason.why}`);
      }
    } else if (loop.stateProblem === "unreadable") {
      lines.push("         state file unreadable — reporting from the process table alone");
    } else if (loop.stateProblem === "foreign") {
      lines.push(
        "         state file belongs to another worktree (copied or moved) — ignoring it",
      );
    } else if (loop.stateProblem === "missing") {
      lines.push("         no durable state — reporting from the process table alone");
    }
    lines.push(`         ${loop.worktree}`);
  }
  for (const path of snap.reconciliation.orphaned) {
    lines.push(`reconcile: ${path} is registered but missing from disk — not a running loop`);
    lines.push("           fix: git worktree prune  (or `git worktree unlock` first, if locked)");
  }
  for (const path of snap.reconciliation.prunable) {
    lines.push(`reconcile: ${path} is prunable — git worktree prune would remove it`);
  }
  return lines;
}

/* --------------------------------------------------------------------------
 * Recording.
 * ----------------------------------------------------------------------- */

export interface RecordPatch {
  event: string;
  detail?: string;
  stage?: Stage;
  iteration?: { index: number; max: number | null };
  branch?: string | null;
  stop?: { kind: StopKind; why: string; signal?: string; self?: boolean };
  session?: string;
  phase?: Phase;
  resumedAt?: Phase;
}

/**
 * Fold one event into the record.
 *
 * Merge rather than overwrite, because the fields arrive from different places
 * at different times: the run id and the pid are known at startup and never
 * repeated, the iteration counter only at iteration boundaries, the branch
 * whenever git is cheap to ask. An event that carried none of them must not
 * blank them.
 *
 * A stop is terminal and is not un-set by a later event: the record's job
 * after a loop ends is to explain the ending, and a stray heartbeat writing
 * `stopReason: null` back over it would turn `failed` into `stale`.
 *
 * Terminal WITHIN ITS RUN, though — and the record lives at a fixed path in
 * the worktree, so the next supervisor started there inherits it. Merging
 * across that boundary is how a live loop came to be reported as `completed`:
 * `stopReason` survived into the new run's first write, and `classifyLoop`
 * consults it before liveness, so the panel described the PREVIOUS
 * supervisor's ending while this one was mid-iteration. A record naming a
 * different run is not this run's history, so it is not merged with at all —
 * which is what `ralph.sh` already says the first write of a run does.
 *
 * One exception: `lastIterationEndAt` is carried from the previous record
 * whatever its run. "When did this loop last finish an iteration?" is asked
 * about the loop, not a run — and every retry the dashboard's reconcile makes
 * starts a new run, so a per-run value would be unset exactly when it is read.
 * A loop with no record at all has it unset: it has never finished one.
 *
 * The phase is carried only while the loop stays in `iteration`: the next
 * gate, hold or stop is between iterations, and a phase shown there would
 * describe work that has already ended. A record that names a phase keeps it
 * whatever its stage, which is how a hold AT a boundary will say where it is.
 * The phase a resumed iteration started at is carried the same way, and only
 * while the phase is still that one: past its first boundary the iteration is
 * no longer resuming anything.
 */
export function applyRecord(
  previous: LoopState | null,
  patch: RecordPatch,
  base: { run: string; loop: string; pid: number | null; host: string; worktree: string },
  nowIso: string,
): LoopState {
  const prior = previous?.run === base.run ? previous : null;
  const stage: Stage = patch.stop ? "stopped" : (patch.stage ?? prior?.stage ?? "starting");
  const session = patch.session ?? prior?.session;
  const phase = patch.phase ?? (stage === "iteration" ? prior?.phase : undefined);
  const resumedAt = patch.resumedAt ?? (phase !== undefined && phase === prior?.resumedAt ? phase : undefined);
  // `previous`, not `prior`: the one field that crosses a run boundary (above).
  const lastIterationEndAt = patch.event === "iteration-end" ? nowIso : previous?.lastIterationEndAt;
  return {
    version: 1,
    run: base.run,
    owner: { loop: base.loop, pid: base.pid, host: base.host },
    worktree: base.worktree,
    branch: patch.branch !== undefined ? patch.branch : (prior?.branch ?? null),
    stage,
    iteration: patch.iteration ?? prior?.iteration ?? null,
    heartbeat: nowIso,
    lastEvent: { name: patch.event, at: nowIso, ...(patch.detail ? { detail: patch.detail } : {}) },
    stopReason: patch.stop
      ? {
          kind: patch.stop.kind,
          why: patch.stop.why,
          at: nowIso,
          ...(patch.stop.signal !== undefined ? { signal: patch.stop.signal } : {}),
          ...(patch.stop.self !== undefined ? { self: patch.stop.self } : {}),
        }
      : (prior?.stopReason ?? null),
    ...(session !== undefined ? { session } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(resumedAt !== undefined ? { resumedAt } : {}),
    ...(lastIterationEndAt !== undefined ? { lastIterationEndAt } : {}),
  };
}

/**
 * Write the record so a reader never sees half of it.
 *
 * Temp file plus `rename`, because the writer is a supervisor that can be
 * killed at any instant and the reader is a panel an operator runs at exactly
 * the worst one. `rename` within a directory is atomic; `> file` is not, and
 * the failure it produces — a truncated file — is the corrupt-state case this
 * module then has to absorb.
 */
export function writeState(path: string, state: LoopState): void {
  writeJsonAtomically(path, state);
}

/**
 * The write itself, shared with every other record in `.ralph/logs/`.
 *
 * Both files are written by a supervisor that can be killed at any instant and
 * read by a panel somebody runs at exactly the worst one, so both need the
 * same temp-file-plus-`rename`. Kept here as one function rather than as a
 * copy in each, for the reason the owner resolver was deduplicated in #700: a
 * second copy is where the rationale above stops being true of one of them.
 */
export function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

/**
 * The branch a worktree is on, asked at the moment of writing.
 *
 * Asked rather than passed in: the supervisor changes branches through an
 * iteration it does not itself drive, so the only true answer is the one git
 * gives right now. A detached HEAD is named as such rather than reported as no
 * branch at all — it is where a loop sits between tickets, and "detached
 * abc1234" and "could not ask git" are different facts.
 */
export function branchOf(root: string): string | null {
  const named = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (named) return named.trim();
  const head = git(["rev-parse", "--short", "HEAD"], root);
  return head ? `detached ${head.trim()}` : null;
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

// Zero, a negative or anything that does not parse falls back to the default:
// a mistyped override must not turn a window into "always" or "never".
const envSeconds = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : fallback;
};

function clockFromEnv(): Clock {
  return {
    nowMs: Date.now(),
    loopStaleAfterMs: envSeconds("RALPH_STALE_AFTER_SECONDS", DEFAULT_LOOP_STALE_AFTER_MS),
    worktreeStaleAfterMs: envSeconds(
      "RALPH_WORKTREE_STALE_AFTER_SECONDS",
      DEFAULT_WORKTREE_STALE_AFTER_MS,
    ),
  };
}

function runRecord(root: string, argv: string[]): void {
  const event = flag(argv, "event");
  if (!event) throw new Error("record needs --event <name>");
  const statePath = join(root, STATE_RELATIVE_PATH);
  const previous = readState(root).state;
  const stopKind = flag(argv, "stop");
  if (stopKind !== undefined && !isStopKind(stopKind)) {
    throw new Error(`--stop must be one of ${STOP_KINDS.join(", ")}; got '${stopKind}'`);
  }
  // Refused here rather than written and rejected on the way back out: a
  // record `parseLoopState` throws away is indistinguishable from no record at
  // all, so a mistyped stage would degrade the panel with nothing to say why.
  const stage = flag(argv, "stage");
  if (stage !== undefined && !isStage(stage)) {
    throw new Error(`--stage must be one of ${STAGES.join(", ")}; got '${stage}'`);
  }
  const phase = flag(argv, "phase");
  if (phase !== undefined && !isPhase(phase)) {
    throw new Error(`--phase must be one of ${PHASES.join(", ")}; got '${phase}'`);
  }
  const resumedAt = flag(argv, "resumed-at");
  if (resumedAt !== undefined && !isPhase(resumedAt)) {
    throw new Error(`--resumed-at must be one of ${PHASES.join(", ")}; got '${resumedAt}'`);
  }
  const iterationRaw = flag(argv, "iteration");
  const maxRaw = flag(argv, "max");
  const branch = branchOf(root);
  const state = applyRecord(
    previous,
    {
      event,
      detail: flag(argv, "detail"),
      stage,
      branch,
      ...(phase !== undefined ? { phase } : {}),
      ...(resumedAt !== undefined ? { resumedAt } : {}),
      ...(iterationRaw !== undefined
        ? {
            iteration: {
              index: Number(iterationRaw),
              max: maxRaw !== undefined ? Number(maxRaw) : null,
            },
          }
        : {}),
      ...(stopKind !== undefined ? { stop: { kind: stopKind, why: flag(argv, "why") ?? event } } : {}),
      ...(process.env.RALPH_SESSION_ID?.trim() ? { session: process.env.RALPH_SESSION_ID.trim() } : {}),
    },
    {
      // The run id is what the usage ledger and the supervisor log key on, so
      // an unset one is recorded as `adhoc` rather than invented — the same
      // word `usage.py` uses for a hand-run step.
      run: process.env.RALPH_RUN_ID ?? previous?.run ?? "adhoc",
      // The roster's own resolver — the environment, then this worktree's
      // `ralph/.loop-name`, refusing a name the claim fence has never heard of.
      // Reused rather than restated because `ralph.sh`, the frontier and the
      // preflight all resolve the identity through it, and a fourth copy is
      // how the panel comes to file a run under the other loop's name.
      loop: currentLoop(process.env, join(root, ".ralph/loop-name")),
      // The supervisor is this process's parent: `record` is invoked from
      // inside `ralph.sh`, so `ppid` is the pid an operator would `kill`, and
      // this process's own pid is gone by the time anyone reads the file.
      pid: Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null,
      host: hostname(),
      worktree: resolved(root),
    },
    new Date().toISOString(),
  );
  writeState(statePath, state);
}

function runStatus(root: string, argv: string[]): void {
  const clock = clockFromEnv();
  const snap = snapshot(root, clock);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  for (const line of report(snap, clock)) console.log(line);
}

function runUnattended(root: string, argv: string[]): void {
  const clock = clockFromEnv();
  const loops = unattendedLoops(
    snapshot(root, clock).loops,
    clock,
    envSeconds("RALPH_UNATTENDED_AFTER_SECONDS", DEFAULT_UNATTENDED_AFTER_MS),
  );
  if (argv.includes("--json")) {
    console.log(JSON.stringify(loops, null, 2));
    return;
  }
  for (const loop of loops) {
    console.log(`${loop.loop}: ${loop.stopKind ?? "dead"} since ${loop.downSince}`);
  }
}

function main(): void {
  // Anchored like `ralph.sh`, `status.sh` and the preflight, so every relative
  // path resolves from the worktree root wherever this was invoked from — the
  // record belongs to the worktree holding this file, not to whatever
  // directory somebody happened to run it from.
  //
  // `RALPH_STATE_ROOT` overrides that for the tests, which drive this CLI
  // against scratch worktrees: without it they would write their fixtures into
  // the real `.ralph/logs/` of the checkout running the suite.
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  process.chdir(root);
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "record") runRecord(root, argv.slice(1));
  else if (command === "status" || command === undefined) runStatus(root, argv.slice(1));
  else if (command === "unattended") runUnattended(root, argv.slice(1));
  else throw new Error(`unknown command '${command}'; expected 'record', 'status' or 'unattended'`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`loop-state: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
