/**
 * Why a stuck ticket is stuck, read back from what the loop wrote on it.
 *
 * A `<loop>-blocked` label says only that a loop gave up on a ticket. Two very
 * different hand-offs wear it. One is the migrations HARD RAIL: the code is
 * finished in a draft PR and waits for a person to apply a database
 * migration, which is a five-minute job for whoever reads the dashboard. The
 * other is everything else — red CI the loop could not fix, an ambiguous
 * spec, a finding it could not resolve — which needs triage. Showing both the
 * same way hides the easy one among the hard ones.
 *
 * The label carries no reason, so the reason comes from the ticket's comments,
 * and this module is the one place that reads them. A block record is a
 * comment that
 *
 *   - is the `ticket-blocked` notification's own mirror, headed
 *     `### Ticket #<n> blocked` (push-notification.ts writes that heading), or
 *   - leads with `needs-migration` (the HARD RAIL comment, bold or not), or
 *   - leads with `blocked:`.
 *
 * `prompt.md` §6 makes the leading word a requirement, so a new block is
 * always one of these; the forms are also exactly what tickets blocked before
 * that rule already carry (loggd #1219 and #1109). The newest record wins,
 * because a ticket unblocked and later wedged again for another reason must
 * show the later reason.
 *
 * The journal's `**Outcome:**` line is the other place a block is written
 * down, and `journalBlockKind` reads it for the loop card's issue history.
 */

export const BLOCK_KINDS = ["migration", "ci-flake", "other", "unknown"] as const;
/**
 * `migration` waits on a person applying a migration; `ci-flake` is a coder
 * parking a pull request on a flaky test, which is the ci-doctor's intake
 * rather than the triager's (felipearos/ralph#155) and shows on the dashboard
 * as the doctor's rather than as human triage; `other` is any other recorded
 * reason; `unknown` means no block record was found or the comments could not
 * be read — not the same as `other`, since it may still be a migration.
 */
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * The kinds a JOURNAL outcome line can name, which is narrower than the kinds
 * a block COMMENT can: a journal says `blocked (<reason>)` in prose and has
 * never distinguished a flake from any other reason.
 *
 * A list of its own rather than an `Exclude<BlockKind, "unknown">`, because
 * that exclusion silently widened the moment `ci-flake` joined the union — and
 * a list rather than only a type, because `dashboard/adapter.ts` validates the
 * field at RUNTIME and a type cannot be handed to `oneOf`. Both copies are
 * pinned by `dashboard/contract-parity.test.ts`.
 */
export const JOURNAL_BLOCK_KINDS = ["migration", "other"] as const;
export type JournalBlockKind = (typeof JOURNAL_BLOCK_KINDS)[number];

export interface BlockReason {
  kind: BlockKind;
  /** The record's first line, as the loop wrote it; null when there is none. */
  reason: string | null;
  /** The PR the record names, e.g. the draft carrying the finished code. */
  pr: number | null;
  /** The migration file the record names, e.g. `drizzle/0062_streaming_region.sql`. */
  migration: string | null;
  /** When the record was written. */
  at: string | null;
}

/** An issue comment as `gh issue view --json comments` returns it. */
export interface IssueComment {
  body: string;
  createdAt?: string;
  /** Who wrote it, as the tracker names people; absent when the read did not carry it. */
  author?: string | null;
}

export const UNKNOWN_BLOCK: BlockReason = { kind: "unknown", reason: null, pr: null, migration: null, at: null };

const MIRROR_HEADING = /^#{1,6}\s+Ticket\s+#\d+\s+blocked\s*$/i;
const MIGRATION_LEAD = /^needs-migration\b/i;
const BLOCKED_LEAD = /^blocked\s*:/i;
/**
 * The flake VOCABULARY — a `flak` stem, so "flaky" and "flake" both read.
 *
 * `prompt.md` §5.4 makes the coder write that block in one shape — `blocked:
 * PR #<pr> red on a flaky test (<file>), not the diff` — but keying on the
 * stem rather than on the whole sentence means a block lightly reworded by
 * hand still reads as one. The stem alone is tight enough: the ordinary
 * unreproducible red (`blocked: PR #1276 red twice in CI; not reproducible
 * locally`) never says it, and that one is a RESCUE candidate, not the
 * doctor's.
 *
 * felipearos/ralph#155 asks for the narrower `blocked: PR #\d+ red on a flaky
 * test`. That form would drop both reworded blocks `block-reason.test.ts`
 * already pins, and the issue's own example matches the stem too, so the stem
 * is what this reads.
 *
 * It is tested against the LEAD — the record's first line — and nothing below
 * it. That is where `prompt.md` puts the verdict, and a flake mentioned
 * further down is a coder saying what else it noticed, not what it parked on.
 * Two cases it therefore gets wrong, both in the safe direction: a flake named
 * only in the body reads as rescuable (the triager then re-specifies a ticket
 * whose test was at fault, which wastes a plan rather than losing anything),
 * and a negation — `blocked: the test is NOT flaky, the diff is` — reads as a
 * flake and goes to the ci-doctor.
 */
