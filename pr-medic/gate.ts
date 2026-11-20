#!/usr/bin/env bun
/**
 * The pr-medic's intake gate — block until one of the operator's pull requests
 * is red, ready and the medic's to take, then claim it and hand it over.
 *
 * Same contract as `frontier-gate.ts` and `ci-doctor/gate.ts`, and for their
 * reason: a supervisor that spawns an iteration to be told every operator PR is
 * green, a draft or somebody else's burns a whole fresh-context turn. So this
 * file answers the question without a model, and hands over at most one PR.
 *
 * **A PR is a case** (felipearos/ralph#246) when all of these hold:
 *
 * - it is open, not a draft, and its head branch matches `prMedic.branches`;
 * - its head branch is under no roster loop's `<loop>/` prefix — an agent's
 *   pull request is that loop's to shepherd — unless that loop is unattended
 *   (#425): then its red or conflicting PR is adopted, glob or not, under the
 *   exclusions below, and handed back once the loop returns;
 * - a required check on its head commit is red, or GitHub says it conflicts
 *   (`mergeStateStatus` `DIRTY`);
 * - its head commit is older than `prMedic.quietMinutes` — the operator is
 *   probably still pushing to a younger one;
 * - no medic has labelled it `<loop>-blocked`, and no OTHER medic holds
 *   `<loop>-wip` on it;
 * - the medic's pushes since the operator's last one are below
 *   `prMedic.maxPushes`: commits carrying a `Pr-Medic: <loop>` trailer, counted
 *   back from the head to the newest commit without one.
 *
 * The oldest such PR is claimed by adding this loop's `-wip` label to it,
 * under a machine-wide lock and after re-reading its labels and head right
 * before the write — the frontier's claim discipline, applied to a PR. The
 * labels are re-read AFTER the write as well, and a claim that finds another
 * medic's `-wip` beside its own takes its own back: two medics on two machines
 * share no lock, and the post-write read is what keeps them from both working
 * one branch. A PR this loop already holds is resumed without a second claim.
 *
 * The hand-over is the verdict line, `operator PR #<n> on <branch> — <reason>`,
 * which `ralph.sh` exports as `RALPH_INTAKE_PR` and `RALPH_INTAKE_REASON`
 * (`red: <checks>`, `conflicting`, or both). A PR red only on a confirmed flake
 * or an open infra incident (`pr-medic/known-red.ts`) is not handed over at
 * all: it gets the doctor's capped re-run once per head commit
 * (`ci-doctor/retry.ts`'s `retryHead`, on the doctor's own daily cap), and
 * then the gate waits — that red is the doctor's.
 *
 * Bounded the doctor's way: every `gh` call is charged to this loop's ledger in
 * the ci-health store (`ci-doctor/gh-budget.ts`, twelve an hour), the PR list
 * is one cached read on a ten-minute cadence, and a throttled or unreadable
 * read starts no iteration.
 *
 * Usage:
 *   pr-medic/gate.ts <poll-seconds>     wait until a PR is claimed, then exit 0
 *   pr-medic/gate.ts --once             one poll, claim included; 0 work, 1 none
 *   pr-medic/gate.ts --once --dry-run   the verdict only: no claim, no retry
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { matchesGlob } from "../executor-guard/diff-guard";
import { classifyRateLimit } from "../frontier/github-rate-limit";
import { withClaimLock } from "../frontier/next-tasks";
import {
  controlSliceSeconds,
  formatDuration,
  gateResume,
  secretRereadDue,
  secretRereadLine,
  sleepInSlices,
  supervisorGone,
  supervisorPidFrom,
} from "../frontier-gate";
import { hasPendingControl } from "../control-inbox";
import { projectRoot } from "../paths";
import { PR_MEDIC_DEFAULTS, loadProjectConfig, type ProjectConfig } from "../project-config";
import { parseCheck, relevantChecks, type Check } from "../pr-wait";
import { roleDescriptor } from "../roles";
import { ghRunner, jittered, retryDepsFrom, throttleWaitSeconds, type Gh, type Ran } from "../ci-doctor/gate";
import { affordable, due, ledgerAt, ledgerOf, spend, type Cadence } from "../ci-doctor/gh-budget";
import { headRetried, retryHead, type HeadRetryResult, type HeadTarget } from "../ci-doctor/retry";
import { readStore, storePathFromGit, withStore, type GhLedger } from "../ci-doctor/store";
import { leaseBlocksClaim, leasePathFromGit, leaseStatus, readLeaseStore } from "../claim-lease";
import type { UnattendedLoop } from "../loop-state";
import {
  adoptComment,
  adoptIdentityFrom,
  adoptionMarker,
  liveUnattendedRunner,
  pickOrphan,
  readUnattended,
  releaseAdoptedLease,
  said,
  takeAdoptedLease,
  ticketOf,
  type AdoptIdentity,
  type AdoptResult,
  type Unattended,
} from "./adoption";
import { knownDepsFrom, readKnownRed, type KnownVerdict, type PrHead } from "./known-red";

/**
 * The one standing read, `gh pr list` with everything the decision needs.
 * Ten minutes, not the doctor's fifteen and not every poll: at the 300-second
 * poll a read per poll is the whole twelve-an-hour allowance, which would
 * leave nothing for a claim. A stale list is safe because the claim re-reads
 * the one PR it is about to take.
 */
export const OPERATOR_PRS: Cadence = { key: "operator-prs", everySeconds: 600 };

