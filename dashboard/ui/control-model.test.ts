// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CONTROL_COMMANDS,
  type CheckoutReport,
  type ClaimView,
  type ControlCommand,
  type ControlResult,
  type ControlView,
  type DashboardLoop,
} from "../contracts";
import {
  type Action,
  type ControlsEvent,
  type ControlsState,
  INITIAL_CONTROLS,
  controlsFor,
  controlsReducer,
  initialControls,
  reissueOf,
  requestFor,
  scoped,
} from "./control-model";

/** Only the fields the controls read; the rest of a loop does not reach them. */
const loop = (over: Partial<DashboardLoop> = {}) =>
  ({ loop: "ralph", role: "coder", present: true, supervisor: "alive", run: "run-1", stopReason: null, claims: [], ...over }) as DashboardLoop;

/** Only the fields the controls read off the control view. */
const view = (over: Partial<ControlView> = {}) => ({ hold: null, stop: null, ...over }) as ControlView;

const claim = (over: Partial<ClaimView> = {}): ClaimView => ({
  issue: 7,
  title: null,
  loop: "ralph",
  status: "active",
  claimedAt: null,
  expiresAt: null,
  run: "run-1",
  labeled: true,
  leased: true,
  ...over,
});

const hold = (over: Partial<NonNullable<ControlView["hold"]>> = {}): ControlView["hold"] => ({
  kind: "pause",
  why: "paused",
  since: "2026-11-03T00:00:00Z",
  gate: null,
  ...over,
});

const interruptedStop = (issue: number | null): ControlView["stop"] =>
  ({ kind: "interrupted", why: "stopped now", at: "2026-11-03T00:00:00Z", iteration: 3, issue }) as ControlView["stop"];

