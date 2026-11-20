import { createHash } from "node:crypto";

import type { IssueComment } from "./block-reason";

/**
 * The record a triager leaves on an issue, and the only durable memory it has.
 *
 * A triager's work is a set of writes to the tracker — labels, a staffing group,
 * a split, a re-spec — and none of those writes says WHO made them or against
 * WHICH version of the issue. Without that, the next poll offers the same issue
 * back: the intake bucket is defined by what an issue lacks, and an issue the
 * triager decided to leave alone still lacks it. So the decision itself is
 * recorded, in a machine-readable trailer on the triage comment, and the
 * frontier reads it the way it reads a label.
 *
 * The hash is what makes the record expire. A marker pinned to the body it was
 * written against goes stale the moment somebody edits the issue, which is
 * exactly when the decision should be made again — and never before.
 */

/**
 * What a triager did. `gave-up` is the one that matters to the frontier: two
 * attempts ending there means the issue needs a person, and offering it a third
 * time would spend a whole iteration re-deciding the same thing.
 *
 * `propose` and `to-person` belong to a Linear or Jira project's Slack intake
 * alone: the report was rewritten into an agent brief, or handed to a person
 * with the agent-ready rule it failed. The GitHub triager is refused both.
 */
export const TRIAGE_OUTCOMES = ["routed", "split", "specced", "info", "gave-up", "propose", "to-person"] as const;
export type TriageOutcome = (typeof TRIAGE_OUTCOMES)[number];

/**
 * The `op=` value an unblock's comment carries, and the one op id this module
 * gives a name to.
 *
 * Every other marker's `op` is a generated id (`release-1`), interesting only
 * as history. This one is a counter the next triager reads: it is the whole
 * record that a ticket has been rescued, so it is a fixed word rather than an
 * id, and it lives here beside the format that writes it.
 */
export const UNBLOCK_MARKER_OP = "unblock";

/**
 * How many times a ticket may ever be rescued.
 *
 * Not an env knob, deliberately. Two is the same budget `triageGaveUp` gives a
 * triage attempt and `prompt.md` gives a coder rescue, and for the same reason:
 * the third failure is a decision a person has to make. A knob here would let a
 * loop raise its own rescue budget, which is exactly the judgement it does not
 * have.
 */
export const MAX_UNBLOCKS = 2;

/**
 * How long a rescued ticket stays off the rescue bucket, in days, when
 * `RALPH_TRIAGE_UNBLOCK_DAYS` says nothing.
 *
 * Beside `MAX_UNBLOCKS` because they are the two halves of one policy, and the
 * knob is read on both sides of it — `frontier/next-tasks.ts` for the bucket,
 * `triage/validate.ts` for the op. Two copies of the default would let the
 * bucket offer what the op refuses, which is the one failure both of those
 * modules' docblocks promise cannot happen.
 */
export const DEFAULT_UNBLOCK_DAYS = 7;

/**
 * The first line a rescue's unblock comment must carry, naming the coder whose
 * rescue count it resets.
 *
 * One function because two readers need the identical string: `validate.ts`
 * refuses a plan without it, and `apply.ts` finds the comment to stamp the
 * `op=unblock` marker onto by it. A second spelling would stamp nothing and
 * the rescue would not be counted.
 */
export const unblockLead = (loop: string): string => `unblocked: rescue count for ${loop} reset`;

/** The first non-empty line of a comment body, trimmed; "" when there is none. */
export const firstLine = (body: string): string =>
  body.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";

/** Whether `body` is the unblock comment for `loop`. */
export const leadsWithUnblock = (body: string, loop: string): boolean =>
  firstLine(body) === unblockLead(loop);

/**
 * The suffix a block label carries. The inverse of
 * `frontier/next-tasks.ts`'s `stuckLabelFor`, which composes the same word;
 * `triage-marker.test.ts` asserts the round trip, because the two halves live
 * in different modules and the types do not link them.
 */
export const BLOCKED_SUFFIX = "-blocked";

/** The loop a `<name>-blocked` label names, or null when it is not one. */
export const blockedLoopOf = (label: string): string | null =>
  label.endsWith(BLOCKED_SUFFIX) ? label.slice(0, -BLOCKED_SUFFIX.length) : null;

/** Why a ticket may not be rescued right now, on its unblock history alone. */
export interface RescueBar {
  reason: "capped" | "undated" | "unparseable" | "recent";
  /** The newest unblock marker. Never absent: no bar exists without one. */
  marker: TriageMarker;
  count: number;
}

