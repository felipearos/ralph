// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { GateRunView } from "../contracts";
import { formatGateDuration, gateRunAvailability, gateRunResult, gateRunStatus, keepPolling } from "./gate-run-model";

function run(overrides: Partial<GateRunView> = {}): GateRunView {
  return {
    gate: "test",
    command: "bun run test",
    state: "passed",
    startedAt: "2026-11-04T15:00:00.000Z",
    durationMs: 12_345,
    exitCode: 0,
    output: "ok\n",
    truncated: false,
    limitMs: 600_000,
    error: null,
    ...overrides,
  };
}

const IDLE = { disabled: false, why: null, pending: false };

describe("gateRunStatus", () => {
  it("words and colours a timeout as its own outcome, not as a failure", () => {
    expect(gateRunStatus("timeout")).toEqual({ label: "Timed out", tone: "warn" });
    expect(gateRunStatus("failed")).toEqual({ label: "Failed", tone: "bad" });
    expect(gateRunStatus("passed")).toEqual({ label: "Passed", tone: "good" });
    expect(gateRunStatus("running")).toEqual({ label: "Running", tone: "info" });
  });
});

describe("formatGateDuration", () => {
  it("is precise for a quick gate and coarse for a slow one", () => {
    expect(formatGateDuration(850)).toBe("850 ms");
    expect(formatGateDuration(12_345)).toBe("12.3 s");
    expect(formatGateDuration(59_999)).toBe("59.9 s");
    expect(formatGateDuration(125_000)).toBe("2 min 5 s");
    expect(formatGateDuration(120_000)).toBe("2 min");
    expect(formatGateDuration(3_780_000)).toBe("1 h 3 min");
    expect(formatGateDuration(-1)).toBe("unknown");
  });
});

describe("gateRunResult", () => {
  it("shows a finished run on its own gate only", () => {
    expect(gateRunResult(run(), "lint")).toBeNull();
    expect(gateRunResult(null, "test")).toBeNull();
    // 15:00 UTC is 12:00 in Santiago (UTC-3 in November).
    expect(gateRunResult(run(), "test")).toEqual({
      label: "Passed",
      tone: "good",
      exit: "exit 0",
      duration: "12.3 s",
      started: "04-11-2026 12:00",
      error: null,
      output: "ok\n",
      truncated: false,
    });
  });

  it("has no exit code or duration while running", () => {
    const result = gateRunResult(run({ state: "running", durationMs: null, exitCode: null }), "test");
    expect(result).toMatchObject({ label: "Running", exit: null, duration: null });
  });

  it("says a timed-out run was stopped at its limit", () => {
    const result = gateRunResult(run({ state: "timeout", exitCode: null, durationMs: 600_010 }), "test");
    expect(result).toMatchObject({ label: "Timed out", tone: "warn", exit: "stopped after 10 min" });
  });

  it("carries a spawn error and a failed run's missing exit code", () => {
    const result = gateRunResult(run({ state: "failed", exitCode: null, error: "spawn ENOENT" }), "test");
    expect(result).toMatchObject({ label: "Failed", exit: "no exit code", error: "spawn ENOENT" });
  });
});

describe("gateRunAvailability", () => {
  it("is offered when nothing runs", () => {
    expect(gateRunAvailability(null, IDLE)).toEqual({ disabled: false, why: null });
    expect(gateRunAvailability(run(), IDLE)).toEqual({ disabled: false, why: null });
  });

  it("says the remote page's reason first", () => {
    const remote = { disabled: true, why: "Local dashboard only", pending: false };
    expect(gateRunAvailability(run({ state: "running" }), remote)).toEqual({ disabled: true, why: "Local dashboard only" });
  });

  it("is refused for every gate while one runs, naming it", () => {
    expect(gateRunAvailability(run({ state: "running" }), IDLE)).toEqual({ disabled: true, why: "gate 'test' is running" });
  });

  it("is held while a press is being sent", () => {
    expect(gateRunAvailability(null, { ...IDLE, pending: true })).toEqual({ disabled: true, why: "starting a run" });
  });
});

describe("keepPolling", () => {
  it("polls only while a run is in flight", () => {
    expect(keepPolling(null)).toBe(false);
    expect(keepPolling(run({ state: "running" }))).toBe(true);
    for (const state of ["passed", "failed", "timeout"] as const) expect(keepPolling(run({ state }))).toBe(false);
  });
});
