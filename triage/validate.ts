/**
 * The rules a triage plan cannot bend.
 *
 * Everything here is checked BEFORE the first GitHub write, and a plan that
 * fails any of it is refused whole: a partly-applied plan is the state nobody
 * can reason about. The rules are the ones the model is least able to police
 * itself on — whose labels it may touch, what counts as evidence for a close,
 * and whether a product decision it made was its to make.
 *
 * Pure. Every fact about the world arrives in the context: the census, the
 * labels that exist, the plan's fences, and two lookups the caller performs
 * (`readRule`, `duplicateTarget`). That is what lets the whole rule set be
 * tested without a network.
 */
import { latestBlockReason, rescuableBlock, withoutEmphasis, type IssueComment } from "../block-reason";
import { READY_LABEL, SPEC_LABEL, URGENT_LABEL, stuckLabelFor, type Ticket } from "../frontier/next-tasks";
import { sectionIfPresent } from "../sections";
import type { PlanFences } from "../frontier-gate";
import {
  BLOCKED_SUFFIX,
  DEFAULT_UNBLOCK_DAYS,
  MAX_UNBLOCKS,
  blockedLoopOf,
  firstLine,
  leadsWithUnblock,
  rescueBar,
  unblockLead,
} from "../triage-marker";
import { KEYED_INTAKE_OUTCOMES } from "./intake";
import { plannedWrites } from "./order";
import { DUPLICATE_LABEL, unblockFor, type SectionHeading, type TriageOp, type TriagePlan } from "./plan";

/** How much one plan may do. Bounds on a model's mistake, not on its ambition. */
export interface TriageLimits {
  maxWrites: number;
  maxNewIssues: number;
  /**
   * How long a rescued ticket is off the rescue bucket, in days.
   *
   * A bound on re-rescuing rather than on rescuing: a ticket that blocks again
   * the same afternoon is evidence the re-spec did not help, and offering it
   * straight back would spend iterations re-deciding the same thing.
   */
  unblockDays: number;
}

const positiveEnv = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export function triageLimits(env: Record<string, string | undefined> = process.env): TriageLimits {
  return {
    maxWrites: positiveEnv(env, "RALPH_TRIAGE_MAX_WRITES", 30),
    maxNewIssues: positiveEnv(env, "RALPH_TRIAGE_MAX_NEW_ISSUES", 6),
    unblockDays: positiveEnv(env, "RALPH_TRIAGE_UNBLOCK_DAYS", DEFAULT_UNBLOCK_DAYS),
  };
}

/**
 * Labels no triager may add or remove, whoever owns them. A loop's claim
 * triple is fenced separately, because the triager's OWN triple is legitimate.
 *
 * `priority:urgent` is here rather than in the role's vocabulary on purpose:
 * it reorders every other loop's work (felipearos/ralph#153), which is an
 * operator's decision and not a triage outcome.
 */
export const NEVER_TOUCHED_LABELS = ["queued", "dequeued", "ready-to-merge", URGENT_LABEL] as const;

const CLAIM_SUFFIXES = ["-wip", "-blocked", "-done"] as const;

export type DuplicateState =
  | { state: "open" }
  | { state: "closed"; completed: boolean }
  | { state: "unknown" };

export interface ValidationContext {
  plan: TriagePlan;
  /** The census, as `buildTickets` returned it. */
  tickets: Map<number, Ticket>;
  /** The project's owner; only their issues are acted on, because the rest is untrusted text. */
  owner: string;
  /** Every loop name on the project's roster, for the claim-label fence. */
  roster: readonly string[];
  /**
   * The loop this process IS, from `RALPH_LOOP_NAME`, or null when nothing said.
   *
   * Every other fence keyed on `plan.loop` trusts the plan's own word for who
   * wrote it, and `plan.loop` is a string a model types by hand. That is
   * load-bearing now that a plan's own claim exempts it from the foreign-claim
   * rules: `"loop": "rafa"` would buy a body write and a close on a ticket rafa
   * is working, and `release` would then take rafa's `-wip` off. So the identity
   * is checked once, here, against the environment rather than the plan.
   */
  loop: string | null;
  /** The labels that exist in the repository. */
  existingLabels: ReadonlySet<string>;
  /** The labels this role may apply, from `roleLabels` plus its own claim triple. */
  allowedLabels: ReadonlySet<string>;
  /**
   * The roster's coder loops. An `unblock` may lift a CODER's block and nothing
   * else: another triager's `-blocked` is a peer's hand-off to a person, and a
   * ci-doctor's is a CI fault no re-spec touches.
   */
  coders: readonly string[];
  /** The project's Jav difficulty labels, so a re-ROUTE is recognisable as one. */
  javLabels: readonly string[];
  fences: PlanFences;
  limits: TriageLimits;
  /** When this plan is being validated, for the rescue window. Defaults to now. */
  now?: Date;
  /**
   * An issue's comments in FULL, past the census tail, for the rescue cap, the
   * window and the block record — null when the read failed, which is a
   * refusal.
   *
   * Required, like `readRule` and `duplicateTarget`: this module's docblock
   * promises every fact about the world arrives in the context, and an optional
   * one would let production silently fall back to the tail, which is the exact
   * fail-open the full read exists to close. A caller with nothing better
   * passes `(n) => tickets.get(n)?.comments ?? []` and says so.
   */
  fullComments: (issue: number) => readonly IssueComment[] | null;
  /** The rule file's text at `origin/<baseBranch>`, or null when the path does not resolve. */
  readRule: (path: string) => string | null;
  /** The state of a `duplicate-of` target, looked up by the caller. */
  duplicateTarget: (issue: number) => DuplicateState;
}

