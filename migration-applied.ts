#!/usr/bin/env bun
/**
 * One operator step after a hand-applied migration.
 *
 * A coder that finishes a ticket whose diff carries a migration may not apply
 * it: the executor holds no database credentials, so it writes a
 * `needs-migration` block record naming the pull request, parks the work as a
 * draft and labels the ticket `<loop>-blocked`. A person with database access
 * then applies the SQL to production by hand — and until now that was where
 * the paper trail stopped. The ticket stayed blocked, the draft stayed a draft
 * that `frontier-gate.ts` skips, and nothing on GitHub said the database was
 * already ahead of `main` (loggd #2760: one hand-applied migration reds every
 * pull request until its own merges).
 *
 * `bun migration-applied.ts <issue>`, run from the project's worktree, is that
 * missing step. Four writes, in an order where a crash between any two is
 * harmless:
 *
 *   1. comment on the issue that the migration was applied, carrying a marker;
 *   2. drop every `*-blocked` label the issue carries;
 *   3. label the issue and the pull request `migration-applied`;
 *   4. `gh pr ready <pr>`, which makes the pull request shepherdable again.
 *
 * Step 4 is last for `ci-doctor/unpark.ts`'s reason: interrupted before it,
 * the draft is visibly unfinished and the next run completes it, where the
 * other order would leave a ready pull request on a ticket still labelled
 * blocked. A merged or closed pull request is never readied.
 *
 * What is left to do is read off the tracker and GitHub on every run — the
 * marker, the labels, the pull request's state — never taken from what a
 * previous run said. That is what makes a second run write nothing and a
 * killed run finish without either being a special case.
 *
 * The issue is read and written through the `Tracker` interface, because it
 * may live on Linear or Jira; the pull request is always GitHub's. So is the
 * `migration-applied` label on it, which is why the label is created on the
 * repository with `gh label create` rather than `ensureLabels`: on a Linear or
 * Jira project the latter creates it on the tracker, and `gh pr edit
 * --add-label` refuses a label the repository does not carry.
 *
 * felipearos/ralph#432.
 */

import { blockReasonOf, latestBlockReason, type IssueComment } from "./block-reason";
import { throttled, write } from "./ci-doctor/gh";
import { ghRunner, type Gh } from "./ci-doctor/gate";
import { isRateLimited, RATE_LIMITED_EXIT } from "./frontier/github-rate-limit";
import { projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { currentProjectId } from "./project-id";
import { CREATED_LABELS } from "./roles";
import { createTracker } from "./tracker/index";
import { TrackerUnavailableError, type Tracker } from "./tracker/types";

const PREFIX = "migration-applied";

/** The label both the issue and the pull request carry once the migration is applied. */
export const APPLIED_LABEL = "migration-applied";

export const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 69, throttled: RATE_LIMITED_EXIT } as const;

/** `<!-- ralph migration-applied ticket=432 pr=437 -->` — the durable record that step 1 happened. */
export const appliedMarker = (ticket: number, pr: number): string => `<!-- ralph migration-applied ticket=${ticket} pr=${pr} -->`;

const MARKER = /<!--\s*ralph migration-applied ticket=(\d+) pr=\d+\s*-->/g;

/**
 * The comment body. It leads `migration-applied:`, never `blocked:` or
 * `needs-migration`, because `blockReasonOf` reads exactly those leads as a
 * block record — and this comment read as one would re-block the ticket it
 * just cleared.
 */
export const appliedComment = (ticket: number, pr: number): string =>
  `${PREFIX}: the migration for PR #${pr} was applied by hand; this ticket is unblocked and the PR is ready.\n\n${appliedMarker(ticket, pr)}`;

/* --------------------------------------------------------------------------
 * The decision. Pure, so every branch is a unit test.
 * ----------------------------------------------------------------------- */

export interface PrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  labels: string[];
}

