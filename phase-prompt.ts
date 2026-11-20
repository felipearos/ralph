#!/usr/bin/env bun
/**
 * The prompt for a FRESH session that runs one phase of an iteration.
 *
 * Most phases run in the session that ran the one before, resumed at the
 * boundary (`phase.ts`). Some cannot: the session that picks an iteration up
 * after the supervisor's wait on its PR, the short handoff after the token cap
 * stopped it, and a phase an operator asked to run again. Each of those starts
 * from nothing but disk — the branch, the briefs, the handoff notes and the
 * ledger — and this prompt.
 *
 * The first session of an iteration that picks up an interrupted ticket is one
 * of them too: `resume` checks the ticket's ledger against the worktree and,
 * when they agree, starts it at the phase after the last one that finished.
 *
 * It is a preamble saying where the work stands, over the rendered iteration
 * prompt (`prompt.md`) cut down to the sections that phase runs. Every section
 * a phase does not run is dropped; every section that belongs to no phase (who
 * you are, model routing, the phase rules, the HARD RAIL, a heading this file
 * does not know) is kept. The sections themselves are kept verbatim, so the
 * rules have one source, `prompt.md`, and cannot drift from it.
 *
 *   phase-prompt.ts retry --phase <phase> [--next <phase>] [--ticket N] --iteration I < rendered-prompt
 *     The prompt for an operator's retry of <phase>: a fresh session that
 *     starts from the handoff note of the phase before it.
 *
 *   phase-prompt.ts resume --ticket N --iteration I < rendered-prompt
 *     Whether the claimed ticket N can be resumed from its ledger, checked
 *     against the worktree's git. One machine line first, tab-separated:
 *       resume <phase> <after> <why>   followed by the fresh session's
 *                                      prompt; <after> is the phase that
 *                                      finished, the boundary it enters by;
 *       fallback <reason> - <why>      the iteration starts from the top, as
 *                                      it always has, and <why> says what was
 *                                      wrong.
 *     Exit 0 either way; anything else is the supervisor's fallback too.
 *
 * `ship-prompt.ts` builds the PR-wait and budget sessions through
 * `phasePrompt(…, "finish", …)`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isPhase, ledgerPath, notePath, PHASE_SECTIONS, PHASES, readLedger, type LedgerEntry, type Phase } from "./phase";

/**
 * The numbered `prompt.md` sections (`## <n>. …`) each phase runs.
 *
 * Whole sections, because a heading is the one cut that survives an edit to
 * the prose under it. So a phase gets a little more than `PHASE_SECTIONS`
 * says: `select` gets all of §3, whose opening reading is the end of it;
 * `review` gets all of §5, whose first two steps it is. Each phase's own
 * boundary line says where it stops. `finish` keeps §4, as the PR session
 * always has: its red-CI path is §4's gates again.
 */
export const PROMPT_SECTIONS: Record<Phase, readonly number[]> = {
  select: [0, 1, 2, 3],
  implement: [3],
  verify: [4],
  review: [5],
  finish: [4, 5, 6],
};

const NUMBERED = /^## ([0-9]+)\. /;

/**
 * The rendered prompt cut down to one phase: the title, every section that
 * belongs to no phase, and that phase's numbered sections, in prompt order.
 */
