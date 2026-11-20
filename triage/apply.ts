/**
 * Making the writes: paced, idempotent, and stoppable at any point.
 *
 * By the time this runs the plan has been validated and simulated, so the
 * question here is no longer "should this happen" but "what happens when it
 * stops halfway". Three answers, and they are the whole module:
 *
 * - **Paced.** One write at a time, spaced, because a burst is what GitHub's
 *   secondary limit is for. A 403 stops the apply where it stands rather than
 *   retrying into it.
 * - **Idempotent.** Every op carries an id. Label and section writes are
 *   idempotent against the census that was just read — an `add-label` of a
 *   label the issue already has is not a write. Comments and issue creations
 *   cannot be, so they carry the id in a marker and are looked up before they
 *   are made.
 * - **Reversible at the body level.** Every section edit keeps a before-image,
 *   so the caller can put the bodies back if the frontier cannot read the
 *   result.
 *
 * Every GitHub call goes through the injected `gh`, so the whole engine is
 * testable without a network.
 */
import { classifyRateLimit, type RateLimitSignal } from "../frontier/github-rate-limit";
import {
  UNBLOCK_MARKER_OP,
  blockedLoopOf,
  formatTriageMarker,
  leadsWithUnblock,
  triageBodyHash,
} from "../triage-marker";
import { applySection } from "./body";
import { carriesOpMarker, issueBodyWithOpMarker, withOpMarker } from "./body";
import { appendLedger, createdIssues, doneOps, readLedger, type LedgerEntry } from "./ledger";
import type { Step } from "./order";
import { DUPLICATE_LABEL, isRefLabelOp, unblockFor, type ApplyOp, type TriagePlan } from "./plan";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ApplyIo {
  gh(args: string[]): Promise<GhResult>;
  sleep(ms: number): Promise<void>;
  now(): string;
}

/** What the apply knows about an issue before it touches it, from the census. */
export interface IssueState {
  body: string;
  labels: Set<string>;
}

export interface ApplyContext {
  plan: TriagePlan;
  steps: readonly Step[];
  io: ApplyIo;
  /** Path of the JSONL ledger for this unit. */
  ledger: string;
  spacingMs: number;
  /** The census's view of every issue the plan writes to. */
  state: Map<number, IssueState>;
}

export interface ApplyReport {
  outcome: "applied" | "rate-limited" | "failed";
  performed: number;
  skipped: number;
  /** Plan-local ref to the issue number it became. */
  created: Map<string, number>;
  /** Issue number to the body it had before this apply changed it. */
  beforeImages: Map<number, string>;
  problem: string | null;
  rateLimit: RateLimitSignal | null;
}

/** GitHub said no because of a rate limit; anything else is an ordinary failure. */
class RateLimited extends Error {
  constructor(readonly signal: RateLimitSignal) {
    super(`rate limited: ${signal.kind}`);
  }
}

export async function applySteps(context: ApplyContext): Promise<ApplyReport> {
  const ledgerEntries = readLedger(context.ledger);
  const done = doneOps(ledgerEntries);
  const created = createdIssues(ledgerEntries);
  const refs = new Map<string, number>();
  for (const [opId, issue] of created) {
    const step = context.steps.find((candidate) => candidate.op.opId === opId);
    if (step !== undefined && step.op.op === "create-issue") refs.set(step.op.ref, issue);
  }

  const report: ApplyReport = {
    outcome: "applied",
    performed: 0,
    skipped: 0,
    created: refs,
    beforeImages: new Map(),
    problem: null,
    rateLimit: null,
  };

  let first = true;
  for (const { op } of context.steps) {
    if (done.has(op.opId)) {
      report.skipped += 1;
      continue;
    }
    // Spacing goes BEFORE the write and only between real ones: a rerun that
    // skips twenty already-applied ops should not sleep thirty seconds first.
    if (!first) await context.io.sleep(context.spacingMs);
    first = false;

    try {
      const entry = await perform(op, context, report);
      appendLedger(context.ledger, { ...entry, opId: op.opId, at: context.io.now() });
      if (entry.result === "applied") report.performed += 1;
      else report.skipped += 1;
    } catch (error) {
      if (error instanceof RateLimited) {
        report.outcome = "rate-limited";
        report.rateLimit = error.signal;
        report.problem = `stopped at ${op.opId}: ${error.message}`;
      } else {
        report.outcome = "failed";
        report.problem = `stopped at ${op.opId}: ${error instanceof Error ? error.message : String(error)}`;
      }
      return report;
    }
  }
  return report;
}