export interface TriageMarker {
  /** The triage attempt this record closes; 1 for the first. */
  attempt: number;
  outcome: TriageOutcome;
  /** `triageBodyHash` of the issue body the decision was made against. */
  body: string;
  /**
   * The `op=` field, when the marker carries the apply details: the id of the
   * op that wrote it. Null when the marker names no op.
   *
   * It is read back because one op id is load-bearing rather than merely
   * historical. `UNBLOCK_MARKER_OP` is how a rescue is counted: #150 lets the
   * triager lift a coder's block at most once per ticket per
   * `RALPH_TRIAGE_UNBLOCK_DAYS`, and never a third time, and the ticket's own
   * comments are the only durable record of that — a local apply ledger is
   * per-unit and per-checkout, so a second triager on another host would not
   * see it. `loop`, `unit` and `labels` stay unread; nothing asks them yet.
   */
  op: string | null;
  /** When the comment carrying it was written; null when the read did not say. */
  at: string | null;
}

/**
 * An issue comment. Re-exported from `block-reason.ts` rather than declared
 * again: both modules classify the same comments off the same read, and two
 * definitions would be two chances to disagree about what a comment is.
 */
export type { IssueComment };

/** The hash is truncated: it goes in a comment a person may read, and 48 bits is plenty to notice an edit. */
const HASH_CHARS = 12;

/**
 * One line, one regex, and the same text both ways — `formatTriageMarker` and
 * `triageMarkerOf` share this shape so a marker this module writes is one it can
 * read back. The keys are fixed in order for the writer; the reader does not
 * care, because a reordered marker written by hand is still a decision.
 */
const MARKER = /<!--\s*ralph:triage\s+([^>]*?)\s*-->/g;

const OUTCOMES = new Set<string>(TRIAGE_OUTCOMES);

const HASH_SHAPE = new RegExp(`^[0-9a-f]{${HASH_CHARS}}$`);

/**
 * The issue body as the marker pins it. CRLF and trailing whitespace are
 * normalised away because GitHub's own editors introduce both: a body that
 * round-tripped through the web UI is not a new decision to make.
 */
export function triageBodyHash(body: string): string {
  const normalised = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
  return createHash("sha256").update(normalised).digest("hex").slice(0, HASH_CHARS);
}

/**
 * What an APPLY adds to the marker beyond the decision itself: who made it,
 * which unit it closed, the write it was, and the unit's labels afterwards.
 *
 * Extra keys rather than a second marker format, because `parseFields` reads
 * the three it needs and ignores the rest. felipearos/ralph#142 §7 spells the
 * marker as a separate `ralph-triage v1 …` comment; written that way it would
 * not parse here, so `hasCurrentTriage` would never see the decision and every
 * triaged issue would sit in the intake bucket forever. Same information, one
 * format that both sides read.
 *
 * Every value is percent-encoded, which is what keeps the HTML comment — and
 * the reader's regex — intact. It matters most for `labels=`: `parseFields`
 * splits on whitespace and rejects a token with no `=`, so a real label like
 * `good first issue` would make the whole marker unreadable, and the issue it
 * marks would sit in the intake bucket forever. That is the exact failure this
 * format was chosen to avoid.
 */
export interface TriageApplyDetails {
  loop: string;
  unit: number;
  op: string;
  labels: readonly string[];
}

/** Percent-encoded, so no value can carry whitespace, `>` or a stray `=`. */
const field = (value: string): string => encodeURIComponent(value);

/** `field`'s inverse. Null when the value is not valid percent-encoding. */
const decoded = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export function formatTriageMarker(
  // `op` is not the caller's to pass twice: it is `details.op`, and a marker
  // with no details names no op.
  marker: Omit<TriageMarker, "at" | "op">,
  details?: TriageApplyDetails,
): string {
  const fields = [`attempt=${marker.attempt}`, `outcome=${marker.outcome}`, `body=${marker.body}`];
  if (details !== undefined) {
    fields.push(
      `loop=${field(details.loop)}`,
      `unit=${details.unit}`,
      `op=${field(details.op)}`,
      `labels=${details.labels.map(field).join(",")}`,
    );
  }
  return `<!-- ralph:triage ${fields.join(" ")} -->`;
}

function parseFields(fields: string): TriageMarker | null {
  const seen = new Map<string, string>();
  for (const pair of fields.trim().split(/\s+/)) {
    const at = pair.indexOf("=");
    if (at <= 0) return null;
    seen.set(pair.slice(0, at), pair.slice(at + 1));
  }

  const attempt = Number(seen.get("attempt"));
  const outcome = seen.get("outcome");
  const body = seen.get("body");
  const op = seen.get("op");
  // Strict on purpose: a half-read marker would make the frontier skip a ticket
  // nobody triaged, which is worse than re-triaging one that was.
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (outcome === undefined || !OUTCOMES.has(outcome)) return null;
  if (body === undefined || !HASH_SHAPE.test(body)) return null;

  return {
    attempt,
    outcome: outcome as TriageOutcome,
    body,
    // Written percent-encoded by `field`, so decoded here. A value that will
    // not decode is read as absent rather than failing the whole marker: `op`
    // is not what makes a marker a decision.
    op: op === undefined ? null : decoded(op),
    at: null,
  };
}

