import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAP_BYTES,
  LearningsError,
  addEntry,
  closeEntry,
  findEntry,
  noIssueYet,
  parseLearnings,
  renderOpen,
  reviseEntry,
  seenAgain,
} from "./learnings";

/** The `harness.md` shape: prose, Open, Fixed, and a section after Fixed. */
const HARNESS = `# Harness learnings

Lessons about Ralph itself. See \`README.md\` for how learnings are split.

## Open: fix these

### Parked PRs starve the loops (2026-09-30)
<!-- learning: parked-prs-starve-loops -->
- **Seen on loggd:** all 5 loops sat "frontier is empty" for 6-8 h.
- **Workaround:**
  1. File the root cause as a \`ready-for-agent\` ticket.
  2. Add a native \`blocked_by\` edge.
- **Fix:** ralph #155.

### CI times out under host load
<!-- learning: ci-timeout-host-load -->
- **Seen:** full suites time out at load of about 40 on 16 cores.
- **Fix:** no issue yet.

## Fixed: kept for context

| Problem | Fixed by |
| --- | --- |
| Dashboard read the roster from a stale branch | #190 (#183) |

## Operator notes

- **Dashboard env.** Never export \`RALPH_DASHBOARD_ROOTS\` in a profile.
`;

/** The `loggd.md` shape: no Fixed section, and a third section after Open. */
const LOGGD = `# loggd learnings

Lessons from running Ralph on loggd.

## Open: fix these

### A missing TMDB fixture parks PRs (2026-09-30)
<!-- learning: tmdb-fixture-missing -->
- **Seen:** the hermetic TMDB stub has no genre-discover fixture.
- **Fix:** #1890.

## Host hygiene: check these first when loops go slow or red

- **Leaked E2E servers.** A \`next start\` ran for 21 h at about 90% CPU.
`;

/** The entries that predate the slug comment: they must still parse. */
const LEGACY = `# ralph learnings

## Open: fix these

### The test gate writes into the live loop (2026-09-30)
- **Seen:** the loop's \`bun run test\` gate runs inside the live worktree.
- **Fix:** #199.

## Fixed: kept for context

| Problem | Fixed by |
| --- | --- |
| Setup's \`git add\` refused gitignored files | #181 |
`;

/**
 * `HARNESS` with its first entry quoting the SECOND entry's whole block in a
 * fence, so the quoted copy comes first in the section. Every rewrite below has
 * to splice the real entry rather than the quotation.
 */
const quotingHarness = (): { text: string; quoted: string } => {
  const quoted = parseLearnings(HARNESS).open[1]?.text as string;
  const text = HARNESS.replace(
    '- **Seen on loggd:** all 5 loops sat "frontier is empty" for 6-8 h.',
    `- **Seen on loggd:** the other entry reads:\n\n\`\`\`markdown\n${quoted}\n\`\`\``,
  );
  // The hazard only exists if the copy really is earlier than the entry.
  if (text.indexOf(quoted) === text.lastIndexOf(quoted)) throw new Error("fixture did not quote the entry");
  return { text, quoted };
};

const entry = (slug: string, title = "A new thing") =>
  `### ${title}\n<!-- learning: ${slug} -->\n- **Seen:** PR #1, build #2, 2026-10-06.\n- **Workaround:** wait.\n- **Fix:** no issue yet.`;

