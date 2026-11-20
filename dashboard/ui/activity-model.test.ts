// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ActivityView } from "../contracts";
import { applyFilter, durationOf, filterCounts, groupActivity, parseLabel, segments, shortenPath } from "./activity-model";

const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 15, 12, 0, seconds)).toISOString();
const row = (seconds: number, stage: string, label: string): ActivityView => ({
  stage,
  label,
  at: at(seconds),
  iteration: 4,
  run: "run-1",
});

describe("parseLabel", () => {
  it("reads every shape timeline.ts writes", () => {
    expect(parseLabel("stage started · claude")).toEqual({ kind: "stage", state: "started", runner: "claude" });
    expect(parseLabel("tool Bash — bun test")).toEqual({ kind: "tool", name: "Bash", detail: "bun test", error: false });
    expect(parseLabel("tool ExitPlanMode")).toEqual({ kind: "tool", name: "ExitPlanMode", detail: "", error: false });
    expect(parseLabel("tool bash error — pnpm: command not found")).toEqual({
      kind: "tool",
      name: "bash",
      detail: "pnpm: command not found",
      error: true,
    });
    expect(parseLabel("tool result ok — 118 pass")).toEqual({ kind: "result", ok: true, detail: "118 pass" });
    expect(parseLabel("tool result error — Exit code 1")).toEqual({ kind: "result", ok: false, detail: "Exit code 1" });
    expect(parseLabel("text — PR is green")).toEqual({ kind: "text", detail: "PR is green" });
    expect(parseLabel("thinking — map first")).toEqual({ kind: "thinking", detail: "map first" });
    expect(parseLabel("rate limit allowed_warning")).toEqual({ kind: "rate", status: "allowed_warning" });
    expect(parseLabel("system — compact_boundary")).toEqual({ kind: "system", detail: "compact_boundary" });
    expect(parseLabel("system — ")).toEqual({ kind: "system", detail: "" });
    expect(parseLabel("invalid event")).toEqual({ kind: "invalid" });
    expect(parseLabel("something new")).toEqual({ kind: "other", detail: "something new" });
  });

  it("does not read a tool called result as a tool result", () => {
    expect(parseLabel("tool result_writer — x").kind).toBe("tool");
  });
});

describe("groupActivity", () => {
  it("folds rows into stage groups with their lifecycle and collapses repeats", () => {
    const groups = groupActivity([
      row(0, "orchestrator", "system — init"),
      row(10, "mapper", "stage started · claude"),
      row(20, "mapper", "tool Read — a.ts"),
      row(30, "mapper", "tool Read — a.ts"),
      row(40, "mapper", "stage completed · claude"),
      row(50, "orchestrator", "text — done"),
    ]);
    expect(groups.map((group) => [group.stage, group.runner, group.state])).toEqual([
      ["orchestrator", null, null],
      ["mapper", "claude", "completed"],
      ["orchestrator", null, null],
    ]);
    expect(groups[1]!.steps).toHaveLength(1);
    expect(groups[1]!.steps[0]!).toMatchObject({ count: 2, firstAt: at(20), at: at(30) });
    expect(durationOf(groups[1]!.startedAt, groups[1]!.endedAt)).toBe("30s");
  });

  it("starts a new group when a finished stage starts again", () => {
    const groups = groupActivity([
      row(0, "executor", "stage started · codex"),
      row(10, "executor", "stage failed · codex"),
      row(20, "executor", "stage started · codex"),
      row(30, "executor", "stage completed · codex"),
    ]);
    expect(groups.map((group) => group.state)).toEqual(["failed", "completed"]);
  });

  it("remembers a degraded stage that completed anyway", () => {
    const [group] = groupActivity([
      row(0, "review.spec", "stage started · claude"),
      row(10, "review.spec", "stage degraded · claude"),
      row(20, "review.spec", "stage completed · claude"),
    ]);
    expect(group).toMatchObject({ state: "completed", degraded: true });
  });
});

describe("filters", () => {
  const groups = groupActivity([
    row(0, "executor", "stage started · opencode"),
    row(10, "executor", "tool bash — bun test"),
    row(20, "executor", "tool result error — 1 fail"),
    row(30, "executor", "text — fixing it"),
    row(40, "executor", "stage failed · opencode"),
    row(50, "review.spec", "stage started · claude"),
    row(60, "review.spec", "rate limit rejected"),
    row(70, "review.spec", "thinking — hmm"),
    row(80, "review.spec", "stage completed · claude"),
  ]);

  it("narrows each group to the matching steps and drops empty groups", () => {
    expect(applyFilter(groups, "tools").map((group) => group.steps.length)).toEqual([2]);
    expect(applyFilter(groups, "messages").map((group) => group.steps.length)).toEqual([1, 1]);
    expect(applyFilter(groups, "stages").map((group) => group.steps.length)).toEqual([0, 0]);
  });

  it("counts a failed stage as an error even without an error row", () => {
    const clean = groupActivity([row(0, "executor", "stage started · codex"), row(10, "executor", "stage failed · codex")]);
    expect(applyFilter(clean, "errors")).toHaveLength(1);
    expect(filterCounts(groups)).toEqual({ all: 5, stages: 2, tools: 2, messages: 2, errors: 3 });
  });
});

describe("segments", () => {
  it("splits URLs out of text", () => {
    expect(segments("see https://github.com/o/r/pull/26 now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://github.com/o/r/pull/26", href: "https://github.com/o/r/pull/26" },
      { kind: "text", text: " now" },
    ]);
  });

  it("pulls a file path out of a tool detail", () => {
    expect(segments("Edit — /home/faros/orca/mobile/app/profile/[username]/network.tsx")).toEqual([
      { kind: "text", text: "Edit — " },
      {
        kind: "path",
        path: {
          full: "/home/faros/orca/mobile/app/profile/[username]/network.tsx",
          dir: "…/profile/[username]/",
          name: "network.tsx",
        },
      },
    ]);
  });

  it("leaves words that only look like paths alone", () => {
    expect(segments("running 3/5 checks")).toEqual([{ kind: "text", text: "running 3/5 checks" }]);
    expect(segments("bun run test")).toEqual([{ kind: "text", text: "bun run test" }]);
  });

  it("keeps a short path whole", () => {
    expect(shortenPath("src/observe.ts")).toEqual({ full: "src/observe.ts", dir: "src/", name: "observe.ts" });
    expect(shortenPath("/etc/hosts")).toEqual({ full: "/etc/hosts", dir: "/etc/", name: "hosts" });
  });
});

describe("durationOf", () => {
  it("formats seconds, minutes and hours", () => {
    expect(durationOf(at(0), at(45))).toBe("45s");
    expect(durationOf(at(0), at(80))).toBe("1m 20s");
    expect(durationOf(at(0), new Date(Date.parse(at(0)) + 7380_000).toISOString())).toBe("2h 3m");
  });
});
