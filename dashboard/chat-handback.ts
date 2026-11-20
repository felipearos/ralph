/**
 * Unblock & resume (#255): the operator's decision lands where the loop will
 * read it, and the loop starts again.
 *
 * Spec #251 decided that a decision living only in the chat transcript does
 * not count. So the confirmed summary goes on the TICKET — the coder reads
 * the issue's comments before it works on it (`prompt.md` §2 and §3) — and
 * into the JOURNAL, which every loop's orientation reads; then the block
 * label comes off and the loop is started. In order, stopping at the first
 * step that fails, each one marked on the chat's stream and transcript:
 *
 *   1. worktree — the loop's checkout against its role's invariant, BEFORE
 *      anything external: a Fix turn may have left it dirty, and a loop
 *      started over that inherits edits nobody reviewed. Refused with the
 *      paths. Skipped while the loop's supervisor is alive: the checkout is
 *      then the running loop's own, and no Fix turn can have touched it.
 *   2. comment — `### Operator decision`, the summary and the transcript's
 *      path, when the chat is about a ticket.
 *   3. label — `<loop>-blocked` removed, when the ticket carries it.
 *   4. journal — an entry through `publish-journal.ts`.
 *   5. restart — `resume-work` after a Stop now, else `start`, through the
 *      lifecycle module the Start and Resume work buttons use.
 *
 * IDEMPOTENT ON RETRY. A handback that failed at the journal is re-run from
 * the top, so every step must be safe to repeat:
 *
 *   - the comment carries a hidden marker naming the chat, and is not posted
 *     again when one is already on the ticket — read off GitHub, not memory;
 *   - the label is removed only when `gh issue view` shows it there;
 *   - the journal step is skipped once the transcript records it done, and
 *     its draft is named from a timestamp the chat fixes at the first
 *     confirm, so a publish whose push landed but whose answer was lost is
 *     re-published as the same entry, which the publisher reports as
 *     already published;
 *   - `start` is idempotent on its own (`already-running`).
 */
import { readOnlyCheckoutRoles, type LoopRole } from "./contracts";
import type { HandbackOutcome, HandbackStep } from "./chat";
import type { HandbackAdapter, IssueRead } from "./chat-handback-adapter";
import {
  readCheckout,
  readLiveness,
  readRecord,
  resumeWork,
  start,
  type LifecycleDeps,
  type ResumeWorkResult,
  type StartResult,
} from "./lifecycle";
import type { CheckoutReport } from "./lifecycle-adapter";

/** The hidden line that makes the ticket comment findable again, by chat. */
export const decisionMarker = (chat: string): string => `<!-- ralph:operator-decision chat=${chat} -->`;

/** The heading the coder's prompt tells it to look for. */
export const DECISION_HEADING = "### Operator decision";

export interface DecisionInput {
  chat: string;
  loop: string;
  summary: string;
  /** The transcript's path on the dashboard's host. */
  transcript: string;
}

/** The ticket comment: heading, the operator's summary, where the conversation is, and the marker. */
export function decisionComment(input: DecisionInput): string {
  return [
    DECISION_HEADING,
    "",
    input.summary.trim(),
    "",
    `Transcript: \`${input.transcript}\` (the unblocker chat with \`${input.loop}\`, on the dashboard's host).`,
    "",
    decisionMarker(input.chat),
  ].join("\n");
}

export interface JournalInput extends DecisionInput {
  ticket: number | null;
  /** `YYYYMMDDTHHMMSSZ`, fixed at the first confirm. */
  stamp: string;
  /** The session the chat forked, or null when it started fresh. */
  session: string | null;
}

/** The draft's file name: `journal-draft-<stamp>-<issue|none>-chat-<id>.md`, as the publisher requires. */
export function journalDraftName(input: Pick<JournalInput, "chat" | "ticket" | "stamp">): string {
  const id = input.chat.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `journal-draft-${input.stamp}-${input.ticket ?? "none"}-chat-${id === "" ? "x" : id}.md`;
}