type Outcome = Pick<LedgerEntry, "op" | "result"> & Partial<Pick<LedgerEntry, "issue" | "commentId" | "detail">>;

async function perform(op: ApplyOp, context: ApplyContext, report: ApplyReport): Promise<Outcome> {
  if (isRefLabelOp(op)) {
    const issue = report.created.get(op.ref);
    if (issue === undefined) throw new Error(`no issue was created for ref ${op.ref}`);
    return addLabel(issue, op.label, op.op, context);
  }

  switch (op.op) {
    case "add-label":
      return addLabel(op.issue, op.label, op.op, context);

    // The same write, kept as two ops because they are two different
    // permissions: `remove-label` may not touch a `*-blocked` at all, and
    // `unblock` may touch nothing else. `validate.ts` holds that line; by the
    // time a step reaches here it has been earned, and what is left is one
    // idempotent `gh issue edit`.
    case "remove-label":
    case "unblock": {
      const state = context.state.get(op.issue);
      if (state !== undefined && !state.labels.has(op.label)) {
        return { op: op.op, result: "skipped", detail: `#${op.issue} does not carry ${op.label}` };
      }
      await run(context, ["issue", "edit", String(op.issue), "--remove-label", op.label]);
      state?.labels.delete(op.label);
      return { op: op.op, result: "applied" };
    }

    case "set-section": {
      const state = context.state.get(op.issue);
      if (state === undefined) throw new Error(`no census body for #${op.issue}`);
      const next = applySection(state.body, op.heading, op.mode, op.body);
      // Against the NORMALISED body: `applySection` folds CRLF away, and
      // GitHub's web editor emits CRLF routinely, so comparing against the raw
      // census body would rewrite every such issue on every rerun.
      if (next === state.body.replace(/\r\n/g, "\n")) {
        return { op: op.op, result: "skipped", detail: `#${op.issue} already reads that way` };
      }
      if (!report.beforeImages.has(op.issue)) report.beforeImages.set(op.issue, state.body);
      await run(context, ["issue", "edit", String(op.issue), "--body", next]);
      state.body = next;
      return { op: op.op, result: "applied" };
    }

    case "comment": {
      const body = withOpMarker(unblockStamped(op, context), op.opId);
      if (await alreadyCommented(op.issue, op.opId, context)) {
        return { op: op.op, result: "skipped", detail: "a comment with this op id is already posted" };
      }
      const posted = await run(context, ["issue", "comment", String(op.issue), "--body", body]);
      return { op: op.op, result: "applied", commentId: posted.stdout.trim() || undefined };
    }

    case "create-issue": {
      const existing = await alreadyCreated(op.opId, context);
      if (existing !== null) {
        report.created.set(op.ref, existing);
        return { op: op.op, result: "skipped", issue: existing, detail: "an issue with this op id exists" };
      }
      const args = ["issue", "create", "--title", op.title, "--body", issueBodyWithOpMarker(op.body, op.opId)];
      for (const label of op.labels ?? []) args.push("--label", label);
      const result = await run(context, args);
      const number = issueNumberOf(result.stdout);
      if (number === null) throw new Error(`could not read the new issue number from ${result.stdout.trim()}`);
      report.created.set(op.ref, number);
      context.state.set(number, {
        body: issueBodyWithOpMarker(op.body, op.opId),
        labels: new Set(op.labels ?? []),
      });
      return { op: op.op, result: "applied", issue: number };
    }

    case "add-blocker": {
      const blocker =
        typeof op.blockedBy === "number" ? op.blockedBy : report.created.get(op.blockedBy);
      if (blocker === undefined) throw new Error(`no issue was created for ref ${String(op.blockedBy)}`);
      // Asked of GitHub, not only of the ledger: a rerun in a fresh worktree
      // has no ledger, and re-POSTing a dependency that exists is an error that
      // would stop the apply short of the writes still outstanding.
      const existing = await run(context, [
        "api",
        `repos/{owner}/{repo}/issues/${op.issue}/dependencies/blocked_by`,
        "--jq",
        "[.[].number]",
      ]);
      if (numbersIn(existing.stdout).includes(blocker)) {
        return { op: op.op, result: "skipped", detail: `#${op.issue} is already blocked by #${blocker}` };
      }
      const id = await run(context, ["api", `repos/{owner}/{repo}/issues/${blocker}`, "--jq", ".id"]);
      // `-F`, not `-f`: the endpoint takes issue_id as an integer, `-f` sends
      // every value as a string, and GitHub answers that with a 422 (#780).
      await run(context, [
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/issues/${op.issue}/dependencies/blocked_by`,
        "-F",
        `issue_id=${id.stdout.trim()}`,
      ]);
      return { op: op.op, result: "applied", detail: `#${op.issue} blocked by #${blocker}` };
    }

    case "close": {
      const state = await run(context, ["issue", "view", String(op.issue), "--json", "state", "--jq", ".state"]);
      if (state.stdout.trim() === "CLOSED") {
        return { op: op.op, result: "skipped", detail: `#${op.issue} is already closed` };
      }
      const args = ["issue", "close", String(op.issue)];
      if (op.evidence.kind === "duplicate-of") {
        // A duplicate is NOT planned work that got done, and GitHub renders the
        // two differently everywhere. The `duplicate` label goes on first, in a
        // write of its own, so the reason survives a reader who only sees
        // labels — and so a rerun that dies between the two still closes.
        await addLabel(op.issue, DUPLICATE_LABEL, "add-label", context);
        args.push("--reason", "not planned");
      }
      if (op.comment !== undefined) args.push("--comment", withOpMarker(op.comment, op.opId));
      await run(context, args);
      return { op: op.op, result: "applied" };
    }

    // A Linear or Jira project's Slack-intake ops. `validate.ts` refuses them
    // on GitHub before anything is applied, so reaching here is a bug.
    case "propose":
    case "to-person":
      throw new Error(`triage op "${op.op}" is unreachable on GitHub: the validator refuses it`);
  }
}

/**
 * The unblock's comment, with its `op=unblock` triage marker appended — that
 * marker being the only durable record that this ticket has been rescued
 * (felipearos/ralph#150).
 *
 * Stamped HERE rather than written into the plan because the marker carries
 * `triageBodyHash` of the issue body — a truncated sha256 no model can produce
 * by hand — so a plan required to supply one would be refused every time.
 *
 * It does NOT make the count safer than a plan-written marker would: this
 * comment is posted in the `comment` phase and the label comes off in the
 * `unblock` phase after it (`order.ts`), so a `gh` failure in between leaves
 * the marker posted and the block in place either way. That costs the ticket a
 * rescue slot it did not spend, which is the direction to fail in — but it is
 * the ordering that decides that, not where the marker is written.
 *
 * The body it hashes is the state as of this step, which the `set-section`
 * before it has already rewritten: a rescue's decision was made about the
 * re-specified ticket, not the one the coder gave up on. A ticket the census
 * gave no body for throws rather than hashing the empty string — the same
 * policy as `set-section` ten lines up, and for a sharper reason: a marker
 * pinned to nothing is a rescue COUNT entry that can never match a real body.
 *
 * `validate.ts` guarantees exactly one comment leads with the line, so this
 * cannot stamp two markers and count one rescue as two.
 */
function unblockStamped(op: Extract<ApplyOp, { op: "comment" }>, context: ApplyContext): string {
  const unblock = unblockFor(context.plan, op.issue);
  if (unblock === null) return op.body;
  const loop = blockedLoopOf(unblock.label);
  if (loop === null || !leadsWithUnblock(op.body, loop)) return op.body;

  const state = context.state.get(op.issue);
  if (state === undefined) throw new Error(`no census body for #${op.issue}`);
  const marker = formatTriageMarker(
    { attempt: context.plan.attempt, outcome: context.plan.outcome, body: triageBodyHash(state.body) },
    { loop: context.plan.loop, unit: context.plan.unit, op: UNBLOCK_MARKER_OP, labels: [unblock.label] },
  );
  return `${op.body}\n\n${marker}`;
}

async function addLabel(
  issue: number,
  label: string,
  op: ApplyOp["op"],
  context: ApplyContext,
): Promise<Outcome> {
  const state = context.state.get(issue);
  if (state !== undefined && state.labels.has(label)) {
    return { op, result: "skipped", detail: `#${issue} already carries ${label}` };
  }
  await run(context, ["issue", "edit", String(issue), "--add-label", label]);
  state?.labels.add(label);
  return { op, result: "applied" };
}

/**
 * The marker lookup that covers the gap the ledger cannot: the line recording a
 * write is appended AFTER the write, so a kill in between leaves a comment with
 * no record of it. GitHub itself is the record in that window.
 */
async function alreadyCommented(issue: number, opId: string, context: ApplyContext): Promise<boolean> {
  const read = await run(context, [
    "issue",
    "view",
    String(issue),
    "--json",
    "comments",
    "--jq",
    ".comments[].body",
  ]);
  return carriesOpMarker(read.stdout, opId);
}

async function alreadyCreated(opId: string, context: ApplyContext): Promise<number | null> {
  const read = await run(context, [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    "50",
    "--search",
    `"ralph:triage-op id=${opId}" in:body`,
    "--json",
    "number,body",
  ]);
  let rows: { number: number; body: string }[];
  try {
    rows = JSON.parse(read.stdout || "[]") as { number: number; body: string }[];
  } catch {
    return null;
  }
  const found = rows.find((row) => carriesOpMarker(row.body, opId));
  return found?.number ?? null;
}

/** The issue numbers in a `--jq '[.[].number]'` answer; anything unreadable is none. */
function numbersIn(stdout: string): number[] {
  try {
    const parsed = JSON.parse(stdout || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : [];
  } catch {
    return [];
  }
}

/** `gh issue create` prints the new issue's URL; the number is its last segment. */
export function issueNumberOf(stdout: string): number | null {
  const match = /\/(\d+)\s*$/.exec(stdout.trim());
  return match === null ? null : Number(match[1]);
}

async function run(context: ApplyContext, args: string[]): Promise<GhResult> {
  const result = await context.io.gh(args);
  if (result.ok) return result;
  const message = `${result.stderr}\n${result.stdout}`.trim();
  const signal = classifyRateLimit(message);
  if (signal !== null) throw new RateLimited(signal);
  throw new Error(message === "" ? `gh ${args[0]} failed` : message);
}

/**
 * Put back every body this apply changed.
 *
 * The last resort, for a frontier that cannot read the result: the plan passed
 * the simulation, so a real frontier that throws means the world moved under
 * it, and a backlog no loop can select from is worse than an untriaged issue.
 * Labels and comments are deliberately NOT reverted — a label is visible and
 * harmless, and deleting a comment destroys the only trace of what happened.
 */
export async function restoreBodies(
  beforeImages: ReadonlyMap<number, string>,
  context: Pick<ApplyContext, "io" | "spacingMs">,
): Promise<{ restored: number[]; failed: number[] }> {
  const restored: number[] = [];
  const failed: number[] = [];
  let first = true;
  for (const [issue, body] of beforeImages) {
    if (!first) await context.io.sleep(context.spacingMs);
    first = false;
    const result = await context.io.gh(["issue", "edit", String(issue), "--body", body]);
    if (result.ok) restored.push(issue);
    else failed.push(issue);
  }
  return { restored, failed };
}
