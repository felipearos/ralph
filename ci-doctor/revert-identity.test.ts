// @vitest-environment node
/**
 * #162's AC 1, the half a mocked `git` cannot discharge:
 *
 *   "the doctor opens exactly one revert PR whose diff is **byte-identical** to
 *   `git revert <culprit>`"
 *
 * `ci-doctor/revert.test.ts` asserts that `git revert --no-edit <sha>` is the
 * command run and that nothing reconstructs the diff by hand, which is as far
 * as a recording fake can go. What this file adds is REAL git on the AC's own
 * "synthetic main".
 *
 * One precision about the word "byte-identical". What is asserted here is the
 * operative contract rather than the literal bytes: `revertSignature`
 * (`executor-guard/diff-guard.ts:758`) is a normalising projection — it drops
 * blob hashes and hunk offsets, which two `git revert` runs legitimately
 * differ on — so the claim proved is "the diff guard's exact-revert exception
 * accepts what `probeRevert` commits". That is the property the feature needs,
 * and literal byte equality is neither achievable nor what the guard checks.
 *
 * It is the only test in `ci-doctor/` that runs git. That is deliberate and
 * worth the ~1s: the exception is what lets a revert leave the doctor's fix
 * scope, so a drift between what `probeRevert` commits and what
 * `revertSignature` recognises would hand the doctor a diff its own guard
 * refuses — and nothing else in the suite would notice.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffGuardProblems, resolveConfig, revertSignature } from "../executor-guard/diff-guard";

import { probeRevert, scratchBranch, type Git } from "./revert";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository with a green `main`, one commit that breaks a test, and an `origin/main` to cut from. */
function syntheticMain(): { cwd: string; git: Git; culprit: string } {
  const cwd = mkdtempSync(join(tmpdir(), "revert-identity-"));
  dirs.push(cwd);
  const run = (args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      // Captured, not inherited: this helper is used for deliberately failing
      // probes too, and an inherited stderr prints git's complaint into the
      // suite's output as though something had gone wrong.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  run(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(cwd, "a.ts"), "export const n = 1;\n");
  writeFileSync(join(cwd, "a.test.ts"), "it('renders', () => expect(n).toBe(1));\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "green"]);
  writeFileSync(join(cwd, "a.ts"), "export const n = 2;\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "feat: bump n (#300)"]);
  const culprit = run(["rev-parse", "HEAD"]).trim();
  // `origin/main` without a remote: the ref is all `probeRevert` reads.
  run(["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const git: Git = (args) => {
    try {
      return { ok: true, stdout: run(args), stderr: "" };
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
    }
  };
  return { cwd, git, culprit };
}

describe("AC 1 — byte-identical to `git revert <culprit>`, against real git", () => {
  it("commits exactly what the diff guard recognises as an exact revert", () => {
    const { git, culprit } = syntheticMain();

    const probe = probeRevert({ git }, { sha: culprit, baseBranch: "main" });
    expect(probe.clean).toBe(true);
    expect(probe.branch).toBe(scratchBranch(culprit));

    // What the doctor's branch now holds, as `ci-doctor/verify.ts` collects it.
    const committed = git(["diff", "origin/main"]).stdout;
    // What the guard compares it against: `revertDiff`, i.e. the culprit backwards.
    const expected = git(["diff", culprit, `${culprit}^`]).stdout;

    expect(committed.trim()).not.toBe("");
    expect(revertSignature(committed)).toBe(revertSignature(expected));
    // Exactly ONE commit on the branch, which the spec's step 2 asks for and
    // the diff alone cannot show: two commits that cancel out to the same tree
    // would produce this same diff.
    expect(git(["rev-list", "--count", "origin/main..HEAD"]).stdout.trim()).toBe("1");
    // And it is a revert in git's own eyes, not merely a diff that matches.
    expect(git(["log", "-1", "--format=%s"]).stdout).toMatch(/^Revert "/);
    // And the guard therefore lets it through, fix scope and all — this is the
    // whole reason the commit must come from `git revert` and not be rebuilt.
    expect(diffGuardProblems(committed, { config: resolveConfig({ fixScope: ["**/*.test.ts"] }), revert: expected })).toEqual([]);
  });

  it("the same diff is refused when it is NOT offered as a revert", () => {
    const { git, culprit } = syntheticMain();
    probeRevert({ git }, { sha: culprit, baseBranch: "main" });
    const committed = git(["diff", "origin/main"]).stdout;

    // `a.ts` is outside any plausible fix scope, so without the exception the
    // very same bytes are out of bounds. If this ever passes, the exception is
    // not what is letting the revert through and the test above proves nothing.
    const config = resolveConfig({ fixScope: ["**/*.test.ts"] });
    const problems = diffGuardProblems(committed, { config });
    expect(problems).not.toEqual([]);
    expect(problems.join("\n")).toContain("outside the doctor's fix scope");
  });

  it("backs a conflicting revert out and leaves the checkout on the base", () => {
    const { git, culprit } = syntheticMain();
    // Move main on top of the culprit so reverting it conflicts.
    git(["switch", "--quiet", "main"]);
    writeFileSync(join(git(["rev-parse", "--show-toplevel"]).stdout.trim(), "a.ts"), "export const n = 99;\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "later change"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const probe = probeRevert({ git }, { sha: culprit, baseBranch: "main" });
    expect(probe.clean).toBe(false);
    expect(probe.branch).toBeNull();
    // Nothing left behind: no scratch branch, no revert in progress, clean tree.
    expect(git(["rev-parse", "--verify", `refs/heads/${scratchBranch(culprit)}`]).ok).toBe(false);
    expect(git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });
});
