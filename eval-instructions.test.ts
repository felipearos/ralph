import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ANALYST_INSTRUCTIONS } from "./eval-analyst";
import { builtInInstructions, EVAL_INSTRUCTION_FILES, readEvalInstructions } from "./eval-instructions";
import { JUDGE_INSTRUCTIONS } from "./eval-panel";
import { scratchDir } from "./test-scratch";

describe("readEvalInstructions", () => {
  it("is the built-in text when the harness has no file", () => {
    const root = scratchDir("eval-instructions-absent-");
    expect(readEvalInstructions("judge-prompt", root)).toBe(JUDGE_INSTRUCTIONS);
    expect(readEvalInstructions("analyst-prompt", root)).toBe(ANALYST_INSTRUCTIONS);
  });

  it("is the file's text, its trailing newline trimmed, when the file holds any", () => {
    const root = scratchDir("eval-instructions-present-");
    mkdirSync(join(root, "eval-prompts"));
    writeFileSync(join(root, EVAL_INSTRUCTION_FILES["judge-prompt"]), "Judge strictly.\n\nCite lines.\n");
    expect(readEvalInstructions("judge-prompt", root)).toBe("Judge strictly.\n\nCite lines.");
    // The other kind's file is absent, so it keeps its default.
    expect(readEvalInstructions("analyst-prompt", root)).toBe(ANALYST_INSTRUCTIONS);
  });

  it("falls back to the built-in text for an empty file or a directory in its place", () => {
    const root = scratchDir("eval-instructions-bad-");
    mkdirSync(join(root, "eval-prompts"));
    writeFileSync(join(root, EVAL_INSTRUCTION_FILES["analyst-prompt"]), "  \n\n");
    mkdirSync(join(root, EVAL_INSTRUCTION_FILES["judge-prompt"]));
    expect(readEvalInstructions("analyst-prompt", root)).toBe(ANALYST_INSTRUCTIONS);
    expect(readEvalInstructions("judge-prompt", root)).toBe(JUDGE_INSTRUCTIONS);
  });

  it("names each kind's constant as its built-in text", () => {
    expect(builtInInstructions("judge-prompt")).toBe(JUDGE_INSTRUCTIONS);
    expect(builtInInstructions("analyst-prompt")).toBe(ANALYST_INSTRUCTIONS);
  });
});
