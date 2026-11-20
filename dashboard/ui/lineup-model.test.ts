import { describe, expect, it } from "vitest";

import { changedCount, changedFields, effortName, harnessVersion, stageGroups, type StageValues } from "./lineup-model";

const stage = (over: Partial<StageValues> = {}): StageValues => ({
  runner: "codex",
  model: "gpt-6-luna",
  effort: "high",
  fallback: [],
  fallbackEfforts: {},
  ...over,
});

describe("lineup table words", () => {
  it("groups stages by their dotted prefix in schema order", () => {
    expect(stageGroups(["orchestrator", "executor", "review.spec", "review.correctness", "audit.deep"])).toEqual([
      { label: "Iteration", stages: ["orchestrator", "executor"] },
      { label: "Pre-PR review", stages: ["review.spec", "review.correctness"] },
      { label: "audit", stages: ["audit.deep"] },
    ]);
  });

  it("names efforts in words and keeps a level it does not know", () => {
    expect(effortName("xhigh")).toBe("Extra high");
    expect(effortName("")).toBe("Default");
    expect(effortName("turbo")).toBe("turbo");
  });

  it("reads a harness's version out of what its CLI prints", () => {
    expect(harnessVersion("2.1.318 (Claude Code)")).toBe("2.1.318");
    expect(harnessVersion("codex-cli 0.165.0")).toBe("0.165.0");
    expect(harnessVersion(null)).toBeNull();
  });
});

describe("which cells an edit changed", () => {
  const shown = { effort: true, fallback: true };

  it("marks each differing cell once, fallbacks as one cell", () => {
    const changed = changedFields(stage({ model: "gpt-6-sol", fallback: ["a", "b"] }), stage({ fallback: ["b", "a"] }), shown);
    expect(changed).toEqual({ runner: false, model: true, effort: false, fallback: true });
    expect(changedCount(changed)).toBe(2);
  });

  it("does not count a field the row does not show, so the count equals the blue cells", () => {
    // Codex → Claude Code drops the effort and the chain; only the harness and model cells show it.
    const now = stage({ runner: "claude", model: "claude-opus-5-5", effort: "", fallback: [] });
    const was = stage({ fallback: ["gpt-6-sol"] });
    const changed = changedFields(now, was, { effort: false, fallback: false });
    expect(changed).toEqual({ runner: true, model: true, effort: false, fallback: false });
    expect(changedCount(changed)).toBe(2);
  });

  it("counts nothing when the stage matches the file", () => {
    expect(changedCount(changedFields(stage(), stage(), shown))).toBe(0);
  });
});
