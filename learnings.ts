/**
 * Reading and rewriting one `learnings/*.md` file.
 *
 * A leaf on purpose: no imports, so that both ends of the learnings path can
 * share it without a cycle. `learnings-read.ts` composes it with git to show a
 * loop the open entries at orientation; `publish-journal.ts` composes it with
 * the journal lock to write one. Those two must agree to the character — one
 * decides what an entry looks like, the other has to find it again by slug —
 * and the publisher sits above the journal lock while the reader sits below
 * everything, so neither module is a home for the format.
 *
 * `sectionRange` below is deliberately NOT `sections.ts`'s, which it otherwise
 * resembles. That leaf's header reserves it for ONE job — anchoring a `##`
 * section of a GitHub ISSUE body, for three named callers that must agree to
 * the character — and these are different documents with a different hazard:
 * an issue body is read, a learnings file is rewritten and pushed, so the scan
 * here has to skip code fences and know about `###` entries. Composing them
 * would couple a write path to a read path for ten lines.
 *
 * Every function here takes the file's text and returns text or a value.
 * Nothing reaches for the filesystem, for git, or for the clock: `seenAgain`
 * is handed its date rather than reading one, so a test can pin the output.
 *
 * The format is the one the hand-written files already use (`learnings/`):
 *
 *     ## Open: fix these
 *
 *     ### A red PR on infrastructure needs a rebuild (2026-09-30)
 *     <!-- learning: infra-red-needs-rebuild -->
 *     - **Seen:** …
 *     - **Workaround:** …
 *     - **Fix:** #161
 *
 *     ## Fixed: kept for context
 *
 *     | Problem | Fixed by |
 *     | --- | --- |
 *     | … | #190 |
 *
 * Three things about those files drive the parsing, and all three are load
 * bearing rather than incidental:
 *
 *   - The headings are `## Open: fix these` and `## Fixed: kept for context`,
 *     so they are matched by prefix and rewritten verbatim.
 *   - `learnings/loggd.md` has no Fixed section and DOES have a third section
 *     after Open, so closing an entry there has to create Fixed in the middle
 *     of the file rather than append it at the end.
 *   - The entries that predate the slug comment have no slug. They parse with
 *     `slug: null` instead of failing, and keep working untouched.
 *
 * Two things the format assumes, both enforced rather than hoped for:
 *
 *   - **A heading inside an entry's body must be fenced.** An unfenced `## ` or
 *     `### ` in a body would BE a section or an entry, which is not a quibble:
 *     a draft whose Workaround had a `## Why` subheading used to be accepted,
 *     and it silently pushed every entry below it out of the Open section — so
 *     the loop stopped being shown them, the dashboard under-counted, and the
 *     next `addEntry` would re-add an already-open slug as a duplicate.
 *     `addEntry` refuses that now, and the scanning below skips fenced regions
 *     so a quoted snippet is inert.
 *   - **LF line endings.** A CRLF file survives a round trip but comes back
 *     mixed, and nothing in this repository writes CRLF.
 */

/**
 * The harness-wide file. Not any project's, so no config names it.
 *
 * Here, in the leaf, because three layers need it and the only module all three
 * may import is this one: the loop's reader, the publisher, and — through
 * `dashboard/learnings.ts` — the dashboard adapter, whose own allow-list keeps
 * it away from the other two.
 */
export const HARNESS_FILE = "learnings/harness.md";

/** A slug on its own: what `<!-- learning: … -->` is allowed to carry. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** The slug comment, wherever it sits in an entry. */
const SLUG_COMMENT = /<!--\s*learning:\s*([^\s>]+)\s*-->/g;

/** The `## Open …` heading line. */
const OPEN_HEADING = /^##\s+Open\b.*$/im;

/** The `## Fixed …` heading line. */
const FIXED_HEADING = /^##\s+Fixed\b.*$/im;

/** The heading written when a file has no Fixed section yet. */
const FIXED_HEADING_TEXT = "## Fixed: kept for context";

/** The Fixed table's two header rows. */
const FIXED_TABLE_HEAD = "| Problem | Fixed by |\n| --- | --- |";

