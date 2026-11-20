// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createOnboardingAdapter,
  failureTail,
  gatesFromPackageJson,
  parseConfigProblems,
  parseIgnored,
  parsePrList,
  parsePrUrl,
  parseSetupBase,
  repoFromRemote,
  requiredChecksFrom,
} from "./onboarding-adapter";
import { createRecordingExecutor } from "./recording-executor";

describe("reading what git and gh answer", () => {
  it("reads owner/name from an https or ssh origin", () => {
    expect(repoFromRemote("https://github.com/acme/widget.git\n")).toBe("acme/widget");
    expect(repoFromRemote("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(repoFromRemote("https://github.com/acme/widget")).toBe("acme/widget");
    expect(repoFromRemote("/srv/git/widget.git")).toBeNull();
  });

  it("takes the PR URL from the last line gh pr create prints", () => {
    expect(parsePrUrl("Creating pull request…\nhttps://github.com/acme/widget/pull/7\n")).toBe("https://github.com/acme/widget/pull/7");
    expect(parsePrUrl("something went wrong")).toBeNull();
  });

  describe("finding the setup PR among every PR gh lists", () => {
    const pr = (head: string, base: string, state: string, createdAt: string, number = 1) => ({
      number,
      url: `https://github.com/acme/widget/pull/${number}`,
      headRefName: head,
      baseRefName: base,
      state,
      mergedAt: state === "MERGED" ? createdAt : null,
      createdAt,
    });
    const list = (...prs: unknown[]): string => JSON.stringify(prs);
    const other = pr("feature/login", "develop", "MERGED", "2026-10-21T00:00:00Z", 9);

    it("finds a setup PR whose head is exactly ralph-setup", () => {
      expect(parseSetupBase(list(other, pr("ralph-setup", "integracion", "MERGED", "2026-10-01T00:00:00Z")))).toBe("integracion");
      expect(parsePrList(list(other, pr("ralph-setup", "main", "OPEN", "2026-10-01T00:00:00Z", 4)))).toEqual({
        number: 4,
        url: "https://github.com/acme/widget/pull/4",
      });
    });

    it("finds one whose head carries an owner or user prefix, and no deeper path", () => {
      expect(parseSetupBase(list(other, pr("felipearosr/ralph-setup", "integracion/ralph", "MERGED", "2026-10-01T00:00:00Z")))).toBe(
        "integracion/ralph",
      );
      expect(parsePrList(list(pr("felipearosr/ralph-setup", "main", "OPEN", "2026-10-01T00:00:00Z", 37)))?.number).toBe(37);
      expect(parseSetupBase(list(pr("a/b/ralph-setup", "x", "MERGED", "2026-10-01T00:00:00Z")))).toBeNull();
      expect(parseSetupBase(list(pr("my-ralph-setup", "x", "MERGED", "2026-10-01T00:00:00Z")))).toBeNull();
    });

    it("with both present, takes the newest merged one, then the newest open one", () => {
      const merged = pr("felipearosr/ralph-setup", "integracion/ralph", "MERGED", "2026-10-01T00:00:00Z", 37);
      const open = pr("ralph-setup", "main", "OPEN", "2026-10-10T00:00:00Z", 40);
      const closed = pr("ralph-setup", "stale", "CLOSED", "2026-10-15T00:00:00Z", 41);
      expect(parseSetupBase(list(closed, open, merged))).toBe("integracion/ralph");
      expect(parseSetupBase(list(merged, pr("ralph-setup", "newer", "MERGED", "2026-10-05T00:00:00Z", 38)))).toBe("newer");
      expect(parseSetupBase(list(closed, open))).toBe("main");
      expect(parsePrList(list(merged, closed, open, pr("o/ralph-setup", "main", "OPEN", "2026-10-12T00:00:00Z", 42)))?.number).toBe(42);
    });

    it("finds none when no head is a setup branch, or gh answered nothing readable", () => {
      expect(parseSetupBase(list(other))).toBeNull();
      expect(parsePrList(list(other))).toBeNull();
      expect(parseSetupBase(list(pr("ralph-setup", "stale", "CLOSED", "2026-10-15T00:00:00Z")))).toBeNull();
      expect(parseSetupBase("[]")).toBeNull();
      expect(parseSetupBase("not json")).toBeNull();
      expect(parsePrList("{}")).toBeNull();
    });
  });

  it("lists every problem project-config reported, or its one-line reason", () => {
    expect(
      parseConfigProblems({
        status: 1,
        stdout: "",
        stderr: "project-config: /tmp/x/.ralph/config.json is invalid:\n  - missing 'repo'\n  - unknown key 'x'\n",
      }),
    ).toEqual(["missing 'repo'", "unknown key 'x'"]);
    expect(parseConfigProblems({ status: 1, stdout: "", stderr: "project-config: x is not valid JSON: y\n" })).toEqual([
      "x is not valid JSON: y",
    ]);
    expect(parseConfigProblems({ status: 0, stdout: "{}", stderr: "" })).toEqual([]);
  });
});

describe("gates from package.json", () => {
  const scripts = JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", dev: "vite" } });

  it("offers each check script, run by the package manager the lockfile names", () => {
    expect(gatesFromPackageJson(scripts, ["bun.lock"])).toEqual({ test: "bun run test", lint: "bun run lint" });
    expect(gatesFromPackageJson(scripts, ["pnpm-lock.yaml"])).toEqual({ test: "pnpm run test", lint: "pnpm run lint" });
    expect(gatesFromPackageJson(scripts, [])).toEqual({ test: "npm run test", lint: "npm run lint" });
  });

  it("offers none without a readable package.json", () => {
    expect(gatesFromPackageJson(null, [])).toEqual({});
    expect(gatesFromPackageJson("not json", [])).toEqual({});
  });
});

describe("the end of a failed command's output", () => {
  it("keeps the last lines of stderr then stdout, bounded", () => {
    const stderr = Array.from({ length: 30 }, (_, n) => `err ${n + 1}`).join("\n");
    const tail = failureTail({ status: 1, stdout: "out\n", stderr }, "git push", 3);
    expect(tail).toBe("err 29\nerr 30\nout");
    expect(failureTail({ status: 1, stdout: "", stderr: "x".repeat(50) }, "git push", 20, 10)).toBe(`…${"x".repeat(10)}`);
    expect(failureTail({ status: 128, stdout: "", stderr: "\n" }, "git push")).toBe("git push exited 128");
  });
});

describe("ignored setup files", () => {
  it("reads each ignored path with the rule that ignores it, leaving out negated matches", () => {
    const out = [
      ".gitignore:2:/.ralph/\t.ralph/config.json",
      ".git/info/exclude:1:*.md\t.ralph/plan.md",
      ".gitignore:3:!.ralph/prompt.md\t.ralph/prompt.md",
      "garbage",
      "",
    ].join("\n");
    expect(parseIgnored(out)).toEqual([
      { path: ".ralph/config.json", source: ".gitignore", line: 2, pattern: "/.ralph/" },
      { path: ".ralph/plan.md", source: ".git/info/exclude", line: 1, pattern: "*.md" },
    ]);
    expect(parseIgnored("")).toEqual([]);
  });
});

describe("required checks from what the base branch reported", () => {
  const runs = (...entries: Record<string, unknown>[]) => JSON.stringify({ total_count: entries.length, check_runs: entries });
  const statuses = (...contexts: string[]) =>
    JSON.stringify({ state: "success", statuses: contexts.map((context) => ({ context, state: "success" })) });

  it("takes each check run, then each commit status, once", () => {
    expect(
      requiredChecksFrom(
        runs({ name: "test", conclusion: "success" }, { name: "lint", conclusion: "failure" }, { name: "test", conclusion: "success" }),
        statuses("buildkite/loggd", "Vercel"),
      ),
    ).toEqual(["test", "lint", "buildkite/loggd", "Vercel"]);
  });

  it("leaves out checks that are clearly not merge gates", () => {
    expect(
      requiredChecksFrom(
        runs(
          { name: "Analyze (javascript)", conclusion: "success", app: { slug: "github-advanced-security" } },
          { name: "CodeQL", conclusion: "success" },
          { name: "Dependabot", conclusion: "success", app: { slug: "dependabot" } },
          { name: "pages build and deployment", conclusion: "success" },
          { name: "Vercel Preview Comments", conclusion: "success", app: { slug: "vercel" } },
          { name: "e2e", conclusion: "skipped" },
          { name: "optional", conclusion: "neutral" },
          { name: "test", conclusion: null },
        ),
        null,
      ),
    ).toEqual(["Analyze (javascript)", "test"]);
  });

  it("starts empty when gh answered nothing readable", () => {
    expect(requiredChecksFrom(null, null)).toEqual([]);
    expect(requiredChecksFrom("not json", "{}")).toEqual([]);
    expect(requiredChecksFrom(null, statuses("ci/circleci"))).toEqual(["ci/circleci"]);
  });
});

describe("the operations, over the executor the adapter owns", () => {
  const adapterOver = (recorder: ReturnType<typeof createRecordingExecutor>, platform: NodeJS.Platform = "linux") =>
    createOnboardingAdapter({ cliDir: "/harness", home: "/home/op", bunPath: "/usr/bin/bun", env: {}, platform, exec: recorder.exec });

  it("reads a config check that throws as one problem in its own words, without rejecting", async () => {
    const recorder = createRecordingExecutor({ fallback: { throw: new Error("spawn /usr/bin/bun ENOENT") } });
    expect(await adapterOver(recorder).projectConfigProblems("/tmp/scratch")).toEqual(["spawn /usr/bin/bun ENOENT"]);
    expect(recorder.calls.map(({ invocation }) => invocation.cwd)).toEqual(["/tmp/scratch"]);
  });

  it("runs nothing for the folder dialog on a platform with none", async () => {
    const recorder = createRecordingExecutor();
    expect(await adapterOver(recorder, "win32").pickFolder()).toEqual({ kind: "none", command: null });
    expect(recorder.calls).toEqual([]);
  });

  it("runs git with the given cwd and argv", async () => {
    const recorder = createRecordingExecutor().on({ command: "git" }, { status: 0, stdout: "/repo\n", stderr: "" });
    expect((await adapterOver(recorder).git("/repo", ["rev-parse", "--show-toplevel"])).stdout).toBe("/repo\n");
    expect(recorder.calls.map(({ invocation: { command, args, cwd } }) => ({ command, args, cwd }))).toEqual([
      { command: "git", args: ["rev-parse", "--show-toplevel"], cwd: "/repo" },
    ]);
  });
});
