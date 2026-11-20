#!/usr/bin/env bun
/**
 * Put a coder ticket parked on a flake back in front of its coder.
 *
 * When CI goes red a fourth time on a test the diff does not touch, `prompt.md`
 * §5.4 has the coder block the ticket `blocked: PR #<pr> red on a flaky test
 * (<file>), not the diff`, and §6 has it park the finished work as a draft
 * (loggd #1557/PR #1681, #1574/PR #1662, #1537/PR #1710). That is the right
 * move and it is also a dead end: `frontier-gate.ts:202` skips drafts, so a
 * stamped draft is never shepherded again, and the `<loop>-blocked` label
 * hides the ticket from every frontier. Good work, finished, invisible.
 *
 * This is the way back out, and the ci-doctor is the one that may take it,
 * because it is the only agent that can say the test rather than the diff was
 * at fault. Three writes, in an order where a crash between any two is
 * harmless:
 *
 *   1. comment the diagnosis on the issue, carrying a marker;
 *   2. drop the owner's `<loop>-blocked`;
 *   3. `gh pr ready <pr>`, which makes the pull request shepherdable again.
 *
 * Step 3 is last on purpose. Interrupted before it, the ticket is unblocked
 * and the pull request is still a draft that nobody shepherds — visibly
 * unfinished, and the next poll completes it. In the other order an
 * interruption would leave a ready pull request on a ticket still labelled
 * blocked, which reads as done to everything that looks.
 *
 * Two things decide, and they are deliberately different:
 *
 * - **What is left to do** is read off GitHub each run: the marker in the
 *   comments, the label on the issue, the draft flag on the pull request. Not
 *   one of the three steps is taken because a previous run said so. That is
 *   what makes a second run write nothing (AC 1) and a killed run finish
 *   (AC 2) without either answer being a special case.
 * - **The budget** — one unpark per (ticket, diagnosis), two per ticket ever —
 *   is counted off the issue's comments too, not off the ci-health store. The
 *   store says in its own header (`store.ts:7-12`) that it is a cache which
 *   may be deleted and rebuilt from a scan; a budget kept only there would
 *   reset with it, and the thing it is protecting is a coder's attention.
 *
 * The store record is still written, last of all, because
 * `ci-doctor/gate.ts:184-197 actionable` reads it to stop offering a ticket it
 * has already unparked for this diagnosis. This module is the first writer of
 * `Case.unparks`, whose reader has been waiting at `store.ts:107`, read by `ci-doctor/gate.ts:194`.
 *
 * What the doctor may not do, and what the code therefore cannot express: it
 * never removes a `-wip` (the claim is the coder's), and it never pushes,
 * rebases, requeues or closes a coder's pull request. The only label verb here
 * is `--remove-label` on a `*-blocked`, and the only `pr` verb is `ready`.
 *
 * felipearos/ralph#155.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { blockReasonOf, type BlockKind, type IssueComment } from "../block-reason";
import { provenance } from "../frontier-gate";
import { isRateLimited, RATE_LIMITED_EXIT } from "../frontier/github-rate-limit";
// `frontier/next-tasks` is already in this module's static graph — `provenance`
// comes from `frontier-gate.ts`, which imports it — so there is no cycle to
// dodge here and no reason to keep a second copy of the label.
import { stuckLabelFor } from "../frontier/next-tasks";
import { projectRoot } from "../paths";

// `flagValue` rather than a fourth copy of it: `case-issue.ts` already exports
// the same six lines, and nothing in it imports this module.
import { flagValue } from "./case-issue";
import { throttled, write } from "./gh";
import type { Gh } from "./gate";
import { ghRunner, parkedCase } from "./gate";
import { storePathFromGit, withStore, type Case, type CiHealthStore } from "./store";

/** How many times one ticket may ever be unparked, however many flakes it meets. */
export const MAX_UNPARKS_PER_TICKET = 2;

