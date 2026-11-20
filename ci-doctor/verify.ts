#!/usr/bin/env bun
/**
 * The diff guard in the ci-doctor's verify phase.
 *
 * §4 of the doctor's iteration (`prompts/ci-doctor.md`) runs the local gates;
 * this is the gate on what the doctor itself wrote. The rules live in
 * `executor-guard/diff-guard.ts`, one implementation shared with the
 * executor's own guard, so the doctor
 * cannot produce a diff in the sandbox that the verify phase would then wave
 * through — or the other way about.
 *
 * What is here rather than there is everything the sandbox has no business
 * doing: finding the base, asking `git` for the diff, and generating the
 * `git revert <culprit>` to compare against for the auto-revert path.
 *
 * Usage:
 *   bun ci-doctor/verify.ts [--base <ref>] [--revert-of <sha>] [--pr-body <file>] [--json]
 *
 * Exit 0 when the diff may land, 10 when it is refused (the findings are on
 * stderr, matching the executor guard's `REFUSED_EXIT`), 64 on bad usage and
 * 1 when git could not be asked.
 *
 * felipearos/ralph#152
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  diffGuardProblems,
  diffRefusalMessage,
  parseTimeoutEvidence,
  readDiffGuardConfig,
  REFUSED_DIFF_EXIT,
  type DiffGuardConfig,
  type TimeoutEvidence,
} from "../executor-guard/diff-guard";

/** Everything that reaches outside this process, so a test can supply it. */
export interface VerifyDeps {
  git(args: string[]): string;
  read(path: string): string;
  exists(path: string): boolean;
}

export interface VerifyOptions {
  /** What to diff against. Defaults to the merge-base with the base branch. */
  base: string;
  /** The culprit a revert claims to undo, for the exact-revert exception. */
  revertOf: string | null;
  /** The PR body, which carries the evidence for any raised timeout. */
  prBody: string | null;
}

/**
 * Everything the doctor has written on this branch, as one diff.
 *
 * `git diff <base>` reaches the working tree, so it covers the commits since
 * the base AND what is still staged or unstaged. The verify phase runs before
 * the commit as often as after it, and a guard that read only `HEAD` would
 * wave through a weakening still sitting unstaged — which is exactly the
 * state an executor hands back.
 *
 * Untracked files are appended separately, because `git diff` cannot see
 * them. A new file is the cheapest way round a guard that only reads edits:
 * a fresh `vitest.config.ts` beside the real one, or a `.buildkite/` step,
 * would otherwise never be judged.
 */
export function collectDiff(deps: VerifyDeps, base: string): string {
  const parts = [deps.git(["diff", base])];
  const untracked = deps
    .git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const path of untracked) parts.push(deps.git(["diff", "--no-index", "--", "/dev/null", path]));
  return parts.filter((part) => part.trim() !== "").join("\n");
}

/** The diff `git revert <sha>` would produce on this base: the sha's, backwards. */
export function revertDiff(deps: VerifyDeps, sha: string): string {
  return deps.git(["diff", sha, `${sha}^`]);
}

/** The nearest `.ralph/config.json` at or above `from`, or null. */
export function nearestConfig(deps: VerifyDeps, from: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, ".ralph", "config.json");
    if (deps.exists(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** The verdict on what the doctor wrote. Empty means it may land. */
export function verify(deps: VerifyDeps, cwd: string, options: VerifyOptions): string[] {
  const config: DiffGuardConfig = readDiffGuardConfig(nearestConfig(deps, cwd), deps.read);
  const evidence: TimeoutEvidence | null = options.prBody === null ? null : parseTimeoutEvidence(options.prBody);
  const revert = options.revertOf === null ? null : revertDiff(deps, options.revertOf);
  return diffGuardProblems(collectDiff(deps, options.base), { config, evidence, revert });
}

/** The deps as the CLI has them: real git, real files. */
export function liveDeps(cwd: string): VerifyDeps {
  return {
    git(args) {
      const out = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      // `git diff --no-index` reports a difference as exit 1, which is the
      // normal case here, not a failure.
      const expected = args[0] === "diff" ? [0, 1] : [0];
      if (!expected.includes(out.status ?? -1)) throw new Error(`git ${args.join(" ")} failed: ${(out.stderr || "").trim()}`);
      return out.stdout ?? "";
    },
    read: (path) => readFileSync(path, "utf8"),
    exists: (path) => existsSync(path),
  };
}

/** The merge-base with the base branch, which is what the PR's diff is against. */
export function defaultBase(deps: VerifyDeps, env: NodeJS.ProcessEnv): string {
  const branch = env.RALPH_BASE_BRANCH?.trim() || "main";
  try {
    return deps.git(["merge-base", `origin/${branch}`, "HEAD"]).trim() || branch;
  } catch {
    return branch;
  }
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, deps?: VerifyDeps): number {
  const cwd = process.cwd();
  const resolved = deps ?? liveDeps(cwd);
  const options: VerifyOptions = { base: "", revertOf: null, prBody: null };
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if ((flag === "--base" || flag === "--revert-of" || flag === "--pr-body") && value !== undefined) {
      if (flag === "--base") options.base = value;
      if (flag === "--revert-of") options.revertOf = value;
      if (flag === "--pr-body") options.prBody = resolved.read(value);
      index += 1;
      continue;
    }
    console.error(
      `ci-doctor/verify: unknown argument ${flag}\n` +
        "usage: bun ci-doctor/verify.ts [--base <ref>] [--revert-of <sha>] [--pr-body <file>] [--json]",
    );
    return 64;
  }

  let problems: string[];
  try {
    if (options.base === "") options.base = defaultBase(resolved, env);
    problems = verify(resolved, cwd, options);
  } catch (error) {
    console.error(`ci-doctor/verify: ${(error as Error).message}`);
    return 1;
  }

  if (json) console.log(JSON.stringify({ problems, refused: problems.length > 0 }, null, 2));
  else if (problems.length === 0) console.log("ci-doctor/verify: the diff is the doctor's to make.");
  else console.error(diffRefusalMessage(problems));
  return problems.length === 0 ? 0 : REFUSED_DIFF_EXIT;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
