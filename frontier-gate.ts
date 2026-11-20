#!/usr/bin/env bun
/**
 * The frontier gate — block until there is something for an iteration to do.
 *
 * A supervisor that spawns an iteration into an empty frontier burns a whole
 * fresh-context `claude -p` turn to be told `ALL_BLOCKED`, and then stops. For
 * one loop that is merely wasteful; for a second loop it is fatal, because the
 * frontier prints at most one ticket per spec tree — so while the first loop
 * holds the only unblocked tree, the second loop's frontier is *legitimately*
 * empty and it would spin down instantly, every time, until the backlog widens.
 *
 * So the supervisor asks first, and waits rather than spawning. This file is
 * that question. It is READ-ONLY by construction: the frontier is consulted
 * through `--take-one --dry-run`, which keeps every live re-read and skips only
 * the claim, and the pull requests through `gh pr list`. Nothing here writes,
 * because a gate that claimed a ticket would hand it to a process that has not
 * started yet — and would lose it outright if the supervisor then died.
 *
 * It does READ one local record: the verdict this loop's supervisor is
 * holding on (`gate-verdict-store.ts`, #771), written after an iteration
 * refuted a "work available" this gate reported. A blocking wait holds on that
 * same verdict instead of waking the loop for it again, hands back once its
 * budget is spent, and releases when the verdict becomes a definite "no work".
 * Writing, clearing and notifying stay the supervisor's; the gate does none.
 *
 * "Something to do" is not the frontier alone. `prompt.md` §1 puts shepherding
 * a pull request owned by this loop ahead of the frontier, and its priority 1
 * is also where a resumable `<loop>-wip` claim lives — the frontier excludes
 * claimed tickets by design, so neither probe below can see one. Local-only
 * work is a fourth source that may exist before GitHub carries any record.
 * Any one of them is enough to spawn.
 *
 * The shepherd and recovery probes run first only because each is one API
 * call against the frontier's dozen or so, and an idle loop asks these questions
 * on every poll.
 *
 * A probe that cannot answer — the network is down, `gh` is unauthenticated —
 * is a wait, not a spawn. An iteration could not have done the work either,
 * and the alternative is a supervisor that empties its iteration cap into a
 * dead network.
 *
 * Usage:
 *   ralph/frontier-gate.ts <poll-seconds>   wait until there is work, then exit 0
 *   ralph/frontier-gate.ts --once           report the verdict now; 0 work, 1 none
 */

import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  doneLabelFor,
  loopRoster,
  type LoopName,
  frontierTracker,
  HUMAN_REASONS,
  closableParent,
  parsePlanFences,
  type OpenIssue,
  type PlanFences,
} from "./frontier/next-tasks";
import { TrackerUnavailableError, type Tracker } from "./tracker/types";
import { join } from "node:path";

// Moved to the frontier tool (#810) so `--take-one` can claim a closable parent
// itself; re-exported so every importer of the gate keeps compiling.
export { closableParent, parsePlanFences, type OpenIssue, type PlanFences } from "./frontier/next-tasks";

import { hasPendingControl } from "./control-inbox";
import {
  DEFAULT_HOLD_BUDGET_HOURS,
  budgetSpent,
  compactDuration,
  describeSubject,
  gateVerdictPath,
  holdAge,
  holdBudgetHours,
  readHeld,
  sameSubject,
  verdictSubject,
  type HeldVerdict,
} from "./gate-verdict-store";
import { RALPH_HOME, projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { DEFAULT_ROLE, readOnlyCheckout, shepherds, type Role } from "./roles";
import { roleOf } from "./roster";

/**
 * The marker `prompt.md` §5.3 writes into every pull request body this loop
 * opens. It is the only evidence a pull request belongs to one of the loops —
 * the `ralph/*`, `rafa/*`, `remo/*` and `rulo/*` branch prefixes are naming conventions parallel
 * agents share, and every pull request here is authored by the same human
 * account. The captured loop name is the durable owner: later iterations of
 * that same loop may resume the pull request, while the other loop continues
 * to its own claim or frontier instead of becoming a second shepherd.
 *
 * Ownership is loop-wide rather than run-specific. A supervisor restart mints
 * a new run id, but must still recover the pull request its worktree owns.
 */
/** Built from the project's roster when first needed, like the claim labels. */
export const provenance = (): RegExp => new RegExp(`🤖 (${loopRoster().join("|")}) loop`, "i");

// Generous rather than tuned: past this many open pull requests the shepherd
// probe could miss the loop's own, which is the exact failure it exists to
// prevent. The repo has never been near it.
const PR_LIMIT = 100;

// The maintenance census. It runs on every poll of a steady idle loop — an
// empty frontier with a non-empty closure list is what `plan.md` ships today —
// so it is one call, not per-issue. It is still small beside the frontier
// probe above it, which pages through the open issues (with their blockers),
// the closed issues and the open pull requests.
const ISSUE_LIMIT = 500;

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/** One reason the gate would spawn, or the reason it would not. */
export type Verdict =
  | { work: true; why: string }
  | { work: false; why: string }
  | {
      work: false;
      undetermined: true;
      why: string;
      /** GitHub throttled the frontier read; the gate backs off instead of polling on schedule. */
      rateLimited?: true;
      retryAfterSeconds?: number | null;
    };

/** The frontier's report that GitHub throttled it (`frontier/github-rate-limit.ts`). */
export interface FrontierRateLimit {
  retryAfterSeconds: number | null;
}

/** What `next-tasks.ts --take-one` prints. Only the fields the gate reads. */
export interface TakeOnePick {
  ticket: number | null;
  title: string | null;
  claimed: boolean;
  obstructed: { number: number; reason: string }[];
  /** Absent from a frontier that predates it. */
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
  /**
   * The pick is an open closure parent from the plan's `## Parent closure
   * exceptions`, handed out as a claimed unit (#810). Absent from a frontier
   * that predates it, which reads as an ordinary ticket.
   */
  closure?: boolean;
  /**
   * Per-reason counts of tickets waiting on a person, printed on an empty pick
   * (#811). Parsed JSON, so untrusted: read only through `waitingOnOperatorNote`.
   */
  waitingOnOperator?: unknown;
}

/**
 * The " — N waiting on an operator (reason count, ...)" suffix for an empty
 * frontier, or "" when there is nothing to say. A malformed field (non-object,
 * negative or fractional count, a reason it does not know) is treated as
 * absent: the gate then reads exactly as it did before #811, rather than
 * printing a wrong number.
 */
export function waitingOnOperatorNote(field: unknown): string {
  if (typeof field !== "object" || field === null || Array.isArray(field)) return "";
  const record = field as Record<string, unknown>;
  // A key this gate does not know is a reason from a newer frontier: summing
  // only the known ones would print a confidently low total, so say nothing.
  const known: ReadonlySet<string> = new Set(HUMAN_REASONS);
  if (Object.keys(record).some((key) => !known.has(key))) return "";
  const counts: [string, number][] = [];
  for (const reason of HUMAN_REASONS) {
    // A missing key is a zero: an older frontier may know fewer reasons.
    if (!(reason in record)) continue;
    const value = record[reason];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return "";
    if (value > 0) counts.push([reason, value]);
  }
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return "";
  return ` — ${total} waiting on an operator (${counts.map(([reason, count]) => `${reason} ${count}`).join(", ")})`;
}

/** What `gh pr list` returns for the shepherd probe. */
export interface PullRequest {
  number: number;
  isDraft: boolean;
  body: string | null;
  /** `[{ name, ... }]` from gh; absent from callers that predate #424. */
  labels?: unknown;
  /** Absent from callers that predate #424. */
  headRefName?: string;
}

/** An open issue carrying this loop's `-wip` label — an unfinished claim. */
export interface ClaimedIssue {
  number: number;
}

/** Work that exists only in this loop's current checkout. */
export interface LocalRecovery {
  branch: string | null;
  ahead: number;
  /** TRACKED modifications only — see `probeLocalRecovery` for why. */
  dirty: boolean;
  /** A finalized squash-merged branch still has commits "ahead" of main. */
  finalizedMergedPullRequest?: boolean;
}

/**
 * The other roster loop whose `<name>-wip` label a pull request carries, or
 * `null`. An adopting loop (the medic, #424) labels the pull request it takes
 * over; the stamping loop must then leave it alone rather than become a second
 * shepherd. Matched against the roster, never a bare `*-wip`, so an unrelated
 * label cannot fence a loop off its own work. Read defensively and never
 * throws: this is on the supervisor's gate path, and an odd label shape means
 * "not adopted", which is the behaviour before the label existed.
 */
export function adoptedBy(pr: PullRequest, loop: LoopName): string | null {
  const labels = pr.labels;
  if (!Array.isArray(labels)) return null;
  let roster: readonly string[];
  try {
    roster = loopRoster();
  } catch {
    return null;
  }
  for (const label of labels) {
    const name: unknown = label !== null && typeof label === "object" ? (label as { name?: unknown }).name : null;
    if (typeof name !== "string" || !name.toLowerCase().endsWith("-wip")) continue;
    const owner = name.slice(0, -"-wip".length).toLowerCase();
    if (owner !== loop && roster.includes(owner)) return owner;
  }
  return null;
}

/**
 * This loop's claims minus those whose pull request another roster loop has
 * adopted (#424). The claim's `<loop>-wip` stays on the issue while the medic
 * works its pull request, so without this the gate would resume a claim an
 * iteration must leave alone — and spin. Read from the pull requests already
 * listed, no new call: unreadable (`null`) leaves the claims as they are, and
 * the prompt is the fence then.
 */
export function liveClaims(
  claims: ClaimedIssue[] | null | undefined,
  prs: PullRequest[] | null,
  loop: LoopName,
): ClaimedIssue[] | null | undefined {
  if (prs === null || claims === null || claims === undefined) return claims;
  const adopted = (n: number): boolean =>
    prs.some(
      (pr) =>
        provenance().exec(pr.body ?? "")?.[1]?.toLowerCase() === loop &&
        typeof pr.headRefName === "string" &&
        // `<loop>/<n>` with or without a slug, as `frontier/next-tasks.ts` parses branches.
        (pr.headRefName === `${loop}/${n}` || pr.headRefName.startsWith(`${loop}/${n}-`)) &&
        adoptedBy(pr, loop) !== null,
    );
  return claims.filter((claim) => !adopted(claim.number));
}

/**
 * Does a pull request carry `name` (case-insensitive)? Read as defensively as
 * `adoptedBy`: an absent, non-array or malformed `labels` means "not labelled"
 * and never throws, since this too sits on the supervisor's gate path.
 */
function hasLabel(pr: PullRequest, name: string): boolean {
  const labels = pr.labels;
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => {
    const value: unknown = label !== null && typeof label === "object" ? (label as { name?: unknown }).name : null;
    return typeof value === "string" && value.toLowerCase() === name.toLowerCase();
  });
}

