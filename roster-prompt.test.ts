// @vitest-environment node
/**
 * The "Who you are" block is generated from the roster, and its four-coder form
 * is the hand-written text `prompt.md` carried until #134 — byte for byte, so
 * that the loops whose prompt this is saw no change on the day it moved.
 */
import { describe, expect, it } from "vitest";

import type { RosterEntry } from "./project-config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROVENANCE_LEAD_IN,
  rosterBlock,
  rosterBranchGlobs,
  rosterCapitals,
  rosterHeadBranches,
  rosterProvenance,
} from "./roster-prompt";

const coders = (...names: string[]): RosterEntry[] => names.map((name) => ({ name, role: "coder" }));

/** `prompt.md` L15–30 as it read before this module existed. */
const FOUR_CODERS = `Four loops work this backlog — **ralph**, **rafa**, **remo** and **rulo** — each from
a worktree of its own. \`ralph.sh\` exports **\`$RALPH_LOOP_NAME\`** with the name
of the one you belong to — read it from the environment at the start of the
iteration and use it everywhere the loop signs its work:

| Where          | Form                       | Example (\`rafa\`)     |
| -------------- | -------------------------- | -------------------- |
| Claim label    | \`$RALPH_LOOP_NAME-wip\`     | \`rafa-wip\`           |
| Stuck label    | \`$RALPH_LOOP_NAME-blocked\` | \`rafa-blocked\`       |
| Merged label   | \`$RALPH_LOOP_NAME-done\`    | \`rafa-done\`          |
| Branch prefix  | \`$RALPH_LOOP_NAME/<n>-…\`   | \`rafa/612-dup-rows\`  |
| PR provenance  | see §5.3                   | \`🤖 Rafa loop — run …\` |

This is how the project's operator tells from the issue list alone which loop
is on what, so never hardcode \`ralph-…\` when you are rafa, remo or rulo, and never
invent a fifth name. If \`$RALPH_LOOP_NAME\` is unset you are \`ralph\`.`;

describe("the roster block", () => {
  it("reproduces the hand-written four-loop text exactly", () => {
    expect(rosterBlock(coders("ralph", "rafa", "remo", "rulo"))).toBe(FOUR_CODERS);
  });

  // Only of this block: §1 and §5.3's lists DO name a joining triager (#197,
  // further down this file). The promise is about who a coder's peers are at
  // taking tickets, not about every line of its prompt.
  it("lists the coders only, so a triager joining changes no coder's PEERS", () => {
    const mixed: RosterEntry[] = [
      { name: "ralph", role: "coder" },
      { name: "tria", role: "triager" },
      { name: "rafa", role: "coder" },
      { name: "remo", role: "coder" },
      { name: "doc", role: "ci-doctor" },
      { name: "rulo", role: "coder" },
    ];
    expect(rosterBlock(mixed)).toBe(FOUR_CODERS);
  });

  it("reads as English for the single-coder roster this repository itself runs", () => {
    const block = rosterBlock(coders("ralph"));
    expect(block).toContain("One loop works this backlog — **ralph** — from");
    // The only coder is its own worked example, and there is nobody to be
    // "when you are": that clause has to go rather than render empty.
    expect(block).toContain("| Claim label    | `$RALPH_LOOP_NAME-wip`     | `ralph-wip`          |");
    expect(block).not.toContain("when you are");
    expect(block).toContain("invent a second name. If `$RALPH_LOOP_NAME` is unset you are `ralph`.");
  });

  it("names the second coder as the worked example", () => {
    const block = rosterBlock(coders("ralph", "rafa"));
    expect(block).toContain("Two loops work this backlog — **ralph** and **rafa** — each from");
    expect(block).toContain("Example (`rafa`)");
    expect(block).toContain("`🤖 Rafa loop — run …`");
    expect(block).toContain("so never hardcode `ralph-…` when you are rafa, and never");
    expect(block).toContain("invent a third name.");
  });

  it("counts past the words it spells out", () => {
    const many = rosterBlock(coders(...Array.from({ length: 13 }, (_, at) => `l${at}`)));
    expect(many).toContain("13 loops work this backlog");
    expect(many).toContain("invent a 14th name.");
  });

  it("names no loop at all for a roster with no coder", () => {
    // A triager-only roster is valid config, and the coder prompt is not its
    // prompt — but this must not fill the gap with a plausible name. A block
    // that says `ralph-wip` to a project with no `ralph` teaches the claim
    // fence off a roster that does not exist, which is the failure the module
    // exists to prevent.
    const block = rosterBlock([{ name: "tria", role: "triager" }]);
    expect(block).toContain("No loop on this project's roster holds the coder role");
    // `ralph.sh` is the script's name, not a loop's — the needles are the
    // forms a loop name takes in this block.
    for (const invented of ["undefined", "**ralph**", "ralph-wip", "`rafa`", "**tria**", "Zero loops", "invent a"]) {
      expect(block, `the no-coder block names ${invented}`).not.toContain(invented);
    }
    // It still tells the reader where its own name comes from.
    expect(block).toContain("$RALPH_LOOP_NAME-wip");
  });
});

