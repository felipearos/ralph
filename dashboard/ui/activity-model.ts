/**
 * The Recent activity feed's reading of the observer's timeline rows.
 *
 * Every row carries a label in one of the shapes `activitiesFor` (timeline.ts)
 * writes. This module parses those shapes back into kinds, folds a run of rows
 * from one stage into a group headed by that stage's lifecycle, and filters
 * the groups — so the component only lays out what is already decided.
 */
import type { ActivityView } from "../contracts";

export type ParsedLabel =
  | { kind: "stage"; state: string; runner: string }
  | { kind: "tool"; name: string; detail: string; error: boolean }
  | { kind: "result"; ok: boolean; detail: string }
  | { kind: "text"; detail: string }
  | { kind: "thinking"; detail: string }
  | { kind: "rate"; status: string }
  | { kind: "system"; detail: string }
  | { kind: "invalid" }
  | { kind: "other"; detail: string };

export function parseLabel(label: string): ParsedLabel {
  let match: RegExpExecArray | null;
  if ((match = /^stage (\S+) · (.+)$/.exec(label))) return { kind: "stage", state: match[1]!, runner: match[2]! };
  if ((match = /^tool result (ok|error)(?: — ([\s\S]*))?$/.exec(label))) {
    return { kind: "result", ok: match[1] === "ok", detail: match[2] ?? "" };
  }
  if ((match = /^tool (\S+) error(?: — ([\s\S]*))?$/.exec(label))) {
    return { kind: "tool", name: match[1]!, detail: match[2] ?? "", error: true };
  }
  if ((match = /^tool (\S+)(?: — ([\s\S]*))?$/.exec(label))) {
    return { kind: "tool", name: match[1]!, detail: match[2] ?? "", error: false };
  }
  if ((match = /^thinking — ([\s\S]*)$/.exec(label))) return { kind: "thinking", detail: match[1]! };
  if ((match = /^text — ([\s\S]*)$/.exec(label))) return { kind: "text", detail: match[1]! };
  if ((match = /^rate limit (\S+)$/.exec(label))) return { kind: "rate", status: match[1]! };
  if ((match = /^system — ?([\s\S]*)$/.exec(label))) return { kind: "system", detail: match[1]! };
  if (label === "invalid event") return { kind: "invalid" };
  return { kind: "other", detail: label };
}

export interface Step {
  key: string;
  label: string;
  parsed: Exclude<ParsedLabel, { kind: "stage" }>;
  /** When the first of the collapsed identical rows arrived. */
  firstAt: string;
  /** When the last of them arrived. */
  at: string;
  count: number;
}

/** How a group's stage ended, as far as its lifecycle rows say. */
export type GroupState = "running" | "completed" | "failed" | "degraded" | null;

export interface Group {
  key: string;
  stage: string;
  runner: string | null;
  state: GroupState;
  /** A degraded row arrived even if the stage completed afterwards. */
  degraded: boolean;
  startedAt: string;
  endedAt: string;
  steps: Step[];
}

/**
 * Fold the feed, oldest first, into stage groups.
 *
 * A group ends when another stage speaks, or when its stage starts again after
 * it had already started — a second attempt reads as a second block.
 */
export function groupActivity(recent: ActivityView[]): Group[] {
  const groups: Group[] = [];
  recent.forEach((item, index) => {
    const parsed = parseLabel(item.label);
    let group = groups.at(-1);
    const restarted = parsed.kind === "stage" && parsed.state === "started" && group !== undefined && group.state !== null;
    if (group === undefined || group.stage !== item.stage || restarted) {
      group = {
        key: `${index}-${item.stage}`,
        stage: item.stage,
        runner: null,
        state: null,
        degraded: false,
        startedAt: item.at,
        endedAt: item.at,
        steps: [],
      };
      groups.push(group);
    }
    group.endedAt = item.at;

    if (parsed.kind === "stage") {
      group.runner = parsed.runner;
      if (parsed.state === "started") group.state = "running";
      else if (parsed.state === "degraded") {
        group.degraded = true;
        if (group.state !== "failed") group.state = "degraded";
      } else if (parsed.state === "completed" || parsed.state === "failed") group.state = parsed.state;
      return;
    }

    const previous = group.steps.at(-1);
    if (previous && previous.label === item.label) {
      previous.count += 1;
      previous.at = item.at;
      return;
    }
    group.steps.push({ key: `${index}`, label: item.label, parsed, firstAt: item.at, at: item.at, count: 1 });
  });
  return groups;
}

export const FILTERS = ["all", "stages", "tools", "messages", "errors"] as const;
export type Filter = (typeof FILTERS)[number];