/**
 * Is there a pull request an iteration would shepherd? A stamped *draft* is a
 * deliberate blocked handoff (`prompt.md` §1) — spawning an iteration for one
 * would produce an iteration that reads it, leaves it alone, and exits, which
 * is the exact spin the gate exists to prevent. An open PR carrying the loop's
 * `-done` label is the same: on a `merge: "human"` project it was handed to a
 * person to merge (`tracker.ts handoff`), and the loop has nothing left to do
 * on it until someone takes the label off to hand it back.
 *
 * Among several candidates, one labelled `migration-applied` comes first: the
 * operator applied its migration by hand and readied it (#432, #433), and
 * until it merges production is ahead of `main`, which reds every other pull
 * request — so it must not wait behind an ordinary one in `gh pr list` order.
 * Otherwise the first match, as before.
 */
export function shepherdable(prs: PullRequest[], loop: LoopName): PullRequest | null {
  const candidates = prs.filter((pr) => {
    if (pr.isDraft) return false;
    if (hasLabel(pr, doneLabelFor(loop))) return false;
    if (adoptedBy(pr, loop) !== null) return false;
    const owner = provenance().exec(pr.body ?? "")?.[1]?.toLowerCase();
    return owner === loop;
  });
  return candidates.find((pr) => hasLabel(pr, "migration-applied")) ?? candidates[0] ?? null;
}

/**
 * The shepherd answer, shared by `decide` and `probe`. Shared rather than
 * duplicated because `probe` skips the frontier entirely when this hits: with
 * the check written out twice, reordering `decide` would silently turn that
 * short-circuit into an "undetermined" and nothing would fail.
 */
function shepherdVerdict(prs: PullRequest[] | null, loop: LoopName): Verdict | null {
  const pr = prs === null ? null : shepherdable(prs, loop);
  const display = `${loop[0]!.toUpperCase()}${loop.slice(1)}`;
  return pr === null ? null : { work: true, why: `${display} PR #${pr.number} to shepherd` };
}

/** What the probes came back with. `null` is always "could not read". */
export interface Probes {
  prs: PullRequest[] | null;
  pick: TakeOnePick | null;
  /**
   * This loop's open `-wip` issues; one entry is enough to spawn. `null` means
   * the probe ran and could not be read, which vetoes a definitive stop below.
   * Left absent entirely (as callers that predate the probe do) it takes no
   * part in the answer at all.
   */
  claims?: ClaimedIssue[] | null;
  /** Local-only state that must wake the iteration before frontier selection. */
  localRecovery?: LocalRecovery | null;
  /** Absent when the frontier answered, since the question is then moot. */
  closableParent?: number | null;
  /** Set when the frontier could not be read because GitHub throttled it. */
  frontierRateLimit?: FrontierRateLimit | null;
}

/**
 * The local state an iteration could act on, or `null` for a checkout with
 * nothing in it. Narrowed rather than asserted back: the callers below read
 * its fields, and a `!` there would turn a reordering into a runtime crash.
 */
const strayCheckout = (local: LocalRecovery | null | undefined): LocalRecovery | null =>
  local !== undefined &&
  local !== null &&
  (local.dirty || (local.ahead > 0 && local.finalizedMergedPullRequest !== true))
    ? local
    : null;

/**
 * The same reading, for a role that must leave the checkout clean and detached,
 * means the opposite thing — so it is named rather than acted on.
 *
 * For a coder, uncommitted work or an unpushed commit is the one thing the
 * frontier cannot express and an iteration must see first. For a triager it is
 * a BUG REPORT: its prompt never edits a file, so an iteration woken for one
 * would read the worktree, find nothing it may do, and come back blocked — and
 * a gate that keeps insisting on work the iteration keeps not finding is
 * exactly `BLOCKED_STREAK_LIMIT`, the halt `probeLocalRecovery` describes.
 *
 * The repair is not the gate's either: the gate is read-only, and `ralph.sh`'s
 * `role_invariant` saves the diff and restores the checkout at the end of an
 * iteration — WHENEVER one next runs, which is why the note says that and not
 * "the next iteration". With an empty bucket and a dirty worktree nothing
 * spawns, so the state can persist while the loop idles; what it must not do
 * is vanish, so every verdict below carries this.
 */
