import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import { branchClaimMaxAgeMs, parseLoopBranch, readBranchClaims } from "./branch-claims";

subprocessSuite("git");

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const ROSTER = ["rafa", "ralph", "tria"] as const;
const DAY_MS = 24 * 3_600_000;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "branch-claims-"));
  dirs.push(dir);
  return dir;
}

function gitIn(dir: string, extraEnv: Record<string, string> = {}) {
  return async (args: string[]): Promise<string> =>
    (await run("git", ["-C", dir, ...args], { env: { ...GIT_ENV, ...extraEnv } })).stdout;
}

/** A repo with one `main` commit and `origin/main` pointing at it. */
async function scratchRepo(): Promise<{ dir: string; git: (args: string[]) => Promise<string> }> {
  const dir = scratchDir();
  const git = gitIn(dir);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["commit", "--quiet", "--allow-empty", "-m", "base"]);
  await git(["update-ref", "refs/remotes/origin/main", "main"]);
  return { dir, git };
}

/** Branch `name` off main, with `ahead` empty commits on it. */
async function branch(dir: string, name: string, ahead: number, extraEnv: Record<string, string> = {}) {
  const git = gitIn(dir, extraEnv);
  await git(["branch", name, "main"]);
  for (let i = 0; i < ahead; i++) {
    const tree = (await git(["rev-parse", `${name}^{tree}`])).trim();
    const commit = (await git(["commit-tree", tree, "-p", name, "-m", `work ${i}`])).trim();
    await git(["update-ref", `refs/heads/${name}`, commit]);
  }
}

describe("parseLoopBranch", () => {
  it("reads a roster loop's branch in local and remote-tracking form", () => {
    expect(parseLoopBranch("rafa/480-slug", ROSTER)).toEqual({ loop: "rafa", number: 480 });
    expect(parseLoopBranch("rafa/480", ROSTER)).toEqual({ loop: "rafa", number: 480 });
    expect(parseLoopBranch("origin/rafa/480-slug", ROSTER)).toEqual({ loop: "rafa", number: 480 });
  });

  it("rejects anything that is not a roster loop's ticket branch", () => {
    for (const ref of ["main", "origin/HEAD", "origin/main", "felipe/480-x", "rafa/0480", "rafa/x-480", "rafa/480x"]) {
      expect(parseLoopBranch(ref, ROSTER), ref).toBeNull();
    }
  });
});

describe("branchClaimMaxAgeMs", () => {
  it("defaults to 24 hours", () => {
    expect(branchClaimMaxAgeMs({})).toBe(DAY_MS);
    for (const value of ["", "  ", "0", "-3", "soon", "NaN", "Infinity"]) {
      expect(branchClaimMaxAgeMs({ RALPH_BRANCH_CLAIM_MAX_AGE_HOURS: value }), value).toBe(DAY_MS);
    }
  });

  it("reads a positive number of hours", () => {
    expect(branchClaimMaxAgeMs({ RALPH_BRANCH_CLAIM_MAX_AGE_HOURS: "6" })).toBe(6 * 3_600_000);
    expect(branchClaimMaxAgeMs({ RALPH_BRANCH_CLAIM_MAX_AGE_HOURS: "0.5" })).toBe(1_800_000);
  });
});

