#!/usr/bin/env bun
/**
 * The push fence: the only way a pr-medic writes to a branch.
 *
 * The medic works inside somebody else's pull request — the operator's — and
 * the operator may be pushing to the same branch at the same moment. Every
 * guardrail the spec gives it (felipearos/ralph#244, guardrail 4) is about that
 * write, so the write is enforced HERE, in code, rather than in a sentence of
 * the prompt: the executor guard exists because `rafa #1108` ran the command
 * its brief forbade (`executor-guard/guard.ts`), and the medic's orchestrator
 * is denied a raw `git push` for the same reason (`roles.ts`
 * `orchestratorSettings`, `pr-medic/orchestrator-settings.json`), which leaves
 * this script the one route.
 *
 *   bun pr-medic/push.ts <pr> --expect <sha>
 *
 * `<sha>` is the head the medic fetched and built on. Four checks, in order,
 * each with its own exit so the iteration can tell them apart:
 *
 *   3   the pull request is not the medic's to push to: closed, a draft, a
 *       fork, a branch outside `prMedic.branches` or under a roster loop's
 *       prefix, or its head is no longer `<sha>` — or this loop is not a medic.
 *       A loop's branch is the medic's only as an ADOPTION: its owner is
 *       unattended and the PR carries `<medic>-wip` (#425);
 *   10  the diff guard (`ci-doctor/verify.ts`) refused what the medic wrote: a
 *       weakened test or a CI-configuration edit;
 *   5   a commit the medic wrote does not carry `Pr-Medic: <loop>`, or the new
 *       HEAD does not: every push must END on a medic commit, because the
 *       gate's `prMedic.maxPushes` counts trailered commits at the top of the
 *       branch. A pure rebase therefore adds `git commit --allow-empty` with
 *       the trailer and a message naming the base sha it rebased onto;
 *   4   the lease failed: the branch moved between the medic's fetch and its
 *       push. The operator's commit stands, and the medic RE-DIAGNOSES rather
 *       than retrying — a retry would be a push over work it has not read;
 *   0   pushed, or nothing to push;
 *   1   git or gh could not be asked; 64 bad usage; 75 GitHub throttled.
 *
 * felipearos/ralph#247
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
  diffGuardProblems,
  diffRefusalMessage,
  matchesGlob,
  parseTimeoutEvidence,
  readDiffGuardConfig,
  REFUSED_DIFF_EXIT,
  type DiffGuardConfig,
} from "../executor-guard/diff-guard";
import { classifyRateLimit, RATE_LIMITED_EXIT } from "../frontier/github-rate-limit";
import { projectRoot } from "../paths";
import { loadProjectConfig, type RosterEntry } from "../project-config";
import type { Role } from "../roles";
import { nearestConfig } from "../ci-doctor/verify";
import { liveUnattendedRunner, readUnattended, type Unattended } from "./adoption";

const PREFIX = "pr-medic/push";

export const INELIGIBLE_EXIT = 3;
export const LEASE_LOST_EXIT = 4;
export const UNSIGNED_EXIT = 5;
export const USAGE_EXIT = 64;
export { REFUSED_DIFF_EXIT };

/** The trailer every commit the medic writes carries, valued with its loop name. */
export const TRAILER = "Pr-Medic";

/** The remote the operator's branch lives on. The loops' checkouts all call it this. */
const REMOTE = "origin";

/** One finished subprocess. */
export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** Everything that reaches outside this process, so a test can supply it. */
export interface PushDeps {
  /** `git` in the medic's checkout. `input` is piped to stdin. */
  git(args: string[], input?: string): Ran;
  gh(args: string[]): Ran;
  read(path: string): string;
  exists(path: string): boolean;
  /** The unattended loops, or null when they could not be read. */
  unattended(): Unattended | null;
}

/** What the fence needs to know about the project, read once from its config. */
export interface FenceProject {
  repo: string;
  /** `prMedic.branches`, or empty when the project has no medic block. */
  branches: readonly string[];
  roster: readonly RosterEntry[];
  /** The project root, where the diff guard's config is found. */
  root: string;
}

