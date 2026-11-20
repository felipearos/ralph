/**
 * The learnings panel's derivations (#201).
 *
 * The panel answers three questions about the list of things the loops already
 * know: how long is it, which entries keep biting, and which of them is
 * anybody fixing. Loops write these files through the journal publisher and
 * nothing here can edit them, so what matters is reading each entry's shape
 * honestly — and that lives in this file. `.tsx` has no tests, so every
 * decision the panel makes is here.
 */
import type { Dashboard, LearningEntryView, LearningFiledView, LearningFixedView, LearningsSourceView } from "../contracts";

export type LearningScope = "project" | "harness";

/**
 * Where an entry's fix stands, as the panel's chip says it.
 *
 *   - `ticket`: the Fix names an issue. Linked when it is a URL; a bare `#n`
 *     is shown unlinked, since the file does not say whose repository it is.
 *   - `duplicate`: the Fix says this entry is a copy of another.
 *   - `queued`: the Fix still reads `no issue yet`, which the findings filer
 *     turns into a ticket at the next publish or reconciliation.
 *   - `operator`: no ticket, and the Fix names a person's job (an operator, a
 *     human, something done by hand) — not something a ticket would fix.
 *   - `none`: anything else, including no Fix line at all.
 */
export type FixStatus =
  | { kind: "ticket"; label: string; href: string | null }
  | { kind: "duplicate" }
  | { kind: "queued" }
  | { kind: "operator" }
  | { kind: "none" };

/** One open entry as the panel draws it. */
export interface LearningItem {
  /** Unique across both files, for React and for the open/closed state. */
  key: string;
  /** The entry's `<!-- learning: … -->` slug, or null for an entry written before slugs. */
  slug: string | null;
  scope: LearningScope;
  /** The entry's position in its file: newest first, as the publisher writes them. */
  order: number;
  title: string;
  date: string | null;
  /** Whole days from `date` to the snapshot, or null when undated. */
  ageDays: number | null;
  /** Every sighting: the first, plus each `Seen again`. */
  seenCount: number;
  /** The latest `Seen again`, or null when it was only seen once. */
  lastSeen: string | null;
  /** Seen four times or more: the only count the panel colours. */
  hot: boolean;
  fix: FixStatus;
  /** Change and Verify are both written, so the filer marks its ticket ready-for-agent. */
  readyForCoder: boolean;
  /**
   * The harness can file this entry now: it has a slug, the Seen and
   * Workaround a ticket is written from, and no ticket or duplicate already.
   */
  fileable: boolean;
  seen: string | null;
  workaround: string | null;
  fixText: string | null;
  change: string | null;
  verify: string | null;
  /** The entry in the file on GitHub, or null when the remote is not on GitHub. */
  href: string | null;
}

/** One file's row on the panel. */
export interface LearningsRow {
  scope: LearningScope;
  file: string;
  /** How many entries are open. Zero for a file that is absent. */
  count: number;
  items: LearningItem[];
  fixed: readonly LearningFixedView[];
  /** Where to read the file, or null when the harness remote is not on GitHub. */
  href: string | null;
  /**
   * True when the file is not on the harness's `origin/main` at all. Said
   * apart from `count: 0`, because "nothing learned yet" and "the list is
   * clear" look identical as a number and mean different things — the second
   * is an achievement, the first is a project nobody has written about.
   */
  absent: boolean;
}

export interface LearningsPanelView {
  rows: LearningsRow[];
  /** Both files' open entries added up: the number the panel leads with. */
  total: number;
}

/** A Fix that names a person's job rather than a code change. */
const OPERATOR = /\b(operator|human|person|by hand)\b/i;

/** A GitHub issue or pull request URL anywhere in the Fix. */
const ISSUE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)/;

/** A Fix that leads with `#123` or `owner/repo#123`. */
const ISSUE_REF = /^(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/;

/** Where an entry's fix stands; see `FixStatus`. */
export function fixStatus(entry: Pick<LearningEntryView, "fix" | "fixPending">): FixStatus {
  const fix = entry.fix?.trim() ?? "";
  if (fix === "") return { kind: "none" };
  if (/^duplicate\b/i.test(fix)) return { kind: "duplicate" };
  if (entry.fixPending) return { kind: "queued" };
  const url = ISSUE_URL.exec(fix);
  if (url !== null) return { kind: "ticket", label: `#${url[1]}`, href: url[0] };
  const ref = ISSUE_REF.exec(fix);
  if (ref !== null) return { kind: "ticket", label: `#${ref[1]}`, href: null };
  if (OPERATOR.test(fix)) return { kind: "operator" };
  return { kind: "none" };
}

/** Whole days between an ISO date and the snapshot's time, never negative. */
function daysSince(date: string | null, nowMs: number): number | null {
  if (date === null) return null;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at) || Number.isNaN(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 86_400_000));
}

function item(entry: LearningEntryView, scope: LearningScope, order: number, fileHref: string | null, nowMs: number): LearningItem {
  const seenAgain = entry.seenAgain;
  const fix = fixStatus(entry);
  return {
    key: `${scope}:${entry.slug ?? order}`,
    slug: entry.slug,
    scope,
    order,
    title: entry.title,
    date: entry.date,
    ageDays: daysSince(entry.date, nowMs),
    seenCount: 1 + seenAgain.length,
    lastSeen: seenAgain.at(-1) ?? null,
    hot: seenAgain.length >= 3,
    fix,
    readyForCoder: entry.change !== null && entry.verify !== null,
    fileable: entry.slug !== null && entry.seen !== null && entry.workaround !== null && fix.kind !== "ticket" && fix.kind !== "duplicate",
    seen: entry.seen,
    workaround: entry.workaround,
    fixText: entry.fix,
    change: entry.change,
    verify: entry.verify,
    href: fileHref === null ? null : `${fileHref}#${entry.anchor}`,
  };
}

