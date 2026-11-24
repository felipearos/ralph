#!/usr/bin/env bun
/**
 * The prompt for a FRESH session that picks an iteration up after the
 * supervisor has waited on its pull request, or after the token cap stopped it.
 *
 * Why a fresh session: an iteration's cost is turns × context, and by the time
 * a PR is open the context holds everything the implementation read — a
 * median 246K tokens on 2026-09-18/19, 773K at worst — none of which CI, the
 * queue or the journal needs. Half of all cache reads those two days happened
 * after the PR was opened. A new session starts from this prompt instead.
 *
 * It is the rendered iteration prompt (stdin) cut down to the `finish` phase's
 * sections by the per-phase prompt builder (`phase-prompt.ts`) — §0–§3, which
 * are about finding and building a ticket, are gone — under a preamble that
 * says where the work stands. The rest is kept verbatim, so the rules for CI,
 * merging, journaling and handing off have one source, `prompt.md`, and cannot
 * drift from it.
 *
 * The preamble is the coder's unless `--role pr-medic` says otherwise. The
 * medic's pull request is the operator's, so its fresh session must never be
 * told to check mergeability and enqueue at green, to push "without force" or
 * to draft the pull request when it is stuck: its own lines send it to the
 * medic prompt's handover and blocked path instead (felipearos/ralph#248). Any
 * other role, and a missing or unknown `--role`, gets the coder's text
 * byte for byte.
 *
 *   ship-prompt.ts ship   --wait <pr-wait json file> [--history <jsonl file>]
 *                         --round N --max-rounds M --handoff <path> --iteration I [--role R]
 *   ship-prompt.ts budget --used N --limit M --strike K --strikes S
 *                         [--issue n] --handoff <path> --iteration I [--role R]
 */
import { existsSync, readFileSync } from "node:fs";

import { phasePrompt } from "./phase-prompt";
import { DEFAULT_ROLE, isRole, type Role } from "./roles";

export interface WaitResult {
  outcome: string;
  mode?: string;
  pr?: string;
  head?: string | null;
  elapsedSeconds?: number;
  checks?: Array<{ name: string; state: string; url: string | null }>;
  detail?: string;
}

function parseWait(raw: string): WaitResult {
  try {
    const parsed = JSON.parse(raw) as WaitResult;
    if (parsed && typeof parsed.outcome === "string") return parsed;
  } catch {
    // Fall through: an unreadable result is an outcome of its own.
  }
  return { outcome: "unreadable", detail: `the supervisor's wait produced no result: ${raw.trim().slice(0, 200)}` };
}

const checkLines = (wait: WaitResult): string =>
  (wait.checks ?? [])
    .map((check) => `  - ${check.name}: ${check.state}${check.url ? ` — ${check.url}` : ""}`)
    .join("\n");

/**
 * The pr-medic's next step, by outcome. Never a merge, an enqueue or a merge
 * wait — the operator merges — and never a second CI wait from here: a red
 * round is journalled and the claim kept, so the gate hands the pull request
 * back to an iteration that has all of the medic prompt's diagnosis sections,
 * which this session does not.
 */
export function medicNextStep(wait: WaitResult): string {
  const pr = wait.pr ?? "<pr>";
  const never = "Never merge, never enqueue: the operator merges.";
  const keep = "leave the claim, journal where it stands (§6), and end with `<ralph>DONE</ralph>`: the gate resumes the claim when CI has an answer.";
  switch (wait.outcome) {
    case "green":
      return [
        `CI is green on the pull request's head. Continue at §5.6, the green handover: write the`,
        `comment, \`case.ts done ${pr}\` to release the claim, then §6's journal and \`<ralph>DONE</ralph>\`.`,
        never,
      ].join("\n");
    case "red":
      return [
        `CI is red again. Follow §5.5's **red** branch: read the log (\`bk-log.ts --pr ${pr}\`) into the`,
        `handoff note. At the cap (\`case.ts status ${pr}\`), take §5.7's blocked path; otherwise`,
        `leave the claim, journal the round and end with \`<ralph>DONE</ralph>\` — the gate hands the`,
        `pull request straight back to this loop, and that iteration diagnoses it afresh. ${never}`,
      ].join("\n");
    case "head-mismatch":
      return [
        `The pull request's head is not the commit this iteration pushed: the operator pushed on`,
        `top. Step back as §5.3's exit 4 says — \`case.ts drop ${pr}\`, journal, \`<ralph>DONE</ralph>\`.`,
        `Never push over it. ${never}`,
      ].join("\n");
    case "merged":
    case "closed":
      return [
        `The operator has the pull request (${wait.outcome}). \`case.ts drop ${pr}\`, journal (§6), and end`,
        `with \`<ralph>DONE</ralph>\`. Nothing is left to wait for.`,
      ].join("\n");
    case "no-checks":
      return [
        `No required check ever reported on the head. If none will — a pipeline that skipped it —`,
        `take §5.7's blocked path; otherwise ${keep} ${never}`,
      ].join("\n");
    default:
      // rounds-exhausted, timeout, unreadable — and dequeued, which a CI wait never returns.
      return [`The wait ended as **${wait.outcome}**. Do not wait again from here: ${keep}`, never].join("\n");
  }
}

