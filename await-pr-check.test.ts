import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type AwaitPrInput, type BranchPr, type PrView, decideAwaitPr, parseBranchPrs } from "./await-pr-check";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("bun running await-pr-check.ts against a fake gh");

const input = (overrides: Partial<AwaitPrInput>): AwaitPrInput => ({
  pr: 2694,
  mode: "ci",
  branch: "testo/2694-x",
  view: "not-found",
  branchPrs: () => [{ number: 2768, state: "OPEN" }],
  ...overrides,
});

const message = (overrides: Partial<AwaitPrInput>): string => {
  const decision = decideAwaitPr(input(overrides));
  if (decision.verdict !== "refuse") throw new Error("expected a refusal");
  return decision.message;
};

describe("decideAwaitPr", () => {
  it("refuses the issue number and names the branch's open PR (#807)", () => {
    const text = message({});
    expect(text).toContain("refused");
    expect(text).toContain("no wait");
    expect(text).toContain("#2694 is not a pull request");
    expect(text).toContain("testo/2694-x");
    expect(text).toContain(".ralph/logs/handoff-pr-2768.md");
    expect(text).toContain("<ralph>AWAIT_PR 2768 ci</ralph>");
  });

  it("keeps the merge mode in the sigil it asks for", () => {
    expect(message({ mode: "merge" })).toContain("<ralph>AWAIT_PR 2768 merge</ralph>");
  });

  it("names only open PRs, never a closed or merged one", () => {
    const text = message({
      branchPrs: () => [
        { number: 2700, state: "CLOSED" },
        { number: 2768, state: "OPEN" },
      ],
    });
    expect(text).toContain("AWAIT_PR 2768 ci");
    expect(text).not.toContain("2700");
  });

  it("tells the session to open a PR when the branch has none open", () => {
    for (const prs of [[], [{ number: 2700, state: "CLOSED" }], null] as (BranchPr[] | null)[]) {
      const text = message({ branchPrs: () => prs });
      expect(text).toContain("has no open pull request");
      expect(text).toContain("open the PR first");
      expect(text).not.toContain("2700");
    }
  });

  it("refuses on a detached HEAD without asking for the branch's PRs", () => {
    let asked = 0;
    const text = message({ branch: "", branchPrs: () => (asked += 1, []) });
    expect(text).toContain("on no ticket branch");
    expect(asked).toBe(0);
  });

  // A session may shepherd a queued PR from a checkout still on another
  // branch: a real PR is never refused for not being this branch's.
  it.each<PrView>(["found", "unreadable"])("passes a number gh does not deny (%s) without reading the branch", (view) => {
    let asked = 0;
    expect(decideAwaitPr(input({ view, branchPrs: () => (asked += 1, []) }))).toEqual({ verdict: "pass" });
    expect(asked).toBe(0);
  });
});

describe("parseBranchPrs", () => {
  it("reads gh's list", () => {
    expect(parseBranchPrs('[{"number":2768,"state":"OPEN"}]')).toEqual([{ number: 2768, state: "OPEN" }]);
    expect(parseBranchPrs("[]")).toEqual([]);
  });

  it("returns null for anything else", () => {
    expect(parseBranchPrs("")).toBeNull();
    expect(parseBranchPrs("{}")).toBeNull();
    expect(parseBranchPrs('[{"state":"OPEN"}]')).toBeNull();
  });
});

describe("the CLI", () => {
  // A fake gh: `pr view 2768` resolves, any other number is denied in gh's
  // own words, and `pr list` answers the branch's open PR. Every call is
  // logged so the --repo flag can be checked.
  const scratch = (): { bin: string; log: string } => {
    const dir = scratchDir("await-pr-check-");
    const log = join(dir, "gh.log");
    const gh = join(dir, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(log)}`,
      'if [ "$1 $2" = "pr view" ]; then',
      '  [ "$3" = "2768" ] && { echo \'{"number":2768}\'; exit 0; }',
      '  echo "GraphQL: Could not resolve to a PullRequest with the number of $3." >&2; exit 1',
      "fi",
      'if [ "$1 $2" = "pr list" ]; then echo \'[{"number":2768,"state":"OPEN"}]\'; exit 0; fi',
      "exit 1",
    ].join("\n"));
    chmodSync(gh, 0o755);
    return { bin: dir, log };
  };

  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "await-pr-check.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("exits 3 with the message for an issue number, asking the project's repo", () => {
    const { bin, log } = scratch();
    const run = cli(["2694", "--mode", "merge", "--branch", "testo/2694-x"], {
      PATH: `${bin}:${process.env.PATH}`,
      RALPH_PROJECT_REPO: "acme/loggd",
    });
    expect(run.status).toBe(3);
    expect(run.stdout).toContain("<ralph>AWAIT_PR 2768 merge</ralph>");
    const calls = spawnSync("cat", [log], { encoding: "utf8" }).stdout;
    expect(calls).toContain("pr view 2694 --repo acme/loggd");
    expect(calls).toContain("pr list --repo acme/loggd --head testo/2694-x");
  });

  it("never names a PR off the base branch", () => {
    const { bin, log } = scratch();
    const run = cli(["2694", "--branch", "main"], { PATH: `${bin}:${process.env.PATH}`, RALPH_BASE_BRANCH: "main" });
    expect(run.status).toBe(3);
    expect(run.stdout).toContain("on no ticket branch");
    expect(run.stdout).not.toContain("2768");
    expect(spawnSync("cat", [log], { encoding: "utf8" }).stdout).not.toContain("pr list");
  });

  it("exits 0 silently for a real PR, and when gh cannot answer", () => {
    const { bin } = scratch();
    const real = cli(["2768", "--branch", "other/1-y"], { PATH: `${bin}:${process.env.PATH}` });
    expect(real.status).toBe(0);
    expect(real.stdout).toBe("");
    const broken = scratchDir("await-pr-check-broken-");
    writeFileSync(join(broken, "gh"), "#!/bin/sh\necho 'HTTP 502' >&2; exit 1\n");
    chmodSync(join(broken, "gh"), 0o755);
    const down = cli(["2694", "--branch", "testo/2694-x"], { PATH: `${broken}:${process.env.PATH}` });
    expect(down.status).toBe(0);
    expect(down.stdout).toBe("");
  });
});
