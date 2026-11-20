/**
 * The learnings panel's server-side fold (#201).
 *
 * A pure fold over text the adapter is handed, for the reason `health.ts` is
 * one: the adapter owns every subprocess and its command surface is pinned, so
 * the git reads happen there and the decisions happen here.
 *
 * It parses through `../learnings`, the same leaf the loop's reader and the
 * journal publisher use, so the dashboard can never disagree with them about
 * what an open entry is. That module imports nothing at all, which is why it
 * is safe to reach across for: there is no loop code behind it and no state.
 */
import { entryFields, HARNESS_FILE, noIssueYet, parseLearnings, titleDate, type LearningEntry } from "../learnings";
import type { LearningEntryView, LearningsRead, LearningsSourceView } from "./contracts";

/**
 * The harness-wide file, re-exported for the adapter: its allow-list keeps it
 * out of `../learnings`, so this module is how the one declaration reaches it.
 */
export { HARNESS_FILE };

/** One file as the adapter read it: its text, or null when it is not on its ref. */
export interface LearningsFileRead {
  scope: "project" | "harness";
  file: string;
  text: string | null;
  /** Set when the file is not the harness's: its own blob base (`blobBase`). */
  base?: string | null;
}

/** A GitHub blob base from a remote URL, or null when it is not a GitHub remote. */
export function blobBase(remote: string | null, branch = "main"): string | null {
  if (remote === null) return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/(.+?)(?:\.git)?$/.exec(remote.trim());
  return match === null ? null : `https://github.com/${match[1]}/${match[2]}/blob/${branch}`;
}

/**
 * The fragment GitHub gives a Markdown heading: lower-cased, punctuation other
 * than `-` and `_` dropped, each space a hyphen. Backticks go with the rest, so
 * `` `*-wip` `` reads `-wip`. Two headings with the same text would get `-1`
 * on the second; the files' dates keep that from happening in practice.
 */
export function githubAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function entry(one: LearningEntry): LearningEntryView {
  const fields = entryFields(one);
  const { title, date } = titleDate(one.title);
  return {
    slug: one.slug,
    title,
    date,
    anchor: githubAnchor(one.title),
    seen: fields.seen,
    workaround: fields.workaround,
    fix: fields.fix,
    change: fields.change,
    verify: fields.verify,
    seenAgain: fields.seenAgain,
    fixPending: fields.fix !== null && noIssueYet(fields.fix) !== null,
  };
}

/** One file's open entries with their fields, and its Fixed table. */
function source(read: LearningsFileRead): LearningsSourceView {
  const parsed = read.text === null ? null : parseLearnings(read.text);
  return {
    scope: read.scope,
    file: read.file,
    entries: parsed === null ? [] : parsed.open.map(entry),
    fixed: parsed === null ? [] : parsed.fixed.map((row) => ({ problem: row.problem, fixedBy: row.fixedBy })),
    present: read.text !== null,
    ...(read.base === undefined ? {} : { base: read.base }),
  };
}

/**
 * The learnings as the dashboard says them.
 *
 * Every entry, never the capped set: the cap is about what a loop should read
 * before diagnosing something, and a panel that showed "3 open" beside two
 * entries because the third did not fit would be lying about the list.
 */
export function foldLearnings(reads: readonly LearningsFileRead[], remote: string | null): LearningsRead {
  return { base: blobBase(remote), sources: reads.map(source) };
}
