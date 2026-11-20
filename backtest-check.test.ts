import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBacktest, type BacktestConfig, type BacktestPr, type CheckSpec } from "./backtest";
import { verifyCheck } from "./backtest-score";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("git, sh");

const env = () => fixtureGitEnv({
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A source whose base prints the wrong sum and whose reference fixes it and adds the test that says so. */
function fixture() {
  const root = realpathSync(scratchDir("backtest-check-"));
  const source = join(root, "app");
  mkdirSync(source);
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  const base = commit(source, { "add.sh": "echo 4\n" }, "base");
  const reference = commit(source, { "add.sh": "echo 3\n", "add.test.sh": "test \"$(sh add.sh)\" = 3\n" }, "fix");
  const config: BacktestConfig = parseBacktest({
    project: source, clerk: "clara", sample: { cap: 1 }, lineup: "codex",
    caps: { trialMinutes: 1, batchMinutes: 10 }, sources: { "acme/app": source },
    scoring: { testCommand: "sh {file}" },
  });
  return { root, source, base, reference, config };
}

type Fixture = ReturnType<typeof fixture>;

const pr = (head: string): BacktestPr => ({
  number: 7, url: "https://github.com/acme/app/pull/7", createdAt: "2026-10-02T10:00:00Z",
  mergedAt: "2026-10-02T12:00:00Z", headRefName: "fix", firstCommit: head, headRefOid: head,
});

const verify = (f: Fixture, spec: CheckSpec, opts: { repo?: string; timeoutMs?: number; config?: BacktestConfig } = {}) => verifyCheck(
  opts.config ?? f.config,
  { repo: opts.repo ?? "acme/app", baseCommit: f.base, humanPrs: [pr(f.reference)], spec },
  // Both commits are in the source: no PR ref is ever fetched.
  { fetchHumanPr: () => {}, log: () => {}, scratchParent: f.root, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
);

describe("verifyCheck", () => {
  it("errs when the setup fails, rather than reading a broken install as the base failing", async () => {
    const f = fixture();
    const config = parseBacktest({
      project: f.source, clerk: "clara", sample: { cap: 1 }, lineup: "codex",
      caps: { trialMinutes: 1, batchMinutes: 10 }, sources: { "acme/app": f.source },
      // Fails only where the fix is missing: a check would otherwise be accepted on a setup that broke.
      scoring: { testCommand: "sh {file}", setup: "grep -q 3 add.sh" },
    });
    const result = await verify(f, { test: "add.test.sh" }, { config });
    expect(result.base).toMatchObject({ result: "error", why: expect.stringContaining("setup failed") });
    expect(result.reference).toEqual({ result: "pass" });
  });

  it("errs on a test path that names a directory: it would overlay the reference's code", async () => {
    const f = fixture();
    const reference = commit(f.source, { "lib/add.test.sh": "test \"$(sh add.sh)\" = 3\n" }, "a directory of tests");
    const result = await verifyCheck(f.config, { repo: "acme/app", baseCommit: f.base, humanPrs: [pr(reference)], spec: { test: "lib" } },
      { fetchHumanPr: () => {}, log: () => {}, scratchParent: f.root });
    expect(result.base).toMatchObject({ result: "error", why: expect.stringContaining("is not a file") });
    expect(result.reference).toMatchObject({ result: "error" });
  });

  it("accepts a test file that fails on the base and passes on the reference", async () => {
    const f = fixture();
    const result = await verify(f, { test: "add.test.sh" });
    expect(result.base).toEqual({ result: "fail" });
    expect(result.reference).toEqual({ result: "pass" });
  });

  it("runs a command spec at the tree's root", async () => {
    const f = fixture();
    const result = await verify(f, { command: "test \"$(sh add.sh)\" = 3" });
    expect(result).toMatchObject({ base: { result: "fail" }, reference: { result: "pass" } });
  });

  it("reports a check that already passes on the base", async () => {
    const f = fixture();
    expect((await verify(f, { command: "true" })).base).toEqual({ result: "pass" });
  });

  it("reports a check that fails on the reference", async () => {
    const f = fixture();
    expect((await verify(f, { command: "false" })).reference).toEqual({ result: "fail" });
  });

  it("errs on both trees when the test file is not in the reference", async () => {
    const f = fixture();
    const result = await verify(f, { test: "missing.test.sh" });
    for (const outcome of [result.base, result.reference]) {
      expect(outcome).toMatchObject({ result: "error", why: expect.stringContaining("missing.test.sh") });
    }
  });

  it("errs, never fails, on a command that is not found", async () => {
    const f = fixture();
    const result = await verify(f, { command: "no-such-cmd-857" });
    expect(result.base).toMatchObject({ result: "error", why: expect.stringContaining("command not found") });
    expect(result.reference).toMatchObject({ result: "error" });
  });

  it("errs on a check that outlives its bound, naming the bound used", async () => {
    const f = fixture();
    const result = await verify(f, { command: "sleep 5" }, { timeoutMs: 300 });
    expect(result.base).toEqual({ result: "error", why: "timed out after 0.3 s" });
    expect(result.reference).toEqual({ result: "error", why: "timed out after 0.3 s" });
  });

  it("errs on both trees when the repo has no source checkout", async () => {
    const f = fixture();
    const result = await verify(f, { command: "true" }, { repo: "acme/other" });
    expect(result.base).toMatchObject({ result: "error", why: expect.stringContaining("acme/other") });
    expect(result.reference).toMatchObject({ result: "error" });
  });
});
