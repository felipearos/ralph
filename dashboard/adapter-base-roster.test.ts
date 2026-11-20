// @vitest-environment node
/**
 * The roster comes from `origin/<baseBranch>`, not the main checkout's working
 * tree.
 *
 * The case that found it: the operator's main checkout sat on a feature branch
 * 149 commits behind `origin/main`, with uncommitted changes, and its
 * `.ralph/config.json` named four loops while the base named five (it added
 * `testo`). The dashboard showed four. These suites rebuild that with real
 * git — a bare origin, a clone that pushes, and a stale, dirty main checkout —
 * and run the real `project-config` and `loop-state` against it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fixtureGitEnv } from "../test-git-env";
import { commonGitDir, configCheckout, createRalphAdapter, hasRemoteRef, readBaseBranch } from "./adapter";
import { createAgentsAdapter } from "./agents-adapter";
import { coderRoster } from "./contracts";
import { cleanupFixtures, createFixture, realGitPath, writeProjectConfig } from "./fixtures";
import { readProjectHealth } from "./health";
import { createRecordingExecutor } from "./recording-executor";

const CLI_DIR = join(__dirname, "..");
const NAMES_BEHIND = ["ralph", "rafa", "remo", "rulo"];
const NAMES_ON_BASE = [...NAMES_BEHIND, "testo"];
// The config spells these as bare names, so the roster the adapter reports is
// the resolved one: every entry a coder.
const LOOPS_BEHIND = coderRoster(...NAMES_BEHIND);
const LOOPS_ON_BASE = coderRoster(...NAMES_ON_BASE);

const scratch: string[] = [];
afterAll(() => {
  cleanupFixtures();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    realGitPath(),
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv() },
  );

/** Commit `loops` as the config on the upstream clone's main and push it. */
const pushRoster = (upstream: string, loops: string[]): void => {
  writeProjectConfig(upstream, loops);
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "--no-verify", "-m", `roster: ${loops.join(" ")}`);
  git(upstream, "push", "--quiet", "origin", "main");
};

/**
 * A bare origin whose main names `NAMES_BEHIND`, a clone that pushes to it,
 * and the operator's main checkout cloned from it. Real git is on PATH; the
 * only fakes are `gh` and the agent runners, borrowed from `createFixture`.
 */