/** One file's row, or the shape of its absence. */
function row(source: LearningsSourceView, base: string | null, nowMs: number): LearningsRow {
  const href = base === null ? null : `${base}/${source.file}`;
  return {
    scope: source.scope,
    file: source.file,
    count: source.entries.length,
    items: source.entries.map((entry, index) => item(entry, source.scope, index, href, nowMs)),
    fixed: source.fixed,
    href,
    absent: !source.present,
  };
}

/**
 * The panel, or null when no adapter supplied the learnings.
 *
 * Null rather than an empty panel, for the reason every other panel here uses
 * it: a read that failed is a question nobody is asking, and drawing "0 open"
 * over it would report a clear list that was never read.
 *
 * A project that opted out is NOT null — its read succeeded and returned the
 * harness's file alone, which is the truth and worth showing.
 */
export function learningsPanel(data: Dashboard): LearningsPanelView | null {
  const read = data.learnings;
  if (read === null || read.sources.length === 0) return null;
  const nowMs = Date.parse(data.generatedAt);
  const rows = read.sources.map((source) => row(source, source.base === undefined ? read.base : source.base, nowMs));
  return { rows, total: rows.reduce((sum, one) => sum + one.count, 0) };
}

/**
 * True when neither file is even on the ref — so the panel says so in a
 * sentence instead of drawing two empty rows.
 */
export function nothingLearned(panel: LearningsPanelView): boolean {
  return panel.total === 0 && panel.rows.every((row) => row.absent);
}

/** What a row's count reads as. The absent case is words, not a zero. */
export function learningsCount(row: LearningsRow): string {
  if (row.absent) return "nothing learned yet";
  if (row.count === 0) return "no open entries";
  return `${row.count} open`;
}

/** Which file's entries the list shows. */
export type LearningsFilter = "all" | LearningScope;

/** The rows the filter keeps. */
export function filteredRows(panel: LearningsPanelView, filter: LearningsFilter): LearningsRow[] {
  return filter === "all" ? panel.rows : panel.rows.filter((row) => row.scope === filter);
}

/**
 * The entries to list, both files merged when the filter is `all`: the ones
 * that keep recurring first, since they cost the loops most, then newest by
 * heading date with undated entries last. Ties keep file order (the
 * publisher's newest-first), project before harness.
 */
export function listedItems(panel: LearningsPanelView, filter: LearningsFilter): LearningItem[] {
  const items = filteredRows(panel, filter).flatMap((row) => row.items);
  const scopeRank = (one: LearningItem) => (one.scope === "project" ? 0 : 1);
  const newest = (a: LearningItem, b: LearningItem) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? 1 : -1;
    }
    return scopeRank(a) - scopeRank(b) || a.order - b.order;
  };
  return [...items].sort((a, b) => b.seenCount - a.seenCount || newest(a, b));
}

export interface LearningsSummary {
  open: number;
  fixed: number;
}

/** The one muted line beside the title, for the rows the filter keeps. */
export function learningsSummary(panel: LearningsPanelView, filter: LearningsFilter): LearningsSummary {
  const rows = filteredRows(panel, filter);
  return {
    open: rows.reduce((sum, row) => sum + row.items.length, 0),
    fixed: rows.reduce((sum, row) => sum + row.fixed.length, 0),
  };
}

/**
 * What the row's last column says: the ticket, or that one is coming, or that
 * it is a person's job. Nothing at all for an entry with no ticket: an empty
 * column is the quiet way to say so, and File ticket is one click away.
 */
export function fixLabel(fix: FixStatus): string | null {
  switch (fix.kind) {
    case "ticket":
      return fix.label;
    case "queued":
      return "queued";
    case "operator":
      return "operator";
    default:
      return null;
  }
}

/** What a File ticket answered, as the entry then shows it. */
export type FilingOutcome =
  | { kind: "filed"; label: string; href: string }
  | { kind: "queued" }
  | { kind: "problem"; text: string };

export function filingOutcome(view: LearningFiledView): FilingOutcome {
  if (view.problem !== null) return { kind: "problem", text: view.problem };
  if (view.url === null) return { kind: "queued" };
  const number = /\/(\d+)$/.exec(view.url)?.[1];
  return { kind: "filed", label: number === undefined ? "ticket" : `#${number}`, href: view.url };
}

/** The Fixed rows the filter keeps, newest first (the table is written oldest first). */
export function listedFixed(panel: LearningsPanelView, filter: LearningsFilter): (LearningFixedView & { scope: LearningScope })[] {
  return filteredRows(panel, filter).flatMap((row) => row.fixed.map((one) => ({ ...one, scope: row.scope })).reverse());
}

/** What the age reads as: `today`, `1d`, `25d`. */
export function ageLabel(days: number | null): string | null {
  if (days === null) return null;
  return days === 0 ? "today" : `${days}d`;
}

/** One run of an entry's text: plain, `code`, or **bold**. */
export interface InlinePiece {
  kind: "text" | "code" | "bold";
  text: string;
}

/**
 * The two marks these files use inside a line — backtick code and double-star
 * bold — as pieces the panel draws without injecting HTML. Code wins: stars
 * inside backticks stay literal. An unclosed mark is plain text.
 */
export function inlinePieces(text: string): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > at) pieces.push({ kind: "text", text: text.slice(at, start) });
    pieces.push(match[1] !== undefined ? { kind: "code", text: match[1] } : { kind: "bold", text: match[2] as string });
    at = start + match[0].length;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
}
