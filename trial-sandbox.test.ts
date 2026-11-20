import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FAKE_GH_BIN } from "./fake-gh";
import { loadProjectConfig } from "./project-config";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";
import { projectIdFor } from "./project-id";
import {
  buildTrial, checkBaseBuild, disposeTrial, localReviewFindingsCommand, REVIEW_ROUND_CAP, runTrial, trialEnv, trialPreflight, type Trial, type TrialOptions,
} from "./trial-sandbox";

subprocessSuite("builds trials with git and runs a stub ralph.sh under bash");

const gitEnv = (home: string) => fixtureGitEnv({
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

function git(cwd: string, home: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: gitEnv(home), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  source: string;
  home: string;
  harness: string;
  tripwire: string;
  options: TrialOptions;
}

/**
 * A scratch app repo with a minimal valid config, and a stub harness whose
 * ralph.sh is `script`. `gates` replaces the config's; `files` are committed with it.
 */
function fixture(script = "exit 0", app: { gates?: Record<string, string>; files?: Record<string, string> } = {}): Fixture {
  const root = realpathSync(scratchDir("trial-sandbox-"));
  const source = join(root, "app");
  const home = join(root, "home");
  const harness = join(root, "harness");
  const tripwire = join(root, "ralph-sh-ran");
  mkdirSync(join(source, ".ralph"), { recursive: true });
  mkdirSync(home);
  mkdirSync(harness);
  writeFileSync(join(source, ".ralph", "config.json"), JSON.stringify({
    repo: "your-org/your-repo",
    owner: "your-github-login",
    baseBranch: "main",
    displayName: "Fixture",
    secrets: { runner: "none", withhold: [] },
    refuseFiles: [],
    envCheck: [],
    requiredChecks: [],
    gates: app.gates ?? { test: "true", typecheck: "true" },
    promptFragment: ".ralph/prompt.md",
    coderFragment: ".ralph/coder.md",
    plan: ".ralph/plan.md",
    journal: { dir: "journal/fixture" },
    loops: ["ralph", "rafa", { name: "tria", role: "triager" }],
  }, null, 2));
  for (const name of ["prompt.md", "coder.md", "plan.md"]) writeFileSync(join(source, ".ralph", name), `${name}\n`);
  writeFileSync(join(source, "README.md"), "app\n");
  for (const [path, text] of Object.entries(app.files ?? {})) writeFileSync(join(source, path), text);
  git(root, home, ["init", "--quiet", "--initial-branch=main", source]);
  git(source, home, ["add", "."]);
  git(source, home, ["commit", "--quiet", "-m", "initial"]);
  writeFileSync(join(harness, "ralph.sh"), `#!/usr/bin/env bash\ntouch ${JSON.stringify(tripwire)}\n${script}\n`);
  chmodSync(join(harness, "ralph.sh"), 0o755);
  return {
    root, source, home, harness, tripwire,
    options: {
      source, base: "main", harness, home, scratchParent: root,
      ticket: { number: 7, title: "Do the thing", body: "Make it so." },
    },
  };
}

/** What a run could have written into the source repo: its status and every ref. */
function sourceFacts(f: Fixture): string {
  return `${git(f.source, f.home, ["status", "--porcelain", "--ignored"])}\n${git(f.source, f.home, ["for-each-ref"])}`;
}

async function waitFor(check: () => boolean, deadlineMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resume) => setTimeout(resume, 20));
  }
  return true;
}

/** Live (non-zombie) processes whose command line carries `marker`. */
function processesWith(marker: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (!readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z") pids.push(Number(entry));
    } catch { /* gone meanwhile */ }
  }
  return pids;
}