/** Every rule the plan breaks. Empty means the plan may be simulated. */
export function validatePlan(context: ValidationContext): string[] {
  const problems: string[] = [];
  const { plan } = context;

  problems.push(...identityProblems(context));
  if (KEYED_INTAKE.has(plan.outcome)) {
    problems.push(`plan.outcome: "${plan.outcome}" ${KEYED_ONLY}`);
  }
  problems.push(...limitProblems(context));
  for (const [index, op] of plan.ops.entries()) {
    problems.push(...opProblems(op, `ops[${index}]`, context));
  }
  problems.push(...decisionProblems(context));

  return problems;
}

/**
 * Who the plan says it is has to be who is running it.
 *
 * A loop off the roster is refused too: `allowedLabelsFor` derives a claim
 * triple from the name, so an unrostered one would be given labels the project
 * does not have and fail op by op instead of at once.
 */
function identityProblems(context: ValidationContext): string[] {
  const { plan, loop, roster } = context;
  const problems: string[] = [];
  if (!roster.includes(plan.loop)) {
    problems.push(`plan.loop: "${plan.loop}" is not a loop on this project's roster`);
  }
  if (loop !== null && plan.loop !== loop) {
    problems.push(`plan.loop: "${plan.loop}" is not this loop ("${loop}"); a plan writes under its own name`);
  }
  return problems;
}

/**
 * The outcomes and ops a Linear or Jira project's Slack intake owns. A GitHub
 * plan carrying one is refused here, so nothing downstream of this validator
 * (`simulate.ts`, `order.ts`, `apply.ts`) ever has to run one.
 */
const KEYED_INTAKE = new Set<string>(KEYED_INTAKE_OUTCOMES);
const KEYED_ONLY = "is a Linear or Jira project's Slack-intake outcome; a GitHub triager may not use it";

function limitProblems(context: ValidationContext): string[] {
  const { plan, limits } = context;
  const problems: string[] = [];
  const creations = plan.ops.filter((op) => op.op === "create-issue").length;
  // Counted without the keyed ops, which `orderOps` has no phase for: they are
  // refused op by op below, and the cap is about the writes that remain.
  const writes = plannedWrites({ ...plan, ops: plan.ops.filter((op) => !KEYED_INTAKE.has(op.op)) });
  if (writes > limits.maxWrites) {
    problems.push(`plan: ${writes} mutations exceeds RALPH_TRIAGE_MAX_WRITES (${limits.maxWrites})`);
  }
  if (creations > limits.maxNewIssues) {
    problems.push(
      `plan: ${creations} new issues exceeds RALPH_TRIAGE_MAX_NEW_ISSUES (${limits.maxNewIssues})`,
    );
  }
  return problems;
}

