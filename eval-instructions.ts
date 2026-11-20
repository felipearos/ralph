/**
 * The judge panel's and the analyst's opening instructions, read from a
 * harness file a PR can change (#878). An evaluation proposal of kind
 * `judge-prompt` or `analyst-prompt` ships as an edit to one of these files,
 * so the scoring pass reads them on every run. Absence is the normal case:
 * the built-in text in eval-panel.ts and eval-analyst.ts is the default.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ANALYST_INSTRUCTIONS } from "./eval-analyst";
import type { PromptKind } from "./eval-evaluation-proposals";
import { JUDGE_INSTRUCTIONS } from "./eval-panel";

/** Each prompt kind's file, relative to the harness root. */
export const EVAL_INSTRUCTION_FILES: Record<PromptKind, string> = {
  "judge-prompt": "eval-prompts/judge.md",
  "analyst-prompt": "eval-prompts/analyst.md",
};

/** The instructions compiled into the harness, used when no file overrides them. */
export function builtInInstructions(kind: PromptKind): string {
  return kind === "judge-prompt" ? JUDGE_INSTRUCTIONS : ANALYST_INSTRUCTIONS;
}

/**
 * The file's text when it holds any, its trailing whitespace trimmed so the
 * prompt's own blank line before the next section stays the only one.
 * Never throws: a missing, empty or unreadable file (a directory in its
 * place) falls back to the built-in text, so a scoring pass overnight is
 * never lost to a bad file.
 */
export function readEvalInstructions(kind: PromptKind, harnessRoot: string = resolve(import.meta.dirname)): string {
  let text: string;
  try {
    text = readFileSync(join(harnessRoot, EVAL_INSTRUCTION_FILES[kind]), "utf8");
  } catch {
    return builtInInstructions(kind);
  }
  return text.trim() === "" ? builtInInstructions(kind) : text.trimEnd();
}
