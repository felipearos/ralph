/**
 * The verifier's revert mechanics (#568) against real git in a temp dir — a
 * bare origin and a clone — and a fake `gh`. Nothing here writes into this
 * checkout or the user's git config.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import type { Gh } from "./deploys";
import { VERIFIER_REVERT_MARKER } from "./merged";
import {
  existingRevertPr,
  isRevert,
  openRevertPr,
  pushRevert,
  readPr,
  realGit,
  revertBranch,
  revertMarker,
  revertPrStatus,
} from "./revert";

subprocessSuite("git for the bare origin, the clone and the scratch revert worktree");

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

/** A bare origin and a clone of it with a few commits on main; `tmpRoot` is where scratch worktrees go. */
const fixture = (): { root: string; origin: string; clone: string; tmpRoot: string; commit: (file: string, text: string, message: string) => string } => {
  const root = mkdtempSync(join(tmpdir(), "verifier-revert-test-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  const tmpRoot = join(root, "tmp");
  mkdirSync(tmpRoot);
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, clone);
  git(clone, "config", "user.name", "Verifier Test");
  git(clone, "config", "user.email", "verifier@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
  git(clone, "checkout", "-b", "main");
  const commit = (file: string, text: string, message: string): string => {
    writeFileSync(join(clone, file), text);
    git(clone, "add", file);
    git(clone, "commit", "-m", message);
    return git(clone, "rev-parse", "HEAD");
  };
  commit("app.txt", "one\ntwo\nthree\n", "first");
  commit("other.txt", "other\n", "second");
  git(clone, "push", "origin", "main");
  return { root, origin, clone, tmpRoot, commit };
};

/** The scratch worktree is gone and the clone lists only itself. */
const expectClean = (clone: string, tmpRoot: string): void => {
  expect(git(clone, "worktree", "list").split("\n")).toHaveLength(1);
  expect(readdirSync(tmpRoot)).toEqual([]);
};

describe("pushRevert", () => {
  it("reverts a squash-style commit and pushes it to the verifier's branch", async () => {
    const { origin, clone, tmpRoot, commit } = fixture();
    const change = commit("app.txt", "one\nTWO\nthree\n", "feat: shout two (#11)");
    git(clone, "push", "origin", "main");
    const result = await pushRevert({ git: realGit, repoRoot: clone, baseBranch: "main", tmpRoot }, { pr: 11, mergeCommit: change, message: "Revert #11: broke prod" });
    expect(result).toEqual({ kind: "pushed", branch: "verifier/revert-11", sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(git(origin, "rev-parse", "refs/heads/verifier/revert-11")).toBe(result.kind === "pushed" ? result.sha : "");
    expect(git(origin, "show", "refs/heads/verifier/revert-11:app.txt")).toBe("one\ntwo\nthree");
    expect(git(origin, "log", "-1", "--format=%B", "refs/heads/verifier/revert-11")).toBe("Revert #11: broke prod");
    expectClean(clone, tmpRoot);
  });

  it("reverts a true merge commit on its first-parent side", async () => {
    const { origin, clone, tmpRoot, commit } = fixture();
    git(clone, "checkout", "-b", "feature");
    commit("feature.txt", "new feature\n", "feat: add feature");
    git(clone, "checkout", "main");
    commit("other.txt", "other moved on\n", "chore: unrelated");
    git(clone, "merge", "--no-ff", "-m", "Merge pull request #12", "feature");
    const merge = git(clone, "rev-parse", "HEAD");
    git(clone, "push", "origin", "main");
    const result = await pushRevert({ git: realGit, repoRoot: clone, baseBranch: "main", tmpRoot }, { pr: 12, mergeCommit: merge, message: "Revert #12" });
    expect(result.kind).toBe("pushed");
    const tree = git(origin, "ls-tree", "--name-only", "refs/heads/verifier/revert-12").split("\n");
    expect(tree).not.toContain("feature.txt");
    expect(git(origin, "show", "refs/heads/verifier/revert-12:other.txt")).toBe("other moved on");
    expectClean(clone, tmpRoot);
  });

  it("reports a conflict with the files and the commits in the way, and pushes nothing", async () => {
    const { origin, clone, tmpRoot, commit } = fixture();
    const change = commit("app.txt", "one\nTWO\nthree\n", "feat: shout two (#13)");
    const later = commit("app.txt", "one\nTwo!\nthree\n", "fix: tone two down");
    git(clone, "push", "origin", "main");
    const result = await pushRevert({ git: realGit, repoRoot: clone, baseBranch: "main", tmpRoot }, { pr: 13, mergeCommit: change, message: "Revert #13" });
    expect(result).toEqual({ kind: "conflict", files: ["app.txt"], commits: [{ sha: later, subject: "fix: tone two down" }] });
    expect(git(origin, "branch", "--list", "verifier/revert-13")).toBe("");
    expectClean(clone, tmpRoot);
  });

  it("answers empty for a change a later commit already undid, and pushes nothing", async () => {
    const { origin, clone, tmpRoot, commit } = fixture();
    const change = commit("app.txt", "one\nTWO\nthree\n", "feat: shout two (#15)");
    commit("app.txt", "one\ntwo\nthree\n", "fix: quiet two again");
    git(clone, "push", "origin", "main");
    const result = await pushRevert({ git: realGit, repoRoot: clone, baseBranch: "main", tmpRoot }, { pr: 15, mergeCommit: change, message: "Revert #15" });
    expect(result).toEqual({ kind: "empty" });
    expect(git(origin, "branch", "--list", "verifier/revert-15")).toBe("");
    expectClean(clone, tmpRoot);
  });

  it("throws on a merge commit that does not exist, and still cleans up", async () => {
    const { clone, tmpRoot } = fixture();
    await expect(
      pushRevert({ git: realGit, repoRoot: clone, baseBranch: "main", tmpRoot }, { pr: 14, mergeCommit: "0123456789abcdef0123456789abcdef01234567", message: "Revert #14" }),
    ).rejects.toThrow(/rev-list/);
    expectClean(clone, tmpRoot);
  });
});

/** A fake `gh`: answers by the first two args, logging every call. */
const fakeGh = (answers: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>, onCall?: (args: string[]) => void): { gh: Gh; calls: string[][] } => {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    onCall?.(args);
    const answer = answers[`${args[0]} ${args[1]}`];
    if (answer === undefined) return { ok: false, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    return { ok: answer.ok ?? true, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { gh, calls };
};

describe("naming", () => {
  it("names the branch and a marker merged.ts skips", () => {
    expect(revertBranch(42)).toBe("verifier/revert-42");
    expect(revertMarker(42).startsWith(VERIFIER_REVERT_MARKER)).toBe(true);
    expect(revertMarker(42)).toContain("pr=42");
  });
});

describe("isRevert", () => {
  it.each([
    [{ title: "feat: thing", body: "Closes #1" }, false],
    [{ title: "Revert #11", body: `${revertMarker(11)}\nbroke prod` }, true],
    [{ title: 'Revert "feat: thing (#11)"', body: "" }, true],
    [{ title: "Undo it", body: "Reverts felipearos/loggd#11\n\nwhy" }, true],
    [{ title: "Reverting the tone of #11", body: "mentions Reverts in prose" }, false],
  ])("%j → %s", (pr, expected) => {
    expect(isRevert(pr)).toBe(expected);
  });
});

describe("gh reads and writes", () => {
  it("reads a PR's title and body, throwing with gh's stderr", async () => {
    expect(await readPr(fakeGh({ "pr view": { stdout: JSON.stringify({ title: "feat: x", body: "Closes #2" }) } }).gh, 7)).toEqual({ title: "feat: x", body: "Closes #2" });
    await expect(readPr(fakeGh({ "pr view": { ok: false, stderr: "no PR 7" } }).gh, 7)).rejects.toThrow(/no PR 7/);
  });

  it("finds the revert PR already opened from the verifier's branch, or none", async () => {
    const none = fakeGh({ "pr list": { stdout: "[]" } });
    expect(await existingRevertPr(none.gh, 11)).toBeNull();
    expect(none.calls[0]).toEqual(["pr", "list", "--head", "verifier/revert-11", "--state", "all", "--json", "number,state,url"]);
    const found = fakeGh({ "pr list": { stdout: JSON.stringify([{ number: 30, state: "CLOSED", url: "https://github.com/o/r/pull/30" }]) } });
    expect(await existingRevertPr(found.gh, 11)).toEqual({ number: 30, state: "CLOSED", url: "https://github.com/o/r/pull/30" });
    await expect(existingRevertPr(fakeGh({ "pr list": { ok: false, stderr: "HTTP 502" } }).gh, 11)).rejects.toThrow(/HTTP 502/);
  });

  it("opens the revert PR from a body file and parses its number", async () => {
    let bodySeen: string | null = null;
    let bodyFile = "";
    const { gh } = fakeGh({ "pr create": { stdout: "Creating pull request...\nhttps://github.com/o/r/pull/77\n" } }, (args) => {
      bodyFile = args[args.indexOf("--body-file") + 1]!;
      bodySeen = readFileSync(bodyFile, "utf8");
    });
    const opened = await openRevertPr(gh, { base: "main", branch: "verifier/revert-11", title: "Revert #11", body: `${revertMarker(11)}\nwhy` });
    expect(opened).toEqual({ number: 77, url: "https://github.com/o/r/pull/77" });
    expect(bodySeen).toBe(`${revertMarker(11)}\nwhy`);
    expect(existsSync(bodyFile)).toBe(false);
    await expect(openRevertPr(fakeGh({ "pr create": { ok: false, stderr: "already exists" } }).gh, { base: "main", branch: "b", title: "t", body: "" })).rejects.toThrow(/already exists/);
  });
});

describe("revertPrStatus", () => {
  const view = (rollup: unknown[], mergeable = "MERGEABLE", mergeStateStatus = "CLEAN"): Gh =>
    fakeGh({
      "pr view": { stdout: JSON.stringify({ state: "OPEN", mergedAt: null, labels: [], headRefOid: "abc", statusCheckRollup: rollup, mergeable, mergeStateStatus }) },
    }).gh;
  const run = (name: string, conclusion: string | null): unknown => ({ __typename: "CheckRun", name, status: conclusion === null ? "IN_PROGRESS" : "COMPLETED", conclusion });

  it("is green when the required checks passed, whatever else failed", async () => {
    expect(await revertPrStatus(view([run("ci", "SUCCESS"), run("lint", "FAILURE")]), 78, ["ci"])).toEqual({ state: "OPEN", checks: "green", mergeable: true });
  });

  it("is red when a required check failed", async () => {
    expect((await revertPrStatus(view([run("ci", "FAILURE")]), 78, ["ci"])).checks).toBe("red");
  });

  it("is pending while a required check is missing or running, and with no checks at all", async () => {
    expect((await revertPrStatus(view([run("lint", "SUCCESS")]), 78, ["ci"])).checks).toBe("pending");
    expect((await revertPrStatus(view([run("ci", null)]), 78, ["ci"])).checks).toBe("pending");
    expect((await revertPrStatus(view([]), 78, [])).checks).toBe("pending");
  });

  it("is not mergeable when conflicting or dirty", async () => {
    expect((await revertPrStatus(view([], "CONFLICTING", "DIRTY"), 78, [])).mergeable).toBe(false);
    expect((await revertPrStatus(view([], "MERGEABLE", "DIRTY"), 78, [])).mergeable).toBe(false);
  });

  it("is mergeable only when clean, hooked or unstable; blocked waits for its review", async () => {
    for (const state of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) expect((await revertPrStatus(view([], "MERGEABLE", state), 78, [])).mergeable).toBe(true);
    for (const state of ["BLOCKED", "BEHIND", "UNKNOWN"]) expect((await revertPrStatus(view([], "MERGEABLE", state), 78, [])).mergeable).toBe(false);
  });

  it("throws on a gh failure or unparseable output", async () => {
    await expect(revertPrStatus(fakeGh({ "pr view": { ok: false, stderr: "boom" } }).gh, 78, [])).rejects.toThrow(/boom/);
    await expect(revertPrStatus(fakeGh({ "pr view": { stdout: "not json" } }).gh, 78, [])).rejects.toThrow(/unparseable/);
  });
});