/** What the fresh session does next, by outcome. The prompt sections below hold the how. */
export function nextStep(
  wait: WaitResult,
  round: number,
  maxRounds: number,
  role: Role = DEFAULT_ROLE,
  merge: string = process.env.RALPH_MERGE ?? "loop",
  method: string = process.env.RALPH_MERGE_METHOD ?? "",
): string {
  if (role === "pr-medic") return medicNextStep(wait);
  const pr = wait.pr ?? "<pr>";
  const again = round < maxRounds;
  const awaitAgain = again
    ? `end with \`<ralph>AWAIT_PR ${pr} ci</ralph>\` and the supervisor waits again`
    : "hand off instead of waiting again: this iteration has used its waits";
  switch (wait.outcome) {
    case "green":
      // `merge: "human"`: §5.6 hands the PR to a person, so there is no
      // enqueue to do and no merge wait to hand back.
      if (merge === "human") {
        return [
          `CI is green on the PR's head. Continue at §5.5, then §5.6: a person merges on this`,
          `project, so once its three conditions hold, hand the PR off as §5.6 says and end with`,
          `\`<ralph>DONE</ralph>\`. Never merge it and never end with \`AWAIT_PR ${pr} merge\`.`,
        ].join("\n");
      }
      // `mergeMethod: "direct"`: no queue, so the loop merges and the merge
      // wait only confirms the merge landed before step 7's cleanup.
      if (method === "direct") {
        return [
          `CI is green on the PR's head. Continue at §5.5, then §5.6: check mergeability and merge it`,
          `(\`gh pr merge ${pr} --squash\`, §5.6). Once it succeeds, end with`,
          `\`<ralph>AWAIT_PR ${pr} merge</ralph>\` so the supervisor sees the merge land.`,
        ].join("\n");
      }
      // GitHub's queue puts no label on the PR; §5.6's enqueue note names the read.
      if (method === "github-queue") {
        return [
          `CI is green on the PR's head. Continue at §5.5, then §5.6: check mergeability and enqueue`,
          `(\`gh pr merge ${pr}\`). Once enqueued — or if \`isInMergeQueue\` already reads true — end with`,
          `\`<ralph>AWAIT_PR ${pr} merge</ralph>\` instead of running the merge wait yourself.`,
        ].join("\n");
      }
      return [
        `CI is green on the PR's head. Continue at §5.5, then §5.6: check mergeability and enqueue.`,
        `Once enqueued — or if the PR already carries the queue's label — end with`,
        `\`<ralph>AWAIT_PR ${pr} merge</ralph>\` instead of running the merge wait yourself.`,
      ].join("\n");
    case "red":
      return [
        `CI is red. Continue at §5.4's red path: push the gate failure, then apply the`,
        `project's flaky-spec rule and the budget for a check you cannot reproduce. The`,
        `earlier waits below are how you know whether this is the second red. A flake`,
        `(§5.4: \`bk-log.ts\` shows only timeouts or files red on other branches, in tests`,
        `the diff does not touch) is never a strike: a second one ends RETRY_LATER, not`,
        `blocked. After pushing a fix or a re-run, ${awaitAgain}.`,
      ].join("\n");
    case "no-checks":
      return [
        `No required check ever reported on the PR's head. Look once at why (a skipped`,
        `pipeline, a missing webhook); if a push or re-trigger fixes it, ${awaitAgain}.`,
        `Otherwise hand off per the HARD RAIL.`,
      ].join("\n");
    case "head-mismatch":
      return [
        `The PR's head is not the commit the previous session had checked out. Compare`,
        `\`git rev-parse HEAD\` with the PR, push what is missing (never force over`,
        `someone else's push), then ${awaitAgain}.`,
      ].join("\n");
    case "merged":
      return [
        `The PR merged. Push \`pr-merged\` as §5.6 says, then do §5.7's cleanup and §6's`,
        `journal. Nothing is left to wait for.`,
      ].join("\n");
    case "dequeued":
      // `mergeMethod: "direct"` has no queue: dequeued means `gh pr merge`
      // did not land, and there is nothing to re-queue.
      if (method === "direct") {
        return [
          `The merge did not land: there is no queue on this project, and the PR is still open.`,
          `Read why \`gh pr merge ${pr} --squash\` failed — a check that is not green, a conflict —`,
          `and follow §5.6 for it; after pushing a fix, ${awaitAgain}. Never re-queue, and never`,
          `pass \`--admin\`.`,
        ].join("\n");
      }
      return [
        `The PR left the merge queue, or never entered it. Follow §5.6's **dequeued**`,
        `branch; after pushing a fix, ${awaitAgain}. If it left because of something`,
        `outside the repository (the deploy provider blocked it, CI is down), do not`,
        `requeue: journal it, leave the claim, and end with \`<ralph>RETRY_LATER</ralph>\`.`,
        `After the one re-queue of an unchanged head that branch allows, end with`,
        `\`<ralph>AWAIT_PR ${pr} merge</ralph>\`.`,
      ].join("\n");
    case "rounds-exhausted":
      return [
        `The supervisor has waited ${maxRounds} times this iteration and will not wait`,
        `again. Do not end with AWAIT_PR. Hand off: journal where the PR stands, leave`,
        `the claim in place, and end with \`<ralph>DONE</ralph>\`.`,
      ].join("\n");
    default:
      // closed, timeout, unreadable
      return [
        `The wait ended as **${wait.outcome}**. Follow §5.6 for a closed PR; for a`,
        `timeout or an unreadable PR, ${again ? "you may wait once more if CI is plainly still running, otherwise " : ""}hand off`,
        `per the HARD RAIL: journal, leave the claim, \`<ralph>DONE</ralph>\`.`,
      ].join("\n");
  }
}

