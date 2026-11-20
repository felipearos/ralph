#!/usr/bin/env bun
/**
 * Answer a confirmed regression on main by reverting the commit that caused it.
 *
 * Before this module the doctor's only answer to a red base branch was to file
 * the diagnosis for the coders (`prompts/ci-doctor.md` §2.2). That left main
 * red and the merge queue blocked for every loop until some coder picked the
 * ticket up — the whole project waiting on one scheduling accident. The
 * operator's decision on 2026-09-29 was that the doctor opens the revert
 * itself, through the ordinary checks, and files the forward fix behind it.
 *
 * Three subcommands, shaped as `ci-doctor/case-issue.ts`'s are:
 *
 *   decide <case key>   the eligibility verdict, and not one byte written
 *   run    <case key>   the revert path, or the urgent filing when ineligible
 *   failed <case key>   a revert PR went red or was dequeued; twice is the end
 *
 * What this module deliberately does NOT do is land the pull request. It opens
 * it and stops. Enqueueing is the project's own command, issued by the model
 * from the guidance at the top of its prompt, and the wait belongs to the
 * supervisor (`AWAIT_PR <pr> merge` → `pr-wait.ts`). There is no `gh pr merge`
 * here, no `@mergifyio queue`, and no path that edits `.mergify.yml` — a
 * revert is still an ordinary pull request, and the one thing worse than a red
 * main is an agent that can push past the checks protecting it.
 *
 * ## Why the bookkeeping lives in `store.reverts` and not on the case
 *
 * `mergeCases` (`ci-doctor/classify.ts:386`) rewrites a regression case's
 * `rule`, `culprit`, `evidence` and `cost72h` on every scan. A revert's issue,
 * pull request and round count kept there would be re-derived away. The store's
 * `reverts` map is keyed by culprit sha, which no classification proposes, so
 * `mergeCases` never touches it. It has existed since #160 shipped the
 * dashboard panel that reads it; this module is its missing writer.
 *
 * ## Why every step is found before it is written
 *
 * The revert path makes five remote writes in a row. A crash between any two
 * must leave the next run FINISHING rather than duplicating, so each write has
 * a marker that identifies it: `caseMarker` for the two issues, and the
 * culprit-scoped markers below for the "has this culprit been reverted at all"
 * question. That last one is searched in the `ci-health` registry and not only
 * read from the store, because a lost store must not be able to buy a second
 * revert of the same commit.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { CLAIM_REFUSED_EXIT } from "../claim-lease";
import { DEFAULT_NEVER_TOUCH, matchesGlob } from "../executor-guard/diff-guard";
import { isRateLimited, RATE_LIMITED_EXIT } from "../frontier/github-rate-limit";
import { URGENT_LABEL } from "../frontier/next-tasks";
import { projectRoot } from "../paths";

import {
  ensureCaseIssue,
  fileForCoders,
  flagValue,
  knownIssue,
  liveCaseIssueIo,
  recordFiled,
  recordHandedOff,
  type CaseIssueIo,
  type StoreIo,
} from "./case-issue";

import { tried, write } from "./gh";
import type { Ran } from "./gate";
import { ghRunner } from "./gate";
import { readStore, storePathFromGit, withStore, type Case, type CiHealthStore, type Revert } from "./store";

const PREFIX = "revert";

/** A revert PR red or dequeued this many times is the end of the road for that culprit. */
export const MAX_REVERT_ROUNDS = 2;

/* --------------------------------------------------------------------------
 * Identity. Three markers, each answering a different question.
 * ----------------------------------------------------------------------- */

/**
 * "Has this culprit been reverted at all?" — the one marker in #162's own
 * wording, so it is written literally. It goes on the revert ISSUE and on the
 * revert pull request, and the eligibility search looks for it across every
 * `ci-health` issue whatever its state: a revert that was opened and closed
 * still used this culprit's one attempt.
 */
export const revertMarker = (sha: string): string => `<!-- ci-doctor revert culprit=${sha} -->`;

/** "Has the forward fix been filed?" Separate, because the two issues are filed a write apart. */
export const forwardMarker = (sha: string): string => `<!-- ci-doctor forward-fix culprit=${sha} -->`;

/**
 * "Has the culprit's own ticket been told — about THIS?" One comment per kind,
 * on the issue and on the PR.
 *
 * The kind is in the marker because the two notices say opposite things and
 * share a culprit. With one marker between them, the abandon path found the
 * revert's own notice already present and wrote nothing at all, so the author
 * of a reverted change was never told the revert had been closed and the
 * regression handed to the coders.
 */
export type NoticeKind = "revert" | "urgent" | "abandoned";
export const noticeMarker = (sha: string, kind: NoticeKind): string =>
  `<!-- ci-doctor revert-notice kind=${kind} culprit=${sha} -->`;

/**
 * The marker keys the two issues are found by.
 *
 * Neither is ever a key in `store.cases`: `mergeCases` deletes any case key a
 * classification does not propose, so a `revert:` entry there would survive
 * exactly until the next scan. They exist only as `caseMarker` identities.
 */
export const revertCaseKey = (sha: string): string => `revert:${sha}`;
export const forwardCaseKey = (sha: string): string => `forward-fix:${sha}`;

const short = (sha: string): string => sha.slice(0, 10);

/* --------------------------------------------------------------------------
 * Config. Read leniently, never through `project-config.ts`.
 * ----------------------------------------------------------------------- */

/** Reverting is on unless the project turns it off. #162's stated default. */
export const AUTO_REVERT_DEFAULT = true;

type RawConfig = { ciDoctor?: { autoRevert?: unknown; neverTouch?: unknown } } | null | undefined;

/**
 * Whether the project lets the doctor revert.
 *
 * `project-config.ts:432` already refuses anything but a boolean, and this
 * still reads leniently, for the reason `ci-doctor/retry.ts:190` gives: the
 * object reaching a doctor module is a raw parse, and a malformed value must
 * fall to the SAFE side. Here safe is the documented default rather than
 * `false`, because a project that never mentions `autoRevert` is asking for
 * #162's behaviour, not opting out of it.
 */
export function autoRevert(config: unknown): boolean {
  const value = (config as RawConfig)?.ciDoctor?.autoRevert;
  return typeof value === "boolean" ? value : AUTO_REVERT_DEFAULT;
}

/** The project's `neverTouch` globs, or the diff guard's default. One matcher, imported. */
export function neverTouchOf(config: unknown): readonly string[] {
  const value = (config as RawConfig)?.ciDoctor?.neverTouch;
  if (!Array.isArray(value)) return DEFAULT_NEVER_TOUCH;
  const globs = value.filter((glob): glob is string => typeof glob === "string" && glob.trim() !== "");
  return globs.length === 0 ? DEFAULT_NEVER_TOUCH : globs;
}

/* --------------------------------------------------------------------------
 * Eligibility. Pure: every fact it needs is an argument.
 * ----------------------------------------------------------------------- */

