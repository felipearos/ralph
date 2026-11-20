// @vitest-environment node
/**
 * The learnings fold: what the adapter's two git reads turn into.
 */
import { describe, expect, it } from "vitest";

import { blobBase, foldLearnings, githubAnchor, type LearningsFileRead } from "./learnings";

const PROJECT = `# loggd learnings

## Open: fix these

### A missing TMDB fixture parks PRs (2026-09-30)
<!-- learning: tmdb-fixture-missing -->
- **Seen:** the hermetic stub has no genre-discover fixture.
- **Fix:** #1890.

### CI is sensitive to host load
<!-- learning: ci-host-load -->
- **Seen:** full suites time out at load of about 40 on 16 cores.

## Fixed: kept for context

| Problem | Fixed by |
| --- | --- |
| Something retired | #1 |
`;

const read = (text: string | null, scope: "project" | "harness" = "project"): LearningsFileRead => ({
  scope,
  file: scope === "harness" ? "learnings/harness.md" : "learnings/loggd.md",
  text,
});

describe("blobBase", () => {
  it("reads both GitHub remote forms, with or without .git", () => {
    expect(blobBase("https://github.com/felipearos/ralph.git\n")).toBe(
      "https://github.com/felipearos/ralph/blob/main",
    );
    expect(blobBase("git@github.com:felipearos/ralph.git")).toBe("https://github.com/felipearos/ralph/blob/main");
    expect(blobBase("https://github.com/felipearos/ralph")).toBe("https://github.com/felipearos/ralph/blob/main");
  });

  it("is null for a remote it cannot link, and for no remote at all", () => {
    expect(blobBase(null)).toBeNull();
    expect(blobBase("git@gitlab.com:someone/thing.git")).toBeNull();
    expect(blobBase("/srv/git/mirror.git")).toBeNull();
  });
});

describe("foldLearnings", () => {
  it("reads each open entry's fields, date and anchor, and the Fixed table apart from them", () => {
    const folded = foldLearnings([read(PROJECT)], "git@github.com:felipearos/ralph.git");
    const [first, second] = folded.sources[0]?.entries ?? [];
    expect(first).toEqual({
      slug: "tmdb-fixture-missing",
      title: "A missing TMDB fixture parks PRs",
      date: "2026-09-30",
      anchor: "a-missing-tmdb-fixture-parks-prs-2026-09-30",
      seen: "the hermetic stub has no genre-discover fixture.",
      workaround: null,
      fix: "#1890.",
      change: null,
      verify: null,
      seenAgain: [],
      fixPending: false,
    });
    expect(second).toMatchObject({ title: "CI is sensitive to host load", date: null, fix: null, fixPending: false });
    expect(folded.sources[0]?.fixed).toEqual([{ problem: "Something retired", fixedBy: "#1" }]);
    expect(folded.sources[0]?.present).toBe(true);
    expect(folded.base).toBe("https://github.com/felipearos/ralph/blob/main");
  });

  it("counts Seen again lines, joins wrapped fields, and marks a placeholder Fix pending", () => {
    const text = `## Open: fix these

### Runner refuses (2026-10-06)
<!-- learning: runner-refuses -->
- **Seen:** delegate.sh exits 4
  with an empty log.
- **Workaround:** take route 3.
- **Fix:** no issue yet — an operator restores access.
- **Seen again:** 2026-10-21
- **Seen again:** 2026-11-03
`;
    const [one] = foldLearnings([read(text)], null).sources[0]?.entries ?? [];
    expect(one).toMatchObject({
      seen: "delegate.sh exits 4 with an empty log.",
      fix: "no issue yet — an operator restores access.",
      seenAgain: ["2026-10-21", "2026-11-03"],
      fixPending: true,
    });
  });

  it("does not read a fenced example of a field as the entry's own", () => {
    const text = "## Open\n\n### Quotes a field\n<!-- learning: quotes -->\n- **Seen:** it looks like:\n\n```md\n- **Fix:** no issue yet.\n```\n\n- **Fix:** #12\n";
    const [one] = foldLearnings([read(text)], null).sources[0]?.entries ?? [];
    expect(one).toMatchObject({ fix: "#12", fixPending: false });
  });

  it("marks a file that is not on the ref as absent with no entries", () => {
    const folded = foldLearnings([read(null), read(PROJECT, "harness")], null);
    expect(folded.sources[0]).toEqual({
      scope: "project",
      file: "learnings/loggd.md",
      entries: [],
      fixed: [],
      present: false,
    });
    expect(folded.sources[1]?.present).toBe(true);
    expect(folded.base).toBeNull();
  });

  it("reads a file with a heading but no entries as present and empty", () => {
    const folded = foldLearnings([read("# x learnings\n\n## Open: fix these\n")], null);
    expect(folded.sources[0]).toMatchObject({ present: true, entries: [] });
  });

  it("keeps the order it is given, which is project then harness", () => {
    const folded = foldLearnings([read(PROJECT), read(PROJECT, "harness")], null);
    expect(folded.sources.map((one) => one.scope)).toEqual(["project", "harness"]);
  });
});

describe("githubAnchor", () => {
  it("slugs a heading the way GitHub renders it", () => {
    expect(githubAnchor("A loop's `*-wip` claim does not fence work done outside the loops (2026-10-09)")).toBe(
      "a-loops--wip-claim-does-not-fence-work-done-outside-the-loops-2026-10-09",
    );
    expect(githubAnchor("Onboarding: colour codes reach the problem list")).toBe("onboarding-colour-codes-reach-the-problem-list");
  });
});