export function isError(parsed: Step["parsed"]): boolean {
  return (
    (parsed.kind === "result" && !parsed.ok) ||
    (parsed.kind === "tool" && parsed.error) ||
    (parsed.kind === "rate" && parsed.status === "rejected") ||
    parsed.kind === "invalid"
  );
}

export function stepMatches(step: Step, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "stages":
      return false;
    case "tools":
      return step.parsed.kind === "tool" || step.parsed.kind === "result";
    case "messages":
      return step.parsed.kind === "text" || step.parsed.kind === "thinking";
    case "errors":
      return isError(step.parsed);
  }
}

const groupFailed = (group: Group): boolean => group.state === "failed" || group.degraded;

/**
 * The groups a filter keeps, each narrowed to its matching steps. "Stages"
 * keeps every header and no steps; "Errors" also keeps a failed or degraded
 * stage whose rows are otherwise clean, since the stage itself is the error.
 */
export function applyFilter(groups: Group[], filter: Filter): Group[] {
  if (filter === "all") return groups;
  if (filter === "stages") return groups.map((group) => ({ ...group, steps: [] }));
  return groups
    .map((group) => ({ ...group, steps: group.steps.filter((step) => stepMatches(step, filter)) }))
    .filter((group) => group.steps.length > 0 || (filter === "errors" && groupFailed(group)));
}

/** How many rows (collapsed repeats counted once) each filter would show. */
export function filterCounts(groups: Group[]): Record<Filter, number> {
  const steps = groups.flatMap((group) => group.steps);
  return {
    all: steps.length,
    stages: groups.length,
    tools: steps.filter((step) => stepMatches(step, "tools")).length,
    messages: steps.filter((step) => stepMatches(step, "messages")).length,
    errors: steps.filter((step) => stepMatches(step, "errors")).length + groups.filter(groupFailed).length,
  };
}

/** `1m 20s`, `45s`, `2h 3m`. */
export function durationOf(fromIso: string, toIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** A file path pulled out of a label, ready to be shown short. */
export interface PathPiece {
  /** The whole path, as it was written. */
  full: string;
  /** The last directories worth showing, with a leading `…/` when trimmed. */
  dir: string;
  /** The file itself — the part worth reading first. */
  name: string;
}

/** One run of a label: plain words, a URL, or a file path. */
export type Piece =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "path"; path: PathPiece };

/** Directories kept in front of the file name before the rest is elided. */
const KEPT_DIRS = 2;

const SEGMENT = String.raw`[\w.@+%~\[\]{}()$-]+`;
/** A rooted (`/`, `~/`, `./`) path, or a relative one whose last part has an extension. */
const PATH = new RegExp(
  String.raw`(?:(?:~|\.{1,2})?\/${SEGMENT}(?:\/${SEGMENT})*\/?|${SEGMENT}(?:\/${SEGMENT})+\.[A-Za-z][\w]{0,9})`,
  "g",
);
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

const looksLikePath = (token: string): boolean => {
  const parts = token.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const last = parts.at(-1)!;
  const named = /\.[A-Za-z][\w]{0,9}$/.test(last);
  if (token.startsWith("/") || token.startsWith("~/") || token.startsWith("./") || token.startsWith("../")) {
    return named || parts.length >= 2;
  }
  return named && parts.length >= 2;
};

/** Split a path into the file name and the tail of directories worth showing. */
export function shortenPath(full: string): PathPiece {
  const trimmed = full.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  const name = parts.pop() ?? trimmed;
  const dirs = parts.filter(Boolean);
  const kept = dirs.slice(-KEPT_DIRS);
  const elided = dirs.length > kept.length;
  const dir = kept.length === 0 ? (trimmed.startsWith("/") ? "/" : "") : `${elided ? "…/" : trimmed.startsWith("/") ? "/" : ""}${kept.join("/")}/`;
  return { full, dir, name };
}

/**
 * The pieces of a label, in order: URLs first, then anything that reads as a
 * file path, then the words around them.
 */
export function segments(text: string): Piece[] {
  const marks: { start: number; end: number; piece: Piece }[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    marks.push({ start, end: start + match[0].length, piece: { kind: "link", text: match[0], href: match[0] } });
  }
  for (const match of text.matchAll(PATH)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (marks.some((mark) => start < mark.end && end > mark.start)) continue;
    if (!looksLikePath(match[0])) continue;
    marks.push({ start, end, piece: { kind: "path", path: shortenPath(match[0]) } });
  }
  marks.sort((a, b) => a.start - b.start);

  const pieces: Piece[] = [];
  let last = 0;
  for (const mark of marks) {
    if (mark.start > last) pieces.push({ kind: "text", text: text.slice(last, mark.start) });
    pieces.push(mark.piece);
    last = mark.end;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}
