/**
 * The git and gh mechanics of a verifier revert (felipearos/ralph#568, spec
 * #560): read a merged PR, find a revert already opened for it, revert its
 * merge commit in a scratch worktree, push it, open the PR, and read that PR's
 * checks back.
 *
 * No tracker, store or policy here: the gate decides WHETHER to revert; this
 * only knows HOW. The scratch worktree never touches the project's own
 * checkout (a loop may be mid-iteration in it) and is always removed.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { judgeCi, parseSnapshot, relevantChecks } from "../pr-wait";
import type { Gh } from "./deploys";
import { VERIFIER_REVERT_MARKER } from "./merged";

/** One git command's outcome, the shape of {@link Gh}. */
export type Git = (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** The real runner: bounded, so a hung fetch or push is a failed step rather than a hung gate. */
export const realGit: Git = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
    });
  });

export const revertBranch = (pr: number): string => `verifier/revert-${pr}`;

/** Starts with VERIFIER_REVERT_MARKER, so `merged.ts` never watches the verifier's own revert. */
export const revertMarker = (pr: number): string => `${VERIFIER_REVERT_MARKER} pr=${pr} -->`;

/**
 * Whether a PR is itself a revert, by the verifier or by a person: reverting
 * a revert would put the broken change back.
 */
export function isRevert(pr: { title: string; body: string }): boolean {
  if (pr.body.includes(VERIFIER_REVERT_MARKER)) return true;
  // `git revert` and GitHub's revert button both title it `Revert "<original>"`.
  if (pr.title.startsWith('Revert "')) return true;
  // GitHub's revert button writes `Reverts owner/repo#n` as the body.
  return /^Reverts [\w.-]+\/[\w.-]+#\d+\s*$/m.test(pr.body);
}

const failed = (what: string, result: { stderr: string; stdout: string }): Error =>
  new Error(`${what} failed: ${(result.stderr || result.stdout).trim()}`);

export async function readPr(gh: Gh, pr: number): Promise<{ title: string; body: string }> {
  const result = await gh(["pr", "view", String(pr), "--json", "title,body"]);
  if (!result.ok) throw failed(`gh pr view ${pr}`, result);
  const parsed = JSON.parse(result.stdout) as { title?: unknown; body?: unknown };
  if (typeof parsed.title !== "string") throw new Error(`gh pr view ${pr} answered no title`);
  return { title: parsed.title, body: typeof parsed.body === "string" ? parsed.body : "" };
}

export async function existingRevertPr(
  gh: Gh,
  pr: number,
): Promise<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string } | null> {
  const result = await gh(["pr", "list", "--head", revertBranch(pr), "--state", "all", "--json", "number,state,url"]);
  if (!result.ok) throw failed(`gh pr list --head ${revertBranch(pr)}`, result);
  const found = JSON.parse(result.stdout) as { number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string }[];
  // gh lists newest first, and the newest is the attempt that counts.
  const first = found[0];
  return first === undefined ? null : { number: first.number, state: first.state, url: first.url };
}

export type PreparedRevert =
  | { kind: "pushed"; branch: string; sha: string }
  | { kind: "conflict"; files: string[]; commits: { sha: string; subject: string }[] }
  /** The revert staged nothing: the base branch no longer holds the change. */
  | { kind: "empty" };

/**
 * Revert `mergeCommit` on top of origin/<baseBranch> in a scratch worktree and
 * push it to revertBranch(pr). A conflict is reported, never resolved: a
 * resolution nobody reviewed is a new change, not a revert.
 */