function opProblems(op: TriageOp, path: string, context: ValidationContext): string[] {
  const problems: string[] = [];

  if (op.op === "create-issue") {
    for (const label of op.labels ?? []) {
      problems.push(...labelProblems(label, `${path}.labels`, context));
    }
    return problems;
  }

  // Everything else writes to an issue that must be in the census and the
  // owner's. An issue the read did not return is one nothing is known about —
  // it may be closed, a pull request, or in another repository.
  const ticket = context.tickets.get(op.issue);
  if (ticket === undefined) {
    return [`${path}.issue: #${op.issue} is not an open issue in this read`];
  }
  if (ticket.author !== context.owner) {
    // Fails closed on an unreadable author, as the frontier's owner fence does:
    // an issue whose author the read could not give is not provably the
    // owner's, and its body is untrusted text a triager would act on.
    return [
      `${path}.issue: #${op.issue} is authored by ${ticket.author ?? "an unreadable account"}, not ${context.owner}`,
    ];
  }

  switch (op.op) {
    case "add-label":
    case "remove-label":
      problems.push(...labelProblems(op.label, `${path}.label`, context));
      break;
    case "set-section":
      if (
        isClaimed(ticket, context.plan.loop) &&
        op.heading !== "Staffing group" &&
        // The rescue exemption covers the two headings that say what the work
        // IS, and no others. felipearos/ralph#150 grants it so a failed spec can
        // be rewritten; `Parent` and `Blocked by` are structure a block is no
        // evidence about, and rewriting them under the operator reading the
        // ticket is what the guardrail exists for.
        !(RESPEC_HEADINGS.includes(op.heading) && isRescue(op.issue, ticket, context))
      ) {
        problems.push(
          `${path}.heading: #${op.issue} is claimed; only "Staffing group" may be set on a claimed issue, not "${op.heading}"`,
        );
      }
      break;
    case "close":
      problems.push(...closeProblems(op, ticket, path, context));
      break;
    case "unblock":
      problems.push(...unblockProblems(op, ticket, path, context));
      break;
    case "add-blocker":
    case "comment":
      break;
    case "propose":
    case "to-person":
      problems.push(`${path}.op: "${op.op}" ${KEYED_ONLY}`);
      break;
  }
  return problems;
}

function labelProblems(label: string, path: string, context: ValidationContext): string[] {
  if ((NEVER_TOUCHED_LABELS as readonly string[]).includes(label)) {
    return [`${path}: "${label}" is never a triager's to set`];
  }
  const claim = claimLabelOwner(label, context.roster);
  if (claim !== null && claim !== context.plan.loop) {
    return [`${path}: "${label}" is ${claim}'s claim label`];
  }
  const problems: string[] = [];
  if (!context.existingLabels.has(label)) {
    problems.push(`${path}: "${label}" does not exist in this repository`);
  }
  if (!context.allowedLabels.has(label)) {
    problems.push(`${path}: "${label}" is outside this role's label set`);
  }
  return problems;
}

/** The loop a `<name>-wip|-blocked|-done` label belongs to, or null if it is not one. */
function claimLabelOwner(label: string, roster: readonly string[]): string | null {
  for (const suffix of CLAIM_SUFFIXES) {
    if (!label.endsWith(suffix)) continue;
    const name = label.slice(0, -suffix.length);
    if (roster.includes(name)) return name;
  }
  return null;
}

/**
 * In flight for SOMEBODY ELSE: a claim label or an assignee. Either makes the
 * body theirs.
 *
 * The plan's own `-wip` is exempt, and that exemption is what makes the rule
 * usable at all: the frontier claims a unit with `<loop>-wip` before the model
 * ever sees it, so every plan arrives with its own claim on the ticket. Without
 * the exemption a triager could not write a section on the issue it was handed
 * or close a duplicate it was handed — the two intake verdicts that need a body
 * write — while a foreign claim, which is the thing worth refusing, would be
 * caught by exactly the same check. `identityProblems` is what makes the exemption
 * safe: it costs nothing if `plan.loop` can be any name the model types.
 *
 * Its own `-blocked` is NOT exempt, and that asymmetry is deliberate. A `-wip` of
 * its own is this iteration's claim; a `-blocked` of its own is a past iteration
 * having given up and put the unit in front of a person. Rewriting the body of
 * that one, under the operator reading it, is the case the guardrails exist for.
 */
function isClaimed(ticket: Ticket, loop: string): boolean {
  if (ticket.assignees.length > 0) return true;
  for (const label of ticket.labels) {
    if (label === `${loop}-wip`) continue;
    if (label.endsWith("-wip") || label.endsWith("-blocked")) return true;
  }
  return false;
}

/**
 * The headings a rescue may rewrite: the two that say what the work IS. Typed
 * as `SectionHeading`, so a heading renamed in `plan.ts` is a type error here
 * rather than a rule that silently stops matching.
 */
const RESPEC_HEADINGS: readonly SectionHeading[] = ["What to build", "Acceptance criteria"];