/** A trailing ` (2026-09-30)`, the only parenthesised tail a title loses. */
const TRAILING_DATE = /\s*\(\d{4}-\d{2}-\d{2}\)$/;

/** The default `renderOpen` budget: enough for the open list, not the history. */
export const DEFAULT_CAP_BYTES = 8 * 1024;

/** One `### …` entry of the Open section. */
export interface LearningEntry {
  /** From `<!-- learning: <slug> -->`, or null for an entry written before slugs. */
  slug: string | null;
  /** The heading text with `### ` removed, verbatim, trailing date included. */
  title: string;
  /** The whole `### ` line, verbatim. */
  heading: string;
  /** Everything after the heading line, trailing blank lines trimmed. */
  body: string;
  /** The entry as it appears: heading, newline, body. */
  text: string;
  /**
   * Where the entry starts inside its SECTION, not inside the file.
   *
   * Carried so a rewrite can splice at the offset the scan found rather than
   * at `indexOf(entry.text)`: an entry that quotes another entry's block in a
   * fenced example — which a learning about this very format naturally does —
   * has that block's text appearing earlier in the section than the entry
   * itself, and the first match is then inside somebody else's fence.
   */
  at: number;
}

/** One row of the Fixed table. */
export interface FixedRow {
  problem: string;
  fixedBy: string;
}

/** A parsed learnings file. */
export interface Learnings {
  /** The Open entries in file order, newest first. Empty when there is no Open section. */
  open: LearningEntry[];
  /** The Fixed rows in file order, oldest first. */
  fixed: FixedRow[];
  hasOpen: boolean;
  hasFixed: boolean;
}

/** Everything this module refuses, in words an operator can act on. */
export class LearningsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningsError";
  }
}

/** A fence opening or closing: three or more backticks or tildes. */
const FENCE = /^(`{3,}|~{3,})/;

/** One line of a document, with its offset and whether it is inside a code fence. */
interface Line {
  at: number;
  text: string;
  /** True for a fence delimiter and for everything between a pair of them. */
  code: boolean;
}

/**
 * Every line, marked for whether it sits in a code fence.
 *
 * The scanning below goes line by line rather than running `/^## /m` over the
 * whole text precisely so it can skip these: a learning about the prompt or
 * about Markdown itself naturally quotes a `## ` heading, and matching inside
 * that snippet would cut the file in the middle of a fence.
 */
function scan(text: string): Line[] {
  const lines: Line[] = [];
  let at = 0;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opener = FENCE.exec(line.trimStart())?.[1];
    const wasOpen = fence !== null;
    if (fence === null) {
      if (opener !== undefined) fence = opener.slice(0, 3);
    } else if (opener !== undefined && opener.startsWith(fence)) {
      fence = null;
    }
    lines.push({ at, text: line, code: wasOpen || opener !== undefined });
    at += line.length + 1;
  }
  return lines;
}

/** Is this line a heading of `depth` hashes, outside any fence? */
function heading(line: Line, depth: 2 | 3): boolean {
  if (line.code) return false;
  return depth === 2 ? /^##\s+\S/.test(line.text) : /^###[ \t]+\S/.test(line.text);
}

/**
 * The span of the section whose heading `anchor` matches: the heading line, the
 * content just past it, and the start of the next `## ` heading or the end.
 */
function sectionRange(
  text: string,
  anchor: RegExp,
): { start: number; contentStart: number; end: number } | null {
  const lines = scan(text);
  const at = lines.findIndex((line) => !line.code && anchor.test(line.text));
  if (at < 0) return null;
  const start = (lines[at] as Line).at;
  const contentStart = start + (lines[at] as Line).text.length;
  const next = lines.slice(at + 1).find((line) => heading(line, 2));
  return { start, contentStart, end: next === undefined ? text.length : next.at };
}

/** The slugs in one block of text, in order. Separate from parsing so `addEntry` can count them. */
function slugsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SLUG_COMMENT)) found.push(match[1] as string);
  return found;
}

