/**
 * The frontier the plan would leave behind, computed before a single write.
 *
 * Validation says the plan is allowed; the simulation says it is SAFE. They are
 * different questions: every op in a split can be individually permitted and
 * the result still be a backlog the frontier cannot use. A malformed
 * `## Staffing group` no longer stops the frontier for every loop — `classify`
 * holds just that ticket out and names it in `Frontier.malformed` — but a plan
 * that WRITES one has still produced a ticket no loop will take, so a ticket
 * the plan leaves malformed that was not before is a refusal.
 *
 * So the plan's bodies and labels are substituted into the census that was just
 * read, and the real `buildTickets`/`classify` are run over the result — the
 * same two functions the frontier itself calls, never a model of them.
 */
import {
  buildTickets,
  classify,
  parseParent,
  type BlockerRef,
  type ClosedIssue,
  type Frontier,
  type OpenPullRequest,
  type RawIssue,
} from "../frontier/next-tasks";
import { leasePathFromGit, readLeaseStore } from "../claim-lease";
import { applySection, issueBodyWithOpMarker } from "./body";
import { orderOps } from "./order";
import { isRefLabelOp, type ApplyOp, type TriagePlan } from "./plan";

/** The census a simulation starts from: exactly what `readFrontierInputs` returns. */
export interface Census {
  raw: RawIssue[];
  natives: BlockerRef[][];
  closed: ClosedIssue[];
  openPrs: OpenPullRequest[];
}

export type Simulation =
  | { ok: true; before: Frontier; after: Frontier; refusals: [] }
  | { ok: false; refusals: string[]; before: Frontier | null; after: null };

/**
 * Numbers for the issues a plan creates.
 *
 * They do not exist yet, so the simulation gives them numbers above everything
 * in the census. Sequential from one past the highest known number: the exact
 * values never reach GitHub, and the frontier only cares that they are distinct
 * and orderable.
 */
const syntheticNumbers = (census: Census, count: number): number[] => {
  const highest = Math.max(
    0,
    ...census.raw.map((issue) => issue.number),
    ...census.closed.map((issue) => issue.number),
  );
  return Array.from({ length: count }, (_, at) => highest + 1 + at);
};

/** The census as the plan would leave it. Pure; the input is not mutated. */
export function substitute(census: Census, plan: TriagePlan): Census {
  return substituteOps(census, plan.ops);
}

/**
 * The same, over an explicit list of ops — including the ones ordering derives.
 *
 * Exported for `stepwiseRefusals`, which needs the census after every PREFIX of
 * the ordered writes, not only after all of them.
 */