/** The fields of `gh pr view --json` the fence decides on. */
export interface PullRequestView {
  state: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  body: string;
  labels?: { name: string }[];
}

export const PR_FIELDS = "state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,body,labels";

export interface Verdict {
  exit: number;
  /** One line per finding, or the success line. */
  lines: string[];
}

/** The roster loop whose `<name>/` prefix `branch` sits under, or null. */
export function ownerOf(branch: string, roster: readonly RosterEntry[]): string | null {
  return roster.find((entry) => branch.startsWith(`${entry.name}/`))?.name ?? null;
}

/**
 * Every reason this pull request is not the medic's to push to. Empty means it is.
 *
 * Re-read at push time rather than trusted from the gate's poll: the gate saw
 * the pull request minutes ago, and a draft, a close or an operator push since
 * then each mean the medic is no longer working on what it thinks it is.
 *
 * The loop-prefix check is made AGAIN although `project-config.ts` already
 * refuses a `branches` glob that overlaps a loop prefix: that validator guards
 * the config, this guards the push, and a second loop added to the roster
 * after the medic started is exactly the case where only the second holds.
 *
 * The one way past both is an adoption (#425): the owner is unattended and
 * the gate labelled the pull request `<loop>-wip`. An unattended set that
 * could not be read refuses — being wrong there force-pushes a live loop's
 * branch.
 */
export function eligibilityProblems(
  pr: PullRequestView,
  expect: string,
  project: FenceProject,
  adoption?: { loop: string; unattended: Unattended | null },
): string[] {
  const problems: string[] = [];
  if (pr.state !== "OPEN") problems.push(`it is ${pr.state.toLowerCase()}, not open`);
  if (pr.isDraft) problems.push("it is a draft; the medic waits until the operator marks it ready");
  // A fork's head is not on `origin`, so a push "to its branch" would create
  // a same-named branch in THIS repository instead.
  if (pr.isCrossRepository) problems.push("its head is on a fork, which the medic cannot push to");
  const owner = ownerOf(pr.headRefName, project.roster);
  const notAdopted = owner === null ? null : adoptionProblem(pr, owner, adoption);
  // An adopted push is judged by the adoption, not by the operator's glob.
  if (notAdopted !== "" && !project.branches.some((glob) => matchesGlob(glob, pr.headRefName))) {
    problems.push(
      project.branches.length === 0
        ? "the project's config has no prMedic.branches, so no branch is the medic's"
        : `'${pr.headRefName}' matches none of prMedic.branches (${project.branches.join(", ")})`,
    );
  }
  if (owner !== null && notAdopted !== "") {
    const ownerLine = `'${pr.headRefName}' is the ${owner} loop's branch; a medic never touches an agent's pull request`;
    problems.push(notAdopted === null ? ownerLine : `${ownerLine} — ${notAdopted}`);
  }
  if (pr.headRefOid !== expect) {
    problems.push(`its head is ${pr.headRefOid.slice(0, 12)}, not the ${expect.slice(0, 12)} you fetched; somebody pushed — re-read it`);
  }
  return problems;
}

/**
 * Why a push to `owner`'s branch is not an adoption: "" when it is, null when
 * no adoption was asked about (today's plain owner refusal), else the reason.
 */
function adoptionProblem(
  pr: PullRequestView,
  owner: string,
  adoption: { loop: string; unattended: Unattended | null } | undefined,
): string | null {
  if (adoption === undefined) return null;
  if (adoption.unattended === null) return "the unattended loops could not be read, so an adoption cannot be confirmed";
  if (!adoption.unattended.has(owner)) return `not an adoption: the ${owner} loop is back`;
  const wip = `${adoption.loop}-wip`;
  if (!(pr.labels ?? []).some((label) => label.name === wip)) return `not an adoption: it carries no ${wip}`;
  return "";
}