/** A commit subject that opens a revert, as `git revert` writes it. */
const REVERT_SUBJECT = /^Revert ["']/;
/** `git revert`'s own body trailer. */
const REVERTS_TRAILER = /\bThis reverts commit\b/;
/** Any culprit-scoped revert marker, wherever it is quoted. */
const ANY_REVERT_MARKER = /<!--\s*ci-doctor revert culprit=[0-9a-f]{7,40}\s*-->/;

export interface EligibilityArgs {
  /** The regression case key, `regression:<test id>`. */
  key: string;
  /** That case, as the store has it. Absent is itself a refusal. */
  case: Case | undefined;
  /** The project's raw `.ralph/config.json`. */
  config: unknown;
  /**
   * Whether a revert for this culprit already exists — store entry OR marker
   * found in the registry. The search is I/O, so the CALLER does it and this
   * stays pure; `revertExists` is what `existingRevert` below answers.
   */
  revertExists: boolean;
  /** The culprit commit's subject line. */
  culpritSubject: string;
  /** The culprit commit's body, without the subject. */
  culpritBody: string;
  /** Every path the culprit commit touched. */
  culpritFiles: readonly string[];
}

export type Verdict = { revert: true } | { revert: false; why: string[] };

/**
 * May the doctor revert this culprit?
 *
 * Every condition #162 lists except the clean apply, which cannot be answered
 * without touching a checkout and is `probeRevert` below. The refusals
 * accumulate rather than short-circuiting: the urgent filing quotes all of
 * them, and a coder reading "ambiguous" without also being told the commit was
 * itself a revert would go looking for the wrong thing.
 */
export function eligibility(args: EligibilityArgs): Verdict {
  const why: string[] = [];
  if (!autoRevert(args.config)) why.push("ciDoctor.autoRevert is false: this project files every regression");
  const value = args.case;
  if (value === undefined) why.push(`the store has no case ${args.key}`);
  else if (value.kind !== "regression") why.push(`${args.key} is a ${value.kind} case, not a regression on main`);
  const culprit = value?.culprit ?? null;
  if (value !== undefined && value.kind === "regression" && culprit === null) {
    why.push("the case names no culprit commit");
  }
  if (culprit !== null && !culprit.unambiguous) {
    why.push(
      culprit.why.length === 0
        ? "the culprit is ambiguous"
        : `the culprit is ambiguous: ${culprit.why.join("; ")}`,
    );
  }
  if (args.revertExists) why.push("a revert for this culprit already exists; one culprit gets one attempt");
  if (REVERT_SUBJECT.test(args.culpritSubject)) why.push("the culprit is itself a revert (its subject opens `Revert \"`)");
  else if (REVERTS_TRAILER.test(args.culpritBody)) why.push("the culprit is itself a revert (its body carries `This reverts commit`)");
  else if (ANY_REVERT_MARKER.test(`${args.culpritSubject}\n${args.culpritBody}`)) {
    why.push("the culprit is itself a revert (its message carries a ci-doctor revert marker)");
  }
  const fenced = neverTouchOf(args.config);
  const forbidden = args.culpritFiles.filter((path) => fenced.some((glob) => matchesGlob(glob, path)));
  if (forbidden.length > 0) {
    why.push(`the culprit touches ${forbidden.join(", ")}, which matches ciDoctor.neverTouch and is never the doctor's to edit`);
  }
  return why.length === 0 ? { revert: true } : { revert: false, why };
}

/* --------------------------------------------------------------------------
 * The reads.
 * ----------------------------------------------------------------------- */

export type Git = (args: string[]) => Ran;

/** `case-issue.ts`'s, re-exported so a caller of this module needs one import rather than two. */
export type { StoreIo };

export interface RevertIo extends CaseIssueIo {
  git: Git;
}

/** A `git` read whose failure is a fault: deciding from a half-read commit is how a wrong sha gets reverted. */
function read(io: Pick<RevertIo, "git">, args: string[]): string {
  const ran = io.git(args);
  if (!ran.ok) throw new Error(`git ${args.join(" ")} failed: ${(ran.stderr || ran.stdout).trim()}`);
  return ran.stdout;
}

export interface CulpritFacts {
  subject: string;
  body: string;
  files: string[];
}

/** The culprit commit as eligibility needs it: subject, body, and every path it touched. */
export function culpritFacts(io: Pick<RevertIo, "git">, sha: string): CulpritFacts {
  const subject = read(io, ["log", "-1", "--format=%s", sha]).trim();
  const body = read(io, ["log", "-1", "--format=%b", sha]);
  const files = read(io, ["show", "--name-only", "--format=", sha])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { subject, body, files };
}

export interface ExistingRevert {
  /** True when the store OR the registry says this culprit has had its attempt. */
  exists: boolean;
  /** The revert issue, when one was found by marker. */
  issue: number | null;
  /** How it was found, for the refusal's wording. */
  how: "store" | "marker" | null;
}

/**
 * Has this culprit already been reverted?
 *
 * The store is consulted first because it is free, and the registry second
 * because the store is a cache that a deploy, a version bump or an `rm` can
 * lose. #162's third condition is explicit that a lost store must not allow a
 * second revert, so the marker search is not an optimisation to skip — it is
 * the authority.
 */
export async function existingRevert(
  sha: string,
  store: CiHealthStore,
  io: Pick<RevertIo, "gh">,
): Promise<ExistingRevert> {
  const known = store.reverts[sha];
  if (known !== undefined) return { exists: true, issue: known.issue, how: "store" };
  const ran = await write(io, [
    "issue",
    "list",
    "--label",
    "ci-health",
    "--state",
    "all",
    "--limit",
    "50",
    "--search",
    `"ci-doctor revert culprit=${sha}" in:body`,
    "--json",
    "number,body",
  ]);
  // A non-array answer is NOT an empty one. "No revert exists" is the single
  // answer this function must never guess, because it is the one that buys a
  // second revert of the same commit — so anything but a list is a fault, the
  // way `case-issue.ts:187-191` reads the same shape as `"unreadable"`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout || "[]");
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`could not read the ci-health registry for ${short(sha)}: ${ran.stdout.trim()}`);
  }
  const rows = parsed as { number?: unknown; body?: unknown }[];
  // GitHub's search is a full-text index, so a row it returns has to be
  // re-checked against the literal marker here — the same re-check
  // `case-issue.ts:195` makes, and for the same reason.
  const marker = revertMarker(sha);
  for (const row of rows) {
    if (typeof row.body === "string" && row.body.includes(marker) && typeof row.number === "number") {
      return { exists: true, issue: row.number, how: "marker" };
    }
  }
  return { exists: false, issue: null, how: null };
}

/**
 * The issue a pull request closes, from its body.
 *
 * `--culprit-issue` is the model's to supply, and unlike `--culprit-pr` there
 * is no number in the store to fall back on — `Culprit` carries `pr` and not
 * an issue. So the fallback is the one place the link is written down: every
 * loop pull request links its ticket with `Closes #<n>` (§5.3), which is free
 * evidence here exactly as it is for `unpark.ts`'s `--pr` check. Degrades to
 * `null`, because the spec's comment on the culprit's ticket is worth having
 * and not worth failing a revert over.
 */
export async function closedBy(io: Pick<RevertIo, "gh">, pr: number): Promise<number | null> {
  const ran = await tried(io, ["pr", "view", String(pr), "--json", "body"]);
  if (ran === null) return null;
  const match = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/i.exec(ran.stdout);
  return match === null ? null : Number(match[1]);
}

/**
 * Whether a comment carrying this marker is already on an issue or pull
 * request — or `null` when that cannot be told.
 *
 * `tried`, not `write`: the numbers here come from `--culprit-pr` and
 * `--culprit-issue`, which the MODEL supplies from the evidence it read. A
 * transposed, deleted or transferred number would otherwise throw on the very
 * last step of the revert path, after the issue, the branch, the pull request
 * and the forward fix all exist — and the doctor would never be told the
 * number of the pull request it had just opened. `case-issue.ts:201-206` makes
 * the same call for the same reason: a number the cache remembers that cannot
 * be read is not a verdict on anything.
 */