/** The journal entry: the heading and `**Outcome:**` line `status.sh` reads, then the decision. */
export function journalEntry(input: JournalInput): string {
  const date = `${input.stamp.slice(0, 4)}-${input.stamp.slice(4, 6)}-${input.stamp.slice(6, 8)}`;
  const subject = input.ticket === null ? `${input.loop} halt` : `#${input.ticket}`;
  return [
    `# ${date} — ${subject}: operator decision`,
    "",
    "**Outcome: unblocked by the operator.**",
    "",
    `- **Loop:** ${input.loop}`,
    `- **Ticket:** ${input.ticket === null ? "none (a halt with no ticket)" : `#${input.ticket}`}`,
    `- **Chat:** ${input.chat}${input.session === null ? ", a fresh session" : `, forked from session ${input.session}`}`,
    `- **Transcript:** \`${input.transcript}\``,
    "",
    "## Decision",
    "",
    input.summary.trim(),
    "",
  ].join("\n");
}

/** A path in the loop's own state directory, which the chat itself writes into. */
const harnessState = (path: string): boolean => path === ".ralph" || path.startsWith(".ralph/");

/** The path a `git status --porcelain` line names: the destination, for a rename. */
const porcelainPath = (line: string): string => {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return (arrow === -1 ? path : path.slice(arrow + 4)).replace(/^"|"$/g, "");
};

export type WorktreeVerdict = { ok: true; why: string } | { ok: false; why: string; paths: string[] };

/**
 * Is the loop's checkout in its role's invariant?
 *
 * - **Every role:** nothing uncommitted, tracked or not — except under
 *   `.ralph/`, the loop's own state, where the chat's transcript and the
 *   journal draft themselves are written.
 * - **`clean-detached` roles** (`roles.ts` `RoleInvariant`, the triager):
 *   HEAD detached, as `ralph.sh`'s `role_invariant` leaves it.
 * - **A coder:** HEAD on one of its own branches (`<loop>/…`, the prompt's
 *   naming), or detached between tickets — never on another loop's branch or
 *   the base branch, where its next commit would land on someone else's work.
 *
 * Fails closed: a checkout `git status` could not read is refused.
 */
export function worktreeVerdict(role: LoopRole, loop: string, checkout: CheckoutReport): WorktreeVerdict {
  if (!checkout.readable) return { ok: false, why: `git status could not be read in ${checkout.worktree}`, paths: [] };
  const dirty = checkout.changes.map(porcelainPath).filter((path) => !harnessState(path));
  if (dirty.length > 0) {
    return {
      ok: false,
      why: `${checkout.worktree} has ${dirty.length} uncommitted change(s): ${dirty.join(", ")} — commit, stash or discard them, then hand back again`,
      paths: dirty,
    };
  }
  if ((readOnlyCheckoutRoles as readonly string[]).includes(role) && checkout.branch !== null) {
    return {
      ok: false,
      why: `the ${role} must leave HEAD detached, and ${checkout.worktree} is on ${checkout.branch}`,
      paths: [],
    };
  }
  if (role === "coder" && checkout.branch !== null && !checkout.branch.startsWith(`${loop}/`)) {
    return {
      ok: false,
      why: `${checkout.worktree} is on ${checkout.branch}, which is not one of ${loop}'s own branches (${loop}/…)`,
      paths: [],
    };
  }
  return { ok: true, why: `${checkout.worktree} is clean${checkout.branch === null ? " and detached" : ` on ${checkout.branch}`}` };
}

export interface HandbackDeps extends LifecycleDeps {
  handback: HandbackAdapter;
}

export interface HandbackRequest {
  chat: string;
  role: LoopRole;
  ticket: number | null;
  summary: string;
  transcript: string;
  session: string | null;
  stamp: string;
  /** Steps an earlier attempt finished, as the chat's transcript records them. */
  done: ReadonlySet<HandbackStep>;
  /** Called once per step, in order: the chat marks it on its stream. */
  mark?: (step: HandbackStep, outcome: HandbackOutcome, why: string) => void;
}

export interface HandbackStepResult {
  step: HandbackStep;
  outcome: HandbackOutcome;
  why: string;
}

export interface HandbackResult {
  loop: string;
  /** `resumed` — every step passed and the loop was started; else the step it stopped at. */
  outcome: "resumed" | "refused" | "failed";
  /** The step it stopped at, or null once resumed. */
  step: HandbackStep | null;
  why: string;
  ticket: number | null;
  steps: HandbackStepResult[];
  /** The worktree's paths that refused the handback; empty otherwise. */
  dirty: string[];
  checkout: CheckoutReport | null;
  restart: StartResult | ResumeWorkResult | null;
}