/**
 * `after`'s findings that `before` does not already account for, as a multiset.
 *
 * A finding names its file and its count (`deletes 2 tests`), so a medic that
 * deletes one more test in a file the operator already thinned changes the
 * string and is still caught. What it does forgive is the operator's own
 * finding replayed unchanged onto the new base — that is the operator's diff,
 * and refusing it would leave every pull request that legitimately removes a
 * test un-rebaseable.
 */
export function newFindings(after: readonly string[], before: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const finding of before) left.set(finding, (left.get(finding) ?? 0) + 1);
  return after.filter((finding) => {
    const count = left.get(finding) ?? 0;
    if (count === 0) return true;
    left.set(finding, count - 1);
    return false;
  });
}

/** The `Pr-Medic` values a commit's trailers carry, from `%(trailers:…,valueonly)`. */
export const trailerValues = (formatted: string): string[] =>
  formatted
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * The guard's rules as the medic is held to them: the doctor's, without its
 * fix scope.
 *
 * The doctor may only edit tests; the medic fixes the branch's own code the
 * way a coder does, so a fix scope would refuse its ordinary work. What it
 * keeps is what the ticket names: `neverTouch` (the CI's own configuration),
 * the weakening rules and the timeout ceilings — read from the project's
 * `ciDoctor` block, because a pipeline file is the same file whichever agent
 * reaches for it.
 */
export const medicGuardConfig = (config: DiffGuardConfig): DiffGuardConfig => ({ ...config, fixScope: ["**"] });

/** `git` that must succeed, trimmed. */
function must(deps: PushDeps, args: string[], input?: string): string {
  const ran = deps.git(args, input);
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr.trim() || `exit ${ran.status}`}`);
  return ran.stdout;
}

/**
 * What the medic wrote, judged by the diff guard.
 *
 * Two shapes, decided by whether the PR's base moved under it:
 *
 * - **Same base** (a fix on top, an amend, a squash): `<sha>..HEAD` IS the
 *   medic's diff, tree against tree, and is judged whole.
 * - **Rebased onto a moved base**: `<sha>..HEAD` would also carry every commit
 *   main gained meanwhile, and those are not the medic's to answer for — a
 *   test main deleted is main's decision. So the guard judges the PR's own
 *   diff against its NEW base, and forgives what the operator's diff against
 *   the OLD base already showed (`newFindings`), and then what each of the
 *   operator's commits replayed patch for patch shows on its own. What is
 *   left is what the rebase and the medic's fixes added.
 *
 * The second forgiveness is for a stale stack: a branch that still carries
 * its parent PR's pre-squash commits. Against the old merge-base those
 * commits' additions net out the operator's own test deletions, so the old
 * diff shows nothing; rebased off them onto the squashed parent, the same
 * deletions surface whole. They are still the operator's — the commit that
 * makes them is replayed unchanged — so they must not read as the medic's
 * (loggd #2201). A replayed commit's findings are judged on its own diff and
 * matched as exact strings, so a medic commit that deletes one more test in
 * the same file changes the aggregate count and is still refused.
 */
export function guardFindings(
  deps: PushDeps,
  options: { expect: string; head: string; baseBefore: string; baseAfter: string; config: DiffGuardConfig; prBody: string },
): string[] {
  const context = { config: options.config, evidence: parseTimeoutEvidence(options.prBody) };
  // `--no-ext-diff` and `--no-color`: a difftool or `color.ui=always` in the
  // operator's git config would hand the guard text it cannot parse.
  const judge = (from: string, to: string): string[] =>
    diffGuardProblems(must(deps, ["diff", "--no-ext-diff", "--no-color", from, to]), context);
  if (options.baseBefore === options.baseAfter) return judge(options.expect, options.head);
  const unexplained = newFindings(judge(options.baseAfter, options.head), judge(options.baseBefore, options.expect));
  if (unexplained.length === 0) return unexplained;
  const replayed = replayedCommits(deps, options).flatMap((commit) => judge(`${commit}^`, commit));
  return newFindings(unexplained, replayed);
}

/** `git patch-id --stable` of one non-merge commit, or null for a merge or an empty one. */
function patchId(deps: PushDeps, commit: string): string | null {
  const patch = must(deps, ["diff-tree", "-p", "--no-ext-diff", "--no-color", "--no-commit-id", "--root", commit]);
  if (patch.trim() === "") return null;
  return must(deps, ["patch-id", "--stable"], patch).split(" ")[0]?.trim() || null;
}

type Range = { expect: string; head: string; baseBefore: string; baseAfter: string };

const revList = (deps: PushDeps, args: string[]): string[] => trailerValues(must(deps, ["rev-list", ...args]));

/** Every commit on HEAD that is neither the operator's head nor the base's, oldest first. */
function writtenCommits(deps: PushDeps, range: Range): string[] {
  return revList(deps, ["--reverse", range.head, `^${range.expect}`, `^${range.baseAfter}`]);
}

/**
 * The written commits that are patch-identical to a commit the operator
 * already had: the operator's own work, replayed by a clean rebase.
 */
function replayedCommits(deps: PushDeps, range: Range): string[] {
  const operators = new Set(
    revList(deps, [range.expect, `^${range.baseBefore}`])
      .map((commit) => patchId(deps, commit))
      .filter((id): id is string => id !== null),
  );
  return writtenCommits(deps, range).filter((commit) => {
    const id = patchId(deps, commit);
    return id !== null && operators.has(id);
  });
}

/**
 * Every commit the medic wrote that does not carry `Pr-Medic: <loop>`.
 *
 * "Wrote" is every commit on HEAD that is neither the operator's head nor the
 * base's — EXCEPT one patch-identical to a commit the operator already had,
 * which is the operator's own work replayed by a clean rebase and theirs to
 * have signed. A commit a rebase CHANGED (a resolved conflict) has a new
 * patch, so it is the medic's writing and needs the trailer like any other.
 *
 * The trailer is what lets the operator, the gate's push cap
 * (`prMedic.maxPushes`) and anyone reading `git log` tell the medic's commits
 * from the operator's on a branch they now share.
 */
export function unsignedCommits(
  deps: PushDeps,
  options: { expect: string; head: string; baseBefore: string; baseAfter: string; loop: string },
): { written: string[]; unsigned: string[] } {
  const written = writtenCommits(deps, options);
  const replayed = new Set(replayedCommits(deps, options));
  const unsigned = written.filter((commit) => {
    if (replayed.has(commit)) return false;
    const values = trailerValues(must(deps, ["show", "-s", `--format=%(trailers:key=${TRAILER},valueonly)`, commit]));
    return !values.includes(options.loop);
  });
  return { written, unsigned };
}

/**
 * Whether a failed push was the lease. `git push --porcelain` marks a refused
 * ref `!` with the reason in brackets; a lease that no longer holds is
 * `stale info`, whether the branch moved or was deleted.
 */
export const leaseLost = (ran: Ran): boolean => /\bstale info\b/.test(`${ran.stdout}\n${ran.stderr}`);

export interface FenceRequest {
  pr: number;
  expect: string;
  loop: string;
  project: FenceProject;
}

/** The whole fence. Throws only when git or gh could not be asked at all. */
export function fence(deps: PushDeps, request: FenceRequest): Verdict {
  const { project, loop } = request;
  const refuse = (exit: number, why: string, problems: readonly string[]): Verdict => ({
    exit,
    lines: [`${PREFIX}: refused #${request.pr} — ${why}:`, ...problems.map((problem) => `  - ${problem}`)],
  });

  const medics = project.roster.filter((entry) => entry.role === ("pr-medic" satisfies Role)).map((entry) => entry.name);
  if (!medics.includes(loop)) {
    return refuse(INELIGIBLE_EXIT, "this loop is not a medic", [
      `'${loop}' is not a pr-medic on this project's roster (${medics.length === 0 ? "it has none" : medics.join(", ")})`,
    ]);
  }

  // Resolved before anything is asked of GitHub: the lease must pin a full
  // sha, and a sha this checkout does not have is a fetch the medic skipped.
  const resolved = deps.git(["rev-parse", "--verify", "--quiet", `${request.expect}^{commit}`]);
  if (resolved.status !== 0) {
    return { exit: USAGE_EXIT, lines: [`${PREFIX}: --expect ${request.expect} is not a commit in this checkout; fetch the branch first`] };
  }
  const expect = resolved.stdout.trim();

  const view = deps.gh(["pr", "view", String(request.pr), "--repo", project.repo, "--json", PR_FIELDS]);
  if (view.status !== 0) {
    const message = `${view.stderr}\n${view.stdout}`.trim();
    if (classifyRateLimit(message) !== null) return { exit: RATE_LIMITED_EXIT, lines: [`${PREFIX}: GitHub throttled the re-read: ${message}`] };
    throw new Error(`gh pr view ${request.pr} failed: ${message || `exit ${view.status}`}`);
  }
  const pr = JSON.parse(view.stdout) as PullRequestView;

  // Read only for a loop's branch, so an operator push never pays for it; a
  // throw is an unread set, which refuses.
  const unattended = (): Unattended | null => {
    try {
      return deps.unattended();
    } catch {
      return null;
    }
  };
  const adoption = ownerOf(pr.headRefName, project.roster) === null ? undefined : { loop, unattended: unattended() };
  const ineligible = eligibilityProblems(pr, expect, project, adoption);
  if (ineligible.length > 0) return refuse(INELIGIBLE_EXIT, "not the medic's to push to", ineligible);

  const head = must(deps, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (head === expect) return { exit: 0, lines: [`${PREFIX}: nothing to push — HEAD is still ${expect.slice(0, 12)}, the head you fetched.`] };

  const base = `${REMOTE}/${pr.baseRefName}`;
  const baseBefore = must(deps, ["merge-base", base, expect]).trim();
  const baseAfter = must(deps, ["merge-base", base, "HEAD"]).trim();

  const located = nearestConfig({ git: (args) => must(deps, args), read: deps.read, exists: deps.exists }, project.root);
  const config = medicGuardConfig(readDiffGuardConfig(located, deps.read));
  const findings = guardFindings(deps, { expect, head, baseBefore, baseAfter, config, prBody: pr.body ?? "" });
  if (findings.length > 0) return { exit: REFUSED_DIFF_EXIT, lines: [diffRefusalMessage(findings)] };

  const { written, unsigned } = unsignedCommits(deps, { expect, head, baseBefore, baseAfter, loop });
  // A HEAD that differs from the sha but adds nothing of its own has only
  // REMOVED the operator's commits — a reset, not a fix — and nothing in it
  // is signed by the medic.
  if (written.length === 0) {
    return refuse(UNSIGNED_EXIT, "the push only removes commits", [`HEAD ${head.slice(0, 12)} adds no commit to ${expect.slice(0, 12)}`]);
  }
  if (unsigned.length > 0) {
    return refuse(
      UNSIGNED_EXIT,
      `a commit lacks the '${TRAILER}: ${loop}' trailer`,
      unsigned.map((commit) => `${commit.slice(0, 12)} — add it with \`git commit --amend --trailer '${TRAILER}: ${loop}'\``),
    );
  }
  // And the new HEAD itself must be the medic's. A pure clean rebase passes
  // the check above with no medic commit at all — every commit is a replay —
  // and the gate's push cap counts trailered commits at the TOP of the branch
  // (`pr-medic/gate.ts`'s `medicPushes`), so such a push would never spend
  // it. A medic that only rebased marks the push with an empty commit.
  if (!trailerValues(must(deps, ["show", "-s", `--format=%(trailers:key=${TRAILER},valueonly)`, head])).includes(loop)) {
    return refuse(UNSIGNED_EXIT, `the new HEAD lacks the '${TRAILER}: ${loop}' trailer`, [
      `HEAD ${head.slice(0, 12)} is not a medic commit, so the push would not count against prMedic.maxPushes — after a pure rebase, ` +
        `add \`git commit --allow-empty -m 'Rebase onto <base sha>' --trailer '${TRAILER}: ${loop}'\``,
    ]);
  }

  // The lease pins the sha the medic READ, never "whatever the remote-tracking
  // ref says": a bare `--force-with-lease` compares against `origin/<branch>`,
  // which the next `git fetch` silently moves to the operator's new commit and
  // so lets the push over it. A bare `--force` is not a mode this script has.
  const ran = deps.git([
    "push",
    "--porcelain",
    `--force-with-lease=${pr.headRefName}:${expect}`,
    REMOTE,
    `${head}:refs/heads/${pr.headRefName}`,
  ]);
  if (ran.status !== 0) {
    if (leaseLost(ran)) {
      return refuse(LEASE_LOST_EXIT, "the branch moved since you fetched it", [
        `${pr.headRefName} is no longer ${expect.slice(0, 12)}; the operator's push stands. Re-read the pull request and diagnose again — do not retry this push.`,
      ]);
    }
    throw new Error(`git push failed: ${`${ran.stderr}\n${ran.stdout}`.trim() || `exit ${ran.status}`}`);
  }
  return {
    exit: 0,
    lines: [`${PREFIX}: pushed ${expect.slice(0, 12)}..${head.slice(0, 12)} to ${pr.headRefName} (#${request.pr}, ${written.length} commit${written.length === 1 ? "" : "s"}).`],
  };
}