function violationNote(local: LocalRecovery | null | undefined, role: Role): string {
  const stray = readOnlyCheckout(role) ? strayCheckout(local) : null;
  if (stray === null) return "";
  const what = stray.dirty
    ? "the worktree dirty"
    : `${stray.ahead} commit(s) on ${stray.branch ?? "detached HEAD"}`;
  return ` (the ${role} left ${what}; its invariant check restores that whenever an iteration next runs)`;
}

/**
 * Turn the probes into one answer. Pure, because this is the whole decision and
 * everything around it is a subprocess.
 *
 * The order mirrors `prompt.md` §1 exactly — shepherd, then frontier, then a
 * closable spec — because the gate's only job is to predict what an iteration
 * would do. Reordering it here would make the gate wait through work, or spawn
 * into none.
 *
 * `null` for a probe means it could not be run or could not be parsed. An
 * undetermined frontier is only reported when nothing definite was found: a
 * readable pull request is enough on its own, and reporting "could not tell"
 * over an answer we already have would be a lie about the state.
 */
export function decide(probes: Probes, loop: LoopName = "ralph", role: Role = DEFAULT_ROLE): Verdict {
  const { pick } = probes;
  // Three states, not two. `prs: null` means "the probe ran and could not be
  // read", which every branch below is written around; for a role that opens
  // no pull request the probe was never ASKED, and the two must not be
  // conflated. Read as unreadable, a triager's every poll would carry a
  // caveat about pull requests that cannot exist and then wait undetermined
  // forever on the branch at the end of this function.
  const asked = shepherds(role);
  const prs = asked ? probes.prs : null;

  if (asked) {
    const shepherd = shepherdVerdict(prs, loop);
    if (shepherd !== null) return shepherd;
  }

  // Priority 1 also covers a resumable claim. prompt.md's handoff rails and
  // README "Stop it" leave a killed iteration's `<loop>-wip` in place so the
  // next iteration resumes it — but the frontier tool excludes every `*-wip`
  // ticket as claimed, that fence being what keeps loops off each other's
  // work. Without this probe, a supervisor whose loop holds a half-finished
  // claim and faces an otherwise held or empty frontier would stop forever
  // beside work its own next iteration would have resumed.
  //
  // The probe filters on THIS loop's label only: the other loop's claim is
  // live work an iteration must not take, and reporting it would spawn an
  // iteration that reads it, leaves it alone, and exits blocked — the exact
  // spin the gate exists to prevent.
  // Computed before the first verdict can form, because EVERY answer has to be
  // able to carry it. Three of the ones below are undetermined waits, which
  // are precisely the verdicts that repeat for hours — losing the violation
  // there would lose it in the only state where it accumulates.
  const violation = violationNote(probes.localRecovery, role);

  const claims = liveClaims(probes.claims, prs, loop) ?? null;
  const claim = claims === null ? null : (claims[0] ?? null);
  if (claim !== null) {
    return {
      work: true,
      why: `issue #${claim.number} carries this loop's unfinished claim — an iteration resumes it under §1 priority 1${violation}`,
    };
  }

  const local = probes.localRecovery;
  const stray = strayCheckout(local);
  if (stray !== null && !readOnlyCheckout(role)) {
    const branch = stray.branch ?? "detached HEAD";
    return {
      work: true,
      why: `local recovery work on ${branch} — inspect it before the frontier`,
    };
  }

  if (local === null) {
    return { work: false, undetermined: true, why: `local recovery state could not be read${violation}` };
  }

  // An unreadable shepherd probe does NOT veto a lower-priority answer, and
  // that is deliberate. This gate is a boolean — "is there anything for an
  // iteration to do" — and it never tells the iteration WHICH work to take:
  // §0 re-lists the pull requests and §1 re-applies its own ordering inside
  // the iteration. So spawning on a known frontier ticket while this probe
  // failed loses nothing; if a stamped pull request does exist, the iteration
  // finds it and shepherds it.
  //
  // Vetoing would cost a great deal. A persistently unreadable `gh pr list` —
  // malformed JSON after a `gh` upgrade, an API hiccup — would block the gate
  // forever while tickets sat ready, turning a cosmetic uncertainty into the
  // exact deadlock this whole file exists to prevent.
  //
  // What the failure must not do is vanish, so it rides along in the report.
  const caveat = asked && prs === null ? " (open PRs unreadable; the iteration re-checks)" : "";
  // Both notes ride on every answer that is not itself about them.
  const notes = caveat + violation;

  if (pick !== null && pick.ticket !== null) {
    // The frontier now hands out a drained closure parent itself (#810); name
    // it the way the census fallback below does, so the report says what the
    // iteration will actually do rather than calling maintenance a ticket.
    if (pick.closure === true) {
      return {
        work: true,
        why: `spec #${pick.ticket} has no open children left — closing it is the task${notes}`,
      };
    }
    const named = `frontier ticket #${pick.ticket} — ${pick.title ?? ""}`.trimEnd();
    return { work: true, why: named + notes };
  }

  // The census fallback: a frontier that predates #810 never offers a closure
  // parent itself, so the gate still asks. Only on a frontier that came back
  // empty WITH NO OBSTRUCTIONS: a held or unreadable frontier is not an empty
  // one, and spawning on maintenance there would take a task §1 would not.
  const closable = probes.closableParent ?? null;
  if (closable !== null && pick !== null && pick.obstructed.length === 0) {
    return {
      work: true,
      why: `spec #${closable} has no open children left — closing it is the task${notes}`,
    };
  }

  // Throttling is named, not folded into "could not be read": it clears on
  // its own, and the supervisor waits it out with backoff and jitter so loops
  // sharing one account do not come back in lockstep. Still undetermined: it
  // says nothing about the backlog, so it must never read as "no work".
  const throttled = probes.frontierRateLimit ?? null;
  if (pick === null && throttled !== null) {
    // Named `requested` rather than `asked`: that word is already this
    // function's boolean for whether the shepherd probe ran.
    const requested = throttled.retryAfterSeconds === null ? "" : ` (GitHub asked for ${throttled.retryAfterSeconds}s)`;
    return {
      work: false,
      undetermined: true,
      rateLimited: true,
      retryAfterSeconds: throttled.retryAfterSeconds,
      why: `GitHub rate-limited the frontier read${requested}${violation}`,
    };
  }
  if (asked && prs === null && pick === null) {
    return { work: false, undetermined: true, why: `neither probe could be read${violation}` };
  }
  if (pick === null) {
    return { work: false, undetermined: true, why: `the frontier could not be read${violation}` };
  }

  // Reached only when nothing definite was found. Here the unread half IS the
  // decision — a shepherdable pull request would have been reason enough to
  // spawn — so this waits rather than reporting an empty backlog.
  if (asked && prs === null) return { work: false, undetermined: true, why: `open PRs could not be read${violation}` };

  // The two verdicts below are terminal for an ungated supervisor, so they
  // require the recovery probe to have actually answered. A claim list that
  // could not be read might be hiding exactly the stranded work the probe
  // exists to surface; undetermined waits rather than stops.
  if (probes.claims === null) {
    return { work: false, undetermined: true, why: `this loop's claim list could not be read${violation}` };
  }

  // Candidates existed but every one was held or raced. That is not an empty
  // frontier, and saying "nothing is ready" would misreport a busy backlog as
  // a drained one — but it is still nothing for THIS supervisor to take.
  if (pick.obstructed.length > 0) {
    const held = pick.obstructed.map((o) => `#${o.number}`).join(" ");
    return { work: false, why: `every frontier candidate is held (${held})${violation}` };
  }

  return { work: false, why: `the frontier is empty${waitingOnOperatorNote(pick.waitingOnOperator)}${violation}` };
}

