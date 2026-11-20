// @vitest-environment node
/**
 * A live loop's identity must not reach the suite it runs as a gate: with it,
 * fixture runs of `ralph.sh` wrote into the running loop's own `.ralph/logs`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isHarnessEnv, stripHarnessEnv } from "./test-ralph-env.setup";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs a child vitest under a leaked loop identity");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const ROOT = import.meta.dirname;

describe("the harness environment", () => {
  it("is gone from every test process, except the suite's own RALPH_TEST_* settings", () => {
    // The setup sets two back: its own scratch findings record, and the switch
    // that keeps the real start.sh from creating systemd units on this host.
    expect(Object.keys(process.env).filter(isHarnessEnv).sort()).toEqual(["RALPH_FINDINGS_RECORD", "RALPH_LOOP_SCOPE"]);
    expect(process.env.RALPH_FINDINGS_RECORD).toContain("ralph-test-findings-");
    expect(process.env.RALPH_LOOP_SCOPE).toBe("off");
  });

  it("strips harness variables and keeps RALPH_TEST_*", () => {
    const env: NodeJS.ProcessEnv = { RALPH_PROJECT: "/live", RALPH_RUN_ID: "run", RALPH_TEST_MAX_WORKERS: "2", PATH: "/bin" };
    stripHarnessEnv(env);
    expect(env).toEqual({ RALPH_TEST_MAX_WORKERS: "2", PATH: "/bin" });
  });

  it("never reaches a suite run from inside a live loop", () => {
    const live = scratchDir("ralph-live-loop-");
    const dir = scratchDir("ralph-env-leak-");
    writeFileSync(
      join(dir, "leak.test.ts"),
      [
        'import { it, expect } from "vitest";',
        'it("sees no loop identity", () => {',
        "  expect(process.env.RALPH_PROJECT).toBeUndefined();",
        "  expect(process.env.RALPH_RUN_ID).toBeUndefined();",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "vitest.config.ts"),
      `export default { test: { setupFiles: [${JSON.stringify(join(ROOT, "test-ralph-env.setup.ts"))}] } };\n`,
    );
    const run = spawnSync(BUN, ["x", "vitest", "run", "--root", dir], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", RALPH_PROJECT: live, RALPH_RUN_ID: "ralph-run-live", RALPH_LOOP_NAME: "ralph" },
      timeout: 25_000,
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readdirSync(live)).toEqual([]);
  });
});

describe("the test runner's own output", () => {
  it("is handed to no harness child by any suite or test helper", () => {
    // The other half of the same incident: a child that inherits this process's
    // stdout writes into whatever the supervisor is tee-ing, which is how 2,488
    // lines of fixture iterations reached the live loop's log (#199). Nothing on
    // `main` passed `inherit` when this was written -- the environment above was
    // the cause -- so this is the fence that keeps it that way, and it covers
    // the forms that are easy to reach for by accident.
    const suspicious = [
      /stdio:\s*(\[[^\]]*)?["']inherit["']/, // stdio: "inherit", or inside the array form
      /std(out|err):\s*["']inherit["']/,
      /stdio:\s*\[\s*\d+\s*,/, // stdio: [0, 1, 2] -- numeric fds are the runner's
      /std(io|out|err):\s*(\[[^\]]*)?process\.std(out|err)/,
    ];
    // Test files and the helpers they spawn through -- not the harness's own
    // CLIs, where `inherit` is right: `publish-journal.ts` and
    // `frontier/next.ts` stream to the supervisor that ran them on purpose.
    const sources = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((path) => {
      if (path.includes("node_modules/") || path.startsWith(".ralph/") || path.startsWith(".git/")) return false;
      // Claude Code's agent worktrees live under `.claude/worktrees/`: whole
      // copies of this repository, so every suite in them would be reported
      // here as an offender in this checkout (and the walk would descend into
      // their own node_modules).
      if (path.startsWith(".claude/")) return false;
      // This file holds the patterns themselves, so it matches every one.
      if (path === "test-ralph-env.test.ts") return false;
      const name = path.slice(path.lastIndexOf("/") + 1);
      return path.endsWith(".test.ts") || name.startsWith("test-") || name === "fixtures.ts";
    });
    const offending = sources.filter((path) => {
      const body = readFileSync(join(ROOT, path), "utf8");
      return suspicious.some((pattern) => pattern.test(body));
    });

    // The scan found the suites at all, rather than silently filtering to none.
    expect(sources.length).toBeGreaterThan(100);
    expect(offending).toEqual([]);
  });
});