/**
 * Whether this plan is rescuing `issue`, for the sake of the `set-section`
 * exemption — NOT whether the rescue is allowed.
 *
 * felipearos/ralph#150 lets a rescue replace `What to build` or `Acceptance
 * criteria` on a ticket its own block makes "claimed": the block is the
 * evidence that the spec was the thing at fault, so refusing to rewrite it
 * would refuse the only repair that helps. The narrowness is the safety. The
 * plan must actually contain the `unblock`, and the only thing claiming the
 * ticket must be the block — an assignee or ANOTHER loop's `-wip` is live work
 * and the body stays theirs.
 *
 * This plan's own `-wip` is exempt, for `isClaimed`'s reason: the frontier
 * writes that label before the model ever sees the unit, so every rescue plan
 * arrives with its own claim on the ticket and no rescue would ever pass.
 * `identityProblems` is what makes the exemption safe. Whether the `unblock`
 * itself survives its five
 * preconditions is `unblockProblems`'s question, and a plan is refused whole,
 * so an exemption taken under an `unblock` that gets refused buys nothing.
 */
function isRescue(issue: number, ticket: Ticket, context: ValidationContext): boolean {
  if (unblockFor(context.plan, issue) === null) return false;
  if (ticket.assignees.length > 0) return false;
  for (const label of ticket.labels) {
    if (label !== `${context.plan.loop}-wip` && label.endsWith("-wip")) return false;
  }
  return coderBlocks(ticket, context.coders).length === 1;
}

/** The coders' `<loop>-blocked` labels the ticket carries, in roster order. */
const coderBlocks = (ticket: Ticket, coders: readonly string[]): string[] =>
  coders.map(stuckLabelFor).filter((label) => ticket.labels.has(label));

/**
 * Text as a QUOTE of it would read: markdown blockquote markers dropped at any
 * depth, emphasis dropped the way `block-reason.ts` drops it, and whitespace
 * folded like `normalise`.
 *
 * Blockquotes, because the triager is told to quote the text it replaces, and
 * making it paste raw `- [ ]` lines to satisfy a containment check would put
 * live checkboxes in a comment.
 *
 * `withoutEmphasis`, because a `BlockReason.reason` has already been through
 * it: a coder
 * writing a file path in backticks — which is how they are written — would
 * otherwise make a faithful, verbatim quote fail the check, with a refusal
 * pointing at the one thing the triager did right. Applied to both sides for
 * the same reason, so neither normaliser is the odd one out.
 */
const quotable = (text: string): string =>
  normalise(withoutEmphasis(text.replace(/^[ \t]*(?:>[ \t]?)+/gm, "")));

/**
 * The three means by which a plan may earn an unblock, as the refusal names
 * them. Built from `RESPEC_HEADINGS` rather than spelling them again, so a
 * heading renamed in `plan.ts` moves the rule AND the message together.
 */
const respecMeans = (): string =>
  `a set-section on ${RESPEC_HEADINGS.map((heading) => `"${heading}"`).join(" or ")}, ` +
  `a comment with "amends": true, or a difficulty label change`;

/**
 * What a plan changed about a ticket, enough to earn an unblock — and, field by
 * field, what the unblock comment must therefore account for. Non-null IS the
 * answer to "did it change anything"; there is no separate verdict to drift
 * from the evidence.
 */
interface Respec {
  /** The `set-section`s whose replaced text the unblock comment must quote. */
  sections: Extract<TriageOp, { op: "set-section" }>[];
  /** The difficulty labels the unblock comment must name. */
  labels: string[];
  /** The amending comment the unblock comment must carry the first line of. */
  amendment: Extract<TriageOp, { op: "comment" }> | null;
}

/**
 * Whether the plan changes what the ticket ASKS FOR, rather than merely saying
 * something about it. One of #150's five preconditions, and the one that makes
 * the others worth having: an unblock on its own resets a coder's rescue count
 * and hands back the identical ticket, which is how a loop spends two more
 * iterations reaching the identical block.
 *
 * Two kinds of nothing are refused here, and both of them looked like a change
 * at first:
 *
 * - **The unblock's own comment does not count as the amendment.** The plan is
 *   REQUIRED to carry that comment, and it may carry `"amends": true` as
 *   readily as any other, so a two-op plan of comment-plus-unblock would
 *   otherwise satisfy this rule with itself. `exclude` is that comment.
 *
 * What this CANNOT check is whether an amending comment says anything. A
 * `set-section` and a label change are machine-checkable against the ticket;
 * prose is not, and a triager willing to write `"amends": true` over an empty
 * sentence can earn an unblock with a comment that changes nothing a coder
 * would read differently. felipearos/ralph#150 names the amendment comment as
 * one of the three means, so it is implemented; the fence on it is that it must
 * be a SEPARATE, real write to the ticket whose first line the unblock comment
 * carries, which makes it visible and attributable rather than sound. The
 * prompt therefore asks for a `set-section` wherever one will do.
 * - **A label op that changes no label does not count as a re-route.** Adding
 *   the difficulty label the ticket already carries is a write the apply
 *   reports as `skipped`, and the coder would get the identical ticket with its
 *   rescue count reset.
 */
