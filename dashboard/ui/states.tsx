/**
 * Every state the loop page header can be in, rendered with the real
 * component over canned inputs. Served by the design preview at `/states`.
 */
import {
  CONTROL_OUTCOMES,
  LOOP_ROLES,
  LOOP_STATUSES,
  ORDERLY_STOP_KINDS,
  PHASES,
  STAGES,
  type CheckoutReport,
  type ControlCommand,
  type ControlOutcome,
  type ControlResult,
  type ControlStopConfirmation,
  type ControlView,
  type DashboardLoop,
  type InterruptCheck,
  type RestartResult,
  type ResumeWorkResult,
  type StartResult,
  type StopNowResult,
} from "../contracts";
import { LoopHeader } from "./controls";
import type { ControlsState } from "./control-model";

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

const base: DashboardLoop = {
  loop: "ralph",
  role: "coder",
  present: true,
  worktree: "/home/faros/ralph/worktrees/ralph",
  loopStatus: "running",
  worktreeStatus: "live",
  branch: "detached 468f4603",
  supervisor: "alive",
  run: "run-ralph-01",
  issue: 961,
  iteration: { index: 4, max: 50 },
  stage: "iteration",
  phase: "implement",
  resumedAt: null,
  stopReason: null,
  stateProblem: null,
  presence: null,
  heartbeat: ago(20),
  lastEvent: null,
  repoUrl: "https://github.com/felipearosr/ralph",
  claims: [],
  issueTitle: "Lineup catalog",
  actors: [],
  presenceProblem: null,
  usage: null,
  journal: null,
  timeline: null,
  runnerFailure: { state: "none", reason: null, current: false },
  // This gallery draws one loop's header; the triage panel is project-level, so
  // it is exercised in the full-dashboard preview (`dashboard/preview.ts`).
  triage: null,
  // Likewise the case: it leads the doctor's loop CARD, which this gallery does
  // not draw, so the `doc` loop in `dashboard/preview.ts` is where it is read.
  case: null,
};

const free: ControlView = {
  loop: "ralph",
  generatedAt: ago(0),
  present: true,
  worktree: base.worktree,
  run: "run-ralph-01",
  loopStatus: "running",
  status: "clear",
  channel: { state: "ok", why: null, since: null, retryAt: null },
  hold: null,
  blocked: null,
  stop: null,
  commands: [],
  pendingApprovals: [],
  gates: [],
  deferrals: [],
  givenUp: [],
};
const paused: ControlView = {
  ...free,
  hold: { kind: "pause", why: "paused from the dashboard", since: ago(95), gate: null },
};
const pausedAtPhase: ControlView = {
  ...free,
  hold: { kind: "pause", why: "pause after review", since: ago(40), gate: null, phase: "finish", after: "review" },
};
const gated: ControlView = {
  ...free,
  hold: { kind: "approval", why: "Merge PR #26 into main?", since: ago(420), gate: "merge" },
  pendingApprovals: [{ gate: "merge", question: "Merge PR #26 into main? CI is green.", since: ago(420) }],
};
const gatesArmed: ControlView = {
  ...free,
  gates: [
    { phase: "review", since: ago(3600), why: null },
    { phase: "finish", since: ago(3600), why: "a person opens the PRs" },
  ],
};
const heldAtGate: ControlView = {
  ...gatesArmed,
  hold: {
    kind: "approval",
    why: "decision gate before-finish: continue into finish? (a person opens the PRs)",
    since: ago(60),
    gate: "before-finish",
    phase: "finish",
  },
  pendingApprovals: [{ gate: "before-finish", question: "continue into finish? (a person opens the PRs)", since: ago(60) }],
};
const gatedNoName: ControlView = {
  ...free,
  hold: { kind: "approval", why: "Continue past preflight warnings?", since: ago(30), gate: null },
};

function result(
  action: ControlCommand,
  outcome: ControlOutcome,
  recorded: boolean,
  why: string,
  stop: ControlResult["stop"] = null,
): ControlResult {
  return {
    loop: "ralph",
    action,
    key: "k-1",
    run: "run-ralph-01",
    issue: action === "abandon" || action === "release" ? 944 : null,
    outcome,
    recorded,
    why,
    at: ago(2),
    stop,
  };
}