function commitConfig(t: Trial, home: string, edit: (config: Record<string, unknown>) => void): void {
  const path = join(t.work, ".ralph", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(config);
  writeFileSync(path, JSON.stringify(config, null, 2));
  git(t.work, home, ["commit", "--quiet", "-am", "leak"]);
}

function regularFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return regularFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

describe("trial sandbox", () => {
  it("builds a sandbox whose only remote is a local bare repo, with its own common dir and a validated local config", async () => {
    const f = fixture();
    const before = sourceFacts(f);
    const t = await buildTrial(f.options);
    expect(t.root.startsWith(f.root)).toBe(true);

    expect(git(t.work, f.home, ["remote"])).toBe("origin");
    expect(git(t.work, f.home, ["remote", "get-url", "origin"])).toBe(t.origin);
    expect(git(t.origin, f.home, ["rev-parse", "--is-bare-repository"])).toBe("true");
    const common = (repo: string) => realpathSync(join(repo, git(repo, f.home, ["rev-parse", "--git-common-dir"])));
    expect(common(t.work)).not.toBe(common(f.source));
    expect(common(t.work).startsWith(t.root)).toBe(true);

    const config = loadProjectConfig(t.work);
    expect(config.tracker).toMatchObject({ kind: "local", key: "TRIAL", file: t.trackerFile });
    expect(config.plugins).toEqual([]);
    expect(config.merge).toBe("human");
    expect(config.learnings).toBe(false);
    expect(config.loops).toEqual(["trial"]);
    // The default checks report `trial/<gate>`, and the default review `fake-gh/review`: what the PR wait requires.
    expect(config.requiredChecks).toEqual(["trial/test", "trial/typecheck", "fake-gh/review"]);
    expect(t.projectId).toBe(projectIdFor(f.source).id);
    expect(trialEnv(t).RALPH_PROJECT_ID).toBe(t.projectId);
    // The harness runs from a staged copy, never in place.
    expect(t.harness).toBe(join(t.root, "harness"));
    expect(readFileSync(join(t.harness, "ralph.sh"), "utf8")).toBe(readFileSync(join(f.harness, "ralph.sh"), "utf8"));
    expect(readFileSync(join(t.work, ".ralph", "loop-name"), "utf8").trim()).toBe("trial");
    expect(git(t.work, f.home, ["status", "--porcelain"])).toBe("");
    expect(git(t.origin, f.home, ["rev-parse", "main"])).toBe(t.base);
    expect(git(t.work, f.home, ["log", "-1", "--format=%s", t.base])).toBe("trial: sandbox config");
    // The gates become the fake gh's checks, in the JSON array it reads.
    const checks = spawnSync("sh", ["-c", t.checksCommand ?? "false"], { cwd: t.work, encoding: "utf8" });
    expect(JSON.parse(checks.stdout)).toEqual([{ name: "trial/test", conclusion: "SUCCESS" }, { name: "trial/typecheck", conclusion: "SUCCESS" }]);

    const tracker = JSON.parse(readFileSync(t.trackerFile, "utf8")) as { key: string; labels: string[]; issues: { number: number; labels: string[] }[] };
    expect(tracker.key).toBe("TRIAL");
    expect(tracker.issues).toEqual([expect.objectContaining({ number: 7, labels: ["ready-for-agent"] })]);
    expect(tracker.labels).toEqual(expect.arrayContaining(["trial-wip", "trial-blocked", "trial-done", "ready-for-agent"]));

    expect(trialPreflight(t, trialEnv(t))).toEqual({ ok: true, failures: [] });
    expect(sourceFacts(f)).toBe(before);
    disposeTrial(t);
    expect(existsSync(t.root)).toBe(false);
  });

  it("clones the work tree from origin by copy, sharing no object file's inode with it (#594)", async () => {
    const f = fixture();
    const t = await buildTrial(f.options);
    const inode = (path: string) => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}`; };
    const originObjects = regularFiles(join(t.origin, "objects"));
    const workObjects = regularFiles(join(t.work, ".git", "objects"));
    expect(originObjects.length).toBeGreaterThan(0);
    expect(workObjects.length).toBeGreaterThan(0);
    const originInodes = new Set(originObjects.map(inode));
    expect(workObjects.filter((path) => originInodes.has(inode(path)))).toEqual([]);
    // Nor does a push start a gc in origin that could rewrite it under a later clone.
    expect(git(t.origin, f.home, ["config", "receive.autogc"])).toBe("false");
    expect(git(t.origin, f.home, ["config", "maintenance.auto"])).toBe("false");
    expect(git(t.origin, f.home, ["config", "gc.auto"])).toBe("0");
    disposeTrial(t);
  });

  it("runs with the live checkout's .ralph and review workflow, uncommitted edits included, even from a base that has none", async () => {
    const f = fixture();
    // A base cut before the project was set up, or on a branch its config never
    // landed on (pwa's `dev`): the app code is there, `.ralph/` is not.
    git(f.source, f.home, ["rm", "-r", "--quiet", "--cached", ".ralph"]);
    git(f.source, f.home, ["commit", "--quiet", "-m", "app only"]);
    const base = git(f.source, f.home, ["rev-parse", "HEAD"]);
    mkdirSync(join(f.source, ".github", "workflows"), { recursive: true });
    writeFileSync(join(f.source, ".github", "workflows", "revision-claude.yml"), "name: Revisión Claude\n");
    git(f.source, f.home, ["add", ".ralph", ".github"]);
    git(f.source, f.home, ["commit", "--quiet", "-m", "set up ralph"]);
    writeFileSync(join(f.source, ".ralph", "prompt.md"), "edited, not committed\n");
    mkdirSync(join(f.source, ".ralph", "logs"));
    writeFileSync(join(f.source, ".ralph", "logs", "iter.log"), "runtime\n");
    writeFileSync(join(f.source, ".ralph", "loop-name"), "rafa\n");
    const before = sourceFacts(f);

    const t = await buildTrial({ ...f.options, base });
    expect(readFileSync(join(t.work, ".ralph", "prompt.md"), "utf8")).toBe("edited, not committed\n");
    expect(readFileSync(join(t.work, ".ralph", "coder.md"), "utf8")).toBe("coder.md\n");
    // The trial's review rounds read the workflow at the sandbox base.
    expect(git(t.work, f.home, ["show", `${t.base}:.github/workflows/revision-claude.yml`])).toBe("name: Revisión Claude");
    expect(loadProjectConfig(t.work).loops).toEqual(["trial"]);
    expect(readFileSync(join(t.work, ".ralph", "loop-name"), "utf8").trim()).toBe("trial");
    expect(existsSync(join(t.work, ".ralph", "logs", "iter.log"))).toBe(false);
    // The fragments are part of the sandbox config commit, so the patch is measured without them.
    expect(git(t.work, f.home, ["status", "--porcelain"])).toBe("");
    expect(git(t.work, f.home, ["diff", "--name-only", base, t.base]).split("\n").sort())
      .toEqual([".github/workflows/revision-claude.yml", ".ralph/coder.md", ".ralph/config.json", ".ralph/loop-name", ".ralph/plan.md", ".ralph/prompt.md"]);
    expect(sourceFacts(f)).toBe(before);
    disposeTrial(t);
  });

  it("records the base's red tests and forgives them in the checks, until a head fails a new one", async () => {
    const f = fixture("exit 0", {
      gates: { test: "sh red.sh" },
      files: { "red.sh": "echo ' FAIL  src/a.test.ts > a > fails'\nexit 1\n" },
    });
    const t = await buildTrial(f.options);
    expect(t.baseRed).toBe(join(t.root, "base-red.json"));
    expect(JSON.parse(readFileSync(t.baseRed ?? "", "utf8"))).toEqual({
      version: 1, base: t.base, gates: { "trial/test": { conclusion: "FAILURE", failures: ["src/a.test.ts > a > fails"] } },
    });
    // The base ran in a clone of its own, removed after: the work tree is as a fresh clone leaves it.
    expect(existsSync(join(t.root, "base-tree"))).toBe(false);
    expect(readdirSync(t.work).sort()).toEqual([".git", ".ralph", "README.md", "red.sh"]);
    expect(git(t.work, f.home, ["status", "--porcelain"])).toBe("");
    const checks = () => JSON.parse(spawnSync("sh", ["-c", t.checksCommand ?? "false"], { cwd: t.work, encoding: "utf8" }).stdout) as unknown[];
    expect(checks()).toEqual([expect.objectContaining({ name: "trial/test", conclusion: "SUCCESS", baseRed: ["src/a.test.ts > a > fails"] })]);
    writeFileSync(join(t.work, "red.sh"), "echo ' FAIL  src/a.test.ts > a > fails'\necho ' FAIL  src/b.test.ts > b > breaks'\nexit 1\n");
    expect(checks()).toEqual([expect.objectContaining({ name: "trial/test", conclusion: "FAILURE" })]);
    disposeTrial(t);
  });

  it("runs the setup command in the base's clone only, never in the work tree", async () => {
    const f = fixture("exit 0", { gates: { test: "test -f ready" } });
    const t = await buildTrial({ ...f.options, setup: "touch ready" });
    expect(JSON.parse(readFileSync(t.baseRed ?? "", "utf8")).gates).toEqual({ "trial/test": { conclusion: "SUCCESS", failures: [] } });
    expect(existsSync(join(t.work, "ready"))).toBe(false);
    expect(git(t.work, f.home, ["status", "--porcelain"])).toBe("");
    disposeTrial(t);
  });

  it("keeps the project's requiredChecks, plus the review's, when the caller names its own checks command, and takes a projectId", async () => {
    const f = fixture();
    const t = await buildTrial({ ...f.options, checksCommand: "printf '[]'", projectId: "custom-project" });
    expect(loadProjectConfig(t.work).requiredChecks).toEqual(["fake-gh/review"]);
    expect(t.checksCommand).toBe("printf '[]'");
    // A caller's own checks never read a base record, so none is made.
    expect(t.baseRed).toBeNull();
    expect(existsSync(join(t.root, "base-red.json"))).toBe(false);
    expect(trialEnv(t).RALPH_PROJECT_ID).toBe("custom-project");
    const unreviewed = await buildTrial({ ...f.options, checksCommand: "printf '[]'", findingsCommand: null });
    expect(loadProjectConfig(unreviewed.work).requiredChecks).toEqual([]);
    disposeTrial(t);
    disposeTrial(unreviewed);
  });

  it("reviews with the staged harness's local Revisión Claude by default, capped, and runs none on findingsCommand: null", async () => {
    const f = fixture();
    const reviewed = await buildTrial(f.options);
    expect(reviewed.findingsCommand).toBe(localReviewFindingsCommand(reviewed.harness, reviewed.origin));
    expect(reviewed.findingsCommand).toContain(`'${join(reviewed.harness, "local-review.ts")}'`);
    expect(loadProjectConfig(reviewed.work).requiredChecks).toContain("fake-gh/review");
    expect(trialEnv(reviewed)).toMatchObject({ FAKE_GH_FINDINGS_CMD: reviewed.findingsCommand, FAKE_GH_REVIEW_ROUNDS: String(REVIEW_ROUND_CAP) });

    const unreviewed = await buildTrial({ ...f.options, findingsCommand: null });
    expect(unreviewed.findingsCommand).toBeNull();
    expect(loadProjectConfig(unreviewed.work).requiredChecks).toEqual(["trial/test", "trial/typecheck"]);
    const env = trialEnv(unreviewed);
    expect(env.FAKE_GH_FINDINGS_CMD).toBeUndefined();
    expect(env.FAKE_GH_REVIEW_ROUNDS).toBeUndefined();
    disposeTrial(reviewed);
    disposeTrial(unreviewed);
  });

  it("refuses a review round cap that is not a positive integer, leaving nothing behind", async () => {
    const f = fixture();
    await expect(buildTrial({ ...f.options, reviewRounds: 0 })).rejects.toThrow(/reviewRounds must be a positive integer/);
    expect(readdirSync(f.root).filter((name) => name.startsWith("ralph-trial-"))).toEqual([]);
  });

  it("refuses an empty findings command, leaving nothing behind", async () => {
    const f = fixture();
    for (const findingsCommand of ["", "  \n"]) {
      await expect(buildTrial({ ...f.options, findingsCommand })).rejects.toThrow(/findingsCommand must be a command or null/);
    }
    expect(readdirSync(f.root).filter((name) => name.startsWith("ralph-trial-"))).toEqual([]);
  });

  it("stages a harness that is a git repository as a copy that is not one, of its tracked files only", async () => {
    const f = fixture();
    writeFileSync(join(f.harness, "helper.test.ts"), "// a harness test\n");
    mkdirSync(join(f.harness, "dashboard"));
    writeFileSync(join(f.harness, "dashboard", "page.ts"), "// the operator page\n");
    git(f.root, f.home, ["init", "--quiet", f.harness]);
    git(f.harness, f.home, ["add", "."]);
    git(f.harness, f.home, ["commit", "--quiet", "-m", "harness"]);
    writeFileSync(join(f.harness, "untracked.txt"), "scratch\n");
    const t = await buildTrial(f.options);
    expect(readdirSync(t.harness).sort()).toEqual(["ralph.sh"]);
    expect(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: t.harness, env: gitEnv(f.home) }).status).not.toBe(0);
    expect(trialPreflight(t, trialEnv(t))).toEqual({ ok: true, failures: [] });
  });

  const leaks: { name: string; leak: string; plant: (t: Trial, f: Fixture) => NodeJS.ProcessEnv }[] = [
    {
      name: "a real gh ahead of the fake on PATH",
      leak: "gh",
      plant: (t) => {
        const bin = join(t.root, "real-bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "gh"), 0o755);
        return { PATH: `${bin}:${FAKE_GH_BIN}:${process.env.PATH ?? ""}` };
      },
    },
    {
      name: "an origin on GitHub",
      leak: "origin",
      plant: (t, f) => { git(t.work, f.home, ["remote", "set-url", "origin", "https://github.com/x/y.git"]); return {}; },
    },
    {
      name: "a tracker that is not local",
      leak: "tracker",
      plant: (t, f) => { commitConfig(t, f.home, (config) => { config.tracker = { kind: "github" }; }); return {}; },
    },
    { name: "plugins turned on in the env", leak: "plugins", plant: () => ({ RALPH_PLUGINS: "slack" }) },
    {
      name: "plugins turned on in the config",
      leak: "plugins",
      plant: (t, f) => { commitConfig(t, f.home, (config) => { config.plugins = ["slack"]; }); return {}; },
    },
    {
      // `ralph.sh` fetches RALPH_HOME's origin whenever it is a git repository.
      name: "a staged harness that has become a git repository",
      leak: "harness",
      plant: (t, f) => { git(t.root, f.home, ["init", "--quiet", t.harness]); return {}; },
    },
  ];
  for (const { name, leak, plant } of leaks) {
    it(`refuses ${name} and never spawns ralph.sh`, async () => {
      const f = fixture();
      const t = await buildTrial(f.options);
      const env = plant(t, f);
      expect(trialPreflight(t, { ...trialEnv(t), ...env }).failures.map((failure) => failure.leak)).toEqual([leak]);
      const result = await runTrial(t, { timeoutMs: 10_000, env });
      expect(result.outcome).toEqual({ kind: "refused", exit: null, sigil: null });
      expect(result.failures.map((failure) => failure.leak)).toEqual([leak]);
      expect(existsSync(f.tripwire)).toBe(false);
    });
  }

  it("passes the lineup to the run as RALPH_MODEL_* and reads it back from the models line", async () => {
    const f = fixture([
      `echo "trial: models — executor \${RALPH_MODEL_EXECUTOR} on \${RALPH_RUNNER_EXECUTOR}, review.standards \${RALPH_MODEL_REVIEW_STANDARDS} on \${RALPH_RUNNER_REVIEW_STANDARDS} (orchestrator effort \${RALPH_MODEL_EXECUTOR_EFFORT})"`,
      "echo '<ralph>NOPE</ralph>'",
      "echo '<ralph>COMPLETE</ralph>'",
    ].join("\n"));
    const t = await buildTrial({
      ...f.options,
      lineup: { executor: { model: "gpt-x", runner: "codex", effort: "high" }, "review.standards": { model: "opus-y", runner: "claude" } },
    });
    const env = trialEnv(t);
    expect(env).toMatchObject({
      RALPH_MODEL_EXECUTOR: "gpt-x", RALPH_RUNNER_EXECUTOR: "codex", RALPH_MODEL_EXECUTOR_EFFORT: "high",
      RALPH_MODEL_REVIEW_STANDARDS: "opus-y", RALPH_RUNNER_REVIEW_STANDARDS: "claude",
    });
    const result = await runTrial(t, { timeoutMs: 20_000 });
    expect(result.outcome).toEqual({ kind: "finished", exit: 0, sigil: "<ralph>COMPLETE</ralph>" });
    expect(result.models).toEqual([
      { stage: "executor", model: "gpt-x", runner: "codex" },
      { stage: "review.standards", model: "opus-y", runner: "claude" },
    ]);
    expect(result.finalHead).toBeNull();
    expect(result.patch).toBe("");
    expect(result.logs.map((log) => log.path)).toEqual(["trial.log"]);
    expect(result.baseRed).toEqual({
      version: 1, base: t.base, gates: { "trial/test": { conclusion: "SUCCESS", failures: [] }, "trial/typecheck": { conclusion: "SUCCESS", failures: [] } },
    });
  });

  it("reports a run whose log cannot be opened as failed, without spawning ralph.sh", async () => {
    const f = fixture();
    const t = await buildTrial(f.options);
    mkdirSync(t.log);
    const result = await runTrial(t, { timeoutMs: 10_000 });
    expect(result.outcome).toEqual({ kind: "failed", exit: null, sigil: null });
    expect(existsSync(f.tripwire)).toBe(false);
  });

  /** GNU sleep's argument is the marker: a duration no other process on the host would choose. */
  const sleepMarker = () => `${900000 + Math.floor(Math.random() * 90000)}.${process.pid}${Math.floor(Math.random() * 1000)}`;

  it("kills a child that left the supervisor's process group, on abort, and reads no sigil off a killed run", async () => {
    const marker = sleepMarker();
    // GNU timeout setpgid()s, as delegate.sh's does around the executor. The
    // sigil is an earlier turn's, in the newest `.final.txt`: not how the run ended.
    const f = fixture(`mkdir -p .ralph/logs; echo '<ralph>DONE</ralph>' > .ralph/logs/iter-1.final.txt\ntimeout 600 sleep ${marker} &\ntouch "$TMPDIR/started"\nwait`);
    const t = await buildTrial(f.options);
    const controller = new AbortController();
    const running = runTrial(t, { timeoutMs: 60_000, signal: controller.signal });
    expect(await waitFor(() => existsSync(join(t.tmp, "started")) && processesWith(marker).length > 0)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.outcome).toMatchObject({ kind: "aborted", sigil: null });
    expect(await waitFor(() => processesWith(marker).length === 0, 5_000)).toBe(true);
  });

  it("kills a child in its own process group on timeout", async () => {
    const marker = sleepMarker();
    const f = fixture(`timeout 600 sleep ${marker} &\nwait`);
    const t = await buildTrial(f.options);
    const result = await runTrial(t, { timeoutMs: 1_500 });
    expect(result.outcome.kind).toBe("timeout");
    expect(await waitFor(() => processesWith(marker).length === 0, 5_000)).toBe(true);
  });

  it("leaves nothing the iteration backgrounded running after it finishes", async () => {
    const marker = sleepMarker();
    const other = sleepMarker();
    // Orphaned at once, in a session and a group of their own: no read of the
    // tree while the supervisor lives can see them.
    const f = fixture(`setsid sleep ${marker} &\ntimeout 600 sleep ${other} &\nexit 0`);
    const t = await buildTrial(f.options);
    const result = await runTrial(t, { timeoutMs: 30_000 });
    expect(result.outcome).toMatchObject({ kind: "finished", exit: 0 });
    expect(await waitFor(() => processesWith(marker).length === 0 && processesWith(other).length === 0, 5_000)).toBe(true);
  });

  it("kills the whole process group on abort and writes nothing into the source repo", async () => {
    // GNU sleep's argument is the marker: a duration no other process on the host would choose.
    const marker = `${900000 + Math.floor(Math.random() * 90000)}.${process.pid}`;
    const f = fixture(`sleep ${marker} &\nsleep ${marker} &\ntouch "$TMPDIR/started"\nwait`);
    const before = sourceFacts(f);
    const t = await buildTrial(f.options);
    const controller = new AbortController();
    const running = runTrial(t, { timeoutMs: 60_000, signal: controller.signal });
    expect(await waitFor(() => existsSync(join(t.tmp, "started")) && processesWith(marker).length === 2)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.outcome.kind).toBe("aborted");
    expect(await waitFor(() => processesWith(marker).length === 0, 5_000)).toBe(true);
    expect(sourceFacts(f)).toBe(before);
  });
});

describe("checkBaseBuild (#820)", () => {
  it("builds the base in a clone of its own: a setup that passes is ok, one that fails says why from its tail", async () => {
    const f = fixture();
    const base = git(f.source, f.home, ["rev-parse", "HEAD"]);
    const scratch = join(f.root, "scratch");
    mkdirSync(scratch);
    const common = { source: f.source, base, timeoutMs: 60_000, scratchParent: scratch, home: f.home };

    // It runs at the base: the committed README is there.
    expect(await checkBaseBuild({ ...common, setup: "test -f README.md" })).toEqual({ ok: true });
    const failed = await checkBaseBuild({ ...common, setup: "echo installing; echo 'npm ERR! missing script: ci' >&2; exit 3" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/^setup failed:\n/);
      expect(failed.reason).toContain("npm ERR! missing script: ci");
      expect(failed.aborted).toBeUndefined();
    }
    // Every clone is gone, and the source is untouched.
    expect(readdirSync(scratch)).toEqual([]);
    expect(git(f.source, f.home, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a base the source does not have, and reports a stopped setup as no verdict", async () => {
    const f = fixture();
    const missing = await checkBaseBuild({ source: f.source, base: "0".repeat(40), setup: "true", timeoutMs: 60_000, home: f.home });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/^could not check out the base: /);

    const controller = new AbortController();
    controller.abort();
    const base = git(f.source, f.home, ["rev-parse", "HEAD"]);
    const stopped = await checkBaseBuild({ source: f.source, base, setup: "true", timeoutMs: 60_000, signal: controller.signal, home: f.home });
    expect(stopped).toEqual({ ok: false, reason: "the base build was stopped", aborted: true });
  });
});
