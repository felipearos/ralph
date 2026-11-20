import { describe, expect, it } from "vitest";

import type { ModelUpdateAgentView, ModelUpdatesView } from "../../lineup/contracts";
import { answerBody, answerMessage, blockLabel, quietReason, updatePanel } from "./model-updates-model";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const opus = { stage: "orchestrator", model: "claude-opus-5", latest: "claude-opus-5-5" };

const agent = (over: Partial<ModelUpdateAgentView>): ModelUpdateAgentView => ({
  project: "loggd",
  block: "testo",
  policy: "ask",
  skip: [],
  snoozedUntil: null,
  malformed: false,
  outdated: [opus],
  ask: true,
  ...over,
});

const view = (agents: ModelUpdateAgentView[]): ModelUpdatesView => ({
  root: "/h/ralph",
  project: "loggd",
  latest: { opus: "claude-opus-5-5" },
  latestSource: "test",
  agents,
});

describe("the model-update panel", () => {
  it("asks about outdated blocks, lists the quiet ones with why, and leaves current ones out", () => {
    const panel = updatePanel(
      view([
        agent({}),
        agent({ block: "@triager", outdated: [opus, { ...opus, stage: "executor" }] }),
        agent({ block: "ralph", outdated: [], ask: false }),
        agent({ block: "medi", policy: "pinned", ask: false }),
      ]),
      NOW,
    );
    expect(panel.asking.map((card) => [card.name, card.kind, card.targets])).toEqual([
      ["testo", "agent", ["claude-opus-5-5"]],
      ["triager", "every triager loop without a block of its own", ["claude-opus-5-5"]],
    ]);
    expect(panel.quiet.map((card) => [card.name, card.quiet])).toEqual([["medi", "pinned: never asked"]]);
  });

  it("says why a block is quiet", () => {
    expect(quietReason(agent({ policy: "auto", ask: false }), NOW)).toBe("updates itself at its next start");
    expect(quietReason(agent({ snoozedUntil: "2026-11-25T12:00:00.000Z", ask: false }), NOW)).toBe("snoozed until 2026-11-25");
    expect(quietReason(agent({ skip: ["claude-opus-5-5"], ask: false }), NOW)).toBe("skipped claude-opus-5-5");
    expect(quietReason(agent({ policy: "pinned", malformed: true, ask: false }), NOW)).toMatch(/could not be read/);
  });

  it("names the file's default and a project default apart from a loop", () => {
    expect(blockLabel({ project: null, block: "default" })).toEqual({ name: "default", kind: "every project's fallback lineup" });
    expect(blockLabel({ project: "loggd", block: "default" })).toEqual({ name: "default", kind: "this project's fallback lineup" });
  });

  it("addresses the file's default by flag and a project block by name", () => {
    expect(answerBody({ project: null, block: "default" }, "pin")).toEqual({ fileDefault: true, answer: "pin" });
    expect(answerBody({ project: "loggd", block: "testo" }, "update")).toEqual({ block: "testo", answer: "update" });
  });

  it("says what an answer did", () => {
    const result = (answer: "update" | "snooze" | "auto", changes = 1) => ({
      root: "/h",
      project: "loggd",
      block: "testo",
      answer,
      changes: Array.from({ length: changes }, () => ({ project: "loggd", block: "testo", stage: "orchestrator", from: "a", to: "b" })),
      agent: agent({ snoozedUntil: "2026-11-25T12:00:00.000Z" }),
    });
    expect(answerMessage(result("update", 2))).toBe("testo: moved 2 stages. It runs the new model from its next start.");
    expect(answerMessage(result("snooze", 0))).toBe("testo: asked again after 2026-11-25.");
    expect(answerMessage(result("auto", 1))).toBe("testo: moves to the latest model by itself at every start; moved 1 stage now.");
  });
});