function started(outcome: StartResult["outcome"], pid: number | null, why: string): StartResult {
  return { loop: "ralph", action: "start", worktree: base.worktree!, outcome, pid, why, at: ago(2) };
}

const clean: CheckoutReport = {
  worktree: base.worktree!,
  branch: "ralph/961-lineup-catalog",
  readable: true,
  dirty: false,
  changes: [],
  claims: [],
  midTicket: false,
  unpushed: [],
};
const midTicket: CheckoutReport = {
  ...clean,
  dirty: true,
  changes: [" M dashboard/ui/app.tsx", "?? dashboard/ui/records.tsx"],
  claims: [{ issue: 961, run: "run-ralph-01", loop: "ralph", branch: "ralph/961-lineup-catalog" }],
  midTicket: true,
};

/** What a Stop now cut short: a half-finished ticket, some of it committed. */
const leftBehind: CheckoutReport = {
  ...midTicket,
  unpushed: ["a1b2c3d feat(dashboard): the catalog's read path", "e4f5a6b test(dashboard): catalog fixtures"],
};

const CHECKED: InterruptCheck[] = [
  { check: "pid-file", ok: true, detail: ".ralph/logs/supervisor.pid names pid 1732294" },
  { check: "alive", ok: true, detail: "pid 1732294 is running" },
  { check: "ralph.sh", ok: true, detail: "pid 1732294 is running 'bash /home/faros/ralph/ralph.sh 50'" },
  { check: "cwd", ok: true, detail: "pid 1732294 is working in /home/faros/ralph/worktrees/ralph" },
  { check: "group", ok: true, detail: "pid 1732294's process group 1732290 is led by its start.sh wrapper" },
];

function stoppedNow(over: Partial<StopNowResult>): StopNowResult {
  return {
    loop: "ralph",
    action: "stop-now",
    key: "now-1",
    worktree: base.worktree!,
    run: "run-ralph-01",
    outcome: "interrupted",
    why: "ralph was interrupted in iteration 4; #961 stays claimed until it is resumed or released (SIGTERM to process group 1732290)",
    at: ago(2),
    target: { pidFile: ".ralph/logs/supervisor.pid", pid: 1732294, group: 1732290 },
    checks: CHECKED,
    signals: ["SIGTERM"],
    recorded: true,
    stop: { kind: "interrupted", confirmation: "confirmed", iteration: 4, issue: 961 },
    audit: ".ralph/control/signals.jsonl",
    ...over,
  };
}

function resumed(outcome: ResumeWorkResult["outcome"], why: string): ResumeWorkResult {
  return {
    loop: "ralph",
    action: "resume-work",
    worktree: base.worktree!,
    outcome,
    pid: outcome === "started" ? 1732301 : null,
    why,
    at: ago(2),
    checkout: leftBehind,
  };
}

/** A loop after Stop now: supervisor gone, its claim kept, the record's interrupted stop. */
const interruptedEntry: Partial<DashboardLoop> = {
  supervisor: "dead",
  loopStatus: "interrupted",
  stage: "stopped",
  phase: null,
  stopReason: { kind: "interrupted", why: "the model held a turn open for 40 minutes", at: ago(60) },
  claims: [
    { issue: 961, title: "Lineup catalog", loop: "ralph", status: "active", claimedAt: new Date(Date.now() - 2_700_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), run: "run-ralph-01", labeled: true, leased: true },
  ],
};
const interruptedStatus: ControlView = {
  ...free,
  loopStatus: "interrupted",
  status: "stopped",
  stop: {
    kind: "interrupted",
    why: "the model held a turn open for 40 minutes",
    at: ago(60),
    confirmation: "confirmed",
    iteration: 4,
    issue: 961,
  },
};

function restarted(over: Partial<RestartResult>): RestartResult {
  return {
    loop: "ralph",
    action: "restart-to-apply",
    key: "k-2",
    worktree: base.worktree!,
    outcome: "started",
    halt: null,
    why: "stopped at the iteration boundary and started again",
    at: ago(2),
    stop: null,
    confirmation: "confirmed",
    start: { outcome: "started", pid: 1732301, why: "Started Ralph supervisor (pid 1732301)" },
    checkout: clean,
    ...over,
  };
}