/** The pull request the newest block record waits on, or why there is none to act for. */
export function migrationPr(ticket: number, comments: readonly IssueComment[]): { pr: number } | { refuse: string } {
  const block = latestBlockReason(comments);
  // Refused rather than guessed: an operator running this on a ticket that is
  // blocked for something else would clear a block nobody resolved.
  if (block.kind !== "migration") {
    return {
      refuse:
        block.kind === "unknown"
          ? `#${ticket} carries no block record, so there is no migration to mark applied`
          : `#${ticket}'s newest block record is not a needs-migration (${block.reason ?? block.kind})`,
    };
  }
  if (block.pr === null) return { refuse: `#${ticket}'s needs-migration record names no PR, so there is nothing to ready` };
  return { pr: block.pr };
}

/**
 * Whether this ticket's marker sits AFTER its newest block record.
 *
 * After, because a ticket blocked again on a new migration once an earlier
 * one was applied is a new apply, and its operator deserves a new comment.
 * Keyed on the ticket number, because a comment may quote another ticket's
 * marker and a quoted marker must not suppress this ticket's comment.
 */
export function alreadyCommented(ticket: number, comments: readonly IssueComment[]): boolean {
  let block = -1;
  let marker = -1;
  for (const [at, comment] of comments.entries()) {
    if (blockReasonOf(comment) !== null) block = at;
    for (const found of comment.body.matchAll(MARKER)) {
      if (Number(found[1]) === ticket) marker = at;
    }
  }
  return marker > block;
}

export interface Steps {
  comment: boolean;
  /** The `*-blocked` labels to drop; never a `*-wip`, which is a loop's claim. */
  unblock: string[];
  labelIssue: boolean;
  labelPr: boolean;
  ready: boolean;
}

export function decide(args: { ticket: number; comments: readonly IssueComment[]; labels: readonly string[]; pr: PrView }): Steps {
  return {
    // The marker only suppresses a second comment. It never stands in for the
    // other steps: a run killed after commenting has to finish them.
    comment: !alreadyCommented(args.ticket, args.comments),
    unblock: args.labels.filter((label) => label.endsWith("-blocked")),
    labelIssue: !args.labels.includes(APPLIED_LABEL),
    labelPr: !args.pr.labels.includes(APPLIED_LABEL),
    ready: args.pr.state === "OPEN" && args.pr.isDraft,
  };
}

/* --------------------------------------------------------------------------
 * The reads and the writes.
 * ----------------------------------------------------------------------- */

export interface Io {
  tracker: Tracker;
  gh: Gh;
}

