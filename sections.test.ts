/**
 * What `sections.ts` promises three layers at once: the frontier sizing a
 * ticket, `triage/body.ts` rewriting a section, and `triage/validate.ts`
 * asking what text a rescue is about to replace all read the same anchor. The
 * cases that matter are the boundaries — a missing heading, an empty section,
 * the last section in a body — because that is where two parsers would have
 * disagreed.
 */
import { describe, expect, it } from "vitest";

import { sectionIfPresent, sectionRange } from "./sections";

const BODY = [
  "## What to build",
  "",
  "A thing.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] It works.",
  "",
  "## Blocked by",
  "",
  "#99",
  "",
].join("\n");

describe("sectionIfPresent", () => {
  it("reads a section bounded by the next heading", () => {
    // The heading's own line break is consumed by the anchor's `\s*$`, so a
    // section begins at the blank line after it.
    expect(sectionIfPresent(BODY, "What to build")).toBe("\nA thing.\n\n");
  });

  it("reads the LAST section to the end of the body", () => {
    expect(sectionIfPresent(BODY, "Blocked by")).toBe("\n#99\n");
  });

  it("answers null for a heading the body does not have, not the whole body", () => {
    // The distinction the frontier's `sectionUnderHeading` composes over, and
    // the one `triage/validate.ts` needs: "no such heading" is not "empty".
    expect(sectionIfPresent(BODY, "Staffing group")).toBeNull();
    expect(sectionIfPresent("No headings at all.\n", "What to build")).toBeNull();
  });

  it("tells an empty section from a missing one", () => {
    expect(sectionIfPresent("## What to build\n\n## Parent\n\n#1\n", "What to build")).toBe("\n");
  });

  it("matches case-insensitively and ignores trailing space on the heading line", () => {
    expect(sectionIfPresent("## what to BUILD   \n\nx\n", "What to build")).toBe("\nx\n");
  });

  it("does not match a heading of another level, or one mid-line", () => {
    expect(sectionIfPresent("### What to build\n\nx\n", "What to build")).toBeNull();
    expect(sectionIfPresent("see ## What to build\n\nx\n", "What to build")).toBeNull();
  });

  it("treats a heading's regex characters as text", () => {
    expect(sectionIfPresent("## A (b) [c] d.e\n\nx\n", "A (b) [c] d.e")).toBe("\nx\n");
    expect(sectionIfPresent("## A (b) [c] d.e\n\nx\n", "A (b) [c] dXe")).toBeNull();
  });

  it("takes the FIRST of two identical headings", () => {
    expect(sectionIfPresent("## P\n\nfirst\n\n## P\n\nsecond\n", "P")).toBe("\nfirst\n\n");
  });
});

describe("sectionRange", () => {
  it("spans the heading line through to the next heading", () => {
    const range = sectionRange(BODY, "Acceptance criteria")!;
    expect(BODY.slice(range.start, range.contentStart)).toBe("## Acceptance criteria\n");
    expect(BODY.slice(range.contentStart, range.end)).toBe("\n- [ ] It works.\n\n");
  });

  it("agrees with sectionIfPresent on every heading in a body", () => {
    for (const heading of ["What to build", "Acceptance criteria", "Blocked by", "Parent"]) {
      const range = sectionRange(BODY, heading);
      const text = sectionIfPresent(BODY, heading);
      expect(range === null ? null : BODY.slice(range.contentStart, range.end)).toBe(text);
    }
  });
});
