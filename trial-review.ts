/**
 * What a trial's review did, read from the fake gh's state: the rounds the
 * review ran on the trial's PR, the heads it did not review and why, and how
 * the iteration answered each thread. Pure, and total over `unknown`: the
 * state is whatever file the run left, and a summary must never throw.
 */
import { priorityOf, titleOf } from "./review-threads";

export type Priority = "P1" | "P2" | "P3";
export type HeadReviewStatus = "findings" | "clean" | "unavailable" | "capped" | "failed" | "pending" | "none";
export type ThreadAnswer = "fix" | "rebuttal" | "unanswered";

export interface ReviewRound {
  round: number;
  head: string;
  findings: number;
  priorities: Record<Priority | "none", number>;
}

export interface ReviewedHead {
  sha: string;
  status: HeadReviewStatus;
  reason: string | null;
}

export interface ReviewThreadSummary {
  id: number | null;
  /** The round of the head whose findings opened the thread; null when that head is no round. */
  round: number | null;
  head: string | null;
  priority: Priority | null;
  path: string | null;
  line: number | null;
  title: string;
  answer: ThreadAnswer;
  /** The last reply's body, not the reviewer's. */
  reply: string | null;
}

export interface TrialReview {
  pr: number | null;
  rounds: ReviewRound[];
  roundCount: number;
  heads: ReviewedHead[];
  /** Heads the review could not run on (unavailable): unreviewed, never clean. */
  unreviewedHeads: string[];
  /** Heads pushed after the round cap: no review ran on them by design. */
  cappedHeads: string[];
  cap: number;
  capReached: boolean;
  note: string;
  threads: ReviewThreadSummary[];
  answered: Record<ThreadAnswer, number>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A reply that names the commit carrying the fix, in English or Spanish; the sha may sit in backticks. */
const FIX_REPLY = /\b(?:fixed in|corregido en)\s+`?[0-9a-f]{7,40}`?(?![0-9a-z])/i;

export function classifyReply(reply: string | null): ThreadAnswer {
  if (reply === null) return "unanswered";
  return FIX_REPLY.test(reply) ? "fix" : "rebuttal";
}

function headStatus(head: Record<string, unknown>): { status: HeadReviewStatus; reason: string | null } {
  // Unavailable first: a head the review could not run on must never read as clean.
  const unavailable = text(head.reviewUnavailable);
  if (unavailable !== null) return { status: "unavailable", reason: unavailable };
  const skipped = text(head.reviewSkipped);
  if (skipped !== null) return { status: "capped", reason: skipped };
  const error = text(head.findingsError);
  if (error !== null) return { status: "failed", reason: error };
  if (Array.isArray(head.findings)) return { status: head.findings.length > 0 ? "findings" : "clean", reason: null };
  if (text(head.findingsCmd) !== null) return { status: "pending", reason: null };
  return { status: "none", reason: null };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function noteFor(review: Omit<TrialReview, "note">): string {
  if (review.pr === null) return "no PR was opened";
  const parts: string[] = [];
  if (review.capReached) {
    parts.push(`stopped at the round cap (${plural(review.cap, "round", "rounds")})`);
    if (review.cappedHeads.length > 0) {
      parts.push(`${plural(review.cappedHeads.length, "head", "heads")} pushed after it ${review.cappedHeads.length === 1 ? "was" : "were"} not reviewed`);
    }
  } else {
    const last = review.heads.at(-1);
    parts.push(`${plural(review.roundCount, "round", "rounds")}${last ? `; last head ${last.status === "findings" ? "with findings" : last.status}` : ""}`);
  }
  if (review.unreviewedHeads.length > 0) parts.push(`${plural(review.unreviewedHeads.length, "head", "heads")} unreviewed (review unavailable)`);
  return parts.join("; ");
}

/** The review of the trial's PR, the newest one in `github`; an empty summary for a missing or malformed state. */
export function summarizeReview(github: unknown, cap: number): TrialReview {
  const prs = list(record(github)?.prs).map(record).filter((pr): pr is Record<string, unknown> => pr !== null);
  const newest = prs.reduce<Record<string, unknown> | null>(
    (best, pr) => (typeof pr.number === "number" && (best === null || pr.number > (best.number as number)) ? pr : best),
    null,
  );

  const heads: ReviewedHead[] = [];
  const rounds: ReviewRound[] = [];
  const roundOf = new Map<string, number>();
  for (const head of list(newest?.heads).map(record)) {
    const sha = text(head?.sha);
    if (head === null || sha === null) continue;
    heads.push({ sha, ...headStatus(head) });
    if (!Array.isArray(head.findings) || text(head.reviewUnavailable) !== null) continue;
    const priorities: ReviewRound["priorities"] = { P1: 0, P2: 0, P3: 0, none: 0 };
    for (const finding of head.findings) {
      const priority = record(finding)?.priority;
      priorities[priority === "P1" || priority === "P2" || priority === "P3" ? priority : "none"] += 1;
    }
    const round = rounds.length + 1;
    rounds.push({ round, head: sha, findings: head.findings.length, priorities });
    if (!roundOf.has(sha)) roundOf.set(sha, round);
  }

  const threads: ReviewThreadSummary[] = [];
  for (const thread of list(newest?.reviewThreads).map(record)) {
    if (thread === null) continue;
    const comments = list(thread.comments).map(record).filter((c): c is Record<string, unknown> => c !== null);
    const first = comments[0];
    const body = text(first?.body) ?? "";
    const reviewer = text(first?.author);
    const replies = comments.slice(1).filter((c) => text(c.author) !== reviewer);
    const last = replies.at(-1);
    const reply = last === undefined ? null : typeof last.body === "string" ? last.body : "";
    const priority = priorityOf(body);
    const head = text(thread.headSha);
    threads.push({
      id: typeof thread.id === "number" ? thread.id : null,
      round: head !== null ? roundOf.get(head) ?? null : null,
      head,
      priority: priority === "P1" || priority === "P2" || priority === "P3" ? priority : null,
      path: text(thread.path),
      line: typeof thread.line === "number" ? thread.line : null,
      title: titleOf(body),
      answer: classifyReply(reply),
      reply,
    });
  }

  const answered: TrialReview["answered"] = { fix: 0, rebuttal: 0, unanswered: 0 };
  for (const thread of threads) answered[thread.answer] += 1;
  const cappedHeads = heads.filter((h) => h.status === "capped").map((h) => h.sha);
  const review: Omit<TrialReview, "note"> = {
    pr: newest !== null ? (newest.number as number) : null,
    rounds,
    roundCount: rounds.length,
    heads,
    unreviewedHeads: heads.filter((h) => h.status === "unavailable").map((h) => h.sha),
    cappedHeads,
    cap,
    // A last allowed round that came back clean left nothing to answer: the
    // cap only bit if a head went unreviewed for it, or the findings it would
    // have checked were left standing.
    capReached: cappedHeads.length > 0 || (rounds.length >= cap && (rounds.at(-1)?.findings ?? 0) > 0),
    threads,
    answered,
  };
  return { ...review, note: noteFor(review) };
}