/**
 * §1's `git ls-remote` globs and §5.3's three lists. `prompt.md` spelled all
 * four of them with the same four names until #197, so the four-loop forms are
 * pinned byte for byte here — the rendered prompt may not move for the project
 * whose prompt this text was written as.
 */
describe("the loop lists outside the roster block", () => {
  const FOUR = coders("ralph", "rafa", "remo", "rulo");

  it("reproduces §1's hand-written `git ls-remote` globs", () => {
    expect(rosterBranchGlobs(FOUR)).toBe('"ralph/<n>-*" "rafa/<n>-*" "remo/<n>-*" "rulo/<n>-*"');
  });

  it("reproduces §5.3's hand-written provenance lines, break included", () => {
    // The break falls inside the second item because `prompt.md` has already
    // spent 19 columns on `the matching line (` — that is what the offset in
    // `rosterProvenance` buys, and losing it would reflow the paragraph.
    expect(rosterProvenance(FOUR)).toBe(
      "`🤖 Ralph loop — run …` for ralph, `🤖 Rafa loop — run …`\n" +
        "for rafa, `🤖 Remo loop — run …` for remo, `🤖 Rulo loop — run …` for rulo",
    );
  });

  it("reproduces §5.3's hand-written head-branch globs", () => {
    expect(rosterHeadBranches(FOUR)).toBe("`ralph/*`, `rafa/*`, `remo/*` or `rulo/*`");
  });

  it("adds the `Rulo` §5.3's capitalisation example was missing", () => {
    // The one line this ticket deliberately changes for a four-loop roster: the
    // hand-written example read "`Ralph`, `Rafa` or `Remo`" and the prompt then
    // told `rulo` to capitalise a name the example did not cover.
    expect(rosterCapitals(FOUR)).toBe("`Ralph`, `Rafa`, `Remo` or `Rulo`");
  });

  it("reads as English for the one-loop roster this repository itself ran", () => {
    const one = coders("solo");
    expect(rosterBranchGlobs(one)).toBe('"solo/<n>-*"');
    expect(rosterProvenance(one)).toBe("`🤖 Solo loop — run …` for solo");
    expect(rosterHeadBranches(one)).toBe("`solo/*`");
    expect(rosterCapitals(one)).toBe("`Solo`");
    // No series conjunction and no second line to wrap onto.
    for (const list of [rosterProvenance(one), rosterHeadBranches(one), rosterCapitals(one)]) {
      expect(list).not.toContain(" or ");
      expect(list).not.toContain("\n");
    }
  });

  it("names a triager too, unlike the roster block", () => {
    // These lists are about whose work a reader may MEET, not who its peers are
    // at taking coder tickets: a triager's branch, its `-wip` and its provenance
    // line are all things a coder has to recognise as not its own. So `tria`
    // appears here while `rosterBlock` leaves it out.
    const mixed: RosterEntry[] = [
      { name: "ralph", role: "coder" },
      { name: "tria", role: "triager" },
      { name: "doc", role: "ci-doctor" },
      { name: "rafa", role: "coder" },
    ];
    expect(rosterBranchGlobs(mixed)).toBe('"ralph/<n>-*" "tria/<n>-*" "doc/<n>-*" "rafa/<n>-*"');
    expect(rosterHeadBranches(mixed)).toBe("`ralph/*`, `tria/*`, `doc/*` or `rafa/*`");
    expect(rosterCapitals(mixed)).toBe("`Ralph`, `Tria`, `Doc` or `Rafa`");
    // Wrapped, so the needle is checked against the flattened series; where the
    // lines break is pinned by the four-loop case above and the width case below.
    const flat = rosterProvenance(mixed).replace(/\n/g, " ");
    expect(flat).toContain("`🤖 Tria loop — run …` for tria");
    expect(flat).toContain("`🤖 Doc loop — run …` for doc");
    // Roster order is kept rather than coders first — pinned by the literals
    // above, which interleave `tria` and `doc` between the two coders.
    // The block above them, meanwhile, still leaves the triager out.
    expect(rosterBlock(mixed)).not.toContain("tria");
  });

  it("wraps the provenance series rather than running one long line", () => {
    const six = coders("ralph", "rafa", "remo", "rulo", "testo", "tango");
    const lines = rosterProvenance(six).split("\n");
    expect(lines.length).toBeGreaterThan(2);
    // Every line of the VALUE fits `prompt.md`'s width — the first one allowing
    // for the prose the template puts before the placeholder. The prose AFTER
    // the placeholder is not budgeted, so the last RENDERED line runs over;
    // that is `rosterProvenance`'s documented choice, and AC 4 of #197 requires
    // it. `"🤖".length === 2`, so `String.length` measures what the reader sees.
    expect(lines[0]!.length + "the matching line (".length).toBeLessThanOrEqual(79);
    for (const line of lines.slice(1)) expect(line.length).toBeLessThanOrEqual(79);
    // Wrapping never breaks a code span across lines.
    for (const line of lines) expect(line.split("`").length % 2).toBe(1);
  });

  it("refuses an empty roster rather than rendering an empty list", () => {
    // `project-config.ts` refuses a config whose `loops` is empty ("'loops'
    // must name at least one loop"), so no render reaches this. It throws
    // anyway because of what `""` would render INTO: §1's line becomes
    // `git ls-remote --heads origin` with no pattern, which lists every head on
    // the remote, and §5.3 reads `A  head branch is NOT` and `capitalised — .`.
    // Returning the empty string here would pin that as the behaviour.
    for (const render of [rosterBranchGlobs, rosterProvenance, rosterHeadBranches, rosterCapitals]) {
      expect(() => render([]), `${render.name} rendered something for an empty roster`).toThrow(
        /at least one loop/,
      );
    }
  });

  it("counts the lead-in `prompt.md` actually has before the placeholder", () => {
    // `PROVENANCE_OFFSET` is how many columns of the provenance list's first
    // line the template has already spent. It is a literal, so rewording §5.3's
    // lead-in would leave the wrap budget wrong with every other test green.
    const prompt = readFileSync(join(__dirname, "prompt.md"), "utf8");
    const line = prompt.split("\n").find((at) => at.includes("{{RALPH_ROSTER_PROVENANCE}}"));
    expect(line, "prompt.md no longer places {{RALPH_ROSTER_PROVENANCE}}").toBeDefined();
    expect(line!.slice(0, line!.indexOf("{{"))).toBe(PROVENANCE_LEAD_IN);
  });
});
