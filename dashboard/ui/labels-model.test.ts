// @vitest-environment node
/**
 * The Labels page's decisions. `.tsx` has no tests, so the ordering, the
 * missing count and the escaping of what the repository hands back are
 * pinned here.
 */
import { describe, expect, it } from "vitest";

import type { LabelsView, ProjectLabelView } from "../contracts";
import { createCommand, labelHref, labelsPage, swatch } from "./labels-model";

const label = (name: string, fields: Partial<ProjectLabelView> = {}): ProjectLabelView => ({
  name,
  usedBy: [{ loop: "ralph", role: "coder" }],
  onRepo: true,
  color: null,
  description: null,
  ...fields,
});

const view = (labels: ProjectLabelView[]): LabelsView => ({ project: "p", repo: "o/r", labels, problems: [] });

describe("labelsPage", () => {
  it("splits needed labels from the repository's others and puts missing ones first", () => {
    const page = labelsPage(
      view([
        label("ralph-wip"),
        label("ralph-done", { onRepo: false }),
        label("bug", { usedBy: [] }),
        label("ralph-blocked"),
        label("automerge", { usedBy: [] }),
      ]),
    );
    expect(page.needed.map((entry) => entry.name)).toEqual(["ralph-done", "ralph-blocked", "ralph-wip"]);
    expect(page.other.map((entry) => entry.name)).toEqual(["automerge", "bug"]);
    expect(page.missing).toBe(1);
  });

  it("does not count a label as missing when the repository could not be read", () => {
    // Unknown is not missing: a failed `gh label list` must not paint every
    // claim label red.
    const page = labelsPage(view([label("ralph-wip", { onRepo: null }), label("ralph-done", { onRepo: null })]));
    expect(page.missing).toBe(0);
  });
});

describe("swatch", () => {
  it("accepts a six-digit hex and nothing else", () => {
    expect(swatch("FBCA04")).toBe("#FBCA04");
    expect(swatch(null)).toBeNull();
    expect(swatch("red; background: url(x)")).toBeNull();
    expect(swatch("fff")).toBeNull();
  });
});

describe("labelHref", () => {
  it("links to the repository's items carrying the label, quoting names with spaces", () => {
    expect(labelHref("o/r", "good first issue")).toBe(
      "https://github.com/o/r/issues?q=label%3A%22good%20first%20issue%22",
    );
    expect(labelHref(null, "bug")).toBeNull();
  });
});

describe("createCommand", () => {
  it("quotes a name the shell would split", () => {
    expect(createCommand("o/r", "ralph-wip")).toBe("gh label create ralph-wip --repo o/r");
    expect(createCommand("o/r", "priority:urgent")).toBe("gh label create priority:urgent --repo o/r");
    expect(createCommand("o/r", "it's ok")).toBe("gh label create 'it'\\''s ok' --repo o/r");
  });
});