/**
 * How many open pull requests one list reads. Not `100`: `PR_FIELDS` carries
 * `commits`, which `gh` expands to 100 commits with up to 100 authors each, and
 * GitHub's GraphQL refuses a query that MAY touch more than 500,000 nodes — so
 * 100 pull requests (1,000,000) failed every time against the real API, and
 * the gate reported "the open pull requests could not be read" (2026-10-07,
 * the first `--once` on loggd). 40 is 400,000; loggd keeps about ten open.
 */
export const PR_LIST_LIMIT = 40;

/** The most `gh` calls one claim makes: the re-read, the write, the read-back, a take-back. */
export const CLAIM_CALLS = 4;

export const PR_FIELDS = "number,isDraft,headRefName,headRefOid,mergeStateStatus,labels,statusCheckRollup,commits";

/**
 * The trailer a medic commit carries. The push fence (felipearos/ralph#247)
 * writes it; this gate only counts it. Any medic's, not only this loop's: the
 * cap is per pull request, and two medics taking turns must not get three
 * pushes each.
 */
export const MEDIC_TRAILER = /^Pr-Medic:[ \t]*\S/im;

export interface PrCommit {
  oid?: string;
  committedDate?: string;
  messageHeadline?: string;
  messageBody?: string;
}

/** One open pull request, as `gh pr list --json $PR_FIELDS` returns it. */
export interface OperatorPr {
  number: number;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  mergeStateStatus?: string;
  labels?: { name: string }[];
  statusCheckRollup?: unknown[];
  commits?: PrCommit[];
}

/** What the decision is judged against: the config and the roster, read once. */
export interface Rules {
  loop: string;
  /** Every roster loop's name — the `<loop>/` prefixes no medic may touch. */
  loops: readonly string[];
  /** The roster's pr-medic loops, this one included, in roster order. */
  medics: readonly string[];
  branches: readonly string[];
  quietMinutes: number;
  maxPushes: number;
  requiredChecks: readonly string[];
}

/**
 * The rules out of a loaded config. `branches` has no default and the config
 * refuses a rostered medic without one, so an empty list here is a project
 * with no medic, and matches nothing.
 */
export function rulesFrom(config: ProjectConfig, loop: string): Rules {
  return {
    loop,
    loops: config.roster.map((entry) => entry.name),
    medics: config.roster.filter((entry) => entry.role === "pr-medic").map((entry) => entry.name),
    branches: config.prMedic?.branches ?? [],
    quietMinutes: config.prMedic?.quietMinutes ?? PR_MEDIC_DEFAULTS.quietMinutes,
    maxPushes: config.prMedic?.maxPushes ?? PR_MEDIC_DEFAULTS.maxPushes,
    requiredChecks: config.requiredChecks,
  };
}

/* --------------------------------------------------------------------------
 * The pure reading of one pull request.
 * ----------------------------------------------------------------------- */

export const labelsOf = (pr: OperatorPr): string[] =>
  (pr.labels ?? []).map((label) => label?.name).filter((name): name is string => typeof name === "string");

/** The roster loop whose `<loop>/` branches this is, or null. */
export const agentOwner = (branch: string, loops: readonly string[]): string | null =>
  loops.find((loop) => branch.startsWith(`${loop}/`)) ?? null;

/**
 * Does a `prMedic.branches` glob match this branch? The executor guard's
 * matcher, because the config validates the globs in that dialect
 * (`project-config.ts`'s `segmentGlob` is pinned to it) and the push fence
 * matches with it too: a gate that read a glob one way and a fence another
 * would hand the fence a PR it then refuses.
 */
export const operatorBranch = (branch: string, globs: readonly string[]): boolean =>
  globs.some((glob) => matchesGlob(glob, branch));

/**
 * The required checks on the head commit that are red, and the ones that have
 * not finished. `pr-wait.ts`'s reading, so a PR this gate calls red is one
 * `AWAIT_PR … ci` would call red: a required check that has not reported yet is
 * pending, and with no `requiredChecks` every check counts.
 */
export function checksOf(pr: OperatorPr, required: readonly string[]): { red: string[]; pending: string[] } {
  const checks = (pr.statusCheckRollup ?? []).map(parseCheck).filter((check): check is Check => check !== null);
  const relevant = relevantChecks(checks, required);
  const names = (state: Check["state"]): string[] => [
    ...new Set(relevant.filter((check) => check.state === state).map((check) => check.name)),
  ];
  return { red: names("fail"), pending: names("pending") };
}

export const conflicting = (pr: OperatorPr): boolean => pr.mergeStateStatus === "DIRTY";

/** The head commit out of the PR's commit list, or null when the list does not carry it. */
export function headCommit(pr: OperatorPr): PrCommit | null {
  const commits = pr.commits ?? [];
  return commits.find((commit) => commit.oid === pr.headRefOid) ?? commits.at(-1) ?? null;
}

/**
 * How many whole minutes ago the head commit was committed, or null when that
 * cannot be read. The committer date, not the push: GitHub's list does not
 * carry a push time, and a rebase or an amend rewrites the committer date,
 * which is the moment the operator last touched the branch.
 */
export function headAgeMinutes(pr: OperatorPr, nowMs: number): number | null {
  const at = Date.parse(headCommit(pr)?.committedDate ?? "");
  if (!Number.isFinite(at)) return null;
  return Math.floor((nowMs - at) / 60_000);
}

const hasTrailer = (commit: PrCommit): boolean => MEDIC_TRAILER.test(commit.messageBody ?? "");

/**
 * Medic pushes since the operator's last: the medic-trailered commits at the
 * top of the branch, back to the newest commit without the trailer. An
 * operator push lands an untrailered commit on top and so clears the count —
 * the spec's "a new operator push clears the count".
 */