describe("readBranchClaims", () => {
  it("claims a recent roster branch ahead of the base, and nothing else", async () => {
    const { dir, git } = await scratchRepo();
    await branch(dir, "rafa/480-claimed", 2);
    await branch(dir, "tria/481-not-ahead", 0);
    await branch(dir, "felipe/482-not-roster", 1);
    await branch(dir, "ralph/483-stale", 1, { GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" });
    // A remote-tracking loop branch claims under its local name.
    await branch(dir, "scratch", 1);
    await git(["update-ref", "refs/remotes/origin/ralph/7-x", "scratch"]);

    const warnings: string[] = [];
    const claims = await readBranchClaims({
      git,
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
      warn: (line) => warnings.push(line),
    });

    expect(Object.fromEntries([...claims].map(([n, claim]) => [n, claim.branch]))).toEqual({
      480: "rafa/480-claimed",
      7: "ralph/7-x",
    });
    expect(Math.abs(claims.get(480)!.tipMs - Date.now())).toBeLessThan(DAY_MS);
    expect(warnings).toEqual([]);
  });

  it("drops a branch whose tip is older than the window", async () => {
    const { dir, git } = await scratchRepo();
    await branch(dir, "rafa/480-x", 1);
    const claims = await readBranchClaims({
      git,
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now() + 2 * DAY_MS,
      maxAgeMs: DAY_MS,
    });
    expect(claims.size).toBe(0);
  });

  it("picks the most recent tip when several branches name one ticket", async () => {
    const { dir, git } = await scratchRepo();
    await branch(dir, "rafa/480-older", 1, { GIT_COMMITTER_DATE: new Date(Date.now() - 3_600_000).toISOString() });
    await branch(dir, "tria/480-newer", 1);
    const claims = await readBranchClaims({
      git,
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
    });
    expect(claims.get(480)?.branch).toBe("tria/480-newer");
  });

  it("breaks a tie between equally recent tips by name, whatever the ref order", async () => {
    const { dir, git } = await scratchRepo();
    const at = { GIT_COMMITTER_DATE: new Date(Date.now() - 3_600_000).toISOString() };
    await branch(dir, "tria/480-a", 1, at);
    await branch(dir, "rafa/480-b", 1, at);
    const claims = await readBranchClaims({
      git,
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
    });
    expect(claims.get(480)?.branch).toBe("rafa/480-b");
  });

  it("collapses a local branch and its origin copy into one claim and one rev-list", async () => {
    const { dir, git } = await scratchRepo();
    await branch(dir, "rafa/480-x", 1);
    await git(["update-ref", "refs/remotes/origin/rafa/480-x", "rafa/480-x"]);
    const revLists: string[][] = [];
    const claims = await readBranchClaims({
      git: (args) => {
        if (args[0] === "rev-list") revLists.push(args);
        return git(args);
      },
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
    });
    expect([...claims.keys()]).toEqual([480]);
    expect(claims.get(480)?.branch).toBe("rafa/480-x");
    expect(revLists).toHaveLength(1);
  });

  it("skips a branch for a ticket outside the open set before any rev-list", async () => {
    const { dir, git } = await scratchRepo();
    await branch(dir, "rafa/480-closed", 1);
    await branch(dir, "rafa/481-open", 1);
    const revLists: string[][] = [];
    const claims = await readBranchClaims({
      git: (args) => {
        if (args[0] === "rev-list") revLists.push(args);
        return git(args);
      },
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
      tickets: new Set([481]),
    });
    expect([...claims.keys()]).toEqual([481]);
    expect(revLists).toHaveLength(1);
  });

  it("reads no claims and warns once, without throwing, when the base ref is missing", async () => {
    const { dir, git } = await scratchRepo();
    await branch(dir, "rafa/480-x", 1);
    await branch(dir, "tria/481-y", 1);
    const warnings: string[] = [];
    const claims = await readBranchClaims({
      git,
      base: "origin/nope",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
      warn: (line) => warnings.push(line),
    });
    expect(claims.size).toBe(0);
    expect(warnings).toEqual(["branch claims: base origin/nope does not resolve, reading no branch claims"]);
  });

  it("reads no claims and warns once outside a repository", async () => {
    const dir = scratchDir();
    const warnings: string[] = [];
    const claims = await readBranchClaims({
      git: gitIn(dir, { GIT_CEILING_DIRECTORIES: tmpdir() }),
      base: "origin/main",
      roster: ROSTER,
      nowMs: Date.now(),
      maxAgeMs: DAY_MS,
      warn: (line) => warnings.push(line),
    });
    expect(claims.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("\n");
  });
});