describe("controlsFor", () => {
  it("offers a live, unheld loop pause, stop and restart, and nothing else", () => {
    const c = controlsFor(loop(), view(), "iteration");
    expect(c).toMatchObject({
      live: true,
      gone: false,
      hold: null,
      stopped: null,
      phases: true,
      scope: "iteration",
      interrupted: false,
      ticket: null,
      canStart: false,
      canPause: true,
      canResume: false,
      canDecide: false,
      retryable: null,
      canStop: true,
      canRestart: true,
      canRetry: false,
      releasable: [],
      abandonable: [],
      recoverable: [],
      unavailable: false,
      nothingApplies: false,
    });
  });

  it("keeps the chosen scope for a role with phases", () => {
    expect(controlsFor(loop(), view(), "phase").scope).toBe("phase");
  });

  it("is unavailable, with no pause, while a live loop's control view is unread", () => {
    const c = controlsFor(loop(), null, "iteration");
    expect(c.unavailable).toBe(true);
    expect(c.canPause).toBe(false);
    expect(c.canStop).toBe(true);
    expect(controlsFor(loop({ supervisor: "dead" }), null, "iteration").unavailable).toBe(false);
  });

  it("offers resume on a pause hold and a decision on an approval hold", () => {
    const paused = controlsFor(loop(), view({ hold: hold() }), "iteration");
    expect([paused.canResume, paused.canDecide, paused.canPause]).toEqual([true, false, false]);
    const gated = controlsFor(loop(), view({ hold: hold({ kind: "approval", gate: "merge" }) }), "iteration");
    expect([gated.canResume, gated.canDecide, gated.canPause]).toEqual([false, true, false]);
  });

  it("retries the phase just finished when held at a phase boundary", () => {
    const held = view({ hold: hold({ phase: "review", after: "implement" }) });
    expect(controlsFor(loop(), held, "iteration").retryable).toBe("implement");
    // Not held at a phase boundary: nothing to retry.
    expect(controlsFor(loop(), view({ hold: hold() }), "iteration").retryable).toBeNull();
    expect(controlsFor(loop({ supervisor: "dead" }), held, "iteration").retryable).toBeNull();
  });

  it("forces the iteration scope and offers no phase retry for a phase-less role", () => {
    const held = view({ hold: hold({ phase: "review", after: "implement" }) });
    const c = controlsFor(loop({ role: "triager" }), held, "phase");
    expect(c.phases).toBe(false);
    expect(c.scope).toBe("iteration");
    expect(c.retryable).toBeNull();
  });

  it("starts a present loop with no live supervisor", () => {
    expect(controlsFor(loop({ supervisor: "dead" }), view(), "iteration").canStart).toBe(true);
    expect(controlsFor(loop({ supervisor: "unknown" }), null, "iteration").canStart).toBe(true);
  });

  it("retries only a failed stop of a gone supervisor", () => {
    const failed = { kind: "failed", why: "boom" } as DashboardLoop["stopReason"];
    expect(controlsFor(loop({ supervisor: "dead", stopReason: failed }), view(), "iteration").canRetry).toBe(true);
    expect(controlsFor(loop({ supervisor: "unknown", stopReason: failed }), view(), "iteration").canRetry).toBe(false);
    const completed = { kind: "completed", why: "done" } as DashboardLoop["stopReason"];
    expect(controlsFor(loop({ supervisor: "dead", stopReason: completed }), view(), "iteration").canRetry).toBe(false);
  });

  it("reads an interruption from the control view's stop, with its ticket", () => {
    const c = controlsFor(loop({ supervisor: "dead" }), view({ stop: interruptedStop(42) }), "iteration");
    expect(c.interrupted).toBe(true);
    expect(c.ticket).toBe(42);
    expect(c.stopped).toMatchObject({ kind: "interrupted", issue: 42 });
    // Resume work and Release replace a plain Start.
    expect(c.canStart).toBe(false);
    expect(c.nothingApplies).toBe(false);
  });

  it("reads an interruption from the loop's stop reason, with no ticket", () => {
    const stopReason = { kind: "interrupted", why: "stopped now" } as DashboardLoop["stopReason"];
    const c = controlsFor(loop({ supervisor: "dead", stopReason }), view(), "iteration");
    expect(c.interrupted).toBe(true);
    expect(c.ticket).toBeNull();
    expect(c.stopped).toBeNull();
  });

  it("is not interrupted while the supervisor is live", () => {
    expect(controlsFor(loop(), view({ stop: interruptedStop(42) }), "iteration").interrupted).toBe(false);
  });

  it("releases the run's own claims, live or lapsed, but not the interrupted ticket from recoverable", () => {
    const own = claim({ issue: 42, status: "active" });
    const lapsed = claim({ issue: 43, status: "expired" });
    const other = claim({ issue: 44, status: "active", run: "run-0" });
    const c = controlsFor(loop({ supervisor: "dead", claims: [own, lapsed, other] }), view({ stop: interruptedStop(42) }), "iteration");
    expect(c.releasable).toEqual([own, lapsed]);
    // The run's own expired claim is released, never abandoned.
    expect(c.abandonable).toEqual([]);
    // The interrupted ticket is offered beside Resume work instead.
    expect(c.recoverable).toEqual([{ claim: lapsed, action: "release" }]);
  });

  it("releases nothing while the supervisor is not known to be gone, or the run is unknown", () => {
    const claims = [claim()];
    expect(controlsFor(loop({ claims }), view(), "iteration").releasable).toEqual([]);
    expect(controlsFor(loop({ supervisor: "dead", run: null, claims }), view(), "iteration").releasable).toEqual([]);
  });

  it("abandons another run's expired claim, but not a live one", () => {
    const expired = claim({ issue: 50, status: "expired", run: "run-0" });
    const active = claim({ issue: 51, status: "active", run: "run-0" });
    const c = controlsFor(loop({ claims: [expired, active] }), view(), "iteration");
    expect(c.abandonable).toEqual([expired]);
    expect(c.recoverable).toEqual([{ claim: expired, action: "abandon" }]);
  });

  it("abandons nothing while the supervisor is unknown", () => {
    const expired = claim({ issue: 50, status: "expired", run: "run-0" });
    const c = controlsFor(loop({ supervisor: "unknown", claims: [expired] }), null, "iteration");
    expect(c.abandonable).toEqual([]);
    expect(c.recoverable).toEqual([]);
  });

  it("offers a loop with no checkout no start and nothing to release or abandon", () => {
    const claims = [claim({ status: "expired" }), claim({ issue: 8, status: "expired", run: "run-0" })];
    const c = controlsFor(loop({ present: false, supervisor: "dead", claims }), null, "iteration");
    expect(c.canStart).toBe(false);
    expect(c.releasable).toEqual([]);
    expect(c.abandonable).toEqual([]);
    expect(c.interrupted).toBe(false);
    expect(c.nothingApplies).toBe(true);
  });

  it("says nothing applies only when no control and no recovery is offered", () => {
    // An unknown supervisor with no checkout: no start, no recovery, no live control.
    expect(controlsFor(loop({ present: false, supervisor: "unknown" }), null, "iteration").nothingApplies).toBe(true);
    // A live loop can always be stopped.
    expect(controlsFor(loop(), null, "iteration").nothingApplies).toBe(false);
    // A present loop with no supervisor can be started.
    expect(controlsFor(loop({ supervisor: "dead" }), view(), "iteration").nothingApplies).toBe(false);
  });

  it("offers stop and restart together, and only on a live loop", () => {
    for (const supervisor of ["alive", "dead", "unknown"] as const) {
      const c = controlsFor(loop({ supervisor }), view(), "iteration");
      expect(c.canStop).toBe(supervisor === "alive");
      expect(c.canRestart).toBe(c.canStop);
    }
  });

  it("offers the gates only with the view read, a checkout and phases", () => {
    expect(controlsFor(loop(), view(), "iteration").canGate).toBe(true);
    expect(controlsFor(loop({ supervisor: "dead" }), view(), "iteration").canGate).toBe(true);
    expect(controlsFor(loop(), null, "iteration").canGate).toBe(false);
    expect(controlsFor(loop({ present: false }), view(), "iteration").canGate).toBe(false);
    expect(controlsFor(loop({ role: "triager" }), view(), "iteration").canGate).toBe(false);
  });

  it("sends a loop with no checkout to create one, and re-issues only with a checkout", () => {
    const missing = controlsFor(loop({ present: false }), view(), "iteration");
    expect(missing.canCreateCheckout).toBe(true);
    expect(missing.canReissue).toBe(false);
    const present = controlsFor(loop(), view(), "iteration");
    expect(present.canCreateCheckout).toBe(false);
    expect(present.canReissue).toBe(true);
  });
});

