/**
 * Open the PR a passed proposal stands for (#875): a proposal whose full-set
 * run passed its guardrail verdict becomes a real change to the harness on a
 * branch of its own — the overlay's prompt files, or the lineup in
 * `models.json` — and a PR a person reviews.
 *
 * This only ever opens. Merging or closing is a person's decision, so nothing
 * here asks gh to approve or land a PR, or pushes to the base branch. The
 * scratch worktree never touches the harness checkout (live loops read it)
 * and is always removed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LineupContent } from "./eval-improver";
import { proposedLineup } from "./eval-lineup";
import { proposalCommitMessage, proposalPrBody, proposalPrTitle } from "./eval-pr-body";
import { promptHash, type ProposalState, type StoredProposal } from "./eval-proposals";
import type { EvalRunSummary } from "./eval-runs";
import { validateConfig } from "./models";
import { applyOverlay, isPromptFile } from "./prompt-overlay";
import type { Gh } from "./verifier/deploys";
import { openRevertPr, type Git } from "./verifier/revert";

export const proposalBranch = (id: string): string => `evals/proposal-${id}`;

/** First line of the body: how the improver finds its own PR again. */
export const proposalMarker = (id: string): string => `<!-- ralph-eval-proposal: ${id} -->`;

export interface OpenProposalPrDeps {
  git: Git;
  /** Runs in the harness repo. */
  gh: Gh;
  harnessRoot: string;
  baseBranch: string;
  tmpRoot?: string;
}

export interface OpenProposalPrInput {
  proposal: StoredProposal;
  state: ProposalState;
  /** The full-set run the verdict was read from. */
  run: EvalRunSummary;
}

export type OpenedProposalPr =
  | { kind: "exists"; number: number; url: string }
  | { kind: "opened"; number: number; url: string; branch: string; files: string[] };

const failed = (what: string, result: { stderr: string; stdout: string }): Error =>
  new Error(`${what} failed: ${(result.stderr || result.stdout).trim()}`);