/**
 * The slug an entry body declares, or null when it declares none or several.
 *
 * Exported because the publisher has to read a draft's slug BEFORE it has a
 * file to add it to, and a second hand-rolled copy of this comment's syntax is
 * how the name on disk and the key in the file would come to disagree.
 */
export function slugOf(text: string): string | null {
  const slugs = slugsIn(text);
  return slugs.length === 1 ? (slugs[0] as string) : null;
}

/** Split a section's content into `### ` entries, ignoring fenced headings. */
function entriesIn(section: string): LearningEntry[] {
  const entries: LearningEntry[] = [];
  const starts = scan(section).filter((line) => heading(line, 3));
  for (const [index, start] of starts.entries()) {
    const next = starts[index + 1];
    const end = next === undefined ? section.length : next.at;
    const text = section.slice(start.at, end).replace(/\s+$/, "");
    const body = text.slice(start.text.length).replace(/^\n/, "");
    const slugs = slugsIn(text);
    entries.push({
      slug: slugs.length === 1 && SLUG.test(slugs[0] as string) ? (slugs[0] as string) : null,
      title: start.text.replace(/^###[ \t]+/, "").trim(),
      heading: start.text,
      body,
      text,
      at: start.at,
    });
  }
  return entries;
}

/** The Fixed table's rows, header rows excluded. */
function rowsIn(section: string): FixedRow[] {
  const rows: FixedRow[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
    if (cells.length !== 2) continue;
    const problem = (cells[0] as string).trim();
    const fixedBy = (cells[1] as string).trim();
    if (problem === "Problem" && fixedBy === "Fixed by") continue;
    if (/^-+$/.test(problem) && /^-+$/.test(fixedBy)) continue;
    rows.push({ problem, fixedBy });
  }
  return rows;
}

/** What a learnings file says, without judging it. Never throws. */
export function parseLearnings(text: string): Learnings {
  const open = sectionRange(text, OPEN_HEADING);
  const fixed = sectionRange(text, FIXED_HEADING);
  return {
    open: open === null ? [] : entriesIn(text.slice(open.contentStart, open.end)),
    fixed: fixed === null ? [] : rowsIn(text.slice(fixed.contentStart, fixed.end)),
    hasOpen: open !== null,
    hasFixed: fixed !== null,
  };
}

/** The open entry carrying `slug`, or null. Slug is the only key; titles move. */
export function findEntry(text: string, slug: string): LearningEntry | null {
  return parseLearnings(text).open.find((entry) => entry.slug === slug) ?? null;
}

/** The Open section's span, or the refusal naming the heading that was expected. */
function openOrRefuse(text: string): { start: number; contentStart: number; end: number } {
  const open = sectionRange(text, OPEN_HEADING);
  if (open === null) {
    throw new LearningsError(
      "the learnings file has no '## Open …' section; entries live under one, as in learnings/harness.md",
    );
  }
  return open;
}

/**
 * Replace one entry's span inside its section.
 *
 * The one place the three rewrites below splice, so a fourth cannot get it
 * wrong: the entry is replaced at the offset the scan found it, never at
 * `section.indexOf(entry.text)`. A learning about this very format quotes
 * another entry's block in a fenced example, and that copy comes EARLIER in
 * the section than the entry itself — so a search would rewrite somebody
 * else's example, leave the real entry stale, and (for `closeEntry`) file a
 * Fixed row for an entry that is still open.
 */
function spliceEntry(section: string, entry: LearningEntry, replacement: string): string {
  return `${section.slice(0, entry.at)}${replacement}${section.slice(entry.at + entry.text.length)}`;
}

/** One trailing newline, however the caller's splice left things. */
function oneTrailingNewline(text: string): string {
  return `${text.replace(/\s+$/, "")}\n`;
}

/**
 * The one definition of a well-formed `### ` block, with the slug it carries.
 *
 * Shared by `addEntry` and `reviseEntry` rather than written twice: a block
 * that only one of the two accepts is a file one write shape can produce and
 * the other cannot repair, and the refusal wording is pinned by tests.
 */
function blockOf(entry: string): { block: string; slug: string } {
  const block = entry.replace(/\s+$/, "").replace(/^\n+/, "");
  if (!/^###[ \t]+\S/.test(block)) {
    throw new LearningsError("a learning entry must start with a '### <title>' heading line");
  }
  const slugs = slugsIn(block);
  if (slugs.length === 0) {
    throw new LearningsError(
      "a learning entry must carry a '<!-- learning: <slug> -->' comment so it can be found again",
    );
  }
  if (slugs.length > 1) {
    throw new LearningsError(
      `a learning entry must carry exactly one slug comment; this one has ${slugs.length} (${slugs.join(", ")})`,
    );
  }
  const slug = slugs[0] as string;
  const stray = scan(block).slice(1).find((line) => !line.code && /^#{1,6}[ \t]/.test(line.text));
  if (stray !== undefined) {
    throw new LearningsError(
      `a learning entry must be one '### ' block with no heading inside it; this one has '${stray.text.trim()}'. Fence a quoted heading in a code block, or indent it.`,
    );
  }
  if (!SLUG.test(slug)) {
    throw new LearningsError(
      `'${slug}' is not a usable slug; use lowercase letters, digits and hyphens, up to 61 characters`,
    );
  }
  return { block, slug };
}

/**
 * Add a whole `### …` block to the top of the Open section.
 *
 * Prepending rather than appending is what makes "the newest entries" a
 * property of the file: `renderOpen` keeps whole entries from the top until it
 * runs out of budget, with no dates to parse and nothing to sort.
 *
 * A slug that is already present is a refusal, not an update. The caller is the
 * one that knows whether the right answer is `seenAgain`.
 */
export function addEntry(text: string, entry: string): string {
  const { block, slug } = blockOf(entry);
  const open = openOrRefuse(text);
  if (findEntry(text, slug) !== null) {
    throw new LearningsError(
      `'${slug}' is already an open learning; append a 'Seen again' line to it instead of adding it twice`,
    );
  }
  const rest = text.slice(open.contentStart, open.end).replace(/^\n+/, "");
  const tail = text.slice(open.end);
  const section = rest === "" ? `${block}\n` : `${block}\n\n${rest.replace(/\s+$/, "")}\n`;
  const head = `${text.slice(0, open.contentStart)}\n\n`;
  return tail === "" ? oneTrailingNewline(`${head}${section}`) : `${head}${section}\n${tail.replace(/^\n+/, "")}`;
}

/**
 * Append `- **Seen again:** <date>` to the entry carrying `slug`.
 *
 * The date is passed in rather than read, so the publisher owns the clock and a
 * test can pin the line. Two calls on the same date leave two lines: whether a
 * repeat is worth recording is the caller's call, not this function's.
 */
export function seenAgain(text: string, slug: string, date: string): string {
  const open = openOrRefuse(text);
  const section = text.slice(open.contentStart, open.end);
  const entry = entriesIn(section).find((candidate) => candidate.slug === slug);
  if (entry === undefined) {
    throw new LearningsError(`no open learning carries the slug '${slug}'`);
  }
  const rebuilt = spliceEntry(section, entry, `${entry.text}\n- **Seen again:** ${date}`);
  return `${text.slice(0, open.contentStart)}${rebuilt}${text.slice(open.end)}`;
}

/** A `- **Seen again:** <date>` line, which is ledger rather than prose. */
const SEEN_AGAIN_LINE = /^- \*\*Seen again:\*\*/;

/**
 * The `Seen again` lines of a block, in order, and the block without them.
 *
 * Two things are deliberately NOT ledger, because carrying them means moving
 * them to the end of the entry, and a line that moves changes meaning:
 *
 *   - a line inside a code fence — a learning about this format quotes these
 *     lines in an example, and a quoted example is prose;
 *   - an INDENTED one, which is a child of the list item above it rather than
 *     a sighting of its own. Hence the match on the raw line, not a trimmed
 *     one: `- **Seen again:**` at column zero is the ledger's shape.
 */
function splitLedger(block: string): { prose: string; ledger: string[] } {
  const ledger: string[] = [];
  const prose: string[] = [];
  for (const line of scan(block)) {
    if (!line.code && SEEN_AGAIN_LINE.test(line.text)) ledger.push(line.text);
    else prose.push(line.text);
  }
  return { prose: prose.join("\n").replace(/\s+$/, ""), ledger };
}

/** A `- **Fix:** <value>` field line at column zero; the value is group 1. */
const FIX_LINE = /^- \*\*Fix:\*\*[ \t]*(.*?)[ \t]*$/;

/**
 * The placeholder a finding carries until a ticket is linked, as `pendingFinding`
 * reads it. A prefix, not the whole value: loops almost always write why after
 * it ("no issue yet. Make parseStaffingGroup read…"), and an exact match left
 * every such entry unfiled forever.
 */
const NO_ISSUE_YET = /^no issue yet\b/i;

/**
 * What a Fix value says after `no issue yet`, or null when it does not start
 * with it. Empty when the placeholder stands alone. The separator the loop
 * wrote (`.`, `—`, `:`) is dropped; a parenthesis is kept, being part of the
 * sentence.
 *
 * Here, in the leaf, so the publisher, the findings filer and the dashboard
 * read the same placeholder the same way.
 */
export function noIssueYet(fix: string): string | null {
  const value = fix.trim();
  if (!NO_ISSUE_YET.test(value)) return null;
  return value.replace(NO_ISSUE_YET, "").replace(/^[\s.,;:\u2013\u2014-]+/, "").trim();
}

/**
 * `prose` with its Fix line set to the one in `existing` when the existing one
 * is settled and the draft's is `no issue yet` (see `reviseEntry`). Only real
 * field lines count: a Fix quoted inside a fence is an example, neither read
 * nor rewritten.
 */
function carrySettledFix(prose: string, existing: string): string {
  const settled = scan(existing).find((line) => !line.code && FIX_LINE.test(line.text));
  if (settled === undefined || NO_ISSUE_YET.test(FIX_LINE.exec(settled.text)?.[1] ?? "")) return prose;
  const lines = scan(prose);
  const at = lines.findIndex((line) => !line.code && FIX_LINE.test(line.text));
  if (at < 0 || !NO_ISSUE_YET.test(FIX_LINE.exec(lines[at]?.text ?? "")?.[1] ?? "")) return prose;
  return lines.map((line, index) => (index === at ? settled.text : line.text)).join("\n");
}

/**
 * Replace the whole `### ` block of the entry carrying `slug`, in place.
 *
 * The third thing that happens to an open entry, after `seenAgain` and
 * `closeEntry`: its **Workaround** or **Seen** has gone stale while the problem
 * it describes is still open, so the entry must be corrected without being
 * retired. A remove-and-`addEntry` would move it to the top of the section,
 * which `renderOpen` reads as "newest" — so the span is spliced where it sits,
 * exactly as `seenAgain` splices its line.
 *
 * Two things survive the replacement whatever the draft says:
 *
 *   - **The slug.** The replacement must carry the same one. Revising is how an
 *     entry's prose changes; the slug is the key every other write and every
 *     citation finds it by, so a revise that renamed it would orphan both.
 *   - **The `Seen again` ledger.** Those lines are not prose a corrector wrote,
 *     they are the record of how often the problem recurred, and the caller is
 *     a loop drafting a correction from the shape of the entry it just read. So
 *     the file's lines are carried over and the draft's are dropped, whatever
 *     they say: a draft that omits them does not lose them, one that reproduces
 *     them does not double them, and one that invents a sighting does not file
 *     it — recording a sighting is `seenAgain`'s job, through `--learning` on
 *     the same slug.
 *
 *   - **A settled `Fix`.** When the file's `- **Fix:**` names something other
 *     than `no issue yet` — a ticket a promotion linked — and the draft's says
 *     `no issue yet`, the file's value is kept. `reconcileFindings` drafts its
 *     revise from an origin/main snapshot taken before the publisher's lock, so
 *     a draft can still say `no issue yet` seconds after another process linked
 *     a ticket; written under the lock, that stale prose would put the
 *     placeholder back over the link and `promote` would file a second ticket
 *     (#481/#482). A draft naming a DIFFERENT value still replaces it, and one
 *     with no Fix line is taken as it stands. The consequence: resetting a Fix
 *     to `no issue yet` is a hand edit of the learnings file, not something a
 *     `--revise` can do.
 *
 * A same-slug race resolves last-writer-wins, as it does for `seenAgain`: the
 * publisher's lock serialises writers on one host, and the loser's correction
 * is simply not in the file the winner read.
 */
export function reviseEntry(text: string, slug: string, entry: string): string {
  const { block, slug: replacement } = blockOf(entry);
  if (replacement !== slug) {
    throw new LearningsError(
      `the replacement is slugged '${replacement}' but '${slug}' is the entry being revised; a revise keeps the slug`,
    );
  }
  const open = openOrRefuse(text);
  const section = text.slice(open.contentStart, open.end);
  const existing = entriesIn(section).find((candidate) => candidate.slug === slug);
  if (existing === undefined) {
    throw new LearningsError(`no open learning carries the slug '${slug}'`);
  }
  const { ledger } = splitLedger(existing.text);
  const prose = carrySettledFix(splitLedger(block).prose, existing.text);
  // A blank line when the correction ends in a fence, so the carried lines read
  // as a list rather than as the fence's next neighbour.
  const gap = FENCE.test((prose.split("\n").at(-1) ?? "").trim()) ? "\n\n" : "\n";
  const kept = ledger.length === 0 ? prose : `${prose}${gap}${ledger.join("\n")}`;
  const rebuilt = spliceEntry(section, existing, kept);
  return `${text.slice(0, open.contentStart)}${rebuilt}${text.slice(open.end)}`;
}

/** `|` inside a title would end the cell early. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * Move the entry carrying `slug` out of Open and into the Fixed table as one
 * row, `| <problem> | #<pr> |`.
 *
 * When the file has no Fixed section — `learnings/loggd.md` does not — it is
 * created directly after Open and BEFORE whatever section follows, never
 * appended at the end of the file, where it would land under an unrelated
 * heading.
 */
export function closeEntry(text: string, slug: string, pr: number): string {
  const open = openOrRefuse(text);
  const section = text.slice(open.contentStart, open.end);
  const entry = entriesIn(section).find((candidate) => candidate.slug === slug);
  if (entry === undefined) {
    throw new LearningsError(`no open learning carries the slug '${slug}'`);
  }
  const remaining = spliceEntry(section, entry, "")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  const trimmed = remaining === "" ? "\n\n" : `\n\n${remaining}\n\n`;
  const withoutEntry = `${text.slice(0, open.contentStart)}${trimmed}${text.slice(open.end).replace(/^\n+/, "")}`;
  const row = `| ${escapeCell(entry.title.replace(TRAILING_DATE, ""))} | #${pr} |`;

  const fixed = sectionRange(withoutEntry, FIXED_HEADING);
  if (fixed === null) {
    const reopened = openOrRefuse(withoutEntry);
    const head = withoutEntry.slice(0, reopened.end).replace(/\s+$/, "");
    const tail = withoutEntry.slice(reopened.end).replace(/^\n+/, "");
    const block = `${FIXED_HEADING_TEXT}\n\n${FIXED_TABLE_HEAD}\n${row}`;
    return tail === ""
      ? oneTrailingNewline(`${head}\n\n${block}`)
      : `${head}\n\n${block}\n\n${tail}`;
  }
  const body = withoutEntry.slice(fixed.contentStart, fixed.end);
  const table = body.replace(/\s+$/, "") === "" ? `${FIXED_TABLE_HEAD}\n${row}` : `${body.replace(/\s+$/, "")}\n${row}`;
  const tail = withoutEntry.slice(fixed.end).replace(/^\n+/, "");
  const rebuilt = `${withoutEntry.slice(0, fixed.contentStart)}\n\n${table}`;
  return tail === "" ? oneTrailingNewline(rebuilt) : `${rebuilt}\n\n${tail}`;
}

/** `8` rather than `8.0`; `0.5` when someone caps in halves. */
function kb(capBytes: number): string {
  const value = capBytes / 1024;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * The open entries a loop should read, capped.
 *
 * Whole entries only, from the top, until the budget runs out — a half-quoted
 * workaround is worse than a missing one. A single oversized entry is still
 * kept: one is better than none.
 *
 * What was left out is NAMED, not just counted. The cap must never hide that an
 * entry exists, only its detail: §5.7 of the prompt tells a loop to retire the
 * entry a merged PR fixed, and it finds that entry in this output. A bare count
 * would make a file over the cap grow forever — the oldest entries drop out of
 * sight, so nothing closes them, so the file grows and drops more.
 */
export function renderOpen(text: string, options: { capBytes?: number } = {}): string {
  const capBytes = options.capBytes ?? DEFAULT_CAP_BYTES;
  const entries = parseLearnings(text).open;
  if (entries.length === 0) return "";

  const kept: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const cost = Buffer.byteLength(entry.text, "utf8") + (kept.length === 0 ? 0 : 2);
    if (kept.length > 0 && used + cost > capBytes) break;
    kept.push(entry.text);
    used += cost;
  }
  const dropped = entries.slice(kept.length);
  const body = kept.join("\n\n");
  if (dropped.length === 0) return body;
  const noun = dropped.length === 1 ? "entry" : "entries";
  const named = dropped.map((entry) => entry.slug ?? entry.title).join(", ");
  return `${body}\n\n- ${dropped.length} older ${noun} dropped (cap ${kb(capBytes)} KB), still open: ${named}. Read the file for their detail.`;
}

/** The labelled lines an entry is written as, by the name the README gives them. */
export interface EntryFields {
  seen: string | null;
  workaround: string | null;
  fix: string | null;
  change: string | null;
  verify: string | null;
  /** Every `Seen again` date (or whatever the line says), in file order. */
  seenAgain: string[];
}

const FIELD_LINE = /^- \*\*(Seen again|Seen|Workaround|Fix|Change|Verify):\*\*[ \t]*(.*)$/;
const FIELD_KEY = { Seen: "seen", Workaround: "workaround", Fix: "fix", Change: "change", Verify: "verify" } as const;

/**
 * An entry's labelled fields, for a reader that shows them rather than files
 * them — the dashboard. Lenient where `findingFields` is strict: a duplicated
 * field keeps its first value instead of refusing, since a panel that went
 * blank over a hand-edited entry would hide the other twenty.
 *
 * A field's wrapped continuation lines (the older entries hard-wrap at 80
 * columns) join it with a space. Fenced lines are skipped, so a quoted example
 * of a field is never read as one; any other `- ` line ends the field.
 */
export function entryFields(entry: LearningEntry): EntryFields {
  const fields: EntryFields = { seen: null, workaround: null, fix: null, change: null, verify: null, seenAgain: [] };
  let open: keyof typeof FIELD_KEY | null = null;
  for (const line of scan(entry.body)) {
    if (line.code) { open = null; continue; }
    const match = FIELD_LINE.exec(line.text);
    if (match !== null) {
      const [, label, value] = match as unknown as [string, keyof typeof FIELD_KEY | "Seen again", string];
      if (label === "Seen again") { fields.seenAgain.push(value.trim()); open = null; continue; }
      open = fields[FIELD_KEY[label]] === null ? label : null;
      if (open !== null) fields[FIELD_KEY[open]] = value.trim();
      continue;
    }
    const text = line.text.trim();
    if (open === null || text === "" || text.startsWith("- ") || text.startsWith("<!--")) { open = null; continue; }
    fields[FIELD_KEY[open]] = `${fields[FIELD_KEY[open]]} ${text}`.trim();
  }
  return fields;
}

/** An entry title's trailing ISO date, and the title without it. */
export function titleDate(title: string): { title: string; date: string | null } {
  const match = /\((\d{4}-\d{2}-\d{2})\)$/.exec(title.trim());
  return match === null ? { title: title.trim(), date: null } : { title: title.trim().replace(TRAILING_DATE, ""), date: match[1]! };
}
