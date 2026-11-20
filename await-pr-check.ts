#!/usr/bin/env bun
/**
 * Judge an `<ralph>AWAIT_PR <n> ci|merge</ralph>` sigil BEFORE the supervisor
 * waits on it.
 *
 * #807: a testo session on branch `testo/2694-...` ended with
 * `AWAIT_PR 2694 ci` — the ISSUE number read off its branch name — while its
 * pull request was #2768. `pr-wait.ts` then waited on a number that was no
 * pull request at all, and the fresh session that followed was told about the
 * wrong one. A wrong number is cheap to catch here and costly to wait out.
 *
 * So `ralph.sh` asks this first. It refuses only what it can prove wrong: a
 * number that gh says is no pull request at all ("Could not resolve to a
 * PullRequest" — what an issue number gets). It never refuses a real PR
 * because the branch checked out has a different one: a session may
 * legitimately shepherd a queued PR from a checkout still on another branch,
 * and a refusal there would point it at the wrong PR (#807 review). The
 * branch's own open PR is read only to name the right number in the refusal.
 *
 * Everything it cannot judge passes (gh down, unparsable output): a judge that
 * cannot read must never stop a loop nobody is watching.
 *
 * CLI: `bun await-pr-check.ts <pr> [--mode ci|merge] [--branch <b>]`.
 * Exit 0 = pass, nothing on stdout. Exit 3 = refuse, the message for the
 * session on stdout. Anything unexpected exits 0 after a line on stderr.
 */
import { spawnSync } from "node:child_process";

export type Mode = "ci" | "merge";

export interface BranchPr {
  number: number;
  state: string;
}

/** The lookup of the sigil's number, done only when the branch has no PR. */
export type PrView = "found" | "not-found" | "unreadable";

export interface AwaitPrInput {
  pr: number;
  mode: Mode;
  /** The branch checked out; empty on a detached HEAD. */
  branch: string;
  /** What gh says the sigil's number is. */
  view: PrView;
  /** The branch's PRs, or null when unread; asked only to word a refusal. */
  branchPrs: () => BranchPr[] | null;
}

export type AwaitPrDecision = { verdict: "pass" } | { verdict: "refuse"; message: string };

const PASS: AwaitPrDecision = { verdict: "pass" };

const LEAD = "The supervisor refused your AWAIT_PR sigil and started no wait.";

export const decideAwaitPr = (input: AwaitPrInput): AwaitPrDecision => {
  const { pr, mode, branch } = input;
  if (input.view !== "not-found") return PASS;

  const notPr = `#${pr} is not a pull request (an issue number is not a PR number).`;
  const prs = branch ? input.branchPrs() : null;
  const open = (prs ?? []).filter((candidate) => candidate.state.toUpperCase() === "OPEN");
  if (open.length > 0) {
    const real = open[0]!.number;
    const others = open.slice(1).map((other) => `#${other.number}`);
    return {
      verdict: "refuse",
      message: [
        LEAD,
        notPr,
        `Branch ${branch} has open pull request #${real}${others.length > 0 ? ` (also ${others.join(", ")})` : ""}.`,
        `If your handoff note is written, it belongs at .ralph/logs/handoff-pr-${real}.md.`,
        `If that is the PR you meant, end again with <ralph>AWAIT_PR ${real} ${mode}</ralph>.`,
      ].join(" "),
    };
  }
  // No open PR on the branch: whatever closed or merged ones it has are not
  // what to wait on, so the session is told to open one rather than handed a
  // stale number.
  const where = branch ? `branch ${branch} has no open pull request` : "the checkout is on no ticket branch";
  return {
    verdict: "refuse",
    message: [
      LEAD,
      notPr,
      `And ${where}: open the PR first, or end with another sigil per §6.`,
      "Once it is open, write the handoff note at .ralph/logs/handoff-pr-<its number>.md and end with",
      `<ralph>AWAIT_PR <its number> ${mode}</ralph>.`,
    ].join(" "),
  };
};

/** `gh pr list --head <b> --state all --json number,state`, or null. */
export const parseBranchPrs = (raw: string): BranchPr[] | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const prs: BranchPr[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) return null;
      const { number, state } = item as { number?: unknown; state?: unknown };
      if (typeof number !== "number" || !Number.isInteger(number)) return null;
      prs.push({ number, state: typeof state === "string" ? state : "" });
    }
    return prs;
  } catch {
    return null;
  }
};

// Every spawn is bounded: the supervisor waits on this before every PR wait,
// and a hung gh must not become a hung loop.
const SPAWN_TIMEOUT_MS = 20_000;

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

// The project's repository, as pr-wait.ts reads it: gh's default repo for the
// checkout may be a fork's, where the real PR resolves to nothing.
const repoArgs = (): string[] => {
  const repo = process.env.RALPH_PROJECT_REPO?.trim();
  return repo ? ["--repo", repo] : [];
};

const viewPr = (pr: number): PrView => {
  const result = run("gh", ["pr", "view", String(pr), ...repoArgs(), "--json", "number"]);
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.stdout) as { number?: unknown };
      return parsed.number === pr ? "found" : "unreadable";
    } catch {
      return "unreadable";
    }
  }
  // Only gh's own words prove the number is no PR; any other failure (auth,
  // network, rate limit) is a read that did not happen.
  return /Could not resolve to a PullRequest/i.test(result.stderr) ? "not-found" : "unreadable";
};

const main = (argv: string[]): number => {
  const [prArg, ...rest] = argv;
  if (!prArg || !/^[1-9][0-9]*$/.test(prArg)) {
    console.error(`await-pr-check: no PR number to judge (${prArg ?? "none"}); passing.`);
    return 0;
  }
  let mode: Mode = "ci";
  let branch: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--mode" && (value === "ci" || value === "merge")) {
      mode = value;
      index += 1;
    } else if (flag === "--branch" && value !== undefined) {
      branch = value;
      index += 1;
    } else {
      console.error(`await-pr-check: ignoring argument ${flag}.`);
    }
  }
  if (branch === undefined) {
    const current = run("git", ["branch", "--show-current"]);
    // An unread branch only costs the refusal its real number.
    branch = current.ok ? current.stdout.trim() : "";
  }
  // The base branch is no ticket's branch: its "PRs" are whatever heads share
  // its name (a fork's `main`), never the one to name. Judged like no branch.
  if (branch && branch === process.env.RALPH_BASE_BRANCH?.trim()) branch = "";
  const pr = Number(prArg);
  const resolved = branch;
  const branchPrs = (): BranchPr[] | null => {
    const listed = run("gh", ["pr", "list", ...repoArgs(), "--head", resolved, "--state", "all", "--json", "number,state"]);
    const prs = listed.ok ? parseBranchPrs(listed.stdout) : null;
    if (prs === null) console.error(`await-pr-check: could not read the PRs of ${resolved}.`);
    return prs;
  };
  const decision = decideAwaitPr({ pr, mode, branch: resolved, view: viewPr(pr), branchPrs });
  if (decision.verdict === "pass") return 0;
  process.stdout.write(`${decision.message}\n`);
  return 3;
};

if (import.meta.main) {
  let status = 0;
  try {
    status = main(process.argv.slice(2));
  } catch (error) {
    // Degrade, never refuse on error: the wait starts as it always did.
    console.error(`await-pr-check: ${error instanceof Error ? error.message : String(error)}; passing.`);
    status = 0;
  }
  process.exit(status);
}