export interface ShipInput {
  wait: WaitResult;
  history: WaitResult[];
  round: number;
  maxRounds: number;
  handoff: string;
  iteration: string;
  /** The loop's role; the coder's text when absent. */
  role?: Role;
}

export function shipPreamble(input: ShipInput): string {
  const { wait } = input;
  const medic = input.role === "pr-medic";
  const earlier = input.history
    .map((entry, i) => `  ${i + 1}. ${entry.mode ?? "ci"} → ${entry.outcome}${entry.head ? ` on ${entry.head.slice(0, 12)}` : ""}${entry.detail ? ` (${entry.detail})` : ""}`)
    .join("\n");
  const checks = checkLines(wait);
  return [
    `# Resuming iteration ${input.iteration} after the supervisor's wait on PR #${wait.pr ?? "?"}`,
    "",
    ...(medic
      ? [
          "You are a FRESH session continuing an iteration that is already under way. An",
          "earlier session of this iteration pushed to the operator's pull request through",
          "`pr-medic/push.ts`, commented on it, and handed the CI wait to the supervisor,",
          "which has now finished it. You have none of that session's context, on purpose.",
          "",
          `**Read the handoff note first:** \`${input.handoff}\`. It names the pull request,`,
          "the branch and base, the head you pushed, the diagnosis, and the pushes made",
          "against the cap. Keep it current: the next iteration starts from it too.",
          "",
          "The pull request is the operator's. You never merge it, enqueue it, approve it",
          "or mark it a draft, and you push to it only through `pr-medic/push.ts`.",
          "",
        ]
      : [
          "You are a FRESH session continuing an iteration that is already under way. An",
          "earlier session of this iteration built the change, opened the PR and handed",
          "the wait to the supervisor, which has now finished it. You have none of that",
          "session's context, on purpose: it is what made waiting and CI work expensive.",
          "",
          `**Read the handoff note first:** \`${input.handoff}\`. It names the ticket, the`,
          "branch, what was built, and what the journal must say. Keep it current: update",
          "it before you end with `AWAIT_PR`, because the next session starts from it too.",
          "",
        ]),
    "Do NOT run §0–§3 (they are not below): no orientation sweep, no journal",
    "reading, no frontier, no new claim. Check the worktree with `git status` and",
    "the PR with `gh pr view` — that is all the orienting this needs.",
    "",
    "This session is the `finish` phase: every phase boundary is behind it, so",
    "never end with `<ralph>PHASE …</ralph>`. §Phases and the boundary lines in",
    "§4 and §5 describe the session that built the change, not this one.",
    "",
    "## Where it stands",
    "",
    `- Wait: ${wait.mode ?? "ci"}, round ${input.round} of ${input.maxRounds} this iteration`,
    `- Outcome: **${wait.outcome}**${wait.detail ? ` — ${wait.detail}` : ""}`,
    `- PR head: ${wait.head ?? "unknown"}`,
    ...(checks ? ["- Checks judged:", checks] : []),
    ...(earlier ? ["- Earlier waits this iteration:", earlier] : ["- Earlier waits this iteration: none"]),
    "",
    "## What to do",
    "",
    nextStep(wait, input.round, input.maxRounds, input.role),
    "",
    ...(medic
      ? ["Never poll with `sleep` — waiting is the supervisor's job, and each poll here", "would re-read this session's whole context."]
      : [
          "Never poll with `sleep` — waiting is the supervisor's job, and each poll here",
          "would re-read this session's whole context. `<ralph>AWAIT_PR <pr> ci|merge</ralph>`",
          "is how you hand it back.",
        ]),
    "",
    "---",
    "",
  ].join("\n");
}

