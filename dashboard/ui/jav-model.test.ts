import { describe, expect, it } from "vitest";

import type { JavConfigView } from "../contracts";
import {
  addLabel,
  idleLoops,
  labelHint,
  needsTriager,
  removeLabel,
  sameConfig,
  setEnabled,
  strandedLabels,
  SUGGESTED_LABELS,
  toggleRoute,
} from "./jav-model";

const off: JavConfigView = { enabled: false, labels: [], routes: {} };
const routed: JavConfigView = {
  enabled: true,
  labels: ["difficulty:easy", "difficulty:hard"],
  routes: { ralph: ["difficulty:hard"], remo: ["difficulty:easy"] },
};

describe("jav edits", () => {
  it("offers the usual pair on a first switch-on, and keeps labels on switch-off", () => {
    expect(setEnabled(off, true).labels).toEqual(SUGGESTED_LABELS);
    expect(setEnabled(routed, false)).toEqual({ ...routed, enabled: false });
  });

  it("adds a trimmed label once", () => {
    expect(addLabel(routed, "  difficulty:medium ").labels).toEqual([...routed.labels, "difficulty:medium"]);
    expect(addLabel(routed, "difficulty:easy")).toBe(routed);
    expect(addLabel(routed, "   ")).toBe(routed);
  });

  it("removes a label from every route along with the list", () => {
    const next = removeLabel({ ...routed, routes: { ralph: routed.labels } }, "difficulty:easy");
    expect(next.labels).toEqual(["difficulty:hard"]);
    expect(next.routes).toEqual({ ralph: ["difficulty:hard"] });
  });

  it("toggles a route, keeping label order and dropping an emptied loop", () => {
    const both = toggleRoute(routed, "ralph", "difficulty:easy");
    expect(both.routes.ralph).toEqual(["difficulty:easy", "difficulty:hard"]);
    const none = toggleRoute(routed, "remo", "difficulty:easy");
    expect(none.routes).toEqual({ ralph: ["difficulty:hard"] });
  });

  it("names stranded labels and idle loops", () => {
    const partial = { ...routed, routes: { ralph: ["difficulty:hard"] } };
    expect(strandedLabels(partial, ["ralph", "rafa"])).toEqual(["difficulty:easy"]);
    expect(idleLoops(partial, ["ralph", "rafa"])).toEqual(["rafa"]);
    // A `default` route covers every loop without one of its own.
    expect(idleLoops({ ...partial, routes: { ...partial.routes, default: ["difficulty:easy"] } }, ["ralph", "rafa"])).toEqual([]);
    expect(strandedLabels({ ...partial, routes: { ...partial.routes, default: ["difficulty:easy"] } }, ["ralph", "rafa"])).toEqual([]);
  });

  it("hints at reserved and duplicate labels", () => {
    expect(labelHint(routed, ["ready-for-agent"], "ready-for-agent")).toMatch(/already uses/);
    expect(labelHint(routed, [], "difficulty:hard")).toMatch(/already listed/);
    expect(labelHint(routed, [], "difficulty:medium")).toBeNull();
  });

  it("compares configs by value", () => {
    expect(sameConfig(routed, JSON.parse(JSON.stringify(routed)) as JavConfigView)).toBe(true);
    expect(sameConfig(routed, off)).toBe(false);
  });
});

/**
 * Routing on with nobody to label the backlog (#147). The queue Jav creates
 * drains through the triager, so routing without one is a queue with no drain
 * — and this page is the only place that is visible.
 */
describe("warning that routing has no triager", () => {
  const intake = (untriaged: number | null, triagers: string[] = []) => ({ untriaged, triagers });

  it("warns when routing is on, tickets are unlabelled, and no triager is staffed", () => {
    expect(needsTriager(routed, intake(3))).toBe(true);
  });

  it("stays quiet while routing is off", () => {
    // Without routing every coder takes an unlabelled ticket, so there is no
    // queue and nothing for a triager to drain.
    expect(needsTriager({ ...routed, enabled: false }, intake(3))).toBe(false);
  });

  it("stays quiet once a triager is on the roster", () => {
    expect(needsTriager(routed, intake(3, ["tria"]))).toBe(false);
  });

  it("stays quiet with nothing unlabelled", () => {
    expect(needsTriager(routed, intake(0))).toBe(false);
  });

  it("stays quiet when the backlog could not be read", () => {
    // Unknown is not evidence: warning on a failed frontier read would cry
    // wolf every time the tracker was slow.
    expect(needsTriager(routed, intake(null))).toBe(false);
  });
});
