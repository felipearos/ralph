import { describe, expect, it } from "vitest";
import type { RunnerCatalogView } from "../../lineup/contracts";
import { groupModels, modelName } from "./model-groups";

const catalog = (models: RunnerCatalogView["models"], aliases = {}): RunnerCatalogView => ({
  available: true, reason: null, source: "fixture", version: null, models, aliases, efforts: [],
});
const choices = (...ids: string[]) => ids.map(id => ({ id }));

describe("model picker groups", () => {
  it("puts OpenCode Go first without losing other providers or changing IDs", () => {
    const models = choices("opencode/free", "other/custom", "opencode-go/paid");
    const groups = groupModels(models, "opencode");
    expect(groups.map(group => group.label)).toEqual(["OpenCode Go", "OpenCode", "other"]);
    expect(groups.flatMap(group => group.choices).map(choice => choice.id).sort()).toEqual(models.map(choice => choice.id).sort());
  });

  it("finds Claude's newest version per family, including aliases and dated older IDs", () => {
    const models = choices("claude-opus-4-9", "claude-opus-4-10", "claude-haiku-4-5", "claude-3-5-haiku-20241022");
    const groups = groupModels([...models, { id: "opus" }, { id: "my-custom-model" }], "claude",
      catalog(models, { opus: "claude-opus-4-10" }));
    expect(groups.find(group => group.label === "New models")?.choices.map(choice => choice.id))
      .toEqual(["claude-opus-4-10", "claude-haiku-4-5", "opus"]);
    expect(groups.find(group => group.label === "Older models")?.choices.map(choice => choice.id))
      .toEqual(["claude-opus-4-9", "claude-3-5-haiku-20241022"]);
    expect(groups.find(group => group.label === "Other models")?.choices).toEqual([{ id: "my-custom-model" }]);
  });

  it("uses Codex's upgrade metadata instead of guessing age from version numbers", () => {
    const models = [{ id: "gpt-5.6-sol" }, { id: "gpt-6-astra" }, { id: "gpt-5.5", upgradeTo: "gpt-5.6-sol" }];
    const groups = groupModels(choices("gpt-5.6-sol", "gpt-5.5", "custom"), "codex", catalog(models));
    expect(groups.map(group => [group.label, group.choices.map(choice => choice.id)])).toEqual([
      ["New models", ["gpt-5.6-sol"]], ["Older models", ["gpt-5.5"]], ["Other models", ["custom"]],
    ]);
  });
});

describe("model names in the lineup table", () => {
  const claude = catalog(
    [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "opus", label: "alias for claude-opus-5-5" }],
    { opus: "claude-opus-5-5" },
  );

  it("uses the harness's label, and an alias names the model it points at", () => {
    expect(modelName("claude-opus-5-5", "claude", claude)).toBe("Opus 5.5");
    expect(modelName("opus", "claude", claude)).toBe("Opus 5.5 (opus)");
  });

  it("drops OpenCode's provider and keeps an unknown id as written", () => {
    expect(modelName("opencode/big-pickle", "opencode")).toBe("big-pickle");
    expect(modelName("claude-custom-1", "claude", claude)).toBe("claude-custom-1");
    expect(modelName("gpt-6-luna", "codex", catalog([{ id: "gpt-6-luna", label: "GPT-6-Luna" }]))).toBe("GPT-6-Luna");
    expect(modelName("gpt-6-sol", "codex")).toBe("gpt-6-sol");
  });
});