export function substituteOps(census: Census, ops: readonly ApplyOp[]): Census {
  const byNumber = new Map<number, { issue: RawIssue; natives: BlockerRef[] }>();
  const order: number[] = [];
  census.raw.forEach((issue, index) => {
    byNumber.set(issue.number, {
      issue: { ...issue, labels: issue.labels.map((label) => ({ ...label })) },
      natives: [...(census.natives[index] ?? [])],
    });
    order.push(issue.number);
  });

  const created = ops.filter((op) => op.op === "create-issue" && !isRefLabelOp(op));
  const numbers = syntheticNumbers(census, created.length);
  const refToNumber = new Map<string, number>();
  created.forEach((op, at) => {
    if (op.op !== "create-issue") return;
    const number = numbers[at]!;
    refToNumber.set(op.ref, number);
    byNumber.set(number, {
      issue: {
        number,
        title: op.title,
        // The body the apply will actually POST, marker included. Simulating the
        // unmarked one is how a body the frontier cannot parse passes a
        // simulation: `triage/body.ts` explains what the marker's placement costs.
        body: issueBodyWithOpMarker(op.body, op.opId),
        labels: (op.labels ?? []).map((name) => ({ name })),
        assignees: [],
        // `classify` does not read `author` — the owner fence is applied before
        // the simulation, on the issues that exist. Inheriting some other
        // issue's login here would be a guess that reads as load-bearing.
        author: null,
        comments: [],
      },
      natives: [],
    });
    order.push(number);
  });

  const closed = [...census.closed];
  const removed = new Set<number>();

  for (const op of ops) {
    if (isRefLabelOp(op)) {
      const number = refToNumber.get(op.ref);
      const target = number === undefined ? undefined : byNumber.get(number);
      if (target !== undefined && !target.issue.labels.some((label) => label.name === op.label)) {
        target.issue.labels.push({ name: op.label });
      }
      continue;
    }
    if (op.op === "create-issue") continue;
    const entry = byNumber.get(op.issue);
    if (entry === undefined) continue;
    switch (op.op) {
      case "add-label":
        if (!entry.issue.labels.some((label) => label.name === op.label)) {
          entry.issue.labels.push({ name: op.label });
        }
        break;
      // An unblock is a label removal as far as the next frontier read is
      // concerned, and that is the whole question a simulation asks.
      case "remove-label":
      case "unblock":
        entry.issue.labels = entry.issue.labels.filter((label) => label.name !== op.label);
        break;
      case "set-section":
        entry.issue.body = applySection(entry.issue.body, op.heading, op.mode, op.body);
        break;
      case "add-blocker": {
        const number = typeof op.blockedBy === "number" ? op.blockedBy : refToNumber.get(op.blockedBy);
        if (number === undefined) break;
        // A blocker the plan creates in the same breath is open by construction;
        // an existing one keeps the state the census gave it.
        const state = byNumber.has(number) && !removed.has(number) ? "open" : "closed";
        if (!entry.natives.some((ref) => ref.number === number)) {
          entry.natives.push({ number, state });
        }
        break;
      }
      case "close":
        removed.add(op.issue);
        closed.push({ number: op.issue, title: entry.issue.title, body: entry.issue.body });
        break;
      case "comment":
        break;
      // A Linear or Jira project's Slack-intake ops, refused on GitHub before a
      // simulation runs; they change nothing the GitHub frontier reads.
      case "propose":
      case "to-person":
        break;
    }
  }

  // A closed issue stops being an open blocker of everything that named it, the
  // same transition the next real read would show.
  for (const entry of byNumber.values()) {
    entry.natives = entry.natives.map((ref) =>
      removed.has(ref.number) ? { ...ref, state: "closed" } : ref,
    );
  }

  const raw: RawIssue[] = [];
  const natives: BlockerRef[][] = [];
  for (const number of order) {
    if (removed.has(number)) continue;
    const entry = byNumber.get(number)!;
    raw.push(entry.issue);
    natives.push(entry.natives);
  }
  // A PR whose closing references all just closed still claims what its body
  // references (`Part of #373`), and through that the spec's children.
  const openPrs = census.openPrs.flatMap((pr): OpenPullRequest[] => {
    if (!closesOnly(pr, removed)) return [pr];
    return (pr.references ?? []).length > 0 ? [{ ...pr, closingIssuesReferences: [] }] : [];
  });
  return { raw, natives, closed, openPrs };
}

/** A PR whose every closing reference just closed is no longer a claim on anything. */
const closesOnly = (pr: OpenPullRequest, removed: ReadonlySet<number>): boolean =>
  pr.closingIssuesReferences.length > 0 &&
  pr.closingIssuesReferences.every((ref) => removed.has(ref.number));

