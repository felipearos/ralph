import { describe, expect, it } from "vitest";

import { fullestClaudeWindow, fullestWindow, guardWaitMs, GUARD_RECHECK_MS, usageRunners } from "./usage-guard";

const print = (claude: unknown) => JSON.stringify([
  { provider: "codex", usage: { primary: { usedPercent: 100, windowMinutes: 43200 } } },
  { provider: "claude", usage: claude },
]);

describe("fullestClaudeWindow", () => {
  it("reads Claude's fullest standard window, never Codex's or a model's own limit", () => {
    expect(fullestClaudeWindow(print({
      primary: { usedPercent: 40, resetsAt: "2026-11-12T22:00:00Z" },
      secondary: { usedPercent: 81, resetsAt: "2026-11-16T15:00:00Z" },
      extraRateWindows: [{ title: "Fable only", window: { usedPercent: 99 } }],
    }))).toEqual({ usedPercent: 81, window: "Weekly", resetsAt: "2026-11-16T15:00:00Z" });
  });

  it("is no reading on output it cannot read, or with no Claude windows", () => {
    expect(fullestClaudeWindow("codexbar: command failed")).toBeNull();
    expect(fullestClaudeWindow(print({ primary: { usedPercent: 50, isSyntheticPlaceholder: true } }))).toBeNull();
    expect(fullestClaudeWindow(JSON.stringify([{ provider: "codex", usage: {} }]))).toBeNull();
  });
});

describe("fullestWindow", () => {
  it("reads Codex's fullest standard window, never Claude's or Codex Spark's own limit (#822)", () => {
    const both = JSON.stringify([
      { provider: "claude", usage: { primary: { usedPercent: 99 } } },
      { provider: "codex", usage: {
        primary: { usedPercent: 30, resetsAt: "2026-11-18T15:00:00Z" },
        secondary: { usedPercent: 64, resetsAt: "2026-11-22T09:00:00Z" },
        extraRateWindows: [{ title: "Spark", window: { usedPercent: 100 } }],
      } },
    ]);
    expect(fullestWindow(both, "codex")).toEqual({ usedPercent: 64, window: "Weekly", resetsAt: "2026-11-22T09:00:00Z" });
    expect(fullestWindow(both, "claude")).toEqual({ usedPercent: 99, window: "Session", resetsAt: null });
    expect(fullestWindow(JSON.stringify([{ provider: "claude", usage: { primary: { usedPercent: 10 } } }]), "codex")).toBeNull();
  });
});

describe("usageRunners", () => {
  it("is Claude always, plus Codex only when something runs on it (#822)", () => {
    expect(usageRunners([])).toEqual(["claude"]);
    expect(usageRunners(["claude", "opencode", undefined])).toEqual(["claude"]);
    expect(usageRunners(["codex"])).toEqual(["claude", "codex"]);
  });
});

describe("guardWaitMs", () => {
  const now = Date.parse("2026-11-12T20:00:00Z");
  it("waits until just after the reset, at most a recheck and at least a minute", () => {
    expect(guardWaitMs({ usedPercent: 95, window: "Session", resetsAt: "2026-11-12T20:05:00Z" }, now)).toBe(6 * 60_000);
    expect(guardWaitMs({ usedPercent: 95, window: "Weekly", resetsAt: "2026-11-16T15:00:00Z" }, now)).toBe(GUARD_RECHECK_MS);
    expect(guardWaitMs({ usedPercent: 95, window: "Session", resetsAt: "2026-11-12T19:00:00Z" }, now)).toBe(60_000);
    expect(guardWaitMs({ usedPercent: 95, window: "Session", resetsAt: null }, now)).toBe(GUARD_RECHECK_MS);
  });
});
