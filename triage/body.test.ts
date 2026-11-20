import { describe, expect, it } from "vitest";

import { parseStaffingGroup } from "../frontier/next-tasks";
import { applySection, carriesOpMarker, issueBodyWithOpMarker, opMarker, withOpMarker } from "./body";

/** What `## <heading>` says, for assertions. The module has no reader of its own. */
const readSection = (body: string, heading: string): string | null => {
  const match = new RegExp(`^##\\s+${heading}\\s*$`, "im").exec(body.replace(/\r\n/g, "\n"));
  if (match === null) return null;
  const rest = body.replace(/\r\n/g, "\n").slice(match.index + match[0].length);
  return (rest.split(/^##\s+/m)[0] ?? "").trim();
};

describe("applySection", () => {
  const body = [
    "## What to build",
    "",
    "the thing",
    "",
    "## Blocked by",
    "",
    "#4",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] it works",
    "",
  ].join("\n");

  it("replaces a section's contents and leaves the rest byte for byte", () => {
    const next = applySection(body, "Blocked by", "replace", "#9");
    expect(readSection(next, "Blocked by")).toBe("#9");
    expect(readSection(next, "What to build")).toBe("the thing");
    expect(readSection(next, "Acceptance criteria")).toBe("- [ ] it works");
  });

  it("appends to a section rather than overwriting it", () => {
    const next = applySection(body, "Acceptance criteria", "append", "- [ ] and this");
    expect(readSection(next, "Acceptance criteria")).toBe("- [ ] it works\n\n- [ ] and this");
  });

  it("appends a heading the body does not carry", () => {
    const next = applySection(body, "Staffing group", "replace", "cli");
    expect(readSection(next, "Staffing group")).toBe("cli");
    expect(next.indexOf("## Staffing group")).toBeGreaterThan(next.indexOf("## Acceptance criteria"));
  });

  it("an append to a missing heading creates it, so the frontier finds it either way", () => {
    expect(readSection(applySection(body, "Parent", "append", "#7"), "Parent")).toBe("#7");
  });

  it("removes the section when the replacement is empty, without growing the body", () => {
    const once = applySection(body, "Blocked by", "replace", "");
    expect(readSection(once, "Blocked by")).toBeNull();
    expect(once).not.toContain("## Blocked by");
    expect(applySection(once, "Blocked by", "replace", "")).toBe(once);
    expect(once).not.toMatch(/\n{3}/);
  });

  it("treats CRLF as newlines, since GitHub's editors introduce them", () => {
    const crlf = body.replace(/\n/g, "\r\n");
    expect(readSection(applySection(crlf, "Blocked by", "replace", "#9"), "Blocked by")).toBe("#9");
  });

  it("an append is a fixed point too: a rerun does not add the text twice", () => {
    // The apply can die between a successful `gh issue edit` and the ledger
    // line recording it, so the rerun reads its own work back as the census.
    const once = applySection(body, "Acceptance criteria", "append", "- [ ] and this");
    expect(applySection(once, "Acceptance criteria", "append", "- [ ] and this")).toBe(once);
  });

  it("is a fixed point: re-applying the same section changes nothing", () => {
    for (const heading of ["Blocked by", "Acceptance criteria", "Staffing group"] as const) {
      const once = applySection(body, heading, "replace", "same text");
      expect(applySection(once, heading, "replace", "same text")).toBe(once);
    }
  });

  it("writes a section into an empty body", () => {
    expect(applySection("", "Parent", "replace", "#3")).toBe("## Parent\n\n#3\n");
  });

  it("does not touch a heading that merely starts with the same words", () => {
    const decoy = "## Blocked by something else\n\nprose\n";
    expect(readSection(decoy, "Blocked by")).toBeNull();
    expect(applySection(decoy, "Blocked by", "replace", "#9")).toContain("## Blocked by something else");
  });
});

describe("applySection leaves prose alone", () => {
  it("does not touch blank lines outside the section it edits", () => {
    const authored = [
      "## What to build",
      "",
      "```",
      "a",
      "",
      "",
      "b",
      "```",
      "",
      "## Blocked by",
      "",
      "#4",
      "",
    ].join("\n");
    const next = applySection(authored, "Blocked by", "replace", "#9");
    // Byte for byte up to the heading it edits — a fenced block with two blank
    // lines in it is the author's, not the triager's.
    expect(next.slice(0, next.indexOf("## Blocked by"))).toBe(
      authored.slice(0, authored.indexOf("## Blocked by")),
    );
  });
});

describe("issueBodyWithOpMarker", () => {
  it("puts the marker ABOVE the first heading, so no section contains it", () => {
    const body = "## Parent\n\n#100\n\n## Staffing group\n\ncli\n";
    const marked = issueBodyWithOpMarker(body, "n1");
    expect(marked.startsWith(opMarker("n1"))).toBe(true);
    expect(carriesOpMarker(marked, "n1")).toBe(true);
    // The point: a trailing marker would land inside `## Staffing group`, whose
    // content must be one kebab-case word. The parser now skips HTML comments
    // too, so either placement reads — the leading one stays because a section
    // should hold only what its author wrote. Asserted against the real parser.
    expect(parseStaffingGroup(marked)).toBe("cli");
    expect(parseStaffingGroup(withOpMarker(body, "n1"))).toBe("cli");
  });
});

describe("op markers", () => {
  it("round-trips an op id through a body", () => {
    const text = withOpMarker("Split into three.", "c1");
    expect(carriesOpMarker(text, "c1")).toBe(true);
    expect(carriesOpMarker(text, "c2")).toBe(false);
    expect(text.endsWith(opMarker("c1"))).toBe(true);
  });
});
