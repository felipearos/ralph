import { describe, expect, it } from "vitest";

import type { DoctorPluginView, DoctorView } from "../contracts";
import { historyRows, mergeDoctorView } from "./doctor-model";

const plugin = (name: string, status: "pass" | "fail"): DoctorPluginView => ({
  plugin: name,
  title: name,
  checks: [{ id: "reach", label: "Reachable", status, detail: "", repairs: [] }],
  problem: null,
});

const view = (plugins: DoctorPluginView[], over: Partial<DoctorView> = {}): DoctorView => ({
  loop: "ralph",
  plugins,
  steps: [],
  stopped: null,
  history: [],
  problem: null,
  ...over,
});

describe("folding an answer into the panel", () => {
  it("replaces everything on a diagnosis", () => {
    const next = view([plugin("a", "pass")]);
    expect(mergeDoctorView(view([plugin("a", "fail"), plugin("b", "fail")]), next, null)).toBe(next);
  });

  it("replaces only the repaired plugin's checks on a repair", () => {
    const merged = mergeDoctorView(
      view([plugin("a", "fail"), plugin("b", "fail")]),
      view([plugin("b", "pass")], { steps: [{ check: "reach", action: "fix", result: "repaired", why: "" }] }),
      "b",
    );
    expect(merged.plugins.map((row) => [row.plugin, row.checks[0]?.status])).toEqual([
      ["a", "fail"],
      ["b", "pass"],
    ]);
    expect(merged.steps).toHaveLength(1);
  });
});

describe("the repair history", () => {
  it("lists one plugin's entries newest first, saying what was done", () => {
    const rows = historyRows(
      [
        { at: "1", plugin: "a", run: "r", kind: "diagnosis", via: "operator", check: null, action: null, result: "failing", why: "x" },
        { at: "2", plugin: "b", run: "r", kind: "diagnosis", via: "operator", check: null, action: null, result: "healthy", why: "" },
        { at: "3", plugin: "a", run: "r", kind: "repair", via: "fix-all", check: "consumer", action: "rebind", result: "repaired", why: "ok" },
        { at: "4", plugin: "a", run: "r", kind: "fix-all", via: "operator", check: null, action: null, result: "stopped", why: "cli" },
      ],
      "a",
    );
    expect(rows.map((row) => [row.at, row.what, row.result, row.tone])).toEqual([
      ["4", "fix all", "stopped", "warn"],
      ["3", "fix all · consumer → rebind", "repaired", "good"],
      ["1", "diagnosis", "failing", "warn"],
    ]);
  });
});
