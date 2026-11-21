// @vitest-environment node
/**
 * Ralph is itself a Ralph project. Its fragments are spliced into every
 * iteration's prompt, so they must name this repository's real commands and
 * the entry doc they point at must exist (#298).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePlanFences } from "./frontier-gate";

const ROOT = import.meta.dirname;
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("ralph's own fragments", () => {
  it("point at an entry doc that exists", () => {
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    // CLAUDE.md is only the import, so a loop that reads it by hand finds nothing else.
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
    expect(read(".ralph/prompt.md")).toContain("AGENTS.md");
    expect(read(".ralph/coder.md")).toContain("AGENTS.md");
  });

  it("name bun gates, never npm", () => {
    for (const fragment of [".ralph/prompt.md", ".ralph/coder.md"]) {
      expect(read(fragment)).not.toMatch(/\bnpm\b/);
      expect(read(fragment)).toContain("bun run typecheck");
    }
    expect(read(".ralph/prompt.md")).toContain("bun run test");
    expect(read(".ralph/prompt.md")).toContain("bun run lint");
  });
});

describe("ralph's own review gate", () => {
  // The CODEX section is spliced in just before §5 step 6's merge conditions,
  // which is what makes Qodo's review of the head a condition of the merge here.
  const gate = (): string => {
    const prompt = read(".ralph/prompt.md");
    const start = prompt.indexOf("<!-- ralph:section CODEX -->");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = prompt.indexOf("<!-- ralph:section", start + 1);
    return prompt.slice(start, end === -1 ? undefined : end);
  };

  it("waits on a Qodo review of the head through the tool that exists", () => {
    expect(gate()).toContain('bun "$RALPH_HOME/qodo-review.ts" <pr>');
    expect(existsSync(join(ROOT, "qodo-review.ts"))).toBe(true);
  });

  it("states the fix threshold, the Low report, and the stall stop", () => {
    const text = gate();
    expect(text).toMatch(/Fix every \*valid\* \*\*High\*\* or \*\*Medium\*\*/);
    expect(text).toContain("### Low findings for the");
    expect(text).toContain("Stall stop.");
    // A reply Qodo is not addressed in never reaches it, and its findings are not threads.
    expect(text).toContain("one PR comment that starts with `@qodo `");
    expect(text).toContain("do NOT arrive as review threads");
  });

  it("never merges past an unmet gate: exit 4 hands the PR to a person", () => {
    expect(gate()).toMatch(/\*\*Exit 4\*\*[\s\S]*Do\s+not merge/);
    expect(gate()).toContain('tracker.ts"\n   handoff <n> --pr <pr-url>');
  });
});

describe("ralph's own plan", () => {
  // The fences are machine-read, and `issueRefsUnderHeading` matches `#<n>`
  // against the section's raw text — an HTML comment included. So a note
  // recording that a hold ENDED re-fences every number it names, which is the
  // defect #299 shipped and then fixed. Asserting the live file, because the
  // parser's own behaviour is already pinned in `frontier-gate.test.ts` and
  // the thing that keeps breaking is this plan.
  it("fences nothing it only mentions inside a comment", () => {
    const plan = read(".ralph/plan.md");
    const fences = parsePlanFences(plan);
    const inComments = new Set(
      (plan.match(/<!--[\s\S]*?-->/g) ?? []).flatMap((comment) =>
        (comment.match(/#(\d+)/g) ?? []).map((ref) => Number(ref.slice(1))),
      ),
    );
    expect(
      [...fences.outOfScope, ...fences.closureParents].filter((n) => inComments.has(n)),
    ).toEqual([]);
    // …and the heading still parses, so the assertion above cannot pass by
    // matching nothing at all.
    expect(fences.outOfScope).toContain(8);
    expect(fences.closureParents.length).toBeGreaterThan(0);
  });
});