export interface BudgetInput {
  used: number;
  limit: number;
  strike: number;
  strikes: number;
  issue: string | null;
  handoff: string;
  iteration: string;
  /** The loop's role; the coder's text when absent. */
  role?: Role;
}

/**
 * The pr-medic's budget handoff. Its work is on the operator's branch, so the
 * coder's "push what exists only locally" and "draft the PR" are exactly the
 * two writes it must not make here: a push goes through the fence after the
 * gates, which this session does not run, and a draft is the operator's call.
 */
function medicBudgetSteps(input: BudgetInput, final: boolean): string[] {
  return [
    "You are a fresh session with a small cap of your own. **Do not continue the",
    "case's work** — no rebasing, no fixing, no CI forensics. Your job is to leave",
    "the pull request in a state the next attempt can pick up cleanly:",
    "",
    '1. Look, briefly: `git status`, `git log --oneline -5`, and',
    '   `bun "$RALPH_HOME/pr-medic/case.ts" status "$RALPH_INTAKE_PR"`.',
    `   The previous session's handoff note, if it wrote one, is \`${input.handoff}\`.`,
    "2. **Push nothing.** The branch is the operator's, and a push to it goes through",
    "   `pr-medic/push.ts` after §4's gates, which this session does not run. Your",
    "   commits stay on the local `$RALPH_LOOP_NAME/pr-<pr>` branch and uncommitted",
    "   changes where they are; the next iteration's §0 recovers them.",
    final
      ? `3. This is strike ${input.strike} of ${input.strikes}: it is **stuck**. Take §5.7's blocked path — \`case.ts blocked\` with a \`blocked:\` comment saying the cap was hit and where the work stands. Never draft, close, merge or enqueue the pull request.`
      : `3. This is strike ${input.strike} of ${input.strikes}: leave the \`-wip\` claim in place so the gate hands the pull request back to this loop, and say nothing on it.`,
    "4. Journal it (§6) with outcome `handed off` or `blocked`, and end with",
    "   `<ralph>DONE</ralph>`. Never `AWAIT_PR` or `PHASE` from here.",
  ];
}