function respecified(
  ticket: Ticket,
  context: ValidationContext,
  exclude: Extract<TriageOp, { op: "comment" }> | null,
): Respec | null {
  const { plan } = context;
  const mine = (op: TriageOp): boolean => "issue" in op && op.issue === ticket.number;

  const sections = plan.ops.filter(
    (op): op is Extract<TriageOp, { op: "set-section" }> =>
      op.op === "set-section" && mine(op) && RESPEC_HEADINGS.includes(op.heading),
  );

  const amendment =
    plan.ops.find(
      (op): op is Extract<TriageOp, { op: "comment" }> =>
        op.op === "comment" && mine(op) && op.amends === true && op !== exclude,
    ) ?? null;

  const routed = plan.ops.filter(
    (op): op is Extract<TriageOp, { op: "add-label" | "remove-label" }> =>
      (op.op === "add-label" || op.op === "remove-label") &&
      mine(op) &&
      context.javLabels.includes(op.label) &&
      // A real change, not a re-assertion of what is already there.
      ticket.labels.has(op.label) === (op.op === "remove-label"),
  );
  // A re-route needs a destination. A plan that only STRIPS the difficulty
  // label has routed the ticket nowhere: with Jav on it is then invisible to
  // every coder, which is the opposite of handing it back, and the issue asks
  // the comment for an "old → new difficulty" there is no new half of.
  const labels = routed.some((op) => op.op === "add-label") ? routed.map((op) => op.label) : [];

  if (sections.length === 0 && amendment === null && labels.length === 0) return null;
  return { sections, labels, amendment };
}

/**
 * The five preconditions felipearos/ralph#150 puts on lifting a coder's block,
 * all of them checked here because this is the last place before the first
 * write. They fail CLOSED throughout: an unreadable block record, an undated
 * marker, a comment thread the read could not reach. The cost of refusing a
 * rescue is one ticket a person looks at; the cost of granting a wrong one is a
 * coder sent back at a ticket that has not changed, with its rescue count
 * reset.
 */