/** Null when the comment carries no marker, or one that will not parse. */
export function triageMarkerOf(comment: IssueComment): TriageMarker | null {
  let found: TriageMarker | null = null;
  // The LAST marker in a comment wins: a triager that edits its own comment
  // appends the new decision, and the old text above it is history.
  for (const match of comment.body.matchAll(MARKER)) {
    const parsed = parseFields(match[1] ?? "");
    if (parsed !== null) found = parsed;
  }
  return found === null ? null : { ...found, at: comment.createdAt ?? null };
}

/** The newest marker among comments listed oldest first, as `gh` lists them. */
export function latestTriageMarker(comments: readonly IssueComment[]): TriageMarker | null {
  for (let at = comments.length - 1; at >= 0; at--) {
    const marker = triageMarkerOf(comments[at]!);
    if (marker !== null) return marker;
  }
  return null;
}

/**
 * Every marker a ticket's comments carry whose `op` is `op`, oldest first.
 *
 * Unlike `latestTriageMarker` this does not stop at the newest: a rescue is
 * bounded both by how long ago the last one was AND by how many there have ever
 * been, so the caller needs the whole list. One marker per comment, the last in
 * each winning, exactly as `triageMarkerOf` decides it.
 */
export function triageMarkersWithOp(comments: readonly IssueComment[], op: string): TriageMarker[] {
  const found: TriageMarker[] = [];
  for (const comment of comments) {
    const marker = triageMarkerOf(comment);
    if (marker !== null && marker.op === op) found.push(marker);
  }
  return found;
}

/**
 * What stops a rescue of this ticket, read off its own comments, or null when
 * nothing does.
 *
 * The ticket's comments rather than the apply ledger, because the ledger is
 * per-unit and per-checkout: a triager on another host, or a later unit, would
 * see an empty one and rescue the same ticket again.
 *
 * One function so that the rescue bucket and the `unblock` op cannot disagree
 * about whether a ticket is due — the bucket checks it for null and the op
 * renders the reason. It fails CLOSED on a marker it cannot date: an undated or
 * unparseable one cannot be SHOWN to be outside the window, and the whole
 * purpose of the window is to stop a ticket coming straight back.
 */
export function rescueBar(
  comments: readonly IssueComment[],
  options: { now: Date; days: number },
): RescueBar | null {
  const marks = triageMarkersWithOp(comments, UNBLOCK_MARKER_OP);
  const count = marks.length;
  const marker = marks[count - 1];
  // No markers, no bar: every reason below is a fact about the newest one.
  if (marker === undefined) return null;
  if (count >= MAX_UNBLOCKS) return { reason: "capped", marker, count };
  if (marker.at === null) return { reason: "undated", marker, count };

  const age = options.now.getTime() - Date.parse(marker.at);
  if (!Number.isFinite(age)) return { reason: "unparseable", marker, count };
  return age < options.days * 24 * 60 * 60 * 1000 ? { reason: "recent", marker, count } : null;
}

/**
 * Whether a triager has already decided about the issue AS IT STANDS NOW.
 *
 * Two things expire the decision, and they are different kinds of new
 * information. An edited body is a changed request. A comment written after the
 * marker is somebody answering the triager — the `needs-info` case is exactly
 * this — and re-reading it is the whole point of having asked. Either way the
 * issue comes back to the intake bucket.
 *
 * Comment ORDER decides, not `createdAt`, which the read may omit: `gh` and the
 * GraphQL census both list comments oldest first, and a timestamp is optional in
 * the shape they return.
 */
export function hasCurrentTriage(issueBody: string, comments: readonly IssueComment[]): boolean {
  for (let at = comments.length - 1; at >= 0; at--) {
    const marker = triageMarkerOf(comments[at]!);
    if (marker === null) continue;
    // The newest marker is the decision that stands; everything after it is
    // news the triager has not seen. `at` is the last index, or it is stale.
    return marker.body === triageBodyHash(issueBody) && at === comments.length - 1;
  }
  return false;
}

/**
 * Whether the triager has spent its attempts on this issue. Two is the budget:
 * the second failure is a decision a person has to make, and the frontier stops
 * offering it rather than letting the loop re-derive the same "I cannot tell".
 */
export function triageGaveUp(comments: readonly IssueComment[]): boolean {
  const marker = latestTriageMarker(comments);
  return marker !== null && marker.outcome === "gave-up" && marker.attempt >= 2;
}