describe("parseLearnings", () => {
  it("reads the entries, their slugs and their nested bodies", () => {
    const parsed = parseLearnings(HARNESS);
    expect(parsed.hasOpen).toBe(true);
    expect(parsed.hasFixed).toBe(true);
    expect(parsed.open.map((one) => one.slug)).toEqual([
      "parked-prs-starve-loops",
      "ci-timeout-host-load",
    ]);
    expect(parsed.open.map((one) => one.title)).toEqual([
      "Parked PRs starve the loops (2026-09-30)",
      "CI times out under host load",
    ]);
    expect(parsed.open[0]?.body).toContain("  2. Add a native `blocked_by` edge.");
    expect(parsed.open[0]?.body).toMatch(/- \*\*Fix:\*\* ralph #155\.$/);
    expect(parsed.open[0]?.heading).toBe("### Parked PRs starve the loops (2026-09-30)");
  });

  it("reads the Fixed rows without their header rows", () => {
    expect(parseLearnings(HARNESS).fixed).toEqual([
      { problem: "Dashboard read the roster from a stale branch", fixedBy: "#190 (#183)" },
    ]);
  });

  it("reports a file with no Fixed section, and does not mistake a later section for it", () => {
    const parsed = parseLearnings(LOGGD);
    expect(parsed.hasOpen).toBe(true);
    expect(parsed.hasFixed).toBe(false);
    expect(parsed.fixed).toEqual([]);
    expect(parsed.open).toHaveLength(1);
    expect(parsed.open[0]?.body).not.toContain("Host hygiene");
    expect(parsed.open[0]?.body).not.toContain("Leaked E2E servers");
  });

  it("gives an entry written before slugs a null slug rather than failing", () => {
    const parsed = parseLearnings(LEGACY);
    expect(parsed.open).toHaveLength(1);
    expect(parsed.open[0]?.slug).toBeNull();
    expect(parsed.open[0]?.title).toBe("The test gate writes into the live loop (2026-09-30)");
  });

  it("reports a file with no Open section as empty rather than throwing", () => {
    const parsed = parseLearnings("# Nothing yet\n\nNo sections at all.\n");
    expect(parsed).toEqual({ open: [], fixed: [], hasOpen: false, hasFixed: false });
  });
});

describe("findEntry", () => {
  it("finds an entry by slug and returns null for anything else", () => {
    expect(findEntry(HARNESS, "ci-timeout-host-load")?.title).toBe("CI times out under host load");
    expect(findEntry(HARNESS, "no-such-slug")).toBeNull();
    expect(findEntry(LEGACY, "no-such-slug")).toBeNull();
  });
});

describe("addEntry", () => {
  it("prepends the entry and leaves the rest of the file byte for byte", () => {
    const next = addEntry(HARNESS, entry("opencode-subscription-lapsed"));
    const parsed = parseLearnings(next);
    expect(parsed.open.map((one) => one.slug)).toEqual([
      "opencode-subscription-lapsed",
      "parked-prs-starve-loops",
      "ci-timeout-host-load",
    ]);
    // Everything that is not the new entry survives unchanged.
    expect(next.replace(`${entry("opencode-subscription-lapsed")}\n\n`, "")).toBe(HARNESS);
    expect(next.endsWith("\n")).toBe(true);
    expect(next).not.toContain("\n\n\n");
  });

  it("keeps the sections that follow Open intact", () => {
    const next = addEntry(LOGGD, entry("host-load"));
    expect(next).toContain("## Host hygiene: check these first when loops go slow or red");
    expect(parseLearnings(next).open.map((one) => one.slug)).toEqual([
      "host-load",
      "tmdb-fixture-missing",
    ]);
  });

  it("adds the first entry to an Open section that has none", () => {
    const empty = "# Fresh learnings\n\n## Open: fix these\n";
    const next = addEntry(empty, entry("first-one"));
    expect(parseLearnings(next).open.map((one) => one.slug)).toEqual(["first-one"]);
    expect(next.endsWith("\n")).toBe(true);
    expect(next).not.toContain("\n\n\n");
  });

  it("refuses a slug that is already open, naming it, rather than duplicating it", () => {
    expect(() => addEntry(HARNESS, entry("ci-timeout-host-load"))).toThrow(LearningsError);
    expect(() => addEntry(HARNESS, entry("ci-timeout-host-load"))).toThrow(
      /'ci-timeout-host-load' is already an open learning/,
    );
  });

  it("refuses an entry with no slug comment, or more than one", () => {
    expect(() => addEntry(HARNESS, "### No slug\n- **Seen:** nothing.")).toThrow(
      /must carry a '<!-- learning: <slug> -->' comment/,
    );
    const two = "### Two slugs\n<!-- learning: one -->\n<!-- learning: two -->\n- **Seen:** x.";
    expect(() => addEntry(HARNESS, two)).toThrow(/exactly one slug comment; this one has 2/);
  });

  it("refuses a slug that is not lowercase-hyphen", () => {
    expect(() => addEntry(HARNESS, entry("Not_A_Slug"))).toThrow(/is not a usable slug/);
  });

  it("refuses a body that is not a '###' block", () => {
    expect(() => addEntry(HARNESS, "- **Seen:** no heading.\n<!-- learning: x -->")).toThrow(
      /must start with a '### <title>' heading line/,
    );
    expect(() => addEntry(HARNESS, "## Too shallow\n<!-- learning: x -->")).toThrow(
      /must start with a '### <title>' heading line/,
    );
  });

  it("refuses an unfenced heading in the body, which would cut the file in two", () => {
    // The bug this closes: `addEntry` used to accept this, and the `## Why`
    // became a top-level section — pushing every entry below it out of Open, so
    // the loop stopped being shown them and the duplicate guard went blind.
    const withHeading = `### The runner dies\n<!-- learning: runner-dies -->\n- **Seen:** twice\n\n## Why\n\n- the host swaps`;
    expect(() => addEntry(HARNESS, withHeading)).toThrow(/must be one '### ' block with no heading inside it/);
    expect(() => addEntry(HARNESS, withHeading)).toThrow(/'## Why'/);
    // A second `###` block is the same fault: it would add a slugless entry
    // that `--close` could never retire.
    const two = `### One\n<!-- learning: one -->\n- **Seen:** x\n\n### Two\n- **Seen:** y`;
    expect(() => addEntry(HARNESS, two)).toThrow(/no heading inside it/);
  });

  it("accepts a heading that is fenced, because a quoted snippet is inert", () => {
    const quoting = [
      "### Writing a learning about the prompt (2026-10-06)",
      "<!-- learning: prompt-snippet -->",
      "- **Seen:** the §6 heredoc.",
      "- **Workaround:** the entry may quote a heading when it is fenced:",
      "",
      "  ```md",
      "  ## Open: fix these",
      "  ### Not an entry",
      "  ```",
      "",
      "- **Fix:** no issue yet.",
    ].join("\n");
    const next = addEntry(HARNESS, quoting);
    const parsed = parseLearnings(next);
    // The fenced lines are neither a section nor an entry.
    expect(parsed.open.map((one) => one.slug)).toEqual([
      "prompt-snippet",
      "parked-prs-starve-loops",
      "ci-timeout-host-load",
    ]);
    expect(parsed.fixed).toEqual(parseLearnings(HARNESS).fixed);
    expect(parsed.open[0]?.body).toContain("## Open: fix these");
    // And the fence survives a close of a NEIGHBOUR untouched.
    const closed = closeEntry(next, "ci-timeout-host-load", 5);
    expect(closed).toContain("  ```md\n  ## Open: fix these\n  ### Not an entry\n  ```");
    expect(parseLearnings(closed).open.map((one) => one.slug)).toEqual([
      "prompt-snippet",
      "parked-prs-starve-loops",
    ]);
  });

  it("refuses a file with no Open section, naming the heading it wanted", () => {
    expect(() => addEntry("# Nothing\n", entry("x"))).toThrow(/has no '## Open …' section/);
  });
});

describe("seenAgain", () => {
  it("appends the line to the right entry and leaves its neighbours alone", () => {
    const next = seenAgain(HARNESS, "parked-prs-starve-loops", "2026-10-06");
    const parsed = parseLearnings(next);
    expect(parsed.open[0]?.body).toMatch(/- \*\*Fix:\*\* ralph #155\.\n- \*\*Seen again:\*\* 2026-10-06$/);
    expect(parsed.open[1]?.text).toBe(parseLearnings(HARNESS).open[1]?.text);
    expect(next).toContain("## Operator notes");
    expect(parsed.fixed).toEqual(parseLearnings(HARNESS).fixed);
  });

  it("appends to the last entry of the section without swallowing the next heading", () => {
    const next = seenAgain(HARNESS, "ci-timeout-host-load", "2026-10-06");
    expect(next).toContain("- **Seen again:** 2026-10-06\n\n## Fixed: kept for context");
    expect(parseLearnings(next).open).toHaveLength(2);
  });

  it("appends twice when called twice: deduplication is the caller's job", () => {
    const once = seenAgain(HARNESS, "ci-timeout-host-load", "2026-10-06");
    const twice = seenAgain(once, "ci-timeout-host-load", "2026-10-06");
    expect(twice.match(/\*\*Seen again:\*\* 2026-10-06/g)).toHaveLength(2);
  });

  it("dates the entry itself when an earlier entry quotes its block in a fence", () => {
    const { text, quoted } = quotingHarness();
    const next = seenAgain(text, "ci-timeout-host-load", "2026-10-06");
    // The line landed on the real entry...
    expect(parseLearnings(next).open[1]?.body).toMatch(/- \*\*Seen again:\*\* 2026-10-06$/);
    // ...and not inside the quotation, which is byte-identical.
    expect(next).toContain(`\`\`\`markdown\n${quoted}\n\`\`\``);
    expect(next.match(/\*\*Seen again:\*\*/g)).toHaveLength(1);
  });

  it("refuses an unknown slug, naming it", () => {
    expect(() => seenAgain(HARNESS, "no-such-slug", "2026-10-06")).toThrow(
      /no open learning carries the slug 'no-such-slug'/,
    );
  });
});

describe("reviseEntry", () => {
  const revised = (slug: string, title: string) =>
    `### ${title}\n<!-- learning: ${slug} -->\n- **Seen:** the hold it named was lifted.\n- **Workaround:** end ALL_BLOCKED.\n- **Fix:** no issue yet.`;

  it("replaces the entry's heading and body, leaving everything else byte for byte", () => {
    const block = revised("parked-prs-starve-loops", "Parked PRs still starve the loops (2026-10-12)");
    const next = reviseEntry(HARNESS, "parked-prs-starve-loops", block);
    // The whole file, byte for byte: only that entry's span may differ, so a
    // change to the blank lines around it fails here rather than passing a
    // parse-level comparison.
    // The entry's Fix is settled (`ralph #155.`), so it survives the draft's
    // `no issue yet.`; everything else is the draft's.
    const old = parseLearnings(HARNESS).open[0]?.text as string;
    expect(next).toBe(HARNESS.replace(old, block.replace("- **Fix:** no issue yet.", "- **Fix:** ralph #155.")));
    const parsed = parseLearnings(next);
    expect(parsed.open[0]?.title).toBe("Parked PRs still starve the loops (2026-10-12)");
    expect(parsed.open[0]?.body).toContain("- **Workaround:** end ALL_BLOCKED.");
    expect(parsed.open[0]?.body).not.toContain("blocked_by");
    expect(parsed.open[1]?.text).toBe(parseLearnings(HARNESS).open[1]?.text);
    expect(parsed.fixed).toEqual(parseLearnings(HARNESS).fixed);
    expect(next).toContain("## Operator notes");
    expect(next.slice(next.indexOf("## Fixed"))).toBe(HARNESS.slice(HARNESS.indexOf("## Fixed")));
  });

  it("keeps the entry where it sits rather than moving it to the top", () => {
    const next = reviseEntry(HARNESS, "ci-timeout-host-load", revised("ci-timeout-host-load", "CI times out under host load (2026-10-12)"));
    expect(parseLearnings(next).open.map((one) => one.slug)).toEqual([
      "parked-prs-starve-loops",
      "ci-timeout-host-load",
    ]);
    expect(parseLearnings(next).open[1]?.title).toBe("CI times out under host load (2026-10-12)");
  });

  it("revises the last entry of the section without swallowing the next heading", () => {
    const next = reviseEntry(HARNESS, "ci-timeout-host-load", revised("ci-timeout-host-load", "Still timing out"));
    expect(next).toContain("- **Fix:** no issue yet.\n\n## Fixed: kept for context");
    expect(parseLearnings(next).open).toHaveLength(2);
  });

  it("revises the only entry of a file that has no Fixed section", () => {
    const next = reviseEntry(LOGGD, "tmdb-fixture-missing", revised("tmdb-fixture-missing", "The TMDB fixture is still missing"));
    expect(parseLearnings(next).open).toHaveLength(1);
    expect(parseLearnings(next).hasFixed).toBe(false);
    expect(next).toContain("## Host hygiene: check these first when loops go slow or red");
  });

  it("refuses an unknown slug, naming it", () => {
    expect(() => reviseEntry(HARNESS, "no-such-slug", revised("no-such-slug", "Nope"))).toThrow(
      /no open learning carries the slug 'no-such-slug'/,
    );
  });

  it("refuses a replacement slugged as a different entry, naming both", () => {
    expect(() => reviseEntry(HARNESS, "parked-prs-starve-loops", revised("ci-timeout-host-load", "Wrong key"))).toThrow(
      /slugged 'ci-timeout-host-load' but 'parked-prs-starve-loops' is the entry being revised/,
    );
  });

  it("applies the same block validation as addEntry", () => {
    expect(() => reviseEntry(HARNESS, "parked-prs-starve-loops", "- **Seen:** no heading")).toThrow(
      /must start with a '### <title>' heading line/,
    );
    expect(() =>
      reviseEntry(
        HARNESS,
        "parked-prs-starve-loops",
        `### Title\n<!-- learning: parked-prs-starve-loops -->\n- **Seen:** x\n## Why\n- **Fix:** none.`,
      ),
    ).toThrow(/no heading inside it; this one has '## Why'/);
    expect(() => reviseEntry(HARNESS, "parked-prs-starve-loops", "### Title\n- **Seen:** x")).toThrow(
      /must carry a '<!-- learning: <slug> -->' comment/,
    );
  });

  it("carries the entry's Seen again ledger over, whether or not the draft repeats it", () => {
    const twice = seenAgain(seenAgain(HARNESS, "parked-prs-starve-loops", "2026-10-10"), "parked-prs-starve-loops", "2026-10-11");
    const bare = reviseEntry(twice, "parked-prs-starve-loops", revised("parked-prs-starve-loops", "Corrected"));
    expect(bare.match(/\*\*Seen again:\*\*/g)).toHaveLength(2);
    expect(parseLearnings(bare).open[0]?.body).toMatch(
      /- \*\*Fix:\*\* ralph #155\.\n- \*\*Seen again:\*\* 2026-10-10\n- \*\*Seen again:\*\* 2026-10-11$/,
    );
    // A draft that reproduces the ledger does not double it.
    const repeated = `${revised("parked-prs-starve-loops", "Corrected")}\n- **Seen again:** 2026-10-10\n- **Seen again:** 2026-10-11`;
    expect(reviseEntry(twice, "parked-prs-starve-loops", repeated)).toBe(bare);
  });

  it("leaves an indented Seen again line where it is, as a child of its item", () => {
    const nested = HARNESS.replace(
      "- **Seen:** full suites time out at load of about 40 on 16 cores.",
      "- **Seen:** full suites time out.\n  - **Seen again:** 2026-02-02 (on loggd)",
    );
    const next = reviseEntry(nested, "ci-timeout-host-load", revised("ci-timeout-host-load", "Corrected"));
    // The draft replaced the prose, so the indented line goes with it rather
    // than being re-emitted under a different parent item.
    expect(next).not.toContain("2026-02-02");
    expect(parseLearnings(next).open[1]?.body).toMatch(/- \*\*Fix:\*\* no issue yet\.$/);
  });

  it("keeps a blank line between a correction that ends in a fence and the carried ledger", () => {
    const twice = seenAgain(HARNESS, "ci-timeout-host-load", "2026-10-10");
    const endsInFence = [
      "### CI times out under host load",
      "<!-- learning: ci-timeout-host-load -->",
      "- **Seen:** the command that shows it:",
      "",
      "```bash",
      "uptime",
      "```",
    ].join("\n");
    const next = reviseEntry(twice, "ci-timeout-host-load", endsInFence);
    expect(next).toContain("```bash\nuptime\n```\n\n- **Seen again:** 2026-10-10");
  });

  it("treats a Seen again line quoted inside a fence as prose, not as ledger", () => {
    const quoted = [
      "### How a learning is shaped",
      "<!-- learning: parked-prs-starve-loops -->",
      "- **Seen:** the shape is:",
      "",
      "  ```markdown",
      "  - **Seen again:** 2026-01-01",
      "  ```",
      "",
      "- **Fix:** no issue yet.",
    ].join("\n");
    const next = reviseEntry(HARNESS, "parked-prs-starve-loops", quoted);
    // The quoted line stays inside the fence, where the draft put it.
    expect(next).toContain("  ```markdown\n  - **Seen again:** 2026-01-01\n  ```");
    expect(parseLearnings(next).open[0]?.body).toMatch(/- \*\*Fix:\*\* ralph #155\.$/);
  });

  it("revises the entry itself when an earlier entry quotes its whole block in a fence", () => {
    // The hazard this pins: the quoted copy comes FIRST in the section, so a
    // splice located by searching for the entry's text would rewrite somebody
    // else's fenced example and leave the real entry stale.
    const target = parseLearnings(HARNESS).open[1]?.text as string;
    const quoting = HARNESS.replace(
      "- **Seen on loggd:** all 5 loops sat \"frontier is empty\" for 6-8 h.",
      `- **Seen on loggd:** the other entry reads:\n\n\`\`\`markdown\n${target}\n\`\`\``,
    );
    expect(quoting.indexOf(target)).toBeLessThan(quoting.lastIndexOf(target));

    const next = reviseEntry(quoting, "ci-timeout-host-load", revised("ci-timeout-host-load", "Corrected in place"));
    // The real entry changed...
    expect(parseLearnings(next).open[1]?.title).toBe("Corrected in place");
    // ...and the quotation did not.
    expect(next).toContain(`\`\`\`markdown\n${target}\n\`\`\``);
  });

  describe("a settled Fix", () => {
    const linked = HARNESS.replace("- **Fix:** ralph #155.", "- **Fix:** https://github.com/o/r/issues/481");

    it("survives a draft that still says no issue yet, while the rest of the draft lands", () => {
      const next = reviseEntry(linked, "parked-prs-starve-loops", revised("parked-prs-starve-loops", "Corrected"));
      const body = parseLearnings(next).open[0]?.body as string;
      expect(body).toContain("- **Fix:** https://github.com/o/r/issues/481");
      expect(body).not.toMatch(/no issue yet/i);
      expect(body).toContain("- **Workaround:** end ALL_BLOCKED.");
      expect(parseLearnings(next).open[0]?.title).toBe("Corrected");
    });

    it("survives a draft whose no issue yet carries an explanation", () => {
      const draft = revised("parked-prs-starve-loops", "Corrected").replace(
        "- **Fix:** no issue yet.",
        "- **Fix:** no issue yet. Route parent closure through the claim path.",
      );
      const body = parseLearnings(reviseEntry(linked, "parked-prs-starve-loops", draft)).open[0]?.body as string;
      expect(body).toContain("- **Fix:** https://github.com/o/r/issues/481");
      expect(body).not.toMatch(/no issue yet/i);
    });

    it("is replaced by a draft naming a different value", () => {
      const draft = revised("parked-prs-starve-loops", "Corrected").replace(
        "- **Fix:** no issue yet.",
        "- **Fix:** https://github.com/o/r/issues/482",
      );
      const body = parseLearnings(reviseEntry(linked, "parked-prs-starve-loops", draft)).open[0]?.body as string;
      expect(body).toContain("- **Fix:** https://github.com/o/r/issues/482");
      expect(body).not.toContain("issues/481");
    });

    it("does not apply when the entry itself still says no issue yet", () => {
      const block = revised("ci-timeout-host-load", "Corrected");
      const next = reviseEntry(HARNESS, "ci-timeout-host-load", block);
      expect(next).toBe(HARNESS.replace(parseLearnings(HARNESS).open[1]?.text as string, block));
    });

    it("is carried into the real field and not into a fenced example of one", () => {
      const draft = [
        "### Corrected",
        "<!-- learning: parked-prs-starve-loops -->",
        "- **Seen:** a fresh finding looks like:",
        "",
        "  ```markdown",
        "  - **Fix:** no issue yet.",
        "  ```",
        "",
        "- **Fix:** No issue yet",
      ].join("\n");
      const next = reviseEntry(linked, "parked-prs-starve-loops", draft);
      expect(next).toContain("  ```markdown\n  - **Fix:** no issue yet.\n  ```");
      expect(parseLearnings(next).open[0]?.body).toMatch(/\n- \*\*Fix:\*\* https:\/\/github\.com\/o\/r\/issues\/481$/);
    });
  });

  it("leaves the revised entry findable by the same slug, with the new prose", () => {
    const next = reviseEntry(HARNESS, "parked-prs-starve-loops", revised("parked-prs-starve-loops", "New title (2026-10-12)"));
    expect(findEntry(next, "parked-prs-starve-loops")?.title).toBe("New title (2026-10-12)");
    expect(parseLearnings(next).open).toHaveLength(parseLearnings(HARNESS).open.length);
  });
});

describe("noIssueYet", () => {
  it("reads the placeholder and what the loop wrote after it", () => {
    expect(noIssueYet("no issue yet")).toBe("");
    expect(noIssueYet("No issue yet.")).toBe("");
    expect(noIssueYet("no issue yet. Make it read one line.")).toBe("Make it read one line.");
    expect(noIssueYet("no issue yet — an operator must act")).toBe("an operator must act");
    expect(noIssueYet("no issue yet (the agent needs a restart policy).")).toBe("(the agent needs a restart policy).");
  });

  it("is null for anything that does not lead with it", () => {
    expect(noIssueYet("https://github.com/o/r/issues/1 — no issue yet")).toBeNull();
    expect(noIssueYet("operator side, no issue yet.")).toBeNull();
    expect(noIssueYet("no issue yetis")).toBeNull();
  });
});

describe("closeEntry", () => {
  it("moves the entry into Fixed, stripping a trailing ISO date from the problem", () => {
    const next = closeEntry(HARNESS, "parked-prs-starve-loops", 233);
    const parsed = parseLearnings(next);
    expect(parsed.open.map((one) => one.slug)).toEqual(["ci-timeout-host-load"]);
    expect(next).not.toContain("parked-prs-starve-loops");
    expect(parsed.fixed).toEqual([
      { problem: "Dashboard read the roster from a stale branch", fixedBy: "#190 (#183)" },
      { problem: "Parked PRs starve the loops", fixedBy: "#233" },
    ]);
    expect(next).toContain("## Operator notes");
  });

  it("keeps a parenthesised tail that is not a date", () => {
    const text = addEntry(HARNESS, entry("tool-outage", "The runner is down (opencode)"));
    expect(parseLearnings(closeEntry(text, "tool-outage", 7)).fixed).toContainEqual({
      problem: "The runner is down (opencode)",
      fixedBy: "#7",
    });
  });

  it("escapes a pipe in the title so the table stays valid", () => {
    const text = addEntry(HARNESS, entry("piped", "Gates | and hooks disagree"));
    const next = closeEntry(text, "piped", 9);
    expect(next).toContain("| Gates \\| and hooks disagree | #9 |");
    expect(parseLearnings(next).fixed).toContainEqual({
      problem: "Gates \\| and hooks disagree",
      fixedBy: "#9",
    });
  });

  it("creates the Fixed section after Open and before the next heading", () => {
    const next = closeEntry(LOGGD, "tmdb-fixture-missing", 1890);
    expect(next.indexOf("## Open: fix these")).toBeLessThan(next.indexOf("## Fixed: kept for context"));
    expect(next.indexOf("## Fixed: kept for context")).toBeLessThan(next.indexOf("## Host hygiene"));
    const parsed = parseLearnings(next);
    expect(parsed.hasFixed).toBe(true);
    expect(parsed.open).toEqual([]);
    expect(parsed.fixed).toEqual([{ problem: "A missing TMDB fixture parks PRs", fixedBy: "#1890" }]);
    expect(next).toContain("- **Leaked E2E servers.**");
    expect(next).not.toContain("\n\n\n");
  });

  it("leaves an emptied Open section usable: close the last entry, then add one", () => {
    const emptied = closeEntry(LOGGD, "tmdb-fixture-missing", 1890);
    expect(parseLearnings(emptied).open).toEqual([]);
    const refilled = addEntry(emptied, entry("next-one"));
    expect(parseLearnings(refilled).open.map((one) => one.slug)).toEqual(["next-one"]);
    expect(parseLearnings(refilled).fixed).toHaveLength(1);
    expect(refilled).toContain("## Host hygiene");
    expect(refilled).not.toContain("\n\n\n");
  });

  it("closes the entry itself when an earlier entry quotes its block in a fence", () => {
    const { text, quoted } = quotingHarness();
    const next = closeEntry(text, "ci-timeout-host-load", 42);
    // The real entry left Open for the Fixed table. (The quoting entry parses
    // with a null slug because `slugsIn` counts the comment it quotes too —
    // the format's pre-existing rule, not something these rewrites introduce.)
    expect(parseLearnings(next).open).toHaveLength(1);
    expect(parseLearnings(next).open[0]?.title).toBe("Parked PRs starve the loops (2026-09-30)");
    expect(parseLearnings(next).fixed).toEqual([
      { problem: "Dashboard read the roster from a stale branch", fixedBy: "#190 (#183)" },
      { problem: "CI times out under host load", fixedBy: "#42" },
    ]);
    // ...and the quotation untouched, rather than emptied out of its fence.
    expect(next).toContain(`\`\`\`markdown\n${quoted}\n\`\`\``);
  });

  it("refuses an unknown slug, and an entry that has no slug", () => {
    expect(() => closeEntry(HARNESS, "no-such-slug", 1)).toThrow(
      /no open learning carries the slug 'no-such-slug'/,
    );
    expect(() => closeEntry(LEGACY, "the-test-gate", 1)).toThrow(LearningsError);
  });
});

describe("renderOpen", () => {
  it("returns every entry when they fit, and nothing else", () => {
    const rendered = renderOpen(HARNESS);
    expect(rendered).toContain("### Parked PRs starve the loops (2026-09-30)");
    expect(rendered).toContain("### CI times out under host load");
    expect(rendered).not.toContain("## Fixed");
    expect(rendered).not.toContain("Operator notes");
    expect(rendered).not.toContain("dropped");
  });

  it("keeps the newest whole entries and says how many it dropped", () => {
    const first = parseLearnings(HARNESS).open[0]?.text as string;
    const cap = Buffer.byteLength(first, "utf8") + 8;
    const rendered = renderOpen(HARNESS, { capBytes: cap });
    expect(rendered).toContain("### Parked PRs starve the loops (2026-09-30)");
    expect(rendered).not.toContain("### CI times out under host load");
    expect(cap).toBeLessThan(Buffer.byteLength(renderOpen(HARNESS, { capBytes: 1e9 }), "utf8"));
    expect(rendered).toMatch(/- 1 older entry dropped \(cap [\d.]+ KB\), still open: ci-timeout-host-load\./);
  });

  it("pluralises the drop line", () => {
    const many = ["a", "b", "c", "d"].reduce((text, slug) => addEntry(text, entry(slug)), HARNESS);
    expect(parseLearnings(many).open).toHaveLength(6);
    expect(renderOpen(many, { capBytes: 400 })).toMatch(/- [2-9] older entries dropped \(cap/);
    expect(renderOpen(many, { capBytes: DEFAULT_CAP_BYTES })).not.toContain("dropped");
  });

  it("renders a whole-KB cap without a decimal, and a fractional one with two", () => {
    const many = "abcdefghij"
      .split("")
      .reduce((text, slug) => addEntry(text, entry(`slug-${slug}`)), HARNESS);
    expect(Buffer.byteLength(renderOpen(many, { capBytes: 1e9 }), "utf8")).toBeGreaterThan(1024);
    expect(renderOpen(many, { capBytes: 1024 })).toContain("(cap 1 KB), still open:");
    expect(renderOpen(many, { capBytes: 512 })).toContain("(cap 0.5 KB), still open:");
    expect(renderOpen(many, { capBytes: 300 })).toContain("(cap 0.29 KB), still open:");
  });

  it("keeps a single oversized entry whole rather than returning nothing", () => {
    const rendered = renderOpen(LOGGD, { capBytes: 10 });
    expect(rendered).toContain("### A missing TMDB fixture parks PRs (2026-09-30)");
    expect(rendered).toContain("- **Fix:** #1890.");
    expect(rendered).not.toContain("dropped");
  });

  it("counts the entries after an oversized first one as dropped", () => {
    const rendered = renderOpen(HARNESS, { capBytes: 10 });
    expect(rendered).toContain("### Parked PRs starve the loops (2026-09-30)");
    expect(rendered).not.toContain("### CI times out under host load");
    expect(rendered).toContain("- 1 older entry dropped (cap 0.01 KB), still open: ci-timeout-host-load.");
  });

  it("names every dropped entry, so the cap hides a body but never an entry", () => {
    // §5.7 has a loop retire the entry a merged PR fixed, and it finds that
    // entry here. A bare count would let a file over the cap grow forever: the
    // oldest entries fall out of sight, so nothing closes them.
    const many = "abcdefghij"
      .split("")
      .reduce((text, slug) => addEntry(text, entry(`slug-${slug}`)), HARNESS);
    const rendered = renderOpen(many, { capBytes: 300 });
    const shown = parseLearnings(rendered).open.map((one) => one.slug);
    const all = parseLearnings(many).open.map((one) => one.slug);
    for (const slug of all) {
      expect(shown.includes(slug) || rendered.includes(slug as string)).toBe(true);
    }
    expect(shown.length).toBeLessThan(all.length);
    expect(rendered).toContain("Read the file for their detail.");
  });

  it("falls back to an entry's title when it is too old to carry a slug", () => {
    const legacyWithMore = addEntry(LEGACY, entry("recent-one"));
    const rendered = renderOpen(legacyWithMore, { capBytes: 10 });
    expect(rendered).toContain("still open: The test gate writes into the live loop (2026-09-30).");
  });

  it("returns '' for an empty file and for one with no Open section", () => {
    expect(renderOpen("")).toBe("");
    expect(renderOpen("# Nothing yet\n")).toBe("");
    expect(renderOpen("# Fresh\n\n## Open: fix these\n")).toBe("");
  });
});
