// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ProjectPromptsView } from "../contracts";
import { fragmentBody, promptsModel, renderBody } from "./prompts-model";

function view(overrides: Partial<ProjectPromptsView> = {}): ProjectPromptsView {
  return {
    fragments: [
      { kind: "prompt", path: ".ralph/prompt.md", text: "# Prompt\n", missing: false, problem: null },
      { kind: "coder", path: ".ralph/coder.md", text: null, missing: true, problem: null },
      { kind: "plan", path: "PLAN.md", text: null, missing: false, problem: "EACCES: permission denied" },
    ],
    renders: [
      { role: "coder", loop: "rafa", prompt: "You are rafa", error: null },
      { role: "triager", loop: "tria", prompt: null, error: "render failed: no such loop" },
    ],
    problems: [],
    ...overrides,
  };
}

describe("promptsModel", () => {
  it("labels each fragment by kind and tells text, missing and unreadable apart", () => {
    expect(promptsModel(view(), null).fragments).toEqual([
      { label: "Prompt fragment", path: ".ralph/prompt.md", body: { kind: "text", text: "# Prompt\n" } },
      { label: "Coder fragment", path: ".ralph/coder.md", body: { kind: "missing" } },
      { label: "Plan", path: "PLAN.md", body: { kind: "problem", text: "EACCES: permission denied" } },
    ]);
  });

  it("draws an empty fragment as text, not as missing", () => {
    expect(fragmentBody({ kind: "prompt", path: "p.md", text: "", missing: false, problem: null })).toEqual({ kind: "text", text: "" });
  });

  it("offers one option per render, labelled by role and loop, and defaults to the first", () => {
    const model = promptsModel(view(), null);
    expect(model.options).toEqual([
      { id: "coder", label: "coder (as rafa)" },
      { id: "triager", label: "triager (as tria)" },
    ]);
    expect(model.chosen).toEqual({ id: "coder", label: "coder (as rafa)", body: { kind: "text", text: "You are rafa" } });
  });

  it("draws the chosen render, a failed one as its error", () => {
    expect(promptsModel(view(), "triager").chosen).toEqual({
      id: "triager",
      label: "triager (as tria)",
      body: { kind: "problem", text: "render failed: no such loop" },
    });
  });

  it("falls back to the first render when the chosen role is gone", () => {
    expect(promptsModel(view(), "sentinel").chosen?.id).toBe("coder");
  });

  it("has nothing chosen when there are no renders, and passes the problems through", () => {
    const model = promptsModel(view({ fragments: [], renders: [], problems: ["config: invalid JSON"] }), null);
    expect(model).toEqual({ fragments: [], options: [], chosen: null, problems: ["config: invalid JSON"] });
  });

  it("never draws a render without a prompt as empty text", () => {
    expect(renderBody({ role: "coder", loop: "rafa", prompt: null, error: null })).toEqual({
      kind: "problem",
      text: "The prompt could not be rendered",
    });
  });
});
