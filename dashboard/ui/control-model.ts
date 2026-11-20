/**
 * Which loop controls apply, and where each one is posted, kept out of the
 * `Controls` component so the rules can be tested without rendering. The
 * component calls `controlsFor` once and gates every button and menu item on
 * its fields; nothing here fetches or reads the clock.
 */
import type {
  CheckoutReport,
  ClaimView,
  ControlCommand,
  ControlResult,
  ControlView,
  DashboardLoop,
  Phase,
  RestartResult,
  ResumeWorkResult,
  StartResult,
  StopNowResult,
} from "../contracts";
import { ROLE_PANELS } from "../contracts";
import type { CommandError, CommandPath } from "./command-model";

/** Every button on the loop page: the channel's commands, plus start, restart, Stop now and Resume work. */
export type Action = ControlCommand | "start" | "restart" | "stop-now" | "resume-work";

/** The two commands that act on one claim, and so name its ticket. */
export type ClaimAction = "abandon" | "release";

export type Answer = ControlResult | StartResult | RestartResult | StopNowResult | ResumeWorkResult | { failed: CommandError };

/** Where a pause or stop applies. The loop's default, and the page's, is the next iteration. */
export type Scope = "iteration" | "phase";

/** The request field a scope is sent as: nothing for the default. */
export const scoped = (scope: Scope): Record<string, unknown> => (scope === "phase" ? { scope: "phase" } : {});

/**
 * Where each action is posted. The channel's commands go to `/api/control`;
 * start, restart, Stop now and Resume work to their own routes. Every command
 * but start and Resume work names the run the page last observed, so one
 * aimed at a replaced run comes back `needs-reconfirmation` instead of
 * stopping a supervisor nobody saw.
 */
export function requestFor(entry: DashboardLoop, action: Action, body: Record<string, unknown>): [CommandPath, Record<string, unknown>] {
  const run = entry.run === null ? {} : { run: entry.run };
  if (action === "start") return ["/api/start", { loop: entry.loop }];
  if (action === "restart") return ["/api/restart", { loop: entry.loop, ...run, ...body }];
  if (action === "stop-now") return ["/api/stop-now", { loop: entry.loop, ...run, ...body }];
  if (action === "resume-work") return ["/api/resume-work", { loop: entry.loop }];
  return ["/api/control", { loop: entry.loop, action, ...run, ...body }];
}

/** What a loop page may offer right now, from the observer and the control view. */
export interface LoopControls {
  live: boolean;
  gone: boolean;
  hold: ControlView["hold"];
  /** The control view's stop, when it is an interrupted one; its details show in the recovery panel. */
  stopped: NonNullable<ControlView["stop"]> | null;
  phases: boolean;
  /** The scope actually sent: the operator's choice, or the iteration for a role without phases. */
  scope: Scope;
  interrupted: boolean;
  ticket: number | null;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canDecide: boolean;
  retryable: Phase | null;
  canStop: boolean;
  canRestart: boolean;
  canRetry: boolean;
  releasable: ClaimView[];
  abandonable: ClaimView[];
  recoverable: { claim: ClaimView; action: ClaimAction }[];
  /** A live loop whose control view has not been read: nothing can be offered yet. */
  unavailable: boolean;
  /** The decision gates can be armed or disarmed: the view is read, the loop has a checkout and runs phases. */
  canGate: boolean;
  /** A loop with no checkout: the card's menu sends the operator to its page to create one. */
  canCreateCheckout: boolean;
  /** A command's answer can be re-issued against the run the loop holds now; never without a checkout. */
  canReissue: boolean;
  /**
   * The "No action applies" / "No checkout to act on" line shows: no control
   * and no recovery is offered. Restart is not counted, since it is offered
   * exactly when Stop is; an interruption is, since its recovery panel shows.
   */
  nothingApplies: boolean;
}