/** The deps as the CLI has them: real git in `cwd`, real gh, real files, the unattended loops of `root`. */
export function liveDeps(cwd: string, root: string): PushDeps {
  const run = (command: string, args: string[], input?: string): Ran => {
    const out = spawnSync(command, args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    return { status: out.status ?? 1, stdout: out.stdout ?? "", stderr: out.stderr ?? (out.error?.message ?? "") };
  };
  return {
    git: (args, input) => run("git", args, input),
    gh: (args) => run("gh", args),
    read: (path) => readFileSync(path, "utf8"),
    exists: (path) => existsSync(path),
    unattended: () => readUnattended(liveUnattendedRunner(root)),
  };
}

/** The project as the fence reads it. */
export function fenceProject(root: string): FenceProject {
  const config = loadProjectConfig(root);
  return { repo: config.repo, branches: config.prMedic?.branches ?? [], roster: config.roster, root };
}

const USAGE = "usage: bun pr-medic/push.ts <pr> --expect <sha>";

export function parseArgs(argv: readonly string[]): { pr: number; expect: string } | null {
  let pr: number | null = null;
  let expect: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--expect" && argv[index + 1] !== undefined) {
      expect = argv[index + 1] as string;
      index += 1;
    } else if (/^[1-9]\d*$/.test(arg) && pr === null) {
      pr = Number(arg);
    } else {
      return null;
    }
  }
  // A sha, never a ref: `--expect origin/x` would pin whatever the last fetch
  // left there, which is the bare lease's flaw this flag exists to avoid.
  if (pr === null || expect === null || !/^[0-9a-f]{7,64}$/i.test(expect)) return null;
  return { pr, expect };
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd(), deps?: PushDeps): number {
  const args = parseArgs(argv);
  if (args === null) {
    console.error(USAGE);
    return USAGE_EXIT;
  }
  const loop = env.RALPH_LOOP_NAME?.trim() ?? "";
  try {
    const root = projectRoot(cwd, env);
    const verdict = fence(deps ?? liveDeps(cwd, root), { ...args, loop, project: fenceProject(root) });
    (verdict.exit === 0 ? console.log : console.error)(verdict.lines.join("\n"));
    return verdict.exit;
  } catch (error) {
    // Never a push: every throw is before the push or is the push failing for
    // a reason other than the lease, and both leave the branch as it was.
    console.error(`${PREFIX}: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