export function medicPushes(pr: OperatorPr): number {
  const commits = pr.commits ?? [];
  let count = 0;
  for (let index = commits.length - 1; index >= 0 && hasTrailer(commits[index]!); index--) count++;
  return count;
}

/** `red: a, b`, `conflicting`, or `conflicting; red: a` — `RALPH_INTAKE_REASON`. */
export function reasonOf(red: readonly string[], dirty: boolean): string {
  const parts = [dirty ? "conflicting" : null, red.length > 0 ? `red: ${red.join(", ")}` : null];
  return parts.filter((part) => part !== null).join("; ");
}

export type Assessment =
  | {
      kind: "case";
      pr: OperatorPr;
      reason: string;
      red: string[];
      dirty: boolean;
      resumed: boolean;
      /** The roster loop whose `<loop>/` branch this is, or null for the operator's. */
      owner: string | null;
      /** The unattended owner a NEW adoption takes the PR from; null otherwise. */
      adopted: UnattendedLoop | null;
      /** A resumed adoption whose owner is back: hand it back, push nothing. */
      handback: boolean;
    }
  /** `operator` says whether the PR was the operator's at all, for the idle line. */
  | { kind: "skip"; pr: number; why: string; operator: boolean };

/**
 * One PR against the rules, in the ticket's order of exclusions. Pure.
 *
 * A PR this loop already holds (`<loop>-wip`, and no other medic's ahead of it
 * in roster order) is RESUMED: the quiet period and the push cap do not apply,
 * because the young head is the medic's own push and the cap is the
 * iteration's to enforce by labelling the PR blocked. It is handed over when
 * it is red, conflicting or green — green is the iteration's cue to release
 * the claim — and waited on only while its checks are still running.
 *
 * A loop's branch is that loop's to shepherd, unless the loop is in
 * `unattended` (#425): then a red or conflicting PR of it is ADOPTED under the
 * operator's exclusions, and the `prMedic.branches` glob is not consulted. A
 * resumed adoption whose owner has come back is handed over as a hand-back.
 * `unattended` null means the read failed: nothing new is adopted and nothing
 * is handed back on a guess.
 */
export function assess(pr: OperatorPr, rules: Rules, nowMs: number, unattended: Unattended | null = null): Assessment {
  const owner = agentOwner(pr.headRefName, rules.loops);
  // Only the operator's own branch counts in the idle line: a loop's draft is
  // not an operator PR waiting on anything.
  const operator = owner === null && operatorBranch(pr.headRefName, rules.branches);
  const skip = (why: string): Assessment => ({ kind: "skip", pr: pr.number, why, operator });
  if (pr.isDraft) return skip("draft");
  if (owner === null && !operator) return skip(`${pr.headRefName} matches no prMedic.branches glob`);

  const labels = labelsOf(pr);
  const blocked = rules.medics.find((medic) => labels.includes(`${medic}-blocked`));
  if (blocked !== undefined) return skip(`labelled ${blocked}-blocked`);
  // Roster order breaks the one tie a label cannot: two medics' `-wip` on one
  // PR, which only a cross-machine race that the read-back missed can leave.
  const holder = rules.medics.find((medic) => labels.includes(`${medic}-wip`));
  if (holder !== undefined && holder !== rules.loop) return skip(`held by ${holder}-wip`);
  const resumed = holder === rules.loop;

  const { red, pending } = checksOf(pr, rules.requiredChecks);
  const dirty = conflicting(pr);
  const ailing = red.length > 0 || dirty;
  const kase = (reason: string, adopted: UnattendedLoop | null = null, handback = false): Assessment => ({
    kind: "case",
    pr,
    reason,
    red,
    dirty,
    resumed,
    owner,
    adopted,
    handback,
  });
  if (resumed) {
    // A known set without the owner is the owner back: the claim goes home
    // whatever CI says. An unknown set hands nothing back on a guess.
    if (owner !== null && unattended !== null && !unattended.has(owner)) return kase(`handback: ${owner} is back`, null, true);
    if (!ailing && pending.length > 0) return skip(`this loop's claim; ${pending.join(", ")} still running`);
    const reason = ailing ? reasonOf(red, dirty) : "green";
    return kase(owner === null ? reason : `adopted from ${owner}; ${reason}`);
  }

  const orphaned = owner === null ? undefined : unattended?.get(owner);
  if (owner !== null && orphaned === undefined) return skip(`${pr.headRefName} is the ${owner} loop's branch`);
  if (!ailing) return skip(pending.length > 0 ? `${pending.join(", ")} still running` : "green");

  const age = headAgeMinutes(pr, nowMs);
  if (age === null) return skip("its head commit's time could not be read");
  if (age < rules.quietMinutes) return skip(`pushed ${age}m ago (quiet for ${rules.quietMinutes}m)`);
  const pushes = medicPushes(pr);
  if (pushes >= rules.maxPushes) return skip(`${pushes} medic pushes since the operator's last (cap ${rules.maxPushes})`);
  if (orphaned !== undefined) return kase(`adopted from ${owner}; ${reasonOf(red, dirty)}`, orphaned);
  return kase(reasonOf(red, dirty));
}

/** The cases in the order they are taken: this loop's own claims, then the oldest PR first. */
export function casesOf(assessed: readonly Assessment[]): Extract<Assessment, { kind: "case" }>[] {
  return assessed
    .filter((one): one is Extract<Assessment, { kind: "case" }> => one.kind === "case")
    .sort((a, b) => Number(b.resumed) - Number(a.resumed) || a.pr.number - b.pr.number);
}