function unblockProblems(
  op: Extract<TriageOp, { op: "unblock" }>,
  ticket: Ticket,
  path: string,
  context: ValidationContext,
): string[] {
  const problems: string[] = [];

  // (0) The label has to exist, or `gh` fails mid-plan with the earlier phases
  // already written. NOT checked against `allowedLabels`: a coder's block is
  // outside the triager's label set by design, and `unblock` is the one op
  // allowed past that — which is why the rest of this function exists.
  if (!context.existingLabels.has(op.label)) {
    problems.push(`${path}.label: "${op.label}" does not exist in this repository`);
  }

  // (1) ready, non-spec, and carrying exactly one coder's block.
  if (!ticket.labels.has(READY_LABEL)) {
    problems.push(`${path}.issue: #${op.issue} is not ${READY_LABEL}; an unblock returns a ticket to the coders`);
  }
  if (ticket.labels.has(SPEC_LABEL)) {
    problems.push(`${path}.issue: #${op.issue} is a spec; a spec is a container, not a coder's ticket`);
  }
  const blocks = coderBlocks(ticket, context.coders);
  const named = context.coders.join(", ") || "none on this roster";
  if (blocks.length > 1) {
    problems.push(`${path}.label: #${op.issue} carries ${blocks.join(" and ")}; a person decides which block stands`);
  } else if (!blocks.includes(op.label)) {
    // Two different faults, and saying which one it is matters: a label the
    // ticket does not carry is a typo, where a label it DOES carry that is not
    // a coder's is the rule refusing a block meant for a person.
    problems.push(
      ticket.labels.has(op.label)
        ? `${path}.label: "${op.label}" is not a coder's block (coders: ${named})`
        : `${path}.label: #${op.issue} does not carry "${op.label}" (its coder blocks: ${blocks.join(", ") || "none"})`,
    );
  }
  if (ticket.assignees.length > 0) {
    problems.push(`${path}.issue: #${op.issue} has an assignee; a person is holding it`);
  }
  // This plan's own `-wip` is the frontier's claim on the unit, written before
  // the model saw it. Anyone else's is live work.
  for (const label of ticket.labels) {
    if (label !== `${context.plan.loop}-wip` && label.endsWith("-wip")) {
      problems.push(`${path}.issue: #${op.issue} carries ${label}; it is in flight, not blocked`);
    }
  }
  // A second `-blocked` that is NOT a coder's is a hand-off to a person, and
  // `isClaimed`'s docblock is explicit that such a block is never exempt: it is
  // a unit a past iteration put in front of somebody. Lifting the coder's half
  // of it would rewrite the ticket under the operator reading it — and would
  // not even free the ticket, since the frontier honours the one left behind.
  for (const label of ticket.labels) {
    // `op.label` is excluded: if it is not a coder's, the check above has
    // already said so, and reporting the label the op NAMED as one the ticket
    // "also carries" reads as a second, different fault.
    if (label !== op.label && label.endsWith(BLOCKED_SUFFIX) && !blocks.includes(label)) {
      problems.push(
        `${path}.issue: #${op.issue} also carries ${label}, which is not a coder's; a person is waiting on it`,
      );
    }
  }

  // (1b) The newest block record says what the block IS, and two kinds are not
  // the triager's. A migration waits on a person with database access; a flake
  // is the ci-doctor's intake (felipearos/ralph#155) and no re-spec touches it.
  // `unknown` is refused with them: the comments did not say, and guessing
  // "ordinary" is the one guess that acts.
  const comments = unblockComments(op.issue, context);
  if (comments === null) {
    // The cap and the window are counted off this thread, so a thread the read
    // could not reach is a cap that cannot be enforced.
    problems.push(
      `${path}.issue: #${op.issue}'s comments could not be read in full; a rescue cannot be counted without them`,
    );
    return problems;
  }
  const reason = latestBlockReason(comments);
  if (!rescuableBlock(reason)) {
    // The predicate is the gate — shared with the rescue bucket so the two
    // cannot disagree about which tickets are offerable — and the wording here
    // is only how the refusal reads.
    problems.push(
      reason.kind === "migration"
        ? `${path}.issue: #${op.issue} is blocked on a migration; a person applies it`
        : reason.kind === "unknown"
          ? `${path}.issue: #${op.issue} has no readable block record; what the coder gave up on is unknown`
          : `${path}.issue: #${op.issue} is blocked on a flaky test; that is the ci-doctor's, not a re-spec`,
    );
  }

  // (2) An open PR means the work is in flight whatever the label says.
  if (ticket.openPullRequest !== null) {
    problems.push(`${path}.issue: #${op.issue} has open PR #${ticket.openPullRequest}`);
  }

  // (5) first, because (3) must not count the unblock's own comment as the
  // change it is supposed to be explaining.
  const loop = blockedLoopOf(op.label);
  const comment = loop === null ? null : unblockCommentOf(op.issue, loop, context);
  const change = respecified(ticket, context, comment);

  // (3) The plan must have changed the spec or the route.
  if (change === null) {
    problems.push(
      `${path}: this plan changes neither the spec nor the route of #${op.issue}; an unblock alone hands ` +
        `back the identical ticket. One of: ${respecMeans()}`,
    );
  }

  // (4) Once per ticket per window, and never a third time. Counted off the
  // ticket's own comments, because that is the only record another host's
  // triager can read — the apply ledger is per-unit and per-checkout.
  const days = context.limits.unblockDays;
  const bar = rescueBar(comments, { now: context.now ?? new Date(), days });
  if (bar !== null) {
    const at = bar.marker.at;
    if (bar.reason === "capped") {
      problems.push(
        `${path}.issue: #${op.issue} has been unblocked ${bar.count} times already ` +
          `(cap ${MAX_UNBLOCKS}); it blocked again, so a person decides`,
      );
    } else if (bar.reason === "undated") {
      problems.push(
        `${path}.issue: #${op.issue} carries an undated unblock marker; it cannot be shown to be older than ${days} days`,
      );
    } else if (bar.reason === "unparseable") {
      problems.push(`${path}.issue: #${op.issue} carries an unblock marker dated "${at}", which will not parse`);
    } else {
      problems.push(`${path}.issue: #${op.issue} was unblocked on ${at}, inside RALPH_TRIAGE_UNBLOCK_DAYS (${days})`);
    }
  }

  // (5) The comment that makes the rescue legible on the ticket itself.
  problems.push(...unblockCommentProblems(op, ticket, path, context, loop, comment, reason.reason, change));

  return problems;
}