export async function readPr(pr: number, io: Pick<Io, "gh">): Promise<PrView> {
  const args = ["pr", "view", String(pr), "--json", "state,isDraft,labels"];
  const ran = await io.gh(args);
  if (!ran.ok) throttled(`could not read PR #${pr}: ${`${ran.stderr}\n${ran.stdout}`.trim()}`, args);
  let parsed: { state?: unknown; isDraft?: unknown; labels?: unknown };
  try {
    parsed = JSON.parse(ran.stdout || "{}") as typeof parsed;
  } catch {
    throw new Error(`could not read PR #${pr}`);
  }
  // An unrecognised state is a fault, not OPEN: deciding from a half-read pull
  // request is how a merged one gets `gh pr ready`.
  if (parsed.state !== "OPEN" && parsed.state !== "MERGED" && parsed.state !== "CLOSED") {
    throw new Error(`could not read PR #${pr}'s state`);
  }
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.flatMap((row) => {
        const name = (row as { name?: unknown }).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  return { state: parsed.state, isDraft: parsed.isDraft === true, labels };
}

/** `gh label create`, where a label the repository already carries is the answer wanted, not a failure. */
async function ensureRepoLabel(io: Pick<Io, "gh">): Promise<void> {
  const { description, color } = CREATED_LABELS[APPLIED_LABEL]!;
  const args = ["label", "create", APPLIED_LABEL, "--description", description, "--color", color];
  const ran = await io.gh(args);
  if (ran.ok) return;
  const message = `${ran.stderr}\n${ran.stdout}`.trim();
  if (/already exists/i.test(message)) return;
  throttled(message, args);
}

export interface Outcome {
  commented: boolean;
  unblocked: boolean;
  labelled: boolean;
  readied: boolean;
}

export async function apply(args: { ticket: number; pr: number }, steps: Steps, io: Io): Promise<Outcome> {
  // 1. The record, carrying the marker the next run reads.
  if (steps.comment) await io.tracker.comment(args.ticket, appliedComment(args.ticket, args.pr));
  // 2. Every block label, and nothing else.
  if (steps.unblock.length > 0) await io.tracker.removeLabels(args.ticket, steps.unblock);
  // 3. The label, on the repository first so the pull request can carry it.
  if (steps.labelIssue || steps.labelPr) await ensureRepoLabel(io);
  if (steps.labelIssue) {
    // On GitHub the repository label just created IS the tracker's label. On
    // Linear or Jira it is not, and their `addLabels` fails on a label the
    // tracker does not have.
    if (io.tracker.kind !== "github") {
      const ensured = await io.tracker.ensureLabels([APPLIED_LABEL]);
      if (ensured.missing.length > 0) throw new Error(`the tracker has no '${APPLIED_LABEL}' label and could not create it`);
    }
    await io.tracker.addLabels(args.ticket, [APPLIED_LABEL]);
  }
  if (steps.labelPr) await write(io, ["pr", "edit", String(args.pr), "--add-label", APPLIED_LABEL]);
  // 4. Last, so an interruption leaves a draft the next run finishes.
  if (steps.ready) await write(io, ["pr", "ready", String(args.pr)]);
  return {
    commented: steps.comment,
    unblocked: steps.unblock.length > 0,
    labelled: steps.labelIssue || steps.labelPr,
    readied: steps.ready,
  };
}

/* --------------------------------------------------------------------------
 * CLI. An operator runs this; no loop does.
 * ----------------------------------------------------------------------- */

export interface CommandDeps {
  /** Built lazily, so a usage error needs no tracker and an unconnected one exits 69. */
  tracker: () => Tracker;
  gh: Gh;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runMigrationApplied(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const raw = argv[0];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || argv.length !== 1) {
    deps.err(`usage: bun migration-applied.ts <issue>`);
    return EXIT.usage;
  }
  const ticket = Number(raw);
  let tracker: Tracker | null = null;
  try {
    tracker = deps.tracker();
    const issue = await tracker.issue(ticket);
    const found = migrationPr(ticket, issue.comments);
    if ("refuse" in found) {
      deps.err(`${PREFIX}: refused: ${found.refuse}`);
      return EXIT.refused;
    }
    const io: Io = { tracker, gh: deps.gh };
    const pr = await readPr(found.pr, io);
    const steps = decide({ ticket, comments: issue.comments, labels: issue.labels, pr });
    const outcome = await apply({ ticket, pr: found.pr }, steps, io);
    const done = [
      outcome.commented ? "commented" : null,
      outcome.unblocked ? "unblocked" : null,
      outcome.labelled ? "labelled" : null,
      outcome.readied ? "readied" : null,
    ].filter((step) => step !== null);
    deps.out(`${PREFIX}: ${tracker.ref(ticket)} PR #${found.pr} — ${done.length === 0 ? "nothing to do" : done.join(", ")}`);
    return EXIT.ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TrackerUnavailableError) {
      deps.err(`${PREFIX}: ${message}`);
      return EXIT.unavailable;
    }
    // A throttle is time, not a fault, whether `gh` or the tracker raised it.
    if (isRateLimited(error) || (tracker !== null && tracker.classifyFailure(error) !== null)) {
      deps.err(`${PREFIX}: rate limited: ${message}`);
      return EXIT.throttled;
    }
    deps.err(`${PREFIX}: ${message}`);
    return EXIT.refused;
  }
}

async function main(): Promise<number> {
  // Anchored as `ci-doctor/unpark.ts` is: unanchored, every `gh` call answers
  // for whatever directory this was invoked from.
  process.chdir(projectRoot());
  const root = process.cwd();
  return runMigrationApplied(process.argv.slice(2), {
    tracker: () => createTracker(loadProjectConfig(root), { projectId: currentProjectId(root) }),
    gh: ghRunner,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`${PREFIX}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = isRateLimited(error) ? RATE_LIMITED_EXIT : EXIT.refused;
    });
}