describe("scoped", () => {
  it("sends nothing for the iteration and the phase scope for a phase", () => {
    expect(scoped("iteration")).toEqual({});
    expect(scoped("phase")).toEqual({ scope: "phase" });
  });
});

describe("requestFor", () => {
  const withRun = loop({ run: "run-9" });
  const noRun = loop({ run: null });
  const body = { confirm: true };

  it("posts start with the loop alone", () => {
    expect(requestFor(withRun, "start", body)).toEqual(["/api/start", { loop: "ralph" }]);
    expect(requestFor(noRun, "start", body)).toEqual(["/api/start", { loop: "ralph" }]);
  });

  it("posts resume work with the loop alone", () => {
    expect(requestFor(withRun, "resume-work", body)).toEqual(["/api/resume-work", { loop: "ralph" }]);
    expect(requestFor(noRun, "resume-work", body)).toEqual(["/api/resume-work", { loop: "ralph" }]);
  });

  it("posts restart and stop now with the run, when known, and the body", () => {
    expect(requestFor(withRun, "restart", body)).toEqual(["/api/restart", { loop: "ralph", run: "run-9", confirm: true }]);
    expect(requestFor(noRun, "restart", body)).toEqual(["/api/restart", { loop: "ralph", confirm: true }]);
    expect(requestFor(withRun, "stop-now", body)).toEqual(["/api/stop-now", { loop: "ralph", run: "run-9", confirm: true }]);
    expect(requestFor(noRun, "stop-now", body)).toEqual(["/api/stop-now", { loop: "ralph", confirm: true }]);
  });

  it.each(CONTROL_COMMANDS.map((command) => [command]))("posts %s to the control channel, naming the run when known", (command) => {
    const action: Action = command;
    expect(requestFor(withRun, action, body)).toEqual(["/api/control", { loop: "ralph", action: command, run: "run-9", confirm: true }]);
    expect(requestFor(noRun, action, body)).toEqual(["/api/control", { loop: "ralph", action: command, confirm: true }]);
  });
});