/* --------------------------------------------------------------------------
 * The claim.
 * ----------------------------------------------------------------------- */

export type ClaimOutcome = { outcome: "claimed" | "lost" | "unread"; why: string; rateLimited?: boolean };

/** What an adopted claim does beyond the label: the owner's lease, and the comment that says so. */
export interface ClaimAdoption {
  take: () => AdoptResult;
  release: () => void;
  comment: { mark: string; body: string };
}

const parsed = <T>(ran: Ran): T | null => {
  if (!ran.ok) return null;
  try {
    return JSON.parse(ran.stdout) as T;
  } catch {
    return null;
  }
};

const throttledRan = (ran: Ran): boolean => !ran.ok && classifyRateLimit(ran.stderr || ran.stdout) !== null;

/**
 * Claim one PR for `loop`: re-read, write `<loop>-wip`, read back.
 *
 * The re-read is the frontier's rule — decide from a live read immediately
 * before the write, never from the list — and it runs under `withLock`, the
 * machine-wide claim lock, so two medics on one host are serialised and the
 * second sees the first's label. The read-back is for the race the lock cannot
 * see, two hosts: if another medic's `-wip` is there beside this one, this
 * loop takes its own label back and reports the race lost. Both may then back
 * off, which is the safe failure — the next poll tries again — where both
 * keeping the label is two agents force-pushing one operator's branch.
 *
 * A read-back that fails leaves the label on and reports `unread`, so nothing
 * is spawned this poll; the next poll finds the PR carrying this loop's `-wip`
 * and resumes it, which is the right ending if the claim did land.
 *
 * An ADOPTION (#425) also takes the owner's claim lease, inside the lock and
 * before the label, so a refused lease writes no label; a label that does not
 * stick gives the lease back. The adoption comment follows a claim that held,
 * once per head: a failed comment leaves the claim standing.
 */
export async function claimPr(
  gh: Gh,
  pr: OperatorPr,
  loop: string,
  medics: readonly string[],
  withLock: <T>(critical: () => Promise<T>) => Promise<T>,
  adopt?: ClaimAdoption,
): Promise<ClaimOutcome> {
  const n = String(pr.number);
  const label = `${loop}-wip`;
  const others = (labels: readonly string[]): string[] =>
    medics.filter((medic) => medic !== loop && (labels.includes(`${medic}-wip`) || labels.includes(`${medic}-blocked`)));
  const unread = (ran: Ran, what: string): ClaimOutcome => ({
    outcome: "unread",
    why: `${what} failed${ran.stderr.trim() === "" ? "" : `: ${ran.stderr.trim().split("\n")[0]}`}`,
    ...(throttledRan(ran) ? { rateLimited: true } : {}),
  });

  return withLock(async () => {
    const fields = adopt === undefined ? "state,isDraft,headRefOid,labels" : "state,isDraft,headRefOid,labels,comments";
    const before = await gh(["pr", "view", n, "--json", fields]);
    const live = parsed<{
      state?: string;
      isDraft?: boolean;
      headRefOid?: string;
      labels?: { name: string }[];
      comments?: { body?: string }[];
    }>(before);
    if (live === null) return unread(before, "re-reading the PR");
    if (live.state !== "OPEN" || live.isDraft === true) return { outcome: "lost", why: "no longer open and ready" };
    if (live.headRefOid !== pr.headRefOid) return { outcome: "lost", why: "its head moved since the list was read" };
    const liveLabels = labelsOf({ ...pr, labels: live.labels ?? [] });
    const held = others(liveLabels);
    if (held.length > 0) return { outcome: "lost", why: `claimed by ${held.join(", ")} first` };
    if (adopt !== undefined) {
      const took = adopt.take();
      if (!took.ok) return { outcome: "lost", why: took.why };
    }
    if (!liveLabels.includes(label)) {
      const wrote = await gh(["pr", "edit", n, "--add-label", label]);
      if (!wrote.ok) {
        adopt?.release();
        return unread(wrote, `adding ${label}`);
      }
    }
    const after = await gh(["pr", "view", n, "--json", "labels"]);
    const back = parsed<{ labels?: { name: string }[] }>(after);
    if (back === null) return unread(after, "reading the claim back");
    const raced = others(labelsOf({ ...pr, labels: back.labels ?? [] }));
    if (raced.length > 0) {
      // Best effort: a take-back that fails leaves both labels, and `assess`'s
      // roster-order tie-break then gives the PR to exactly one of them.
      await gh(["pr", "edit", n, "--remove-label", label]);
      adopt?.release();
      return { outcome: "lost", why: `raced ${raced.join(", ")} for it` };
    }
    if (adopt !== undefined && !said(live.comments, adopt.comment.mark)) {
      await gh(["pr", "comment", n, "--body", adopt.comment.body]);
    }
    return { outcome: "claimed", why: `claimed with ${label}` };
  });
}

/* --------------------------------------------------------------------------
 * One poll.
 * ----------------------------------------------------------------------- */

