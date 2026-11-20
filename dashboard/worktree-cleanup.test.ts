// @vitest-environment node
/**
 * The worktree cleanup (#696) over a real repository: `listWorktrees` and
 * `removeWorktree` run real git, so "only the stale registration is gone" is
 * what `git worktree list` says afterwards, not what a fake recorded.
 * `checkouts()` and `supervisors()` are fakes answering the reconciliation
 * lists and liveness `loop-state` would.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import type { AgentsDeps } from "./agents";
import { parseWorktreeList, type CheckoutsSnapshot, type Read } from "./agents-adapter";
import type { Liveness } from "./contracts";
import { cleanUpWorktrees } from "./worktree-cleanup";

subprocessSuite("git");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Repo {
  root: string;
  prunable: string;
  orphaned: string;
  inUse: string;
  git: (cwd: string, ...args: string[]) => string;
  registered: () => string[];
  env: NodeJS.ProcessEnv;
}

/** A repo with three linked worktrees: one whose directory is gone, one locked then gone, one alive. */
function repo(): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ralph-worktree-cleanup-")));
  scratch.push(dir);
  const gitConfig = join(dir, "gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = fixture\n\temail = fixture@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const root = join(dir, "proj");
  git(dir, "init", "--quiet", root);
  writeFileSync(join(root, "README"), "proj\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "seed");
  const prunable = join(dir, "gone-loop");
  const orphaned = join(dir, "locked-loop");
  const inUse = join(dir, "busy-loop");
  git(root, "worktree", "add", "--quiet", "-b", "gone", prunable);
  git(root, "worktree", "add", "--quiet", "-b", "locked", orphaned);
  git(root, "worktree", "add", "--quiet", "-b", "busy", inUse);
  rmSync(prunable, { recursive: true, force: true });
  git(root, "worktree", "lock", orphaned);
  rmSync(orphaned, { recursive: true, force: true });
  const registered = (): string[] =>
    git(root, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  return { root, prunable, orphaned, inUse, git, registered, env };
}

function deps(
  at: Repo,
  options: { supervisors?: Read<{ worktree: string; liveness: Liveness }[]>; checkouts?: Read<CheckoutsSnapshot> } = {},
): AgentsDeps {
  const run = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: at.root, encoding: "utf8", env: at.env });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  const agents = {
    root: at.root,
    project: "proj",
    listWorktrees: async () => parseWorktreeList(run("worktree", "list", "--porcelain")),
    removeWorktree: async (path: string) => {
      const result = run("worktree", "remove", path);
      return result.status === 0 ? { ok: true } : { ok: false, why: result.stderr.trim() };
    },
    checkouts: async () =>
      options.checkouts ?? {
        ok: true,
        value: {
          loops: [{ worktree: at.inUse, liveness: "alive", owner: "busy", recorded: true }],
          orphaned: [at.orphaned],
          prunable: [at.prunable],
        },
      },
    supervisors: async () => options.supervisors ?? { ok: true, value: [{ worktree: at.inUse, liveness: "alive" }] },
  } as unknown as AgentsDeps["agents"];
  return { agents };
}

describe("cleanUpWorktrees", () => {
  it("removes only the prunable registration and says why each other one stays", async () => {
    const at = repo();
    const result = await cleanUpWorktrees(deps(at), { paths: [at.prunable, at.orphaned, at.inUse] });

    expect(result.outcome).toBe("done");
    expect(result.project).toBe("proj");
    expect(result.pruned).toEqual([{ path: at.prunable, branch: "gone" }]);
    // git lists linked worktrees in its own order, not the order they were added.
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { path: at.orphaned, branch: "locked", reason: expect.stringContaining("git does not offer to prune it"), registered: true },
      { path: at.inUse, branch: "busy", reason: "a loop runs in it", registered: true },
    ]));
    expect(result.why).toBe("pruned 1 stale registration; skipped 2");
    expect(at.registered().sort()).toEqual([at.root, at.orphaned, at.inUse].sort());
  });

  it("refuses, removing nothing, when the supervisors cannot be read", async () => {
    const at = repo();
    const result = await cleanUpWorktrees(deps(at, { supervisors: { ok: false, why: "loop-state exited 1" } }), {
      paths: [at.prunable],
    });

    expect(result).toEqual({
      project: "proj",
      outcome: "refused",
      pruned: [],
      skipped: [],
      why: expect.stringContaining("loop-state exited 1"),
    });
    expect(at.registered()).toContain(at.prunable);
  });

  it("leaves a prunable registration the operator did not confirm", async () => {
    const at = repo();
    const result = await cleanUpWorktrees(deps(at), { paths: [at.inUse] });

    expect(result.pruned).toEqual([]);
    // Only what was sent and the orphaned registration are reported: the
    // unconfirmed prunable one is neither touched nor listed.
    expect(result.skipped.map((entry) => entry.path).sort()).toEqual([at.orphaned, at.inUse].sort());
    expect(result.why).toBe("nothing to prune; skipped 2");
    expect(at.registered()).toContain(at.prunable);
  });

  it("reports a sent path git does not call prunable without removing it", async () => {
    const at = repo();
    const live = join(at.root, "..", "live-loop");
    at.git(at.root, "worktree", "add", "--quiet", "-b", "live", live);
    const result = await cleanUpWorktrees(deps(at), { paths: [live] });

    expect(result.skipped).toContainEqual({ path: live, branch: "live", reason: expect.stringContaining("not report it as prunable"), registered: true });
    expect(at.registered()).toContain(live);
  });

  it("reports a requested path that is no longer registered", async () => {
    const at = repo();
    const ghost = join(at.root, "..", "never-there");
    const result = await cleanUpWorktrees(deps(at), { paths: [ghost, ghost] });

    // Once, however often it was sent, and marked as nothing in the way.
    expect(result.skipped.filter((entry) => entry.path === ghost)).toEqual([{ path: ghost, branch: null, reason: "it is no longer registered", registered: false }]);
  });
});
