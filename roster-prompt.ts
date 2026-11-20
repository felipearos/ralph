/**
 * The roster-derived text of the iteration prompt: its "Who you are" section,
 * and the four loop lists §1 and §5.3 carry (further down this file).
 *
 * `prompt.md` used to name four loops in prose — "Four loops work this backlog
 * — **ralph**, **rafa**, **remo** and **rulo**" — with a worked example table
 * keyed to one of them. That is the project's roster written twice: this
 * repository's own roster is a single `ralph`, and loggd's may gain or lose a
 * loop any day, so the prose was already a lie on one project and one edit away
 * from being one on the other. A prompt that misnames the loops undermines the
 * very fence it is teaching, because the reader cannot tell which of the two
 * lists is the real one.
 *
 * So the block is generated from `loops` in the project's `.ralph/config.json`
 * and spliced in as `{{RALPH_ROSTER}}`.
 *
 * **Only the coders are listed in THAT block.** A triager or a doctor joining
 * the roster must not change who a coder reads as its peers at taking tickets —
 * the roles foundation's promise, pinned by `roster-prompt.test.ts` — and it
 * costs the reader nothing, because the paragraph that follows in `prompt.md`
 * covers every other role without naming any of them: "any `*-wip` or
 * `*-blocked` label means somebody already has that ticket, whoever it is".
 *
 * The four lists below are the other way round: they name EVERY roster entry
 * whatever its role, so a joining triager DOES change those four lists in a
 * coder's prompt and nothing else (#197, fenced by `prompt-render.test.ts`).
 * The promise above is therefore about this block, not about the whole prompt —
 * read the block at `rosterBranchGlobs` for why.
 *
 * Line breaks and table widths are LITERALS here rather than a reflow, so a
 * four-coder roster reproduces the hand-written original byte for byte
 * (`roster-prompt.test.ts`). A longer roster gets a long first line; the block
 * is markdown, so that is cosmetic.
 *
 * Imports one type and nothing else: it renders text, it does not read the
 * roster.
 */
import type { RosterEntry } from "./project-config";

/**
 * `ORDINALS` runs one further than `CARDINALS` on purpose: the count is always
 * asked for as a cardinal and the "never invent a …" clause always as the
 * ordinal of count + 1, so the two lists stop at the same roster size. Extend
 * them together.
 */
const CARDINALS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

const ORDINALS = [
  "zeroth",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
];

/** `4` → `Four`; past the words this file carries, the digits. */
const cardinal = (n: number): string => CARDINALS[n] ?? String(n);

/** `5` → `fifth`; past the words this file carries, `14th` and up. */
const ordinal = (n: number): string => ORDINALS[n] ?? `${n}th`;