const FLAKE_WORD = /\bflak\w*/i;
const REASON_LIMIT = 300;

/**
 * Text without its markdown emphasis, so `**needs-migration** — …` reads as it
 * leads. Used on single lines here; `triage/validate.ts` passes whole comment
 * bodies, which is why the name does not say "line".
 *
 * Exported because a `BlockReason.reason` has been through it, so anything
 * comparing a reason against the comment it came from has to put the comment
 * through it too. `triage/validate.ts` checks that a rescue's unblock comment
 * quotes the block record, and a coder writing a file path in backticks —
 * which is how they are written — would otherwise fail that check on a
 * verbatim copy.
 */
export const withoutEmphasis = (text: string): string => text.replace(/[*`]/g, "").trim();

/** The same, named for how this module reads it: one line at a time. */
const plain = withoutEmphasis;

const lines = (body: string): string[] =>
  body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * Classify one comment. Null when it is not a block record at all — a claim
 * comment, a PR notice, a token footer.
 */
export function blockReasonOf(comment: IssueComment): BlockReason | null {
  const rest = lines(comment.body);
  const mirrored = rest[0] !== undefined && MIRROR_HEADING.test(rest[0]);
  if (mirrored) rest.shift();
  const first = rest[0] === undefined ? null : plain(rest[0]);
  const migration = first !== null && MIGRATION_LEAD.test(first);
  if (!mirrored && !migration && !(first !== null && BLOCKED_LEAD.test(first))) return null;

  // The first line is the reason, and what it names is what waits. The rest
  // is a fallback: a HARD RAIL comment names its file in the apply steps, but
  // a file named in passing under any other block is not a migration to run.
  const lead = first ?? "";
  const pr = /\bPR\s+#(\d+)/i.exec(lead)?.[1] ?? /\bPR\s+#(\d+)/i.exec(comment.body)?.[1];
  const file = /[\w./-]+\.sql\b/.exec(lead)?.[0] ?? (migration ? /[\w./-]+\.sql\b/.exec(comment.body)?.[0] : undefined);
  return {
    // Migration first, and it wins whatever the rest of the record says: a
    // ticket waiting on a person with database access is not the doctor's
    // however flaky its suite also was.
    kind: migration ? "migration" : FLAKE_WORD.test(lead) ? "ci-flake" : "other",
    reason: lead === "" ? null : lead.length > REASON_LIMIT ? `${lead.slice(0, REASON_LIMIT - 1)}…` : lead,
    pr: pr === undefined ? null : Number(pr),
    migration: file ?? null,
    at: comment.createdAt ?? null,
  };
}

/** The newest block record among a ticket's comments, oldest first as `gh` lists them. */
export function latestBlockReason(comments: readonly IssueComment[]): BlockReason {
  for (let at = comments.length - 1; at >= 0; at--) {
    const reason = blockReasonOf(comments[at]!);
    if (reason !== null) return reason;
  }
  return UNKNOWN_BLOCK;
}

/**
 * Whether a block is one the TRIAGER can do anything about — the single gate
 * both the rescue bucket (`frontier/next-tasks.ts`) and the `unblock` op
 * (`triage/validate.ts`) ask, so the bucket cannot offer a ticket the op will
 * refuse. Two predicates would drift, and the symptom would be an iteration
 * claimed, planned and thrown away.
 *
 * Only an ordinary recorded reason qualifies, which is now the whole of the
 * test: a migration waits on a person with database access, a `ci-flake` is
 * the ci-doctor's, and `unknown` is refused with them because the comments did
 * not say what the coder gave up on, and guessing "ordinary" is the one guess
 * that acts. There used to be an `isFlakeBlock` predicate beside this one;
 * `ci-flake` subsumed it, and a second way of asking one question is how the
 * two answers drift.
 */
export function rescuableBlock(reason: BlockReason): boolean {
  return reason.kind === "other";
}

/**
 * The kind of block a journal `**Outcome:**` names, or null when the outcome
 * is not a block. Entries written before §6 fixed the wording say it several
 * ways — `blocked (needs-migration)`, `blocked on a migration`, `blocked
 * (migration hard rail)` — and all of them name the migration.
 */
export function journalBlockKind(outcome: string): JournalBlockKind | null {
  if (!/^blocked\b/i.test(outcome.trim())) return null;
  return /\bmigration\b/i.test(outcome) ? "migration" : "other";
}