export function phaseSections(rendered: string, phase: Phase): string {
  const wanted = PROMPT_SECTIONS[phase];
  const out: string[] = [];
  let keep = true;
  for (const line of rendered.split("\n")) {
    if (line.startsWith("## ")) {
      const numbered = NUMBERED.exec(line);
      keep = numbered === null || wanted.includes(Number(numbered[1]));
    }
    if (keep) out.push(line);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** A fresh session's whole prompt: what it is told first, then the phase's sections. */
export function phasePrompt(rendered: string, phase: Phase, preamble: string): string {
  return preamble + phaseSections(rendered, phase);
}

/**
 * The handoff note a fresh session in `phase` starts from: the note of the
 * phase that led into it, or null when there is none on disk.
 *
 * The ledger says which phase that was — a shepherded PR goes from `select`
 * straight to `finish` — and its latest attempt is the one that counts. With
 * no ledger line for it, the nearest earlier phase whose note exists stands in.
 */
export function handoffInto(root: string, ticket: number, phase: Phase): string | null {
  const exists = (path: string | null): path is string => path !== null && existsSync(join(root, path));
  const into = readLedger(root, ticket).filter((entry) => entry.next === phase && entry.phase !== phase).at(-1);
  if (into !== undefined && exists(into.note)) return into.note;
  for (const earlier of PHASES.slice(0, PHASES.indexOf(phase)).reverse()) {
    const note = notePath(ticket, earlier);
    if (exists(note)) return note;
  }
  return null;
}

export interface RetryInput {
  /** The phase being run again. */
  phase: Phase;
  /** The phase the first attempt went on to, which this one ends by naming. */
  next: Phase | null;
  ticket: number | null;
  /** The note of the phase before it, from `handoffInto`. */
  note: string | null;
  iteration: string;
}

/** What a retried phase's fresh session is told before the phase's sections. */
export function retryPreamble(input: RetryInput): string {
  const { phase, ticket } = input;
  const ref = ticket === null ? "<n>" : String(ticket);
  const own = ticket === null ? `.ralph/logs/phase-<n>-${phase}.md` : notePath(ticket, phase);
  const first = PHASES.indexOf(phase) === 0;
  const following = input.next ?? PHASES[PHASES.indexOf(phase) + 1];
  const start = input.note !== null
    ? [`**Start from the handoff note of the phase before it:** \`${input.note}\`. It says`, `where \`${phase}\` starts. Read it first.`]
    : first
      ? ["There is no phase before `select`: start from the ticket itself."]
      : [`No handoff note from the phase before \`${phase}\` was found. Work out where it`, "starts from the branch: `git status`, `git log --oneline \"origin/$RALPH_BASE_BRANCH..HEAD\"`."];
  return [
    `# Retrying the \`${phase}\` phase of iteration ${input.iteration}${ticket === null ? "" : ` on #${ticket}`}`,
    "",
    `You are a FRESH session. The \`${phase}\` phase of this iteration already ran`,
    "once; an operator held the loop at the boundary after it and asked for it to",
    "be run again on the same work — after changing a model in the lineup, say, or",
    "because they do not trust its result. You have none of the earlier attempt's",
    "context, on purpose: do the phase again, and judge the work afresh rather than",
    "by what the earlier attempt concluded.",
    "",
    ...start,
    "",
    first
      ? `The ticket${ticket === null ? "" : ` #${ticket}`} is already claimed by this loop: do not take or claim another one, and do not claim it again. Orient, then map it.`
      : `Do NOT run the phases before \`${phase}\` (their sections are not below): no orientation sweep, no frontier, no new claim. The ticket is claimed and the branch is checked out.`,
    "",
    `Run \`${phase}\` — ${PHASE_SECTIONS[phase]} — by the sections below.`,
    following
      ? `At its end, write \`${own}\` afresh, replacing the earlier attempt's note, and end with \`<ralph>PHASE ${following} ${ref}</ralph>\` (or name the phase you actually go to next), exactly as §Phases says. The supervisor resumes this session from there.`
      : "There are no more boundaries: finish the iteration and end with one of the endings in §6, per the HARD RAIL.",
    "",
    "---",
    "",
  ].join("\n");
}

/** What a resume needs to know about the checkout it would resume in. */
export interface Checkout {
  /** The branch checked out; null when HEAD is detached or git cannot say. */
  branch: string | null;
  /** Whether `sha` is HEAD or one of its ancestors. */
  contains(sha: string): boolean;
}

/** The worktree's own git, bounded so a wedged repository answers "no" rather than hanging the supervisor. */
export function gitCheckout(root: string): Checkout {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  const current = git("branch", "--show-current");
  const branch = current.status === 0 ? current.stdout.trim() || null : null;
  return {
    branch,
    contains: (sha) => /^[0-9a-f]{4,64}$/i.test(sha) && git("merge-base", "--is-ancestor", sha, "HEAD").status === 0,
  };
}

/**
 * Why a ticket is not resumed from its ledger:
 *
 * - `missing`     no ledger, or nothing in it: no phase finished that we know of.
 * - `unrecorded`  its last line names no branch or head, so it cannot be
 *                 checked against anything — a line written before they were
 *                 recorded, or on a detached HEAD.
 * - `stale`       the handoff note that line names is not on disk.
 * - `mismatched`  the worktree contradicts it: another branch, or a history
 *                 that no longer holds the head it was written on.
 */
export const RESUME_FALLBACKS = ["missing", "unrecorded", "stale", "mismatched"] as const;
export type ResumeFallback = (typeof RESUME_FALLBACKS)[number];

export type ResumePoint =
  | { resume: true; phase: Phase; from: LedgerEntry & { branch: string; head: string }; note: string; why: string }
  | { resume: false; reason: ResumeFallback; why: string };

const short = (sha: string): string => sha.slice(0, 10);

/**
 * Where an interrupted ticket's work goes on: the phase after the last one
 * that finished, when the worktree still agrees with the ledger. The last line
 * is the latest attempt of the latest phase (`readLedger`). It must name a
 * branch and a head, its handoff note must be on disk, the branch must be the
 * one checked out, and the head must still be in its history. Anything short
 * of all four is a fallback with the reason, never a guess: the iteration then
 * starts from the top, which is how a claim was always resumed.
 */
export function resumePoint(root: string, ticket: number, checkout: Checkout): ResumePoint {
  const last = readLedger(root, ticket).at(-1);
  if (last === undefined) return { resume: false, reason: "missing", why: `#${ticket} has no phase ledger` };
  const at = `${last.phase} → ${last.next}`;
  if (!last.branch || !last.head) {
    return { resume: false, reason: "unrecorded", why: `#${ticket}'s ledger ends at ${at} without the branch and head it was written on` };
  }
  if (last.note === null || !existsSync(join(root, last.note))) {
    return {
      resume: false,
      reason: "stale",
      why: last.note === null
        ? `#${ticket}'s ledger ends at ${at} with no ${last.phase} handoff note`
        : `#${ticket}'s ${last.phase} handoff note ${last.note} is gone`,
    };
  }
  if (checkout.branch !== last.branch) {
    return {
      resume: false,
      reason: "mismatched",
      why: `#${ticket}'s ledger was written on ${last.branch}, but the worktree is on ${checkout.branch ?? "a detached HEAD"}`,
    };
  }
  if (!checkout.contains(last.head)) {
    return { resume: false, reason: "mismatched", why: `#${ticket}'s ledger head ${short(last.head)} is not in ${last.branch}'s history` };
  }
  return {
    resume: true,
    phase: last.next,
    from: { ...last, branch: last.branch, head: last.head },
    note: last.note,
    why: `${last.phase} finished at ${short(last.head)} on ${last.branch}`,
  };
}

/** What the fresh session that resumes an interrupted ticket is told before its phase's sections. */
export function resumePreamble(ticket: number, point: Extract<ResumePoint, { resume: true }>, iteration: string): string {
  const { phase, from, note } = point;
  const following = PHASES[PHASES.indexOf(phase) + 1];
  return [
    `# Resuming #${ticket} at the \`${phase}\` phase, iteration ${iteration}`,
    "",
    `You are a FRESH session. An earlier iteration on #${ticket} was interrupted after`,
    `it finished \`${from.phase}\` — stopped at a phase boundary, stopped now, crashed, or`,
    `cut off by a restart — and its ledger (\`${ledgerPath(ticket)}\`) says the work goes`,
    `on at \`${phase}\`. The supervisor checked that against this worktree: it is still`,
    `on \`${from.branch}\`, and the head \`${from.head}\` the ledger recorded is in its history.`,
    "",
    `**Start from the handoff note of \`${from.phase}\`:** \`${note}\`. Read it first.`,
    "",
    `The interrupted session may have got further than its note: \`${phase}\` can have`,
    "begun before it stopped. Look before you work — `git status`,",
    `\`git log --oneline ${short(from.head)}..HEAD\`, and whether the branch already has a PR`,
    "— and carry on from what is there. Never reset, clean or discard it, and never",
    "open a second PR for the branch.",
    "",
    `Do NOT run the phases before \`${phase}\` (their sections are not below): no orientation sweep, no frontier, no new claim. #${ticket} is claimed by this loop and its branch is checked out.`,
    "",
    `Run \`${phase}\` — ${PHASE_SECTIONS[phase]} — by the sections below.`,
    following
      ? `At its end, write \`${notePath(ticket, phase)}\` and end with \`<ralph>PHASE ${following} ${ticket}</ralph>\` (or name the phase you actually go to next), exactly as §Phases says. The supervisor resumes this session from there.`
      : "There are no more boundaries: finish the iteration and end with one of the endings in §6, per the HARD RAIL.",
    "",
    "---",
    "",
  ].join("\n");
}

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1]! : null;
}