export async function pushRevert(
  deps: { git: Git; repoRoot: string; baseBranch: string; tmpRoot?: string },
  revert: { pr: number; mergeCommit: string; message: string },
): Promise<PreparedRevert> {
  const { git, repoRoot, baseBranch } = deps;
  const step = async (args: string[], cwd: string): Promise<string> => {
    const result = await git(args, cwd);
    if (!result.ok) throw failed(`git ${args.join(" ")}`, result);
    return result.stdout;
  };

  await step(["fetch", "origin", baseBranch], repoRoot);
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "verifier-revert-"));
  try {
    await step(["worktree", "add", "--detach", tmp, `origin/${baseBranch}`], repoRoot);
    const parents = (await step(["rev-list", "--parents", "-n", "1", revert.mergeCommit], tmp)).trim().split(/\s+/).length - 1;
    // A true merge commit needs a mainline; the base branch's side is the first parent.
    const mainline = parents >= 2 ? ["-m", "1"] : [];
    const reverted = await git(["revert", "--no-commit", ...mainline, revert.mergeCommit], tmp);
    if (!reverted.ok) {
      const files = (await step(["diff", "--name-only", "--diff-filter=U"], tmp)).split("\n").filter((line) => line !== "");
      if (files.length === 0) throw failed(`git revert ${revert.mergeCommit}`, reverted);
      const commits = (await step(["log", "--format=%H%x09%s", `${revert.mergeCommit}..HEAD`, "--", ...files], tmp))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const tab = line.indexOf("\t");
          return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
        });
      // The worktree is removed below either way; aborting first keeps a
      // failed removal from leaving a half-reverted tree behind.
      await git(["revert", "--abort"], tmp);
      return { kind: "conflict", files, commits };
    }
    // A later commit already undid the change: committing would fail (or
    // push an empty revert), and the verifier reads it as already reverted.
    const staged = await git(["diff", "--cached", "--quiet"], tmp);
    if (staged.ok) return { kind: "empty" };
    await step(["commit", "-m", revert.message], tmp);
    const sha = (await step(["rev-parse", "HEAD"], tmp)).trim();
    const branch = revertBranch(revert.pr);
    // Forced: the branch is the verifier's own, and a crashed earlier attempt may have left one.
    await step(["push", "--force", "origin", `HEAD:refs/heads/${branch}`], tmp);
    return { kind: "pushed", branch, sha };
  } finally {
    // Best effort: a cleanup failure must not mask the revert's own result.
    const removed = await git(["worktree", "remove", "--force", tmp], repoRoot).catch(() => ({ ok: false }));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Left for the OS's temp cleaner.
    }
    if (!removed.ok) await git(["worktree", "prune"], repoRoot).catch(() => undefined);
  }
}

export async function openRevertPr(
  gh: Gh,
  pr: { base: string; branch: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  // A body file, not `--body`: a long body with the marker must not ride argv.
  const dir = mkdtempSync(join(tmpdir(), "verifier-revert-body-"));
  try {
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, pr.body);
    const result = await gh(["pr", "create", "--base", pr.base, "--head", pr.branch, "--title", pr.title, "--body-file", bodyFile]);
    if (!result.ok) throw failed(`gh pr create --head ${pr.branch}`, result);
    // gh prints the new PR's URL last.
    const url = /(https:\/\/\S+\/pull\/(\d+))\s*$/.exec(result.stdout.trim());
    if (url === null) throw new Error(`gh pr create printed no PR URL: ${result.stdout.trim().slice(0, 200)}`);
    return { number: Number(url[2]), url: url[1]! };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MERGEABLE_STATES = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];

export type RevertPrStatus = { state: "OPEN" | "CLOSED" | "MERGED"; checks: "green" | "red" | "pending"; mergeable: boolean };

export async function revertPrStatus(gh: Gh, pr: number, required: string[]): Promise<RevertPrStatus> {
  const result = await gh(["pr", "view", String(pr), "--json", "state,mergedAt,labels,headRefOid,statusCheckRollup,mergeable,mergeStateStatus"]);
  if (!result.ok) throw failed(`gh pr view ${pr}`, result);
  const snapshot = parseSnapshot(result.stdout);
  if (snapshot === null) throw new Error(`gh pr view ${pr} answered unparseable output: ${result.stdout.trim().slice(0, 200)}`);
  const { mergeable, mergeStateStatus } = JSON.parse(result.stdout) as { mergeable?: unknown; mergeStateStatus?: unknown };
  // No checks yet is not "nothing to wait for": CI registers them after the push.
  const verdict = judgeCi(relevantChecks(snapshot.checks, required), 0, 1);
  return {
    state: snapshot.state,
    checks: verdict === "green" || verdict === "red" ? verdict : "pending",
    // BLOCKED is a missing review or rule: it waits, and the stale timer pages a person.
    mergeable: mergeable === "MERGEABLE" && typeof mergeStateStatus === "string" && MERGEABLE_STATES.includes(mergeStateStatus),
  };
}