/**
 * The ticket's comments for the rescue rules, in full.
 *
 * The census tail is NOT enough here, and this is the one place in the file
 * that goes past it. `frontier/next-tasks.ts` fills `Ticket.comments` from
 * `comments(last: 20)`, which is ample for "has this been triaged" — the
 * marker it looks for is on the newest comment or it is stale anyway. The
 * rescue cap is the opposite shape: it counts markers that may be months and
 * dozens of comments old, and a count read off a truncated tail reads as ZERO,
 * which fails OPEN into a third rescue. A rescue cycle costs four to six
 * comments, so two of them plus a re-block sits right at the tail.
 *
 * Null when the full read failed, which the caller turns into a refusal.
 */
function unblockComments(issue: number, context: ValidationContext): readonly IssueComment[] | null {
  return context.fullComments(issue);
}

/** The plan's unblock comment for `loop` on `issue`, or null. */
const unblockCommentOf = (
  issue: number,
  loop: string,
  context: ValidationContext,
): Extract<TriageOp, { op: "comment" }> | null =>
  context.plan.ops.find(
    (op): op is Extract<TriageOp, { op: "comment" }> =>
      op.op === "comment" && op.issue === issue && leadsWithUnblock(op.body, loop),
  ) ?? null;

/**
 * The unblock's comment, which is the whole audit trail: the label removal
 * leaves no trace, and `release` strips the claim right after, so a ticket
 * rescued without this comment reads afterwards as one that was never blocked.
 * A coder may claim it within seconds of the label going, and this is what it
 * finds when it asks why.
 *
 * The `op=unblock` MARKER is not asked of the plan. `triage/apply.ts` stamps it
 * onto this comment as it posts it, for two reasons: the hash it carries is a
 * truncated sha256 of the issue body, which no model can produce by hand, and a
 * marker written by the plan would exist whether or not the label removal that
 * follows it succeeded — so the count could run ahead of the rescues. What this
 * function does insist on is that exactly ONE comment leads with the line, or
 * the apply would stamp two and count one rescue as two.
 */
function unblockCommentProblems(
  op: Extract<TriageOp, { op: "unblock" }>,
  ticket: Ticket,
  path: string,
  context: ValidationContext,
  loop: string | null,
  comment: Extract<TriageOp, { op: "comment" }> | null,
  blockReason: string | null,
  change: Respec | null,
): string[] {
  // Nothing useful to say about the comment when the label is not a block at
  // all: the lead line names a loop, and there is no loop to name.
  if (loop === null) return [`${path}.label: "${op.label}" is not a <loop>-blocked label`];

  if (comment === null) {
    return [`${path}: #${op.issue} needs a comment in this plan whose first line is "${unblockLead(loop)}"`];
  }
  const leads = context.plan.ops.filter(
    (other) => other.op === "comment" && other.issue === op.issue && leadsWithUnblock(other.body, loop),
  );
  if (leads.length > 1) {
    return [`${path}: ${leads.length} comments on #${op.issue} lead with "${unblockLead(loop)}"; one rescue, one comment`];
  }

  const problems: string[] = [];
  const quoted = quotable(comment.body);

  // Why it was blocked, in the coder's own words. Compared against the record's
  // first line as `blockReasonOf` trimmed it, so a reason long enough to be
  // elided matches on the part that was kept.
  if (blockReason !== null) {
    const needle = blockReason.endsWith("…") ? blockReason.slice(0, -1) : blockReason;
    if (!quoted.includes(quotable(needle))) {
      problems.push(`${path}: the unblock comment on #${op.issue} does not quote the block record's first line`);
    }
  }

  // And what changed, in whatever terms the change was made. Enough that the
  // comment cannot be a template that says nothing.
  if (change === null) return problems;
  for (const section of change.sections) {
    if (!comment.body.includes(section.heading)) {
      problems.push(`${path}: the unblock comment on #${op.issue} does not name the re-specified "${section.heading}"`);
    }
    // Replacing one of these drops text a coder was working to. #150 makes
    // quoting it the price of the permission, so the history survives the
    // rewrite. Compared against the text being replaced rather than against the
    // comment alone, because the NEW text often contains the old as a
    // substring — quoting the replacement would otherwise pass.
    const replaced = section.mode === "replace" ? sectionIfPresent(ticket.body, section.heading) : null;
    // `quotable(replaced)` and not `replaced.trim()`: a section of nothing but
    // markup folds to "", and `includes("")` is true for every comment.
    if (replaced !== null && quotable(replaced) !== "" && !quoted.includes(quotable(replaced))) {
      problems.push(`${path}: the unblock comment on #${op.issue} does not quote the "${section.heading}" it replaces`);
    }
  }
  for (const label of change.labels) {
    if (!comment.body.includes(label)) {
      problems.push(`${path}: the unblock comment on #${op.issue} does not name the difficulty change (${label})`);
    }
  }
  if (change.amendment !== null && !quoted.includes(quotable(firstLine(change.amendment.body)))) {
    problems.push(
      `${path}: the unblock comment on #${op.issue} does not carry the first line of the amendment it rests on`,
    );
  }
  return problems;
}