const USAGE = [
  "usage: phase-prompt.ts retry --phase <phase> [--next <phase>] [--ticket N] --iteration I < rendered-prompt",
  "       phase-prompt.ts resume --ticket N --iteration I < rendered-prompt",
].join("\n");

/** A field of the tab-separated machine line: never a tab or a newline in it. */
const field = (text: string): string => text.replace(/[\t\n]+/g, " ");

export function main(
  argv: string[],
  stdin: string,
  root: string,
  checkout: (root: string) => Checkout = gitCheckout,
): { code: number; out: string } {
  const [mode, ...rest] = argv;
  if ((mode !== "retry" && mode !== "resume") || stdin.trim() === "") return { code: 64, out: USAGE };
  if (mode === "resume") {
    const raw = flag(rest, "ticket");
    if (raw === null || !/^[1-9][0-9]*$/.test(raw)) return { code: 64, out: USAGE };
    const ticket = Number(raw);
    const point = resumePoint(root, ticket, checkout(root));
    if (!point.resume) return { code: 0, out: `fallback\t${point.reason}\t-\t${field(point.why)}` };
    const preamble = resumePreamble(ticket, point, flag(rest, "iteration") ?? "?");
    const line = `resume\t${point.phase}\t${point.from.phase}\t${field(point.why)}`;
    return { code: 0, out: `${line}\n${phasePrompt(stdin, point.phase, preamble)}` };
  }
  const phase = flag(rest, "phase");
  const next = flag(rest, "next");
  if (!isPhase(phase) || (next !== null && !isPhase(next))) return { code: 64, out: USAGE };
  const raw = flag(rest, "ticket");
  const ticket = raw !== null && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  const preamble = retryPreamble({
    phase,
    next,
    ticket,
    note: ticket === null ? null : handoffInto(root, ticket, phase),
    iteration: flag(rest, "iteration") ?? "?",
  });
  return { code: 0, out: phasePrompt(stdin, phase, preamble) };
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const { code, out } = main(process.argv.slice(2), stdin, process.cwd());
  if (code === 0) process.stdout.write(out);
  else console.error(out);
  process.exitCode = code;
}