export function budgetPreamble(input: BudgetInput): string {
  const millions = (n: number): string => `${(n / 1e6).toFixed(0)}M`;
  const final = input.strike >= input.strikes;
  if (input.role === "pr-medic") {
    return [
      `# Iteration ${input.iteration} was stopped at its token cap`,
      "",
      `The supervisor stopped this iteration's working session: it had used`,
      `${millions(input.used)} tokens against a cap of ${millions(input.limit)}. Normal iterations use`,
      "25M–65M; one past the cap is going around in circles, and more of the same",
      "session would not have ended it.",
      "",
      ...medicBudgetSteps(input, final),
      "",
      "---",
      "",
    ].join("\n");
  }
  return [
    `# Iteration ${input.iteration} was stopped at its token cap`,
    "",
    `The supervisor stopped this iteration's working session: it had used`,
    `${millions(input.used)} tokens against a cap of ${millions(input.limit)}. Normal iterations use`,
    "25M–65M; one past the cap is going around in circles, and more of the same",
    "session would not have ended it.",
    "",
    "You are a fresh session with a small cap of your own. **Do not continue the",
    "ticket's work** — no implementing, no investigating, no CI forensics. Your job",
    "is to leave the ticket in a state the next attempt can pick up cleanly:",
    "",
    `1. Look, briefly: \`git status\`, \`git log --oneline "origin/$RALPH_BASE_BRANCH..HEAD"\`,`,
    `   and the ticket's PR if it has one. ${input.issue ? `The claimed issue is #${input.issue}.` : "Find the claimed issue by this loop's `-wip` label."}`,
    `   The previous session's handoff note, if it wrote one, is \`${input.handoff}\`.`,
    "2. Push commits that exist only locally to the ticket branch, without force.",
    "   Leave uncommitted changes where they are; the next iteration's §0 recovers them.",
    "3. Comment on the issue: the cap was hit, what state the work is in, and what",
    "   the next attempt should do differently. End it with the usage footer.",
    final
      ? `4. This is strike ${input.strike} of ${input.strikes} for this ticket: it is **stuck**. Take §6's stuck path — draft the PR if there is one, push \`ticket-blocked\`, swap the claim for the blocked label.`
      : `4. This is strike ${input.strike} of ${input.strikes}: leave the \`-wip\` claim in place so the next iteration resumes it.`,
    "5. Journal it (§6) with outcome `handed off` or `blocked`, and end with",
    "   `<ralph>DONE</ralph>`. Never `AWAIT_PR` or `PHASE` from here.",
    "",
    "---",
    "",
  ].join("\n");
}

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1]! : null;
}

const USAGE =
  "usage: ship-prompt.ts ship --wait F [--history F] --round N --max-rounds M --handoff P --iteration I [--role R] < rendered-prompt\n" +
  "       ship-prompt.ts budget --used N --limit M --strike K --strikes S [--issue n] --handoff P --iteration I [--role R] < rendered-prompt";

export async function main(argv: string[], stdin: string): Promise<{ code: number; out: string }> {
  const [mode, ...rest] = argv;
  const handoff = flag(rest, "handoff");
  const iteration = flag(rest, "iteration") ?? "?";
  // An unknown or missing role is the coder's text: the session still gets a
  // prompt, which a refusal here would cost it.
  const named = flag(rest, "role");
  const role: Role = isRole(named) ? named : DEFAULT_ROLE;
  if (handoff === null || stdin.trim() === "") return { code: 64, out: USAGE };

  if (mode === "ship") {
    const waitFile = flag(rest, "wait");
    if (waitFile === null) return { code: 64, out: USAGE };
    const historyFile = flag(rest, "history");
    const history =
      historyFile !== null && existsSync(historyFile)
        ? readFileSync(historyFile, "utf8").split("\n").filter(Boolean).map(parseWait)
        : [];
    const wait = parseWait(existsSync(waitFile) ? readFileSync(waitFile, "utf8") : "");
    const preamble = shipPreamble({
      wait,
      history,
      round: Number(flag(rest, "round") ?? "1"),
      maxRounds: Number(flag(rest, "max-rounds") ?? "1"),
      handoff,
      iteration,
      role,
    });
    return { code: 0, out: phasePrompt(stdin, "finish", preamble) };
  }

  if (mode === "budget") {
    const preamble = budgetPreamble({
      used: Number(flag(rest, "used") ?? "0"),
      limit: Number(flag(rest, "limit") ?? "0"),
      strike: Number(flag(rest, "strike") ?? "1"),
      strikes: Number(flag(rest, "strikes") ?? "2"),
      issue: flag(rest, "issue"),
      handoff,
      iteration,
      role,
    });
    return { code: 0, out: phasePrompt(stdin, "finish", preamble) };
  }
  return { code: 64, out: USAGE };
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const { code, out } = await main(process.argv.slice(2), stdin);
  if (code === 0) process.stdout.write(out);
  else console.error(out);
  process.exitCode = code;
}