function gitProject(label: string) {
  const f = createFixture(label);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ralph-base-roster-${label}-`)));
  scratch.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["gh", "claude", "codex", "opencode"]) symlinkSync(join(f.bin, tool), join(bin, tool));
  const origin = join(dir, "origin.git");
  const upstream = join(dir, "upstream");
  const root = join(dir, "main-checkout");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "clone", "--quiet", origin, upstream);
  git(upstream, "switch", "--quiet", "-c", "main");
  pushRoster(upstream, NAMES_BEHIND);
  git(dir, "clone", "--quiet", origin, root);
  const adapter = createRalphAdapter({
    cliDir: CLI_DIR,
    roots: [root],
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_TERMINAL_PROMPT: "0" },
  });
  return { dir, origin, upstream, root, adapter };
}

describe("the roster is read from origin/<baseBranch>", () => {
  it("lists every loop on the base while the main checkout is on a stale branch", async () => {
    const p = gitProject("stale-branch");
    git(p.root, "switch", "--quiet", "-c", "feature/stale");
    pushRoster(p.upstream, NAMES_ON_BASE);
    git(p.root, "fetch", "--quiet", "origin");
    // The checkout's own config still names four: it is behind the base.
    expect(git(p.root, "show", "HEAD:.ralph/config.json")).not.toContain("testo");

    // A loop worktree for the fifth loop, found through `git worktree list`.
    const testo = join(p.dir, "testo-loop");
    git(p.root, "worktree", "add", "--quiet", "--detach", testo, "origin/main");
    writeFileSync(join(testo, ".ralph", "loop-name"), "testo\n");

    const snapshot = await p.adapter.read();
    expect(snapshot.roster).toEqual(LOOPS_ON_BASE);
    expect(snapshot.loops.find((loop) => loop.worktree === testo)?.identity).toBe("testo");

    // The health read goes through the same roster, so it agrees.
    const local = await p.adapter.readLocal();
    expect(local.roster).toEqual(snapshot.roster);
    expect(local.loops.find((loop) => loop.worktree === testo)?.identity).toBe("testo");
    const health = await readProjectHealth({
      project: "fixture",
      local: () => p.adapter.readLocal(),
      controlStatus: async () => ({ kind: "none" }),
    });
    expect(health.loops).toBe(1);
  });

  it("does not let a dirty main checkout change the roster", async () => {
    const p = gitProject("dirty");
    // Uncommitted: drop a loop and add one the base has never named.
    writeProjectConfig(p.root, ["ralph", "zed"]);
    expect(git(p.root, "status", "--porcelain")).toContain(".ralph/config.json");
    // A fresh clone keeps its remote refs packed; this read goes through them.
    expect((await p.adapter.read()).roster).toEqual(LOOPS_BEHIND);
    expect((await p.adapter.readLocal()).roster).toEqual(LOOPS_BEHIND);
  });

  it("follows the base when a fetch moves it, without a restart", async () => {
    const p = gitProject("follow");
    git(p.root, "switch", "--quiet", "-c", "feature/stale");
    expect((await p.adapter.readLocal()).roster).toEqual(LOOPS_BEHIND);
    pushRoster(p.upstream, NAMES_ON_BASE);
    // Pushed but not fetched: the checkout's origin/main has not moved.
    expect((await p.adapter.readLocal()).roster).toEqual(LOOPS_BEHIND);
    git(p.root, "fetch", "--quiet", "origin");
    expect((await p.adapter.readLocal()).roster).toEqual(LOOPS_ON_BASE);
    expect((await p.adapter.read()).roster).toEqual(LOOPS_ON_BASE);
  });

  it("falls back to the working tree when the base holds no config yet", async () => {
    const p = gitProject("not-set-up");
    git(p.upstream, "rm", "--quiet", "-r", ".ralph");
    git(p.upstream, "commit", "--quiet", "--no-verify", "-m", "no config on the base");
    git(p.upstream, "push", "--quiet", "origin", "main");
    git(p.root, "fetch", "--quiet", "origin");
    writeProjectConfig(p.root, ["ralph", "nova"]);
    expect((await p.adapter.readLocal()).roster).toEqual(coderRoster("ralph", "nova"));
  });
});

describe("the base a project's roster is read from", () => {
  it("is the checkout's baseBranch, then origin/HEAD, then main", () => {
    const p = gitProject("base-name");
    const gitDir = commonGitDir(p.root);
    expect(gitDir).toBe(join(p.root, ".git"));
    expect(readBaseBranch(p.root, gitDir)).toBe("main");
    rmSync(join(p.root, ".ralph"), { recursive: true });
    // No config: the clone's origin/HEAD names the remote's default branch.
    git(p.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(readBaseBranch(p.root, gitDir)).toBe("trunk");
    expect(readBaseBranch(p.root, null)).toBe("main");
    // A name that would walk out of the refs directory is not a base.
    mkdirSync(join(p.root, ".ralph"));
    writeFileSync(join(p.root, ".ralph", "config.json"), JSON.stringify({ baseBranch: "../../HEAD" }));
    expect(readBaseBranch(p.root, gitDir)).toBe("trunk");
  });

  it("is a loop worktree's baseBranch when the main checkout's branch has no config", () => {
    const p = gitProject("worktree-base");
    rmSync(join(p.root, ".ralph"), { recursive: true });
    const loop = join(p.dir, "loop");
    git(p.root, "worktree", "add", "--quiet", "--detach", loop, "origin/main");
    writeFileSync(join(loop, ".ralph", "config.json"), JSON.stringify({ baseBranch: "integracion" }));
    expect(readBaseBranch(p.root, commonGitDir(p.root))).toBe("integracion");
  });

  it("is the main checkout for every config read when it has one, base named or not", () => {
    const p = gitProject("config-checkout");
    const loop = join(p.dir, "loop");
    git(p.root, "worktree", "add", "--quiet", "--detach", loop, "origin/main");
    // The fixture's config names no baseBranch, as loggd's does not.
    expect(configCheckout(p.root)).toBe(p.root);
    rmSync(join(p.root, ".ralph"), { recursive: true });
    expect(configCheckout(p.root)).toBe(loop);
    rmSync(join(loop, ".ralph"), { recursive: true });
    // Nowhere: the main checkout, so the error names the path it always did.
    expect(configCheckout(p.root)).toBe(p.root);
  });

  it("passes over a main checkout's config that names none of the repository's loops", () => {
    // acme-backoffice: the main checkout on dev pulls bruno's config (base
    // dev, roster bruno, worked from another clone) while the Linear loops'
    // worktrees carry theirs on integracion/feature-base.
    const p = gitProject("foreign-config");
    const loop = join(p.dir, "loop");
    git(p.root, "worktree", "add", "--quiet", "--detach", loop, "origin/main");
    writeFileSync(join(p.root, ".ralph", "config.json"), JSON.stringify({ baseBranch: "dev", loops: ["bruno"] }));
    writeFileSync(join(loop, ".ralph", "config.json"), JSON.stringify({ baseBranch: "integracion", loops: ["ralph", { name: "rafa", role: "coder" }] }));
    writeFileSync(join(loop, ".ralph", "loop-name"), "rafa\n");
    const gitDir = commonGitDir(p.root);
    expect(configCheckout(p.root, gitDir)).toBe(loop);
    expect(readBaseBranch(p.root, gitDir)).toBe("integracion");
    // The main checkout's config names a loop here again: it stands for the project.
    writeFileSync(join(p.root, ".ralph", "config.json"), JSON.stringify({ baseBranch: "dev", loops: ["bruno", "rafa"] }));
    expect(configCheckout(p.root, gitDir)).toBe(p.root);
    expect(readBaseBranch(p.root, gitDir)).toBe("dev");
    // No config names a loop here: the main checkout's, as before.
    writeFileSync(join(loop, ".ralph", "config.json"), JSON.stringify({ baseBranch: "integracion", loops: ["remo"] }));
    writeFileSync(join(p.root, ".ralph", "config.json"), JSON.stringify({ baseBranch: "dev", loops: ["bruno"] }));
    expect(configCheckout(p.root, gitDir)).toBe(p.root);
  });

  it("reads the frontier from a loop worktree's config when the main checkout's branch has none", async () => {
    // acme-backoffice: main checkout on dev, config only on the loops' base.
    // The frontier panel said "cannot read .../.ralph/config.json (ENOENT)".
    const p = gitProject("frontier-worktree");
    rmSync(join(p.root, ".ralph"), { recursive: true });
    const loop = join(p.dir, "loop");
    git(p.root, "worktree", "add", "--quiet", "--detach", loop, "origin/main");
    const frontier = (await p.adapter.read()).frontier;
    expect(frontier?.problem).toBeNull();
    expect(frontier?.view).not.toBeNull();
  });

  it("points the agents page's config read at that loop worktree too", async () => {
    const p = gitProject("agents-worktree");
    rmSync(join(p.root, ".ralph"), { recursive: true });
    const loop = join(p.dir, "loop");
    git(p.root, "worktree", "add", "--quiet", "--detach", loop, "origin/main");
    // Only where the read runs is under test, so the recorder answers nothing.
    const recorder = createRecordingExecutor();
    const agents = createAgentsAdapter({ cliDir: CLI_DIR, root: p.root, project: "proj", workspaces: p.dir, exec: recorder.exec });
    await agents.readConfig();
    const read = recorder.calls[0]!.invocation;
    expect(read.cwd).toBe(loop);
    expect(read.env?.RALPH_PROJECT).toBe(loop);
    // An explicit checkout is still honoured.
    await agents.readConfig({ at: p.root });
    expect(recorder.calls[1]!.invocation.cwd).toBe(p.root);
    expect(recorder.calls).toHaveLength(2);
  });

  it("is found in a linked worktree's shared git dir, packed or loose", () => {
    const p = gitProject("linked");
    const linked = join(p.dir, "linked");
    git(p.root, "worktree", "add", "--quiet", "--detach", linked, "origin/main");
    const gitDir = commonGitDir(linked);
    expect(gitDir).toBe(join(p.root, ".git"));
    expect(hasRemoteRef(gitDir!, "main")).toBe(true);
    expect(hasRemoteRef(gitDir!, "nope")).toBe(false);
  });
});