const OUTCOME_ACTION: Record<ControlOutcome, ControlCommand> = {
  applied: "approve",
  refused: "resume",
  replayed: "pause",
  "needs-reconfirmation": "stop",
  "not-for-this-loop": "deny",
  deferred: "pause",
};

const OUTCOME_WHY: Record<ControlOutcome, string> = {
  applied: "approve applied",
  refused: "the loop is not paused, so there is nothing to resume",
  replayed: "this command was already applied under the same key",
  "needs-reconfirmation": "the run changed since the page loaded; the command targets run-ralph-00",
  "not-for-this-loop": "the command names a different loop",
  deferred: "the loop is between iterations; it will apply after the current stage",
};

interface State {
  name: string;
  note?: string;
  entry?: Partial<DashboardLoop>;
  status?: ControlView | null;
  initial?: Partial<ControlsState>;
}

interface Group {
  id: string;
  title: string;
  about: string;
  states: State[];
}

const GROUPS: Group[] = [
  {
    id: "status",
    title: "Loop status badge",
    about: "Every `loopStatus`, with a live supervisor and no hold.",
    states: LOOP_STATUSES.map((loopStatus) => ({ name: `loopStatus: ${loopStatus}`, entry: { loopStatus } })),
  },
  {
    id: "stage",
    title: "Stage badge",
    about: "Every `stage`, every iteration `phase`, plus none, on a running loop with no hold.",
    states: [
      ...STAGES.map((stage) => ({ name: `stage: ${stage}`, entry: { stage, phase: stage === "iteration" ? ("implement" as const) : null } })),
      ...PHASES.map((phase) => ({ name: `stage: iteration · ${phase}`, entry: { stage: "iteration" as const, phase } })),
      { name: "stage: iteration · resuming at verify", entry: { stage: "iteration" as const, phase: "verify" as const, resumedAt: "verify" as const } },
      { name: "stage: null", entry: { stage: null, phase: null } },
    ],
  },
  {
    id: "role",
    title: "Role badge",
    about: "Every role a roster entry can hold. A role also hides the panels it gives no meaning to.",
    states: LOOP_ROLES.map((role) => ({ name: `role: ${role}`, entry: { role } })),
  },
  {
    id: "subtitle",
    title: "Subtitle",
    about: "Issue and branch present or missing.",
    states: [
      { name: "issue + branch" },
      { name: "issue only", entry: { branch: null } },
      { name: "branch only", entry: { issue: null } },
      { name: "neither", entry: { issue: null, branch: null } },
      {
        name: "long branch",
        entry: { branch: "felipearosr/orquestrator-dashboard-loop-controls-and-lineup-catalog-with-a-very-long-name" },
      },
    ],
  },
  {
    id: "buttons",
    title: "Buttons and holds",
    about: "Which buttons show, from supervisor liveness, checkout presence and the control record's hold.",
    states: [
      { name: "alive · no hold", note: "Pause, Stop" },
      { name: "alive · paused", status: paused, entry: { stage: "paused" }, note: "Resume, Stop + pause alert" },
      {
        name: "alive · held before a phase",
        status: pausedAtPhase,
        entry: { stage: "paused", phase: "finish" },
        note: "Held before finish: stage and alert both name the phase",
      },
      { name: "alive · stop armed at next phase", initial: { armed: true, scope: "phase" }, note: "Confirm stop at next phase" },
      { name: "alive · approval gate (named)", status: gated, entry: { stage: "gate" }, note: "Stop + Approve/Deny" },
      { name: "alive · approval gate (unnamed)", status: gatedNoName, entry: { stage: "gate" } },
      { name: "alive · gates armed", status: gatesArmed, note: "Asks before review and finish; each chip disarms" },
      {
        name: "alive · held at an armed gate",
        status: heldAtGate,
        entry: { stage: "paused", phase: "finish" },
        note: "Approve/Deny, held before finish, the gate still armed",
      },
      { name: "alive · control status still loading", status: null, note: "status = null → treated as no hold" },
      { name: "dead · no hold", entry: { supervisor: "dead", loopStatus: "stale" }, note: "Start" },
      { name: "unknown liveness", entry: { supervisor: "unknown", loopStatus: "unknown" }, note: "Start" },
      {
        name: "not present",
        entry: { present: false, supervisor: "unknown", loopStatus: "unknown", stage: null, issue: null, branch: null },
        note: "No buttons except Settings",
      },
    ],
  },
  {
    id: "recovery",
    title: "Retry, abandon and release",
    about: "A failed loop with its supervisor gone, the claims it can recover, and each recorded answer.",
    states: [
      {
        name: "dead · failed · own claim and an expired one",
        entry: {
          supervisor: "dead",
          loopStatus: "failed",
          stage: "stopped",
          stopReason: { kind: "failed", why: "review cannot log in", at: ago(600) },
          claims: [
            { issue: 961, title: "Lineup catalog", loop: "ralph", status: "active", claimedAt: new Date(Date.now() - 2_700_000).toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(), run: "run-ralph-01", labeled: true, leased: true },
            { issue: 944, title: "Parallel executors", loop: "ralph", status: "expired", claimedAt: ago(7200), expiresAt: ago(3600), run: "run-ralph-00", labeled: true, leased: true },
          ],
        },
        note: "Start, Retry + Claims: Abandon… #944, Release… #961",
      },
      {
        name: "alive · expired claim",
        entry: {
          claims: [{ issue: 944, title: "Parallel executors", loop: "ralph", status: "expired", claimedAt: ago(7200), expiresAt: ago(3600), run: "run-ralph-00", labeled: true, leased: true }],
        },
        note: "Abandon only; a live run's own claim is not offered for release",
      },
      {
        name: "abandon armed",
        entry: {
          supervisor: "dead",
          loopStatus: "stale",
          claims: [{ issue: 944, title: "Parallel executors", loop: "ralph", status: "expired", claimedAt: ago(7200), expiresAt: ago(3600), run: "run-ralph-00", labeled: true, leased: true }],
        },
        initial: { claimArmed: { action: "abandon", issue: 944 } },
      },
      {
        name: "retry applied · recorded",
        entry: { supervisor: "dead", loopStatus: "stale" },
        initial: { last: result("retry", "applied", true, "retrying as run-ralph-01/attempt-5 after run-ralph-01/attempt-4 — retry issued from the local inbox") },
      },
      {
        name: "abandon refused · unexpired",
        entry: { supervisor: "dead", loopStatus: "stale" },
        initial: { last: result("abandon", "refused", true, "issue #944 is held by ralph@fedora (run run-ralph-00, active) until 2026-09-22T18:40:00.000Z") },
      },
      {
        name: "release refused · not the owner",
        entry: { supervisor: "dead", loopStatus: "stale" },
        initial: { last: result("release", "refused", true, "issue #944 is claimed by run run-ralph-00, not run-ralph-01; it expired at 2026-09-22T16:00:00.000Z, so abandon takes it back") },
      },
    ],
  },
  {
    id: "stop-now",
    title: "Stop now, and the way back",
    about: "The emergency stop: armed, in flight, each answer; then the interrupted loop's recovery panel and Resume work's answers.",
    states: [
      { name: "alive · Stop now armed", initial: { nowArmed: true }, note: "Reason field, Confirm stop now" },
      { name: "pending: stop now", initial: { pending: { action: "stop-now", body: {} } } },
      { name: "stopped now · recorded", initial: { last: stoppedNow({}) } },
      {
        name: "stopped now · SIGKILL needed",
        initial: { last: stoppedNow({ signals: ["SIGTERM", "SIGKILL"], why: "ralph was interrupted in iteration 4 (SIGTERM, then SIGKILL to process group 1732290)" }) },
      },
      {
        name: "stopped now · not recorded",
        initial: {
          last: stoppedNow({
            recorded: false,
            stop: null,
            why: "ralph was interrupted, but the stop was not recorded: a supervisor holds the loop's lock again (SIGTERM to process group 1732290)",
          }),
        },
      },
      {
        name: "refused · another checkout's ralph.sh",
        initial: {
          last: stoppedNow({
            outcome: "refused",
            signals: [],
            recorded: false,
            stop: null,
            why: "nothing was signalled: pid 1732294 is working in /home/faros/ralph/worktrees/rafa, not this checkout (/home/faros/ralph/worktrees/ralph)",
            checks: [...CHECKED.slice(0, 3), { check: "cwd", ok: false, detail: "pid 1732294 is working in /home/faros/ralph/worktrees/rafa, not this checkout (/home/faros/ralph/worktrees/ralph)" }],
          }),
        },
      },
      {
        name: "refused · no pid file",
        initial: {
          last: stoppedNow({
            outcome: "refused",
            signals: [],
            recorded: false,
            stop: null,
            target: { pidFile: ".ralph/logs/supervisor.pid", pid: null, group: null },
            why: "nothing was signalled: .ralph/logs/supervisor.pid could not be read (ENOENT): no supervisor start.sh launched is on record here",
            checks: [{ check: "pid-file", ok: false, detail: ".ralph/logs/supervisor.pid could not be read (ENOENT): no supervisor start.sh launched is on record here" }],
          }),
        },
      },
      {
        name: "survived",
        initial: {
          last: stoppedNow({
            outcome: "survived",
            signals: ["SIGTERM", "SIGKILL"],
            recorded: false,
            stop: null,
            why: "pid 1732294 is still running after SIGTERM and SIGKILL to process group 1732290",
          }),
        },
      },
      {
        name: "interrupted · what it left",
        entry: interruptedEntry,
        status: interruptedStatus,
        initial: { recovery: leftBehind },
        note: "Resume work, Release #961…; no Start",
      },
      { name: "interrupted · reading the worktree", entry: interruptedEntry, status: interruptedStatus, initial: { recovery: null } },
      {
        name: "interrupted · clean, nothing unpushed",
        entry: interruptedEntry,
        status: interruptedStatus,
        initial: { recovery: clean },
      },
      {
        name: "interrupted · worktree unreadable",
        entry: interruptedEntry,
        status: interruptedStatus,
        initial: { recovery: { failed: "HTTP 500: git status exited 128" } },
      },
      {
        name: "interrupted · release armed",
        entry: interruptedEntry,
        status: interruptedStatus,
        initial: { recovery: leftBehind, claimArmed: { action: "release", issue: 961 } },
      },
      {
        name: "resume work: started",
        entry: interruptedEntry,
        status: interruptedStatus,
        initial: {
          recovery: leftBehind,
          last: resumed("started", "Started Ralph supervisor (pid 1732301) (worktree left as it is: 2 uncommitted change(s); mid-ticket on #961)"),
        },
      },
      {
        name: "resume work: refused",
        entry: interruptedEntry,
        status: interruptedStatus,
        initial: { recovery: leftBehind, last: resumed("refused", "ralph's supervisor is running; there is nothing to resume") },
      },
    ],
  },
  {
    id: "transient",
    title: "Transient button states",
    about: "Stop armed, and each action while its request is in flight.",
    states: [
      { name: "stop armed", initial: { armed: true } },
      { name: "pending: pause", initial: { pending: { action: "pause", body: {} } } },
      { name: "pending: stop", initial: { pending: { action: "stop", body: {} } } },
      { name: "pending: resume", status: paused, entry: { stage: "paused" }, initial: { pending: { action: "resume", body: {} } } },
      { name: "pending: approve", status: gated, entry: { stage: "gate" }, initial: { pending: { action: "approve", body: {} } } },
      { name: "pending: deny", status: gated, entry: { stage: "gate" }, initial: { pending: { action: "deny", body: {} } } },
      { name: "pending: start", entry: { supervisor: "dead", loopStatus: "stale" }, initial: { pending: { action: "start", body: {} } } },
    ],
  },
  {
    id: "result",
    title: "Command result banner",
    about: "Every outcome, read back from the record or not, and a request that failed outright.",
    states: [
      {
        name: "request failed",
        initial: { last: { failed: { kind: "Failed", message: "the control channel did not answer", status: 502 } } },
      },
      ...CONTROL_OUTCOMES.flatMap((outcome) =>
        [false, true].map((recorded) => ({
          name: `${outcome} · recorded: ${recorded}`,
          initial: { last: result(OUTCOME_ACTION[outcome], outcome, recorded, OUTCOME_WHY[outcome]) },
        })),
      ),
      {
        name: "start: started (multi-line why)",
        entry: { supervisor: "dead", loopStatus: "stale" },
        initial: {
          last: started(
            "started",
            1732294,
            "Started Ralph supervisor (pid 1732294); waits 300s, runs up to 50 iterations.\nLog: .ralph/logs/loop.stdout",
          ),
        },
      },
      {
        name: "start: already running",
        initial: { last: started("already-running", null, "a supervisor already holds the worktree lock") },
      },
      {
        name: "start: failed",
        entry: { supervisor: "dead", loopStatus: "stale" },
        initial: { last: started("failed", null, "start.sh exited 1: preflight failed") },
      },
    ],
  },
  {
    id: "restart",
    title: "Restart to apply",
    about: "The armed confirmation with its checkout report, and every restart answer.",
    states: [
      { name: "armed · reading checkout", initial: { restartArmed: true } },
      { name: "armed · clean checkout", initial: { restartArmed: true, checkout: clean } },
      { name: "armed · dirty, mid-ticket", initial: { restartArmed: true, checkout: midTicket } },
      { name: "pending: restart", initial: { pending: { action: "restart", body: {} } } },
      { name: "restarted", initial: { last: restarted({}) } },
      {
        name: "halted · stop pending",
        initial: {
          last: restarted({
            outcome: "halted",
            halt: "stop-pending",
            confirmation: "pending",
            start: null,
            why: "the stop was not confirmed within 120s; nothing was started",
            checkout: midTicket,
          }),
        },
      },
      {
        name: "halted · run replaced",
        initial: {
          last: restarted({
            outcome: "halted",
            halt: "stop-refused",
            confirmation: null,
            start: null,
            why: "the loop is now held by run-ralph-02",
            stop: { ...result("stop", "needs-reconfirmation", false, "run replaced"), key: "k-2" },
          }),
        },
      },
      {
        name: "stopped, start failed",
        initial: {
          last: restarted({
            outcome: "failed",
            start: { outcome: "failed", pid: null, why: "start.sh exited 1" },
            why: "the stop was confirmed, but start.sh failed",
          }),
        },
      },
    ],
  },
  {
    id: "channel",
    title: "Control record",
    about: "What the control view says beyond a hold. A degraded channel is never drawn as a hold or a stop.",
    states: [
      {
        name: "channel degraded",
        status: {
          ...free,
          status: "degraded",
          channel: { state: "degraded", why: "the channel did not answer", since: ago(300), retryAt: new Date(Date.now() + 60_000).toISOString() },
        },
      },
      {
        name: "channel unreachable",
        status: { ...free, status: "degraded", channel: { state: "unreachable", why: "controls exited 1", since: null, retryAt: null } },
      },
      {
        name: "stop pending in the record",
        status: { ...free, status: "stop-pending", stop: { kind: "blocked", why: "stopped from the dashboard", at: ago(40), confirmation: "pending", iteration: null, issue: null } },
      },
      {
        name: "stop unreachable in the record",
        status: { ...free, status: "stop-unreachable", stop: { kind: "failed", why: "operator stop", at: ago(40), confirmation: "unreachable", iteration: null, issue: null } },
      },
      {
        name: "deferred and given up",
        status: {
          ...free,
          deferrals: [{ key: "d-1", command: "pause", since: ago(90), attempts: 2 }],
          givenUp: [{ key: "g-1", command: "resume", at: ago(900), attempts: 5, remedy: "re-send it once the loop is polling again" }],
        },
      },
    ],
  },
  {
    id: "stop",
    title: "Stop result",
    about: "Every orderly stop kind × confirmation. `interrupted` is Stop now's, above.",
    states: ORDERLY_STOP_KINDS.flatMap((kind) =>
      (["pending", "confirmed", "unreachable"] as ControlStopConfirmation[]).map((confirmation) => ({
        name: `stop ${kind} · ${confirmation}`,
        entry: confirmation === "confirmed" ? { supervisor: "dead" as const, loopStatus: kind, stage: "stopped" as const } : {},
        initial: {
          last: result("stop", "applied", confirmation !== "pending", "stopped from the dashboard", { kind, confirmation }),
        },
      })),
    ),
  },
  {
    id: "contradictions",
    title: "Contradictory combinations",
    about: "Inputs from the observer, the durable record and the control record that disagree. These are the likely bugs.",
    states: [
      {
        name: "stage gate · no hold · approve just sent",
        note: "The screenshot: Gate badge with no approval alert, Pause offered, banner still shown",
        entry: { stage: "gate" },
        initial: { last: result("approve", "applied", false, "approve applied (preview: nothing was sent)") },
      },
      { name: "stage gate · no hold", entry: { stage: "gate" }, note: "Gate badge, but Pause/Stop instead of Approve/Deny" },
      { name: "stage paused · no hold", entry: { stage: "paused" }, note: "Paused badge next to a Pause button" },
      { name: "approval hold · stage iteration", status: gated, note: "Awaiting a decision while the stage says iterating" },
      { name: "pause hold · status running", status: paused, note: "Badge reads Paused; the stage still says Iteration" },
      {
        name: "hold · supervisor dead",
        status: paused,
        entry: { supervisor: "dead", loopStatus: "stale" },
        note: "Paused alert with a Start button and no Resume",
      },
      {
        name: "approval hold · supervisor dead",
        status: gated,
        entry: { supervisor: "dead", loopStatus: "blocked", stage: "gate" },
        note: "Awaiting a decision, but no Approve/Deny can show",
      },
      { name: "stage stopped · supervisor alive", entry: { stage: "stopped" }, note: "Stopped badge with Pause/Stop" },
      { name: "status completed · supervisor alive", entry: { loopStatus: "completed" } },
      {
        name: "status running · supervisor dead",
        entry: { supervisor: "dead" },
        note: "Pulsing Running next to a Start button",
      },
      {
        name: "resume sent · still paused",
        status: paused,
        entry: { stage: "paused" },
        initial: { last: result("resume", "applied", false, "resume applied") },
      },
      {
        name: "pause sent · hold shown · stage iteration",
        status: paused,
        initial: { last: result("pause", "applied", true, "pause applied") },
      },
      {
        name: "stop confirmed · supervisor still alive",
        initial: {
          last: result("stop", "applied", true, "stopped from the dashboard", { kind: "blocked", confirmation: "confirmed" }),
        },
      },
      {
        name: "not present · hold in record",
        status: gated,
        entry: { present: false, supervisor: "unknown", loopStatus: "unknown", stage: null },
      },
    ],
  },
];

