#!/usr/bin/env bun
/**
 * Next tasks — the actionable frontier of the ticket graph.
 *
 * Answers "what can I pick up right now, and what can run in parallel".
 *
 * The graph is built from EVERY open issue, so readiness stays truthful even
 * when a blocker is not itself queued. Only `ready-for-agent` issues are
 * displayed; a blocker outside the queue still blocks, and is surfaced.
 *
 * Blocking edges are the UNION of two sources, because the repo currently
 * carries both:
 *   - `## Blocked by` prose written by /to-tickets
 *   - GitHub native issue dependencies
 * That union is a transition. Prose-only edges are reported in the footer;
 * they are the backfill worklist.
 *
 * The one write this tool makes is the claim: every ticket it prints under
 * READY NOW is assigned to OWNER, because showing a frontier and leaving it
 * unclaimed is how two workers pick the same ticket. `ralph/prompt.md` reads
 * an assignee as "someone already has this", so the claim is also the fence
 * that keeps the Ralph loop off work Felipe just took. Claiming re-reads each
 * ticket immediately before writing, since the graph is a snapshot and a
 * competing claim can land inside that window. Pass `--dry-run` to read only.
 * Inside a Ralph loop session (`RALPH_RUN_ID` set) a run that is neither
 * `--take-one` nor `--dry-run` is read-only, as `--dry-run`: an assignee reads
 * as "a human has this", so an agent that only ran it to look handed every
 * READY NOW ticket to OWNER and starved every loop (#786). Loops claim through
 * `--take-one`.
 *
 * Tickets are grouped by their `## Parent` spec and optional `## Staffing
 * group`. A tree with any ungrouped child keeps the legacy parent-wide
 * collision domain, so partial metadata cannot accidentally increase
 * concurrency. That rule is ENFORCED, not advised: READY NOW prints at most
 * one ticket per collision domain, so "start an agent on every line, in
 * parallel" is literally true. Spec parents are excluded for the same reason
 * — implementing the spec is implementing its children.
 *
 * Nothing may vanish. Every readiness decision the tool makes has to be
 * visible somewhere in the output, because a queued ticket that silently
 * disappears is indistinguishable from one that does not exist. That covers
 * routing too: with Jav on, a ready ticket carrying no difficulty label is one
 * no loop takes, so `--dry-run` also lists it under UNTRIAGED.
 *
 * `--tree` swaps the flat sections for the graph drawn as a tree — the same
 * data, shaped to answer "why is there nothing to do" rather than "what do I
 * start". See `buildTree`.
 *
 * `--take-one` swaps both for one line of JSON: exactly one UNIT, claimed with
 * the calling loop's `<loop>-wip` label, for a caller that wants work and must
 * never race a second caller for it. A coder's unit is one ticket, and its JSON
 * is the `ticket`/`title`/`tree` it always was; a triager's may be a bucket's
 * worth of them, and says so in two added keys, `bucket` and `tickets`. It is a label rather than an assignee because the
 * loop keeps off any assignee, and an assignee is the fence a human uses. The
 * supervisor that polls it reads a ticket number out of that line, never out
 * of a rendered terminal frontier — so an empty frontier is `ticket: null`,
 * not an error, and the only output is the JSON itself.
 * `--exclude <number>` supplies a caller-owned scope fence to single-ticket
 * mode. It never reorders the frontier; it only withholds named tickets from
 * the atomic claim.
 *
 * Both claim paths — this one and the maintainer's bulk claim — write under
 * the lock in `withClaimLock`, which is where the reasoning about concurrent
 * callers lives.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  claimLease,
  currentGitDetails,
  leasePathFromGit,
  leaseStatus,
  readLeaseStore,
  writeLeaseStore,
  type ClaimLease,
  type LeaseClock,
  type LeaseStatus,
} from "../claim-lease";
import { UNKNOWN_BLOCK, blockReasonOf, latestBlockReason, rescuableBlock, type BlockReason, type IssueComment } from "../block-reason";
import { DEFAULT_UNBLOCK_DAYS, hasCurrentTriage, rescueBar, triageGaveUp, triageMarkerOf } from "../triage-marker";
import { isUntriagedReport } from "../triage/intake";
import { configuredParkStorePath, listStore, type ListedPark } from "../park-store";
import { isRoutingExempt, javLabelsFor, javPath, readJav, routeByDifficulty, type JavConfig } from "../jav";
import { projectRoot } from "../paths";
import { loadProjectConfig, trackerKey } from "../project-config";
import { sectionIfPresent } from "../sections";
import { recordSpeedEvent } from "../speed";
import { currentProjectId, loopsWithRole, projectRosterEntries, type RosterEntry } from "../roster";
import { DEFAULT_ROLE, isRole, ROLES, roleDescriptor, type Role } from "../roles";
import {
  RATE_LIMITED_EXIT,
  frontierConcurrency,
  isRateLimited,
  parseIncluded,
  retryPolicy,
  withRateLimitRetry,
  type RetryBudget,
} from "./github-rate-limit";
import { branchClaimMaxAgeMs, readBranchClaims, type BranchClaim } from "./branch-claims";
import { CommandError, run } from "../tracker/command";
import { classifyDependencyFailure, classifyGhFailure, createGithubTracker, readOpenIssuesWithBlockers } from "../tracker/github";
import { createTracker } from "../tracker/index";
import type { Tracker } from "../tracker/types";
import { withoutCode } from "../markdown-code";

// Moved to the tracker seam (felipearos/ralph#330); re-exported so existing
// callers and tests keep their import path.
export { CommandError, classifyDependencyFailure, classifyGhFailure, readOpenIssuesWithBlockers };
export { OPEN_ISSUES_QUERY } from "../tracker/github";

/** Exported: `triage/order.ts` sequences writes around this label by name. */
export const READY_LABEL = "ready-for-agent";
/**
 * The one priority lane: a backlog whose base branch is broken has nothing more
 * valuable to offer than the fix. The frontier only READS the label — it
 * reorders what is already offerable and promotes nothing, so claimed, stuck,
 * blocked, spec and `--exclude`-fenced tickets are as unofferable as before,
 * and Jav routing still filters afterwards (`roleUnits`).
 *
 * **Nothing in this repo writes it yet.** `roles.ts:562` only declares it as a
 * label the doctor's project must HAVE (`preflight.labels`), and the doctor's
 * own filing labels are `ci-health`/`ready-for-agent`/`bug`
 * (`ci-doctor/case-issue.ts`'s `CODER_FILING_LABELS`). So today the writer is
 * an operator, and the regression path of #132's children is what should take
 * it over. Said here because a reader who greps for the producer the lane
 * implies finds a preflight existence check and concludes this is dead code.
 *
 * `roles.ts` names the label again rather than importing this constant, and
 * must: it imports nothing from the harness — `project-config.ts` validates
 * the roster against it and this file imports it, so the import would be a
 * cycle. `triage/validate.ts` has no such excuse and does import it.
 */
export const URGENT_LABEL = "priority:urgent";
/**
 * How many open PRs the claim census reads. The fence degrades quietly past
 * this bound rather than failing, so the read is checked against it and the
 * truncation is printed — a silent fence is worse than no fence, because the
 * frontier is believed.
 */
export const OPEN_PR_CENSUS_LIMIT = 200;
/**
 * Claims go here. `gh` cannot resolve "@me" for assignment, so name the login —
 * the project's `owner` in `.ralph/config.json` (or `RALPH_PROJECT_OWNER`, which
 * the supervisor exports from that same file). Resolved lazily: the read-only
 * and pure paths of this module must not need a project at all.
 */
let cachedOwner: string | null = null;
function owner(): string {
  if (cachedOwner === null) {
    cachedOwner = process.env.RALPH_PROJECT_OWNER?.trim() || loadProjectConfig(projectRoot()).owner;
  }
  return cachedOwner;
}
/**
 * The loops that work this backlog, and how a reader tells them apart.
 *
 * Several supervisors run against one tracker, each from a worktree of its
 * own, and the labels carry that identity: `<loop>-wip` is a claim,
 * `<loop>-blocked` is that loop wedged. The name is in the label rather than
 * beside it in a second `loop:*` tag so that one chip in the issue list
 * answers both "what state is this in" and "who has it".
 *
 * The roster is the project's: `loops` in its `.ralph/config.json`, so
 * another project's loops may share these names without sharing a fence.
 *
 * Every READ over these labels asks about the whole set, because the fence
 * they raise is "somebody is already on this ticket" and which loop that is
 * cannot change the answer. Only the WRITE names one loop: the one this
 * process belongs to.
 */
export type LoopName = string;

let cachedRoster: readonly RosterEntry[] | null = null;
/**
 * This project's loops with their roles. Resolved lazily and once, like
 * `owner()`: the pure paths of this module must not need a project. A checkout
 * without a config throws on first use: there is no roster to fence claims with.
 *
 * Jav reads this one rather than the names: routing is written for the loops
 * that pick from the frontier, and a roster passed as bare names would let a
 * triager hold a route the frontier would never read.
 */
export function loopRosterEntries(): readonly RosterEntry[] {
  cachedRoster ??= projectRosterEntries(projectRoot());
  return cachedRoster;
}

/**
 * This project's loops by name, whatever their role — what the claim fences
 * compare and list. Derived from `loopRosterEntries()` rather than read again,
 * so a roster edit landing between two first uses cannot leave the fences on one
 * roster and Jav's route targets on another.
 */
export function loopRoster(): readonly string[] {
  return loopRosterEntries().map((entry) => entry.name);
}

export const wipLabelFor = (loop: LoopName): string => `${loop}-wip`;
export const stuckLabelFor = (loop: LoopName): string => `${loop}-blocked`;
/**
 * Applied at merge to both the issue and the pull request. Nothing in this
 * file reads it — attribution is its whole job — but it is derived here with
 * the other two so the family has one home: another loop then needs its name
 * added in one place rather than in prose scattered across `prompt.md`.
 */
export const doneLabelFor = (loop: LoopName): string => `${loop}-done`;

const wipLabels = (): readonly string[] => loopRoster().map(wipLabelFor);
const stuckLabels = (): readonly string[] => loopRoster().map(stuckLabelFor);

const firstPresent = (candidates: readonly string[], labels: Iterable<string>): string | null => {
  const present = labels instanceof Set ? labels : new Set(labels);
  return candidates.find((name) => present.has(name)) ?? null;
};

/**
 * The claim label a ticket carries, or null. It is also the answer to "which
 * loop holds this", which is why every caller renders the label it returns
 * rather than a fixed string.
 */
export const wipLabelOf = (labels: Iterable<string>): string | null =>
  firstPresent(wipLabels(), labels);

/** The stuck label a ticket carries, or null. Same reasoning as `wipLabelOf`. */
export const stuckLabelOf = (labels: Iterable<string>): string | null =>
  firstPresent(stuckLabels(), labels);

/**
 * Where a worktree records which loop it is. Untracked, one lowercase word.
 *
 * Found by walking UP from the working directory, never from this file's own
 * location: `frontier/next.ts` runs the pinned `origin/main` copy of this
 * payload out of a temporary directory, so `import.meta.dirname` is
 * `/tmp/ralph-next-*` on the ordinary path and would look for the identity
 * beside a file that is not in any worktree. The cwd is the operator's, and
 * that is whose identity the claim should carry.
 *
 * Walking up rather than reading `./.ralph/loop-name` is what makes a call
 * from `src/` or `mobile/` resolve the same as one from the root.
 */