/**
 * The searchable half of an unpark marker: the diagnosis as a hash.
 *
 * A case key is `flake:src/a.test.ts > flaps` — quotes, spaces, `>`, `/` — so
 * it cannot go in an HTML comment attribute unescaped and cannot be searched
 * for. `caseToken` in `case-issue.ts:81-83` makes the same trade for the same
 * reason, at the same 16 hex characters, which is the width GitHub's search
 * matches exactly.
 */
export const diagnosisToken = (diagnosis: string): string =>
  createHash("sha256").update(diagnosis).digest("hex").slice(0, 16);

/** `<!-- ci-doctor unpark ticket=1557 diagnosis=0f1e… -->` — the durable record that this unpark happened. */
export const unparkMarker = (ticket: number, diagnosis: string): string =>
  `<!-- ci-doctor unpark ticket=${ticket} diagnosis=${diagnosisToken(diagnosis)} -->`;

/**
 * The marker a REFUSAL carries, when the budget is spent and the doctor only
 * comments.
 *
 * A separate marker rather than the same one: an `unpark` marker is what the
 * budget counts, so writing one for a refusal would spend the allowance the
 * refusal is reporting. This one only stops the refusal being commented again
 * on every poll.
 */
export const declinedMarker = (ticket: number, diagnosis: string): string =>
  `<!-- ci-doctor unpark-declined ticket=${ticket} diagnosis=${diagnosisToken(diagnosis)} -->`;

const MARKER = /<!--\s*ci-doctor unpark ticket=(\d+) diagnosis=([0-9a-f]{16})\s*-->/g;

/**
 * The same pattern without `g`, for a one-shot test.
 *
 * `MARKER` carries `g` because `matchAll` requires it, and `RegExp.test` on a
 * global regex advances `lastIndex` — so testing with `MARKER` would answer
 * differently on the second call. The cheapest way not to have that bug is not
 * to share the object.
 */
const ANY_MARKER = /<!--\s*ci-doctor unpark(?:-declined)? ticket=\d+ diagnosis=[0-9a-f]{16}\s*-->/;

/**
 * A `flake:` case key, and only that.
 *
 * `ci-doctor/store.ts:196` declares five case kinds, but `actionable` builds
 * exactly one shape of diagnosis key — `flake:${testId}` (`gate.ts:186`) — so a
 * `regression:` or `pr-specific:` key here would be recorded under a key the
 * gate never looks up, and the ticket would be offered on every poll with the
 * record sitting right there. Free text is worse still: `subjectOrNull` would
 * derive a null `rule`, and the gate never re-reads a ticket it already has a
 * case for (`gate.ts:592-598`), so that ticket goes blind for good.
 */
const CASE_KEY = /^flake:\S/;

/**
 * Each diagnosis this ticket has been unparked for, and the index of the
 * newest comment that records it.
 *
 * The index, not the timestamp. `gh issue view --json comments` lists oldest
 * first, so position alone answers the one question that needs an ordering —
 * has the coder parked this ticket AGAIN since the unpark? — without trusting
 * a `createdAt` that may be absent, and without a clock.
 *
 * Keyed on the ticket number as well as the hash, because a comment may quote
 * another ticket's marker — a hand-off note, a mirrored block — and a quoted
 * marker must not spend this ticket's budget.
 */
export function markerIndex(ticket: number, comments: readonly IssueComment[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const [at, comment] of comments.entries()) {
    for (const found of comment.body.matchAll(MARKER)) {
      if (Number(found[1]) === ticket) seen.set(found[2]!, at);
    }
  }
  return seen;
}

