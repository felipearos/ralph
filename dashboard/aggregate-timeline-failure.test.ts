// @vitest-environment node
/**
 * Timeline activity and the runner-failure reason in the pure projection.
 *
 * Timeline: a panel shows only its own run's activity, newest first and
 * capped; an absent or unreadable timeline is `null` (unknown), and a timeline
 * with nothing in it is `[]`. Failure: the reason is the newest runner failure
 * recorded for the panel's own run and loop; a run with no recorded failure
 * reads `none`, but only when the record could be read and the run did not
 * fail — a failed run with no record, or no readable record, is `unknown`.
 */
import { describe, expect, it } from "vitest";

import { TIMELINE_LIMIT, aggregateDashboard } from "./aggregate";
import type {
  Clock,
  LoopStateView,
  RunnerFailureView,
  RuntimeLoop,
  RuntimeSnapshot,
  TimelineActivityView,
} from "./contracts";
import { coderRoster } from "./contracts";

const clock: Clock = { nowMs: Date.parse("2026-09-13T12:00:00.000Z") };

const state = (over: Partial<LoopStateView> = {}): LoopStateView => ({
  version: 1,
  run: "ralph-run-1",
  owner: { loop: "ralph", pid: 4242, host: "desktop" },
  worktree: "/checkout/ralph",
  branch: "ralph/919-scaffold",
  stage: "iteration",
  iteration: { index: 2, max: 50 },
  heartbeat: "2026-09-13T11:59:00.000Z",
  lastEvent: null,
  stopReason: null,
  ...over,
});

const activity = (minute: number, over: Partial<TimelineActivityView> = {}): TimelineActivityView => ({
  stage: "executor",
  label: `step ${minute}`,
  at: `2026-09-13T11:${String(minute).padStart(2, "0")}:00.000Z`,
  iteration: 2,
  run: "ralph-run-1",
  ...over,
});

const failure = (over: Partial<RunnerFailureView> = {}): RunnerFailureView => ({
  at: "2026-09-13T11:30:00.000Z",
  loop: "ralph",
  run: "ralph-run-1",
  iteration: 2,
  stage: "executor",
  runner: "claude",
  model: "opus",
  issue: 919,
  exitCode: 1,
  kind: "api-error",
  summary: "the provider answered with an error",
  visibility: "post-hoc",
  evidence: ["overloaded_error"],
  note: null,
  ...over,
});

const loop = (over: Partial<RuntimeLoop> = {}): RuntimeLoop => ({
  worktree: "/checkout/ralph",
  identity: "ralph",
  loopStatus: "running",
  worktreeStatus: "live",
  branch: "ralph/919-scaffold",
  state: state(),
  stateProblem: null,
  supervisor: "alive",
  presence: null,
  ...over,
});

const runtime = (loops: RuntimeLoop[]): RuntimeSnapshot => ({
  roster: coderRoster("ralph", "rafa", "remo", "rulo"),
  loops,
  reconciliation: { orphaned: [], prunable: [] },
});

const panel = (snapshot: RuntimeSnapshot, name = "ralph") =>
  aggregateDashboard(snapshot, clock).loops.find((item) => item.loop === name)!;

const timeline = (activities: TimelineActivityView[], exists = true) => ({
  exists,
  path: exists ? "/checkout/ralph/.ralph/logs/iter-ralph-run-1-2.events.jsonl" : null,
  activities,
});

describe("recent timeline activity", () => {
  it("shows the newest activity first, capped", () => {
    const activities = Array.from({ length: 14 }, (_, index) => activity(index));
    const shown = panel(runtime([loop({ timeline: timeline(activities) })])).timeline;
    expect(TIMELINE_LIMIT).toBe(10);
    expect(shown?.map((item) => item.label)).toEqual([
      "step 13",
      "step 12",
      "step 11",
      "step 10",
      "step 9",
      "step 8",
      "step 7",
      "step 6",
      "step 5",
      "step 4",
    ]);
  });

  it("orders by time rather than by receipt, and keeps the later receipt first on a tie", () => {
    const activities = [
      activity(5, { label: "late" }),
      activity(1, { label: "early" }),
      activity(3, { label: "tie, received first" }),
      activity(3, { label: "tie, received second" }),
    ];
    expect(panel(runtime([loop({ timeline: timeline(activities) })])).timeline?.map((item) => item.label)).toEqual([
      "late",
      "tie, received second",
      "tie, received first",
      "early",
    ]);
  });

  it("carries stage, label and time for each entry", () => {
    expect(panel(runtime([loop({ timeline: timeline([activity(7)]) })])).timeline).toEqual([
      { stage: "executor", label: "step 7", at: "2026-09-13T11:07:00.000Z", iteration: 2, run: "ralph-run-1" },
    ]);
  });

  it("drops activity from any run but the panel's own", () => {
    const activities = [activity(1), activity(2, { run: "ralph-run-0" }), activity(3, { run: null })];
    expect(panel(runtime([loop({ timeline: timeline(activities) })])).timeline?.map((item) => item.label)).toEqual([
      "step 1",
    ]);
  });

  it("renders an absent or unreadable timeline as unknown, and an empty one as empty", () => {
    expect(panel(runtime([loop({ timeline: timeline([], false) })])).timeline).toBeNull();
    expect(panel(runtime([loop({ timeline: null })])).timeline).toBeNull();
    expect(panel(runtime([loop()])).timeline).toBeNull();
    expect(panel(runtime([loop({ timeline: timeline([]) })])).timeline).toEqual([]);
  });

  it("keeps the timeline unknown when the panel's run is unknown", () => {
    expect(panel(runtime([loop({ state: null, timeline: timeline([activity(1)]) })])).timeline).toBeNull();
  });

  it("keeps a roster loop with no worktree unknown", () => {
    expect(panel(runtime([loop()]), "rafa")).toMatchObject({
      present: false,
      timeline: null,
      runnerFailure: { state: "unknown", reason: null, current: false },
    });
  });

  it("does not reorder the runtime's activities in place", () => {
    const activities = [activity(2), activity(1)];
    const copy = [...activities];
    aggregateDashboard(runtime([loop({ timeline: timeline(activities) })]), clock);
    expect(activities).toEqual(copy);
  });
});