export async function carries(
  io: Pick<RevertIo, "gh">,
  kind: "issue" | "pr",
  number: number,
  marker: string,
): Promise<boolean | null> {
  const ran = await tried(io, [kind, "view", String(number), "--json", "comments"]);
  return ran === null ? null : ran.stdout.includes(marker);
}

/* --------------------------------------------------------------------------
 * The clean-apply probe. The one condition that touches a checkout.
 * ----------------------------------------------------------------------- */

export interface Probe {
  clean: boolean;
  /** Null when it applied; otherwise git's complaint, for the urgent filing. */
  why: string | null;
  /** The scratch branch left behind holding the revert commit, when it applied. */
  branch: string | null;
}

/** The scratch branch the probe cuts. Renamed once step 1 yields an issue number. */
export const scratchBranch = (sha: string): string => `ci-doctor/revert-${short(sha)}`;

/**
 * Does `git revert --no-edit <sha>` apply on `origin/<base>`?
 *
 * There is no way to ask that question without doing it, and doing it IS the
 * step — the commit this leaves behind is the one that ships, because
 * `ci-doctor/verify.ts --revert-of` compares it through `revertSignature`
 * (`executor-guard/diff-guard.ts:758`) and anything reconstructed by hand
 * fails that exception. So the probe runs before the first `gh` call and backs
 * itself out completely on a conflict: `--abort`, detach, delete the branch.
 * A checkout that could not be returned to the base branch is a fault, not a
 * refusal — carrying on would commit the revert onto whatever is checked out.
 */
export function probeRevert(io: Pick<RevertIo, "git">, args: { sha: string; baseBranch: string }): Probe {
  const base = `origin/${args.baseBranch}`;
  const branch = scratchBranch(args.sha);
  read(io, ["rev-parse", "--verify", base]);
  // A dirty checkout makes `git revert` exit non-zero with "your local changes
  // would be overwritten", which is a local-state problem — and reading it as
  // "the revert conflicts" would file a perfectly revertable regression to the
  // coders as unrevertable. `.ralph/logs/` is gitignored, so the evidence file
  // is not the trigger; a part-done fix from §3 is.
  const dirty = read(io, ["status", "--porcelain"]).trim();
  if (dirty !== "") {
    throw new Error(`the checkout is not clean, so a revert of ${short(args.sha)} cannot be probed:\n${dirty}`);
  }
  // Detach first, because the scratch branch a crashed run left behind may be
  // the one this checkout is standing on, and neither `branch -D` nor
  // `switch -c` can touch the current branch.
  const detached = io.git(["switch", "--detach", base]);
  if (!detached.ok) throw new Error(`could not detach at ${base}: ${(detached.stderr || detached.stdout).trim()}`);
  // A scratch branch left by a crashed run is not evidence of anything: the
  // commit it holds was never pushed and never named in an issue. Cutting it
  // fresh is what makes this run's probe the one that decides.
  io.git(["branch", "-D", branch]);
  const cut = io.git(["switch", "-c", branch, base]);
  if (!cut.ok) throw new Error(`could not cut ${branch} from ${base}: ${(cut.stderr || cut.stdout).trim()}`);
  const reverted = io.git(["revert", "--no-edit", args.sha]);
  if (reverted.ok) return { clean: true, why: null, branch };
  const why = `${reverted.stderr}\n${reverted.stdout}`.trim() || `git revert --no-edit ${short(args.sha)} failed`;
  io.git(["revert", "--abort"]);
  const back = io.git(["switch", "--detach", base]);
  if (!back.ok) throw new Error(`the revert of ${short(args.sha)} did not apply and the checkout could not be returned to ${base}`);
  io.git(["branch", "-D", branch]);
  return { clean: false, why, branch: null };
}

/* --------------------------------------------------------------------------
 * The bodies. Every one of them must let a coder start without re-deriving.
 * ----------------------------------------------------------------------- */

export interface RevertRequest {
  /** The regression case key, `regression:<test id>`. */
  key: string;
  sha: string;
  testId: string;
  /** Null when the culprit commit names zero or several merged pull requests. */
  culpritPr: number | null;
  /** The culprit's own ticket, when its pull request names one. */
  culpritIssue: number | null;
  /** Whether the classification could narrow the culprit to one commit. Drives the filing's "candidate, not a verdict" wording. */
  ambiguous: boolean;
  loop: string;
  baseBranch: string;
  /** The evidence table: the first red build, the parent's green build, the failing line. */
  evidence: string;
  run: string;
  session: string;
  at: string;
}

const culpritName = (request: Pick<RevertRequest, "sha" | "culpritPr">): string =>
  request.culpritPr === null ? `\`${short(request.sha)}\`` : `#${request.culpritPr} (\`${short(request.sha)}\`)`;

/** `🤖 Ralph loop — run …` — §5.3's line, so the pull request is attributable by its content. */
export const provenanceLine = (request: Pick<RevertRequest, "loop" | "run" | "session">): string =>
  `🤖 ${request.loop.charAt(0).toUpperCase()}${request.loop.slice(1)} loop — run \`${request.run}\` · iteration session \`${request.session}\``;

export const revertIssueTitle = (request: Pick<RevertRequest, "sha" | "culpritPr" | "testId">): string =>
  `Revert ${request.culpritPr === null ? short(request.sha) : `#${request.culpritPr}`}: main red on ${request.testId}`;

export const forwardFixTitle = (request: Pick<RevertRequest, "sha" | "culpritPr" | "testId">): string =>
  `Re-land ${request.culpritPr === null ? short(request.sha) : `#${request.culpritPr}`} without breaking ${request.testId}`;

export function revertIssueBody(request: RevertRequest): string {
  return [
    revertMarker(request.sha),
    "",
    `\`${request.baseBranch}\` is red on **${request.testId}** and ${culpritName(request)} is the culprit.`,
    "",
    "The ci-doctor is opening a revert pull request for it through the ordinary required checks. No check is bypassed, no gate is overridden, and the forward fix is filed separately so the re-land is somebody's ticket rather than nobody's.",
    "",
    "## Evidence",
    "",
    request.evidence,
  ].join("\n");
}

export function revertPrBody(request: RevertRequest, issue: number): string {
  return [
    provenanceLine(request),
    "",
    revertMarker(request.sha),
    "",
    `Reverts ${culpritName(request)}, which turned \`${request.baseBranch}\` red on **${request.testId}**.`,
    "",
    `The diff is exactly \`git revert ${short(request.sha)}\` on \`origin/${request.baseBranch}\` — nothing else is in it, which is what lets the diff guard's exact-revert exception accept it (\`bun ci-doctor/verify.ts --revert-of ${request.sha}\`).`,
    "",
    "## Evidence",
    "",
    request.evidence,
    "",
    `Closes #${issue}`,
  ].join("\n");
}

export function forwardFixBody(request: RevertRequest, revertIssue: number, revertPr: number): string {
  return [
    forwardMarker(request.sha),
    "",
    `${culpritName(request)} turned \`${request.baseBranch}\` red on **${request.testId}** and has been reverted by #${revertPr}. This ticket is the re-land: the change was wanted, and it has to come back without that failure.`,
    "",
    `- The revert pull request: #${revertPr}`,
    `- The culprit pull request: ${request.culpritPr === null ? `\`${request.sha}\`` : `#${request.culpritPr}`}`,
    "",
    "## Evidence",
    "",
    request.evidence,
    "",
    "## Blocked by",
    "",
    `- #${revertIssue}`,
    "",
    `Do not start this before the revert above has merged: re-landing onto a \`${request.baseBranch}\` that is still red cannot be told from the failure it is meant to fix.`,
  ].join("\n");
}