/**
 * The kind of the newest block record written AFTER the comment at `since`, or
 * null when there is none — i.e. was the ticket parked AGAIN since the unpark
 * that was supposed to clear it, and if so, what for?
 *
 * This is the distinction the whole decision turns on, and the one state that
 * is otherwise invisible: a chronic flake's steady state. Unparked once, the
 * pull request goes red on the same test four more times and the coder parks
 * it again — draft, `<loop>-blocked`, a fresh block comment. On GitHub that
 * looks EXACTLY like an unpark interrupted after step 1: marker present, label
 * present, draft. Read as a resume it would be silently unparked again, with
 * no comment, no store record and no bound, for as long as the test stays
 * flaky.
 *
 * The KIND matters as well as the fact, because the two refusals it leads to
 * are different and a reader deserves the right one. A newer `ci-flake` is a
 * re-park on the same flake, which "one unpark per (ticket, diagnosis)"
 * refuses. A newer `migration` or `other` is the ticket having become somebody
 * else's problem — a person with database access, or a human who looked — and
 * unparking over either would undo their decision.
 *
 * The doctor's own comments cannot be mistaken for a block record: they lead
 * `unparked:` and `unpark-declined:`, and `blockReasonOf` reads only the first
 * line and only `needs-migration` or `blocked:` as a record.
 */
function reparkedAs(comments: readonly IssueComment[], since: number): BlockKind | null {
  for (const comment of comments.slice(since + 1).reverse()) {
    const reason = blockReasonOf(comment);
    if (reason !== null) return reason.kind;
  }
  return null;
}

/** The loop a pull request body is stamped for, lowercased, or null when it carries no provenance line. */
export const ownerOf = (body: string | null): string | null =>
  provenance().exec(body ?? "")?.[1]?.toLowerCase() ?? null;

export interface UnparkIo {
  gh: Gh;
}

export interface StoreIo {
  path: string;
  /** `withStore`, injected so the tests can hold a real temp store. */
  with: <T>(path: string, critical: (store: CiHealthStore) => T) => Promise<T>;
}

/* --------------------------------------------------------------------------
 * The reads. Each one is a fault when it fails: deciding from a half-read
 * ticket is how a second comment gets written.
 * ----------------------------------------------------------------------- */

export interface Parked {
  comments: IssueComment[];
  labels: string[];
}

const commentsOf = (raw: unknown): IssueComment[] =>
  Array.isArray(raw)
    ? raw.flatMap((row) => {
        const body = (row as { body?: unknown }).body;
        if (typeof body !== "string") return [];
        const at = (row as { createdAt?: unknown }).createdAt;
        return [{ body, createdAt: typeof at === "string" ? at : undefined }];
      })
    : [];