export async function openProposalPr(deps: OpenProposalPrDeps, input: OpenProposalPrInput): Promise<OpenedProposalPr> {
  const { git, gh, harnessRoot, baseBranch } = deps;
  const { proposal, state, run } = input;
  // Only a verdict a full-set run earned ships: a subset run is a hint, not evidence.
  if (state.status !== "passed") throw new Error(`proposal ${proposal.id} is ${state.status}, not passed: no PR is opened`);
  if (state.runs.full !== run.id) {
    throw new Error(`run ${run.id} is not proposal ${proposal.id}'s full-set run (${state.runs.full ?? "none"}): no PR is opened`);
  }

  const branch = proposalBranch(proposal.id);
  const listed = await gh(["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url"]);
  if (!listed.ok) throw failed(`gh pr list --head ${branch}`, listed);
  const found = JSON.parse(listed.stdout) as { number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string }[];
  const open = found.find((pr) => pr.state === "OPEN");
  if (open !== undefined) return { kind: "exists", number: open.number, url: open.url };
  // A merged or closed PR is a person's answer; reopening it as a new PR would ask again.
  const decided = found[0];
  if (decided !== undefined) {
    throw new Error(`proposal ${proposal.id} already had PR #${decided.number} (${decided.state.toLowerCase()}, ${decided.url}): a person decided it`);
  }

  const step = async (args: string[], cwd: string): Promise<string> => {
    const result = await git(args, cwd);
    if (!result.ok) throw failed(`git ${args.join(" ")}`, result);
    return result.stdout;
  };

  // A run killed mid-way (the page's exec timeout) leaves its scratch worktree registered; clear those first.
  await git(["worktree", "prune"], harnessRoot).catch(() => undefined);
  await step(["fetch", "origin", baseBranch], harnessRoot);
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "eval-proposal-pr-"));
  let files: string[];
  try {
    await step(["worktree", "add", "--detach", tmp, `origin/${baseBranch}`], harnessRoot);
    if (proposal.kind === "prompt-overlay") {
      await refuseMovedBase(proposal, tmp, baseBranch, step);
      applyOverlay(join(dirname(proposal.path), proposal.id, "overlay"), tmp);
    } else {
      // Rebuilt over the base's CURRENT models.json rather than copied from the
      // trial's lineup file: that copy is a snapshot from when the proposal
      // ran, and shipping it would silently revert every later edit to models.json.
      const config = JSON.parse(readFileSync(join(tmp, "models.json"), "utf8")) as Record<string, unknown>;
      const proposed = proposedLineup(config, (proposal.content as LineupContent).stages);
      const { problems } = validateConfig(proposed);
      if (problems.length > 0) throw new Error(`proposal ${proposal.id}'s lineup is not a valid models.json on origin/${baseBranch}: ${problems.join("; ")}`);
      writeFileSync(join(tmp, "models.json"), `${JSON.stringify(proposed, null, 2)}\n`);
    }
    await step(["add", "-A"], tmp);
    files = (await step(["diff", "--cached", "--name-only"], tmp)).split("\n").filter((line) => line !== "");
    // The fence on what was actually staged, not on what the proposal claims:
    // a PR that touched anything else would ship a change no eval measured.
    const stray = proposal.kind === "prompt-overlay"
      ? files.filter((file) => !isPromptFile(file))
      : files.filter((file) => file !== "models.json");
    if (stray.length > 0) throw new Error(`proposal ${proposal.id} would change ${stray.join(", ")}, which a ${proposal.kind} proposal may not touch`);
    if (files.length === 0) throw new Error(`origin/${baseBranch} already holds this change: proposal ${proposal.id} has nothing to open`);
    await step(["commit", "-m", proposalCommitMessage(proposal, run)], tmp);
    // Forced: the branch is the improver's own, and a crashed earlier attempt may have left one.
    await step(["push", "--force", "origin", `HEAD:refs/heads/${branch}`], tmp);
  } finally {
    // Best effort: a cleanup failure must not mask the attempt's own result.
    const removed = await git(["worktree", "remove", "--force", tmp], harnessRoot).catch(() => ({ ok: false }));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Left for the OS's temp cleaner.
    }
    if (!removed.ok) await git(["worktree", "prune"], harnessRoot).catch(() => undefined);
  }

  let pr: { number: number; url: string };
  try {
    pr = await openRevertPr(gh, {
      base: baseBranch,
      branch,
      title: proposalPrTitle(proposal),
      body: proposalPrBody({ proposal, state, run, marker: proposalMarker(proposal.id) }),
    });
  } catch (error) {
    // Two clicks (local and relayed) can both pass the lookup above; the loser's create
    // fails because the winner's PR exists, and that PR is the answer, not a failure.
    const again = await gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,state,url"]);
    const raced = again.ok ? (JSON.parse(again.stdout) as { number: number; url: string }[])[0] : undefined;
    if (raced !== undefined) return { kind: "exists", number: raced.number, url: raced.url };
    throw error;
  }
  return { kind: "opened", number: pr.number, url: pr.url, branch, files };
}

/**
 * An overlay replaces files whole, so laid over a base that moved since the
 * trial it would silently revert those later edits, shipping a change no eval
 * measured. Refuse instead: proposing again reads the current text.
 */
async function refuseMovedBase(
  proposal: StoredProposal,
  tmp: string,
  baseBranch: string,
  step: (args: string[], cwd: string) => Promise<string>,
): Promise<void> {
  const files = Object.keys((proposal.content as { files?: Record<string, string> } | null)?.files ?? {});
  let moved: string[];
  if (proposal.bases !== undefined) {
    moved = files.filter((file) => {
      const recorded = proposal.bases![file];
      let current: string | null;
      try { current = promptHash(readFileSync(join(tmp, file), "utf8")); } catch { current = null; }
      return recorded === undefined || recorded !== current;
    });
  } else {
    // A proposal written before bases were recorded: any commit to its files since it was made counts as moved.
    const log = await step(["log", "--format=%h", `--since=${proposal.createdAt}`, `origin/${baseBranch}`, "--", ...files], tmp);
    moved = log.trim() === "" ? [] : files;
  }
  if (moved.length > 0) {
    throw new Error(`origin/${baseBranch} changed ${moved.join(", ")} since proposal ${proposal.id} was made: the overlay would revert that; propose again on the current prompts`);
  }
}