/** A command's recorded answer; only the fields the reducer reads matter. */
const result = (action: ControlCommand, issue: number | null = null): ControlResult => ({
  loop: "ralph",
  action,
  key: "key-1",
  run: "run-1",
  issue,
  outcome: "applied",
  recorded: true,
  why: "done",
  at: "2026-11-03T00:00:00Z",
  stop: null,
}) as ControlResult;

/** Only the shape matters to the reducer: it stores the report as read. */
const report = { dirty: false } as unknown as CheckoutReport;

const run = (state: ControlsState, ...events: ControlsEvent[]) => events.reduce(controlsReducer, state);

describe("controlsReducer", () => {
  const arms: [string, ControlsEvent, Partial<ControlsState>][] = [
    ["stop", { type: "arm-stop", scope: "phase" }, { armed: true }],
    ["restart", { type: "arm-restart" }, { restartArmed: true }],
    ["stop now", { type: "arm-now" }, { nowArmed: true }],
    ["a claim", { type: "arm-claim", claim: { action: "release", issue: 7 } }, { claimArmed: { action: "release", issue: 7 } }],
  ];
  const everythingArmed = initialControls({ armed: true, restartArmed: true, nowArmed: true, claimArmed: { action: "abandon", issue: 3 } });

  it.each(arms)("arming %s disarms every other confirmation", (_name, event, expected) => {
    const next = controlsReducer(everythingArmed, event);
    expect({ armed: next.armed, restartArmed: next.restartArmed, nowArmed: next.nowArmed, claimArmed: next.claimArmed }).toEqual({
      armed: false,
      restartArmed: false,
      nowArmed: false,
      claimArmed: null,
      ...expected,
    });
  });

  it("arms stop at the scope it was armed at", () => {
    expect(run(INITIAL_CONTROLS, { type: "arm-stop", scope: "phase" }).scope).toBe("phase");
    expect(run(initialControls({ scope: "phase" }), { type: "arm-stop", scope: "iteration" }).scope).toBe("iteration");
  });

  it("starts the worktree read over when restart is armed", () => {
    expect(run(initialControls({ checkout: report }), { type: "arm-restart" }).checkout).toBeNull();
  });

  it("cancels each confirmation alone", () => {
    expect(run(everythingArmed, { type: "cancel-stop" })).toMatchObject({ armed: false, restartArmed: true, nowArmed: true });
    expect(run(everythingArmed, { type: "cancel-restart" })).toMatchObject({ armed: true, restartArmed: false, nowArmed: true });
    expect(run(everythingArmed, { type: "cancel-now" })).toMatchObject({ armed: true, restartArmed: true, nowArmed: false });
    expect(run(everythingArmed, { type: "cancel-claim" })).toMatchObject({ armed: true, claimArmed: null });
  });

  it("keeps the Stop now reason as typed", () => {
    expect(run(INITIAL_CONTROLS, { type: "edit-why", text: "runaway" }).nowWhy).toBe("runaway");
  });

  it("sets the scope chosen", () => {
    expect(run(INITIAL_CONTROLS, { type: "choose-scope", scope: "phase" }).scope).toBe("phase");
  });

  it("clears every armed confirmation when a command is sent", () => {
    const next = run(everythingArmed, { type: "send", action: "stop", body: { scope: "phase" } });
    expect(next).toMatchObject({ pending: { action: "stop", body: { scope: "phase" } }, armed: false, restartArmed: false, nowArmed: false, claimArmed: null });
  });

  it("ends a send on its answer, a failure, and marks it queued in between", () => {
    const sending = run(INITIAL_CONTROLS, { type: "send", action: "pause", body: {} }, { type: "queued" });
    expect(sending).toMatchObject({ pending: { action: "pause" }, queued: true });
    const answer = result("pause");
    expect(run(sending, { type: "answer", answer })).toMatchObject({ last: answer, pending: null, queued: false });
    const error = { kind: "Failed", message: "HTTP 500", status: 500 } as const;
    expect(run(sending, { type: "failed", error })).toMatchObject({ last: { failed: error }, pending: null, queued: false });
  });

  it("dismisses the last answer", () => {
    expect(run(initialControls({ last: result("pause") }), { type: "dismiss" }).last).toBeNull();
  });

  it("reads the restart checkout and the recovery report", () => {
    expect(run(INITIAL_CONTROLS, { type: "checkout-read", report }).checkout).toBe(report);
    expect(run(INITIAL_CONTROLS, { type: "checkout-failed", message: "gone" }).checkout).toEqual({ failed: "gone" });
    expect(run(INITIAL_CONTROLS, { type: "recovery-read", report }).recovery).toBe(report);
    expect(run(INITIAL_CONTROLS, { type: "recovery-failed", message: "gone" }).recovery).toEqual({ failed: "gone" });
    expect(run(initialControls({ recovery: report }), { type: "recovery-reading" }).recovery).toBeNull();
  });

  it("re-arms a re-issued stop at the scope already chosen, without sending", () => {
    const next = run(initialControls({ last: result("stop"), scope: "phase" }), { type: "reissue" });
    expect(next).toMatchObject({ last: null, armed: true, scope: "phase", pending: null });
    expect(reissueOf(result("stop"))).toEqual({ kind: "arm-stop" });
  });

  it("arms a re-issued abandon or release for its ticket", () => {
    for (const action of ["abandon", "release"] as const) {
      const next = run(initialControls({ last: result(action, 9) }), { type: "reissue" });
      expect(next).toMatchObject({ last: null, claimArmed: { action, issue: 9 }, pending: null });
    }
  });

  it("leaves a plain command, or a claim with no ticket, for the renderer to send", () => {
    expect(reissueOf(result("pause"))).toEqual({ kind: "send", action: "pause" });
    expect(reissueOf(result("release", null))).toEqual({ kind: "send", action: "release" });
    const next = run(initialControls({ last: result("pause") }), { type: "reissue" });
    expect(next).toEqual(INITIAL_CONTROLS);
  });

  it("has nothing to re-issue for a failure or an answer that shows no re-issue", () => {
    expect(reissueOf(null)).toBeNull();
    expect(reissueOf({ failed: { kind: "Failed", message: "HTTP 500", status: 500 } })).toBeNull();
    expect(reissueOf({ action: "start" } as never)).toBeNull();
    expect(reissueOf({ action: "stop-now" } as never)).toBeNull();
  });

  it("seeds over the defaults", () => {
    expect(initialControls()).toEqual(INITIAL_CONTROLS);
    expect(INITIAL_CONTROLS).toMatchObject({ scope: "iteration", nowWhy: "", pending: null, last: null, queued: false });
    expect(initialControls({ nowArmed: true, scope: "phase" })).toEqual({ ...INITIAL_CONTROLS, nowArmed: true, scope: "phase" });
  });
});