const labelsOf = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.flatMap((row) => {
        const name = (row as { name?: unknown }).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];

/** The ticket's comments and labels, in one `gh` call, because both decide the same run. */
export async function readParked(ticket: number, io: UnparkIo): Promise<Parked> {
  const args = ["issue", "view", String(ticket), "--json", "comments,labels"];
  const ran = await io.gh(args);
  // A throttled READ is time, not a fault, exactly as a throttled write is: a
  // 403 burst on `gh issue view` is routine on a busy host, and reported as a
  // fault it stops the loop for a human instead of being waited out.
  if (!ran.ok) throttled(`could not read #${ticket}: ${`${ran.stderr}\n${ran.stdout}`.trim()}`, args);
  try {
    const parsed = JSON.parse(ran.stdout || "{}") as { comments?: unknown; labels?: unknown };
    return { comments: commentsOf(parsed.comments), labels: labelsOf(parsed.labels) };
  } catch {
    throw new Error(`could not read #${ticket}`);
  }
}

export interface Draft {
  isDraft: boolean;
  body: string | null;
}

export async function readDraft(pr: number, io: UnparkIo): Promise<Draft> {
  const args = ["pr", "view", String(pr), "--json", "isDraft,body"];
  const ran = await io.gh(args);
  if (!ran.ok) throttled(`could not read PR #${pr}: ${`${ran.stderr}\n${ran.stdout}`.trim()}`, args);
  try {
    const parsed = JSON.parse(ran.stdout || "{}") as { isDraft?: unknown; body?: unknown };
    return {
      isDraft: parsed.isDraft === true,
      body: typeof parsed.body === "string" ? parsed.body : null,
    };
  } catch {
    throw new Error(`could not read PR #${pr}`);
  }
}

/* --------------------------------------------------------------------------
 * The decision. Pure, so every branch is a unit test rather than a fixture
 * of `gh` calls.
 * ----------------------------------------------------------------------- */

export type Decision =
  /** Steps to take. Each flag is what the READ state says is outstanding, never what a previous run claimed. */
  | { act: "unpark"; comment: boolean; removeLabel: string | null; ready: boolean; resuming: boolean }
  /** Every step already done. */
  | { act: "nothing"; why: string }
  /** The budget is spent: comment the diagnosis and touch nothing. */
  | { act: "declined"; comment: boolean; why: string; prior: number }
  /** Something the doctor must not guess at. */
  | { act: "fault"; why: string };

export function decide(args: {
  ticket: number;
  diagnosis: string;
  owner: string | null;
  comments: readonly IssueComment[];
  labels: readonly string[];
  isDraft: boolean;
  max?: number;
}): Decision {
  const max = args.max ?? MAX_UNPARKS_PER_TICKET;
  const markers = markerIndex(args.ticket, args.comments);
  const mine = markers.get(diagnosisToken(args.diagnosis));
  const blocked = args.labels.filter((on) => on.endsWith("-blocked"));

  // "Nothing to do" is asked FIRST, and from the three steps alone: this
  // ticket's marker is on it, no block label is, and the pull request is
  // ready. Nothing below can change that answer, and asking anything else
  // first is how a completed unpark comes back to write a second comment — the
  // one write AC 1 forbids.
  if (mine !== undefined && blocked.length === 0 && !args.isDraft) {
    return { act: "nothing", why: `#${args.ticket} is already unparked for this diagnosis` };
  }

  const declined = (): boolean =>
    args.comments.some((comment) => comment.body.includes(declinedMarker(args.ticket, args.diagnosis)));

  // Unparked for this diagnosis and NOT parked again since: the first unpark is
  // unfinished, and finishing it is not a second one.
  const again = mine === undefined ? null : reparkedAs(args.comments, mine);
  if (again !== null) {
    return {
      act: "declined",
      comment: !declined(),
      why:
        again === "ci-flake"
          ? `#${args.ticket} was unparked for this diagnosis and parked on a flake again; the budget is one unpark per diagnosis`
          : `#${args.ticket} was unparked for this diagnosis and blocked again as ${again}, which is not the doctor's to clear`,
      prior: markers.size,
    };
  }
  const resuming = mine !== undefined;
  if (!resuming && markers.size >= max) {
    return {
      act: "declined",
      comment: !declined(),
      why: `#${args.ticket} has been unparked ${markers.size} times; the budget is ${max}`,
      prior: markers.size,
    };
  }

  // The owner names the label to drop. A ticket whose block label is already
  // gone needs no owner at all, which is what lets a resume survive an edited
  // pull request body.
  const label = args.owner === null ? null : stuckLabelFor(args.owner);
  const foreign = blocked.filter((on) => on !== label);
  if (foreign.length > 0) {
    // Never guess, and never half-finish. Readying the pull request while a
    // block label the doctor cannot attribute stays on would leave exactly the
    // state the write order exists to prevent: a ready pull request on a ticket
    // that still reads as blocked to everything that looks at it.
    return {
      act: "fault",
      why:
        `#${args.ticket} carries ${foreign.join(", ")}, which ` +
        (args.owner === null
          ? "no provenance line on the pull request accounts for"
          : `the pull request's own loop (${args.owner}) does not account for`) +
        " — whose block it is has to be read, not guessed (frontier-gate.ts:59-72)",
    };
  }

  return {
    act: "unpark",
    comment: !resuming,
    removeLabel: label !== null && args.labels.includes(label) ? label : null,
    ready: args.isDraft,
    resuming,
  };
}

/** The comment body: the verdict first, the evidence under it, the marker last. */
export function unparkComment(args: { ticket: number; diagnosis: string; evidence: string }): string {
  return [`unparked: ${args.diagnosis}`, args.evidence.trim(), unparkMarker(args.ticket, args.diagnosis)]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function declinedComment(args: { ticket: number; diagnosis: string; why: string; evidence: string }): string {
  return [
    `unpark-declined: ${args.diagnosis}`,
    args.why,
    args.evidence.trim(),
    declinedMarker(args.ticket, args.diagnosis),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/* --------------------------------------------------------------------------
 * The store record, written last.
 * ----------------------------------------------------------------------- */

/**
 * The diagnosis key the GATE will look this unpark up under, which is the only
 * key worth writing.
 *
 * `actionable` (`gate.ts:186,194`) builds `flake:${ticket.testId}`, and
 * `parkedTickets` (`gate.ts:619`) reads that test id back out of the parked
 * case's `rule` — which the gate derived from the coder's block comment with
 * `testIdOf`. The doctor's `--diagnosis` comes from its own scan instead, and
 * the two are routinely at different granularity: `testIdOf` returns the bare
 * FILE when the quoted `FAIL` line carries no `> title`, where a ci-health case
 * key is `flake:<file> > <test>`. Recorded under the doctor's spelling, the
 * gate's lookup misses, `actionable` stays non-null, and the ticket is offered
 * again on every poll — the exact failure the record exists to prevent, except
 * now invisible because the record looks present.
 *
 * So the case's own `rule` wins whenever it has one. Only a case this run is
 * creating takes the key from the argument.
 */
const diagnosisKeyFor = (value: Case | undefined, diagnosis: string): string =>
  value?.rule ? `flake:${value.rule}` : diagnosis;

/**
 * Record the unpark on the ticket's `parked:<n>` case, so the gate stops
 * offering it (`gate.ts:193-196`).
 *
 * Written only when the diagnosis is absent: one unpark per diagnosis, so a
 * resume must not append a second timestamp. (It cannot inflate the budget —
 * that is counted off GitHub — but a second timestamp would claim something
 * that did not happen.) A `parked:<n>` case the scan has not written yet is
 * created here: the doctor may be unparking a ticket whose block the store
 * lost, and leaving no record would have the gate offer it again.
 */
export async function recordUnpark(
  args: { ticket: number; diagnosis: string; at: string; testId?: string | null },
  store: StoreIo,
): Promise<boolean> {
  return store.with(store.path, (open) => {
    const key = `parked:${args.ticket}`;
    const value = open.cases[key] ?? parkedCase(args.testId ?? null);
    const diagnosis = diagnosisKeyFor(open.cases[key], args.diagnosis);
    if (value.unparks[diagnosis] !== undefined) return false;
    open.cases[key] = { ...value, unparks: { ...value.unparks, [diagnosis]: [args.at] } };
    return true;
  });
}

/* --------------------------------------------------------------------------
 * The writes.
 * ----------------------------------------------------------------------- */

export interface Outcome {
  kind: Decision["act"];
  why: string;
  commented: boolean;
  unblocked: boolean;
  readied: boolean;
  recorded: boolean;
}

export async function unpark(
  args: { ticket: number; pr: number; diagnosis: string; evidence: string; at: string; testId?: string | null },
  decision: Decision,
  io: UnparkIo,
  store: StoreIo,
): Promise<Outcome> {
  const idle = { commented: false, unblocked: false, readied: false, recorded: false };
  const record = (): Promise<boolean> =>
    recordUnpark({ ticket: args.ticket, diagnosis: args.diagnosis, at: args.at, testId: args.testId }, store);

  // A fault establishes nothing, so it records nothing. Every other outcome
  // has read the ticket and decided, and the store is where the gate reads
  // that decision.
  if (decision.act === "fault") return { kind: "fault", why: decision.why, ...idle };
  if (decision.act === "nothing") {
    // Recorded even though nothing was written. A completed unpark has dropped
    // the block label, so the ticket leaves the gate's parked search and this
    // write is not what stops it being re-offered forever — the label is. What
    // it closes is the window: the search answer is cached for 15 minutes
    // (`gh-budget.ts:34 PARKED`), so a poll inside it offers a ticket already
    // unparked, and a store that learns nothing hands the next iteration the
    // same answer.
    const recorded = await record();
    return { kind: "nothing", why: decision.why, ...idle, recorded };
  }
  if (decision.act === "declined") {
    if (decision.comment) {
      await write(io, [
        "issue",
        "comment",
        String(args.ticket),
        "--body",
        declinedComment({ ticket: args.ticket, diagnosis: args.diagnosis, why: decision.why, evidence: args.evidence }),
      ]);
    }
    // Recorded, like a `nothing`. A refused ticket KEEPS its block label, so it
    // stays in the gate's parked search (`gate.ts:578-582`) — and with the
    // refusal comment suppressed by its own marker, a run that writes neither
    // GitHub nor the store is offered again on every poll, silently, for good.
    // This is the branch where that loop is actually reachable.
    const recorded = await record();
    return { kind: "declined", why: decision.why, ...idle, commented: decision.comment, recorded };
  }

  // 1. The diagnosis, carrying the marker the next run reads.
  if (decision.comment) {
    await write(io, [
      "issue",
      "comment",
      String(args.ticket),
      "--body",
      unparkComment({ ticket: args.ticket, diagnosis: args.diagnosis, evidence: args.evidence }),
    ]);
  }
  // 2. The owner's block label, and nothing else. A `-wip` is the coder's claim.
  if (decision.removeLabel !== null) {
    await write(io, ["issue", "edit", String(args.ticket), "--remove-label", decision.removeLabel]);
  }
  // 3. Last, so an interruption leaves a draft the next poll finishes.
  if (decision.ready) {
    await write(io, ["pr", "ready", String(args.pr)]);
  }
  const recorded = await record();
  return {
    kind: "unpark",
    why: decision.resuming ? `resumed the unpark of #${args.ticket}` : `unparked #${args.ticket}`,
    commented: decision.comment,
    unblocked: decision.removeLabel !== null,
    readied: decision.ready,
    recorded,
  };
}

/* --------------------------------------------------------------------------
 * CLI. The doctor's prompt runs this; nothing else does.
 * ----------------------------------------------------------------------- */

const PREFIX = "unpark";

export interface CommandDeps {
  io: UnparkIo;
  store: StoreIo;
  now: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

function ticketArg(argv: readonly string[]): number {
  const raw = argv[0];
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${PREFIX} needs a ticket number, e.g. 1557`);
  return Number(raw);
}

function evidenceArg(argv: readonly string[], read: typeof readFileSync = readFileSync): string {
  const inline = flagValue(argv, "--evidence");
  if (inline !== null) return inline;
  const file = flagValue(argv, "--evidence-file");
  if (file === null) throw new Error(`${PREFIX} needs --evidence or --evidence-file`);
  return read(file, "utf8") as string;
}

/** `flake:src/a.test.ts > flaps` → `src/a.test.ts > flaps`, for a `parked:<n>` case this module has to create. */
const subjectOrNull = (diagnosis: string): string | null => {
  const at = diagnosis.indexOf(":");
  return at === -1 ? null : diagnosis.slice(at + 1) || null;
};

/**
 * `<ticket> --pr <n> --diagnosis <case key> (--evidence <t> | --evidence-file <f>)`.
 *
 * The whole argv is validated before the first read, as `case-issue.ts:605-612`
 * validates before it spends budget: a run that fails on a missing `--pr` after
 * commenting is the one shape of this command that cannot be re-run cleanly.
 */
export async function runUnpark(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const ticket = ticketArg(argv);
  const pr = flagValue(argv, "--pr");
  if (pr === null || !/^\d+$/.test(pr)) throw new Error(`${PREFIX} needs --pr <number>`);
  const diagnosis = flagValue(argv, "--diagnosis");
  if (diagnosis === null) throw new Error(`${PREFIX} needs --diagnosis, e.g. "flake:src/a.test.ts > flaps"`);
  // A flake case key, not free text — see `CASE_KEY` for why nothing else is
  // a key the gate can read.
  if (!CASE_KEY.test(diagnosis)) {
    throw new Error(`${PREFIX}: --diagnosis must be a flake case key, e.g. "flake:src/a.test.ts > flaps"`);
  }
  const evidence = evidenceArg(argv);
  // Every decision this module makes is read back off its own markers, so
  // evidence quoting one forges that decision: an unpark marker spends the
  // allowance the evidence is reporting on, and a refusal marker silences the
  // refusal for good.
  if (ANY_MARKER.test(evidence)) throw new Error(`${PREFIX}: --evidence must not contain a ci-doctor unpark marker`);

  const parked = await readParked(ticket, deps.io);
  const draft = await readDraft(Number(pr), deps.io);
  // The pull request has to be THIS ticket's. A transposed `--pr` would ready
  // an unrelated loop's draft, which is the one write the "never pushes,
  // rebases, requeues or closes a coder's PR" fence exists to make
  // unthinkable. §5.3 has every loop PR link its issue, so the link is free
  // evidence.
  if (!new RegExp(`#${ticket}\\b`).test(draft.body ?? "")) {
    deps.err(`${PREFIX}: PR #${pr} does not name #${ticket}, so it is not this ticket's parked work`);
    return 1;
  }
  const decision = decide({
    ticket,
    diagnosis,
    owner: ownerOf(draft.body),
    comments: parked.comments,
    labels: parked.labels,
    isDraft: draft.isDraft,
  });
  const outcome = await unpark(
    { ticket, pr: Number(pr), diagnosis, evidence, at: deps.now(), testId: subjectOrNull(diagnosis) },
    decision,
    deps.io,
    deps.store,
  );
  const steps = [
    outcome.commented ? "commented" : null,
    outcome.unblocked ? "unblocked" : null,
    outcome.readied ? "readied" : null,
    outcome.recorded ? "recorded" : null,
  ].filter((step) => step !== null);
  // The KIND leads the line, because `why` alone cannot be read back: a
  // declined run's reason opens "…was unparked for this diagnosis…", which is
  // exactly the word a reader would take for success. The doctor's prompt
  // (§2.3) tells it to journal the word printed here.
  const line = `${PREFIX}: ${outcome.kind}: ${outcome.why}${steps.length === 0 ? "" : ` — ${steps.join(", ")}`}`;
  if (outcome.kind === "fault") {
    deps.err(`${PREFIX}: ${outcome.why}`);
    return 1;
  }
  deps.out(line);
  return 0;
}

async function main(): Promise<number> {
  // Anchored as `ci-doctor/case-issue.ts:681-685` is, and for its reason:
  // unanchored, every `gh` and `git` probe answers for whatever directory this
  // was invoked from, so the comment would land on the harness's own
  // repository and the store written would be one the gate never reads.
  process.chdir(projectRoot());
  const storePath = storePathFromGit(process.cwd());
  return runUnpark(process.argv.slice(2), {
    io: { gh: ghRunner },
    store: { path: storePath, with: withStore },
    now: () => new Date().toISOString(),
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
      // A throttle is time, not a fault: `RATE_LIMITED_EXIT` is the code the
      // supervisor waits out instead of stopping for a human.
      process.exitCode = isRateLimited(error) ? RATE_LIMITED_EXIT : 1;
    });
}