/**
 * The line printed on every poll that finds nothing. It carries a wall-clock
 * time and how long the wait has run, because the one thing this output has to
 * prove is that the supervisor is idle rather than dead — and a line with no
 * clock in it proves nothing once it has scrolled past.
 */
export function waitingLine(
  verdict: Verdict,
  state: { poll: number; waitingSince: Date; now: Date; intervalSeconds: number },
): string {
  const idleSeconds = Math.max(0, Math.round((state.now.getTime() - state.waitingSince.getTime()) / 1000));
  const at = state.now.toISOString().replace(/\.\d+Z$/, "Z");
  return (
    `frontier-gate: ${verdict.why} at ${at} — ` +
    `waiting ${state.intervalSeconds}s (poll ${state.poll}, idle ${formatDuration(idleSeconds)})`
  );
}

/**
 * What a blocking poll does with its verdict, given the held-verdict record
 * (#771). Pure, so the sequences are pinned without a process:
 *
 *   report   — work the record does not hold (or no record): spawn, as before
 *   wait     — no work, or an undetermined verdict: today's wait, unchanged
 *   hold     — the held subject again: wait instead of re-spawning on it
 *   budget   — the held subject again, budget spent and not yet notified: hand back once
 *   release  — a definite "no work" while holding: hand back so the supervisor marks it released
 *
 * An undetermined verdict (throttled included) says nothing about the held
 * subject, so it never releases one. A RELEASED record holds nothing: work on
 * any subject is reported (the supervisor's write re-holds a subject that came
 * back, on its original clock), and no work is a plain wait, never a second
 * release.
 */
export type HoldDecision = "report" | "wait" | "hold" | "budget" | "release";

export function holdDecision(
  verdict: Verdict,
  held: HeldVerdict | null,
  now: Date,
  budgetHours: number,
): HoldDecision {
  if (held !== null && held.released) return verdict.work ? "report" : "wait";
  if (verdict.work) {
    if (held === null || !sameSubject(verdictSubject(verdict.why), held)) return "report";
    // Notified once already: keep holding silently rather than handing back a second time.
    return !held.notified && budgetSpent(held, now, budgetHours) ? "budget" : "hold";
  }
  if ("undetermined" in verdict && verdict.undetermined) return "wait";
  return held === null ? "wait" : "release";
}

/** The hand-back once a hold's budget is spent; `ralph.sh` reads `after poll N` from it. */
export function holdBudgetLine(held: HeldVerdict, now: Date, poll: number): string {
  return (
    `frontier-gate: hold budget spent — ${describeSubject(held)} held since ${held.first} ` +
    `(${compactDuration(holdAge(held, now))}) — after poll ${poll}`
  );
}

/** The hand-back when a held verdict turned into a definite "no work". */
export function holdReleasedLine(verdict: Verdict): string {
  return `frontier-gate: hold released — ${verdict.why}`;
}

/** The verdict a holding poll reports in its waiting line, so the log says why work is not taken. */
export function holdingVerdict(verdict: Verdict, held: HeldVerdict): Verdict {
  return {
    work: false,
    why: `holding on an unchanged verdict (${describeSubject(held)}, held since ${held.first}): ${verdict.why}`,
  };
}

/** `4500` → `1h15m`. Short enough to sit at the end of a status line. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The poll interval, or an error naming what was wrong with it. Rejecting a
 * bad value matters more here than it looks: `sleep` on a non-number fails
 * every cycle, and a gate that failed every cycle would poll the GitHub API in
 * a tight loop for as long as the supervisor lived.
 */
export function parseInterval(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `frontier-gate: poll interval must be a whole number of seconds; received ${raw ?? "nothing"}`,
    );
  }
  return Number(raw);
}

interface Ran {
  ok: boolean;
  stdout: string;
}

/**
 * Run a command and hand back its output, never throwing. Every call site here
 * treats failure as "could not tell", so an exception would only be caught and
 * converted back into this.
 */
function run(command: string, args: string[]): Promise<Ran> {
  return new Promise<Ran>((resolve) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: error === null, stdout });
    });
  });
}

/**
 * The frontier's own answer, as JSON. The launcher (`frontier/next.ts`) writes
 * an explanatory note to stderr and `bun run` may prefix the invocation, so
 * the JSON is taken from the last non-empty line of stdout rather than from
 * the whole stream.
 */
export function parsePick(stdout: string): TakeOnePick | null {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);
  if (line === undefined) return null;
  try {
    const parsed = JSON.parse(line) as TakeOnePick;
    if (typeof parsed !== "object" || parsed === null || !("ticket" in parsed)) return null;
    return { ...parsed, obstructed: parsed.obstructed ?? [] };
  } catch {
    return null;
  }
}

/**
 * What one `--take-one --dry-run` run said. A failed run is unreadable — its
 * JSON carries `error` and would otherwise look like an empty frontier —
 * unless that JSON says GitHub throttled it, which is an answer of its own.
 */
export function frontierOutcome(
  ok: boolean,
  stdout: string,
): { pick: TakeOnePick | null; rateLimit: FrontierRateLimit | null } {
  const parsed = parsePick(stdout);
  if (ok) return { pick: parsed, rateLimit: null };
  if (parsed?.rateLimited === true) {
    return { pick: null, rateLimit: { retryAfterSeconds: parsed.retryAfterSeconds ?? null } };
  }
  return { pick: null, rateLimit: null };
}

async function probeFrontier(
  fences: PlanFences,
  role: Role = DEFAULT_ROLE,
): Promise<{ pick: TakeOnePick | null; rateLimit: FrontierRateLimit | null }> {
  // `--dry-run` is what makes this read-only, and it is not an optimisation:
  // without it the gate would claim the ticket for a process that does not
  // exist yet. Never remove it from this call site.
  const args = [join(RALPH_HOME, "frontier", "next.ts"), "--take-one", "--dry-run"];
  // The one fence §1 passes by hand — a durable local list. The rescue limit
  // used to be a second one, counted from the journal, and the gate could not
  // see it: on 2026-09-22 the iterations kept excluding #1099 over rescues the
  // operator had already cleared, the gate kept naming it, and ralph halted on
  // the disagreement. It is now the `<loop>-blocked` label only, which the
  // frontier reads for both of us; open-PR references are the frontier's own
  // fence too. Without this list the gate reports work for a ticket the
  // iteration refuses, spending an Opus turn per cycle learning that — the
  // exact waste it exists to prevent.
  for (const number of fences.outOfScope) args.push("--exclude", String(number));
  // The closure list is a fence for a TRIAGER and a task for a coder, so it is
  // passed for one and not the other. Closing a drained spec is `prompt.md`
  // §1's maintenance job, reached only when the coder's frontier is empty;
  // triaging that same spec — staffing its tree, or taking it into intake for
  // want of a state label — would put `<loop>-wip` on the issue the plan says
  // is somebody else's closure task, and hide it from the coder that would
  // have closed it.
  if (role !== DEFAULT_ROLE) {
    for (const number of fences.closureParents) args.push("--exclude", String(number));
  }
  // Only a non-coder role asks for one, so a coder's argv is byte-identical to
  // what it always was. That is not just tidiness: `frontier/next.ts`
  // materialises its payload from the harness's `origin/main`, so a flag this
  // gate sends before that payload knows it would fail every coder's probe. A
  // role that could send it cannot exist until the roster names one.
  if (role !== DEFAULT_ROLE) args.push("--role", role);
  const { ok, stdout } = await run("bun", args);
  return frontierOutcome(ok, stdout);
}