export interface PollDeps {
  gh: Gh;
  now: () => number;
  storePath: string;
  rules: Rules;
  /** Is this red PR red only on things the doctor knows? (`known-red.ts`) */
  known: (head: PrHead, red: readonly string[], rollup: unknown) => Promise<KnownVerdict>;
  /**
   * The doctor's capped re-run of every failed job at this head, or ABSENT
   * when the gate holds no retry token — then a known-only red is simply left
   * to the doctor, which is how the medic behaves on a project without one.
   */
  retry?: (target: HeadTarget, budget: { afford: (calls: number) => boolean }) => Promise<HeadRetryResult>;
  /** The machine-wide claim lock. */
  withLock: <T>(critical: () => Promise<T>) => Promise<T>;
  /** The verdict only: no claim, no retry. `--once --dry-run`. */
  dryRun?: boolean;
  /** The unattended loops (`adoption.ts`'s `readUnattended`); null when they could not be read. */
  unattended: () => Unattended | null;
  /**
   * What a NEW adoption needs: the claim-lease store, who takes the lease and
   * where. Absent, or with no identity, the gate adopts nothing new; an
   * adoption it already holds is still resumed.
   */
  adoption?: { leasePath: string; identity: AdoptIdentity | null; worktree: string; pidAlive?: (pid: number) => boolean };
}

/** What survives between polls: the last PR list, and each head's settled known-red verdict. */
export interface Cached {
  prs: OperatorPr[] | null;
  /** `<pr>@<sha>` → a `known` or `unknown` verdict. A `wait` is never kept. */
  known: Record<string, KnownVerdict>;
}

export const noCache = (): Cached => ({ prs: null, known: {} });

export interface Verdict {
  work: boolean;
  why: string;
  pr: number | null;
  reason: string | null;
  /** The PR was already this loop's, so nothing was claimed. */
  resumed?: boolean;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
}

export interface Polled {
  verdict: Verdict;
  cached: Cached;
  /** `gh` calls this poll made, retries' reserved calls included. */
  calls: number;
  /** Every retry this poll attempted, in order. */
  retried: HeadRetryResult[];
}

/** `operator PR #2197 on felipearosr/x — red: buildkite/loggd`: the case `ralph.sh` reads. */
export const caseText = (pr: OperatorPr, reason: string): string =>
  `operator PR #${pr.number} on ${pr.headRefName} — ${reason}`;

export const throttledWhy = (retryAfterSeconds: number | null): string =>
  `GitHub rate-limited the medic's read${retryAfterSeconds === null ? "" : ` (GitHub asked for ${retryAfterSeconds}s)`}`;

/** The idle line's detail: what each operator PR is waiting on, the first few by number. */
export function idleWhy(assessed: readonly Assessment[], notes: readonly string[]): string {
  if (notes.length > 0) return `no operator PR to take — ${notes.join("; ")}`;
  const mine = assessed
    .filter((one): one is Extract<Assessment, { kind: "skip" }> => one.kind === "skip" && one.operator)
    .sort((a, b) => a.pr - b.pr);
  if (mine.length === 0) return "no open operator pull request";
  const shown = mine.slice(0, 5).map((one) => `#${one.pr} ${one.why}`);
  if (mine.length > shown.length) shown.push(`… ${mine.length - shown.length} more`);
  return `no red operator PR to take — ${shown.join("; ")}`;
}

/**
 * Read, decide, retry a known-only red, claim the first case left.
 *
 * Every `gh` call goes through `ask`, which charges it to this loop's ledger
 * and refuses it when the hour's allowance is spent; the ledger is written back
 * to the store once, at the end. A lost claim moves on to the next case rather
 * than waiting a whole interval to find it free — bounded by the number of
 * open PRs, so it cannot spin.
 */