export function StatesGallery() {
  const count = GROUPS.reduce((sum, group) => sum + group.states.length, 0);
  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Loop header states</h1>
        <p className="text-sm text-muted-foreground">
          {count} states of the real <code className="font-mono">LoopHeader</code> over canned inputs. Buttons send to a
          loop that does not exist, so a click shows the failed banner.
        </p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {GROUPS.map((group) => (
            <a key={group.id} href={`#${group.id}`} className="text-muted-foreground underline-offset-4 hover:underline">
              {group.title} ({group.states.length})
            </a>
          ))}
        </nav>
      </div>

      {GROUPS.map((group) => (
        <section key={group.id} id={group.id} className="scroll-mt-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{group.title}</h2>
            <p className="text-sm text-muted-foreground">{group.about}</p>
          </div>
          <div className="space-y-4">
            {group.states.map((state) => (
              <figure key={state.name} className="space-y-2">
                <figcaption className="flex flex-wrap items-baseline gap-x-3 font-mono text-xs">
                  <span>{state.name}</span>
                  {state.note && <span className="text-muted-foreground">{state.note}</span>}
                </figcaption>
                <div className="rounded-lg border p-5">
                  <LoopHeader
                    entry={{ ...base, ...state.entry }}
                    status={state.status === undefined ? free : state.status}
                    onSent={() => undefined}
                    initial={state.initial}
                  />
                </div>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