/**
 * Where the plan lives: the project's `.ralph/config.json` (`baseBranch`,
 * `plan`), or the supervisor's exports of the same. A project with no readable
 * config degrades to `main` and `.ralph/plan.md` — the gate's contract is that
 * an unreadable plan fences nothing rather than stalling; the preflight is what
 * refuses an invalid config.
 */
export function planLocation(
  env: Record<string, string | undefined> = process.env,
  root: string = process.cwd(),
): { baseBranch: string; plan: string } {
  const fromEnv = { baseBranch: env.RALPH_BASE_BRANCH?.trim(), plan: env.RALPH_PLAN?.trim() };
  if (fromEnv.baseBranch && fromEnv.plan) return { baseBranch: fromEnv.baseBranch, plan: fromEnv.plan };
  try {
    const config = loadProjectConfig(root);
    return { baseBranch: fromEnv.baseBranch || config.baseBranch, plan: fromEnv.plan || config.plan };
  } catch {
    return { baseBranch: fromEnv.baseBranch || "main", plan: fromEnv.plan || ".ralph/plan.md" };
  }
}

/** `plan.md`'s fences; an unreadable plan fences nothing rather than stalling. */
async function readPlanFences(): Promise<PlanFences> {
  // A Linear or Jira plan names its tickets `<KEY>-n`; building the tracker
  // sets the key the parser reads before the plan is parsed.
  probeTracker();
  // Read out of origin/main, matching prompt.md §0's journal rule: a checkout
  // is one loop's view and may lag main mid-ticket — the freshness guard lets
  // exactly that run — while origin/main is every loop's view. The iteration
  // reads main, and a gate that fenced from a stale plan would predict an
  // iteration that no longer exists. Falls back to the working tree when
  // origin/main cannot answer (no repo, no ref), then to fencing nothing.
  const { baseBranch, plan } = planLocation();
  const shown = await run("git", ["show", `origin/${baseBranch}:${plan}`]);
  if (shown.ok && shown.stdout.trim() !== "") return parsePlanFences(shown.stdout);
  try {
    return parsePlanFences(await readFile(plan, "utf8"));
  } catch {
    return { outOfScope: [], closureParents: [] };
  }
}

/**
 * The loop this gate answers for. The supervisor exports its name before the
 * first ask, so the recovery probe filters on THAT loop's `-wip` label;
 * defaulting matches `ralph.sh`'s own default, so a hand-run `--once` from a
 * shell without the export still asks a well-defined question.
 */
function currentLoopName(): LoopName {
  const roster = loopRoster();
  const raw = process.env.RALPH_LOOP_NAME ?? roster[0]!;
  if (!roster.includes(raw)) {
    throw new Error(`frontier-gate: RALPH_LOOP_NAME must be one of ${roster.join(", ")}; got '${raw}'`);
  }
  return raw;
}

/**
 * Which tracker the issue probes ask (felipearos/ralph#333): `"github"` for
 * the `gh` calls below, exactly as before; a Linear or Jira tracker; or null
 * when the project's tracker cannot be reached (no credential yet), which a
 * probe reports as a failure so the gate degrades instead of reading GitHub
 * issues the project does not use. A checkout without a readable config keeps
 * the GitHub probes it always ran.
 */
function probeTracker(): Tracker | "github" | null {
  try {
    const tracker = frontierTracker();
    return tracker.kind === "github" ? "github" : tracker;
  } catch (error) {
    return error instanceof TrackerUnavailableError ? null : "github";
  }
}

/** Why the project's tracker cannot be reached, or null when it can (or is GitHub's). */
function trackerUnavailableReason(): string | null {
  try {
    frontierTracker();
    return null;
  } catch (error) {
    return error instanceof TrackerUnavailableError ? `the project's tracker is not connected: ${error.message}` : null;
  }
}

/** `null` on failure, like every other probe here — see `Probes`. */
async function probeOpenClaims(loop: LoopName): Promise<ClaimedIssue[] | null> {
  const tracker = probeTracker();
  if (tracker !== "github") {
    if (tracker === null) return null;
    try {
      return (await tracker.withLabel(`${loop}-wip`, { state: "open", limit: ISSUE_LIMIT })).map(({ number }) => ({ number }));
    } catch {
      return null;
    }
  }
  const { ok, stdout } = await run("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIMIT),
    "--label",
    `${loop}-wip`,
    "--json",
    "number",
  ]);
  if (!ok) return null;
  try {
    return JSON.parse(stdout) as ClaimedIssue[];
  } catch {
    return null;
  }
}

/**
 * The base branch as a remote ref.
 *
 * Resolved rather than hardcoded because `role_invariant` measures "detached at
 * the base" against the project's own base branch, and a gate that measured it
 * against `origin/main` on a project whose base is something else would call
 * the same checkout stray while the invariant called it clean — the two
 * disagreeing forever, which is a `BLOCKED_STREAK_LIMIT` halt.
 *
 * Through `planLocation`, which is this file's resolver already: the
 * supervisor's exports, then the project's committed config, then `main`. The
 * config step is what the env alone cannot cover, and this gate is documented
 * as a hand-run (`README.md`, `adding-an-agent.md`) with no supervisor exports
 * in sight — where reading the environment only would fail every `rev-list` on
 * a project whose base is not `main` and report the checkout unreadable.
 */
const baseRef = (): string => `origin/${planLocation().baseBranch}`;

/**
 * `null` on failure. An unreadable worktree must never lead to a new claim.
 *
 * `--untracked-files=no`, because "recovery work" means work an iteration can
 * actually finish: uncommitted changes to TRACKED files, or commits that have
 * not reached a pull request. An untracked path is neither. Nothing an
 * iteration does resolves it — it will not commit a stray file it did not
 * write — so counting it as work makes this probe return `dirty` forever while
 * every iteration correctly reports nothing to recover. A gated supervisor
 * then stops on `BLOCKED_STREAK_LIMIT` ("the gate and the iteration disagree
 * persistently") instead of waiting out its poll interval, which is how rafa
 * died beside a ready frontier on 2026-09-15: one stale `ralph/` log directory
 * left in the worktree by a superseded harness layout.
 */