export function findLoopNameFile(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  // Bounded by reaching the filesystem root, where `dirname` stops changing.
  for (;;) {
    const candidate = join(dir, ".ralph", "loop-name");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Which loop this process claims for, resolved exactly as `ralph/ralph.sh`
 * resolves it: `RALPH_LOOP_NAME` when set, otherwise `.ralph/loop-name` in
 * this worktree, otherwise the roster's first loop (`ralph`).
 *
 * Reading the file matters because this is also the HAND path. Under the loop
 * the supervisor has already exported the name, but a maintainer running
 * `bun run next -- --take-one` from the second worktree has not — and before
 * the file was consulted here that claim went out as `ralph-wip` from a
 * checkout whose every other mark said `rafa`, which is the single-label
 * collision `.loop-name` exists to prevent.
 *
 * An unrecognised name is refused rather than passed through: claiming under
 * `rafa2-wip` would raise a fence no reader in this file consults, so the
 * other loop would walk straight over the claim. A file that EXISTS but
 * yields nothing — unreadable, a directory, whitespace — is refused for the
 * same reason it is in `ralph.sh`: the fallback is not neutral, it is
 * `ralph`, so defaulting silently would hand the second loop the first one's
 * label at precisely the moment its identity broke.
 */
export function currentLoop(
  env: Record<string, string | undefined> = process.env,
  loopNameFile: string | null = findLoopNameFile(),
  roster: readonly string[] = loopRoster(),
): LoopName {
  const fromEnv = (env.RALPH_LOOP_NAME ?? "").trim();
  let raw = fromEnv;
  let source = "RALPH_LOOP_NAME";
  if (raw === "" && loopNameFile !== null && existsSync(loopNameFile)) {
    source = loopNameFile;
    let contents: string;
    try {
      contents = readFileSync(loopNameFile, "utf8");
    } catch (error) {
      throw new Error(
        `${loopNameFile} exists but could not be read (${(error as Error).message}); ` +
          "fix it or unset it — defaulting would claim under the other loop's label",
      );
    }
    raw = contents.trim();
    if (raw === "") {
      throw new Error(
        `${loopNameFile} is empty; write one of ${roster.join(", ")} or delete the file`,
      );
    }
  }
  // The roster's first loop, never a name this project's fence does not know.
  if (raw === "") return roster[0]!;
  const match = roster.find((name) => name === raw);
  if (match === undefined) {
    throw new Error(`${source} must be one of ${roster.join(", ")}; got '${raw}'`);
  }
  return match;
}
/**
 * Explicit override for a container ticket. Spec parents are normally inferred
 * from the `## Parent` links their children carry, open or closed — that link
 * is written by /to-tickets and cannot drift the way a hand-applied label does.
 * The label is for the one case inference cannot reach: a spec whose tickets
 * have not been written yet, so no child names it.
 */
export const SPEC_LABEL = "spec";

/**
 * `gh` concurrency for the per-ticket fan-outs that remain (the dependency
 * fallback, the stuck-reason read). Low on purpose: four loops share one
 * account, and GitHub's secondary limit counts concurrent requests; at 8 the
 * old per-ticket dependency fan-out tripped it (2026-09-28).
 * `RALPH_FRONTIER_CONCURRENCY`, default 2.
 */
const API_CONCURRENCY = frontierConcurrency();

const TITLE_WIDTH = 64;
const SPEC_TITLE_WIDTH = 60;
const BLOCKER_TITLE_WIDTH = 50;

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  assignees?: { login: string }[];
  /** Who opened it. The triager works only the project owner's own issues. */
  author?: { login: string } | null;
  /** The tail of the thread, oldest first — where a triager's marker lives. */
  comments?: IssueComment[];
  /** The tracker's own parent link (a Linear sub-issue, a Jira parent); `## Parent` prose wins over it. */
  parent?: number | null;
}

export interface BlockerRef {
  number: number;
  state: "open" | "closed";
}

/** An open PR and the issues GitHub says it closes. Drafts included. */
export interface OpenPullRequest {
  number: number;
  closingIssuesReferences: { number: number }[];
  /**
   * Issues the body names with a non-closing keyword (`Part of #n`, `Refs #n`).
   * Kept apart from the closing ones because `closesOnly` in
   * `triage/simulate.ts` reads that field as "closes". They still claim: on
   * 2026-10-21 six PRs opened `Part of #373.` while #373 was split into
   * #381–#386, and every child was offered as READY NOW with its work already
   * in a PR.
   */
  references?: { number: number }[];
}

/**
 * Same-repository issues a PR body names with a non-closing keyword. A bare
 * `#n` in prose and a cross-repo `owner/repo#n` do not count: PR bodies cite
 * issues in passing, and a passing mention must not fence a ticket. Code is
 * skipped for the same reason: a loop PR that quotes an issue's text in a
 * fence or a backtick span (`Part of #373.`) is not part of #373.
 */
export function parseBodyReferences(body: string | null | undefined): number[] {
  const numbers: number[] = [];
  const prose = withoutCode(body);
  const pattern = /\b(?:part of|references|refs?|related to)\s*:?\s*#(\d+)(?![\w/])/gi;
  for (const match of prose.matchAll(pattern)) {
    const number = Number(match[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

export interface Ticket {
  number: number;
  title: string;
  /**
   * The issue body, kept rather than parsed away: the triager's buckets ask
   * questions of the prose itself — how many acceptance criteria it carries,
   * which platforms it names, and whether a triage marker still matches it.
   */
  body: string;
  /** Who opened the issue; null when the census did not say. */
  author: string | null;
  /** The tail of the thread, oldest first. Empty when the census did not carry it. */
  comments: IssueComment[];
  labels: Set<string>;
  /** A claim: `ralph/prompt.md` treats an assignee as "someone already has this". */
  assignees: string[];
  /**
   * The open pull request that closes this ticket, if any. A second claim
   * signal alongside the label and the assignee, and the one that covers the
   * window a loop opens by clearing its `<loop>-wip` label when it opens the
   * PR — a window that spans every shepherdable PR, and is widest for the
   * ones that sit longest.
   *
   * A PR that closes or references a spec also claims the spec's children
   * that have no PR of their own: on 2026-10-21 the triager split #373 into
   * children while PRs `Part of #373.` already carried their work, and the
   * children were offered to loops as free.
   */
  openPullRequest: number | null;
  /**
   * A recent `<loop>/<n>-*` branch with commits ahead of the base, if any:
   * the claim that survives a lost `<loop>-wip` label (#480). A rate-limit
   * restart can clear the label while the loop's work sits on its branch,
   * unpushed and unmerged; without this the frontier hands the ticket to a
   * second loop. Null once the ticket was handed back on purpose (a stuck
   * label, or a comment after the branch's last commit) — see `buildTickets`.
   */
  liveBranch: string | null;
  parent: number | null;
  /** Optional collision domain within a parent spec. Missing means the whole tree. */
  staffingGroup: string | null;
  /**
   * Why this ticket's metadata cannot be read, or null. A malformed ticket is
   * never offered, and is named in every view so a person or the triager fixes
   * it; the rest of the backlog is read as usual.
   */
  malformed: string | null;
  /** Union of both sources, restricted to blockers that are still open. */
  openBlockers: number[];
  /**
   * Union of both sources, restricted to blockers that have closed. This is
   * the trace a finished slice leaves behind, and the only evidence the tool
   * has that a tree is already in progress.
   */
  closedBlockers: number[];
  /** Prose edges with no matching native dependency — the backfill worklist. */
  proseOnlyBlockers: number[];
}

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;

/** Writes go through here; a write is never retried behind the caller's back. */
const gh = (args: string[]): Promise<string> => run("gh", args);

/** One run's patience with GitHub, shared by every read it makes. */
const retryBudget: RetryBudget = { waitedSeconds: 0 };
const retryDeps = {
  sleep: (seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000)),
  random: Math.random,
};

/**
 * Every read goes through here. A throttled read waits and retries within the
 * run's budget, then fails as `RateLimitedError`, so a caller can say "rate
 * limited, retry later" instead of reporting a broken frontier.
 */
const readGh = (args: string[]): Promise<string> =>
  withRateLimitRetry(() => gh(args), classifyGhFailure, retryDeps, retryPolicy(), retryBudget);

/**
 * The project's tracker, as the frontier reads and claims through it
 * (felipearos/ralph#333). Built once per process, lazily, because the pure
 * paths of this module must not need a project.
 *
 * On GitHub it is the adapter UNPINNED, over this module's own `gh` and
 * rate-limited `readGh`: the argv it runs is exactly what this file ran before
 * the seam, and gh resolves the repo from the checkout as it always has. On
 * Linear or Jira it is the keyed adapter with the host's credential, and the
 * body parsers switch to that tracker's `<KEY>-n` references.
 */
let cachedTracker: Tracker | null = null;
export function frontierTracker(): Tracker {
  if (cachedTracker !== null) return cachedTracker;
  const root = projectRoot();
  const config = loadProjectConfig(root);
  cachedTracker =
    config.tracker.kind === "github"
      ? createGithubTracker({ repo: config.repo, owner: owner(), pinned: false, gh, read: readGh })
      : createTracker(config, { projectId: currentProjectId(root) });
  useReferenceKey(trackerKey(config.tracker));
  return cachedTracker;
}

/**
 * The triager's view of a keyed tracker (felipearos/ralph#396): null on
 * GitHub, otherwise the project's scope label. Read once per process, like
 * the tracker itself, so a pick does not re-read the config per call site.
 */
export interface TriageKeyed {
  scopeLabel: string | null;
}
let cachedKeyed: { value: TriageKeyed | null } | null = null;
export function triageKeyed(): TriageKeyed | null {
  if (cachedKeyed !== null) return cachedKeyed.value;
  const tracker = loadProjectConfig(projectRoot()).tracker;
  cachedKeyed = { value: tracker.kind === "github" ? null : { scopeLabel: tracker.scopeLabel } };
  return cachedKeyed.value;
}

/**
 * Tests only: the tracker the frontier uses, the key its parsers read, and
 * where a keyed tracker's live re-read finds open PRs, and the scope label
 * `triageKeyed` reports for a keyed one. Null puts all back.
 */
export function useFrontierTracker(
  tracker: Tracker | null,
  key: string | null = null,
  pullRequestHeads: (() => Promise<OpenPullRequestHead[]>) | null = null,
  scopeLabel: string | null = null,
): void {
  cachedTracker = tracker;
  // Kept in step with the tracker: a keyed view cached by an earlier test
  // would otherwise outlive the tracker it described. Null re-reads the config.
  cachedKeyed =
    tracker === null ? null : { value: tracker.kind === "github" ? null : { scopeLabel } };
  useReferenceKey(tracker === null ? null : key);
  readHeads = pullRequestHeads ?? readOpenPullRequestHeads;
}

/** `gh api` with `--include`, so a throttled answer carries its headers. Returns the body. */
const readGhApi = async (args: string[]): Promise<string> =>
  parseIncluded(await readGh(["api", "--include", ...args])).body;
/** Only ever asked for paths, never for anything that writes. */
const git = (args: string[]): Promise<string> => run("git", args);

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Extract issue references from one `## Heading` section only. Scoping to the
 * section matters: a ticket body mentioning "#530" in prose elsewhere is not an
 * edge, and treating it as one invents blockers.
 *
 * Issue bodies are written to a template, so their headings match exactly.
 * `ralph/plan.md` is prose a human maintains and its headings carry a trailing
 * gloss (`## Out of scope — never pick`), so `prefix` relaxes the anchor for
 * that caller. It is opt-in because relaxing it for issue bodies would let
 * `## Blocked by something else entirely` answer to `Blocked by`.
 */
export function issueRefsUnderHeading(
  body: string,
  heading: string,
  options: { prefix?: boolean } = {},
): number[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = options.prefix === true ? ".*" : "\\s*";
  const section = body.split(new RegExp(`^##\\s+${escaped}${tail}$`, "im"))[1];
  if (!section) return [];
  const untilNextHeading = section.split(/^##\s+/m)[0] ?? "";
  const refs = [...untilNextHeading.matchAll(referencePattern())].map((match) => Number(match[1]));
  warnForeignKeys(untilNextHeading);
  return [...new Set(refs)];
}

/**
 * The key a Linear or Jira project's references carry (`AND` in `AND-184`), or
 * null on GitHub, where a reference is `#184` alone (felipearos/ralph#333).
 *
 * Module state rather than a parameter because the parsers are called from a
 * dozen places, each holding a body and nothing else; it is set once, by the
 * process that knows the project (`useReferenceKey`), before any body is read.
 *
 * With a key, ONLY `<KEY>-n` is a ticket: in a Linear or Jira body `#73` is a
 * GitHub pull request (AND-184 cites "PR #73"), and reading it as ticket 73
 * would invent a blocker.
 */
let referenceKey: string | null = null;
export function useReferenceKey(key: string | null): void {
  referenceKey = key;
}

const escapeKey = (key: string): string => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function referencePattern(): RegExp {
  return referenceKey === null ? /#(\d+)/g : new RegExp(`\\b${escapeKey(referenceKey)}-(\\d+)\\b`, "g");
}

/**
 * Another key's reference names a ticket this project cannot see, and its
 * number would collide with one of ours, so it is ignored. Said once per
 * reference, on stderr, because a silently dropped blocker promotes a ticket.
 */
const warnedForeign = new Set<string>();
function warnForeignKeys(section: string): void {
  if (referenceKey === null) return;
  for (const [ref, key] of section.matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)) {
    if (key === referenceKey || warnedForeign.has(ref)) continue;
    warnedForeign.add(ref);
    console.error(`next-tasks: ignoring ${ref}: it is not a ${referenceKey} ticket, so this project cannot read it`);
  }
}

export function parseProseBlockers(body: string): number[] {
  return issueRefsUnderHeading(body, "Blocked by");
}

export function parseParent(body: string): number | null {
  return issueRefsUnderHeading(body, "Parent")[0] ?? null;
}

/**
 * Lines a tool appends to an issue body without meaning them as content: an
 * agent's "Generated with" footer and its separator, or a co-author trailer.
 * When `## Staffing group` is the last section they land inside it, and on
 * 2026-10-17 one such footer on loggd#2427 made every frontier call throw.
 */
const GENERATED_FOOTER =
  /^\s*(?:-{3,}|\*{3,}|🤖.*|.*Generated with \[[^\]]+\]\([^)]*\).*|Co-Authored-By:.*)\s*$/i;

export type StaffingGroupReading = { group: string | null; problem: string | null };

/**
 * The staffing group a body names, or why it names none usable.
 *
 * Returned rather than thrown: the frontier reads EVERY open issue for EVERY
 * loop, so a throw here turned one hand-edited ticket into an outage for the
 * whole project. A malformed group now makes only its own ticket unofferable
 * (`classify` holds it out of the queue and the views name it), which is the
 * same safety the throw bought without the blast radius.
 */
export function readStaffingGroup(body: string): StaffingGroupReading {
  const heading = /^##\s+Staffing group\s*$/im.exec(body);
  if (!heading) return { group: null, problem: null };

  const tail = body.slice(heading.index + heading[0].length);
  const section = (tail.split(/^##\s+/m)[0] ?? "").replace(/<!--[\s\S]*?-->/g, "");
  // Footers and blank lines are dropped, but what remains must still be ONE
  // line: two names is an authoring mistake, and picking either would guess a
  // collision domain.
  const value = section
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !GENERATED_FOOTER.test(line))
    .join("\n")
    .trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    return {
      group: null,
      problem: `## Staffing group must contain one lowercase kebab-case name; got ${JSON.stringify(value)}`,
    };
  }
  return { group: value, problem: null };
}

/** The strict form, for callers that author a group and want a malformed one refused. */
export function parseStaffingGroup(body: string): string | null {
  const { group, problem } = readStaffingGroup(body);
  if (problem !== null) throw new Error(problem);
  return group;
}

/** One ticket's native blockers over REST, for a ticket the census page truncated (`classifyDependencyFailure`). */
async function nativeBlockers(number: number): Promise<BlockerRef[]> {
  try {
    const raw = await readGhApi([
      `repos/{owner}/{repo}/issues/${number}/dependencies/blocked_by`,
      "--jq",
      "[.[] | {number, state}]",
    ]);
    return JSON.parse(raw || "[]") as BlockerRef[];
  } catch (error) {
    if (isRateLimited(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (classifyDependencyFailure(message) === "no-dependency-data") return [];
    throw new Error(`could not read dependencies for #${number}: ${message}`);
  }
}

/** Transitive count of tickets that closing `number` eventually frees. */
export function unblockingPower(
  number: number,
  dependents: Map<number, number[]>,
): number {
  const seen = new Set<number>();
  const queue = [...(dependents.get(number) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(dependents.get(next) ?? []));
  }
  return seen.size;
}

export function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`;
}

/**
 * The branch a ticket's claim rests on, or null when the issue records a
 * deliberate hand-back since the branch's last commit.
 *
 * The label lost in a restart leaves the branch as the last word on the
 * ticket, while every deliberate hand-back the issue records — the coder's
 * stuck label and block record, a triager's decision, an operator's
 * `### Operator decision` — speaks after the last commit. Fencing those would
 * hide a parked ticket from the triager's rescue bucket and let it occlude its
 * staffing group. Only those comments count: a question, a bot's note or the
 * coder's own progress comment is not a hand-back, and letting one release
 * the branch would reopen the very race the claim closes. A Release or an
 * abandoned branch leaves no such trace; that gap is known, and the age window
 * (`branchClaimMaxAgeMs`) bounds it. A comment without a readable time says
 * nothing about order, so it releases nothing.
 */
function liveBranchOf(
  claim: BranchClaim | undefined,
  labels: ReadonlySet<string>,
  comments: readonly IssueComment[],
): string | null {
  if (claim === undefined || stuckLabelOf(labels) !== null) return null;
  const handedBack = comments.some((comment) => {
    const at = comment.createdAt === undefined ? Number.NaN : Date.parse(comment.createdAt);
    return Number.isFinite(at) && at > claim.tipMs && isHandBack(comment);
  });
  return handedBack ? null : claim.branch;
}

/** A comment that gives a ticket back: a block record, a triage decision or an operator's decision. */
const isHandBack = (comment: IssueComment): boolean =>
  blockReasonOf(comment) !== null ||
  triageMarkerOf(comment) !== null ||
  /^\s*###\s+Operator decision\b/m.test(comment.body);

/**
 * Fold raw issues into the ticket graph. Pure, so the edge logic — the part
 * where a wrong parse silently invents or drops a blocker — is testable
 * without touching the network.
 */
export function buildTickets(
  raw: RawIssue[],
  nativesByIndex: BlockerRef[][],
  closedNumbers = new Set<number>(),
  openPullRequests: OpenPullRequest[] = [],
  branchClaims: ReadonlyMap<number, BranchClaim> = new Map(),
): Map<number, Ticket> {
  const openNumbers = new Set(raw.map((i) => i.number));
  const tickets = new Map<number, Ticket>();

  // The lowest open PR number wins when two claim the same issue, so the
  // value is stable across calls rather than dependent on the order GitHub
  // happened to return.
  const prByIssue = new Map<number, number>();
  for (const pr of openPullRequests) {
    for (const ref of [...pr.closingIssuesReferences, ...(pr.references ?? [])]) {
      const existing = prByIssue.get(ref.number);
      if (existing === undefined || pr.number < existing) prByIssue.set(ref.number, pr.number);
    }
  }

  raw.forEach((issue, index) => {
    const body = issue.body ?? "";
    const labels = new Set(issue.labels.map((l) => l.name));
    const prose = parseProseBlockers(body);
    const staffing = readStaffingGroup(body);
    const native = nativesByIndex[index] ?? [];
    const nativeNumbers = new Set(native.map((b) => b.number));

    // Three states, not two. "Absent from the open set" is not evidence of
    // closure: a prose ref can point at a pull request, a deleted issue, or a
    // typo. Those gate nothing, but they are not progress either, and counting
    // them as progress would let a typo promote a tree that never started.
    const states = new Map<number, "open" | "closed" | "unknown">();
    for (const blocker of native) states.set(blocker.number, blocker.state);
    for (const number of prose) {
      if (states.has(number)) continue;
      if (openNumbers.has(number)) states.set(number, "open");
      else states.set(number, closedNumbers.has(number) ? "closed" : "unknown");
    }

    const openBlockers: number[] = [];
    const closedBlockers: number[] = [];
    for (const [number, state] of states) {
      if (state === "open") openBlockers.push(number);
      else if (state === "closed") closedBlockers.push(number);
    }

    tickets.set(issue.number, {
      number: issue.number,
      title: issue.title,
      body,
      author: issue.author?.login ?? null,
      comments: issue.comments ?? [],
      labels,
      assignees: (issue.assignees ?? []).map((a) => a.login),
      openPullRequest: prByIssue.get(issue.number) ?? null,
      liveBranch: liveBranchOf(branchClaims.get(issue.number), labels, issue.comments ?? []),
      parent: parseParent(body) ?? issue.parent ?? null,
      staffingGroup: staffing.group,
      malformed: staffing.problem,
      openBlockers: openBlockers.sort((a, b) => a - b),
      closedBlockers: closedBlockers.sort((a, b) => a - b),
      proseOnlyBlockers: prose.filter(
        (n) => openNumbers.has(n) && !nativeNumbers.has(n),
      ),
    });
  });

  // A child inherits its parent's PR only when it has none of its own, and
  // only from the PR that names the parent directly — one level, so a spec's
  // PR does not reach into a child spec's own children.
  for (const ticket of tickets.values()) {
    if (ticket.openPullRequest !== null || ticket.parent === null) continue;
    ticket.openPullRequest = prByIssue.get(ticket.parent) ?? null;
  }

  return tickets;
}

export function buildDependents(tickets: Map<number, Ticket>): Map<number, number[]> {
  const dependents = new Map<number, number[]>();
  for (const ticket of tickets.values()) {
    for (const blocker of ticket.openBlockers) {
      const existing = dependents.get(blocker);
      if (existing) existing.push(ticket.number);
      else dependents.set(blocker, [ticket.number]);
    }
  }
  return dependents;
}

/** One independently staffable group's READY NOW ticket, plus its spec header. */
export interface ReadyGroup {
  parent: number | null;
  staffingGroup: string | null;
  members: Ticket[];
}

/**
 * The frontier, bucketed. Split out of `render` so the claim step and the
 * printed output cannot disagree about which tickets are ready: both read the
 * same buckets, rather than each deciding readiness for itself.
 */
export interface Frontier {
  readyTasks: Ticket[];
  specs: Ticket[];
  orderedGroups: ReadyGroup[];
  occluded: Ticket[];
  inFlight: Ticket[];
  blocked: Ticket[];
  occupiedByTicket: Map<number, Ticket>;
  /** Children ever written, open and closed — what makes a ticket a container. */
  childCensus: Map<number, number>;
  dependents: Map<number, number[]>;
  /**
   * Every open ticket somebody already holds — a live `<loop>-wip`, an
   * assignee, an open closing PR, or a live loop branch. Published rather
   * than recomputed because the answer costs a lease-store read, and a second
   * definition of "already held" is a second chance for the two to disagree.
   */
  claimed: Set<number>;
  /**
   * Every open ticket that is a container rather than work: it has children, or
   * it carries the `spec` label. The triager's staffing bucket claims one of
   * these, so it needs the same test `classify` staffs by.
   */
  containers: Set<number>;
  /**
   * Trees holding a non-spec child with no `## Staffing group` — the ones
   * `classify` keeps at their conservative parent-wide collision domain, so
   * their siblings sit in OCCUPIED behind work they do not touch. Published
   * because it is the triager's staffing bucket, and deriving it a second time
   * is how the bucket and the behaviour it exists to fix drift apart.
   */
  ungroupedTrees: Set<number>;
  /** Open tickets whose metadata cannot be read (`Ticket.malformed`): never offered. */
  malformed: Ticket[];
}

/** A ticket with no parent is its own tree, not a member of a shared bucket. */
export const treeOf = (t: Ticket): number => t.parent ?? t.number;

/**
 * One reading of the label inside the frontier. Every site that asks calls
 * this: both sorts in `classify`, the `--json` report, both terminal views
 * (`render` and `renderTree`) and the claim walk's `named()`. A second reading
 * is a second chance for the order a loop is handed and the order a person is
 * shown to disagree.
 */
export const isUrgent = (t: Ticket): boolean => t.labels.has(URGENT_LABEL);

/** Missing metadata retains the conservative, parent-wide collision domain. */
export const staffingKeyOf = (t: Ticket): string => {
  if (t.parent === null) return `ticket:${t.number}`;
  return t.staffingGroup === null
    ? `tree:${t.parent}`
    : `tree:${t.parent}:group:${t.staffingGroup}`;
};

export function classify(
  tickets: Map<number, Ticket>,
  /**
   * `## Parent` targets named by CLOSED issues — the rest of the census.
   * Required, with no default: omitting it makes a spec whose children have all
   * merged look staffable, and this tool assigns what it calls staffable, so
   * the mistake would write to the tracker rather than merely misprint.
   */
  closedChildParents: number[],
): Frontier {
  const dependents = buildDependents(tickets);
  const all = [...tickets.values()];
  const leases = readLeaseStore(leasePathFromGit()).leases;

  // A ticket is claimed by any loop's `-wip` OR by a GitHub assignee OR by an
  // open PR that closes or references it or its parent: `ralph/prompt.md` treats an assignee as another
  // agent or Felipe already holding it, so offering it again is how two workers
  // land on one ticket. The PR claim is not leased — a loop clears its
  // `<loop>-wip` label when it opens the PR, so the PR is what fences the
  // ticket from "PR opened" until "PR merged". A live loop branch ahead of the
  // base is a claim too (#480): it is what remains when a restart clears the
  // `-wip` label mid-ticket. It is not leased either — its own age window
  // (`branchClaimMaxAgeMs`) is what lets an abandoned branch go.
  const isClaimed = (t: Ticket): boolean =>
    (wipLabelOf(t.labels) !== null &&
      (leases[String(t.number)] === undefined ||
        leaseStatus(leases[String(t.number)]!, { nowMs: Date.now() }) !== "expired")) ||
    t.assignees.length > 0 ||
    t.openPullRequest !== null ||
    t.liveBranch !== null;

  // Computed over EVERY open issue, not just the queue: a ticket whose queue
  // label is dropped on claim must still show rather than disappear.
  // Claimed AND actually startable. A claimed ticket with open blockers is not
  // in flight, it is blocked — and it belongs in BLOCKED, where the chain that
  // depends on it stays legible.
  const inFlight = all.filter((t) => isClaimed(t) && t.openBlockers.length === 0);
  // `<loop>-blocked` keeps `ready-for-agent` (ralph/prompt.md), so a stuck
  // ticket would otherwise be advertised as ready with only a tag to say
  // otherwise. Known-stuck is not ready.
  const queued = all.filter(
    (t) => t.labels.has(READY_LABEL) && stuckLabelOf(t.labels) === null && t.malformed === null,
  );
  // Held out of the queue rather than read as best we can: a ticket whose
  // collision domain cannot be read could overlap any sibling. Published so
  // every view names it, which is what gets it fixed.
  const malformed = all.filter((t) => t.malformed !== null).sort((a, b) => a.number - b.number);
  const readyQueued = queued.filter((t) => !isClaimed(t) && t.openBlockers.length === 0);
  // Claimed tickets stay here: a claim does not close a blocking edge, and
  // dropping them would hide the middle of a chain.
  const blocked = queued.filter((t) => t.openBlockers.length > 0);

  // Closed children count. A spec whose slices have all merged still is not
  // work — and inferring only from OPEN children would let it silently become
  // staffable again at exactly the moment it looks finished.
  const childCensus = new Map<number, number>();
  const countChild = (parent: number | null): void => {
    if (parent === null) return;
    childCensus.set(parent, (childCensus.get(parent) ?? 0) + 1);
  };
  for (const ticket of all) countChild(ticket.parent);
  for (const parent of closedChildParents) countChild(parent);

  // A spec parent is a container, not work: implementing the spec IS
  // implementing its children, so printing both means staffing an agent
  // against itself. Inferred from the links the children already carry, with
  // SPEC_LABEL as the override for a spec that has no children at all.
  const isSpec = (t: Ticket): boolean =>
    (childCensus.get(t.number) ?? 0) > 0 || t.labels.has(SPEC_LABEL);

  // A partially annotated tree is more dangerous than an entirely legacy one:
  // treating its named children as independent could overlap them with a child
  // whose collision domain remains unknown. Keep the whole tree conservative
  // until every non-spec child carries explicit metadata.
  const legacyTrees = new Set(
    all
      .filter(
        (ticket) =>
          !isSpec(ticket) && ticket.parent !== null && ticket.staffingGroup === null,
      )
      .map(treeOf),
  );
  const staffingKeyFor = (ticket: Ticket): string =>
    legacyTrees.has(treeOf(ticket)) ? `tree:${treeOf(ticket)}` : staffingKeyOf(ticket);

  // One ticket per staffing group is the whole staffing rule. Tickets without
  // explicit metadata retain the conservative parent-wide behavior. A claimed
  // SPEC deliberately holds every group in its tree: whoever took the
  // container is implementing the children.
  const claimedSpecs = new Map<number, Ticket>();
  const claimedGroups = new Map<string, Ticket>();
  for (const ticket of all.filter(isClaimed)) {
    if (isSpec(ticket)) claimedSpecs.set(ticket.number, ticket);
    else claimedGroups.set(staffingKeyFor(ticket), ticket);
  }

  // Kept and rendered rather than dropped: a queued spec that silently vanished
  // would be indistinguishable from one nobody wrote.
  const specs = readyQueued.filter(isSpec);
  const staffable = readyQueued.filter((t) => !isSpec(t));

  // A header only makes sense where something actually names this as parent;
  // a standalone ticket is its own tree but needs no title above it.
  const headerParents = new Set(
    staffable.map((t) => t.parent).filter((n): n is number => n !== null),
  );

  const occupiedByTicket = new Map<number, Ticket>();
  const holderOf = (ticket: Ticket): Ticket | undefined =>
    claimedSpecs.get(treeOf(ticket)) ?? claimedGroups.get(staffingKeyFor(ticket));
  for (const ticket of staffable) {
    const holder = holderOf(ticket);
    if (holder) occupiedByTicket.set(ticket.number, holder);
  }
  const occluded = staffable.filter((t) => occupiedByTicket.has(t.number));
  const free = staffable.filter((t) => !occupiedByTicket.has(t.number));

  // A ticket with no parent is its own tree, not a member of one shared
  // "unparented" bucket — two standalone tickets are independently staffable,
  // and lumping them together both undercounts the trees and hides the
  // ordering between them.
  const byStaffingGroup = new Map<string, Ticket[]>();
  for (const ticket of free) {
    const key = staffingKeyFor(ticket);
    const existing = byStaffingGroup.get(key);
    if (existing) existing.push(ticket);
    else byStaffingGroup.set(key, [ticket]);
  }

  // One per staffing group, enforced rather than advised, because READY NOW has
  // to mean "start an agent on every line, in parallel, right now". Siblings
  // within one group are unblocked, not collision-free: they share a domain
  // surface and often a single file. The pick is the sibling that frees the
  // most downstream work; ties go to the lower number, so an authored batch
  // order survives.
  // Urgency outranks that, and the price is real rather than a round's delay:
  // losing the pick IS being OCCUPIED (below), from this call and not from the
  // claim, so a sibling that frees more work waits for as long as the urgent
  // ticket remains its group's pick — until it is claimed and merged, or drops
  // out of the queue. Even an urgent ticket nobody takes holds it. Accepted
  // deliberately: the lane exists for a broken base branch, where nothing
  // downstream is worth starting first.
  const pickFor = (members: Ticket[]): Ticket =>
    [...members].sort((a, b) => {
      const urgent = Number(isUrgent(b)) - Number(isUrgent(a));
      if (urgent !== 0) return urgent;
      const power =
        unblockingPower(b.number, dependents) - unblockingPower(a.number, dependents);
      return power !== 0 ? power : a.number - b.number;
    })[0]!;

  const readyTasks: Ticket[] = [];
  const groups: ReadyGroup[] = [];
  for (const members of byStaffingGroup.values()) {
    const pick = pickFor(members);
    readyTasks.push(pick);
    // Losing to the pick is exactly the OCCUPIED contract: unblocked, but the
    // staffing group now has its one ticket.
    for (const sibling of members) {
      if (sibling.number !== pick.number) {
        occluded.push(sibling);
        occupiedByTicket.set(sibling.number, pick);
      }
    }
    groups.push({
      parent: pick.parent !== null && headerParents.has(pick.parent) ? pick.parent : null,
      staffingGroup: legacyTrees.has(treeOf(pick)) ? null : pick.staffingGroup,
      members: [pick],
    });
  }

  const hasProgress = (members: Ticket[]): boolean =>
    members.some((m) => m.closedBlockers.length > 0);

  // A group offering an urgent ticket leads, ahead of progress: `takeOne` walks
  // this order and hands over the first candidate it can claim. First here is
  // offered first WITHIN what the asking loop may take — `roleUnits` filters
  // this order through `routeByDifficulty` afterwards, so on a Jav-routed
  // project an urgent ticket whose difficulty label the loop does not carry is
  // not offered to it at all — some other loop takes that one. An urgent ticket
  // carrying no difficulty label at all is offered to every loop that takes
  // anything, because routing exempts it rather than stranding it
  // (`ROUTING_EXEMPT_LABELS`, felipearos/ralph#233). Among urgent groups the
  // existing keys decide, which keeps the lane a reordering rather than a
  // second ranking.
  // `some` rather than the pick itself: a group holds exactly one ticket today
  // (`members: [pick]`, below), so the two coincide — and if a group ever
  // carries more, leading on any urgent member is the reading that matches
  // what the lane is for.
  const isUrgentGroup = (members: Ticket[]): boolean => members.some(isUrgent);

  const orderedGroups = groups.sort((a, b) => {
    const urgent = Number(isUrgentGroup(b.members)) - Number(isUrgentGroup(a.members));
    if (urgent !== 0) return urgent;
    const progress = Number(hasProgress(b.members)) - Number(hasProgress(a.members));
    if (progress !== 0) return progress;
    const power =
      Math.max(...b.members.map((t) => unblockingPower(t.number, dependents))) -
      Math.max(...a.members.map((t) => unblockingPower(t.number, dependents)));
    if (power !== 0) return power;
    return (
      Math.min(...a.members.map((t) => t.number)) -
      Math.min(...b.members.map((t) => t.number))
    );
  });

  return {
    readyTasks,
    specs,
    orderedGroups,
    occluded,
    inFlight,
    blocked,
    occupiedByTicket,
    childCensus,
    dependents,
    claimed: new Set(all.filter(isClaimed).map((t) => t.number)),
    containers: new Set(all.filter(isSpec).map((t) => t.number)),
    ungroupedTrees: legacyTrees,
    malformed,
  };
}

/**
 * The tickets difficulty routing strands: queued, unclaimed, not stuck, not a
 * spec and not blocked — READY NOW or OCCUPIED — yet carrying none of the
 * project's Jav labels. With Jav on, no loop's route matches them, so no loop
 * takes them until a triager labels them.
 *
 * A `ROUTING_EXEMPT_LABELS` ticket is not stranded and so is not here: routing
 * keeps it for every loop already (`jav.ts`), so offering it to the triager to
 * be labelled would ask for a difficulty nobody is waiting on — and for the
 * ci-doctor's regression filings, which is what those labels mark, a difficulty
 * is not knowable in the first place.
 *
 * A view over the frontier rather than a bucket carved out of it: each ticket
 * also stays where `classify` put it. Nothing here feeds `takeOneCandidates` or
 * the bulk claim, so what a CODER picks is exactly what it picked before; it is
 * the triager's intake, reached only through `roleUnits`. No labels
 * configured means nothing is untriaged, and the report is as it was.
 */
export function untriagedTickets(frontier: Frontier, javLabels: readonly string[]): Ticket[] {
  if (javLabels.length === 0) return [];
  return [...frontier.readyTasks, ...frontier.occluded]
    .filter((t) => !isRoutingExempt(t.labels) && !javLabels.some((label) => t.labels.has(label)))
    .sort((a, b) => a.number - b.number);
}

/* ------------------------------------------------- the triager's intake */

/**
 * A triager's work is not "one ticket" the way a coder's is. Routing a backlog
 * is a hundred small label writes, and handing them over one poll at a time
 * would spend an iteration's whole context on GitHub round trips; staffing a
 * tree is one write against a container that is not itself work. So the intake
 * hands over a UNIT — a bucket, and the tickets that unit holds — and the claim
 * fence, the label and the lease stay exactly the coder's.
 */
export const TRIAGE_BUCKETS = ["staffing", "routing", "intake", "oversize", "rescue"] as const;
export type TriageBucket = (typeof TRIAGE_BUCKETS)[number];

/** Which intake a unit came from. `ready` is the coder's, one ticket at a time. */
export type UnitBucket = "ready" | TriageBucket;

export interface FrontierUnit {
  bucket: UnitBucket;
  /** Every ticket the unit claims. One, except for a triager's routing batch. */
  tickets: Ticket[];
}

/**
 * The labels that say an issue has been through triage. An issue carrying none
 * of them has never been looked at, which is the intake bucket's whole
 * definition — so this list IS the triager's contract, and adding a state
 * label without adding it here would quietly re-open every issue that carries
 * only the new one.
 */
export const TRIAGE_STATE_LABELS = [
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  SPEC_LABEL,
] as const;

/** The explicit request for triage, which outranks any state label already on the issue. */
const NEEDS_TRIAGE_LABEL = "needs-triage";

/**
 * Why a ticket waits on the operator rather than on a loop. The backlog draws
 * these apart from agent work so a person can see at a glance what is theirs:
 *
 * - `ready-for-human` — triaged as a person's job (a migration, host config, a
 *   decision).
 * - `needs-info` — waiting on an answer from whoever filed it.
 * - `held` — listed under `plan.md`'s `## Out of scope`. The frontier gate
 *   fences these off every loop, so a held ticket can sit at READY NOW in the
 *   picture while the loops call the frontier empty; lifting the hold is the
 *   operator's call.
 * - `untriaged` — no triage state yet, and no triager on the roster to give it
 *   one, so it waits for a person to label it.
 */
export const HUMAN_REASONS = ["ready-for-human", "needs-info", "held", "untriaged"] as const;
export type HumanReason = (typeof HUMAN_REASONS)[number];

/**
 * The reason a ticket is the operator's, or null when it is agent work (or a
 * container, which is nobody's). A `<loop>-blocked` ticket is left to the
 * stuck view, which already says it needs a person and why; a claimed one —
 * label, assignee, open PR or live loop branch — is somebody's already.
 */
export function humanReason(
  ticket: Ticket,
  options: { held: ReadonlySet<number>; triager: boolean; container: boolean },
): HumanReason | null {
  const claimed =
    wipLabelOf(ticket.labels) !== null ||
    ticket.assignees.length > 0 ||
    ticket.openPullRequest !== null ||
    ticket.liveBranch !== null;
  if (options.container || claimed || stuckLabelOf(ticket.labels) !== null) return null;
  if (ticket.labels.has("ready-for-human")) return "ready-for-human";
  if (ticket.labels.has("needs-info")) return "needs-info";
  if (options.held.has(ticket.number)) return "held";
  const untriaged =
    ticket.labels.has(NEEDS_TRIAGE_LABEL) || !TRIAGE_STATE_LABELS.some((label) => ticket.labels.has(label));
  return untriaged && !options.triager ? "untriaged" : null;
}

/**
 * The project's base branch: `RALPH_BASE_BRANCH`, else the config's, else
 * "main". Never throws — the readers that need it degrade, they do not fail
 * the census.
 */
function resolveBaseBranch(root: string): string {
  const fromEnv = process.env.RALPH_BASE_BRANCH?.trim();
  if (fromEnv) return fromEnv;
  try {
    return loadProjectConfig(root).baseBranch;
  } catch {
    return "main";
  }
}

/** An open issue, as far as the maintenance probe is concerned. */
export interface OpenIssue {
  number: number;
  body: string | null;
  /** The tracker's own parent link, on Linear or Jira; prose wins over it. */
  parent?: number | null;
  /**
   * Optional so a caller that never read them (the gate's probe) keeps its
   * old answer: absent means "not held", as before #810.
   */
  labels?: readonly string[];
  assignees?: readonly string[];
}

/**
 * The two lists `ralph/plan.md` carries. They are the only durable local input
 * to selection, and the gate has to read them for the same reason the
 * iteration does — a gate that predicted work the iteration would refuse, or
 * refused work the iteration would take, is worse than no gate.
 */
export interface PlanFences {
  /** `## Out of scope` — passed to the frontier as `--exclude`, as §1 does. */
  outOfScope: number[];
  /** `## Parent closure exceptions` — closing one is a valid maintenance task. */
  closureParents: number[];
}

/**
 * Both lists, read with the frontier tool's own section parser rather than a
 * second one — the gate and the iteration have to agree about what `plan.md`
 * says, and two parsers is how they stop agreeing. `prefix` because the plan's
 * headings carry a human gloss (`## Out of scope — never pick`).
 */
export function parsePlanFences(markdown: string): PlanFences {
  return {
    outOfScope: issueRefsUnderHeading(markdown, "Out of scope", { prefix: true }),
    closureParents: issueRefsUnderHeading(markdown, "Parent closure exceptions", {
      prefix: true,
    }),
  };
}

/**
 * A spec from `plan.md`'s closure list that is open and has no open children
 * left. `prompt.md` §1 makes closing one an iteration's task when the frontier
 * comes back empty — so without this probe a gated supervisor would park on
 * "the frontier is empty" while an iteration would have had real work, which
 * is a stall the ungated supervisor never had.
 */
export function closableParent(parents: number[], open: OpenIssue[]): number | null {
  // Parenthood is read from `## Parent` prose only, the same edge `plan.md`'s
  // specs are actually written with. A child linked only as a native sub-issue
  // would be invisible here, so a spec could read as closable while children
  // are open — a false positive costing one iteration, never a stall.
  const openNumbers = new Set(open.map((issue) => issue.number));
  const stillParented = new Set(
    open
      .map((issue) => parseParent(issue.body ?? "") ?? issue.parent ?? null)
      .filter((parent): parent is number => parent !== null),
  );
  // A parent some loop already holds (#810): `--take-one` now offers a closure
  // as a claimed unit, so one carrying a loop's `-wip` or `-blocked` label, or
  // assigned to anyone, is somebody's work and offering it again is the race
  // two loops ran on it. Never throws: an unreadable roster means "not held",
  // which is the answer this function gave before it read labels at all.
  const held = new Set(
    open
      .filter((issue) => {
        if ((issue.assignees ?? []).length > 0) return true;
        const labels = issue.labels ?? [];
        if (labels.length === 0) return false;
        try {
          return wipLabelOf(labels) !== null || stuckLabelOf(labels) !== null;
        } catch {
          return false;
        }
      })
      .map((issue) => issue.number),
  );
  return parents.find((n) => openNumbers.has(n) && !stillParented.has(n) && !held.has(n)) ?? null;
}

/**
 * Both of the plan's fences, read the way the frontier gate reads them: out of
 * `origin/<baseBranch>` first, since that is every loop's view, then the
 * working tree, then nothing. Never throws — an unreadable plan fences nothing
 * rather than stalling.
 */
export async function readProjectPlanFences(root: string = projectRoot()): Promise<PlanFences> {
  const baseBranch = resolveBaseBranch(root);
  let plan = process.env.RALPH_PLAN?.trim() || ".ralph/plan.md";
  try {
    plan = process.env.RALPH_PLAN?.trim() || loadProjectConfig(root).plan;
  } catch {
    // An unreadable config holds nothing back from the picture; preflight is
    // what refuses it.
  }
  try {
    const shown = await run("git", ["-C", root, "show", `origin/${baseBranch}:${plan}`]);
    if (shown.trim() !== "") return parsePlanFences(shown);
  } catch {
    // No ref or no repo: fall through to the checkout.
  }
  try {
    return parsePlanFences(readFileSync(join(root, plan), "utf8"));
  } catch {
    return { outOfScope: [], closureParents: [] };
  }
}

/**
 * The `## Out of scope` list from the project's plan (`readProjectPlanFences`).
 * Only the pictures (`--tree`, `--json`) call this; a claim is fenced by the
 * caller's own `--exclude`, exactly as before.
 */
export async function readPlanHolds(root: string = projectRoot()): Promise<Set<number>> {
  return new Set((await readProjectPlanFences(root)).outOfScope);
}

/**
 * A knob that will not parse takes the default rather than throwing. This runs
 * inside the claim path, and refusing to hand over work because somebody typed
 * `eight` is a worse failure than quietly using 8.
 */
const positiveEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** How many routing tickets one unit claims. `RALPH_TRIAGE_ROUTE_BATCH`, default 10. */
export const routeBatch = (): number => positiveEnv("RALPH_TRIAGE_ROUTE_BATCH", 10);

/**
 * How long a rescued ticket stays out of the rescue bucket, in days.
 * `RALPH_TRIAGE_UNBLOCK_DAYS`, default 7. The same knob `triage/validate.ts`
 * reads for the `unblock` op, so the bucket does not offer what the op refuses.
 */
export const unblockDays = (): number => positiveEnv("RALPH_TRIAGE_UNBLOCK_DAYS", DEFAULT_UNBLOCK_DAYS);

/**
 * When a ticket is too big for one agent. Thresholds rather than judgement,
 * because the frontier only decides whether to OFFER the ticket — the triager's
 * `TRIAGER_SPLIT` fragment carries the prose it actually splits by, and it is
 * free to leave a ticket whole. Being offered one that does not need splitting
 * costs a marker; missing one costs a ticket no agent can finish.
 */
const splitThresholds = (): { criteria: number; surfaces: number } => ({
  criteria: positiveEnv("RALPH_TRIAGE_SPLIT_CRITERIA", 8),
  surfaces: positiveEnv("RALPH_TRIAGE_SPLIT_SURFACES", 3),
});

const CHECKBOX = /^\s*[-*]\s*\[[ xX]\]/gm;
const SURFACES: Readonly<Record<string, RegExp>> = {
  web: /\bweb\b|\bbrowser\b/i,
  mobile: /\bmobile\b|\bios\b|\bandroid\b/i,
  api: /\bapi\b|\bendpoint\b|\bserver\b/i,
  db: /\bdatabase\b|\bschema\b|\bmigration\b/i,
};

/** Whether the body asks for more than one agent can carry. */
function isOversize(body: string, thresholds = splitThresholds()): boolean {
  const criteria = (sectionUnderHeading(body, "Acceptance criteria").match(CHECKBOX) ?? []).length;
  if (criteria > thresholds.criteria) return true;
  const named = Object.values(SURFACES).filter((pattern) => pattern.test(body)).length;
  return named >= thresholds.surfaces;
}

/**
 * The text under one `##` heading. A body with no such heading answers with the
 * WHOLE body, where `issueRefsUnderHeading` answers with nothing: a ticket that
 * lists its acceptance criteria without a heading still has them, and counting
 * zero would hide exactly the oversize ticket the bucket is looking for.
 */
function sectionUnderHeading(body: string, heading: string): string {
  return sectionIfPresent(body, heading) ?? body;
}

/**
 * Whether the triager may look at this ticket at all, whichever bucket found
 * it. Every exclusion here is "somebody else's call, or a call already made":
 * a claim (a coder's, another triager's, a person's), a plan fence, an issue
 * this project does not own, a decision still current, or two attempts that
 * ended in giving up.
 *
 * A `<loop>-blocked` of ANY loop counts, the triager's own included, in every
 * bucket but one. A coder's block is a ticket waiting on a person, and
 * re-triaging it would paper over that — so the only bucket that may see one is
 * `rescue`, whose whole subject is lifting it, and which passes `blocked`.
 * Nothing else about eligibility is relaxed there: a claim, an assignee, an
 * open PR, a plan fence and a spent triage still exclude.
 *
 * `hasCurrentTriage` is kept for rescue too, and that is deliberate rather than
 * incidental: a triager that has just looked at this ticket AS IT STANDS has
 * already decided, and a block it chose to leave is a decision like any other.
 */
function triagerEligible(
  ticket: Ticket,
  frontier: Frontier,
  options: { excluded: Set<number>; owner: string; blocked?: boolean; skipAuthor?: boolean },
): boolean {
  if (options.excluded.has(ticket.number)) return false;
  if (frontier.claimed.has(ticket.number)) return false;
  if (options.blocked !== true && stuckLabelOf(ticket.labels) !== null) return false;
  // Fails CLOSED on an unknown author: GitHub returns null for a deleted
  // account, which is certainly not the owner, and the one issue whose
  // provenance cannot be read is the last one to hand a triager. Skipped on a
  // keyed tracker, where an author is a Linear/Jira user and never the GitHub
  // owner: there the `slack-intake` and scope labels are the provenance fence.
  if (options.skipAuthor !== true && ticket.author !== options.owner) return false;
  if (triageGaveUp(ticket.comments)) return false;
  return !hasCurrentTriage(ticket.body, ticket.comments);
}

const byNumber = (a: Ticket, b: Ticket): number => a.number - b.number;

const chunk = (tickets: Ticket[], size: number): Ticket[][] => {
  const out: Ticket[][] = [];
  for (let at = 0; at < tickets.length; at += size) out.push(tickets.slice(at, at + size));
  return out;
};

/**
 * Everything waiting in each of the triager's intake buckets, whether or not
 * the intake would hand it over.
 *
 * Buckets rather than one ranked list because the kinds of triage are not
 * comparable. Staffing leads: an ungrouped tree is the one state that makes
 * coders collide with each other, and every hour it stays that way is an hour
 * of wasted parallelism. Routing is next because with Jav on an unlabelled
 * ticket is invisible to every coder. Intake and oversize are backlog hygiene:
 * real work, but nothing is stalled on them. Rescue is last of all — not
 * because a blocked coder does not matter, but because a rescue is the one
 * bucket whose ticket is ALREADY in front of a person, so it is the only one
 * where waiting an iteration costs nothing that was not already lost.
 *
 * Split out from `triagerUnits`, which returns only the leading bucket: a
 * reader that wants to SEE the backlog (the dashboard's triage panel) needs
 * every population, and computing them twice from two sets of predicates is how
 * the picture and the intake drift apart.
 */
export function triageBuckets(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  options: {
    excluded?: Set<number>;
    /** The project's Jav labels; routing is empty without them, as `untriagedTickets` has it. */
    javLabels?: readonly string[];
    owner?: string;
    /** The roster's coder loops, whose blocks the rescue bucket may lift. */
    coders?: readonly string[];
    /** For the rescue window; the caller's clock so the bucket stays testable. */
    now?: Date;
    /** Set on a Linear/Jira project; absent or null is GitHub. */
    keyed?: TriageKeyed | null;
    /** From `readParks`; a ticket with a live park is withheld from rescue. */
    parks?: ReadonlyMap<number, ListedPark>;
  } = {},
): Record<TriageBucket, Ticket[]> {
  const excluded = options.excluded ?? new Set<number>();
  const all = [...tickets.values()];
  const keyed = options.keyed ?? null;
  if (keyed !== null) {
    // On a keyed tracker the triager does the Slack intake and nothing else:
    // its apply step there accepts only `propose` / `to-person` plans, so any
    // other bucket would hand it a unit it cannot apply. The owner is never
    // read, so a keyed pick needs no GitHub login.
    const eligible = (t: Ticket): boolean =>
      triagerEligible(t, frontier, { excluded, owner: "", skipAuthor: true });
    const intake = all.filter((t) => isUntriagedReport(t.labels, keyed.scopeLabel)).filter(eligible).sort(byNumber);
    return { staffing: [], routing: [], intake, oversize: [], rescue: [] };
  }
  const projectOwner = options.owner ?? owner();
  const eligible = (t: Ticket): boolean => triagerEligible(t, frontier, { excluded, owner: projectOwner });

  // Staffing. A tree with someone already in it and a child carrying no
  // `## Staffing group`: the group is the fence between two coders, and
  // without it the whole tree collapses to one conservative collision
  // domain, so the siblings sit in OCCUPIED behind work they do not touch.
  const occupiedTrees = new Set(frontier.occluded.map(treeOf));
  const staffing = all
    .filter(
      (t) =>
        frontier.containers.has(t.number) &&
        occupiedTrees.has(t.number) &&
        frontier.ungroupedTrees.has(t.number),
    )
    .filter(eligible)
    .sort(byNumber);

  // Routing. `untriagedTickets` is already this bucket's population — ready,
  // unclaimed, not stuck, not a spec, carrying no Jav label and not exempt from
  // routing — so it is used rather than restated, and the two cannot drift.
  const routing = untriagedTickets(frontier, options.javLabels ?? []).filter(eligible).sort(byNumber);

  // Intake. Over EVERY open issue, not the queue: an issue with no state
  // label is precisely one that never reached the queue, and looking only at
  // `ready-for-agent` would make the bucket that catches new issues blind to
  // new issues.
  const intake = all
    .filter(
      (t) =>
        t.labels.has(NEEDS_TRIAGE_LABEL) ||
        !TRIAGE_STATE_LABELS.some((label) => t.labels.has(label)),
    )
    .filter(eligible)
    .sort(byNumber);

  // Oversize. Queued and unclaimed: a ticket nobody has started can still be
  // split without throwing work away.
  const oversize = all
    .filter((t) => t.labels.has(READY_LABEL) && !frontier.containers.has(t.number) && isOversize(t.body))
    .filter(eligible)
    .sort(byNumber);

  // Rescue. A coder gave up on a ready ticket and a person has it; the triager
  // may hand it back once it has re-specified or re-routed it
  // (felipearos/ralph#150). Every narrowing here is one of the `unblock` op's
  // own preconditions, asked through the same two shared predicates —
  // `rescuableBlock` for what kind of block it is, `rescueBar` for whether this
  // ticket is due again — so that the bucket's answer and the op's are decided
  // by the same code rather than by two readings of one rule.
  //
  // They are asked of DIFFERENT EVIDENCE, though, and that is a real gap rather
  // than a tidy equivalence. Here they read `Ticket.comments`, which the census
  // fills with `comments(last: COMMENT_TAIL)`; the op re-reads the thread in
  // full. So a ticket whose rescue markers have scrolled past the tail is
  // offered here and refused there. The cost is one iteration claimed, planned
  // and discarded — never a wrong write, since the op has the full read. Giving
  // the bucket its own full read would mean one `gh` call per candidate inside
  // the claim path, which is precisely the per-issue fan-out that GitHub
  // throttled on 2026-09-28 and that the single GraphQL census replaced.
  //
  // `frontier.claimed` carries the open-PR check, so a block with a draft PR
  // waiting on a person — the migrations hand-off — never reaches here even
  // before its record is read.
  const coders = options.coders ?? coderLoops();
  const blockLabels = coders.map(stuckLabelFor);
  const now = options.now ?? new Date();
  const days = unblockDays();
  const parks = options.parks ?? new Map<number, ListedPark>();
  const rescue = all
    .filter(
      (t) =>
        t.labels.has(READY_LABEL) &&
        !t.labels.has(SPEC_LABEL) &&
        blockLabels.filter((label) => t.labels.has(label)).length === 1 &&
        // No OTHER `-blocked` either. One that is not a coder's is a unit a
        // past iteration put in front of a person, and lifting the coder's
        // half of it would not even free the ticket — the frontier honours the
        // one left behind. The op refuses it too; this keeps the bucket from
        // spending an iteration finding that out.
        ![...t.labels].some((label) => label.endsWith("-blocked") && !blockLabels.includes(label)) &&
        rescuableBlock(latestBlockReason(t.comments)) &&
        rescueBar(t.comments, { now, days }) === null &&
        // A live park (#776) is a wait with a known wake condition that the
        // park probe is already watching; rescuing it would spend a triager
        // iteration re-specifying a ticket that resumes on its own. Once the
        // park expires, escalates or goes stale it is a person's again, and
        // rescue behaves exactly as it did before parks existed.
        !isLivePark(parks.get(t.number), t.labels),
    )
    .filter((t) => triagerEligible(t, frontier, { excluded, owner: projectOwner, blocked: true }))
    .sort(byNumber);

  return { staffing, routing, intake, oversize, rescue };
}

/**
 * The roster's coder loops. Read here rather than passed in by every caller
 * because a bucket that silently had no coders would report an empty rescue
 * backlog, which reads exactly like nothing being blocked.
 */
const coderLoops = (): readonly string[] => loopsWithRole("coder", loopRosterEntries());

/**
 * The units the triager's intake offers, in bucket order: the first non-empty
 * bucket wins outright, and its units are offered oldest issue first. Every
 * population, and the reason each is what it is, lives in `triageBuckets`.
 *
 * Returns EVERY unit of the winning bucket, not just the first, because the
 * claim is a live re-read: the walk needs somewhere to go when another triager
 * took the unit inside the window between the snapshot and the write.
 */
export function triagerUnits(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  options: {
    excluded?: Set<number>;
    /** The project's Jav labels; routing is empty without them, as `untriagedTickets` has it. */
    javLabels?: readonly string[];
    owner?: string;
    batch?: number;
    coders?: readonly string[];
    now?: Date;
    keyed?: TriageKeyed | null;
    parks?: ReadonlyMap<number, ListedPark>;
  } = {},
): FrontierUnit[] {
  const buckets = triageBuckets(tickets, frontier, options);

  if (buckets.staffing.length > 0) return buckets.staffing.map((spec) => ({ bucket: "staffing", tickets: [spec] }));
  if (buckets.routing.length > 0) {
    return chunk(buckets.routing, options.batch ?? routeBatch()).map((batch) => ({ bucket: "routing", tickets: batch }));
  }
  if (buckets.intake.length > 0) return buckets.intake.map((t) => ({ bucket: "intake", tickets: [t] }));
  if (buckets.oversize.length > 0) return buckets.oversize.map((t) => ({ bucket: "oversize", tickets: [t] }));
  return buckets.rescue.map((t) => ({ bucket: "rescue", tickets: [t] }));
}

/**
 * The Jav labels the dry-run report checks tickets against: the project's
 * `labels`, whether or not routing is `enabled`, so the routing backlog is
 * visible before anyone turns Jav on. A missing file is no labels. A broken
 * one is too, with a warning: the report is a picture, and a bad `jav.json`
 * must not take the rest of the frontier down with it (`--take-one` still
 * refuses to route on it).
 */
export function reportJavLabels(
  read: () => JavConfig = () => readJav(javPath(), currentProjectId(projectRoot()), loopRosterEntries()),
  warn: (message: string) => void = (message) => console.error(yellow(message)),
): string[] {
  try {
    return read().labels;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`warning: could not read the Jav labels (${message}); UNTRIAGED is not shown.`);
    return [];
  }
}

/* ------------------------------------------------------------ JSON report */

/** A ticket as the report names it: number and title, nothing a loop could act on. */
export interface ReportTicket {
  number: number;
  title: string;
}

/** One READY NOW staffing group: its spec header and the ticket it offers. */
export interface ReportGroup {
  spec: ReportTicket | null;
  staffingGroup: string | null;
  /** OCCUPIED siblings held back by this group's ready ticket. */
  waiting: number;
  /**
   * `urgent` is present only when it is true — the lane is a no-op for a
   * project with no urgent ticket open, and that has to include this document,
   * not only the order inside it.
   */
  tickets: (ReportTicket & { frees: number; stuck: string | null; urgent?: true })[];
}

/**
 * The frontier as one JSON document — the same buckets `render` prints, in
 * the same order, so a page drawing it and a person reading the terminal see
 * one backlog. Nothing here is a claim: it names loops by their labels and
 * never writes.
 */
export interface FrontierReport {
  ready: ReportGroup[];
  occupied: (ReportTicket & { heldBy: number })[];
  specs: (ReportTicket & { children: number })[];
  inFlight: (ReportTicket & {
    /** The loop whose `-wip` label claims it; null for an assignee or PR claim. */
    loop: string | null;
    /** How the claim shows: the label, `assigned to …`, or `PR #n`. */
    claim: string;
    queued: boolean;
  })[];
  blocked: (ReportTicket & { blockers: number[]; stuck: string | null })[];
  /** Blockers that gate work but are not themselves queued. */
  gates: ReportTicket[];
  stuck: (ReportTicket & { label: string })[];
  /** Open tickets the frontier cannot read and so never offers (`Ticket.malformed`). */
  malformed: (ReportTicket & { problem: string })[];
  /** The same backlog by spec, as `--tree` draws it: `buildTree`'s groups, in its order. */
  tree: TreeGroup[];
  /**
   * Why each ticket carrying a `<loop>-blocked` label is stuck, wherever the
   * buckets above place it: waiting on a person to apply a migration, or
   * anything else. One entry per stuck ticket, `unknown` when its comments
   * held no block record or could not be read.
   */
  stuckReasons: (ReportTicket & BlockReason & { park: ParkReason | null })[];
  /**
   * `untriagedTickets`: ready tickets carrying none of the project's Jav
   * labels, which no loop takes while routing is on — a `ROUTING_EXEMPT_LABELS`
   * ticket excepted, since routing offers that one to every loop already. Each
   * is also in `ready` or `occupied`. Empty when the project lists no Jav
   * labels.
   */
  untriaged: ReportTicket[];
  /**
   * How many units wait in each of the triager's intake buckets, from
   * `triageBuckets`. The intake hands over only the first non-empty bucket, so
   * a non-zero count below the leading one is backlog, not work in hand.
   * `routing` counts the same tickets as `untriaged` after the triager's own
   * eligibility fence, so it is never larger.
   */
  triage: Record<TriageBucket, number>;
  /**
   * Open tickets that wait on the operator rather than a loop, with why — the
   * same `human` the tree's nodes carry, flat, so a reader can list "what is
   * mine" without walking the tree. Specs are never in it.
   */
  human: (ReportTicket & { reason: HumanReason })[];
}

/**
 * Why a stuck ticket waits, when a loop parked it (#776): what it waits on and
 * how long before the park probe gives up on it. A reason beside the block
 * kinds rather than one of them, because the block record and the park are two
 * stores and a ticket can carry both.
 */
export interface ParkReason {
  loop: string;
  label: string;
  pr: number | null;
  summary: string;
  condition: ListedPark["condition"];
  since: string;
  budgetUntil: string;
  /** Whole seconds from the report's clock to `budgetUntil`, never below 0. */
  remainingSeconds: number;
  expired: boolean;
  escalatedAt: string | null;
}

/**
 * The park as the report shows it, or null when there is none or the ticket no
 * longer wears the label it was parked under — a park whose label came off is
 * stale, and showing it would claim a wait nobody is in.
 */
function parkReasonOf(park: ListedPark | undefined, labels: ReadonlySet<string>, now: Date): ParkReason | null {
  if (park === undefined || !labels.has(park.label)) return null;
  const left = Math.floor((Date.parse(park.budgetUntil) - now.getTime()) / 1000);
  return {
    loop: park.loop,
    label: park.label,
    pr: park.pr,
    summary: park.summary,
    condition: park.condition,
    since: park.since,
    budgetUntil: park.budgetUntil,
    remainingSeconds: Number.isFinite(left) ? Math.max(0, left) : 0,
    expired: park.expired,
    escalatedAt: park.escalatedAt,
  };
}

/** A park the probe is still watching: in budget, not escalated, and its label still on the ticket. */
function isLivePark(park: ListedPark | undefined, labels: ReadonlySet<string>): boolean {
  return park !== undefined && !park.expired && park.escalatedAt === null && labels.has(park.label);
}

/**
 * Every park in the project's store, by ticket. Never throws: every loop's
 * census goes through here, so an unreadable store must read as "nothing is
 * parked" — today's behaviour — rather than stop every loop on the project.
 */
export function readParks(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Map<number, ListedPark> {
  try {
    return new Map(listStore(configuredParkStorePath(env, cwd), now.toISOString()).map((park) => [park.ticket, park]));
  } catch {
    return new Map();
  }
}

export function frontierReport(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  closed: ClosedIssue[],
  /** From `readStuckReasons`; a stuck ticket missing here reads as `unknown`. */
  reasons: ReadonlyMap<number, BlockReason> = new Map(),
  /** From `reportJavLabels`; none means `untriaged` is empty. */
  javLabels: readonly string[] = [],
  /**
   * The project's owner, for the triage counts' eligibility fence.
   *
   * A PARAMETER, like `javLabels` above and for the same reason: `owner()`
   * reads the project's config, and this module promises that its pure paths
   * need no project at all. So a programmatic caller can keep this function
   * owner-free by supplying one; omitted, `triageBuckets` falls back to
   * `owner()` exactly as `triagerUnits` does.
   *
   * The CLI fills it in. That does not make `--dry-run --json` newly dependent
   * on a project: the text dry-run beside it has always ended by printing
   * `nothing assigned to ${owner()}`, so both dry-run paths now resolve the
   * owner rather than only one of them.
   */
  projectOwner?: string,
  /** Plan holds and whether a triager runs; the default marks labels only. See `Ownership`. */
  ownership: Ownership = NO_OWNERSHIP,
  /** From `triageKeyed`; null is GitHub. Passed so the report and the intake agree. */
  keyed: TriageKeyed | null = null,
  /** From `readParks`; the park each stuck ticket waits under, and the rescue count's fence. */
  parks: ReadonlyMap<number, ListedPark> = new Map(),
  /** For `remainingSeconds`; the caller's clock so the report stays testable. */
  now: Date = new Date(),
): FrontierReport {
  const { readyTasks, specs, orderedGroups, occluded, inFlight, blocked, occupiedByTicket, childCensus, dependents } =
    frontier;
  const all = [...tickets.values()];
  const byNumber = (a: { number: number }, b: { number: number }): number => a.number - b.number;
  const brief = (t: Ticket): ReportTicket => ({ number: t.number, title: t.title });

  const ready = orderedGroups.map(({ parent, staffingGroup, members }): ReportGroup => {
    const holder = members[0]!;
    const spec = parent === null ? null : tickets.get(parent);
    return {
      spec: parent === null ? null : spec ? brief(spec) : { number: parent, title: `#${parent}` },
      staffingGroup,
      waiting: occluded.filter((t) => occupiedByTicket.get(t.number)?.number === holder.number).length,
      tickets: [...members].sort(byNumber).map((m) => ({
        ...brief(m),
        frees: unblockingPower(m.number, dependents),
        stuck: stuckLabelOf(m.labels),
        ...(isUrgent(m) ? { urgent: true as const } : {}),
      })),
    };
  });

  const gates = new Set<number>();
  for (const ticket of blocked) {
    for (const blocker of ticket.openBlockers) {
      const b = tickets.get(blocker);
      if (b && !b.labels.has(READY_LABEL)) gates.add(blocker);
    }
  }
  const shown = new Set([...readyTasks, ...specs, ...occluded, ...inFlight, ...blocked].map((t) => t.number));
  const buckets = triageBuckets(tickets, frontier, { javLabels, owner: projectOwner, keyed, parks, now });

  return {
    ready,
    occupied: [...occluded].sort(byNumber).map((t) => ({ ...brief(t), heldBy: occupiedByTicket.get(t.number)!.number })),
    specs: [...specs].sort(byNumber).map((t) => ({ ...brief(t), children: childCensus.get(t.number) ?? 0 })),
    inFlight: [...inFlight].sort(byNumber).map((t) => {
      const label = wipLabelOf(t.labels);
      return {
        ...brief(t),
        loop: label === null ? null : label.slice(0, -"-wip".length),
        claim:
          label !== null
            ? label
            : t.assignees.length > 0
              ? `assigned to ${t.assignees.join(", ")}`
              : t.openPullRequest !== null
                ? `PR #${t.openPullRequest}`
                : `branch ${t.liveBranch}`,
        queued: t.labels.has(READY_LABEL),
      };
    }),
    blocked: [...blocked].sort(byNumber).map((t) => ({ ...brief(t), blockers: t.openBlockers, stuck: stuckLabelOf(t.labels) })),
    gates: [...gates].sort((a, b) => a - b).map((n) => brief(tickets.get(n)!)),
    stuck: all
      .filter((t) => stuckLabelOf(t.labels) !== null && !shown.has(t.number))
      .sort(byNumber)
      .map((t) => ({ ...brief(t), label: stuckLabelOf(t.labels)! })),
    malformed: frontier.malformed.map((t) => ({ ...brief(t), problem: t.malformed! })),
    tree: buildTree(tickets, frontier, closed, ownership),
    stuckReasons: stuckNumbers(tickets).map((number) => ({
      ...brief(tickets.get(number)!),
      ...(reasons.get(number) ?? UNKNOWN_BLOCK),
      park: parkReasonOf(parks.get(number), tickets.get(number)!.labels, now),
    })),
    untriaged: untriagedTickets(frontier, javLabels).map(brief),
    // Built from `TRIAGE_BUCKETS` rather than written out, so a bucket added
    // to the intake cannot be forgotten here and silently read as zero.
    triage: Object.fromEntries(TRIAGE_BUCKETS.map((bucket) => [bucket, buckets[bucket].length])) as Record<
      TriageBucket,
      number
    >,
    human: humanTickets(tickets, frontier, ownership).map(({ ticket, reason }) => ({ ...brief(ticket), reason })),
  };
}

/**
 * Every open ticket that waits on the operator, with its reason, in number
 * order. The one per-ticket computation behind both the report's `human` list
 * and `waitingOnOperator`'s counts, so the two can never disagree.
 */
function humanTickets(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  ownership: Ownership,
): { ticket: Ticket; reason: HumanReason }[] {
  const specNumbers = specNumbersOf(tickets, frontier);
  return [...tickets.values()]
    .sort(byNumber)
    .flatMap((ticket) => {
      const reason = humanReason(ticket, { ...ownership, container: specNumbers.has(ticket.number) });
      return reason === null ? [] : [{ ticket, reason }];
    });
}

/**
 * How many open tickets wait on the operator, per reason (#811). Every key of
 * `HUMAN_REASONS` is present, zero included, so a reader can tell "none" from
 * "not reported". Pure: the caller supplies the ownership it read.
 */
export function waitingOnOperator(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  ownership: Ownership,
): Record<HumanReason, number> {
  const counts = Object.fromEntries(HUMAN_REASONS.map((reason) => [reason, 0])) as Record<HumanReason, number>;
  for (const { reason } of humanTickets(tickets, frontier, ownership)) counts[reason] += 1;
  return counts;
}

/** Every open ticket carrying a `<loop>-blocked` label, in number order. */
export const stuckNumbers = (tickets: Map<number, Ticket>): number[] =>
  [...tickets.values()]
    .filter((t) => stuckLabelOf(t.labels) !== null)
    .map((t) => t.number)
    .sort((a, b) => a - b);

/**
 * Read why each stuck ticket is stuck from its comments (`block-reason.ts`).
 * One `gh issue view` per stuck ticket, pooled: stuck tickets are few, and
 * only the `--json` report pays for it. A read that fails leaves that ticket
 * `unknown` rather than failing the frontier, whose buckets are still true.
 */
export async function readStuckReasons(
  numbers: number[],
  io: { comments(number: number): Promise<IssueComment[]> } = { comments: (number) => frontierTracker().comments(number) },
): Promise<Map<number, BlockReason>> {
  const read = await pooled(numbers, API_CONCURRENCY, async (number) => {
    try {
      return latestBlockReason(await io.comments(number));
    } catch {
      return UNKNOWN_BLOCK;
    }
  });
  return new Map(numbers.map((number, at) => [number, read[at]!]));
}

export function render(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  /** From `reportJavLabels`; none means no UNTRIAGED section. */
  javLabels: readonly string[] = [],
): string {
  const all = [...tickets.values()];
  const {
    readyTasks,
    specs,
    orderedGroups,
    occluded,
    inFlight,
    blocked,
    occupiedByTicket,
    childCensus,
    dependents,
  } = frontier;

  const lines: string[] = [];

  if (readyTasks.length === 0) {
    lines.push(bold("READY NOW — nothing"));
    lines.push(
      dim("  Frontier is empty. Check the Loggd Roadmap Project (see the `roadmap` skill)."),
    );
    lines.push("");
  } else {
    const groupCount = orderedGroups.length;
    lines.push(
      bold(
        `READY NOW — ${readyTasks.length} ticket${readyTasks.length === 1 ? "" : "s"}, ` +
          `${groupCount} independent staffing group${groupCount === 1 ? "" : "s"}`,
      ) + dim("   ← one agent per line, in parallel"),
    );
    lines.push("");
    for (const { parent, staffingGroup, members } of orderedGroups) {
      if (parent !== null) {
        const spec = tickets.get(parent);
        const groupSuffix = staffingGroup === null ? "" : ` · ${staffingGroup}`;
        const suffix = ` (#${parent})${groupSuffix}`;
        const label = spec
          ? `${truncate(spec.title, Math.max(1, SPEC_TITLE_WIDTH - suffix.length))}${suffix}`
          : `#${parent}${groupSuffix}`;
        // The waiting siblings are the tree's remaining work; naming the count
        // here is what makes the single printed line legible as a choice
        // already made, rather than as the tree's only ticket.
        const holder = members[0]!;
        const waiting = occluded.filter(
          (ticket) => occupiedByTicket.get(ticket.number)?.number === holder.number,
        ).length;
        const hint =
          waiting > 0
            ? dim(`   ← ${waiting} sibling${waiting === 1 ? "" : "s"} behind this one`)
            : "";
        lines.push(`  ${bold(label)}${hint}`);
      }
      const indent = parent !== null ? "    " : "  ";
      for (const member of [...members].sort((a, b) => a.number - b.number)) {
        const notes: string[] = [];
        const power = unblockingPower(member.number, dependents);
        if (power > 0) notes.push(`frees ${power}`);
        const suffix = notes.length > 0 ? dim(` (${notes.join(", ")})`) : "";
        // Why this line is above the others, said on the line itself: the
        // ordering alone is indistinguishable from the ordering it replaced.
        const urgent = isUrgent(member) ? bold(yellow(" URGENT")) : "";
        const wedgedBy = stuckLabelOf(member.labels);
        const stuck = wedgedBy !== null ? yellow(` [${wedgedBy}]`) : "";
        lines.push(
          `${indent}${green(`#${member.number}`)}  ` +
            `${truncate(member.title, TITLE_WIDTH)}${suffix}${urgent}${stuck}`,
        );
      }
      lines.push("");
    }
  }

  if (occluded.length > 0) {
    lines.push(bold("OCCUPIED — unblocked, but their staffing group is already taken"));
    for (const ticket of [...occluded].sort((a, b) => a.number - b.number)) {
      const holder = occupiedByTicket.get(ticket.number)!;
      lines.push(
        `  ${yellow(`#${ticket.number}`)}  ${truncate(ticket.title, TITLE_WIDTH)} ` +
          dim(`— staffing group held by #${holder.number}`),
      );
    }
    lines.push("");
  }

  // Beside READY NOW and OCCUPIED, where each of these tickets also shows:
  // routing leaves them to nobody, and a ticket no loop will take must not
  // read as one simply waiting its turn.
  const untriaged = untriagedTickets(frontier, javLabels);
  if (untriaged.length > 0) {
    lines.push(
      bold(`UNTRIAGED — ${untriaged.length} ready, but no loop takes them until they carry a difficulty label`) +
        dim(` (${javLabels.join(", ")})`),
    );
    for (const ticket of untriaged) {
      lines.push(`  ${yellow(`#${ticket.number}`)}  ${truncate(ticket.title, TITLE_WIDTH)}`);
    }
    lines.push("");
  }

  if (specs.length > 0) {
    lines.push(bold("SPECS — containers, not work; staff their children"));
    for (const spec of [...specs].sort((a, b) => a.number - b.number)) {
      const children = childCensus.get(spec.number) ?? 0;
      const how = children > 0 ? `parent of ${children}` : `labeled ${SPEC_LABEL}`;
      lines.push(
        `  ${yellow(`#${spec.number}`)}  ${truncate(spec.title, TITLE_WIDTH)} ${dim(`— ${how}`)}`,
      );
    }
    lines.push("");
  }

  if (inFlight.length > 0) {
    lines.push(bold("IN FLIGHT"));
    for (const ticket of [...inFlight].sort((a, b) => a.number - b.number)) {
      const claim = wipLabelOf(ticket.labels);
      const how =
        claim !== null
          ? `[${claim}]`
          : ticket.assignees.length > 0
            ? `assigned to ${ticket.assignees.join(", ")}`
            : ticket.openPullRequest !== null
              ? `PR #${ticket.openPullRequest}`
              : `branch ${ticket.liveBranch}`;
      const offQueue = ticket.labels.has(READY_LABEL) ? "" : dim(` — not ${READY_LABEL}`);
      lines.push(
        `  ${yellow(`#${ticket.number}`)}  ${truncate(ticket.title, TITLE_WIDTH)} ` +
          `${dim(how)}${offQueue}`,
      );
    }
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push(bold(`BLOCKED — ${blocked.length}`));
    // Collapse tickets that share the same blocker set onto one line.
    const bySignature = new Map<string, { blockers: number[]; numbers: number[] }>();
    for (const ticket of [...blocked].sort((a, b) => a.number - b.number)) {
      const signature = ticket.openBlockers.join(",");
      const entry = bySignature.get(signature);
      if (entry) entry.numbers.push(ticket.number);
      else {
        bySignature.set(signature, {
          blockers: ticket.openBlockers,
          numbers: [ticket.number],
        });
      }
    }
    for (const { blockers, numbers } of bySignature.values()) {
      const wedgedBy =
        numbers.map((n) => stuckLabelOf(tickets.get(n)?.labels ?? [])).find((l) => l !== null) ??
        null;
      const stuck = wedgedBy !== null ? yellow(` [${wedgedBy}]`) : "";
      lines.push(
        `  ${numbers.map((n) => `#${n}`).join(" ")}  ` +
          `${dim(`← ${blockers.map((n) => `#${n}`).join(" ")}`)}${stuck}`,
      );
    }

    // A blocker that isn't itself queued appears in no section above, yet it
    // is what actually gates the work.
    const offQueue = new Set<number>();
    for (const ticket of blocked) {
      for (const blocker of ticket.openBlockers) {
        const b = tickets.get(blocker);
        if (b && !b.labels.has(READY_LABEL)) offQueue.add(blocker);
      }
    }
    for (const number of [...offQueue].sort((a, b) => a - b)) {
      const ticket = tickets.get(number)!;
      lines.push(
        `  ${yellow(`⚠ #${number}`)} ${truncate(ticket.title, BLOCKER_TITLE_WIDTH)} ` +
          dim(`— gates work but is not ${READY_LABEL}`),
      );
    }
    lines.push("");
  }

  const shown = new Set([
    ...readyTasks.map((t) => t.number),
    ...specs.map((t) => t.number),
    ...occluded.map((t) => t.number),
    ...inFlight.map((t) => t.number),
    ...blocked.map((t) => t.number),
  ]);
  const stuckElsewhere = all.filter(
    (t) => stuckLabelOf(t.labels) !== null && !shown.has(t.number),
  );
  if (stuckElsewhere.length > 0) {
    lines.push(bold("STUCK"));
    for (const ticket of stuckElsewhere.sort((a, b) => a.number - b.number)) {
      lines.push(
        `  ${yellow(`#${ticket.number}`)}  ${truncate(ticket.title, TITLE_WIDTH)} ` +
          `${dim(`[${stuckLabelOf(ticket.labels)}]`)}${dim(` — not ${READY_LABEL}`)}`,
      );
    }
    lines.push("");
  }

  // Last and loud: these are the tickets a person has to fix before any loop
  // can take them, and nothing else in the view would mention them.
  for (const ticket of frontier.malformed) {
    lines.push(yellow(`⚠ malformed: #${ticket.number} — ${ticket.malformed}`));
  }

  const backfillWorklist = all.filter((t) => t.proseOnlyBlockers.length > 0);
  if (backfillWorklist.length > 0) {
    lines.push(
      dim(
        "⚠ prose-only edges, backfill as native dependencies: " +
          backfillWorklist.map((t) => `#${t.number}`).join(" "),
      ),
    );
  }

  return lines.join("\n").replace(/\n+$/, "");
}

/**
 * The tree view.
 *
 * The flat sections answer "what do I start now". They cannot answer the
 * question that follows an empty frontier — "then why is there nothing?" —
 * because the shape that holds the answer is the one thing the buckets throw
 * away: which spec a ticket belongs to, and what stands in front of it.
 *
 * So the tree keeps both axes at once. Specs are the outer grouping, since a
 * spec is the unit of work a person actually holds. Inside one, a ticket nests
 * under the sibling that blocks it, so a chain reads as a chain and the cost of
 * a stalled ticket is visible as the subtree hanging off it.
 *
 * Closed children are shown, not filtered. A spec whose children have all
 * merged is indistinguishable from a spec nobody has started once you drop
 * them, and telling those two apart is most of why anyone opens this view.
 *
 * The module's "nothing may vanish" rule binds here hardest, and cost two
 * bugs to learn: a spec with no children, and a spec whose only child is
 * another spec, both fell through the grouping entirely and printed nowhere.
 * Every spec now seeds a group whether or not anything hangs under it.
 */

/** What a ticket is doing, in the order a reader cares about it. */
export type TreeState =
  | "done"
  | "ready"
  | "in-flight"
  | "occupied"
  | "blocked"
  | "open";

export interface TreeNode {
  number: number;
  title: string;
  state: TreeState;
  /**
   * The `<loop>-blocked` label this ticket carries, or null. Carried beside
   * the state rather than as one, because a stuck ticket is usually ALSO
   * something else — blocked, or claimed — and collapsing the two would drop
   * whichever it is. The flat view tags it the same way for the same reason.
   * The label rather than a flag, so the tree names the loop that wedged.
   */
  stuck: string | null;
  /** Who holds it, or which ticket holds its tree. Null when nothing holds it. */
  detail: string | null;
  /**
   * Blockers this node's POSITION does not already show — a blocker outside
   * this spec, or the second and later blockers of a ticket that can only nest
   * under one. Without them a ticket reads as gated by one thing when it is
   * gated by five.
   */
  otherBlockers: number[];
  /**
   * For an occupied ticket, the ticket holding its staffing group: not a
   * dependency, but the thing it waits behind. Null for every other state.
   */
  heldBy: number | null;
  /** Transitive tickets this one frees, for the subtree that is not drawn. */
  frees: number;
  /** Why this ticket waits on the operator rather than a loop; null for agent work. See `humanReason`. */
  human: HumanReason | null;
  children: TreeNode[];
}

/**
 * What `humanReason` needs beyond the ticket. The default — nothing held, a
 * triager present — marks only the labelled cases, so a caller that never
 * read a plan or a roster gets no guess about either.
 */
export interface Ownership {
  held: ReadonlySet<number>;
  triager: boolean;
}

const NO_OWNERSHIP: Ownership = { held: new Set(), triager: true };

/**
 * Every number that heads a group rather than sitting in one. Three sources,
 * because each misses a case the others catch. The census knows every
 * container that has children, including one that has closed; the label is
 * the only evidence for a spec whose tickets are not written yet; and
 * `frontier.specs` alone would see only the ready ones, dropping a childless
 * spec the moment it was assigned, stuck, or off the queue.
 */
function specNumbersOf(tickets: Map<number, Ticket>, frontier: Frontier): Set<number> {
  const specNumbers = new Set<number>(frontier.specs.map((s) => s.number));
  for (const [parent, children] of frontier.childCensus) {
    if (children > 0) specNumbers.add(parent);
  }
  for (const ticket of tickets.values()) {
    if (ticket.labels.has(SPEC_LABEL)) specNumbers.add(ticket.number);
  }
  return specNumbers;
}

export interface TreeGroup {
  /**
   * The spec at the root, or null for a ticket that is its own tree. `title`
   * is null when the spec is referenced by a child but absent from both fetch
   * windows: naming it is impossible, but calling the group standalone would
   * be a lie, since the tickets plainly declare a parent.
   *
   * `state` carries the spec's OWN standing. Promoting a spec to a header
   * dropped it from the forest, so a spec that was itself claimed or stuck
   * rendered as a bare caption while the flat view listed it under IN FLIGHT
   * or STUCK — hiding the very reason the frontier was empty.
   */
  spec: {
    number: number;
    title: string | null;
    state: TreeState | null;
    detail: string | null;
    /** The `<loop>-blocked` label it carries, or null. See `TreeNode.stuck`. */
    stuck: string | null;
    /** A spec can be blocked too, and "blocked" without the edge explains nothing. */
    blockers: number[];
  } | null;
  /** The spec's own parent, when a spec is itself a child of another spec. */
  under: number | null;
  /**
   * Specs that name this one as parent. They head their own groups rather than
   * nesting here — nesting would print them twice — so the count is how the
   * relationship stays visible from the parent's side.
   */
  subSpecs: number[];
  /** Children ever written, open and closed — the denominator of progress. */
  total: number;
  /** No open members: the tree is finished, and wants a line rather than a page. */
  complete: boolean;
  /** The spec issue is open while every child has closed — probably closeable. */
  specStillOpen: boolean;
  roots: TreeNode[];
}

/** A closed issue, carried far enough to appear as a done leaf. */
export interface ClosedIssue {
  number: number;
  title: string;
  body: string;
}

const STATE_MARK: Record<TreeState, string> = {
  done: "✔",
  ready: "★",
  "in-flight": "●",
  occupied: "◐",
  blocked: "○",
  open: "·",
};

/**
 * Which blocker a ticket hangs under. Only a blocker inside the same spec can
 * be a parent — nesting under one in another tree would print the same ticket
 * in two groups — and of those, the lowest-numbered wins so an authored batch
 * order (2/5 before 3/5) survives. Every other blocker is reported inline
 * instead, which is what keeps a multiply-blocked ticket honest.
 */
export function primaryBlocker(
  ticket: Ticket,
  siblings: Set<number>,
): { parent: number | null; others: number[] } {
  const inside = ticket.openBlockers.filter((n) => siblings.has(n)).sort((a, b) => a - b);
  const parent = inside[0] ?? null;
  return {
    parent,
    others: ticket.openBlockers.filter((n) => n !== parent).sort((a, b) => a - b),
  };
}

/**
 * Break any nesting cycle by demoting the ticket that would close it to a root.
 * A blocking cycle is a bug in the tickets rather than in this tool, but it is
 * a bug that would hang the renderer, and a view whose whole job is explaining
 * a stall must not itself stall on the pathological case.
 */
export function withoutCycles(parentOf: Map<number, number>): Map<number, number> {
  const safe = new Map<number, number>();
  for (const [child, parent] of parentOf) {
    // Walk the edges ALREADY ACCEPTED, not the original map. Testing against
    // the original demoted every edge touching a cycle, so one bad pair
    // flattened its whole component — including the edges that explained it.
    const seen = new Set<number>([child]);
    let cursor: number | undefined = parent;
    let cyclic = false;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = safe.get(cursor);
    }
    if (!cyclic) safe.set(child, parent);
  }
  return safe;
}

/**
 * Fold the graph into one forest per spec. Pure, and separate from rendering,
 * so the nesting rules can be tested without a terminal in the way.
 */
export function buildTree(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  closed: ClosedIssue[],
  ownership: Ownership = NO_OWNERSHIP,
): TreeGroup[] {
  const ready = new Set(frontier.readyTasks.map((t) => t.number));
  const inFlight = new Set(frontier.inFlight.map((t) => t.number));
  const occluded = new Set(frontier.occluded.map((t) => t.number));

  const stateOf = (ticket: Ticket): TreeState => {
    if (inFlight.has(ticket.number)) return "in-flight";
    // Blocked outranks occupied and ready: a ticket with an open blocker is
    // not startable whatever else is true of it, and saying otherwise here
    // would contradict the flat sections.
    if (ticket.openBlockers.length > 0) return "blocked";
    if (occluded.has(ticket.number)) return "occupied";
    if (ready.has(ticket.number)) return "ready";
    return "open";
  };

  const detailOf = (ticket: Ticket, state: TreeState): string | null => {
    if (state === "in-flight") {
      return (
        wipLabelOf(ticket.labels) ??
        (ticket.assignees.join(", ") || null) ??
        (ticket.openPullRequest === null ? null : `PR #${ticket.openPullRequest}`) ??
        (ticket.liveBranch === null ? null : `branch ${ticket.liveBranch}`)
      );
    }
    if (state === "occupied") {
      const holder = frontier.occupiedByTicket.get(ticket.number);
      return holder ? `staffing group held by #${holder.number}` : null;
    }
    return null;
  };

  const nodeFor = (ticket: Ticket, otherBlockers: number[]): TreeNode => {
    const state = stateOf(ticket);
    return {
      number: ticket.number,
      title: ticket.title,
      state,
      stuck: stuckLabelOf(ticket.labels),
      detail: detailOf(ticket, state),
      otherBlockers,
      heldBy: state === "occupied" ? (frontier.occupiedByTicket.get(ticket.number)?.number ?? null) : null,
      frees: unblockingPower(ticket.number, frontier.dependents),
      human: humanReason(ticket, { ...ownership, container: false }),
      children: [],
    };
  };

  // A spec is a group header, never a member of its own group. Set rather than
  // a scan per ticket, matching how `render` does the same job.
  const specNumbers = specNumbersOf(tickets, frontier);

  const closedByNumber = new Map<number, ClosedIssue>();
  for (const issue of closed) closedByNumber.set(issue.number, issue);

  const openByTree = new Map<number, Ticket[]>();
  for (const ticket of tickets.values()) {
    if (specNumbers.has(ticket.number)) continue;
    const key = treeOf(ticket);
    const bucket = openByTree.get(key);
    if (bucket) bucket.push(ticket);
    else openByTree.set(key, [ticket]);
  }

  const closedByTree = new Map<number, ClosedIssue[]>();
  for (const issue of closed) {
    // A closed SPEC heads its own group; adding it here as well would print
    // one number twice, as a header and as a tick inside its parent.
    if (specNumbers.has(issue.number)) continue;
    const parent = parseParent(issue.body ?? "");
    if (parent === null) continue;
    const bucket = closedByTree.get(parent);
    if (bucket) bucket.push(issue);
    else closedByTree.set(parent, [issue]);
  }

  const subSpecsOf = new Map<number, number[]>();
  for (const number of specNumbers) {
    // A closed sub-spec has no Ticket, so its `## Parent` is the only record
    // of where it hangs — without this its parent claimed nothing was written.
    const parent =
      tickets.get(number)?.parent ??
      parseParent(closedByNumber.get(number)?.body ?? "");
    if (parent === null) continue;
    const bucket = subSpecsOf.get(parent);
    if (bucket) bucket.push(number);
    else subSpecsOf.set(parent, [number]);
  }

  /** One spec's forest: nest by blocker, then hang the finished slices off the top. */
  const buildGroup = (key: number, open: Ticket[], done: ClosedIssue[]): TreeGroup => {
    const siblings = new Set(open.map((t) => t.number));
    const parentOf = new Map<number, number>();
    const inline = new Map<number, number[]>();
    for (const ticket of open) {
      const { parent, others } = primaryBlocker(ticket, siblings);
      if (parent !== null) parentOf.set(ticket.number, parent);
      inline.set(ticket.number, others);
    }
    const nesting = withoutCycles(parentOf);

    const nodes = new Map<number, TreeNode>();
    for (const ticket of open) {
      // A demoted cycle member keeps every blocker inline, since its position
      // now shows none of them.
      const others = nesting.has(ticket.number)
        ? (inline.get(ticket.number) ?? [])
        : ticket.openBlockers;
      nodes.set(ticket.number, nodeFor(ticket, others));
    }

    const roots: TreeNode[] = [];
    for (const ticket of open) {
      const node = nodes.get(ticket.number)!;
      const parent = nesting.get(ticket.number);
      const parentNode = parent === undefined ? undefined : nodes.get(parent);
      if (parentNode) parentNode.children.push(node);
      else roots.push(node);
    }

    // Closed tickets sit at the top level: they gate nothing any more, and
    // burying a finished slice under the one it happened to block would hide
    // exactly the progress this view exists to show.
    for (const issue of done) {
      roots.push({
        number: issue.number,
        title: issue.title,
        state: "done",
        stuck: null,
        detail: null,
        otherBlockers: [],
        heldBy: null,
        frees: 0,
        human: null,
        children: [],
      });
    }

    const byNumber = (a: TreeNode, b: TreeNode): number => a.number - b.number;
    roots.sort(byNumber);
    for (const node of nodes.values()) node.children.sort(byNumber);

    // A spec that has since closed still names its group; without the closed
    // lookup a finished tree was captioned by nothing, which is how a dozen
    // anonymous blocks of ticks reached the first draft of this view.
    const spec = tickets.get(key) ?? closedByNumber.get(key);
    const specTicket = tickets.get(key);
    const specState = specTicket === undefined ? null : stateOf(specTicket);
    const subSpecs = (subSpecsOf.get(key) ?? []).sort((a, b) => a - b);
    // A group keyed on one of its own members is a standalone ticket standing
    // as its own tree, and wants no header above its single line. Anything
    // else is a parent reference — nameable or not, it is a spec.
    const isHeader = !siblings.has(key);
    // Something exists below and none of it is live. "Below" has to include
    // sub-specs: a parent can own no tickets directly and still have all its
    // work finished one level down, and without them it sat in the live
    // section for ever. Nothing below at all is UNSTARTED, not finished.
    const nothingLeft = open.length === 0 && (done.length > 0 || subSpecs.length > 0);
    return {
      spec: isHeader
        ? {
            number: key,
            title: spec?.title ?? null,
            state: specState,
            detail: specTicket === undefined ? null : detailOf(specTicket, specState!),
            stuck: specTicket === undefined ? null : stuckLabelOf(specTicket.labels),
            blockers: specTicket?.openBlockers ?? [],
          }
        : null,
      // A closed spec's parent survives only in its body, exactly as its
      // sub-spec links do.
      under: specTicket?.parent ?? parseParent(closedByNumber.get(key)?.body ?? ""),
      subSpecs,
      total: open.length + done.length,
      complete: nothingLeft,
      specStillOpen: nothingLeft && tickets.has(key),
      roots,
    };
  };

  // Every spec seeds a key even with nothing under it. A spec with no tickets
  // written yet, and a spec whose only child is another spec, both produced no
  // group at all before this — and a ticket the tool decided about but never
  // printed is the one outcome this module forbids.
  const keys = new Set<number>([
    ...openByTree.keys(),
    ...closedByTree.keys(),
    ...specNumbers,
  ]);

  const groups: TreeGroup[] = [];
  for (const key of keys) {
    groups.push(buildGroup(key, openByTree.get(key) ?? [], closedByTree.get(key) ?? []));
  }

  // Completeness has to be decided across groups, not within one. A spec whose
  // own direct children have all closed still owns whatever hangs under its
  // sub-specs — and filing it under COMPLETE as "spec still open" invited
  // closing a parent while its descendants were live, which is the one action
  // this view should never encourage.
  const byNumber = new Map<number, TreeGroup>();
  for (const group of groups) {
    if (group.spec !== null) byNumber.set(group.spec.number, group);
  }
  // No memo, and a fresh path per branch. Specs number in the dozens, so the
  // walk is free — and both shortcuts were wrong here: a shared `seen` made a
  // sub-spec with two parents look cyclic, and caching a value computed under
  // that assumption spread it. A revisit is treated as UNFINISHED, because a
  // parent cycle is a broken ticket graph and letting one member vouch for
  // another would close a spec with live work beneath it.
  const isFinished = (group: TreeGroup, path: Set<number>): boolean => {
    const key = group.spec?.number;
    if (key !== undefined && path.has(key)) return false;
    const next = key === undefined ? path : new Set([...path, key]);
    return (
      group.complete &&
      group.subSpecs.every((n) => {
        const child = byNumber.get(n);
        return child === undefined || isFinished(child, next);
      })
    );
  };
  for (const group of groups) {
    const done = isFinished(group, new Set());
    group.specStillOpen = done && group.specStillOpen;
    group.complete = done;
  }

  // Groups with something startable first, then the largest — a reader scanning
  // this wants the tree they can act on before the one that is merely big.
  const actionable = (g: TreeGroup): number => {
    const walk = (nodes: TreeNode[]): boolean =>
      nodes.some(
        (n) => n.state === "ready" || n.state === "open" || walk(n.children),
      );
    return walk(g.roots) ? 1 : 0;
  };
  return groups.sort((a, b) => {
    const act = actionable(b) - actionable(a);
    if (act !== 0) return act;
    const size = b.total - a.total;
    if (size !== 0) return size;
    return (a.spec?.number ?? a.roots[0]?.number ?? 0) -
      (b.spec?.number ?? b.roots[0]?.number ?? 0);
  });
}

const TREE_TITLE_WIDTH = 52;

/** A spec's caption, including the case where nothing in the graph can name it. */
function specLabel(spec: { number: number; title: string | null }): string {
  return spec.title === null
    ? `#${spec.number}  (outside the fetched graph)`
    : `#${spec.number}  ${truncate(spec.title, SPEC_TITLE_WIDTH)}`;
}

/** A drawn line, split so the note column can be aligned after the fact. */
interface TreeRow {
  left: string;
  right: string;
}

function treeRows(
  nodes: TreeNode[],
  prefix: string,
  rows: TreeRow[],
  connect = true,
): void {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const notes: string[] = [];
    if (node.detail !== null) notes.push(node.detail);
    if (node.otherBlockers.length > 0) {
      notes.push(`← ${node.otherBlockers.map((n) => `#${n}`).join(" ")}`);
    }
    // Only worth saying where the subtree is not already the answer: a node
    // with drawn children shows what it frees by standing above it.
    if (node.frees > 0 && node.children.length === 0) notes.push(`frees ${node.frees}`);
    const stem = connect ? `${prefix}${last ? "└─" : "├─"} ` : prefix;
    rows.push({
      left:
        `${stem}${STATE_MARK[node.state]} ` +
        `#${node.number}  ${truncate(node.title, TREE_TITLE_WIDTH)}`,
      // The stuck tag follows the notes, so a stuck ticket reads as stuck
      // rather than as the idle dot its state would otherwise print.
      right: [
        notes.join(" · "),
        node.stuck !== null ? `[${node.stuck}]` : "",
        // Last and bracketed like the stuck tag, so "this one is yours" reads
        // as a tag rather than as one more note about the ticket.
        node.human !== null ? `[for you: ${node.human}]` : "",
      ]
        .filter((part) => part !== "")
        .join(" "),
    });
    treeRows(node.children, connect ? `${prefix}${last ? "   " : "│  "}` : `${prefix}  `, rows);
  });
}

/** Pad the note column to the widest row in one block, and only that block. */
function alignedRows(rows: TreeRow[]): string[] {
  // A column tracking the widest row across every group would push the notes
  // of every small group off-screen to accommodate one huge one.
  const width = Math.max(0, ...rows.map((r) => [...r.left].length));
  return rows.map(({ left, right }) => {
    if (right === "") return left;
    return `${left}${" ".repeat(width - [...left].length)}  ${dim(right)}`;
  });
}

export function renderTree(
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  groups: TreeGroup[],
): string {
  const lines: string[] = [];
  // `orderedGroups` as well as the set, because this line restates the default
  // view's promise and the two must not name a different ticket as next: the
  // membership is the same, but `readyTasks` is `byStaffingGroup` insertion
  // order and carries none of the ordering keys.
  const { readyTasks, orderedGroups } = frontier;

  // The staffing list is the tool's promise and must survive the view change,
  // so it is restated in one line rather than left to be hunted for by marker.
  // A stuck ticket derives `open` too, because `classify` drops it from the
  // queue — but it usually still carries the label, so counting it here said
  // the opposite of the truth about it. It has its own tag and its own line.
  const countOpen = (nodes: TreeNode[], stuck: boolean): number =>
    nodes.reduce(
      (total, node) =>
        total +
        (node.state === "open" && (node.stuck !== null) === stuck ? 1 : 0) +
        countOpen(node.children, stuck),
      0,
    );
  const unqueued = groups.reduce((total, g) => total + countOpen(g.roots, false), 0);
  const wedged = groups.reduce((total, g) => total + countOpen(g.roots, true), 0);

  lines.push(
    readyTasks.length === 0
      ? bold("READY NOW — nothing") + dim(`   ← nothing ${READY_LABEL} is startable`)
      : bold(
          `READY NOW — ${orderedGroups
            .flatMap((group) => group.members)
            .map((t) => `#${t.number}${isUrgent(t) ? " URGENT" : ""}`)
            .join(" ")}`,
        ) + dim("   ← one agent per ticket, in parallel"),
  );
  // Only `ready-for-agent` tickets can be ready, so an empty frontier beside
  // open unqueued work is ordinary rather than a stall — and saying "every
  // tree is held, blocked, or done" over the top of it was simply false.
  if (readyTasks.length === 0 && unqueued > 0) {
    lines.push(
      dim(
        `  ${unqueued} open ticket${unqueued === 1 ? "" : "s"} ` +
          `not labelled ${READY_LABEL}, marked ${STATE_MARK.open} below`,
      ),
    );
  }
  if (readyTasks.length === 0 && wedged > 0) {
    lines.push(
      yellow(`  ${wedged} ticket${wedged === 1 ? "" : "s"} tagged ${stuckLabels().join(" / ")}`),
    );
  }
  lines.push("");

  const live = groups.filter((g) => !g.complete);
  const finished = groups.filter((g) => g.complete);
  const parented = live.filter((g) => g.spec !== null);
  const standalone = live.filter((g) => g.spec === null);

  for (const group of parented) {
    const spec = group.spec!;
    const under = group.under === null ? "" : dim(` · under #${group.under}`);
    const subs =
      group.subSpecs.length === 0
        ? ""
        : dim(
            ` · ${group.subSpecs.length} sub-spec${group.subSpecs.length === 1 ? "" : "s"}` +
              ` (${group.subSpecs.map((n) => `#${n}`).join(" ")})`,
          );
    // "No tickets written yet" is only true when nothing hangs off this spec at
    // all. A spec whose children are all sub-specs has plenty written; it is
    // just written one level down.
    const count =
      group.total > 0
        ? dim(` — ${group.total} ticket${group.total === 1 ? "" : "s"}`)
        : group.subSpecs.length > 0
          ? ""
          : dim(" — no tickets written yet");
    const own: string[] = [];
    if (spec.state !== null && spec.state !== "open") own.push(spec.state);
    if (spec.detail !== null) own.push(spec.detail);
    if (spec.blockers.length > 0) {
      own.push(`← ${spec.blockers.map((n) => `#${n}`).join(" ")}`);
    }
    if (spec.stuck !== null) own.push(`[${spec.stuck}]`);
    // A spec's own "open" is the ordinary case and says nothing — a container
    // is not work. Only a state that explains something gets a mark.
    const mark =
      spec.state === null || spec.state === "open" ? "" : `${STATE_MARK[spec.state]} `;
    const standing = own.length > 0 ? dim(` · ${own.join(" · ")}`) : "";
    lines.push(`${mark}${bold(specLabel(spec))}${count}${subs}${under}${standing}`);
    const rows: TreeRow[] = [];
    treeRows(group.roots, "", rows);
    lines.push(...alignedRows(rows));
    lines.push("");
  }

  // Each of these is its own tree and staffing group, so they are not
  // siblings — but N single-line groups each opening with a `└─` pointing at
  // nothing reads as a rendering bug. One heading, no connectors.
  if (standalone.length > 0) {
    lines.push(bold("STANDALONE — their own tree, no spec above them"));
    const rows: TreeRow[] = [];
    for (const group of standalone) treeRows(group.roots, "  ", rows, false);
    lines.push(...alignedRows(rows));
    lines.push("");
  }

  // Finished trees collapse to a line each rather than vanishing. Drawing them
  // in full buried the live work under a page of ticks; dropping them would
  // break the rule the rest of this tool keeps, that a decision the tool made
  // is visible somewhere. A line each says "counted, and done".
  if (finished.length > 0) {
    lines.push(
      bold(`COMPLETE — ${finished.length} tree${finished.length === 1 ? "" : "s"}`),
    );
    for (const group of finished) {
      const spec = group.spec;
      const label =
        spec !== null
          ? specLabel(spec)
          : `#${group.roots[0]?.number ?? 0}  ${truncate(group.roots[0]?.title ?? "", SPEC_TITLE_WIDTH)}`;
      // The one thing worth acting on in here: a spec still open with every
      // child closed is a container nobody remembered to close.
      // `total` counts direct tickets only, so a parent whose work all lives
      // in finished sub-specs read as "0 done" — accurate about nothing.
      const count =
        group.total > 0
          ? `${group.total} done`
          : `${group.subSpecs.length} sub-spec${group.subSpecs.length === 1 ? "" : "s"} done`;
      const note = group.specStillOpen
        ? yellow(` — ${count}, spec still open`)
        : dim(` — ${count}`);
      // The children are done; the SPEC may still be held or stuck, and this
      // line otherwise invited closing it out from under whoever has it.
      const own: string[] = [];
      if (spec?.state != null && spec.state !== "open") own.push(spec.state);
      if (spec?.detail != null) own.push(spec.detail);
      if (spec !== null && spec.blockers.length > 0) {
        own.push(`← ${spec.blockers.map((n) => `#${n}`).join(" ")}`);
      }
      if (spec?.stuck != null) own.push(`[${spec.stuck}]`);
      const standing = own.length > 0 ? yellow(` · ${own.join(" · ")}`) : "";
      lines.push(`  ${dim(STATE_MARK.done)} ${dim(label)}${note}${standing}`);
    }
    lines.push("");
  }

  const legend =
    (["ready", "in-flight", "occupied", "blocked", "open", "done"] as const)
      .map((state) => `${STATE_MARK[state]} ${state}`)
      .join("   ") + `   [${stuckLabels().join(" | ")}] stuck   [for you: …] waits on you, not a loop`;
  lines.push(dim(legend));

  // The two warnings the flat view ends on are readiness decisions, not
  // decoration, so they belong to both views. Dropping them here would have
  // made `--tree` quietly the less truthful of the two.
  const offQueue = new Set<number>();
  for (const ticket of frontier.blocked) {
    for (const blocker of ticket.openBlockers) {
      const b = tickets.get(blocker);
      if (b && !b.labels.has(READY_LABEL)) offQueue.add(blocker);
    }
  }
  for (const number of [...offQueue].sort((a, b) => a - b)) {
    const ticket = tickets.get(number)!;
    lines.push(
      `${yellow(`⚠ #${number}`)} ${truncate(ticket.title, BLOCKER_TITLE_WIDTH)} ` +
        dim(`— gates work but is not ${READY_LABEL}`),
    );
  }

  for (const ticket of frontier.malformed) {
    lines.push(yellow(`⚠ malformed: #${ticket.number} — ${ticket.malformed}`));
  }

  const backfill = [...tickets.values()].filter((t) => t.proseOnlyBlockers.length > 0);
  if (backfill.length > 0) {
    lines.push(
      dim(
        "⚠ prose-only edges, backfill as native dependencies: " +
          backfill.map((t) => `#${t.number}`).join(" "),
      ),
    );
  }

  return lines.join("\n").replace(/\n+$/, "");
}

export interface LiveIssue {
  assignees: { login: string }[];
  labels: { name: string }[];
  /**
   * PRs GitHub links to this issue, of ANY state — the field carries no
   * state, so a closed-unmerged PR appears here too and must be checked
   * before it is allowed to refuse a claim.
   */
  closedByPullRequestsReferences?: { number: number }[];
  /**
   * Whether the tracker's authoritative single-issue read calls the ticket
   * closed. Optional because callers that build a LiveIssue by hand know no
   * state: absent means "unknown", which must never invent a refusal.
   */
  state?: "open" | "closed";
  /** The tracker's workflow status name, "" or absent when it has none. */
  status?: string;
}

/**
 * The closed half of a live re-read obstruction, checked first by both claim
 * fences. The census came from a search index or a snapshot, and either can
 * lag a status move (OAI-140: a Jira ticket already in the done-category
 * "Mergeado" was claimed), so the single-issue read has the last word — and a
 * closed ticket is never claimable, a rescue included.
 */
function closedObstruction(live: LiveIssue): string | null {
  if (live.state !== "closed") return null;
  return live.status ? `closed (${live.status})` : "closed";
}

/** Whether a linked PR is still open. Injected so the tests can drive it. */
export type IsOpenPr = (n: number) => Promise<boolean>;

/**
 * The PR half of a live re-read obstruction. The field carries no state, so a
 * closed-unmerged PR must not refuse a claim; only the lowest linked PR the
 * probe reports open does.
 */
async function openPrObstruction(live: LiveIssue, isOpenPr: IsOpenPr): Promise<string | null> {
  const open: number[] = [];
  for (const ref of live.closedByPullRequestsReferences ?? []) {
    if (await isOpenPr(ref.number)) open.push(ref.number);
  }
  if (open.length === 0) return null;
  return `open PR #${Math.min(...open)}`;
}

/**
 * Why a live re-read forbids claiming, or null if the ticket is free.
 *
 * The frontier already excludes assigned and ralph-labelled tickets, but it
 * decides that against a snapshot taken before the dependency round-trip. A
 * Ralph iteration can claim inside that window, and stamping owner() over its
 * claim is exactly the two-workers-one-ticket collision this tool exists to
 * prevent — so obstruction is re-checked against live state, per ticket,
 * immediately before the write.
 */
export async function claimObstruction(
  live: LiveIssue,
  isOpenPr?: IsOpenPr,
): Promise<string | null> {
  const closed = closedObstruction(live);
  if (closed !== null) return closed;
  const others = live.assignees.map((a) => a.login).filter((login) => login !== owner());
  if (others.length > 0) return `assigned to ${others.join(", ")}`;
  const held = live.labels
    .map((l) => l.name)
    .filter((name) => wipLabels().includes(name) || stuckLabels().includes(name));
  if (held.length > 0) return `labeled ${held.join(", ")}`;
  // An absent probe must not invent a refusal: only tickets that actually have
  // a linked PR reach the probe, so omitting it means "no PR information".
  if (isOpenPr !== undefined) return openPrObstruction(live, isOpenPr);
  return null;
}

/**
 * The live re-read both claim paths take immediately before writing. Written
 * once because two copies of "which fields does a claim decision need" is two
 * places for the decision to start reading a field the other does not.
 */
export async function readLiveIssue(number: number): Promise<LiveIssue> {
  const tracker = frontierTracker();
  const live = await tracker.live(number);
  // GitHub links a PR to the issue it closes. Linear and Jira cannot see
  // GitHub, so a PR is linked when its branch or body names the ticket.
  const linked =
    tracker.kind === "github"
      ? live.linkedPullRequests
      : linkKeyedPullRequests(await readHeads(), tracker.ref(number).replace(/-\d+$/, ""), loopRoster())
          .filter((pr) => pr.closingIssuesReferences.some((ref) => ref.number === number))
          .map((pr) => pr.number);
  return {
    assignees: live.assignees.map((login) => ({ login })),
    labels: live.labels.map((name) => ({ name })),
    closedByPullRequestsReferences: linked.map((pr) => ({ number: pr })),
    state: live.state,
    status: live.status,
  };
}

/** An open PR's head branch and body: what a keyed tracker's PR fence reads. */
export interface OpenPullRequestHead {
  number: number;
  headRefName: string;
  body: string;
}

async function readOpenPullRequestHeads(): Promise<OpenPullRequestHead[]> {
  return JSON.parse(
    await readGh(["pr", "list", "--state", "open", "--limit", String(OPEN_PR_CENSUS_LIMIT), "--json", "number,headRefName,body"]),
  ) as OpenPullRequestHead[];
}
let readHeads: () => Promise<OpenPullRequestHead[]> = readOpenPullRequestHeads;

/**
 * Which tickets each open PR carries, on a tracker that cannot see GitHub
 * (felipearos/ralph#333): a PR whose head branch is `<loop>/<n>-…` for a loop
 * of this project, or whose body names `<KEY>-n` outside code. Shaped like GitHub's
 * `closingIssuesReferences`, so the census and the live re-read fence it the
 * same way.
 */
export function linkKeyedPullRequests(
  prs: readonly OpenPullRequestHead[],
  key: string,
  loops: readonly string[],
): OpenPullRequest[] {
  const keyRef = new RegExp(`\\b${escapeKey(key)}-(\\d+)\\b`, "g");
  return prs.map((pr) => {
    const numbers = new Set<number>();
    const branch = /^([a-z][a-z0-9]*)\/([1-9][0-9]*)(?:-|$)/.exec(pr.headRefName);
    if (branch !== null && loops.includes(branch[1]!)) numbers.add(Number(branch[2]));
    // Code is a citation, as it is for parseBodyReferences: a PR quoting
    // another ticket's key (pr-ref --criteria does) must not fence it.
    for (const match of withoutCode(pr.body).matchAll(keyRef)) numbers.add(Number(match[1]));
    return { number: pr.number, closingIssuesReferences: [...numbers].map((number) => ({ number })) };
  });
}

export interface ClaimResult {
  number: number;
  status: "claimed" | "already-mine" | "skipped" | "failed";
  detail?: string;
}

/**
 * Who this process is to the lease store.
 *
 * Written once because the claim path and the read-only path below have to
 * agree on it exactly: `claimLease` compares BOTH fields, so an identity that
 * drifted in either one would make a dry run report a loop's own live lease as
 * somebody else's and fence the loop off its own ticket.
 */
export function leaseIdentity(): { run: string; loop: LoopName } {
  const loop = currentLoop();
  return { run: process.env.RALPH_RUN_ID ?? `${loop}-manual-${process.pid}`, loop };
}

/**
 * The one wording for "somebody else's lease holds this issue".
 *
 * Written once because the gate and the iteration are meant to read the same
 * answer: `writeClaim`'s throw and the read-only check below are the two
 * places it is produced, and two literals would drift without anything
 * noticing.
 */
export const leaseHeldReason = (status: LeaseStatus, issue: number): string =>
  `lease ${status} for issue #${issue}`;

/**
 * The lease side of `takeOne`'s `io`, against one store path and one identity.
 *
 * A factory rather than the inline literal it replaces, so a test can drive it
 * against a store of its own: `leasePathFromGit()` resolves to the git common
 * directory that every loop worktree on this host shares, and a test writing a
 * "foreign lease" there would fence the live loops off that issue number.
 *
 * `clock` is a function, not a value, because these seams are consulted once
 * per candidate across a walk that talks to GitHub in between — a timestamp
 * captured at construction would judge the last candidate by the first one's
 * clock.
 */
export function claimLeaseIo(options: {
  path: string;
  identity: { run: string; loop: string };
  clock?: () => LeaseClock;
}): {
  isExpired(n: number): boolean;
  canReclaimExpired(n: number, live: LiveIssue): boolean;
  releaseExpired(n: number): Promise<void>;
  leaseObstruction(n: number): string | null;
} {
  const clock = options.clock ?? ((): LeaseClock => ({ nowMs: Date.now() }));
  const leaseOf = (n: number): ClaimLease | undefined => readLeaseStore(options.path).leases[String(n)];
  return {
    isExpired: (n: number): boolean => {
      const lease = leaseOf(n);
      return lease !== undefined && leaseStatus(lease, clock()) === "expired";
    },
    canReclaimExpired: (n: number, live: LiveIssue): boolean => {
      // An expired lease releases a dead loop's claim, never a closed ticket:
      // the closed refusal is the one obstruction no reclaim may override.
      if (live.state === "closed") return false;
      if (live.assignees.length > 0) return false;
      const lease = leaseOf(n);
      return lease !== undefined && live.labels.some((label) => label.name === lease.claim);
    },
    releaseExpired: async (n: number): Promise<void> => {
      const lease = leaseOf(n);
      if (lease) await removeClaimLabel(n, lease);
    },
    /**
     * The refusal a real claim would meet, for a caller that is not going to
     * write. Until #328 only `writeClaim` knew about it, so a dry run named
     * tickets a live lease held — and loggd's triager spent 40 iterations of
     * 50 being handed #2427, which every one of them then failed to claim.
     *
     * It reads the store and nothing else: no `withLeaseStoreLock` (held, it
     * returns `undefined`, which would silently turn the answer into "nothing
     * is held"), no `withClaimLock` (which polls the same file for a minute and
     * then throws, and in the real mode this process is already holding it), no
     * write.
     */
    leaseObstruction: (n: number): string | null => {
      let lease: ClaimLease | undefined;
      try {
        lease = leaseOf(n);
      } catch {
        // A store that will not parse tells us nothing about this candidate,
        // and `CLAUDE.md` is the rule: a malformed signal falls back to
        // existing behaviour, never to a stuck loop. Obstructing here would
        // park every loop on every ticket until a human noticed.
        //
        // Deliberately silent, and that is the trade: the gate polls this path
        // every few minutes, so a warning per poll would bury its own output.
        // What a human sees instead is the real claim throwing `invalid lease
        // store:` in the iteration that follows.
        return null;
      }
      if (lease === undefined) return null;
      // Both fields, because `claimLease` compares both: a re-claim by the run
      // that already holds the lease is the same attempt, not a collision. The
      // loop alone is not enough either — a crashed predecessor run of THIS
      // loop still holds a live lease, and that one does fence us off.
      if (lease.run === options.identity.run && lease.loop === options.identity.loop) return null;
      // One observation of the holder, not two: `leaseStatus` reads the pid
      // through /proc, so asking it once to decide and again to explain can
      // straddle the holder's exit and report `lease expired` as the reason a
      // candidate is obstructed.
      // `leaseBlocksClaim` IS `status !== "expired"`, so this is not a second
      // definition of "held" — it is the same one, from one reading.
      const status = leaseStatus(lease, clock());
      return status === "expired" ? null : leaseHeldReason(status, n);
    },
  };
}

function leaseClaim(number: number, label?: string): {
  store: ReturnType<typeof readLeaseStore>;
  path: string;
  result: ReturnType<typeof claimLease>;
} {
  const path = leasePathFromGit();
  const store = readLeaseStore(path);
  const details = currentGitDetails();
  const { run, loop } = leaseIdentity();
  const result = claimLease(store, {
    issue: number,
    run,
    loop,
    pid: Number(process.env.RALPH_SUPERVISOR_PID) || process.pid,
    host: process.env.HOSTNAME,
    worktree: details.worktree,
    branch: details.branch,
    claim: label,
    nowMs: Date.now(),
  });
  return { store, path, result };
}

/**
 * Take a lease's claim label off its ticket. The label is the one the lease
 * records, never one rebuilt from its loop: a claim made before `currentLoop`
 * read `.loop-name` went out as `ralph-wip` from a `rafa` checkout, and
 * removing `rafa-wip` there would leave the real claim on the ticket.
 */
const removeClaimLabel = (issue: number, lease: ClaimLease): Promise<void> =>
  frontierTracker().removeLabels(issue, [lease.claim]);

/**
 * Write one claim: the lease first, then the label, and the lease rolled back
 * if the label write fails.
 *
 * That order is the atomicity contract, and it runs this way round because the
 * lease is the cheap local fence and the label is the remote one. A lease
 * written for a claim whose label never landed would fence every other loop
 * off a ticket nobody holds, so the rollback is not tidiness: it is the only
 * thing that keeps the two halves from disagreeing. The rollback restores the
 * lease that was replaced rather than deleting it, because replacing is how a
 * reclaim works and deleting there would drop the previous holder's evidence.
 *
 * It does not decide WHETHER to claim — the caller does that, under the lock,
 * from a live re-read. Both claim paths that know their ticket use this:
 * single-ticket mode's walk and `claimByNumber`.
 */
export async function writeClaim(number: number, label: string, options: { move?: boolean } = {}): Promise<void> {
  const lease = leaseClaim(number, label);
  if (lease.result.outcome === "held") {
    throw new Error(leaseHeldReason(lease.result.status, number));
  }
  writeLeaseStore(lease.path, lease.store);
  try {
    if (lease.result.outcome === "replaced" && lease.result.previous) {
      await removeClaimLabel(number, lease.result.previous);
    }
    if (options.move === false) {
      // Label only: a triager's claim on Linear/Jira must not move an
      // untriaged report to In Progress, since nothing would move it back.
      await frontierTracker().addLabels(number, [label]);
    } else {
      // The label is the fence; a state move the tracker refused is said, not thrown.
      const transition = await frontierTracker().claim(number, label);
      if (transition.warning !== null) console.error(`next-tasks: claimed ${frontierTracker().ref(number)}, but ${transition.warning}`);
    }
  } catch (error) {
    const current = readLeaseStore(lease.path);
    if (current.leases[String(number)]?.run === lease.result.lease.run) {
      if (lease.result.outcome === "replaced" && lease.result.previous) {
        current.leases[String(number)] = lease.result.previous;
      } else {
        delete current.leases[String(number)];
      }
      writeLeaseStore(lease.path, current);
    }
    throw error;
  }
}

/**
 * A failed claim is reported, never thrown: one ticket losing a race must not
 * discard the claims that succeeded, and the frontier above it is still true.
 */
async function claimTickets(tickets: Ticket[], isOpenPr?: IsOpenPr): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];
  // Lease writes update one shared JSON document. Keep this small critical
  // section sequential so two successful claims cannot overwrite each other's
  // evidence; the expensive graph build remains parallel and outside the lock.
  for (const ticket of tickets) {
    const result = await (async (): Promise<ClaimResult> => {
    let pending: ReturnType<typeof leaseClaim> | null = null;
    try {
      const live = await readLiveIssue(ticket.number);
      const obstruction = await claimObstruction(live, isOpenPr);
      if (obstruction !== null) {
        const store = readLeaseStore(leasePathFromGit());
        const lease = store.leases[String(ticket.number)];
        const externalAssignee = live.assignees.some((assignee) => assignee.login !== owner());
        const matchingExpiredLabel = lease !== undefined &&
          live.labels.some((label) => label.name === lease.claim) &&
          leaseStatus(lease, { nowMs: Date.now() }) === "expired";
        // A closed ticket stays refused even past an expired lease, as in takeOne.
        if (live.state === "closed" || externalAssignee || !matchingExpiredLabel) {
          return { number: ticket.number, status: "skipped", detail: obstruction };
        }
        await removeClaimLabel(ticket.number, lease);
      }
      if (live.assignees.some((a) => a.login === owner())) {
        return { number: ticket.number, status: "already-mine" };
      }
      pending = leaseClaim(ticket.number);
      if (pending.result.outcome === "held") {
        return { number: ticket.number, status: "skipped", detail: `lease ${pending.result.status}` };
      }
      writeLeaseStore(pending.path, pending.store);
      // `owner` is a GitHub login; on Linear or Jira the claim goes to the credential's own user.
      const tracker = frontierTracker();
      await tracker.assign(ticket.number, tracker.kind === "github" ? owner() : undefined);
      return { number: ticket.number, status: "claimed" };
    } catch (error) {
      if (pending?.result.outcome !== "held") {
        const current = readLeaseStore(pending?.path ?? leasePathFromGit());
        if (pending && current.leases[String(ticket.number)]?.run === pending.result.lease.run) {
          if (pending.result.outcome === "replaced" && pending.result.previous) {
            current.leases[String(ticket.number)] = pending.result.previous;
          } else {
            delete current.leases[String(ticket.number)];
          }
          writeLeaseStore(pending.path, current);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      return { number: ticket.number, status: "failed", detail: message };
    }
    })();
    results.push(result);
  }
  return results;
}

const CLAIM_DISPLAY = {
  claimed: { colour: green, note: "" },
  "already-mine": { colour: yellow, note: " already mine" },
  skipped: { colour: yellow, note: " left alone" },
  failed: { colour: yellow, note: " claim failed" },
} as const;

export function renderClaims(results: ClaimResult[]): string {
  if (results.length === 0) return "";
  const lines = [bold(`CLAIMED — assigned to ${owner()}`)];
  for (const result of [...results].sort((a, b) => a.number - b.number)) {
    const { colour, note } = CLAIM_DISPLAY[result.status];
    const suffix = result.detail !== undefined ? ` — ${result.detail}` : "";
    lines.push(`  ${colour(`#${result.number}`)}${dim(`${note}${suffix}`)}`);
  }
  return lines.join("\n");
}

/**
 * Why a live re-read forbids a LOOP from claiming, or null if the ticket is
 * free. It differs from `claimObstruction` in exactly one way, and that
 * difference is the point of single-ticket mode: the maintainer's fence lets
 * owner() re-claim a ticket it already holds, but a loop must keep off ANY
 * assignee, because an assignee — whoever it is — means a human took the
 * ticket, and the collision this mode exists to prevent is two callers landing
 * on the same work.
 *
 * A rescue is the one caller that may claim a ticket wearing a `*-blocked`,
 * and without that exception felipearos/ralph#150's whole bucket is
 * unreachable: every ticket it offers carries a coder's block by definition, so
 * the live re-read would obstruct all of them and the hand-over would answer
 * "obstructed" forever.
 *
 * `rescuable` is the blocks it may claim past — the CODERS' — and not "any
 * block". That distinction is the whole of the exception's safety. A ticket
 * carrying a coder's block AND a triager's is a unit somebody put in front of a
 * person on purpose, and claiming it would write a `-wip` over that; the plan
 * would then be refused for it, having spent the iteration and the write. A
 * `*-wip` and an assignee still obstruct a rescue too — the coder's block is
 * what it came for, a live claim is not.
 */
export async function loopClaimObstruction(
  live: LiveIssue,
  isOpenPr?: IsOpenPr,
  options: { rescuable?: readonly string[] } = {},
): Promise<string | null> {
  const closed = closedObstruction(live);
  if (closed !== null) return closed;
  const holders = live.assignees.map((a) => a.login);
  if (holders.length > 0) return `assigned to ${holders.join(", ")}`;
  const rescuable = options.rescuable ?? [];
  const forbidden = [...wipLabels(), ...stuckLabels().filter((name) => !rescuable.includes(name))];
  const held = live.labels.map((l) => l.name).filter((name) => forbidden.includes(name));
  if (held.length > 0) return `labeled ${held.join(", ")}`;
  if (isOpenPr !== undefined) return openPrObstruction(live, isOpenPr);
  return null;
}

/** A candidate the live re-read refused, and what refused it. */
export interface ClaimRefusal {
  number: number;
  reason: string;
}

/** One ticket as a hand-over names it. `tree` is the tree it holds. */
export interface ClaimedTicket {
  number: number;
  title: string;
  tree: number;
  /**
   * Carried from the classification rather than re-read, because a hand-over
   * names tickets by number and title and holds no label set: the renderer
   * could only guess, and the frontier already knows. Present only when true,
   * so the JSON a loop parses is unchanged where the lane is unused.
   */
  urgent?: true;
}

/** The result of one hand-over to a single caller. */
export interface TakeOneOutcome {
  /**
   * The ticket claimed, or null when the frontier offered nothing claimable.
   * `tree` is the tree this ticket holds, so the caller can see what a second
   * call against the same frontier will be refused. For a unit of several
   * tickets this is the first of them, so a caller written for one ticket
   * keeps reading the field it always read.
   */
  ticket: ClaimedTicket | null;
  /**
   * Every ticket handed over, `ticket` first. One, except for a triager's
   * routing batch — and on a dry run, the whole unit as it was OFFERED, since
   * nothing was claimed.
   */
  tickets: ClaimedTicket[];
  /** The bucket the unit came from, or null when nothing was offered. */
  bucket: UnitBucket | null;
  /**
   * Whether the claim was actually written. Reported rather than re-derived
   * from the caller's flags: the walk is the only thing that knows whether it
   * wrote, and a second place deciding what "claimed" means is a second place
   * to get it wrong.
   */
  claimed: boolean;
  /** Candidates refused by the live re-read, in the order they were tried. */
  obstructed: ClaimRefusal[];
  /**
   * Set only when the hand-over is a `## Parent closure exceptions` spec
   * rather than a frontier ticket (#810): closing it is maintenance, and the
   * caller does something different with it than build it.
   */
  closure?: true;
}

/**
 * The ordered candidate list for a single-ticket claim: the frontier's picks,
 * one per staffing group, in the order the rendered frontier prints them. Derived from
 * the groups `classify` already ordered, never re-derived — readiness, the
 * one-per-group rule and the ordering all live in `classify`, and computing
 * them again here is how the claim and the printed frontier drift apart.
 */
export function takeOneCandidates(frontier: Frontier, excluded = new Set<number>()): Ticket[] {
  return frontier.orderedGroups
    .flatMap((group) => group.members)
    .filter((ticket) => !excluded.has(ticket.number));
}

/**
 * The ordered units a role's intake offers, from the bucket its descriptor
 * names — the dispatch that makes `--take-one --role <role>` one claim path
 * rather than one per role.
 *
 * Everything past the unit list is shared on purpose: the same claim lock, the
 * same live re-read, the same `<loop>-wip` and the same lease. A role differs
 * in WHICH tickets it is offered and how many at a time, never in what holding
 * one means, so the fence stays one thing every loop reads the same way.
 *
 * A role with no bucket throws rather than returning nothing, because the two
 * answers mean opposite things to a caller: an empty frontier is "wait", and
 * asking the frontier for a doctor's case is a caller in the wrong place. Its
 * intake claims by number (`claim-lease.ts claim <n>`).
 */
export function roleUnits(
  role: Role,
  tickets: Map<number, Ticket>,
  frontier: Frontier,
  options: {
    excluded?: Set<number>;
    javLabels?: () => readonly string[];
    /** The Jav difficulty labels this loop takes, or null with routing off. */
    route?: string[] | null;
    owner?: string;
    batch?: number;
    /** From `triageKeyed`; the triager's bucket only. */
    keyed?: TriageKeyed | null;
    /** From `readParks`; the triager's bucket only, read lazily like `javLabels`. */
    parks?: () => ReadonlyMap<number, ListedPark>;
  } = {},
): FrontierUnit[] {
  const excluded = options.excluded ?? new Set<number>();
  const bucket = roleDescriptor(role).frontierBucket;
  if (bucket === null) {
    throw new Error(
      `the ${role} role takes no work off the frontier — its intake claims by number ` +
        "(claim-lease.ts claim <n>)",
    );
  }
  if (bucket === "triage") {
    // Read lazily, because the coder's bucket must not pay for a file it does
    // not consult: a `jav.json` this call never needed could otherwise fail a
    // claim that has nothing to do with routing.
    return triagerUnits(tickets, frontier, {
      excluded,
      javLabels: options.javLabels?.() ?? [],
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      ...(options.batch === undefined ? {} : { batch: options.batch }),
      ...(options.keyed === undefined ? {} : { keyed: options.keyed }),
      ...(options.parks === undefined ? {} : { parks: options.parks() }),
    });
  }
  // Difficulty routing is applied here rather than after the fact so that a
  // unit is the same thing in both buckets: everything the walk may claim. The
  // project's configured labels go in beside this loop's route because
  // `routeByDifficulty`'s exemption is defined against them (`jav.ts`).
  const route = options.route ?? null;
  // A routed caller MUST say what the project configures, because that is the
  // narrow half of the exemption: with an empty `configured` list every exempt
  // ticket reads as stranded, so a caller that merely forgot the labels would
  // get the blanket exemption the decision rules out — silently, and only on a
  // routed project. Throwing is the same choice as the null bucket above: the
  // two answers mean opposite things, and one of them is a caller in the wrong
  // place. Unrouted, nothing is filtered, so THIS function reads nothing —
  // which is all `reads the Jav labels only for the bucket defined by them`
  // pins. Whether the CALLER reads the file is its own business: `main` resolves
  // a `javRouted` role's route before it knows whether Jav is even enabled.
  if (route !== null && options.javLabels === undefined) {
    throw new Error(
      "difficulty routing needs the project's Jav labels as well as this loop's route " +
        "(roleUnits options.javLabels) — they are what decides whether a ci-doctor filing is stranded",
    );
  }
  return routeByDifficulty(
    takeOneCandidates(frontier, excluded),
    route,
    route === null ? [] : (options.javLabels?.() ?? []),
  ).map((ticket) => ({ bucket: "ready" as const, tickets: [ticket] }));
}

/**
 * Walk the units in order and hand over exactly one of them, claimed with the
 * loop label rather than an assignee — or, on a dry run, named without being
 * claimed. Each ticket is re-read live immediately before the write, because
 * the frontier is a snapshot and a competing claim can land inside that
 * window; the answer to that race is the one the maintainer's path already
 * uses — never claim over what the re-read shows is held. One failed read or
 * claim is recorded and the walk moves on: a bad ticket must not throw away
 * the rest of the frontier, and running out of units is an empty result,
 * never an error.
 *
 * A unit of several tickets hands over as much of itself as it can get: a
 * routing batch that loses two of its ten to another triager is still nine
 * label writes this iteration does not have to poll again for. Only a unit
 * that loses EVERY ticket is refused, and the walk moves to the next one.
 *
 * A dry run verifies the unit's FIRST ticket and stops there. The re-read
 * exists to close the window before a write, and a dry run has no write; what
 * it must not do is NAME a ticket somebody already holds, and one read settles
 * that. The cost of that shortcut is that a unit whose first ticket is held
 * reads as held whole, where a real call would record the obstruction and
 * claim the other nine — so a gate may wait out a routing batch it could have
 * taken most of. One read per poll is the trade #143 asks for. The frontier gate polls this mode continuously, so re-reading a whole
 * batch on every poll would make a triager's poll cost ten times a coder's —
 * the one thing #143 says it must not.
 */
export async function takeOne(
  units: FrontierUnit[],
  io: {
    readLive(n: number): Promise<LiveIssue>;
    claim(n: number): Promise<void>;
    isExpired?(n: number): boolean;
    canReclaimExpired?(n: number, live: LiveIssue): boolean;
    releaseExpired?(n: number): Promise<void>;
    /**
     * The lease refusal, for a caller that has not written yet. Optional
     * because a caller without a lease store (every test fake) must behave as
     * it always did.
     */
    leaseObstruction?(n: number): string | null;
    /**
     * A property rather than a method, because unlike its siblings this one is
     * passed on rather than called here — and a method shorthand handed to
     * another function arrives unbound.
     */
    isOpenPr?: IsOpenPr;
  },
  options: { dryRun?: boolean } = {},
): Promise<TakeOneOutcome> {
  const dryRun = options.dryRun === true;
  const obstructed: ClaimRefusal[] = [];
  const named = (t: Ticket): ClaimedTicket => ({
    number: t.number,
    title: t.title,
    tree: treeOf(t),
    ...(isUrgent(t) ? { urgent: true as const } : {}),
  });

  for (const unit of units) {
    const probe = dryRun ? unit.tickets.slice(0, 1) : unit.tickets;
    const taken: ClaimedTicket[] = [];
    for (const candidate of probe) {
      try {
        const live = await io.readLive(candidate.number);
        const obstruction = await loopClaimObstruction(live, io.isOpenPr, {
          rescuable: unit.bucket === "rescue" ? coderLoops().map(stuckLabelFor) : [],
        });
        if (obstruction !== null) {
          const expiredLease =
            io.isExpired?.(candidate.number) === true &&
            io.canReclaimExpired?.(candidate.number, live) === true;
          if (expiredLease) {
            if (!dryRun) await io.releaseExpired?.(candidate.number);
          } else {
            obstructed.push({ number: candidate.number, reason: obstruction });
            continue;
          }
        }
        // Asked in BOTH modes, from one code path, because that is what keeps a
        // dry run's reason text identical to the real claim's — the whole point
        // of the check is that the gate and the iteration agree. In the real
        // mode it reads, a moment early, the same state `writeClaim` is about to
        // refuse on. A candidate a label or an open PR already obstructed has
        // `continue`d above, so those messages still win.
        const leaseHeld = io.leaseObstruction?.(candidate.number) ?? null;
        if (leaseHeld !== null) {
          obstructed.push({ number: candidate.number, reason: leaseHeld });
          continue;
        }
        if (!dryRun) await io.claim(candidate.number);
        taken.push(named(candidate));
      } catch (error) {
        // Throttling is not about this candidate: every later read would meet
        // the same limit, and recording it as an obstruction would report a busy
        // backlog ("every candidate is held") for what is a GitHub wait.
        if (isRateLimited(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        obstructed.push({ number: candidate.number, reason: message });
      }
    }
    if (taken.length === 0) continue;
    // A dry run verified the first ticket and reports the unit as OFFERED, so
    // the caller sees the size of the batch a real call would take.
    const tickets = dryRun ? unit.tickets.map(named) : taken;
    return { ticket: tickets[0] ?? null, tickets, bucket: unit.bucket, claimed: !dryRun, obstructed };
  }
  return { ticket: null, tickets: [], bucket: null, claimed: false, obstructed };
}

/**
 * `takeOne`, then — only when the frontier offered nothing and nothing was
 * obstructed — the plan's closable parent as a unit of its own (#810). Before
 * this the prompt told an idle loop to close that parent by hand, with no
 * claim, and two loops raced on it. Routed through `takeOne` so the parent
 * meets the same live re-read, loop-label fence and lease as any ticket: one
 * held on the live read lands in `obstructed`, not in a second loop's hands.
 *
 * `closure` is null for a role that never closes parents (the triager). Its
 * `parent()` never throws by contract; a throw is still caught here and read
 * as "no closure parent", because a broken plan must not cost the loop its
 * ordinary answer. Its `claim` writes label and lease with no state move:
 * closing a spec is not starting it.
 */
export async function takeOneOrClosure(
  units: FrontierUnit[],
  io: Parameters<typeof takeOne>[1],
  closure: { parent(): Promise<Ticket | null>; claim(n: number): Promise<void> } | null,
  options: { dryRun?: boolean } = {},
): Promise<TakeOneOutcome> {
  const outcome = await takeOne(units, io, options);
  if (closure === null || outcome.ticket !== null || outcome.obstructed.length > 0) return outcome;
  let parent: Ticket | null = null;
  try {
    parent = await closure.parent();
  } catch {
    parent = null;
  }
  if (parent === null) return outcome;
  const closed = await takeOne([{ bucket: "ready", tickets: [parent] }], { ...io, claim: closure.claim }, options);
  return closed.ticket === null ? closed : { ...closed, closure: true };
}

/** The result of a claim aimed at one known issue. */
export interface ClaimByNumberOutcome {
  number: number;
  /** The label that was written, or would have been. */
  label: string;
  claimed: boolean;
  /**
   * What refused the claim, or null when it was written: the wording
   * `loopClaimObstruction` uses, or — from `claimByNumberWithLock` — the lease
   * store's, when a live lease settled it without asking GitHub.
   *
   * Refusal is an OUTCOME rather than an error because losing a race is the
   * ordinary case this path exists to handle: the caller asked for one issue,
   * somebody else has it, and that is an answer. "Somebody" includes THIS loop:
   * the fence reads every roster claim label without excepting the caller's
   * own, so an issue this loop already holds is refused too, and a caller that
   * means to resume its own work must read the label rather than re-claim it.
   * Nor is there an expired-lease escape here, as `takeOne` has: this path
   * claims what it was told to claim or refuses, and releasing somebody else's
   * lapsed claim is a decision its caller has to make in the open.
   */
  refusal: string | null;
}

/** The reads and the write `claimByNumber` needs, injected so a test can watch both. */
export interface ClaimByNumberIo {
  readLive(n: number): Promise<LiveIssue>;
  claim(n: number, label: string): Promise<void>;
  /**
   * A property rather than a method for the same reason as `takeOne`'s: it is
   * passed on rather than called here, and a method shorthand arrives unbound.
   */
  isOpenPr?: IsOpenPr;
}

/**
 * Claim one issue the caller already chose, rather than one the frontier
 * offered. A role whose intake is its own scanner — the ci-doctor, which finds
 * its case in Buildkite and not in the backlog — needs the claim without the
 * selection, and reaching it by pretending the frontier picked the ticket
 * would mean teaching the frontier about work it cannot see.
 *
 * The fence is the same one single-ticket mode uses, `loopClaimObstruction`: a
 * live re-read immediately before the write, refusing any assignee and any
 * roster loop's `-wip` or `-blocked` whatever that loop's role. Nothing here
 * re-implements it, because a second definition of "already held" is a second
 * chance for the two to disagree.
 *
 * A live read that FAILS throws, where `takeOne` would record it and move on.
 * The difference is that there is no next candidate: a caller that cannot tell
 * free from held must not claim, and reporting "refused" would be a lie about
 * a read that never happened.
 */
export async function claimByNumber(
  number: number,
  label: string,
  io: ClaimByNumberIo,
): Promise<ClaimByNumberOutcome> {
  const live = await io.readLive(number);
  const refusal = await loopClaimObstruction(live, io.isOpenPr);
  if (refusal !== null) return { number, label, claimed: false, refusal };
  await io.claim(number, label);
  return { number, label, claimed: true, refusal: null };
}

/**
 * `claimByNumber` against the real GitHub, under the claim lock every other
 * claim path holds — the whole point of the exercise, since a claim outside
 * that lock could land between another caller's re-read and its write and put
 * two loops on one issue.
 *
 * There is no dry-run escape here, unlike single-ticket mode, where the gate's
 * continuous poll must not hold the fence. This path always writes, so it
 * always takes the lock.
 *
 * A lease held by another live run arrives as a throw from `writeClaim` and is
 * reported as a refusal: it is the same "somebody else has it" the label check
 * reports, settled locally and without asking GitHub. Every other failure
 * still throws.
 */
export async function claimByNumberWithLock(
  number: number,
  options: { label?: string } = {},
): Promise<ClaimByNumberOutcome> {
  const label = options.label ?? wipLabelFor(currentLoop());
  // A label no fence reads is worse than no claim at all: `wipLabels()` is
  // built from the roster, so a claim written as `rafa2-wip` — or as some
  // unrelated label that happens to exist on the tracker — puts a lease in the
  // store saying the issue is held while every other loop walks straight over
  // it. `currentLoop` refuses an unrecognised loop NAME for exactly this
  // reason; an operator-supplied label is the same hole one step further out.
  if (!wipLabels().includes(label)) {
    throw new Error(
      `${label} is not a claim label of this project's loops (${wipLabels().join(", ")}) — ` +
        "a claim no fence reads would leave the issue open to every other loop",
    );
  }
  const io: ClaimByNumberIo = {
    readLive: readLiveIssue,
    claim: writeClaim,
    isOpenPr: async (n: number): Promise<boolean> =>
      (JSON.parse(await readGh(["pr", "view", String(n), "--json", "state"])) as { state: string })
        .state === "OPEN",
  };
  return withClaimLock(await claimLockPath(), async () => {
    try {
      return await claimByNumber(number, label, io);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("lease ")) return { number, label, claimed: false, refusal: message };
      throw error;
    }
  });
}

const CLAIM_LOCK_NAME = "next-tasks-claim.lock";
/** How long to wait for the holder before giving up. */
const CLAIM_LOCK_TIMEOUT_MS = 60_000;
/** How often to retry while waiting. */
const CLAIM_LOCK_POLL_MS = 100;
/**
 * The age fallback for deciding a lock is abandoned. Liveness is normally
 * settled by the holder's pid, which is exact; this only covers a lock whose
 * token cannot be parsed — hand-written, truncated, or left by a future format
 * — where refusing to ever break it would wedge every later caller.
 */
const CLAIM_LOCK_STALE_MS = 120_000;

/**
 * Where the claim lock lives: the git directory shared by every worktree of
 * this clone. A second Ralph loop IS a second worktree, so both callers
 * resolve the same path and therefore the same lock. Falls back to the temp
 * directory when git cannot answer, which keeps the fence up for a caller run
 * outside a worktree rather than silently dropping it.
 *
 * This is a single-machine fence, and deliberately so. The collision it exists
 * to stop is two local supervisors that polled the same frontier on the same
 * interval and walked into the claim together; two loops on two machines would
 * need the tiebreak to move to GitHub itself, at the cost of a round-trip the
 * local case should not have to pay. Being single-machine is also what lets
 * `pidIsAlive` ask the OS about the holder instead of guessing from a clock.
 */
export async function claimLockPath(): Promise<string> {
  try {
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    if (common !== "") return join(common, CLAIM_LOCK_NAME);
  } catch {
    // No git, or not a repository: the temp directory still fences two callers
    // on this machine, which is every caller this lock is meant to arbitrate.
  }
  return join(tmpdir(), CLAIM_LOCK_NAME);
}

/** The pid a lock token names, or null when the token is not one we wrote. */
function holderPid(token: string): number | null {
  const pid = Number(token.split(":")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether a process still exists. Signal 0 runs every permission check and
 * delivers nothing, so it answers "is this pid alive" without disturbing it;
 * `EPERM` means alive but owned by another user, which is still alive.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock may be broken. A token we wrote is judged ONLY by whether its
 * process is still alive — age is not consulted, because a clock cannot tell a
 * dead holder from a slow one, and breaking a live walk silently restores the
 * double claim underneath a fence still reporting success.
 *
 * Age is the fallback for a token we cannot parse — hand-written, truncated,
 * or from a future format — where there is no pid to ask about and refusing to
 * ever break it would wedge every later caller.
 */
function lockIsAbandoned(holder: string, ageMs: number, staleMs: number): boolean {
  const pid = holderPid(holder);
  return pid === null ? ageMs > staleMs : !pidIsAlive(pid);
}

/**
 * Remove the lock, but only while it still holds `token`. Both removal paths
 * go through here — the ordinary release, and breaking a lock the caller has
 * judged abandoned — because both face the same hazard: between deciding to
 * remove and removing, the file can be released and re-acquired by somebody
 * else, and an unconditional unlink would delete THAT caller's live lock and
 * put two walks inside the critical section.
 *
 * Whether a lock deserves removing is the caller's judgement; this only
 * enforces that the thing removed is the thing that was judged.
 *
 * Returns whether the lock is now gone, which the acquire loop needs: a
 * removal that FAILED — a read-only filesystem, no permission on the git
 * directory — leaves a file that will be judged abandoned again on the next
 * pass, and a caller that retried on that answer would spin on it forever.
 * False also covers the ordinary case where the token did not match, because
 * somebody else holds the lock: the caller must wait either way, and both
 * answers mean the same thing to it — the file is still there.
 *
 * A window remains between the read and the unlink. It cannot be closed
 * without an atomic compare-and-delete the filesystem does not offer, and it
 * is microseconds wide against the seconds-wide window this lock exists to
 * close.
 */
function releaseIfHeldBy(lockPath: string, token: string): boolean {
  try {
    if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath, { force: true });
    return !existsSync(lockPath);
  } catch {
    // Released or replaced between the judgement and here: not ours to remove.
    return !existsSync(lockPath);
  }
}

/**
 * Hold an exclusive lock for the duration of `critical`, so that only one
 * caller at a time can walk the candidates and write a claim.
 *
 * The re-read inside `takeOne` narrows the window between deciding a ticket is
 * free and saying so; it cannot close it. `gh issue edit --add-label` is not a
 * compare-and-swap, and adding a label that is already there succeeds, so two
 * callers that arrive together both read the ticket as free, both write, and
 * BOTH are told they won. That is not a rare interleaving: building the graph
 * takes seconds and dominates the call, so two callers started together reach
 * the write within milliseconds of each other. Frontier gating makes it likelier
 * still, by design — two supervisors on one interval see the frontier widen on
 * the same poll.
 *
 * Serialising the walk turns those concurrent callers into the sequential case
 * the re-read already handles correctly: the second one reads the label the
 * first one wrote, is obstructed, and is offered the next tree.
 *
 * The lock covers ONLY the walk, never the graph build. The build is the
 * expensive part and it is read-only, so both callers still do it in parallel;
 * a stale snapshot is safe precisely because the re-read runs under the lock.
 *
 * Abandonment is decided by asking the OS whether the holder still exists, not
 * by how old the lock is — see `lockIsAbandoned`.
 */
export async function withClaimLock<T>(
  lockPath: string,
  critical: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CLAIM_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CLAIM_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? CLAIM_LOCK_STALE_MS;
  // The pid decides liveness; the uuid makes the token unique across pid reuse
  // and across two callers that somehow share one. Both halves are read back:
  // the pid by `pidIsAlive`, the whole token by every unlink.
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      // Read the holder BEFORE judging it, and judge only what was read: the
      // token is what authorises the unlink below.
      let holder: string | null = null;
      try {
        holder = readFileSync(lockPath, "utf8");
      } catch {
        // Released underneath us — retry immediately and take it.
      }
      if (holder !== null) {
        let ageMs = 0;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          // Gone between the read and the stat: the retry below picks it up.
        }
        // Retry at once ONLY if the file is actually gone: having just freed
        // it, reporting that another caller is holding it would be false. If
        // the removal failed — no permission, read-only filesystem — fall
        // through instead, because the next pass would judge the same file
        // abandoned again and a retry here would spin without ever sleeping
        // or reaching the deadline below.
        if (lockIsAbandoned(holder, ageMs, staleMs) && releaseIfHeldBy(lockPath, holder)) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire the claim lock at ${lockPath} within ${timeoutMs}ms — ` +
            `another caller is holding it. Remove the file if no loop is running.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await critical();
  } finally {
    // Nothing to do with the answer here: the critical section is over
    // either way, and a lock we could not remove is one the next caller will
    // break on liveness.
    releaseIfHeldBy(lockPath, token);
  }
}

/**
 * The flags this tool takes, parsed once at the top of `main`. An unknown flag
 * is an error that names EVERY unknown flag, not the first one: falling
 * through to the writing path on a typo would assign tickets the caller was
 * only trying to look at, so one misspelled mode has to stop the run before
 * any of them reach GitHub.
 */
export interface Flags {
  dryRun: boolean;
  tree: boolean;
  takeOne: boolean;
  /** The whole frontier as one JSON document, for a program that draws it. */
  json: boolean;
  excluded: number[];
  /**
   * Whose intake is asking. Defaults to `coder`, so every caller that never
   * heard of roles — and the rendered frontier, which has no role at all —
   * behaves exactly as before.
   */
  role: Role;
}

/**
 * The read-only fence for a loop session. Kept apart from `parseFlags` so that
 * stays pure: its own tests run inside loop sessions, where `RALPH_RUN_ID` is
 * set. `RALPH_RUN_ID` is the marker because `ralph.sh` exports it for every
 * session and nothing else does; `RALPH_LOOP_NAME` may sit in an operator's
 * shell, and treating that as a loop would take the bulk claim away from the
 * human it exists for. `--take-one` passes untouched: it is how loops claim.
 */
export function loopReadOnly(
  flags: Flags,
  env: Record<string, string | undefined>,
): { flags: Flags; notice: string | null } {
  const runId = env.RALPH_RUN_ID?.trim() ?? "";
  if (runId === "" || flags.takeOne || flags.dryRun) return { flags, notice: null };
  return {
    flags: { ...flags, dryRun: true },
    notice: `frontier: running inside a Ralph loop (RALPH_RUN_ID=${runId}), so this run is read-only, as --dry-run. Use --take-one to claim.`,
  };
}

const KNOWN_FLAGS = ["--dry-run", "--tree", "--take-one", "--exclude", "--json", "--role"] as const;

export function parseFlags(argv: string[]): Flags {
  const excluded: number[] = [];
  const unknown: string[] = [];
  let role: Role = DEFAULT_ROLE;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--role") {
      const named = argv[++i];
      // An unrecognised role is refused rather than defaulted: defaulting would
      // quietly hand a role's intake the coder's candidates, and the caller
      // would see a claim on work it never asked for.
      if (named === undefined || !isRole(named)) {
        throw new Error(`--role requires one of ${ROLES.join(", ")}; received ${named ?? "nothing"}`);
      }
      role = named;
      continue;
    }
    if (flag !== "--exclude") {
      if (!KNOWN_FLAGS.includes(flag as (typeof KNOWN_FLAGS)[number])) unknown.push(flag);
      continue;
    }

    const value = argv[++i];
    if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
      throw new Error(`--exclude requires a positive issue number; received ${value ?? "nothing"}`);
    }
    excluded.push(Number(value));
  }
  if (unknown.length > 0) {
    throw new Error(`unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.join(" ")}`);
  }
  const takeOne = argv.includes("--take-one");
  // The tree is a drawing for a human and single-ticket mode is consumed by a
  // program, so picking one silently hands a caller the other's output.
  if (takeOne && argv.includes("--tree")) {
    throw new Error("--take-one and --tree are mutually exclusive");
  }
  if (excluded.length > 0 && !takeOne) {
    throw new Error("--exclude is only valid with --take-one");
  }
  // Only single-ticket mode has an intake. The rendered frontier and the JSON
  // document are pictures of the whole backlog, and narrowing either to one
  // role's bucket would hide tickets from the report that exists to show them.
  if (role !== DEFAULT_ROLE && !takeOne) {
    throw new Error("--role is only valid with --take-one");
  }
  const json = argv.includes("--json");
  // The JSON frontier is a picture for a program, never a claim: a consumer
  // that only wants to draw the backlog must not be able to assign it.
  if (json && !argv.includes("--dry-run")) {
    throw new Error("--json is only valid with --dry-run");
  }
  if (json && (takeOne || argv.includes("--tree"))) {
    throw new Error("--json cannot be combined with --take-one or --tree");
  }
  return {
    dryRun: argv.includes("--dry-run"),
    tree: argv.includes("--tree"),
    takeOne,
    json,
    excluded: [...new Set(excluded)],
    role,
  };
}

/**
 * The single-ticket mode's whole output: one line of JSON, no colour escapes,
 * no prose, so a supervisor can hand the ticket number to a worker without
 * parsing a rendered terminal frontier. `claimed` is the caller's signal, and
 * it comes from the walk rather than from the flag: only a write means the
 * worker actually holds the ticket.
 *
 * `error` is what keeps a FAILURE from reading as an empty frontier. The two
 * are otherwise the same payload — no ticket, nothing obstructed — and
 * `ralph/prompt.md` §1 branches on this JSON, not on the exit status, so
 * without it a caller that could not even ask would report `ALL_BLOCKED` and
 * stop the loop. That is the one thing §1 says never to do: "never misreport
 * an API failure as `ALL_BLOCKED`".
 *
 * `loop` reports the identity the claim was written under. It is here because
 * the identity is resolved from the environment and the worktree rather than
 * passed in, so it is the one field a caller cannot derive from its own
 * arguments — and claiming under the wrong loop is otherwise silent, visible
 * only later as a label on an issue nobody expected to hold it.
 *
 * `route` is the Jav difficulty labels the walk was limited to, or null when
 * Jav is off. An empty frontier under a route means "nothing labelled for this
 * loop", which is a different thing to fix than an empty backlog.
 */
export function renderTakeOne(
  outcome: TakeOneOutcome,
  options: {
    dryRun: boolean;
    error?: string;
    /** Set when `error` is GitHub throttling; see `github-rate-limit.ts`. */
    rateLimit?: { retryAfterSeconds: number | null } | null;
    loop?: LoopName;
    route?: string[] | null;
    /** From `waitingOnOperator`; printed only on an empty, error-free pick. */
    waitingOnOperator?: Record<HumanReason, number> | null;
  },
): string {
  const { ticket, obstructed } = outcome;
  // Only when nothing was offered and the read succeeded: an empty frontier is
  // where "what is the operator sitting on" answers why, and on every other
  // pick the JSON stays byte for byte what callers already parse.
  const waiting =
    ticket === null && options.error == null && options.waitingOnOperator != null
      ? { waitingOnOperator: options.waitingOnOperator }
      : {};

  return JSON.stringify({
    ticket: ticket?.number ?? null,
    title: ticket?.title ?? null,
    tree: ticket?.tree ?? null,
    // Only on an urgent offer: §1 of `prompt.md` reads this object field by
    // field, and a key that appeared on every hand-over would read as a
    // priority decision on tickets where nobody made one.
    ...(ticket?.urgent === true ? { urgent: true } : {}),
    loop: options.loop ?? null,
    route: options.route ?? null,
    // A coder's hand-over is one ticket from one bucket, and its JSON says so
    // in the three fields above. `bucket` and `tickets` appear only for a role
    // whose unit is something else, so `--take-one` prints byte for byte what
    // it printed before for every caller that had one. Numbers, not objects,
    // matching how `ticket`/`title`/`tree` are already flattened — and on a
    // dry run they are the unit as OFFERED, of which only the first was
    // verified, which `dryRun: true` in the same object is what says.
    ...(outcome.bucket === null || outcome.bucket === "ready"
      ? {}
      : { bucket: outcome.bucket, tickets: outcome.tickets.map((t) => t.number) }),
    // Only on a parent-closure hand-over (#810), like `urgent`: every other
    // caller's JSON stays byte for byte what it was.
    ...(outcome.closure === true ? { closure: true } : {}),
    claimed: outcome.claimed,
    dryRun: options.dryRun,
    obstructed,
    ...waiting,
    error: options.error ?? null,
    // `rateLimited` separates "GitHub throttled the read; it lifts on its own"
    // from every other `error`. prompt.md §1 ends RETRY_LATER on it, and the
    // gate waits it out with backoff instead of reporting an unreadable frontier.
    rateLimited: options.rateLimit != null,
    retryAfterSeconds: options.rateLimit?.retryAfterSeconds ?? null,
  });
}

/**
 * Read independent censuses together. The open issues arrive with their
 * blockers (`readOpenIssuesWithBlockers`); only a ticket whose blocker list
 * did not fit one page is read per ticket.
 */
export async function readFrontierInputs(
  io: {
    gh(args: string[]): Promise<string>;
    nativeBlockers(number: number): Promise<BlockerRef[]>;
  } = { gh: readGh, nativeBlockers },
): Promise<{ raw: RawIssue[]; closed: ClosedIssue[]; openPrs: OpenPullRequest[]; natives: BlockerRef[][] }> {
  const read = async <T>(args: string[]): Promise<T> => JSON.parse(await io.gh(args)) as T;
  const openIssues = readOpenIssuesWithBlockers(io);

  // The census is bounded by this limit: past 1000 closed issues the oldest
  // children fall out of it, and a spec could flip back to staffable — and be
  // assigned — at exactly the moment the census exists to prevent that.
  // Through the GitHub adapter, unpinned: the same `issue list` it always was.
  const closedIssues = createGithubTracker({ repo: "", owner: "", pinned: false, gh: io.gh, read: io.gh }).closedIssues();

  // One bulk call for the whole census, never one per ticket. Drafts are
  // included: a draft PR claims the ticket exactly as a ready one does.
  //
  // Bounded like the closed-issue census above, and the truncation matters
  // more here: `gh pr list` returns newest first, so the PRs that fall out
  // past the bound are the OLDEST — which are exactly the long-lived ones
  // this fence exists for. A ticket whose only PR is past the bound renders
  // under READY NOW, and a person reading that picks up work a PR already
  // carries. The claim paths survive it for a PR that closes the ticket,
  // because the live re-read probes the issue's own linked PRs rather than
  // this census. A reference or a parent's PR is seen only here, and the
  // display reads only here — so a truncated census is reported rather than
  // absorbed.
  const pullRequests = read<(OpenPullRequest & { body?: string | null })[]>([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(OPEN_PR_CENSUS_LIMIT),
    "--json",
    "number,closingIssuesReferences,body",
  ]).then((prs) =>
    prs.map(({ number, closingIssuesReferences, body }): OpenPullRequest => {
      const references = parseBodyReferences(body).map((n) => ({ number: n }));
      return { number, closingIssuesReferences, ...(references.length > 0 ? { references } : {}) };
    }),
  );

  const issuesWithDependencies = openIssues.then(async ({ raw, natives }) => ({
    raw,
    natives: await pooled(raw, API_CONCURRENCY, (issue) => {
      const known = natives.get(issue.number);
      return known !== undefined ? Promise.resolve(known) : io.nativeBlockers(issue.number);
    }),
  }));
  // Attach handlers to every branch immediately, including dependencies. A
  // failed census must not leave a later API rejection unhandled.
  const [{ raw, natives }, closed, openPrs] = await Promise.all([
    issuesWithDependencies,
    closedIssues,
    pullRequests,
  ]);
  return { raw, closed, openPrs, natives };
}

/**
 * The census from the project's own tracker: GitHub's exactly as before, or a
 * Linear or Jira project's built from its `Tracker` (felipearos/ralph#333).
 */
export async function readProjectFrontierInputs(): Promise<Awaited<ReturnType<typeof readFrontierInputs>>> {
  const tracker = frontierTracker();
  return tracker.kind === "github" ? readFrontierInputs() : readKeyedFrontierInputs(tracker);
}

/**
 * A keyed tracker's census in the shape the GitHub census returns, so the
 * graph, the fences and the claim cannot tell them apart.
 *
 * Its blockers are the tracker's own (complete, the adapter's promise) and its
 * parent rides on the issue, behind `## Parent` prose. Pull requests are still
 * GitHub's: the tracker cannot see them, so each open PR is tied to a ticket
 * by its branch or body (`linkKeyedPullRequests`).
 */
export async function readKeyedFrontierInputs(
  tracker: Tracker,
  io: { gh(args: string[]): Promise<string> } = { gh: readGh },
): Promise<Awaited<ReturnType<typeof readFrontierInputs>>> {
  const key = tracker.ref(1).replace(/-1$/, "");
  const [open, closed, heads] = await Promise.all([
    tracker.openIssues(),
    tracker.closedIssues(),
    io
      .gh(["pr", "list", "--state", "open", "--limit", String(OPEN_PR_CENSUS_LIMIT), "--json", "number,headRefName,body"])
      .then((out) => JSON.parse(out) as OpenPullRequestHead[]),
  ]);
  return {
    raw: open.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      author: issue.author === null ? null : { login: issue.author },
      comments: issue.comments,
      parent: issue.parent,
    })),
    closed,
    openPrs: linkKeyedPullRequests(heads, key, loopRoster()),
    natives: open.map((issue) => issue.blockers ?? []),
  };
}

/**
 * Take-one's failure line. This mode's contract is one line of JSON, and
 * `ralph/prompt.md` §1 parses it without a guard, so a failure has to still
 * LOOK like an answer or the iteration dies in JSON.parse. But it must not
 * look like an EMPTY one: §1 reads an empty result with no obstructions as
 * "the frontier truly offered nothing" and stops the loop with ALL_BLOCKED.
 * `error` is what separates the two, and `rateLimited` separates a GitHub
 * throttle from every other error. The exit status is for shell callers:
 * `RATE_LIMITED_EXIT` (75) for a throttle, 1 otherwise.
 */
function reportTakeOneFailure(error: unknown, options: { dryRun: boolean }): void {
  const message = error instanceof Error ? error.message : String(error);
  const rateLimit = isRateLimited(error) ? { retryAfterSeconds: error.retryAfterSeconds } : null;
  console.log(
    renderTakeOne(
      { ticket: null, tickets: [], bucket: null, claimed: false, obstructed: [] },
      { dryRun: options.dryRun, error: message, rateLimit },
    ),
  );
  console.error(message);
  process.exitCode = rateLimit === null ? 1 : RATE_LIMITED_EXIT;
}

/** The pictures' `Ownership`: the plan's holds, and whether the roster runs a triager. */
async function readOwnership(): Promise<Ownership> {
  let triager = true;
  try {
    triager = loopsWithRole("triager", loopRosterEntries()).length > 0;
  } catch {
    // No readable roster: claim nothing is untriaged rather than guess.
  }
  return { held: await readPlanHolds(), triager };
}

/**
 * The project's live loop branches as ticket claims (#480). Never throws: an
 * unreadable roster or repository leaves the census exactly as it was before
 * branch claims existed.
 */
async function readProjectBranchClaims(openTickets: ReadonlySet<number>): Promise<Map<number, BranchClaim>> {
  try {
    const root = projectRoot();
    return await readBranchClaims({
      git: (args) => run("git", ["-C", root, ...args]),
      base: `origin/${resolveBaseBranch(root)}`,
      roster: loopRoster(),
      nowMs: Date.now(),
      maxAgeMs: branchClaimMaxAgeMs(),
      tickets: openTickets,
      warn: (line) => console.error(yellow(line)),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(yellow(`warning: branch claims unreadable, ignoring them: ${reason}`));
    return new Map();
  }
}

async function main(): Promise<void> {
  // Stderr, so stdout stays byte-for-byte what `--dry-run` prints.
  const { flags, notice } = loopReadOnly(parseFlags(process.argv.slice(2)), process.env);
  if (notice !== null) console.error(notice);
  const { dryRun, tree: asTree, takeOne: asTakeOne, json: asJson, excluded, role } = flags;

  let inputs: Awaited<ReturnType<typeof readFrontierInputs>>;
  try {
    inputs = await readProjectFrontierInputs();
  } catch (error) {
    // Take-one's contract is one line of JSON even when the census itself
    // fails — see the catch below. Before this, a census failure (the
    // throttled dependency reads of 2026-09-28) printed only a stack trace.
    if (!asTakeOne) throw error;
    reportTakeOneFailure(error, { dryRun });
    return;
  }
  const { raw, closed, openPrs, natives } = inputs;
  if (openPrs.length >= OPEN_PR_CENSUS_LIMIT) {
    console.error(
      yellow(
        `warning: the open-PR census hit its ${OPEN_PR_CENSUS_LIMIT}-PR bound. ` +
          `Tickets held by an older PR may be shown as ready. Raise OPEN_PR_CENSUS_LIMIT.`,
      ),
    );
  }

  const tickets = buildTickets(
    raw,
    natives,
    new Set(closed.map((i) => i.number)),
    openPrs,
    await readProjectBranchClaims(new Set(raw.map((i) => i.number))),
  );
  // One classification, shared by the print and the claim, so the two cannot
  // disagree about which tickets are ready — a second call would only be
  // equivalent by convention.
  const frontier = classify(
    tickets,
    closed.map((i) => parseParent(i.body ?? "")).filter((n): n is number => n !== null),
  );

  // Only tickets that actually have a linked PR reach this, so it stays cheap.
  const isOpenPr = async (n: number): Promise<boolean> =>
    (JSON.parse(await readGh(["pr", "view", String(n), "--json", "state"])) as { state: string })
      .state === "OPEN";

  // The one JSON line is the whole output here: mixing in the human frontier
  // would hand a program prose to parse.
  if (asTakeOne) {
    // A dry run writes nothing, so it cannot collide with anyone and takes no
    // lock. That is not just an optimisation: the frontier gate polls this
    // mode continuously, and a poller allowed to hold the fence could block a
    // caller that actually wants to claim.
    try {
      // Inside the try, and resolved even on a dry run: a loop whose name
      // nothing recognises has no claim fence, and the gate's read-only poll
      // is where that should surface — reported as this mode's `error`, which
      // `prompt.md` §1 reads, rather than thrown past the JSON contract.
      const loop = currentLoop();
      const claimLabel = wipLabelFor(loop);
      // Jav: with difficulty routing on, this loop sees only the tickets
      // labelled for it. Filtered here, after the loop is known and inside the
      // try, so a broken `jav.json` is this mode's `error` rather than a
      // frontier quietly open to every loop.
      const project = currentProjectId(projectRoot());
      // Routing is written per coder, so a role it does not cover reports no
      // route at all rather than an empty one — an empty route would filter a
      // triager's whole intake away, and `null` is already what every loop sees
      // with Jav off.
      // Read at most ONCE per pick, and only when something asks: the route and
      // the configured labels are two halves of one answer (`roleUnits` needs
      // both, `jav.ts`), and two reads could pair a route from one revision of
      // the file with a configured set from another. Not pinned by a test — it
      // would take a seam for the reader to count reads here — so the memo is
      // the guarantee; keep them one read. Lazy, so a role that is not
      // `javRouted` and asks for no labels touches no `jav.json` at all; a
      // routed one reads it whether or not routing turns out to be enabled.
      let jav: JavConfig | null = null;
      const readOnce = (): JavConfig => (jav ??= readJav(javPath(), project, loopRosterEntries()));
      const route = roleDescriptor(role).javRouted ? javLabelsFor(readOnce(), loop) : null;
      const units = roleUnits(role, tickets, frontier, {
        route,
        excluded: new Set(excluded),
        // Strict, unlike the report's warn-and-carry-on reader: a bucket
        // DEFINED by which labels a ticket lacks cannot be computed from a
        // `jav.json` that would not parse, and answering "nothing is untriaged"
        // there would park the triager on a file nobody was told about. The
        // throw becomes this mode's `error`, which is where the caller looks.
        //
        // `labels` whether or not routing is `enabled`, matching what the report
        // has always shown: labelling the backlog is a triager's job BEFORE
        // anyone turns routing on, and a bucket that stayed empty until then
        // would leave nothing to turn on. With routing off a coder's route is
        // `null`, so it sees those tickets too and the two roles can reach for
        // one ticket — bounded, deliberately, by the fence every claim goes
        // through: the second one reads the first one's label and is offered the
        // next candidate, exactly as two coders are.
        javLabels: () => readOnce().labels,
        ...(role === "triager" ? { keyed: triageKeyed() } : {}),
        parks: () => readParks(),
      });
      const io = {
        readLive: readLiveIssue,
        isOpenPr,
        ...claimLeaseIo({ path: leasePathFromGit(), identity: leaseIdentity() }),
        // A triager claims by label only: see `writeClaim`.
        claim: (n: number): Promise<void> => writeClaim(n, claimLabel, { move: role !== "triager" }),
      };
      // One lock for the whole unit: a routing batch's ten label writes are one
      // hand-over, and letting another triager in halfway through would split a
      // batch across two claims.
      // A coder whose frontier is empty may close a plan parent instead (#810);
      // a triager never does. Inside the same lock, so the parent is fenced by
      // the very claim that fences tickets.
      const closure =
        roleDescriptor(role).frontierBucket === "ready"
          ? {
              parent: async (): Promise<Ticket | null> => {
                try {
                  const fences = await readProjectPlanFences();
                  const skip = new Set(excluded);
                  const open: OpenIssue[] = [...tickets.values()].map((t) => ({
                    number: t.number,
                    body: t.body,
                    parent: t.parent,
                    labels: [...t.labels],
                    assignees: t.assignees,
                  }));
                  const n = closableParent(
                    fences.closureParents.filter((p) => !skip.has(p)),
                    open,
                  );
                  return n === null ? null : (tickets.get(n) ?? null);
                } catch {
                  return null;
                }
              },
              claim: (n: number): Promise<void> => writeClaim(n, claimLabel, { move: false }),
            }
          : null;
      const outcome = dryRun
        ? await takeOneOrClosure(units, io, closure, { dryRun })
        : await withClaimLock(await claimLockPath(), () => takeOneOrClosure(units, io, closure, { dryRun }));
      // The start of the claim-to-hand-off clock (#578). A triager's claim is
      // routing work, not a ticket being built, so it starts no clock. The
      // recorder never throws and writes only to stderr, so stdout stays the
      // one JSON line.
      // A parent closure is maintenance, not a ticket being built: no clock.
      if (!dryRun && outcome.claimed && outcome.ticket !== null && role !== "triager" && outcome.closure !== true) {
        recordSpeedEvent("claimed", { ticket: String(outcome.ticket.number) });
      }
      // Read only when nothing was offered: the counts explain an empty pick,
      // and a claim should not wait on a plan or roster read. A failure here
      // drops the field rather than setting `error` — §1 of the prompts reads
      // `error` as "could not ask", and the pick itself succeeded.
      let waiting: Record<HumanReason, number> | null = null;
      if (outcome.ticket === null) {
        try {
          waiting = waitingOnOperator(tickets, frontier, await readOwnership());
        } catch {
          waiting = null;
        }
      }
      console.log(renderTakeOne(outcome, { dryRun, loop, route, waitingOnOperator: waiting }));
    } catch (error) {
      reportTakeOneFailure(error, { dryRun });
    }
    return;
  }

  // One document, no colour, no prose: the dashboard reads this the way the
  // supervisor reads `--take-one`, and it is the same buckets `render` prints.
  if (asJson) {
    const reasons = await readStuckReasons(stuckNumbers(tickets));
    console.log(
      JSON.stringify(
        frontierReport(
          tickets,
          frontier,
          closed,
          reasons,
          reportJavLabels(),
          owner(),
          await readOwnership(),
          triageKeyed(),
          readParks(),
        ),
      ),
    );
    return;
  }

  // UNTRIAGED is a dry-run view: the bulk claim prints what it printed before,
  // and reads no `jav.json` on its way to writing.
  console.log(
    asTree
      ? renderTree(tickets, frontier, buildTree(tickets, frontier, closed, await readOwnership()))
      : render(tickets, frontier, dryRun ? reportJavLabels() : []),
  );

  if (dryRun) {
    console.log("");
    console.log(dim(`--dry-run: nothing assigned to ${owner()}`));
    return;
  }

  // Claim exactly what was printed under READY NOW, under the same fence the
  // loop takes. Both paths write a claim off a snapshot, so a human running
  // /next while a loop is mid-walk is the same read-then-write race as two
  // loops — and the loop's locked re-read cannot see an assignee that lands
  // inside its own critical section.
  // How long THIS caller waits, not how long it may hold. The bulk path is the
  // one a human is watching, and the thing it waits on is a loop's walk, so it
  // is given room to outlast one rather than failing a hand-claim under a loop
  // that is behaving correctly. The loop deliberately keeps the shorter
  // default: it has somewhere to go when the wait fails — §1 reads `error` and
  // retries on the next iteration — and a person at a terminal does not.
  const results = await withClaimLock(
    await claimLockPath(),
    () => claimTickets(frontier.readyTasks, isOpenPr),
    { timeoutMs: 180_000 },
  );
  const claims = renderClaims(results);
  if (claims !== "") {
    console.log("");
    console.log(claims);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    console.error(error.message);
    process.exitCode = RATE_LIMITED_EXIT;
  }
}