describe("selecting the runner-failure reason", () => {
  it("shows the newest failure recorded for the panel's run", () => {
    const settled = [
      failure({ at: "2026-09-13T11:10:00.000Z", kind: "timeout" }),
      failure({ at: "2026-09-13T11:40:00.000Z", kind: "rate-limit" }),
      failure({ at: "2026-09-13T11:20:00.000Z", kind: "permission-denied" }),
    ];
    expect(panel(runtime([loop({ runnerFailures: { settled } })])).runnerFailure).toEqual({
      state: "failed",
      reason: settled[1],
      current: true,
    });
  });

  it("prefers the later record when two share a time", () => {
    const settled = [failure({ kind: "first" }), failure({ kind: "second" })];
    expect(panel(runtime([loop({ runnerFailures: { settled } })])).runnerFailure.reason?.kind).toBe("second");
  });

  it("ignores failures from another run or signed by another loop", () => {
    const settled = [
      failure({ run: "ralph-run-0", at: "2026-09-13T11:50:00.000Z" }),
      failure({ loop: "rafa", at: "2026-09-13T11:55:00.000Z" }),
    ];
    expect(panel(runtime([loop({ runnerFailures: { settled } })])).runnerFailure).toEqual({
      state: "none",
      reason: null,
      current: false,
    });
  });

  it("keeps a failure the runtime could not name a loop for, when it is the panel's run", () => {
    const unnamed = failure({ loop: "unknown" });
    expect(panel(runtime([loop({ runnerFailures: { settled: [unnamed] } })])).runnerFailure).toEqual({
      state: "failed",
      reason: unnamed,
      current: true,
    });
  });

  it("shows none for a run that did not fail", () => {
    expect(panel(runtime([loop({ runnerFailures: { settled: [] } })])).runnerFailure).toEqual({
      state: "none",
      reason: null,
      current: false,
    });
  });

  it("keeps a failed run with no failure record unknown, not none", () => {
    const failedStop = state({ stopReason: { kind: "failed", why: "executor gave up", at: "2026-09-13T11:58:00.000Z" } });
    expect(panel(runtime([loop({ state: failedStop, runnerFailures: { settled: [] } })])).runnerFailure).toEqual({
      state: "unknown",
      reason: null,
      current: false,
    });
    expect(
      panel(runtime([loop({ loopStatus: "failed", runnerFailures: { settled: [] } })])).runnerFailure.state,
    ).toBe("unknown");
  });

  it("marks a failure from an earlier iteration of a run that carried on as not current", () => {
    const earlier = failure({ iteration: 8 });
    const now = state({ iteration: { index: 17, max: 50 } });
    expect(panel(runtime([loop({ state: now, runnerFailures: { settled: [earlier] } })])).runnerFailure).toEqual({
      state: "failed",
      reason: earlier,
      current: false,
    });
  });

  it("keeps an earlier iteration's failure current once the run has failed", () => {
    const now = state({
      iteration: { index: 17, max: 50 },
      stopReason: { kind: "failed", why: "executor gave up", at: "2026-09-13T11:58:00.000Z" },
    });
    expect(
      panel(runtime([loop({ state: now, runnerFailures: { settled: [failure({ iteration: 8 })] } })])).runnerFailure.current,
    ).toBe(true);
    expect(
      panel(runtime([loop({ loopStatus: "failed", state: state({ iteration: { index: 17, max: 50 } }), runnerFailures: { settled: [failure({ iteration: 8 })] } })]))
        .runnerFailure.current,
    ).toBe(true);
  });

  it("keeps a failure current when either iteration is unknown", () => {
    const unnumbered = failure({ iteration: null });
    expect(panel(runtime([loop({ runnerFailures: { settled: [unnumbered] } })])).runnerFailure.current).toBe(true);
    const noIteration = state({ iteration: null });
    expect(panel(runtime([loop({ state: noIteration, runnerFailures: { settled: [failure()] } })])).runnerFailure.current).toBe(true);
  });

  it("keeps an unreadable record, or an unknown run, unknown", () => {
    expect(panel(runtime([loop({ runnerFailures: null })])).runnerFailure).toEqual({ state: "unknown", reason: null, current: false });
    expect(panel(runtime([loop()])).runnerFailure).toEqual({ state: "unknown", reason: null, current: false });
    expect(
      panel(runtime([loop({ state: null, runnerFailures: { settled: [failure()] } })])).runnerFailure,
    ).toEqual({ state: "unknown", reason: null, current: false });
  });
});