async function probeLocalRecovery(loop: LoopName): Promise<LocalRecovery | null> {
  const [status, branch, ahead] = await Promise.all([
    run("git", ["status", "--porcelain", "--untracked-files=no"]),
    run("git", ["branch", "--show-current"]),
    run("git", ["rev-list", "--count", `${baseRef()}..HEAD`]),
  ]);
  if (!status.ok || !branch.ok || !ahead.ok) return null;
  const aheadCount = Number.parseInt(ahead.stdout.trim(), 10);
  if (!Number.isFinite(aheadCount) || aheadCount < 0) return null;
  const branchName = branch.stdout.trim() || null;
  let finalizedMergedPullRequest = false;
  if (
    status.stdout.trim() === "" &&
    aheadCount > 0 &&
    branchName?.startsWith(`${loop}/`) === true
  ) {
    const merged = await run("gh", [
      "pr",
      "list",
      "--state",
      "merged",
      "--head",
      branchName,
      "--limit",
      "1",
      "--json",
      "number,labels",
    ]);
    if (merged.ok) {
      try {
        const mergedPullRequests = JSON.parse(merged.stdout) as {
          labels?: { name: string }[];
        }[];
        finalizedMergedPullRequest = mergedPullRequests.some((pullRequest) =>
          pullRequest.labels?.some((label) => label.name === `${loop}-done`),
        );
      } catch {
        // An unreadable answer is not evidence that local commits are safe.
      }
    }
  }
  return {
    branch: branchName,
    ahead: aheadCount,
    dirty: status.stdout.trim() !== "",
    finalizedMergedPullRequest,
  };
}

/** `null` on failure, like every other probe here — see `Probes`. */
async function probeOpenIssues(): Promise<OpenIssue[] | null> {
  const tracker = probeTracker();
  if (tracker !== "github") {
    if (tracker === null) return null;
    try {
      // Labels and assignees too (#810): `closableParent` skips a parent some
      // loop holds, so the gate never reports closure work the frontier refuses.
      return (await tracker.openIssues()).map(({ number, body, parent, labels, assignees }) => ({
        number,
        body,
        parent,
        labels: Array.isArray(labels) ? labels : [],
        assignees: Array.isArray(assignees) ? assignees : [],
      }));
    } catch {
      return null;
    }
  }
  const { ok, stdout } = await run("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIMIT),
    "--json",
    "number,body,labels,assignees",
  ]);
  if (!ok) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return (parsed as GhOpenIssue[]).map((issue) => ({
      number: issue.number,
      body: issue.body,
      labels: namesOf(issue.labels, "name"),
      assignees: namesOf(issue.assignees, "login"),
    }));
  } catch {
    return null;
  }
}

/** What the census's `gh issue list` returns; label and assignee shapes are not trusted. */
interface GhOpenIssue {
  number: number;
  body: string | null;
  labels?: unknown;
  assignees?: unknown;
}

/**
 * `[{ name }]` / `[{ login }]` from gh, flattened to strings. An odd shape — a
 * `gh` upgrade, a partial answer — reads as "none", which is the census's
 * answer from before it read them; it must never throw on the supervisor's path.
 */
function namesOf(value: unknown, key: "name" | "login"): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>)[key];
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
}

async function probePullRequests(): Promise<PullRequest[] | null> {
  const { ok, stdout } = await run("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(PR_LIMIT),
    "--json",
    "number,isDraft,body,labels,headRefName",
  ]);
  if (!ok) return null;
  try {
    return JSON.parse(stdout) as PullRequest[];
  } catch {
    return null;
  }
}

/**
 * All probes, cheapest first, each skipped once an earlier one has
 * settled the answer. An idle loop asks this on every poll, so the shepherd
 * list (one API call) runs before the frontier (a dozen or so), and the maintenance
 * census (one more) runs only when the frontier came back empty.
 */
/**
 * Which bucket this loop's intake reads, from the ROSTER rather than from
 * `RALPH_LOOP_ROLE`: the gate is also run by hand (`--once`, step 11 of adding
 * an agent), and a role read from an environment the operator did not set would
 * silently probe the coder's bucket.
 *
 * Resolved ONCE per process, and never inside the poll loop. `roleOf`'s default
 * roster is `projectRosterEntries()`, which re-reads and re-validates the
 * project's `config.json` and THROWS on a bad one — and a throw out of the poll
 * loop leaves the supervisor printing "the intake gate failed to start" and
 * stopping. A gate that has already been waiting for hours must not die because
 * the operator was mid-save on a file it only needs the answer to once.
 *
 * A name the roster does not carry cannot reach here: `currentLoopName` refuses
 * it first. So the fallbacks cover an unreadable roster, where the coder's
 * bucket is the answer that changes nothing — the gate stays read-only either
 * way, and `probeFrontier` sends no `--role` for it.
 */
export function intakeRole(loop: LoopName): Role {
  try {
    return roleOf(loop) ?? DEFAULT_ROLE;
  } catch {
    return DEFAULT_ROLE;
  }
}

export async function probe(role: Role = intakeRole(currentLoopName())): Promise<Verdict> {
  const loop = currentLoopName();
  // Not asked at all for a role that opens no pull request: the API call would
  // be spent, every poll, to learn that a thing which cannot exist does not.
  // `decide` is told the role for the same reason — see `asked` there.
  const asks = shepherds(role);
  const prs = asks ? await probePullRequests() : null;
  if (asks) {
    const shepherd = shepherdVerdict(prs, loop);
    if (shepherd !== null) return shepherd;
  }

  // A Linear or Jira project whose tracker this host cannot reach (no
  // credential yet, or a refused one) has no claims or frontier to read. Say
  // why and wait: the operator reconnects it from the dashboard, and a halt
  // here would stop the loop overnight over a fix nothing in it can make.
  const unavailable = trackerUnavailableReason();
  if (unavailable !== null) return { work: false, undetermined: true, why: unavailable };

  // Recovery second, also one API call: when it answers, the frontier cannot
  // express that work (it excludes claimed tickets by design), so the
  // expensive probes are skipped entirely. `null` claims fall through — the
  // unreadable case only matters when a stop verdict is about to form, and
  // `decide` handles it there.
  // Claims whose pull request another loop adopted (#424) are not this loop's
  // work: only live ones short-circuit, the rest fall through to the frontier.
  const claims = liveClaims(await probeOpenClaims(loop), prs, loop) ?? null;
  if (claims !== null && claims.length > 0) return decide({ prs, pick: null, claims }, loop, role);

  // A power cut can leave the only copy of work in this checkout, before a
  // claim or branch was pushed. Wake an iteration for it before asking the
  // frontier for anything new. If Git cannot describe the checkout, wait: a
  // new claim is the unsafe answer to an unreadable recovery state.
  const localRecovery = await probeLocalRecovery(loop);
  if (localRecovery === null) return decide({ prs, pick: null, claims, localRecovery }, loop, role);
  const localVerdict = decide({ prs, pick: null, claims, localRecovery }, loop, role);
  if (localVerdict.work) return localVerdict;

  const fences = await readPlanFences();
  const { pick, rateLimit: frontierRateLimit } = await probeFrontier(fences, role);
  if (frontierRateLimit !== null) {
    return decide({ prs, pick, claims, localRecovery, frontierRateLimit }, loop, role);
  }
  if (pick !== null && pick.ticket !== null) {
    return decide({ prs, pick, claims, localRecovery }, loop, role);
  }

  // Only a frontier that came back definitively empty makes §1's maintenance
  // question live, and only then is the census worth its API call.
  const frontierIsEmpty = pick !== null && pick.obstructed.length === 0;
  if (!frontierIsEmpty || fences.closureParents.length === 0) {
    return decide({ prs, pick, claims, localRecovery }, loop, role);
  }

  const open = await probeOpenIssues();
  if (open === null) {
    return { work: false, undetermined: true, why: "the open-issue census could not be read" };
  }
  return decide(
    {
      prs,
      pick,
      claims,
      localRecovery,
      // Out-of-scope parents excluded, as the frontier's own closure pick
      // excludes them (#810): a verdict the iteration's `--exclude` refuses
      // would hold the gate on work no iteration can take.
      closableParent: closableParent(
        fences.closureParents.filter((n) => !fences.outOfScope.includes(n)),
        open,
      ),
    },
    loop,
    role,
  );
}