/** The controls a loop page offers, given the operator's chosen scope. */
export function controlsFor(entry: DashboardLoop, status: ControlView | null, chosenScope: Scope): LoopControls {
  const live = entry.supervisor === "alive";
  const hold = status?.hold ?? null;
  // Recovery needs a supervisor that is either there to apply it or known to
  // be gone, so the page applies it; one it cannot see would leave the
  // command for a new run, which refuses it as naming a replaced one.
  const gone = entry.supervisor === "dead";
  // Stopped now: the recovery panel offers Resume work and Release instead of a plain Start.
  const stopped = status?.stop?.kind === "interrupted" ? status.stop : null;
  const interrupted = entry.present && gone && (stopped !== null || entry.stopReason?.kind === "interrupted");
  const ticket = stopped?.issue ?? null;
  // A role that runs no phases has no phase to pause before, stop at, retry or
  // gate: the supervisor would never reach a boundary to honour them at. The
  // controls are hidden rather than offered and ignored.
  const phases = ROLE_PANELS[entry.role].phases;
  // Without phases the selector is hidden, so a scope left over from an
  // earlier loop's panel must not still be sent as one.
  const scope: Scope = phases ? chosenScope : "iteration";
  const canStart = entry.present && !live && !interrupted;
  const canPause = live && status !== null && hold === null;
  const canResume = live && hold?.kind === "pause";
  const canDecide = live && hold?.kind === "approval";
  // Held at a phase boundary: the phase just finished can be run again, in a fresh session.
  const retryable = phases && live && hold?.phase !== undefined ? (hold?.after ?? null) : null;
  const canStop = live;
  const canRestart = live;
  // Only a failure is retried; the loop refuses any other ending.
  const canRetry = entry.present && gone && entry.stopReason?.kind === "failed";
  // A run gives up only its own claim, lapsed or not, and only while no
  // supervisor is working it.
  const releasable =
    entry.present && gone && entry.run !== null
      ? entry.claims.filter((claim) => (claim.status === "active" || claim.status === "expired") && claim.run === entry.run)
      : [];
  // Only a lapsed claim may be taken back; the loop refuses a live one, naming its expiry.
  // The run's own lapsed claim is released rather than abandoned.
  const abandonable =
    entry.present && entry.supervisor !== "unknown"
      ? entry.claims.filter((claim) => claim.status === "expired" && !releasable.includes(claim))
      : [];
  const recoverable = [
    ...abandonable.map((claim) => ({ claim, action: "abandon" as const })),
    // The interrupted ticket is offered in the recovery panel, beside Resume work.
    ...releasable
      .filter((claim) => !(interrupted && claim.issue === ticket))
      .map((claim) => ({ claim, action: "release" as const })),
  ];
  const unavailable = live && status === null;
  const canGate = status !== null && entry.present && phases;
  const canCreateCheckout = !entry.present;
  const canReissue = entry.present;
  const nothingApplies =
    !canStart && !canPause && !canResume && !canDecide && !canStop && !canRetry && !interrupted && recoverable.length === 0;
  return {
    live,
    gone,
    hold,
    stopped,
    phases,
    scope,
    interrupted,
    ticket,
    canStart,
    canPause,
    canResume,
    canDecide,
    retryable,
    canStop,
    canRestart,
    canRetry,
    releasable,
    abandonable,
    recoverable,
    unavailable,
    canGate,
    canCreateCheckout,
    canReissue,
    nothingApplies,
  };
}

/** A command on its way: what was sent, so its button can say so. */
export type Pending = { action: Action; body: Record<string, unknown> };

/** A claim's abandon or release, armed and waiting for its confirming click. */
export type ClaimArmed = { action: ClaimAction; issue: number };

/**
 * The loop controls' transient state: what is armed, what is on its way and
 * what the last command said back. It lives here, beside `controlsFor`, so
 * the rules that reset one confirmation when another is armed are cases of
 * one reducer instead of setters each click handler has to remember.
 */
export interface ControlsState {
  pending: Pending | null;
  /** Stop armed, waiting for its confirming click. */
  armed: boolean;
  /** Where Pause and Stop apply: the next iteration boundary, or the next phase boundary. */
  scope: Scope;
  restartArmed: boolean;
  /** Stop now armed, waiting for its confirming click. */
  nowArmed: boolean;
  /** The operator's reason for a Stop now. */
  nowWhy: string;
  claimArmed: ClaimArmed | null;
  /** What a restart would leave in the worktree, read when it is armed. */
  checkout: CheckoutReport | { failed: string } | null;
  /** What an interrupted loop left in its worktree, as the recovery panel shows it. */
  recovery: CheckoutReport | { failed: string } | null;
  last: Answer | null;
  /** Remote only: the command is with the machine and has not been applied yet. */
  queued: boolean;
}

export const INITIAL_CONTROLS: ControlsState = {
  pending: null,
  armed: false,
  scope: "iteration",
  restartArmed: false,
  nowArmed: false,
  nowWhy: "",
  claimArmed: null,
  checkout: null,
  recovery: null,
  last: null,
  queued: false,
};

/** The defaults, overlaid by a seed: `useReducer`'s init, and the states gallery's starting points. */
export function initialControls(seed: Partial<ControlsState> = {}): ControlsState {
  return { ...INITIAL_CONTROLS, ...seed };
}