function closeProblems(
  op: Extract<TriageOp, { op: "close" }>,
  ticket: Ticket,
  path: string,
  context: ValidationContext,
): string[] {
  const problems: string[] = [];

  if (ticket.labels.has("spec")) {
    problems.push(`${path}: #${op.issue} is a spec; a spec closes when its children do`);
  }
  if (isClaimed(ticket, context.plan.loop)) {
    problems.push(`${path}: #${op.issue} is claimed; closing it would take work off a loop mid-flight`);
  }
  if (ticket.openPullRequest !== null) {
    problems.push(`${path}: #${op.issue} has open PR #${ticket.openPullRequest}`);
  }
  if (context.fences.closureParents.includes(op.issue)) {
    problems.push(`${path}: #${op.issue} is a plan Parent-closure exception; a person closes it`);
  }
  if (context.fences.outOfScope.includes(op.issue)) {
    problems.push(`${path}: #${op.issue} is Out of scope in the plan`);
  }

  if (op.evidence.kind === "duplicate-of") {
    // The APPLY adds this label, not the plan, so it is the only label that
    // would otherwise reach `gh` unchecked — and on a repository without it the
    // close fails mid-plan, with the earlier phases already written.
    problems.push(...labelProblems(DUPLICATE_LABEL, `${path}.evidence`, context));
    const target = context.duplicateTarget(op.evidence.issue);
    if (target.state === "unknown") {
      problems.push(`${path}.evidence.issue: #${op.evidence.issue} could not be read`);
    } else if (target.state === "closed" && !target.completed) {
      problems.push(
        `${path}.evidence.issue: #${op.evidence.issue} was closed as not planned; duplicating it closes nothing`,
      );
    }
    if (op.evidence.issue === op.issue) {
      problems.push(`${path}.evidence.issue: #${op.issue} cannot duplicate itself`);
    }
  }
  return problems;
}

/**
 * A plan that decides a product question has to cite the rule it decided under,
 * and the rule has to say what the plan claims it says — checked against
 * `origin/<baseBranch>`, never the working tree, because the working tree is
 * one loop's view and a quote can be added to it by the same session that cites it.
 */
function decisionProblems(context: ValidationContext): string[] {
  const problems: string[] = [];
  const decisions = context.plan.decisions ?? [];
  if (decisions.length === 0) return problems;

  const unitComments = context.plan.ops.filter(
    (op) => op.op === "comment" && op.issue === context.plan.unit,
  ) as Extract<TriageOp, { op: "comment" }>[];

  decisions.forEach((decision, index) => {
    const path = `decisions[${index}]`;
    const file = decision.rule.split("#")[0] ?? "";
    const text = context.readRule(file);
    if (text === null) {
      problems.push(`${path}.rule: ${file} does not exist at the base branch`);
      return;
    }
    const heading = decision.rule.includes("#") ? decision.rule.slice(decision.rule.indexOf("#") + 1) : null;
    if (heading !== null && heading !== "" && !hasHeading(text, heading)) {
      problems.push(`${path}.rule: ${file} has no heading "${heading}"`);
    }
    if (!normalise(text).includes(normalise(decision.quote))) {
      problems.push(`${path}.quote: does not appear verbatim in ${file}`);
    }
    // The citation has to reach the human reading the issue, not only the plan
    // file, which nobody outside this apply ever sees.
    if (!unitComments.some((comment) => comment.body.includes(decision.rule))) {
      problems.push(
        `${path}.rule: no comment on #${context.plan.unit} names ${decision.rule}; a cited rule must be visible on the issue`,
      );
    }
  });
  return problems;
}

/** Whitespace-folded so a quote that survived a re-wrap still matches its source. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

const hasHeading = (text: string, heading: string): boolean => {
  const escaped = heading.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(text);
};