/**
 * The supervisor this gate serves. `ralph.sh` exports its own pid as
 * `RALPH_SUPERVISOR_PID` before it starts a gate; a gate run by hand has no
 * such variable and serves the shell that started it.
 */
export function supervisorPidFrom(env: Record<string, string | undefined>, ppid: number): number {
  // Trimmed because `ci-doctor/case-lease.ts`'s `supervisorPid` delegates here
  // and has always tolerated a padded value; the two must not disagree about
  // which pid a doctor leases a case to and which one its gate watches.
  const raw = env.RALPH_SUPERVISOR_PID?.trim();
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : ppid;
}

/**
 * The supervisor is gone. The gate blocks for hours by design, so a `kill` of
 * a backgrounded `ralph.sh` would otherwise leave it polling the GitHub API
 * forever with nobody to serve. Checked rather than trapped because no trap
 * survives `kill -9` of the parent.
 *
 * Asked of the pid, not of the gate's parent: `ralph.sh` runs the gate as a
 * function inside a pipeline whose body is a `( … exec bun … )` subshell, so
 * the gate's parent is an intermediate bash that outlives the supervisor and
 * `process.ppid` never changes. Signal 0 delivers nothing and answers whether
 * the pid exists; `EPERM` is alive under another user, which is still alive.
 */
export function supervisorGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The line the gate ends on when an operator command is waiting. `ralph.sh`
 * matches it and goes back to its control checkpoint instead of starting an
 * iteration — the checkpoint is the only place a command is applied.
 */
export const CONTROL_PENDING_LINE = "frontier-gate: control command waiting — handing back to the supervisor";

/**
 * What a gate prints when it hands back so the supervisor can re-read the
 * secrets it could not read at startup (#759). `ralph.sh` matches the line
 * anchored as `^[A-Za-z0-9_.-]+: secret re-read due`.
 */
export const SECRET_REREAD_PHRASE = "secret re-read due — handing back to the supervisor";

/**
 * The hand-back line. It carries the wait this poll chose (a jittered interval,
 * or a longer one when GitHub throttled the read) as `poll again in <n>s`, so
 * the supervisor sleeps what is left of THAT wait rather than its own default
 * interval, and a throttled gate is not asked again early.
 */
export const secretRereadLine = (prefix: string, waitSeconds?: number, poll?: number): string =>
  `${prefix}: ${SECRET_REREAD_PHRASE}`
  + (waitSeconds === undefined ? "" : ` — poll again in ${Math.max(0, Math.round(waitSeconds))}s`)
  // The poll it handed back after: one gate run can make several polls
  // between hand-backs (see `secretRereadPoll`), so the supervisor resumes the
  // count from this rather than counting hand-backs.
  + (poll === undefined ? "" : ` — after poll ${poll}`);

/**
 * Whether a no-work poll should hand back for a secret re-read (#759). A gate
 * blocks for hours, and the supervisor reads secrets only between gate runs:
 * boots where the keyring was still locked left loops polling all night
 * without a token. `RALPH_SECRET_REREAD=1` is required as well as an unread
 * secret because a gate runs fresh from `$RALPH_HOME` on every ask while
 * `ralph.sh` is parsed once: after a deploy without a restart, an old
 * supervisor already exports the unread names but would read this
 * hand-back's exit 0 as work and spawn an empty iteration.
 *
 * Only a secret the GATE uses counts (`RALPH_ROLE_SECRETS_GATE`, exported by
 * role-behaviour.ts): an iteration-only one, like the coder's Buildkite read
 * token, is re-read by the supervisor before each iteration, so its gate need
 * not restart for it.
 *
 * And not every poll: each hand-back restarts the gate and drops what it
 * caches in process — ci-doctor's three GitHub reads go cold against a
 * 12/hour budget, pr-medic re-lists its PRs, the clerk forgets its transient
 * backoff — so a long outage must not cost that on every poll; the spec asks
 * the re-read to back off. `poll` is the resumed count (`gateResume`), so the
 * schedule runs across hand-backs: polls 1, 2, 4, 8, then every 12th.
 */
export function secretRereadDue(env: NodeJS.ProcessEnv, poll: number): boolean {
  if (env.RALPH_SECRET_REREAD !== "1") return false;
  const gate = new Set((env.RALPH_ROLE_SECRETS_GATE ?? "").split(/\s+/).filter((name) => name !== ""));
  const unread = (env.RALPH_ROLE_SECRETS_UNREAD ?? "").split(/\s+/).filter((name) => name !== "");
  if (!unread.some((name) => gate.has(name))) return false;
  return secretRereadPoll(poll);
}

/**
 * The back-off schedule of `secretRereadDue`: polls 1, 2, 4, 8, then every
 * 12th from 24 (24, 36, …) — the doubling's next step, held at a fixed gap
 * so an outage that ends at 3am is still seen within twelve polls.
 */
export function secretRereadPoll(poll: number): boolean {
  if (!Number.isInteger(poll) || poll < 1) return false;
  if (poll <= 8) return (poll & (poll - 1)) === 0;
  return poll >= 24 && poll % 12 === 0;
}

/**
 * Where a gate's wait resumes: each secret re-read hand-back restarts the
 * gate, so without this every waiting line would read `poll 1, idle 0s` all
 * night and the operator would lose the "tokenless for hours" signal. The
 * supervisor passes `RALPH_GATE_WAITING_SINCE` (epoch seconds) and
 * `RALPH_GATE_POLLS` (polls already made); missing or malformed is a fresh wait.
 */
export function gateResume(env: NodeJS.ProcessEnv, now: Date): { waitingSince: Date; firstPoll: number } {
  const since = env.RALPH_GATE_WAITING_SINCE;
  const polls = env.RALPH_GATE_POLLS;
  if (since === undefined || polls === undefined || !/^\d+$/.test(since) || !/^\d+$/.test(polls)) {
    return { waitingSince: now, firstPoll: 1 };
  }
  const sinceMs = Number(since) * 1000;
  // A clock that stepped back must not show a negative idle.
  const waitingSince = sinceMs > now.getTime() ? now : new Date(sinceMs);
  return { waitingSince, firstPoll: Number(polls) + 1 };
}

/**
 * Sleep out one poll interval in slices, stopping early when `interrupt` says
 * so. The gate blocks for as long as the frontier stays empty, and it used to
 * sleep through whole intervals without looking at the control inbox: a stop
 * sent to an idle loop waited for work that never came. Returns why it woke
 * early, or null once the interval has elapsed.
 */
export async function sleepInSlices<T>(
  seconds: number,
  sliceSeconds: number,
  interrupt: () => T | null,
  nap: (seconds: number) => Promise<void> = sleep,
): Promise<T | null> {
  let slept = 0;
  while (slept < seconds) {
    const step = Math.min(sliceSeconds, seconds - slept);
    await nap(step);
    slept += step;
    const why = interrupt();
    if (why !== null) return why;
  }
  return null;
}