/** Run Unblock & resume's confirm sequence for one chat. */
export async function handBack(deps: HandbackDeps, request: HandbackRequest): Promise<HandbackResult> {
  const adapter = deps.handback;
  const steps: HandbackStepResult[] = [];
  const answer: Omit<HandbackResult, "outcome" | "step" | "why"> = {
    loop: deps.loop,
    ticket: request.ticket,
    steps,
    dirty: [],
    checkout: null,
    restart: null,
  };
  const mark = (step: HandbackStep, outcome: HandbackOutcome, why: string): void => {
    steps.push({ step, outcome, why });
    request.mark?.(step, outcome, why);
  };
  const stop = (step: HandbackStep, outcome: "refused" | "failed", why: string): HandbackResult => {
    mark(step, outcome, why);
    return { ...answer, outcome, step, why };
  };

  // 1. The worktree, before anything leaves this host.
  const liveness = await readLiveness(deps);
  if (liveness.liveness === "alive") {
    mark("worktree", "skipped", `${deps.loop}'s supervisor is running, so its worktree is the loop's own`);
  } else {
    const checkout = await readCheckout(deps);
    answer.checkout = checkout;
    const verdict = worktreeVerdict(request.role, deps.loop, checkout);
    if (!verdict.ok) {
      answer.dirty = verdict.paths;
      return stop("worktree", "refused", verdict.why);
    }
    mark("worktree", "done", verdict.why);
  }

  // 2 and 3. The ticket: one read serves both the marker and the label.
  const ticket = request.ticket;
  if (ticket === null) {
    mark("comment", "skipped", "the halt names no ticket, so there is nothing to comment on");
    mark("label", "skipped", "the halt names no ticket, so there is no label to drop");
  } else {
    const issue: IssueRead | { problem: string } = await adapter.readIssue(ticket);
    if ("problem" in issue) return stop("comment", "failed", `#${ticket} could not be read: ${issue.problem}`);

    const marker = decisionMarker(request.chat);
    if (issue.comments.some((body) => body.includes(marker))) {
      mark("comment", "already", `#${ticket} already carries this chat's operator decision`);
    } else {
      const body = decisionComment({ chat: request.chat, loop: deps.loop, summary: request.summary, transcript: request.transcript });
      const posted = await adapter.comment(ticket, body);
      if (!posted.ok) return stop("comment", "failed", posted.why);
      mark("comment", "done", `posted the operator decision on #${ticket}`);
    }

    const label = `${deps.loop}-blocked`;
    if (!issue.labels.includes(label)) {
      mark("label", "already", `#${ticket} does not carry ${label}`);
    } else {
      const removed = await adapter.unlabel(ticket, label);
      if (!removed.ok) return stop("label", "failed", removed.why);
      mark("label", "done", `removed ${label} from #${ticket}`);
    }
  }

  // 4. The journal, once.
  if (request.done.has("journal")) {
    mark("journal", "already", "an earlier attempt published this handback's journal entry");
  } else {
    const input: JournalInput = {
      chat: request.chat,
      loop: deps.loop,
      summary: request.summary,
      transcript: request.transcript,
      ticket,
      stamp: request.stamp,
      session: request.session,
    };
    let draft: string;
    try {
      draft = adapter.writeDraft(journalDraftName(input), journalEntry(input));
    } catch (error) {
      return stop("journal", "failed", `the journal draft could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    const published = await adapter.publish(draft, ticket);
    if (!published.ok) return stop("journal", "failed", published.why);
    mark("journal", "done", published.said);
  }

  // 5. The loop, as the operator left it: resumed over a Stop now's work, else started.
  const stopped = (await readRecord(deps))?.stop ?? null;
  const resume = stopped?.kind === "interrupted" && liveness.liveness !== "alive";
  const restart = resume ? await resumeWork(deps, { loop: deps.loop }) : await start(deps, { loop: deps.loop });
  answer.restart = restart;
  const verb = resume ? "resume-work" : "start";
  if (restart.outcome !== "started" && restart.outcome !== "already-running") {
    return stop("restart", "failed", `${verb} ${restart.outcome}: ${restart.why}`);
  }
  mark("restart", "done", `${verb}: ${restart.why}`);
  return { ...answer, outcome: "resumed", step: null, why: `${deps.loop} handed back and ${restart.outcome === "started" ? "started" : "already running"}` };
}