export type ControlsEvent =
  | { type: "arm-stop"; scope: Scope }
  | { type: "cancel-stop" }
  | { type: "arm-restart" }
  | { type: "cancel-restart" }
  | { type: "arm-now" }
  | { type: "cancel-now" }
  | { type: "edit-why"; text: string }
  | { type: "arm-claim"; claim: ClaimArmed }
  | { type: "cancel-claim" }
  | { type: "choose-scope"; scope: Scope }
  | { type: "send"; action: Action; body: Record<string, unknown> }
  | { type: "answer"; answer: Answer }
  | { type: "failed"; error: CommandError }
  | { type: "queued" }
  | { type: "checkout-read"; report: CheckoutReport }
  | { type: "checkout-failed"; message: string }
  | { type: "recovery-reading" }
  | { type: "recovery-read"; report: CheckoutReport }
  | { type: "recovery-failed"; message: string }
  | { type: "dismiss" }
  | { type: "reissue" };

/** What re-issuing the last answer does: re-arm a destructive confirmation, or send the command again. */
export type Reissue = { kind: "arm-stop" } | { kind: "arm-claim"; claim: ClaimArmed } | { kind: "send"; action: Action } | null;

/**
 * What the last answer's re-issue does, or null when it has none (a failure,
 * or a start, restart, Stop now or Resume work answer, which show no re-issue).
 * WHY a helper rather than a state field: the reducer cannot send, so the
 * renderer reads `reissueOf(last)` before dispatching `reissue` and calls its
 * own send for the `send` kind; the reducer handles the arm kinds with the
 * same helper, so both sides agree on which is which without the state
 * carrying a one-shot "send this" flag an effect would have to clear.
 */
export function reissueOf(last: Answer | null): Reissue {
  if (last === null || !("action" in last)) return null;
  if (last.action === "start" || last.action === "restart-to-apply" || last.action === "stop-now" || last.action === "resume-work") {
    return null;
  }
  // The destructive ones still arm their confirmation.
  if (last.action === "stop") return { kind: "arm-stop" };
  if ((last.action === "abandon" || last.action === "release") && last.issue !== null) {
    return { kind: "arm-claim", claim: { action: last.action, issue: last.issue } };
  }
  return { kind: "send", action: last.action };
}

/** Every confirmation disarmed: arming one, or sending anything, leaves no other waiting for a click. */
const DISARMED = { armed: false, restartArmed: false, nowArmed: false, claimArmed: null } as const;

/** The loop controls' transitions. Pure: the fetches stay in the component, which dispatches what they read. */
export function controlsReducer(state: ControlsState, event: ControlsEvent): ControlsState {
  switch (event.type) {
    case "arm-stop":
      return { ...state, ...DISARMED, armed: true, scope: event.scope };
    case "cancel-stop":
      return { ...state, armed: false };
    case "arm-restart":
      // The worktree is read again for this arming, so the last report is cleared
      // until it lands. A late read from an earlier arming is not fenced (as before).
      return { ...state, ...DISARMED, restartArmed: true, checkout: null };
    case "cancel-restart":
      return { ...state, restartArmed: false };
    case "arm-now":
      return { ...state, ...DISARMED, nowArmed: true };
    case "cancel-now":
      return { ...state, nowArmed: false };
    case "edit-why":
      return { ...state, nowWhy: event.text };
    case "arm-claim":
      return { ...state, ...DISARMED, claimArmed: event.claim };
    case "cancel-claim":
      return { ...state, claimArmed: null };
    case "choose-scope":
      return { ...state, scope: event.scope };
    case "send":
      return { ...state, ...DISARMED, pending: { action: event.action, body: event.body } };
    case "answer":
      return { ...state, last: event.answer, pending: null, queued: false };
    case "failed":
      return { ...state, last: { failed: event.error }, pending: null, queued: false };
    case "queued":
      return { ...state, queued: true };
    case "checkout-read":
      return { ...state, checkout: event.report };
    case "checkout-failed":
      return { ...state, checkout: { failed: event.message } };
    case "recovery-reading":
      return { ...state, recovery: null };
    case "recovery-read":
      return { ...state, recovery: event.report };
    case "recovery-failed":
      return { ...state, recovery: { failed: event.message } };
    case "dismiss":
      return { ...state, last: null };
    case "reissue": {
      const next = reissueOf(state.last);
      const cleared = { ...state, last: null };
      // A re-armed Stop keeps the scope already chosen, as the button did.
      if (next?.kind === "arm-stop") return controlsReducer(cleared, { type: "arm-stop", scope: state.scope });
      if (next?.kind === "arm-claim") return controlsReducer(cleared, { type: "arm-claim", claim: next.claim });
      // A plain command is sent by the renderer, which read `reissueOf` first.
      return cleared;
    }
  }
}