/** The frontier for a census, or the error `buildTickets`/`classify` threw reading it. */
export function frontierOf(census: Census): { frontier: Frontier } | { error: string } {
  try {
    const closedNumbers = new Set(census.closed.map((issue) => issue.number));
    const tickets = buildTickets(census.raw, census.natives, closedNumbers, census.openPrs);
    const closedChildParents = census.closed
      .map((issue) => parseParent(issue.body ?? ""))
      .filter((parent): parent is number => parent !== null);
    return { frontier: classify(tickets, closedChildParents, readLeaseStore(leasePathFromGit()).leases) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Tickets `after` cannot read that `before` could. Only NEW ones: a ticket that
 * was already malformed is somebody else's mess, and refusing every plan while
 * one exists would park triage — including the plan that fixes it.
 */
function newlyMalformed(before: Frontier, after: Frontier): string[] {
  const already = new Set(before.malformed.map((t) => t.number));
  return after.malformed
    .filter((t) => !already.has(t.number))
    .map((t) => `the plan leaves #${t.number} unreadable to the frontier: ${t.malformed}`);
}

/**
 * Run the plan against the census and refuse what the result would break.
 *
 * Three refusals, each naming a failure the frontier cannot recover from on its
 * own:
 *
 * - the frontier THROWS on the resulting backlog — every loop's selection stops,
 *   not just this one's;
 * - a ticket the plan wrote comes out malformed (`Frontier.malformed`), so no
 *   loop will ever take it;
 * - a tree the plan touched comes out partly annotated, which collapses that
 *   whole tree to its parent-wide collision domain and parks its siblings in
 *   OCCUPIED behind work they do not touch;
 * - a ticket that was a container reaches READY NOW, where a loop would try to
 *   implement a spec rather than its children;
 * - any INTERMEDIATE state of the ordered writes offers something it should not
 *   (`stepwiseRefusals`).
 */
/**
 * The refusals from walking the ordered writes ONE AT A TIME.
 *
 * `simulate` checks where the plan ends up; this checks every state it passes
 * through, which is the thing the ordering exists to make safe. The frontier
 * reads GitHub, not the plan: between two writes it will happily offer a coder
 * a spec that has stopped being one, or a child created without its acceptance
 * criteria. So each prefix of `orderOps(plan)` is substituted and classified,
 * and a prefix that offers either is a refusal.
 *
 * It is a simulation of the WRITE ORDER, not of GitHub: a real apply can also
 * stop partway, and a prefix is exactly what it leaves behind when it does.
 */
export function stepwiseRefusals(census: Census, plan: TriagePlan): string[] {
  const steps = orderOps(plan);
  const created = new Set(
    steps.flatMap(({ op }) => (op.op === "create-issue" && !isRefLabelOp(op) ? [op.ref] : [])),
  );
  if (created.size === 0) return [];

  const refusals: string[] = [];
  const initial = frontierOf(census);
  const start = "error" in initial ? null : initial.frontier;
  // Through the LAST write, not up to it: a plan whose children never name the
  // parent leaves the original offerable at the end too, and that final state
  // is one the endpoint checks — which ask about specs and trees — do not see.
  for (let taken = 1; taken <= steps.length; taken += 1) {
    const prefix = steps.slice(0, taken).map((step) => step.op);
    const partial = frontierOf(substituteOps(census, prefix));
    if ("error" in partial) {
      refusals.push(`after ${taken} of ${steps.length} writes the frontier would throw: ${partial.error}`);
      break;
    }
    if (start !== null) {
      for (const refusal of newlyMalformed(start, partial.frontier)) {
        refusals.push(`after ${taken} of ${steps.length} writes ${refusal}`);
      }
      if (refusals.length > 0) break;
    }
    for (const ready of partial.frontier.readyTasks) {
      // A child is incomplete until its tree is fully annotated: an ungrouped
      // tree is exactly the state that collapses its siblings' collision domain.
      if (partial.frontier.ungroupedTrees.has(ready.parent ?? ready.number)) {
        refusals.push(
          `after ${taken} of ${steps.length} writes the frontier would offer #${ready.number}, whose tree is not yet annotated`,
        );
      }
      if (ready.number === plan.unit) {
        refusals.push(
          `after ${taken} of ${steps.length} writes the frontier would still offer #${plan.unit}, which this plan is splitting`,
        );
      }
    }
    if (refusals.length > 0) break;
  }
  return refusals;
}

export function simulate(census: Census, plan: TriagePlan): Simulation {
  const start = frontierOf(census);
  if ("error" in start) {
    // The frontier was ALREADY broken before this plan. Refusing here is still
    // right — the simulation cannot tell what the plan did — but the message has
    // to say so, or the triager will rewrite a plan that was never the problem.
    return {
      ok: false,
      refusals: [`the frontier already fails to read this backlog: ${start.error}`],
      before: null,
      after: null,
    };
  }
  const before = start.frontier;

  const after = frontierOf(substitute(census, plan));
  if ("error" in after) {
    return { ok: false, refusals: [`the plan makes the frontier throw: ${after.error}`], before, after: null };
  }

  const refusals: string[] = newlyMalformed(before, after.frontier);
  // Only trees the plan made ungrouped. A tree that was already ungrouped is
  // somebody else's mess and refusing every plan on a project that has one
  // would park triage entirely; and since the substitution is a pure function
  // of the plan, a tree that is newly ungrouped is newly ungrouped BY it.
  for (const tree of after.frontier.ungroupedTrees) {
    if (before.ungroupedTrees.has(tree)) continue;
    refusals.push(
      `the plan leaves tree #${tree} partly annotated: a child with no "## Staffing group" keeps the whole tree at its parent-wide collision domain`,
    );
  }
  // `classify` keeps a container off READY NOW by itself, so the only way a
  // spec reaches it is a plan that stops it BEING one — dropping the `spec`
  // label from a container with no children. Judged against the before-frontier
  // for exactly that reason: after the edit there is nothing left to notice.
  for (const ready of after.frontier.readyTasks) {
    if (before.containers.has(ready.number)) {
      refusals.push(
        `the plan puts spec #${ready.number} on the frontier as work; a spec is a container, not a ticket`,
      );
    }
  }

  refusals.push(...stepwiseRefusals(census, plan));

  if (refusals.length > 0) return { ok: false, refusals, before, after: null };
  return { ok: true, before, after: after.frontier, refusals: [] };
}