/**
 * The one comment the culprit's own ticket and pull request get.
 *
 * `revertPr` is null on the urgent path, where the spec also wants the culprit
 * told — there the doctor did NOT revert, and saying so is the whole point of
 * the comment.
 */
export function culpritNotice(
  request: RevertRequest,
  kind: NoticeKind,
  revertPr: number | null,
  forwardIssue: number | null,
): string {
  const landed = `This landed as \`${short(request.sha)}\` and turned \`${request.baseBranch}\` red on **${request.testId}**`;
  const lines =
    kind === "revert"
      ? [
          `${landed}, so the ci-doctor has opened #${revertPr} to revert it.`,
          forwardIssue === null
            ? "The forward fix is being filed; it will link here."
            : `The re-land is tracked as #${forwardIssue}, blocked by the revert.`,
        ]
      : kind === "abandoned"
        ? [
            // The one shape that must not read as either of the others: a
            // revert WAS opened and has been given up on, which is the state
            // a reader would otherwise have to infer from a closed PR.
            `${landed}. The ci-doctor opened #${revertPr} to revert it, that revert failed its checks ${MAX_REVERT_ROUNDS} times, and it has been closed rather than retried.`,
            forwardIssue === null
              ? "The regression is being filed for the coders."
              : `The regression is now #${forwardIssue}, for a coder to revert by hand or fix forward.`,
          ]
        : [
            `${landed}. The ci-doctor did not revert it automatically.`,
            forwardIssue === null
              ? "The regression is being filed for the coders."
              : `It is filed as #${forwardIssue} for a coder to revert or fix forward.`,
          ];
  return [noticeMarker(request.sha, kind), "", ...lines, "", "Nothing here is a judgement on the change — it is wanted back, with that test passing."].join("\n");
}

/** The body of an urgent filing: the regression, the culprit, and why it was not reverted. */
export function urgentBody(request: RevertRequest, why: readonly string[]): string {
  return [
    `\`${request.baseBranch}\` is red on **${request.testId}**. The ci-doctor did **not** revert it, so this needs a coder.`,
    "",
    "## Why it was not reverted",
    "",
    ...why.map((line) => `- ${line}`),
    "",
    "## The culprit",
    "",
    request.ambiguous
      ? `**A candidate, not a verdict.** \`${request.sha}\`${request.culpritPr === null ? "" : ` (${culpritName(request)})`} is where the classification landed, but it could not be narrowed to one commit — treat the range around it as the suspect and read the evidence below before assuming it.`
      : `${culpritName(request)}.`,
    "",
    "## Evidence",
    "",
    request.evidence,
    "",
    `A red \`${request.baseBranch}\` blocks the merge queue for every loop, which is why this carries \`${URGENT_LABEL}\`.`,
  ].join("\n");
}

/* --------------------------------------------------------------------------
 * The writes.
 * ----------------------------------------------------------------------- */

export type OutcomeKind = "reverted" | "resumed" | "filed-urgent" | "nothing" | "refused" | "fault";

export interface Outcome {
  kind: OutcomeKind;
  why: string;
  issue: number | null;
  pr: number | null;
  forwardIssue: number | null;
  steps: string[];
}

const recordRevert = async (sha: string, value: Revert, store: StoreIo): Promise<void> => {
  await store.with(store.path, (held) => {
    held.reverts[sha] = { ...held.reverts[sha], ...value };
  });
};

/**
 * File the regression for the coders as urgent.
 *
 * Every refusal lands here, and so does a revert that ran out of rounds. The
 * `priority:urgent` label is a SECOND write because `fileForCoders` applies
 * `ci-health`, `ready-for-agent` and `bug` and nothing else — the same second
 * write `prompts/ci-doctor.md` §2.2 already tells the model to make by hand.
 */
export async function fileUrgent(
  request: RevertRequest,
  why: readonly string[],
  io: RevertIo,
  store: StoreIo,
  /**
   * Which notice the culprit's ticket gets, and the revert it refers to.
   *
   * An abandoned revert is not the same news as one never attempted, and the
   * abandoned wording names the pull request that was closed — so the kind
   * cannot travel without the number.
   */
  notice: { kind: Extract<NoticeKind, "urgent" | "abandoned">; pr: number | null } = { kind: "urgent", pr: null },
): Promise<Outcome> {
  const known = knownIssue(request.key, store);
  const filed = await fileForCoders(
    {
      key: request.key,
      title: `main red on ${request.testId}: revert ${culpritName(request)} or fix forward`,
      body: urgentBody(request, why),
      known,
      loop: request.loop,
    },
    io,
  );
  if (filed.issue === null) {
    return { kind: "fault", why: "GitHub could not be read for this case, so nothing was filed", issue: null, pr: null, forwardIssue: null, steps: [] };
  }
  const steps = [filed.created ? "filed" : "found"];
  await write(io, ["issue", "edit", String(filed.issue), "--add-label", URGENT_LABEL]);
  steps.push("urgent");
  // Without this the gate re-offers the case on every poll: it skips a
  // regression only when the state is `handed-off` or the recorded issue is
  // open (`ci-doctor/gate.ts:273-275`), and a filing that writes neither
  // leaves `cases[key].issue` null and the state `open`. `case-issue.ts`'s own
  // `runFile` records it for exactly this reason, and the urgent path has no
  // pull request for the shepherd branch to shield it with.
  await recordHandedOff(request.key, filed.issue, store);
  steps.push("recorded");
  // The spec's urgent filing comments once on the culprit's own ticket too —
  // the author of a reverted-or-not change learns about it there or nowhere.
  const told = await notify(request, notice.kind, notice.pr, filed.issue, io);
  if (told.wrote) steps.push("told the culprit's ticket");
  if (told.unreadable.length > 0) steps.push(`could not read ${told.unreadable.join(", ")}`);
  return {
    kind: "filed-urgent",
    why: `#${filed.issue} carries the regression for the coders — ${why.join("; ")}`,
    issue: filed.issue,
    pr: null,
    forwardIssue: null,
    steps,
  };
}

/** The revert branch, on the repo-wide `$RALPH_LOOP_NAME/<n>-…` convention (`roster-prompt.ts`). #162 wrote the prefix as `doc/`, which is what this renders for a doctor loop named `doc`; the loop name is per-project everywhere else, so it is read rather than assumed. */
export const revertBranch = (loop: string, issue: number, sha: string): string => `${loop}/${issue}-revert-${short(sha)}`;

/**
 * The pull request already open for this branch, if any.
 *
 * The one write in this path that a marker cannot find, because a pull request
 * carries no `ci-health` label and is not in the registry. Without this lookup
 * a crash between `gh pr create` and the store write wedges every later run:
 * `gh` refuses the second create, `write` turns that into a throw, and the
 * revert can never be finished or abandoned.
 */