/**
 * The wait after a poll GitHub throttled. Four loops on one account were
 * throttled together on 2026-09-28 and came back together on the same 300s
 * beat. So the wait grows with consecutive throttled polls (the poll
 * interval, doubling, capped at `maxSeconds`), is never shorter than what
 * GitHub asked for, and carries ±25% jitter so the loops drift apart.
 */
export function rateLimitWaitSeconds(
  state: { streak: number; intervalSeconds: number; retryAfterSeconds: number | null; maxSeconds: number },
  random: () => number = Math.random,
): number {
  const asked = state.retryAfterSeconds ?? 0;
  const floor = Math.max(state.intervalSeconds, asked);
  const grown = Math.min(Math.max(state.maxSeconds, asked), floor * 2 ** Math.max(0, state.streak - 1));
  return Math.max(asked, 1, Math.round(grown * (0.75 + random() * 0.5)));
}

/** `RALPH_GATE_RATE_LIMIT_MAX_SECONDS` (1800): the longest throttled-poll wait. */
export function rateLimitMaxSeconds(raw: string | undefined): number {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : 1800;
}

/** The supervisor's control poll interval, which is how often a wait looks at the inbox. */
export function controlSliceSeconds(raw: string | undefined): number {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : 15;
}

/** What a role's own gate runs around the frontier gate's polls (`triage/gate.ts`). */
export interface FrontierGateHooks {
  /** Runs before every probe, `--once` included. A throw is logged, never the end of the gate. */
  beforePoll?: () => Promise<void>;
}

/**
 * One step a role's gate adds before a probe. Best-effort by contract: the
 * gate is the only thing keeping an idle loop alive, so a step that throws is
 * one log line and the probe runs as usual.
 */
async function beforePoll(hooks: FrontierGateHooks): Promise<void> {
  try {
    await hooks.beforePoll?.();
  } catch (error) {
    console.log(`frontier-gate: before-poll step failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** How long one park sweep may run before the gate gives up on it and polls. */
const PARK_SWEEP_TIMEOUT_MS = 120_000;

/**
 * The park sweep (#775), run before each poll of a BLOCKING gate when the
 * supervisor asks for it (`RALPH_PARK_SWEEP_IN_GATE=1`): a ticket whose park
 * wakes during a long wait must reach the probe that follows, not the next
 * iteration's. Spawned rather than imported, so a sweep that crashes or hangs
 * stays out of the gate process; and best-effort like `beforePoll` — a spawn
 * error, a timeout or a non-zero exit is one log line, never the end of the
 * gate. Here rather than in a role's hooks, so every role's gate runs it.
 */
export function parkSweep(
  env: NodeJS.ProcessEnv,
  root: string,
  spawn: typeof spawnSync = spawnSync,
): void {
  if (env.RALPH_PARK_SWEEP_IN_GATE !== "1") return;
  try {
    const result = spawn("bun", [join(RALPH_HOME, "park-probe.ts"), "sweep"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: PARK_SWEEP_TIMEOUT_MS,
      // Its stderr goes where the gate's does: into the supervisor log.
      stdio: ["ignore", "pipe", "inherit"],
    });
    for (const line of String(result.stdout ?? "").split("\n")) {
      if (line.trim() !== "") console.log(line);
    }
    if (result.error) {
      console.log(`frontier-gate: park sweep failed: ${result.error.message}`);
    } else if (result.status !== 0) {
      const how = result.status === null ? `signal ${result.signal ?? "unknown"}` : `status ${result.status}`;
      console.log(`frontier-gate: park sweep exited with ${how}; polling anyway.`);
    }
  } catch (error) {
    console.log(`frontier-gate: park sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The gate itself, for `main` and for a role's gate that wraps it. With no
 * hooks it is exactly the coder's gate.
 */
export async function runFrontierGate(argv: string[], hooks: FrontierGateHooks = {}): Promise<void> {
  // Anchored like `ralph.sh` and `status.sh` (both `cd` to the project root), so
  // the plan and every `gh`/`git` probe resolve wherever this is invoked from.
  // Unanchored, a run from another directory reports "nothing to do" — the
  // same words an empty frontier gets — for what is really a broken probe.
  process.chdir(projectRoot());

  if (argv.includes("--once")) {
    await beforePoll(hooks);
    const verdict = await probe();
    console.log(`frontier-gate: ${verdict.work ? "work available" : "nothing to do"} — ${verdict.why}`);
    process.exitCode = verdict.work ? 0 : 1;
    return;
  }

  const intervalSeconds = parseInterval(argv[0]);
  const { waitingSince, firstPoll } = gateResume(process.env, new Date());
  const supervisorPid = supervisorPidFrom(process.env, process.ppid);
  const slice = controlSliceSeconds(process.env.RALPH_CONTROL_POLL_SECONDS);
  const root = process.cwd();
  const throttleCap = rateLimitMaxSeconds(process.env.RALPH_GATE_RATE_LIMIT_MAX_SECONDS);
  let throttledStreak = 0;
  // A malformed budget falls back to the default rather than stopping the gate.
  const holdBudget = holdBudgetHours(process.env.RALPH_GATE_HOLD_BUDGET_HOURS) ?? DEFAULT_HOLD_BUDGET_HOURS;
  // Once, outside the loop: see `intakeRole`.
  const role = intakeRole(currentLoopName());

  for (let poll = firstPoll; ; poll++) {
    parkSweep(process.env, root);
    await beforePoll(hooks);
    const probed = await probe(role);
    // Re-read every poll: the supervisor releases, clears or replaces the record between gates.
    const held = readHeld(gateVerdictPath(process.env, root));
    const now = new Date();
    const decision = holdDecision(probed, held, now, holdBudget);
    if (decision === "report") {
      console.log(`frontier-gate: work available — ${probed.why}`);
      return;
    }
    if (decision === "budget" && held !== null) {
      console.log(holdBudgetLine(held, now, poll));
      return;
    }
    if (decision === "release") {
      console.log(holdReleasedLine(probed));
      return;
    }
    // A hold is a no-work poll in every other respect: same wait, same wakes.
    const verdict = decision === "hold" && held !== null ? holdingVerdict(probed, held) : probed;
    const throttled = "rateLimited" in verdict && verdict.rateLimited === true;
    throttledStreak = throttled ? throttledStreak + 1 : 0;
    const wait = throttled
      ? rateLimitWaitSeconds({
          streak: throttledStreak,
          intervalSeconds,
          retryAfterSeconds: verdict.retryAfterSeconds ?? null,
          maxSeconds: throttleCap,
        })
      : intervalSeconds;
    // Unbuffered and immediate: this line is the only evidence that an idle
    // supervisor is alive, so it must not sit in a pipe waiting for the next.
    console.log(waitingLine(verdict, { poll, waitingSince, now: new Date(), intervalSeconds: wait }));
    // No sleep here: the supervisor re-reads its unread secrets, then runs the gate again.
    if (secretRereadDue(process.env, poll)) {
      console.log(secretRereadLine("frontier-gate", wait, poll));
      return;
    }
    const woke = await sleepInSlices(wait, slice, () => {
      if (supervisorGone(supervisorPid)) return "orphaned" as const;
      return hasPendingControl(root) ? ("control" as const) : null;
    });
    if (woke === "orphaned") {
      console.log(`frontier-gate: supervisor ${supervisorPid} is gone — stopping.`);
      return;
    }
    if (woke === "control") {
      console.log(CONTROL_PENDING_LINE);
      return;
    }
  }
}

async function main(): Promise<void> {
  await runFrontierGate(process.argv.slice(2));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(dim(error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