/** `['a','b','c']` → `a, b and c`, with `and` replaceable by `or`. */
function series(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

const capitalise = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The example table's three columns, at the widths the hand-written original
 * used. A cell wider than its column is emitted unpadded, exactly as the
 * provenance row always was — and note `"🤖".length === 2`, so that row
 * measures wider than it reads and never pads.
 */
const COLUMNS = [14, 26, 20] as const;

const row = (cells: readonly [string, string, string]): string =>
  `| ${cells.map((cell, at) => cell.padEnd(COLUMNS[at]!)).join(" | ")} |`;

/**
 * The body of `prompt.md`'s "## Who you are" section for `roster`, without a
 * trailing newline.
 */
export function rosterBlock(roster: readonly RosterEntry[]): string {
  const coders = roster.filter((entry) => entry.role === "coder").map((entry) => entry.name);
  // A coder's own render cannot reach the no-coder case — a loop that renders
  // this prompt is a coder, so its roster holds at least one. A roster is
  // config, though, and a triager-only one is valid, so this has to say
  // something true rather than fall back on names: the fallbacks below would
  // otherwise teach the claim fence off a `ralph` and a `rafa` the project does
  // not run, which is the exact failure this module exists to stop.
  if (coders.length === 0) {
    return [
      "No loop on this project's roster holds the coder role, so there is no",
      "worked example to show you. `ralph.sh` exports",
      "**`$RALPH_LOOP_NAME`** with the name of the loop you belong to — read it",
      "from the environment at the start of the iteration and use it everywhere",
      "the loop signs its work: `$RALPH_LOOP_NAME-wip` to claim,",
      "`$RALPH_LOOP_NAME-blocked` when stuck, `$RALPH_LOOP_NAME-done` once",
      "merged, and `$RALPH_LOOP_NAME/<n>-…` for the branch.",
    ].join("\n");
  }

  // The worked example is the SECOND coder wherever there is one: the reader is
  // most often the first, and an example that spells their own name back at
  // them is the one way this table fails to make its point.
  const example = coders[1] ?? coders[0]!;
  const first = coders[0]!;
  const rest = coders.slice(1);

  const opening = coders.length === 1
      ? `${cardinal(1)} loop works this backlog — **${first}** — from`
      : `${cardinal(coders.length)} loops work this backlog — ${series(coders.map((name) => `**${name}**`), "and")} — each from`;

  // With one coder there is no "when you are …" clause to write: an empty
  // series would leave the sentence reading "when you are , and never".
  const hardcode = rest.length > 0
    ? `is on what, so never hardcode \`${first}-…\` when you are ${series(rest, "or")}, and never`
    : `is on what, so never hardcode \`${first}-…\` for another loop's name, and never`;

  return [
    `${opening}`,
    "a worktree of its own. `ralph.sh` exports **`$RALPH_LOOP_NAME`** with the name",
    "of the one you belong to — read it from the environment at the start of the",
    "iteration and use it everywhere the loop signs its work:",
    "",
    row(["Where", "Form", `Example (\`${example}\`)`]),
    `| ${COLUMNS.map((width) => "-".repeat(width)).join(" | ")} |`,
    row(["Claim label", "`$RALPH_LOOP_NAME-wip`", `\`${example}-wip\``]),
    row(["Stuck label", "`$RALPH_LOOP_NAME-blocked`", `\`${example}-blocked\``]),
    row(["Merged label", "`$RALPH_LOOP_NAME-done`", `\`${example}-done\``]),
    row(["Branch prefix", "`$RALPH_LOOP_NAME/<n>-…`", `\`${example}/612-dup-rows\``]),
    row(["PR provenance", "see §5.3", `\`🤖 ${capitalise(example)} loop — run …\``]),
    "",
    "This is how the project's operator tells from the issue list alone which loop",
    hardcode,
    `invent a ${ordinal(coders.length + 1)} name. If \`$RALPH_LOOP_NAME\` is unset you are \`${first}\`.`,
  ].join("\n");
}

/*
 * A preamble to the four functions below rather than any one function's doc.
 *
 * They render the three `prompt.md` passages OUTSIDE "Who you are" that also
 * named the four loops by hand — four lists in all, since §5.3 carries three:
 * §1 priority 2's `git ls-remote` globs, then §5.3's provenance lines, head
 * branch globs and `<Loop>` capitalisation example. #134 generated the "Who you
 * are" block and left these, so the rendered prompt contradicted itself on any
 * roster that was not exactly `ralph, rafa, remo, rulo` — it told a one-loop
 * project's only loop to go looking for `rafa/`, `remo/` and `rulo/` branches
 * that cannot exist, and told loggd's `testo` that a `testo/*` branch is not one
 * of the prefixes "parallel agents share".
 *
 * **These four list EVERY roster entry, whatever its role** — which is the one
 * way they differ from `rosterBlock` above, and it is deliberate. That block
 * teaches the reader which loops are their PEERS at taking coder tickets, so a
 * triager joining must not change it. These lists answer a different question:
 * whose work may I run into? A triager's branch, its `-wip` and its provenance
 * line are all things a coder meets while deciding what is not its to touch.
 */

/**
 * Refuses an empty roster, loudly, rather than rendering an empty list.
 *
 * `project-config.ts` already refuses a config whose `loops` is empty ("'loops'
 * must name at least one loop"), so no project reaches these functions without
 * a name. The guard is here because of what an empty list renders INTO: §1's
 * line would become `git ls-remote --heads origin` with no pattern, which lists
 * every head on the remote and so tells the loop that an arbitrary branch is
 * "the unfinished work" — and §5.3 would read `A  head branch is NOT …` and
 * `capitalised — .`. A render that cannot say anything true should fail where a
 * human sees it, which is this module's whole argument.
 */
function requireLoops(roster: readonly RosterEntry[]): readonly RosterEntry[] {
  if (roster.length === 0) {
    throw new Error(
      "the prompt's loop lists need a roster: 'loops' must name at least one loop.",
    );
  }
  return roster;
}

/** The ref globs §1 hands `git ls-remote`, for every loop on the roster. */
export function rosterBranchGlobs(roster: readonly RosterEntry[]): string {
  return requireLoops(roster).map((entry) => `"${entry.name}/<n>-*"`).join(" ");
}

/** The head-branch globs §5.3 calls "a naming convention parallel agents share". */
export function rosterHeadBranches(roster: readonly RosterEntry[]): string {
  return series(requireLoops(roster).map((entry) => `\`${entry.name}/*\``), "or");
}

/** §5.3's `<Loop>` capitalisation example. `Rulo` was missing from it by hand. */
export function rosterCapitals(roster: readonly RosterEntry[]): string {
  return series(requireLoops(roster).map((entry) => `\`${capitalise(entry.name)}\``), "or");
}

/**
 * How wide a line of `prompt.md` is, and how much of the provenance list's first
 * line the template has already spent on `the matching line (`.
 *
 * Both are LITERALS, for the same reason `rosterBlock`'s table widths are: the
 * four-loop roster has to reproduce the hand-written original byte for byte, and
 * the original's break falls inside its second item. Note `"🤖".length === 2`,
 * so `String.length` here already measures what the reader sees.
 */
const PROMPT_WIDTH = 79;
/**
 * Exported so `roster-prompt.test.ts` can check it against `prompt.md` itself:
 * the lead-in is a literal here, and rewording §5.3's "the matching line ("
 * would otherwise leave the budget silently wrong with every test still green.
 */
export const PROVENANCE_LEAD_IN = "the matching line (";
const PROVENANCE_OFFSET = PROVENANCE_LEAD_IN.length;

/**
 * The wrappable units of a provenance series: a whole `` `code span` `` is one
 * unit, everything else is a word.
 *
 * Breaking inside a span would put `` `🤖 Testo loop — run `` at the end of one
 * line and `` …` for testo `` at the start of the next. A reader has to
 * recognise that string in a PR body, so it may not be the one thing the prompt
 * shows them in two halves — and the hand-written four-loop text never did,
 * because its own break fell between a span and the `for <name>` after it.
 */
function atoms(text: string): string[] {
  const units: string[] = [];
  for (const word of text.split(" ")) {
    const open = units.length > 0 && (units[units.length - 1]!.split("`").length - 1) % 2 === 1;
    if (open) units[units.length - 1] += ` ${word}`;
    else units.push(word);
  }
  return units;
}

/**
 * §5.3's provenance series — `` `🤖 Rafa loop — run …` for rafa `` per loop —
 * wrapped, with no trailing newline.
 *
 * Wrapped rather than emitted on one line because the placeholder sits mid
 * sentence: the template reads `the matching line ({{…}}). Ownership is …`, so
 * the value's first line starts 19 columns in and its last line continues into
 * prose the template owns.
 *
 * Only the 19 columns BEFORE it are budgeted, and the 30 after it are not, so
 * the last rendered line runs over `PROMPT_WIDTH`. That is deliberate rather
 * than overlooked: the hand-written four-loop text ran to 104 columns on that
 * very line, and AC 4 of #197 is that its bytes do not move. The overrun is
 * cosmetic — this is markdown prose, and `prompt.md` has dozens of longer
 * lines.
 */
export function rosterProvenance(roster: readonly RosterEntry[]): string {
  const text = requireLoops(roster)
    .map((entry) => `\`🤖 ${capitalise(entry.name)} loop — run …\` for ${entry.name}`)
    .join(", ");
  const lines: string[] = [];
  let line = "";
  let budget = PROMPT_WIDTH - PROVENANCE_OFFSET;
  for (const word of atoms(text)) {
    if (line === "") {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= budget) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
    budget = PROMPT_WIDTH;
  }
  lines.push(line);
  return lines.join("\n");
}
