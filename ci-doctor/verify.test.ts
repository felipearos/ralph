// @vitest-environment node
/**
 * What the ci-doctor's verify-phase diff gate is pinned to.
 *
 * The rules themselves are pinned in `executor-guard/diff-guard.test.ts`;
 * what is pinned here is everything this module adds around them — which
 * `git` questions it asks, that the working tree and untracked files are
 * judged and not only the commits, how the base is resolved, and the exit
 * codes the doctor's iteration reads.
 *
 * `git` is injected, so no test here runs one.
 *
 * felipearos/ralph#152
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectDiff, defaultBase, liveDeps, main, nearestConfig, verify, type VerifyDeps } from "./verify";

const SKIP_DIFF = [
  "diff --git a/src/a.test.ts b/src/a.test.ts",
  "--- a/src/a.test.ts",
  "+++ b/src/a.test.ts",
  "@@ -1 +1 @@",
  '-  it("x", () => {});',
  '+  it.skip("x", () => {});',
  "",
].join("\n");

const CLEAN_DIFF = [
  "diff --git a/src/a.test.ts b/src/a.test.ts",
  "--- a/src/a.test.ts",
  "+++ b/src/a.test.ts",
  "@@ -1 +1 @@",
  "-  const rows = walk(repo);",
  "+  const rows = scanned.rows;",
  "",
].join("\n");

function deps(overrides: { git?: Record<string, string>; files?: Record<string, string> } = {}): VerifyDeps & { asked: string[][] } {
  const asked: string[][] = [];
  const files = overrides.files ?? {};
  return {
    asked,
    git(args) {
      asked.push(args);
      return overrides.git?.[args.join(" ")] ?? "";
    },
    read: (path) => files[path] ?? "",
    exists: (path) => path in files,
  };
}

describe("collectDiff", () => {
  it("diffs the base against the working tree, not against HEAD", () => {
    const fake = deps({ git: { "diff abc123": CLEAN_DIFF } });
    expect(collectDiff(fake, "abc123")).toBe(CLEAN_DIFF);
    // Two dots to the working tree: a weakening left unstaged is still judged.
    expect(fake.asked[0]).toEqual(["diff", "abc123"]);
  });

  it("appends every untracked file, which `git diff` cannot see", () => {
    const fake = deps({
      git: {
        "diff abc123": CLEAN_DIFF,
        "ls-files --others --exclude-standard": "vitest.config.ts\n\nsrc/b.test.ts\n",
        "diff --no-index -- /dev/null vitest.config.ts": "diff --git a/vitest.config.ts b/vitest.config.ts\n",
        "diff --no-index -- /dev/null src/b.test.ts": "diff --git a/src/b.test.ts b/src/b.test.ts\n",
      },
    });
    const diff = collectDiff(fake, "abc123");
    expect(diff).toContain("vitest.config.ts");
    expect(diff).toContain("src/b.test.ts");
    expect(fake.asked).toHaveLength(4);
  });
});

describe("nearestConfig", () => {
  it("walks up to the nearest .ralph/config.json, and gives null when there is none", () => {
    const path = "/repo/.ralph/config.json";
    expect(nearestConfig(deps({ files: { [path]: "{}" } }), "/repo/src/app")).toBe(path);
    expect(nearestConfig(deps(), "/repo/src/app")).toBeNull();
  });
});

describe("defaultBase", () => {
  it("is the merge-base with the configured base branch", () => {
    const fake = deps({ git: { "merge-base origin/trunk HEAD": "abc123\n" } });
    expect(defaultBase(fake, { RALPH_BASE_BRANCH: "trunk" })).toBe("abc123");
  });

  it("falls back to the branch name when git cannot answer", () => {
    const fake: VerifyDeps = {
      git() {
        throw new Error("no such ref");
      },
      read: () => "",
      exists: () => false,
    };
    expect(defaultBase(fake, {})).toBe("main");
  });
});

describe("verify", () => {
  it("refuses a weakening in the working tree", () => {
    const fake = deps({ git: { "diff base": SKIP_DIFF } });
    expect(verify(fake, "/repo", { base: "base", revertOf: null, prBody: null })).toEqual([
      "src/a.test.ts: adds `.skip` (1 more than it removes, within one hunk) — a test that does not run is not a fix.",
    ]);
  });

  it("accepts a diff that only rewrites how a test gets its data", () => {
    expect(verify(deps({ git: { "diff base": CLEAN_DIFF } }), "/repo", { base: "base", revertOf: null, prBody: null })).toEqual([]);
  });

  it("reads the project's ciDoctor rules rather than only the defaults", () => {
    const config = JSON.stringify({ ciDoctor: { fixScope: ["spec/**"], neverTouch: [".ci/**"] } });
    const fake = deps({ git: { "diff base": CLEAN_DIFF }, files: { "/repo/.ralph/config.json": config } });
    // `src/a.test.ts` is in the default scope and outside this project's.
    expect(verify(fake, "/repo", { base: "base", revertOf: null, prBody: null })).toEqual([
      "src/a.test.ts: outside the doctor's fix scope (spec/**).",
    ]);
  });

  it("takes the timeout evidence from the PR body", () => {
    const raise = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,2 +1,2 @@",
      '   it("walks", () => {',
      "-  }, 5000);",
      "+  }, 20000);",
      "",
    ].join("\n");
    const fake = deps({ git: { "diff base": raise } });
    const options = { base: "base", revertOf: null };
    expect(verify(fake, "/repo", { ...options, prBody: null })).toHaveLength(1);
    expect(verify(fake, "/repo", { ...options, prBody: "timeout-evidence: ci=9s local=2s" })).toEqual([]);
  });

  it("asks git for the culprit's reverse diff when a revert is claimed", () => {
    const fake = deps({ git: { "diff base": CLEAN_DIFF, "diff dead1 dead1^": CLEAN_DIFF } });
    expect(verify(fake, "/repo", { base: "base", revertOf: "dead1", prBody: null })).toEqual([]);
    expect(fake.asked).toContainEqual(["diff", "dead1", "dead1^"]);
  });

  it("refuses a claimed revert that is not the culprit's diff backwards", () => {
    const fake = deps({ git: { "diff base": SKIP_DIFF, "diff dead1 dead1^": CLEAN_DIFF } });
    expect(verify(fake, "/repo", { base: "base", revertOf: "dead1", prBody: null })[0]).toBe(
      "the diff is offered as a revert but is not byte-identical to `git revert` on this base.",
    );
  });
});

describe("the CLI", () => {
  it("exits 10 on a refusal and 0 on a clean diff", () => {
    expect(main(["--base", "base"], {}, deps({ git: { "diff base": SKIP_DIFF } }))).toBe(10);
    expect(main(["--base", "base"], {}, deps({ git: { "diff base": CLEAN_DIFF } }))).toBe(0);
  });

  it("exits 64 on an unknown argument", () => {
    expect(main(["--heal"], {}, deps())).toBe(64);
  });

  it("exits 1 when git cannot be asked, rather than reporting a clean diff", () => {
    const broken: VerifyDeps = {
      git() {
        throw new Error("not a git repository");
      },
      read: () => "",
      exists: () => false,
    };
    expect(main(["--base", "base"], {}, broken)).toBe(1);
  });

  it("resolves the base itself when none is given", () => {
    const fake = deps({ git: { "merge-base origin/main HEAD": "abc123\n", "diff abc123": CLEAN_DIFF } });
    expect(main([], {}, fake)).toBe(0);
    expect(fake.asked[0]).toEqual(["merge-base", "origin/main", "HEAD"]);
  });
});

describe("liveDeps, against a real git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A repo with one commit, so `git diff <base>` has something to say. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-doctor-verify-"));
    dirs.push(dir);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    };
    git("init", "--quiet", "-b", "main");
    git("config", "user.email", "loop@example.test");
    git("config", "user.name", "Loop");
    writeFileSync(join(dir, "a.test.ts"), 'it("x", () => {});\n');
    git("add", "-A");
    git("commit", "--quiet", "-m", "first");
    return dir;
  }

  it("reads an edit to a tracked file that is not yet committed", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.test.ts"), 'it.skip("x", () => {});\n');
    const diff = collectDiff(liveDepsIn(dir), "HEAD");
    expect(diff).toContain("+it.skip");
  });

  it("reads an untracked file, where `git diff --no-index` exits 1 by design", () => {
    // The exit-1 tolerance in `liveDeps` is load-bearing: without it this
    // throws, and a brand-new weakening file is never judged.
    const dir = repo();
    writeFileSync(join(dir, "vitest.config.ts"), 'export default { test: { exclude: ["a.test.ts"] } };\n');
    const diff = collectDiff(liveDepsIn(dir), "HEAD");
    expect(diff).toContain("vitest.config.ts");
    expect(diff).toContain("+export default");
  });

  it("throws rather than reporting a clean diff when the ref does not exist", () => {
    expect(() => collectDiff(liveDepsIn(repo()), "no-such-ref")).toThrow(/git diff/);
  });

  /** `liveDeps` resolves its cwd at construction; these run outside the repo. */
  function liveDepsIn(dir: string): VerifyDeps {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return liveDeps(dir);
    } finally {
      process.chdir(previous);
    }
  }
});