export async function poll(deps: PollDeps, cached: Cached): Promise<Polled> {
  const now = deps.now();
  const { rules } = deps;
  let ledger: GhLedger = ledgerAt(ledgerOf(readStore(deps.storePath), rules.loop), now);
  let calls = 0;
  let rateLimited = false;
  let retryAfterSeconds: number | null = null;
  const retried: HeadRetryResult[] = [];
  const next: Cached = { prs: cached.prs, known: { ...cached.known } };

  /** One charged call; a cadence read with an answer in hand waits for its interval. */
  const ask = async (args: string[], cadence?: Cadence, cold = false): Promise<Ran | null> => {
    if (!affordable(ledger, 1, now)) return null;
    if (cadence !== undefined && !cold && !due(ledger, cadence, now)) return null;
    ledger = spend(ledger, 1, now);
    calls += 1;
    const ran = await deps.gh(args);
    if (!ran.ok) {
      const signal = classifyRateLimit(ran.stderr || ran.stdout);
      if (signal !== null) {
        rateLimited = true;
        retryAfterSeconds = signal.retryAfterSeconds ?? retryAfterSeconds;
      }
      return ran;
    }
    // Stamped only on success, as the doctor's gate does: one throttled read
    // must not blind the gate for a whole cadence.
    if (cadence !== undefined) ledger = spend(ledger, 0, now, cadence);
    return ran;
  };

  // The adoption this loop holds, if any: one at a time (#425). `undefined`
  // leaves the stored record as it is; `null` clears it.
  let held = readStore(deps.storePath).medicAdoptions?.[rules.loop] ?? null;
  let record: { pr: number; head: string; issue: number } | null | undefined;

  const finish = async (verdict: Verdict): Promise<Polled> => {
    await withStore(deps.storePath, (open) => {
      open.gh = { ...open.gh, [rules.loop]: ledger };
      if (record !== undefined) {
        const rest = { ...open.medicAdoptions };
        delete rest[rules.loop];
        open.medicAdoptions = record === null ? rest : { ...rest, [rules.loop]: record };
      }
    });
    return { verdict, cached: next, calls, retried };
  };
  const wait = (why: string): Verdict => ({ work: false, why, pr: null, reason: null });
  const throttled = (): Verdict => ({
    ...wait(throttledWhy(retryAfterSeconds)),
    rateLimited: true,
    retryAfterSeconds,
  });

  // `cold` for the doctor's reason: the cadence mark is in the store and the
  // answer in this process, so a restarted gate would otherwise hold neither.
  const listed = await ask(["pr", "list", "--state", "open", "--limit", String(PR_LIST_LIMIT), "--json", PR_FIELDS], OPERATOR_PRS, cached.prs === null);
  if (listed !== null) {
    const prs = parsed<OperatorPr[]>(listed);
    if (Array.isArray(prs)) next.prs = prs;
  }
  // A throttled poll starts no iteration, whatever the cache holds: the claim
  // is a GitHub write and would be the next call to be refused.
  if (rateLimited) return finish(throttled());
  if (next.prs === null) return finish(wait("the open pull requests could not be read"));

  // Asked only when a listed PR is on a loop's branch: the read spawns a bun
  // process, and a poll with nothing a loop owns has no use for its answer.
  let unattended: Unattended | null = new Map();
  if (next.prs.some((pr) => agentOwner(pr.headRefName, rules.loops) !== null)) {
    try {
      unattended = deps.unattended();
    } catch {
      unattended = null;
    }
  }
  const assessed = next.prs.map((pr) => assess(pr, rules, now, unattended));
  const notes: string[] = [];

  const identity = deps.adoption?.identity ?? null;
  /**
   * Release this run's adopted lease. False only when the release FAILED (a
   * busy lock, an unusable store): the caller then keeps the record, so the
   * next poll tries again — a lease forgotten here is renewed by the
   * heartbeat for the rest of the run and blocks every later adoption.
   */
  const release = (issue: number): boolean =>
    deps.adoption === undefined || identity === null || releaseAdoptedLease(deps.adoption.leasePath, issue, identity) !== "failed";

  // The iteration ended the adoption once the PR it names lost this loop's
  // `-wip`. `case.ts` releases the lease too; releasing again is harmless.
  const named = held === null ? undefined : next.prs.find((one) => one.number === held!.pr);
  if (held !== null && named !== undefined && !labelsOf(named).includes(`${rules.loop}-wip`)) {
    if (deps.dryRun !== true && release(held.issue)) record = null;
    held = null;
  } else if (held !== null && named !== undefined && named.isDraft) {
    // An adoption turned into a draft: `assess` skips every draft, so no
    // iteration would ever drop this claim, and its `-wip` is what keeps the
    // returning owner off its own branch (`frontier-gate.ts`'s `adoptedBy`).
    // The draft is the operator's call; the medic lets go of it.
    if (deps.dryRun === true) {
      notes.push(`#${named.number} is a draft — would release the adoption`);
    } else {
      const released = release(held.issue);
      const removed = await ask(["pr", "edit", String(named.number), "--remove-label", `${rules.loop}-wip`]);
      if (rateLimited) return finish(throttled());
      // Both or neither: a half-done release keeps the record, so the next
      // poll finishes it before anything new is adopted.
      if (released && removed?.ok === true) {
        record = null;
        held = null;
      }
      notes.push(`#${named.number} is a draft — ${held === null ? "adoption released" : "its release is not finished yet"}`);
    }
  }

  // A PR the list no longer shows may be closed, or merely past the list's
  // limit, so absence proves nothing: only a re-read that says it is not
  // OPEN ends the adoption. Otherwise its `-wip` and lease would outlive it,
  // and with one adoption at a time the medic would never adopt again.
  if (held !== null && named === undefined) {
    const n = held.pr;
    const viewed = await ask(["pr", "view", String(n), "--json", "state"]);
    if (rateLimited) return finish(throttled());
    const live = viewed === null ? null : parsed<{ state?: unknown }>(viewed);
    const state = live !== null && typeof live === "object" ? live.state : undefined;
    if (typeof state === "string" && state !== "OPEN") {
      if (deps.dryRun === true) {
        notes.push(`#${n} closed — would release the adoption`);
      } else {
        const released = release(held.issue);
        // Best effort: the claim is over whatever the label says, and a
        // closed PR's stray label blocks nothing.
        const removed = await ask(["pr", "edit", String(n), "--remove-label", `${rules.loop}-wip`]);
        if (released) record = null;
        notes.push(
          `#${n} closed — ${released ? "adoption released" : "its lease could not be released yet"}${removed?.ok === true ? "" : `; ${rules.loop}-wip could not be removed`}`,
        );
        if (rateLimited) return finish(throttled());
      }
      held = null;
    }
  }

  // One orphan per poll, and none while this loop already holds one: the
  // supervisor's heartbeat renews one lease per run. An orphan that cannot be
  // claimed this poll — its owner's lease still blocks, or its red is a known
  // flake whose one retry is spent — is left out BEFORE the pick, or it would
  // be picked every poll and starve every other orphan.
  const leases = (() => {
    if (deps.adoption === undefined) return null;
    try {
      return readLeaseStore(deps.adoption.leasePath);
    } catch {
      return null;
    }
  })();
  const pidAlive = deps.adoption?.pidAlive;
  const adoptable: OperatorPr[] = [];
  for (const one of assessed) {
    if (one.kind !== "case" || one.adopted === null || one.owner === null) continue;
    const ticket = ticketOf(one.pr.headRefName, one.owner);
    if (ticket === null) {
      notes.push(`#${one.pr.number} ${one.pr.headRefName} names no issue — not adopted`);
      continue;
    }
    const lease = leases?.leases[String(ticket)];
    const ours = lease !== undefined && identity !== null && lease.run === identity.run && lease.loop === identity.loop;
    const clock = { nowMs: now, ...(pidAlive ? { pidAlive } : {}) };
    if (lease !== undefined && !ours && leaseBlocksClaim(lease, clock)) {
      notes.push(`#${one.pr.number} ${lease.loop}'s lease on #${ticket} is still ${leaseStatus(lease, clock)} — not adopted`);
      continue;
    }
    if (next.known[`${one.pr.number}@${one.pr.headRefOid}`]?.kind === "known" && headRetried(readStore(deps.storePath), one.pr.number, one.pr.headRefOid)) {
      continue;
    }
    adoptable.push(one.pr);
  }
  let orphan: OperatorPr | null = null;
  if (adoptable.length > 0) {
    if (held !== null) notes.push(`already adopting #${held.pr} — no second adoption`);
    else if (deps.adoption === undefined || identity === null) notes.push("no adoption identity — nothing adopted");
    else orphan = pickOrphan(adoptable);
  }
  const taken = assessed.filter((one) => one.kind !== "case" || one.adopted === null || one.pr === orphan);

  for (const kase of casesOf(taken)) {
    const { pr } = kase;
    // Only a red that is nothing else: a conflict is the medic's whatever CI
    // says, and a resumed claim was judged when it was taken.
    if (!kase.resumed && !kase.dirty && kase.red.length > 0) {
      const key = `${pr.number}@${pr.headRefOid}`;
      const known =
        next.known[key] ?? (await deps.known({ pr: pr.number, sha: pr.headRefOid, branch: pr.headRefName }, kase.red, pr.statusCheckRollup ?? []));
      if (known.kind !== "wait") next.known[key] = known;
      if (known.kind === "wait") {
        notes.push(`#${pr.number} ${known.why}`);
        continue;
      }
      if (known.kind === "known") {
        if (headRetried(readStore(deps.storePath), pr.number, pr.headRefOid)) {
          notes.push(`#${pr.number} ${known.why}; its head had its one retry — the doctor's now`);
          continue;
        }
        if (deps.dryRun === true || deps.retry === undefined) {
          notes.push(`#${pr.number} ${known.why}; ${deps.dryRun === true ? "would retry it" : "no retry token — the doctor's"}`);
          continue;
        }
        const result = await deps.retry(known.target, { afford: (n) => affordable(ledger, n, now) });
        ledger = spend(ledger, result.ghCalls, now);
        calls += result.ghCalls;
        retried.push(result);
        notes.push(`#${pr.number} ${known.why}; retry ${result.outcome}`);
        continue;
      }
    }

    const work: Verdict = { work: true, why: caseText(pr, kase.reason), pr: pr.number, reason: kase.reason };
    if (kase.resumed) {
      // A claim whose read-back failed holds the lease but wrote no record:
      // write it now, so the closed-PR release above can find it.
      if (deps.dryRun !== true && kase.owner !== null && held?.pr !== pr.number) {
        const issue = ticketOf(pr.headRefName, kase.owner);
        if (issue !== null) record = { pr: pr.number, head: pr.headRefOid, issue };
      }
      return finish({ ...work, resumed: true });
    }
    if (deps.dryRun === true) return finish(work);
    const adopting = kase.adopted !== null && kase.owner !== null ? kase.adopted : null;
    if (!affordable(ledger, CLAIM_CALLS + (adopting === null ? 0 : 1), now)) {
      notes.push(`#${pr.number} no GitHub allowance left this hour to claim it`);
      break;
    }
    const counted: Gh = async (args) => {
      ledger = spend(ledger, 1, now);
      calls += 1;
      return deps.gh(args);
    };
    let adopt: ClaimAdoption | undefined;
    let stranded = false;
    let issue: number | null = null;
    if (adopting !== null && deps.adoption !== undefined && identity !== null) {
      const { leasePath, worktree, pidAlive } = deps.adoption;
      const ticket = ticketOf(pr.headRefName, kase.owner!)!;
      issue = ticket;
      adopt = {
        take: () =>
          takeAdoptedLease(leasePath, {
            issue: ticket,
            identity,
            worktree,
            branch: pr.headRefName,
            nowMs: now,
            ...(pidAlive ? { pidAlive } : {}),
          }),
        release: () => {
          stranded = releaseAdoptedLease(leasePath, ticket, identity) === "failed";
        },
        comment: {
          mark: adoptionMarker("adopt", rules.loop, pr.headRefOid),
          body: adoptComment({
            medic: rules.loop,
            owner: kase.owner!,
            stopKind: adopting.stopKind,
            downSince: adopting.downSince,
            nowMs: now,
            head: pr.headRefOid,
          }),
        },
      };
    }
    const claim = await claimPr(counted, pr, rules.loop, rules.medics, deps.withLock, adopt);
    if (claim.rateLimited === true) {
      rateLimited = true;
      return finish(throttled());
    }
    if (claim.outcome === "claimed") {
      if (issue !== null) record = { pr: pr.number, head: pr.headRefOid, issue };
      return finish(work);
    }
    // A lost claim whose lease could not be given back: record it anyway, so
    // the next poll finds the PR without this loop's `-wip` and releases again.
    if (stranded && issue !== null) record = { pr: pr.number, head: pr.headRefOid, issue };
    notes.push(`#${pr.number} ${claim.why}`);
    // An unreadable claim is a fault of the read, not of this PR, and the
    // next PR's claim would read the same way: wait rather than walk on.
    if (claim.outcome === "unread") break;
  }
  return finish(wait(idleWhy(assessed, notes)));
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const PREFIX = "pr-medic-gate";

export const verdictLine = (verdict: Verdict): string =>
  `${PREFIX}: ${verdict.work ? "work available" : "nothing to do"} — ${verdict.why}`;

export const workLine = (verdict: Verdict): string => `${PREFIX}: work available — ${verdict.why}`;

export const retryLine = (result: HeadRetryResult): string => `${PREFIX}: retry ${result.outcome} — ${result.why}`;

/** Matched by `ralph.sh`, which goes back to its control checkpoint instead of spawning. */
export const CONTROL_PENDING_LINE = `${PREFIX}: control command waiting — handing back to the supervisor`;

export function waitingLine(
  verdict: Verdict,
  state: { poll: number; waitingSince: Date; now: Date; waitSeconds: number },
): string {
  const idle = Math.max(0, Math.round((state.now.getTime() - state.waitingSince.getTime()) / 1000));
  const at = state.now.toISOString().replace(/\.\d+Z$/, "Z");
  return `${PREFIX}: ${verdict.why} at ${at} — waiting ${state.waitSeconds}s (poll ${state.poll}, idle ${formatDuration(idle)})`;
}

/** From the role descriptor, as the doctor's is: `roles.ts` says how long a role's gate waits. */
export const DEFAULT_POLL_SECONDS = roleDescriptor("pr-medic").pollSeconds;

export function pollSeconds(argv: string | undefined): number {
  if (argv !== undefined && /^\d+$/.test(argv) && Number(argv) >= 1) return Number(argv);
  return DEFAULT_POLL_SECONDS;
}

function wire(root: string, loop: string, env: NodeJS.ProcessEnv, dryRun: boolean): PollDeps {
  // Loaded strictly: the config validator is what refuses a medic with no
  // `prMedic.branches`, and a gate that guessed a blast radius here would be
  // the harness choosing whose branches an agent pushes to. A throw is exit 2,
  // which the supervisor retries and then stops on with the reason logged.
  const config = loadProjectConfig(root);
  const storePath = storePathFromGit(root);
  const lockPath = join(dirname(storePath), "pr-medic-claim.lock");
  const known = knownDepsFrom(env, storePath);
  const retry = retryDepsFrom(root, env);
  return {
    gh: ghRunner,
    now: () => Date.now(),
    storePath,
    rules: rulesFrom(config, loop),
    known: (head, red, rollup) => readKnownRed(known, head, red, rollup),
    ...(retry === undefined ? {} : { retry: (target, { afford }) => retryHead({ ...retry, afford }, target) }),
    withLock: (critical) => {
      mkdirSync(dirname(lockPath), { recursive: true });
      return withClaimLock(lockPath, critical);
    },
    dryRun,
    unattended: () => readUnattended(liveUnattendedRunner(root)),
    adoption: { leasePath: leasePathFromGit(root), identity: adoptIdentityFrom(env), worktree: root },
  };
}

const resumedLine = (verdict: Verdict, loop: string): string =>
  `${PREFIX}: PR #${verdict.pr} already carries ${loop}-wip — resuming this loop's claim`;

async function main(): Promise<void> {
  // Anchored like the other gates: unanchored, every `gh` call answers for
  // whatever directory this was invoked from.
  process.chdir(projectRoot());
  const root = process.cwd();
  const argv = process.argv.slice(2);
  const loop = process.env.RALPH_LOOP_NAME?.trim() || "medi";
  const once = argv.includes("--once");
  const deps = wire(root, loop, process.env, once && argv.includes("--dry-run"));

  if (once) {
    const { verdict, retried } = await poll(deps, noCache());
    for (const result of retried) console.log(retryLine(result));
    if (verdict.resumed === true) console.log(resumedLine(verdict, loop));
    console.log(verdictLine(verdict));
    process.exitCode = verdict.work ? 0 : 1;
    return;
  }

  const interval = pollSeconds(argv.find((arg) => !arg.startsWith("--")));
  const { waitingSince, firstPoll } = gateResume(process.env, new Date());
  const supervisorPid = supervisorPidFrom(process.env, process.ppid);
  const slice = controlSliceSeconds(process.env.RALPH_CONTROL_POLL_SECONDS);
  let cached = noCache();
  let lastRetry: string | null = null;

  for (let count = firstPoll; ; count++) {
    const polled = await poll(deps, cached);
    cached = polled.cached;
    // Only when the answer changes, for the doctor's reason: a busy host says
    // `busy` every poll, and repeating it buries the lines that matter.
    const lines = polled.retried.map(retryLine).join("\n");
    if (lines !== "" && lines !== lastRetry) console.log(lines);
    lastRetry = lines === "" ? lastRetry : lines;
    if (polled.verdict.work) {
      if (polled.verdict.resumed === true) console.log(resumedLine(polled.verdict, loop));
      console.log(workLine(polled.verdict));
      return;
    }
    const wait =
      polled.verdict.rateLimited === true
        ? throttleWaitSeconds(polled.verdict.retryAfterSeconds ?? null)
        : jittered(interval);
    console.log(waitingLine(polled.verdict, { poll: count, waitingSince, now: new Date(), waitSeconds: wait }));
    // No sleep here: the supervisor re-reads its unread secrets (#759), then runs the gate again.
    if (secretRereadDue(process.env, count)) {
      console.log(secretRereadLine(PREFIX, wait, count));
      return;
    }
    const woke = await sleepInSlices(wait, slice, () => {
      if (supervisorGone(supervisorPid)) return "orphaned" as const;
      return hasPendingControl(root) ? ("control" as const) : null;
    });
    if (woke === "orphaned") {
      console.log(`${PREFIX}: supervisor ${supervisorPid} is gone — stopping.`);
      return;
    }
    if (woke === "control") {
      console.log(CONTROL_PENDING_LINE);
      return;
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