export async function openPrFor(io: Pick<RevertIo, "gh">, branch: string): Promise<number | null> {
  const ran = await tried(io, ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", "number"]);
  if (ran === null) return null;
  try {
    const rows: unknown = JSON.parse(ran.stdout || "[]");
    if (!Array.isArray(rows)) return null;
    const numbers = rows.map((row) => (row as { number?: unknown }).number).filter((n): n is number => typeof n === "number");
    return numbers.length === 0 ? null : Math.min(...numbers);
  } catch {
    return null;
  }
}

/**
 * The revert path: issue, branch, pull request, forward fix, notice, store.
 *
 * `branch` is the scratch branch the probe left holding the revert commit, or
 * **null** when the store already records a pushed pull request. That second
 * case is why the probe is not simply re-run on a resume: `git revert` does not
 * produce the same COMMIT twice — the committer timestamp moves, so the new sha
 * is not an ancestor of the pushed one and `git push` is rejected as a
 * non-fast-forward. The commit already on the remote is the one CI judged and
 * the one `verify.ts --revert-of` accepted, so a resume leaves the branch
 * alone entirely. This is also what keeps §2.4's "the first round is yours to
 * fix on the branch" true: a re-run must not delete the doctor's own fix.
 */
export async function openRevert(
  request: RevertRequest,
  branch: string | null,
  io: RevertIo,
  store: StoreIo,
): Promise<Outcome> {
  const steps: string[] = [];
  const held = store.read(store.path).reverts[request.sha] ?? null;
  const ensured = await ensureCaseIssue(
    {
      key: revertCaseKey(request.sha),
      title: revertIssueTitle(request),
      body: revertIssueBody(request),
      known: held?.issue ?? null,
      loop: request.loop,
    },
    io,
  );
  if (ensured.issue === null || !ensured.claimed) {
    // `refused` is an ordinary claim race — another loop's label beat ours —
    // and `ensureCaseIssue`'s own doc comment calls that "a RESULT, not an
    // exception". Reporting it as a fault sent the doctor down the
    // RETRY_LATER path for something that resolves itself, so it gets the
    // repo's own vocabulary for a lost claim, `CLAIM_REFUSED_EXIT`.
    return {
      kind: ensured.kind === "held" ? "nothing" : ensured.kind === "refused" ? "refused" : "fault",
      why: ensured.refusal ?? `the revert issue for ${short(request.sha)} could not be claimed`,
      issue: ensured.issue,
      pr: null,
      forwardIssue: null,
      steps,
    };
  }
  const issue = ensured.issue;
  if (ensured.created) steps.push(`issue #${issue}`);
  await recordRevert(request.sha, { case: request.key, issue, pr: held?.pr ?? null, forwardIssue: held?.forwardIssue ?? null, state: "open" }, store);
  // The revert issue is the doctor's own work, so the case records it as
  // FILED rather than handed off: a hand-off is what tells `gate.ts:274` to
  // stop offering the case for good, and this one is still the doctor's until
  // the revert lands or is abandoned.
  await recordFiled(request.key, issue, store);

  const named = revertBranch(request.loop, issue, request.sha);
  if (branch !== null) {
    if (branch !== named) {
      // A local `<loop>/<issue>-revert-<sha>` here is this module's own
      // earlier attempt at this very revert, left by a run that died before
      // it pushed — `runRevert` only reaches this arm when the branch is NOT
      // on the remote. Nothing else writes that name, so clearing it is what
      // lets the rename succeed instead of failing `fatal: a branch named …
      // already exists` on every run from then on.
      io.git(["branch", "-D", named]);
      const renamed = io.git(["branch", "-m", branch, named]);
      if (!renamed.ok) throw new Error(`could not rename ${branch} to ${named}: ${(renamed.stderr || renamed.stdout).trim()}`);
    }
    const pushed = io.git(["push", "--set-upstream", "origin", named]);
    if (!pushed.ok) throw new Error(`could not push ${named}: ${(pushed.stderr || pushed.stdout).trim()}`);
    steps.push(`pushed ${named}`);
  }

  let pr = held?.pr ?? (await openPrFor(io, named));
  let opened = false;
  if (pr === null) {
    const created = await write(io, [
      "pr",
      "create",
      "--base",
      request.baseBranch,
      "--head",
      named,
      "--title",
      revertIssueTitle(request),
      "--body",
      revertPrBody(request, issue),
    ]);
    pr = prNumberOf(created.stdout);
    if (pr === null) throw new Error(`could not read the new pull request number from ${created.stdout.trim()}`);
    steps.push(`PR #${pr}`);
    opened = true;
    await recordRevert(request.sha, { case: request.key, issue, pr, forwardIssue: held?.forwardIssue ?? null, state: "open" }, store);
  }

  const forward = await fileForward(request, issue, pr, held?.forwardIssue ?? null, io, store);
  if (forward.created) steps.push(`forward fix #${forward.issue}`);
  const told = await notify(request, "revert", pr, forward.issue, io);
  if (told.wrote) steps.push("told the culprit's ticket");
  if (told.unreadable.length > 0) steps.push(`could not read ${told.unreadable.join(", ")}`);

  // A forward fix that could not be filed is NOT a success with a footnote:
  // AC 2 is the re-land being somebody's ticket, and reporting `reverted` with
  // the revert issue standing in for it would read as discharged. The revert
  // itself is open and fine, so the next run finishes the filing — but the
  // word printed has to say that it has not happened.
  if (forward.issue === null) {
    return {
      kind: "fault",
      why: `#${pr} reverts ${culpritName(request)}, but the forward fix could not be filed (GitHub was unreadable) — run this again to file it`,
      issue,
      pr,
      forwardIssue: null,
      steps: [...steps, "forward fix NOT filed"],
    };
  }

  // `reverted` is this run having OPENED something, not having done work:
  // the push and the issue claim happen on every run, so a run that only
  // re-pushed an existing branch would otherwise report a revert it did not
  // make. That word is what the prompt tells the doctor to journal.
  return {
    kind: ensured.created || opened || forward.created || told.wrote ? "reverted" : "resumed",
    why: `#${pr} reverts ${culpritName(request)} and #${forward.issue} tracks the re-land; it still has to pass the required checks and go through the project's queue`,
    issue,
    pr,
    forwardIssue: forward.issue,
    steps,
  };
}

/** `https://github.com/o/r/pull/41` → 41. Anchored on `/pull/` rather than reusing `issueNumberOf`, so an issue URL can never be read as a pull request. */
export function prNumberOf(stdout: string): number | null {
  const match = /\/pull\/(\d+)/.exec(stdout.trim());
  return match === null ? null : Number(match[1]);
}

/** The forward fix, found by its own marker so a crash after the revert PR files it once. */
async function fileForward(
  request: RevertRequest,
  revertIssue: number,
  revertPr: number,
  known: number | null,
  io: RevertIo,
  store: StoreIo,
): Promise<{ issue: number | null; created: boolean }> {
  const filed = await fileForCoders(
    {
      key: forwardCaseKey(request.sha),
      title: forwardFixTitle(request),
      body: forwardFixBody(request, revertIssue, revertPr),
      known,
      loop: request.loop,
    },
    io,
  );
  if (filed.issue === null) return { issue: null, created: false };
  await recordRevert(request.sha, { case: request.key, issue: revertIssue, pr: revertPr, forwardIssue: filed.issue, state: "open" }, store);
  // `created` comes from `fileForCoders`, not from whether the store knew a
  // number: a store that remembers an issue GitHub can no longer resolve by
  // marker makes `fileForCoders` create a FRESH one, and inferring otherwise
  // reported `resumed` for a run that had just filed a new ticket.
  return { issue: filed.issue, created: filed.created };
}

/**
 * Tell the culprit's ticket and pull request, once each.
 *
 * Found by marker rather than by the store, because this is the one write
 * whose absence nothing else reveals: the revert exists, the forward fix
 * exists, and the author of the reverted change learns about it here or not at
 * all. A target that cannot be read is reported rather than written to or
 * thrown on — see `carries`.
 */
async function notify(
  request: RevertRequest,
  kind: NoticeKind,
  pr: number | null,
  forwardIssue: number | null,
  io: RevertIo,
): Promise<{ wrote: boolean; unreadable: string[] }> {
  const body = culpritNotice(request, kind, pr, forwardIssue);
  const marker = noticeMarker(request.sha, kind);
  let wrote = false;
  const unreadable: string[] = [];
  const culpritIssue = request.culpritIssue ?? (request.culpritPr === null ? null : await closedBy(io, request.culpritPr));
  for (const [target, number] of [
    ["issue", culpritIssue],
    ["pr", request.culpritPr],
  ] as const) {
    if (number === null) continue;
    const already = await carries(io, target, number, marker);
    if (already === null) {
      unreadable.push(`${target} #${number}`);
      continue;
    }
    if (already) continue;
    await write(io, [target, "comment", String(number), "--body", body]);
    wrote = true;
  }
  return { wrote, unreadable };
}

/**
 * A revert pull request went red or was dequeued.
 *
 * Rounds are counted in the store and nowhere else, because unlike every other
 * fact here a round has no artefact on GitHub to read it off — a red check is
 * replaced by the next one. That makes the count the one piece of this module's
 * bookkeeping a lost store can forget, and forgetting it fails SAFE: the
 * culprit's single attempt is already spent, so the next run refuses on
 * `existingRevert` rather than opening a second revert.
 */
export async function failedRound(
  request: RevertRequest,
  why: string,
  io: RevertIo,
  store: StoreIo,
): Promise<Outcome> {
  const held = store.read(store.path).reverts[request.sha] ?? null;
  if (held === null || held.pr === null) {
    return { kind: "fault", why: `no revert pull request is recorded for ${short(request.sha)}`, issue: held?.issue ?? null, pr: null, forwardIssue: null, steps: [] };
  }
  if (held.state === "abandoned") {
    return { kind: "nothing", why: `the revert of ${short(request.sha)} was already abandoned; this culprit gets no second attempt`, issue: held.issue, pr: held.pr, forwardIssue: held.forwardIssue, steps: [] };
  }
  // Counted inside the lock off the record the lock sees, not off `held`:
  // `held` was read before it, and two `failed` runs a second apart would
  // otherwise both write round 1 and neither would ever close the pull request.
  const rounds = await store.with(store.path, (open) => {
    const record = open.reverts[request.sha] ?? held;
    const next = (record.rounds ?? 0) + 1;
    open.reverts[request.sha] = { ...record, rounds: next };
    return next;
  });
  if (rounds < MAX_REVERT_ROUNDS) {
    return {
      kind: "nothing",
      why: `round ${rounds} of ${MAX_REVERT_ROUNDS} on #${held.pr}: ${why} — fix it on the branch and let the checks run again`,
      issue: held.issue,
      pr: held.pr,
      forwardIssue: held.forwardIssue,
      steps: [`round ${rounds}`],
    };
  }
  await write(io, [
    "pr",
    "comment",
    String(held.pr),
    "--body",
    [
      `This revert of ${culpritName(request)} has failed its checks ${MAX_REVERT_ROUNDS} times (${why}), so the ci-doctor is closing it rather than trying a third time.`,
      "",
      `The regression is filed for the coders as \`${URGENT_LABEL}\`. Reverting this culprit automatically is not attempted again.`,
    ].join("\n"),
  ]);
  await write(io, ["pr", "close", String(held.pr)]);
  // `rounds`, not `held.rounds`: `held` was read before the lock that
  // incremented it, and the spread in `recordRevert` puts `value` last — so
  // passing `held` here would write the count back down and leave an abandoned
  // revert claiming it had failed once.
  await recordRevert(request.sha, { ...held, rounds, state: "abandoned" }, store);
  const filed = await fileUrgent(
    request,
    [`the revert #${held.pr} failed its checks ${MAX_REVERT_ROUNDS} times: ${why}`],
    io,
    store,
    { kind: "abandoned", pr: held.pr },
  );
  return {
    kind: filed.kind === "fault" ? "fault" : "filed-urgent",
    why: `#${held.pr} is closed and the case is not revertable — ${filed.why}`,
    issue: filed.issue,
    pr: held.pr,
    forwardIssue: held.forwardIssue,
    steps: ["commented", "closed", "abandoned", ...filed.steps],
  };
}

/**
 * The case states in which a regression is no longer live work.
 *
 * `handed-off` is in the list and has to be, because it is the state
 * `fileUrgent` itself writes: every filing this module makes lands there, so a
 * list without it would retire nothing this module had ever filed. `fixed` and
 * `retired` are `classify`'s own words for a case it has stopped seeing.
 */
const RETIRABLE: readonly string[] = ["fixed", "retired", "handed-off"];

/**
 * Take `priority:urgent` off a filing whose case has retired.
 *
 * The spec's one line that nothing else in the harness answers: *"Remove
 * `priority:urgent` when the case retires (main green on T)."* Without it
 * every urgent filing this module ever makes stays urgent for good, and the
 * lane that exists to put a red base branch at the front of the frontier fills
 * up with regressions that were fixed days ago — at which point it no longer
 * means anything.
 *
 * Read off the store rather than asked of GitHub, and **three** conditions
 * rather than two, because "main green" is not the same claim as the spec's
 * "green on T": the base branch's recorded colour can be green because T was
 * skipped or quarantined. So the case's own newest evidence must also predate
 * the build that green reading came from — T has not failed since main went
 * green — which is as close to "green on T" as the store can answer.
 */
export async function retireUrgent(
  key: string,
  store: CiHealthStore,
  io: Pick<RevertIo, "gh">,
): Promise<{ removed: boolean; why: string }> {
  const value = store.cases[key];
  if (value === undefined) return { removed: false, why: `the store has no case ${key}` };
  if (store.main.state !== "green") {
    return { removed: false, why: `${key} cannot retire while main is ${store.main.state}` };
  }
  if (!RETIRABLE.includes(value.state)) {
    return { removed: false, why: `${key} is ${value.state}, which is still live work` };
  }
  const newest = value.evidence.reduce((high, row) => Math.max(high, row.build), 0);
  if (newest > store.main.build) {
    return {
      removed: false,
      why: `${key} failed in build #${newest}, after the #${store.main.build} that read main green — not green on this test yet`,
    };
  }
  if (value.issue === null) return { removed: false, why: `${key} has no filed issue to unlabel` };
  const labels = await tried(io, ["issue", "view", String(value.issue), "--json", "labels"]);
  // Unreadable is not "no label": `gh` 404s on removing a label that is not
  // there, and guessing either way is a write on somebody's ticket.
  if (labels === null) return { removed: false, why: `#${value.issue} could not be read` };
  if (!labels.stdout.includes(URGENT_LABEL)) {
    return { removed: false, why: `#${value.issue} does not carry ${URGENT_LABEL}` };
  }
  await write(io, ["issue", "edit", String(value.issue), "--remove-label", URGENT_LABEL]);
  return { removed: true, why: `${URGENT_LABEL} removed from #${value.issue}: ${key} has retired and main is green` };
}

/* --------------------------------------------------------------------------
 * The CLI.
 * ----------------------------------------------------------------------- */

const CASE_KEY = /^regression:\S/;

export interface CommandDeps {
  io: RevertIo;
  store: StoreIo;
  config: unknown;
  loop: string;
  baseBranch: string;
  run: string;
  session: string;
  now: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

function caseKeyArg(argv: readonly string[]): string {
  // `argv[0]`, not the first non-dash entry: a scan would pick up `300` out of
  // `--culprit-pr 300`, or the evidence text, and refuse for want of a key
  // that was in fact supplied. `case-issue.ts:546-550` takes the same position.
  const key = argv[0] ?? null;
  if (key === null || !CASE_KEY.test(key)) {
    throw new Error(`${PREFIX} needs a regression case key, e.g. "regression:src/a.test.ts > flaps"`);
  }
  return key;
}

function evidenceArg(argv: readonly string[], readFile: typeof readFileSync = readFileSync): string | null {
  const inline = flagValue(argv, "--evidence");
  if (inline !== null) return inline;
  const file = flagValue(argv, "--evidence-file");
  if (file === null) return null;
  return readFile(file, "utf8") as string;
}

/**
 * The evidence rows the store already holds, rendered as a table.
 *
 * `run` wants the doctor's own written evidence and refuses without it. `failed`
 * must NOT: §2.4 tells the doctor to call it with `--why` alone, and requiring
 * evidence there made the documented command exit 1 before a round was ever
 * counted — so the round that closes the pull request needs a filing body it
 * can build for itself. The store is the right source: `classify` put these
 * rows there, and they are the same ones the issue and the pull request carry.
 */
export function evidenceFromStore(value: Case | undefined): string {
  const rows = value?.evidence ?? [];
  const culprit = value?.culprit ?? null;
  const parts: string[] = [];
  // The two builds the spec's urgent filing asks for by name. They live on the
  // culprit, not in the evidence rows, so a table alone would file a ticket
  // naming neither — which is most of what a coder needs to start.
  if (culprit !== null) {
    parts.push(
      `- First red build: **#${culprit.build}** on \`${short(culprit.commit)}\``,
      `- The parent's green build: ${culprit.parentBuild === null ? "_none in the window_" : `**#${culprit.parentBuild}**`}`,
      "",
    );
  }
  if (rows.length === 0) parts.push("_No evidence rows are in the store for this case._");
  else {
    parts.push(
      "| build | branch | commit | kind | line |",
      "| --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| #${row.build} | ${row.branch} | \`${short(row.commit)}\` | ${row.kind} | ${row.line} |`),
    );
  }
  return parts.join("\n");
}

/** `regression:src/a.test.ts > flaps` → `src/a.test.ts > flaps`. */
const testIdOf = (key: string): string => key.slice(key.indexOf(":") + 1);

const numberFlag = (argv: readonly string[], flag: string): number | null => {
  const raw = flagValue(argv, flag);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${PREFIX}: ${flag} must be a number`);
  return Number(raw);
};

function requestOf(argv: readonly string[], key: string, culprit: string, evidence: string, deps: CommandDeps): RevertRequest {
  const value = deps.store.read(deps.store.path).cases[key];
  return {
    key,
    sha: culprit,
    testId: testIdOf(key),
    // The flags first, then the culprit the classification already named. A
    // doctor that omits them should still get the titles the spec asks for
    // (`Revert #<culprit PR>: …`) and the notice comments, rather than a bare
    // sha and a silence — the store has had the number since `scan.ts:283`.
    culpritPr: numberFlag(argv, "--culprit-pr") ?? value?.culprit?.pr ?? null,
    culpritIssue: numberFlag(argv, "--culprit-issue"),
    ambiguous: value?.culprit?.unambiguous === false,
    loop: deps.loop,
    baseBranch: deps.baseBranch,
    evidence,
    run: deps.run,
    session: deps.session,
    at: deps.now(),
  };
}

/**
 * The culprit sha the case names, or the one `--culprit` overrides it with.
 *
 * The override exists for the one case the store cannot answer: a doctor
 * acting on a `failed` round after the window that held the case has rolled
 * over. It is never a way to revert a commit the classification did not name,
 * because `eligibility` still reads the case.
 */
function culpritOf(argv: readonly string[], key: string, store: StoreIo): string {
  const override = flagValue(argv, "--culprit");
  if (override !== null) {
    if (!/^[0-9a-f]{7,40}$/i.test(override)) throw new Error(`${PREFIX}: --culprit must be a commit sha`);
    return override;
  }
  const sha = store.read(store.path).cases[key]?.culprit?.commit ?? null;
  if (sha === null) throw new Error(`${PREFIX}: the store's ${key} names no culprit commit; pass --culprit <sha>`);
  return sha;
}

/** `decide <case key> [--culprit <sha>]` — the verdict, and nothing written. */
export async function runDecide(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  const sha = culpritOf(argv, key, deps.store);
  const store = deps.store.read(deps.store.path);
  const facts = culpritFacts(deps.io, sha);
  const found = await existingRevert(sha, store, deps.io);
  const verdict = eligibility({
    key,
    case: store.cases[key],
    config: deps.config,
    revertExists: found.exists,
    culpritSubject: facts.subject,
    culpritBody: facts.body,
    culpritFiles: facts.files,
  });
  // The clean apply is deliberately NOT probed here: it cuts a branch and
  // commits on it, and `decide` promises to write nothing at all. A verdict of
  // `revert` therefore means "eligible, subject to the revert applying", which
  // is what the printed line says.
  deps.out(
    verdict.revert
      ? `${PREFIX}: revert: ${short(sha)} is eligible, subject to \`git revert\` applying on origin/${deps.baseBranch}`
      : `${PREFIX}: urgent: ${verdict.why.join("; ")}`,
  );
  return 0;
}

/** `run <case key> (--evidence <t> | --evidence-file <f>) [--culprit-pr <n>] [--culprit-issue <n>]`. */
export async function runRevert(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  const sha = culpritOf(argv, key, deps.store);
  // The whole argv is validated before the first read, as
  // `case-issue.ts:605-612` is: a run that fails on a missing `--evidence`
  // after filing the issue is the one shape of this command that cannot be
  // re-run cleanly.
  const evidence = evidenceArg(argv);
  if (evidence === null) throw new Error(`${PREFIX} run needs --evidence or --evidence-file`);
  const request = requestOf(argv, key, sha, evidence, deps);
  const store = deps.store.read(deps.store.path);
  const facts = culpritFacts(deps.io, sha);
  const found = await existingRevert(sha, store, deps.io);
  // A revert this run itself opened is not a reason to refuse: `run` is
  // idempotent, and a crash after step 1 must come back and finish steps 2
  // and 3 rather than filing the regression as unrevertable.
  const held = store.reverts[sha];
  const resuming = found.exists && held !== undefined && held.state === "open";
  const verdict = eligibility({
    key,
    case: store.cases[key],
    config: deps.config,
    revertExists: found.exists && !resuming,
    culpritSubject: facts.subject,
    culpritBody: facts.body,
    culpritFiles: facts.files,
  });
  if (!verdict.revert) {
    // A revert found by MARKER with no open store record is the double fault
    // AC 3 covers: the attempt is spent, so no second revert is opened, but
    // the filing says where the first one is rather than describing the
    // regression as untouched.
    const why =
      found.how === "marker" && found.issue !== null
        ? verdict.why.map((line) => (line.startsWith("a revert for this culprit") ? `${line} — see #${found.issue}` : line))
        : verdict.why;
    const outcome = await fileUrgent(request, why, deps.io, deps.store);
    return report(outcome, deps);
  }
  // A resume whose branch is already PUSHED does not re-probe. The probe makes
  // a fresh `git revert` commit, whose sha differs from the pushed one (the
  // committer timestamp moves), so pushing it would be rejected as a
  // non-fast-forward and every re-run would fault at the same line. It would
  // also delete the branch §2.4 tells the doctor to fix by hand after round 1.
  //
  // The test is the REMOTE, not `held.pr`. The store learns the pull request
  // number only after `gh pr create`, so a run that died between the push and
  // that write — a 403, a protected-branch refusal, a killed process — would
  // otherwise re-probe and then fault forever on the rename or the push,
  // leaving a regression that can neither be reverted nor filed. With the
  // branch known to be pushed, `openPrFor` finds the pull request if one
  // exists and opens it against that head if not, which is what it is for.
  if (resuming && (held?.pr ?? null) === null && held?.issue !== undefined) {
    const pushed = deps.io.git(["ls-remote", "--heads", "origin", revertBranch(deps.loop, held.issue, sha)]);
    if (pushed.ok && pushed.stdout.trim() !== "") {
      return report(await openRevert(request, null, deps.io, deps.store), deps);
    }
  }
  if (resuming && (held?.pr ?? null) !== null) {
    return report(await openRevert(request, null, deps.io, deps.store), deps);
  }
  const probe = probeRevert(deps.io, { sha, baseBranch: deps.baseBranch });
  if (!probe.clean || probe.branch === null) {
    const outcome = await fileUrgent(
      request,
      [`\`git revert --no-edit ${short(sha)}\` does not apply on origin/${deps.baseBranch}: ${probe.why ?? "it conflicts"}`],
      deps.io,
      deps.store,
    );
    return report(outcome, deps);
  }
  const outcome = await openRevert(request, probe.branch, deps.io, deps.store);
  return report(outcome, deps);
}

/** `failed <case key> --why <text>` — one red or dequeued round. */
export async function runFailed(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  const sha = culpritOf(argv, key, deps.store);
  const why = flagValue(argv, "--why");
  if (why === null || why.trim() === "") throw new Error(`${PREFIX} needs --why <what went red or dequeued it>`);
  // Evidence is optional here and falls back to the store's own rows: §2.4
  // calls this with `--why` alone, and only the round that closes the pull
  // request needs a body to file with.
  const evidence = evidenceArg(argv) ?? evidenceFromStore(deps.store.read(deps.store.path).cases[key]);
  const request = requestOf(argv, key, sha, evidence, deps);
  return report(await failedRound(request, why, deps.io, deps.store), deps);
}

/**
 * `retire [<case key>]` — drop `priority:urgent` from every case that has retired.
 *
 * **With no key it sweeps**, and that is the form the prompt uses, because the
 * single-key form cannot be reached: `ci-doctor/gate.ts:274` skips a
 * regression in exactly the three states `RETIRABLE` lists, so the gate never
 * hands the doctor a retirable case key and nothing else prints one. A
 * mechanism with no trigger drains nothing, which is where this started.
 *
 * The sweep is as safe as the single call — `retireUrgent` writes only when all
 * three of its conditions hold — and it is cheap: one `gh issue view` per
 * retired case that still carries the label, and nothing at all for the rest.
 */
export async function runRetire(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const store = deps.store.read(deps.store.path);
  const keys =
    argv[0] !== undefined && !argv[0].startsWith("-")
      ? [caseKeyArg(argv)]
      : Object.entries(store.cases)
          .filter(([, value]) => value.kind === "regression" && RETIRABLE.includes(value.state) && value.issue !== null)
          .map(([key]) => key);
  if (keys.length === 0) {
    deps.out(`${PREFIX}: nothing: no retired regression has a filed issue to unlabel`);
    return 0;
  }
  let removed = 0;
  for (const key of keys) {
    const outcome = await retireUrgent(key, store, deps.io);
    if (outcome.removed) removed += 1;
    deps.out(`${PREFIX}: ${outcome.removed ? "retired" : "nothing"}: ${outcome.why}`);
  }
  if (keys.length > 1) deps.out(`${PREFIX}: ${removed} of ${keys.length} retired regressions unlabelled`);
  return 0;
}

/**
 * Print the outcome, kind first.
 *
 * The KIND leads the line because the reason alone cannot be read back: a
 * refusal's `why` opens "#41 carries the regression…", which is exactly the
 * sentence a reader takes for a successful revert. The doctor's prompt tells it
 * to journal the word printed here.
 */
function report(outcome: Outcome, deps: CommandDeps): number {
  if (outcome.kind === "fault") {
    deps.err(`${PREFIX}: ${outcome.why}`);
    return 1;
  }
  // Exit 3 is what the prompt already teaches at §2.1 and what
  // `case-issue.ts:570-578` returns: another doctor holds this, try another
  // case. It is not a fault and it is not success.
  if (outcome.kind === "refused") {
    deps.err(`${PREFIX}: refused: ${outcome.why}`);
    return CLAIM_REFUSED_EXIT;
  }
  const steps = outcome.steps.length === 0 ? "" : ` — ${outcome.steps.join(", ")}`;
  deps.out(`${PREFIX}: ${outcome.kind}: ${outcome.why}${steps}`);
  return 0;
}

function identity(env: NodeJS.ProcessEnv): { loop: string; run: string; session: string } {
  const loop = env.RALPH_LOOP_NAME ?? "";
  const run = env.RALPH_RUN_ID ?? "";
  const session = env.RALPH_SESSION_ID ?? "";
  if (loop === "" || run === "") throw new Error(`${PREFIX} needs RALPH_LOOP_NAME and RALPH_RUN_ID`);
  return { loop, run, session };
}

function liveConfig(root: string): unknown {
  try {
    return JSON.parse(readFileSync(`${root}/.ralph/config.json`, "utf8")) as unknown;
  } catch {
    // An unreadable config is the documented defaults, not a fault: this
    // module's two keys both have one, and refusing to act on a project that
    // simply has no `ciDoctor` block would make the feature opt-in, which is
    // the opposite of #162's `autoRevert: true`.
    return null;
  }
}

/** The real `git`, as `ci-doctor/verify.ts:liveDeps` runs it, but keeping the exit code: a conflict is an answer. */
export const gitRunner: Git = (args) => {
  const out = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  return { ok: out.status === 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
};

async function main(): Promise<number> {
  // Anchored as `ci-doctor/unpark.ts:639-645` is, and for its reason:
  // unanchored, every `gh` and `git` probe answers for whatever directory this
  // was invoked from, so the revert would be cut from the harness's own
  // repository and the store written would be one the gate never reads.
  process.chdir(projectRoot());
  const root = process.cwd();
  const who = identity(process.env);
  const storePath = storePathFromGit(root);
  const deps: CommandDeps = {
    io: { ...liveCaseIssueIo(storePath), gh: ghRunner, git: gitRunner },
    store: { path: storePath, with: withStore, read: readStore },
    config: liveConfig(root),
    loop: who.loop,
    baseBranch: process.env.RALPH_BASE_BRANCH ?? "main",
    run: who.run,
    session: who.session,
    now: () => new Date().toISOString(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
  const argv = process.argv.slice(3);
  switch (process.argv[2]) {
    case "decide":
      return runDecide(argv, deps);
    case "run":
      return runRevert(argv, deps);
    case "failed":
      return runFailed(argv, deps);
    case "retire":
      return runRetire(argv, deps);
    default:
      console.error(`usage: ${PREFIX}.ts decide|run|failed|retire '<regression case key>' [options]`);
      return 64;
  }
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
