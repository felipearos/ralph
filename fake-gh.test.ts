import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAKE_GH_BIN, stopHookRunners } from "./fake-gh";
import * as mergeWait from "./merge-wait";
import { judgeCi, parseSnapshot as parsePrWaitSnapshot, relevantChecks } from "./pr-wait";
import { subprocessSuite } from "./test-timeouts";
import { scratchDir } from "./test-scratch";
import { summarizeReview } from "./trial-review";

subprocessSuite("runs fake-gh.ts under bun, git and sh");

interface Trial {
  root: string;
  origin: string;
  work: string;
  state: string;
  env: NodeJS.ProcessEnv;
  marker: string;
}

/**
 * A scratch trial: a bare origin on `main`, a clone that pushed `main` and
 * sits on `feature`, and a tripwire `gh` AFTER the fake on PATH that leaves a
 * marker if anything ever reaches past the fake.
 */
function trial(): Trial {
  const root = scratchDir("fake-gh-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const tripwireBin = join(root, "tripwire-bin");
  const marker = join(root, "real-gh-was-called");
  mkdirSync(tripwireBin);
  writeFileSync(join(tripwireBin, "gh"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  chmodSync(join(tripwireBin, "gh"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FAKE_GH_BIN}:${tripwireBin}:${process.env.PATH ?? ""}`,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Trial",
    GIT_AUTHOR_EMAIL: "trial@example.invalid",
    GIT_COMMITTER_NAME: "Trial",
    GIT_COMMITTER_EMAIL: "trial@example.invalid",
    FAKE_GH_STATE: join(root, "state", "gh.json"),
  };
  delete env.FAKE_GH_ORIGIN;
  delete env.FAKE_GH_REPO;
  delete env.FAKE_GH_LOGIN;
  delete env.FAKE_GH_CHECKS_CMD;
  delete env.FAKE_GH_FINDINGS_CMD;
  delete env.FAKE_GH_HOOKS_SYNC;
  delete env.FAKE_GH_REVIEWER;
  delete env.FAKE_GH_REVIEW_ROUNDS;
  delete env.FAKE_GH_FAIL;
  const run = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  run(root, "clone", "--quiet", origin, work);
  run(work, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(work, "README.md"), "trial\n");
  run(work, "add", "README.md");
  run(work, "commit", "--quiet", "-m", "initial");
  run(work, "push", "--quiet", "origin", "main");
  run(work, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "feature.txt"), "feature\n");
  run(work, "add", "feature.txt");
  run(work, "commit", "--quiet", "-m", "feat: add feature", "-m", "Why it matters.");
  return { root, origin, work, state: env.FAKE_GH_STATE as string, env, marker };
}

/** git in the work clone; a failure throws, so a test never runs on against a repo it did not set up. */
function gitOk(t: Trial, args: string[]): string {
  const result = spawnSync("git", args, { cwd: t.work, env: t.env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function push(t: Trial, branch = "feature"): string {
  gitOk(t, ["push", "--quiet", "origin", branch]);
  return gitOk(t, ["rev-parse", branch]);
}

function commit(t: Trial, file: string, content: string): void {
  writeFileSync(join(t.work, file), content);
  for (const args of [["add", file], ["commit", "--quiet", "-m", `change ${file}`]]) {
    const result = spawnSync("git", args, { cwd: t.work, env: t.env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

/** A hook script under the trial root, run as `sh <path>`. */
function hook(t: Trial, name: string, script: string): string {
  const path = join(t.root, name);
  writeFileSync(path, script);
  return `sh ${path}`;
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : [];
}

function heads(t: Trial): Record<string, unknown>[] {
  return JSON.parse(readFileSync(t.state, "utf8")).prs[0].heads;
}

/** Poll `predicate` until it holds or `ms` pass; a bounded wait, never a fixed sleep, and shorter than the suite timeout so it fails with its own message. */
function waitFor(predicate: () => boolean, what: string, ms = 20_000): void {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

/** Stop every runner the state recorded, so none outlives its test. */
function killRunners(t: Trial): void {
  stopHookRunners(t.state);
}

function rollup(t: Trial): { name: string; status: string; conclusion: string | null }[] {
  return JSON.parse(ok(t, ["pr", "view", "1", "--json", "statusCheckRollup"])).statusCheckRollup;
}

function gh(t: Trial, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, { cwd: t.work, env: { ...t.env, ...extraEnv }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(t: Trial, args: string[]): string {
  const result = gh(t, args);
  expect(result.stderr, `gh ${args.join(" ")}`).toBe("");
  expect(result.status, `gh ${args.join(" ")}`).toBe(0);
  return result.stdout;
}

/** The real review-threads.ts, only ever spawned the way a loop runs it: no import, so its parser is the contract. */
const REVIEW_THREADS = fileURLToPath(new URL("./review-threads.ts", import.meta.url));

function reviewThreads(t: Trial, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [REVIEW_THREADS, ...args], { cwd: t.work, env: { ...t.env, ...extraEnv }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A findings command that prints `findings` as JSON from a file under the trial root. */
function findingsCmd(t: Trial, name: string, findings: unknown[]): string {
  const path = join(t.root, `${name}.json`);
  writeFileSync(path, JSON.stringify(findings));
  return `cat ${path}`;
}

function finding(priority: string | null, title: string, line: number | null = 1): Record<string, unknown> {
  return { path: "feature.txt", line, priority, title, body: `why ${title} matters` };
}

function roundTrip(t: Trial): void {
  const sha = push(t);
  const url = ok(t, ["pr", "create", "--title", "feat: add feature", "--body", "Closes #1", "--label", "a,b"]).trim();
  expect(url).toBe("https://github.com/trial/sandbox/pull/1");

  const view = JSON.parse(ok(t, ["pr", "view", "1", "--json", "number,state,headRefName,headRefOid,labels"]));
  expect(view).toEqual({ number: 1, state: "OPEN", headRefName: "feature", headRefOid: sha, labels: [{ name: "a" }, { name: "b" }] });
  expect(JSON.parse(ok(t, ["pr", "view", "--json", "number,baseRefName"]))).toEqual({ number: 1, baseRefName: "main" });
  expect(ok(t, ["pr", "view", url, "--json", "title", "--jq", ".title"])).toBe("feat: add feature\n");

  expect(ok(t, ["pr", "list", "--head", "feature", "--json", "number", "--jq", ".[].number"])).toBe("1\n");

  ok(t, ["pr", "edit", "1", "--add-label", "c", "--remove-label", "a"]);
  expect(ok(t, ["pr", "view", "1", "--json", "labels", "--jq", ".labels[].name"])).toBe("b\nc\n");

  const commentUrl = ok(t, ["pr", "comment", "1", "--body", "hello"]).trim();
  expect(commentUrl).toMatch(/^https:\/\/github\.com\/trial\/sandbox\/pull\/1#issuecomment-\d+$/);
  const comments = JSON.parse(ok(t, ["pr", "view", "1", "--json", "comments"])).comments;
  expect(comments).toEqual([{ author: { login: "ralph-trial" }, body: "hello", createdAt: expect.any(String), url: commentUrl }]);
}

describe("fake gh", () => {
  it("answers auth status as logged in, with no state file, so preflight's github-credentials check reads ready", () => {
    const t = trial();
    const result = gh(t, ["auth", "status"], { FAKE_GH_STATE: "", FAKE_GH_LOGIN: "trial-bot" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Logged in to fake-gh.invalid account trial-bot");
    expect(existsSync(t.marker)).toBe(false);
  });

  it("round-trips a PR through create, view, list, edit and comment", () => {
    roundTrip(trial());
  });

  it("refuses an unpushed branch and a second PR for the same head", () => {
    const t = trial();
    const unpushed = gh(t, ["pr", "create", "--title", "x"]);
    expect(unpushed.status).not.toBe(0);
    expect(unpushed.stderr).toContain("push the current branch");

    push(t);
    ok(t, ["pr", "create", "--fill"]);
    const again = gh(t, ["pr", "create", "--title", "again"]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('a pull request for branch "feature"');
    expect(again.stderr).toContain("https://github.com/trial/sandbox/pull/1");
    expect(ok(t, ["pr", "view", "1", "--json", "title,body", "--jq", ".title"])).toBe("feat: add feature\n");
  });

  it("answers pr-wait's and merge-wait's snapshot reads in a shape their parsers accept", () => {
    const t = trial();
    const sha = push(t);
    ok(t, ["pr", "create", "--title", "x", "--label", "queued"]);
    const prWait = parsePrWaitSnapshot(ok(t, ["pr", "view", "1", "--json", "state,mergedAt,labels,headRefOid,statusCheckRollup"]));
    expect(prWait).toEqual({ state: "OPEN", mergedAt: null, labels: ["queued"], head: sha, checks: [] });
    const snapshot = mergeWait.parseSnapshot(ok(t, ["pr", "view", "1", "--json", "state,mergedAt,labels", "--repo", "trial/sandbox"]));
    expect(snapshot).toEqual({ state: "OPEN", mergedAt: null, labels: ["queued"] });
  });

  it("refuses every merge, records the attempt and leaves the PR open", () => {
    const t = trial();
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    const merge = gh(t, ["pr", "merge", "1", "--squash"]);
    expect(merge.status).not.toBe(0);
    expect(merge.stderr).toContain("refuses every merge");
    const missing = gh(t, ["pr", "merge", "99"]);
    expect(missing.status).not.toBe(0);
    const state = JSON.parse(readFileSync(t.state, "utf8"));
    expect(state.mergeAttempts).toEqual([
      { at: expect.any(String), pr: 1, argv: ["pr", "merge", "1", "--squash"] },
      { at: expect.any(String), pr: null, argv: ["pr", "merge", "99"] },
    ]);
    expect(ok(t, ["pr", "view", "1", "--json", "state", "--jq", ".state"])).toBe("OPEN\n");
  });

  it("refuses commands and flags it does not implement", () => {
    const t = trial();
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    for (const args of [["issue", "list"], ["run", "list"], ["pr", "view", "1", "--bogus"]]) {
      const result = gh(t, args);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stderr).toContain(`fake gh: unsupported: gh ${args.join(" ")}`);
    }
    const field = gh(t, ["pr", "view", "1", "--json", "nope"]);
    expect(field.status).not.toBe(0);
    expect(field.stderr).toContain('Unknown JSON field: "nope"');
    const jq = gh(t, ["pr", "view", "1", "--json", "labels", "--jq", ".labels | length"]);
    expect(jq.status).not.toBe(0);
    expect(jq.stderr).toContain(".labels | length");
  });

  it("never reaches a real gh further down PATH", () => {
    const t = trial();
    roundTrip(t);
    expect(ok(t, ["api", "repos/trial/sandbox/issues/1/comments", "--jq", ".[].body"])).toBe("hello\n");
    expect(gh(t, ["issue", "list"]).status).not.toBe(0);
    gh(t, ["pr", "merge", "1"]);
    expect(existsSync(t.marker)).toBe(false);
  });

  it("fails closed when origin is not a local directory", () => {
    const t = trial();
    push(t);
    for (const origin of ["https://github.com/x/y", "git@github.com:x/y.git", join(t.root, "missing.git")]) {
      const result = gh(t, ["pr", "create", "--title", "x"], { FAKE_GH_ORIGIN: origin });
      expect(result.status, origin).not.toBe(0);
      expect(result.stderr).toContain("origin is not local");
    }
    expect(existsSync(t.state)).toBe(false);
  });

  it("refuses to run without a state file and names the repo it fakes", () => {
    const t = trial();
    const missing = gh(t, ["repo", "view", "--json", "nameWithOwner"], { FAKE_GH_STATE: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("FAKE_GH_STATE");
    push(t);
    expect(JSON.parse(ok(t, ["repo", "view", "--json", "nameWithOwner,owner,defaultBranchRef"]))).toEqual({
      nameWithOwner: "trial/sandbox",
      owner: { login: "trial" },
      defaultBranchRef: { name: "main" },
    });
  });

  it("records a checks command's result even when a gate leaves a background process holding stderr", () => {
    const t = trial();
    const pidFile = join(t.root, "leaked.pid");
    t.env.FAKE_GH_HOOKS_SYNC = "1";
    // As a trial's checks command runs a gate with its output on stderr: the leaked process (a dev server) keeps the hook's stderr.
    t.env.FAKE_GH_CHECKS_CMD = hook(t, "leaky.sh", `sleep 30 >&2 &\necho $! > "${pidFile}"\necho '[{"name":"ci","conclusion":"SUCCESS"}]'\n`);
    try {
      push(t);
      // Bounded: a stderr pipe the leak holds open would block this call until the sleep ends.
      const started = Date.now();
      const create = spawnSync("gh", ["pr", "create", "--title", "x"], { cwd: t.work, env: t.env, encoding: "utf8", timeout: 15_000 });
      expect(create.status, create.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(heads(t)[0]?.checks).toEqual([{ name: "ci", conclusion: "SUCCESS" }]);
    } finally {
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
      }
    }
  });

  it("runs each hook once per head and reports only the current head's results", () => {
    const t = trial();
    const checksCount = join(t.root, "checks-count");
    const findingsCount = join(t.root, "findings-count");
    t.env.FAKE_GH_HOOKS_SYNC = "1";
    t.env.FAKE_GH_CHECKS_CMD = hook(
      t,
      "checks.sh",
      `echo "$FAKE_GH_HEAD_SHA" >> "${checksCount}"\nprintf '[{"name":"gate-%s","conclusion":"SUCCESS","detailsUrl":"https://ci.invalid/%s"}]' "$FAKE_GH_HEAD_SHA" "$FAKE_GH_HEAD_SHA"\n`,
    );
    t.env.FAKE_GH_FINDINGS_CMD = hook(
      t,
      "findings.sh",
      `echo "$FAKE_GH_HEAD_SHA" >> "${findingsCount}"\nprintf '[{"path":"feature.txt","line":1,"priority":"P2","title":"t-%s","body":"b"}]' "$FAKE_GH_HEAD_SHA"\n`,
    );
    const first = push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    commit(t, "second.txt", "second\n");
    const second = push(t);
    for (let i = 0; i < 3; i++) ok(t, ["pr", "view", "1", "--json", "headRefOid,statusCheckRollup"]);
    ok(t, ["pr", "list", "--json", "number"]);

    expect(lines(checksCount)).toEqual([first, second]);
    expect(lines(findingsCount)).toEqual([first, second]);
    const view = JSON.parse(ok(t, ["pr", "view", "1", "--json", "headRefOid,statusCheckRollup,mergeStateStatus,mergeable"]));
    expect(view.headRefOid).toBe(second);
    expect(view.statusCheckRollup).toEqual([
      {
        __typename: "CheckRun",
        name: `gate-${second}`,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: `https://ci.invalid/${second}`,
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      },
      expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "SUCCESS" }),
    ]);
    expect(view.mergeStateStatus).toBe("CLEAN");
    expect(view.mergeable).toBe("MERGEABLE");
    const [h1, h2] = heads(t);
    expect(h1?.findings).toEqual([{ path: "feature.txt", line: 1, priority: "P2", title: `t-${first}`, body: "b" }]);
    expect(h2?.findings).toEqual([{ path: "feature.txt", line: 1, priority: "P2", title: `t-${second}`, body: "b" }]);
    // The elapsed column depends on how long the hook took, so only its shape is pinned.
    expect(ok(t, ["pr", "checks", "1"])).toMatch(new RegExp(`^gate-${second}\tpass\t(0|\\d+s|\\d+m\\d+s)\thttps://ci\\.invalid/${second}\nfake-gh/review\tpass\t[^\n]*\n$`));
    expect(JSON.parse(ok(t, ["pr", "checks", "--json", "name,state,bucket"]))).toEqual([
      { name: `gate-${second}`, state: "SUCCESS", bucket: "pass" },
      { name: "fake-gh/review", state: "SUCCESS", bucket: "pass" },
    ]);
  });

  it("runs the hooks detached, so a slow checks command never blocks a gh call", () => {
    const t = trial();
    const release = join(t.root, "release");
    t.env.FAKE_GH_CHECKS_CMD = hook(
      t,
      "slow.sh",
      `while [ ! -e "${release}" ]; do sleep 0.05; done\necho '[{"name":"slow","conclusion":"SUCCESS"}]'\n`,
    );
    try {
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      const started = Date.now();
      const raw = ok(t, ["pr", "view", "1", "--json", "state,mergedAt,labels,headRefOid,statusCheckRollup,mergeStateStatus"]);
      // Generous because CI runs on the loops' own loaded host; a blocked call would wait on minutes of gates.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(JSON.parse(raw).statusCheckRollup).toEqual([expect.objectContaining({ name: "fake-gh/checks", status: "IN_PROGRESS", conclusion: null })]);
      expect(JSON.parse(raw).mergeStateStatus).toBe("BLOCKED");
      const snapshot = parsePrWaitSnapshot(raw);
      expect(snapshot).not.toBeNull();
      expect(judgeCi(relevantChecks(snapshot?.checks ?? [], []), 0, 3)).toBe("wait");
      const pending = gh(t, ["pr", "checks", "1"]);
      expect(pending.status).toBe(8);
      expect(pending.stdout).toContain("fake-gh/checks\tpending");

      writeFileSync(release, "");
      waitFor(() => heads(t)[0]?.hooks === "done", "the detached runner to finish");
      expect(rollup(t)).toEqual([expect.objectContaining({ name: "slow", status: "COMPLETED", conclusion: "SUCCESS" })]);
    } finally {
      writeFileSync(release, "");
      killRunners(t);
    }
  });

  it("records a failing checks command as a fake-gh/checks FAILURE, never as no checks", () => {
    const t = trial();
    t.env.FAKE_GH_HOOKS_SYNC = "1";
    t.env.FAKE_GH_CHECKS_CMD = hook(t, "broken.sh", "echo not json\nexit 3\n");
    t.env.FAKE_GH_FINDINGS_CMD = hook(t, "bad-findings.sh", "echo '{'\n");
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    const raw = ok(t, ["pr", "view", "1", "--json", "state,mergedAt,labels,headRefOid,statusCheckRollup,mergeStateStatus"]);
    expect(JSON.parse(raw).statusCheckRollup).toEqual([
      expect.objectContaining({ name: "fake-gh/checks", status: "COMPLETED", conclusion: "FAILURE" }),
      expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "FAILURE" }),
    ]);
    expect(JSON.parse(raw).mergeStateStatus).toBe("BLOCKED");
    const snapshot = parsePrWaitSnapshot(raw);
    expect(judgeCi(relevantChecks(snapshot?.checks ?? [], []), 0, 3)).toBe("red");
    const checks = gh(t, ["pr", "checks", "1", "--required"]);
    expect(checks.status).toBe(1);
    expect(checks.stdout).toContain("fake-gh/checks\tfail");
    const [head] = heads(t);
    expect(head?.checks).toEqual([{ name: "fake-gh/checks", conclusion: "FAILURE", summary: expect.stringContaining("exited 3") }]);
    expect(head?.findings).toBeNull();
    expect(head?.findingsError).toContain("unparseable");
  });

  it("keeps a check's base-red tests, and a SUCCESS with a summary still passes", () => {
    const t = trial();
    t.env.FAKE_GH_HOOKS_SYNC = "1";
    t.env.FAKE_GH_CHECKS_CMD = hook(
      t,
      "base-red.sh",
      `printf '[{"name":"trial/test","conclusion":"SUCCESS","summary":"passes apart from 1 test","baseRed":["a > fails"]},{"name":"trial/lint","conclusion":"SUCCESS","baseRed":[3]}]'\n`,
    );
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    const [head] = heads(t);
    // A malformed baseRed is dropped, never the check.
    expect(head?.checks).toEqual([
      { name: "trial/test", conclusion: "SUCCESS", summary: "passes apart from 1 test", baseRed: ["a > fails"] },
      { name: "trial/lint", conclusion: "SUCCESS" },
    ]);
    expect(gh(t, ["pr", "checks", "1"]).status).toBe(0);
    expect(JSON.parse(ok(t, ["pr", "checks", "1", "--json", "name,state,bucket,description"]))).toEqual(expect.arrayContaining([
      { name: "trial/test", state: "SUCCESS", bucket: "pass", description: "passes apart from 1 test" },
      expect.objectContaining({ name: "trial/lint", state: "SUCCESS", bucket: "pass" }),
    ]));
  });

  it("marks a dead runner's hooks failed and never re-runs them", () => {
    const t = trial();
    const count = join(t.root, "count");
    const release = join(t.root, "never");
    t.env.FAKE_GH_CHECKS_CMD = hook(t, "stuck.sh", `echo "$FAKE_GH_HEAD_SHA" >> "${count}"\nwhile [ ! -e "${release}" ]; do sleep 0.05; done\necho '[]'\n`);
    // Stuck too: the runner runs both at once, so a quick review would finish before the kill.
    t.env.FAKE_GH_FINDINGS_CMD = hook(t, "findings.sh", `while [ ! -e "${release}" ]; do sleep 0.05; done\necho '[]'\n`);
    try {
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      waitFor(() => lines(count).length === 1, "the checks command to start");
      const pid = heads(t)[0]?.runnerPid as number;
      expect(pid).toBeGreaterThan(0);
      process.kill(-pid, "SIGKILL");
      waitFor(() => rollup(t).some((c) => c.name === "fake-gh/hooks"), "a sync to see the runner dead");
      expect(rollup(t)).toEqual([
        expect.objectContaining({ name: "fake-gh/hooks", status: "COMPLETED", conclusion: "FAILURE" }),
        expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "FAILURE" }),
      ]);
      const [head] = heads(t);
      expect(head?.hooks).toBe("failed");
      expect(head?.error).toBe("hook runner died");
      expect(head?.findingsError).toBe("hook runner died");
      expect(lines(count)).toHaveLength(1);
    } finally {
      writeFileSync(release, "");
      killRunners(t);
    }
  });

  it("reports no checks when no hook is configured", () => {
    const t = trial();
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    expect(JSON.parse(ok(t, ["pr", "view", "1", "--json", "statusCheckRollup,mergeStateStatus"]))).toEqual({ statusCheckRollup: [], mergeStateStatus: "CLEAN" });
    expect(heads(t)[0]?.hooks).toBe("none");
    const checks = gh(t, ["pr", "checks", "1"]);
    expect(checks.status).toBe(1);
    expect(checks.stderr).toContain("no checks reported on the 'feature' branch");
  });

  it("diffs the current head against its merge base with the base branch", () => {
    const t = trial();
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    commit(t, "second.txt", "second\n");
    push(t);
    // A commit on main after the branch point is not part of the PR's diff.
    gitOk(t, ["checkout", "--quiet", "main"]);
    commit(t, "main-only.txt", "main\n");
    push(t, "main");
    gitOk(t, ["checkout", "--quiet", "feature"]);
    expect(ok(t, ["pr", "diff", "1", "--name-only"])).toBe("feature.txt\nsecond.txt\n");
    expect(ok(t, ["pr", "diff"])).toContain("+second");
  });

  it("refuses pr checks --watch: waiting belongs to the supervisor", () => {
    const t = trial();
    push(t);
    ok(t, ["pr", "create", "--title", "x"]);
    const result = gh(t, ["pr", "checks", "1", "--watch"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fake gh: unsupported: gh pr checks 1 --watch");
  });

  describe("gh api", () => {
    it("serves review threads the real review-threads.ts reads, answers and sees go outdated", () => {
      const t = trial();
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_FINDINGS_CMD = findingsCmd(t, "two", [finding("P1", "Null deref in parse", 3), finding("P3", "Name is vague", null)]);
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);

      const open = reviewThreads(t, ["1"]);
      expect(open.stderr).toBe("");
      expect(open.status).toBe(1);
      expect(open.stdout).toContain("PR #1: 2 open review threads");
      expect(open.stdout).toContain("P1 feature.txt:3 — Null deref in parse");
      expect(open.stdout).toContain("P3 feature.txt — Name is vague");
      expect(open.stdout).toContain("by revision-claude");
      const replies = [...open.stdout.matchAll(/reply: (gh api repos\/trial\/sandbox\/pulls\/1\/comments\/\d+\/replies -F body=@<file>)/g)].map((m) => m[1] as string);
      expect(replies).toHaveLength(2);

      // The badge arrives with its alt text empty, as Claude review comments do; the URL carries the priority.
      const bodies = ok(t, ["api", "repos/trial/sandbox/pulls/1/comments", "--paginate", "--jq", ".[].body"]).trim().split("\n");
      expect(bodies[0]).toBe("![](https://img.shields.io/badge/P1-red?style=flat) **Null deref in parse**");
      expect(bodies).toContain("![](https://img.shields.io/badge/P3-yellow?style=flat) **Name is vague**");

      const reply = (command: string, text: string) => {
        const file = join(t.root, "reply.md");
        writeFileSync(file, text);
        const args = command.replace("@<file>", `@${file}`).split(" ").slice(1);
        return JSON.parse(ok(t, args));
      };
      const created = reply(replies[0] as string, "Fixed in the next push.");
      expect(created).toEqual({
        id: expect.any(Number),
        body: "Fixed in the next push.",
        user: { login: "ralph-trial" },
        html_url: expect.stringMatching(/^https:\/\/github\.com\/trial\/sandbox\/pull\/1#discussion_r\d+$/),
        in_reply_to_id: Number(/comments\/(\d+)\/replies/.exec(replies[0] as string)?.[1]),
      });

      const one = reviewThreads(t, ["1", "--json"]);
      expect(one.status).toBe(1);
      expect(JSON.parse(one.stdout)).toMatchObject({ pr: 1, repo: "trial/sandbox", self: "ralph-trial", open: [{ priority: "P3", title: "Name is vague", outdated: false }] });

      reply(replies[1] as string, "Renamed.");
      const none = reviewThreads(t, ["1"]);
      expect(none.status).toBe(0);
      expect(none.stdout).toContain("PR #1: no open review threads");

      const all = JSON.parse(ok(t, ["api", "repos/trial/sandbox/pulls/1/comments"]));
      expect(all).toHaveLength(4);
      expect(all.filter((c: { in_reply_to_id?: number }) => c.in_reply_to_id !== undefined)).toHaveLength(2);

      // A new head with a clean review: the answered threads go outdated and stay answered.
      t.env.FAKE_GH_FINDINGS_CMD = findingsCmd(t, "none", []);
      commit(t, "second.txt", "second\n");
      push(t);
      const after = reviewThreads(t, ["1", "--json"]);
      expect(after.status).toBe(0);
      expect(JSON.parse(after.stdout).open).toEqual([]);
      const query = "query { repository { pullRequest { reviewThreads { nodes { isOutdated } } } } }";
      const outdated = ok(t, ["api", "graphql", "-f", `query=${query}`, "-F", "owner=trial", "-F", "name=sandbox", "-F", "pr=1", "--jq", ".data.repository.pullRequest.reviewThreads.nodes[]"]);
      expect(JSON.parse(outdated.trim().split("\n")[0] as string)).toMatchObject({ isOutdated: true, line: null, originalLine: 3 });
      expect(outdated.trim().split("\n").map((l) => JSON.parse(l).isOutdated)).toEqual([true, true]);
    });

    it("spawns review-threads.ts and never imports it", () => {
      const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
      expect(source).not.toMatch(/from "\.\/review-threads"/);
      expect(source).not.toMatch(/import\("\.\/review-threads/);
    });

    it("pages 150 threads, 100 at a time, through the real review-threads.ts", () => {
      const t = trial();
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_FINDINGS_CMD = findingsCmd(t, "many", Array.from({ length: 150 }, (_, i) => finding("P2", `finding ${i}`, i + 1)));
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      const result = reviewThreads(t, ["1", "--json"]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(1);
      const open = JSON.parse(result.stdout).open as { id: number; title: string }[];
      expect(open).toHaveLength(150);
      expect(new Set(open.map((o) => o.id)).size).toBe(150);
      expect(open.at(-1)?.title).toBe("finding 149");
      const query = "query { reviewThreads }";
      const first = JSON.parse(ok(t, ["api", "graphql", "-f", `query=${query}`, "-F", "owner=trial", "-F", "name=sandbox", "-F", "pr=1"]));
      const page = first.data.repository.pullRequest.reviewThreads;
      expect(page.nodes).toHaveLength(100);
      expect(page.pageInfo.hasNextPage).toBe(true);
      const second = JSON.parse(ok(t, ["api", "graphql", "-f", `query=${query}`, "-F", "owner=trial", "-F", "name=sandbox", "-F", "pr=1", "-F", `after=${page.pageInfo.endCursor}`]));
      expect(second.data.repository.pullRequest.reviewThreads.nodes).toHaveLength(50);
      expect(second.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage).toBe(false);
    });

    it("posts no thread when any finding is invalid", () => {
      const t = trial();
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_FINDINGS_CMD = findingsCmd(t, "bad", [finding("P1", "good one"), { line: 2, priority: "P2", title: "no path", body: "b" }]);
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      const [head] = heads(t);
      expect(head?.findings).toBeNull();
      expect(head?.findingsError).toContain("entry 1 is not a valid finding");
      expect(JSON.parse(readFileSync(t.state, "utf8")).prs[0].reviewThreads).toEqual([]);
      expect(reviewThreads(t, ["1"]).status).toBe(0);
    });

    /** A review that always finds one P2, capped at 2 rounds, over three heads: the third is capped. */
    const cappedThreeHeads = (): { t: Trial; count: string; third: string } => {
      const t = trial();
      const count = join(t.root, "count");
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_REVIEW_ROUNDS = "2";
      t.env.FAKE_GH_FINDINGS_CMD = hook(t, "one.sh", `echo x >> "${count}"\ncat ${join(t.root, "one.json")}\n`);
      writeFileSync(join(t.root, "one.json"), JSON.stringify([finding("P2", "Again")]));
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      commit(t, "second.txt", "second\n");
      push(t);
      ok(t, ["pr", "view", "1", "--json", "headRefOid"]);
      commit(t, "third.txt", "third\n");
      const third = push(t);
      ok(t, ["pr", "view", "1", "--json", "headRefOid"]);
      return { t, count, third };
    };

    it("stops reviewing after FAKE_GH_REVIEW_ROUNDS reviewed heads, with a NEUTRAL review check", () => {
      const { t, count, third } = cappedThreeHeads();
      const all = heads(t);
      expect(all).toHaveLength(3);
      expect(lines(count)).toHaveLength(2);
      expect(all.slice(0, 2).map((h) => (h.findings as unknown[]).length)).toEqual([1, 1]);
      expect(all[2]).toMatchObject({ sha: third, findings: null, findingsError: null, reviewSkipped: "round cap 2 reached" });
      const threads = JSON.parse(readFileSync(t.state, "utf8")).prs[0].reviewThreads as { headSha: string }[];
      expect(threads).toHaveLength(2);
      expect(threads.some((th) => th.headSha === third)).toBe(false);
      expect(rollup(t)).toEqual([expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "NEUTRAL" })]);
    });

    it("summarizes the capped PR's real state as stopped at the cap, the third head unreviewed by design", () => {
      const { t, third } = cappedThreeHeads();
      const review = summarizeReview(JSON.parse(readFileSync(t.state, "utf8")), 2);
      expect(review.capReached).toBe(true);
      expect(review.roundCount).toBe(2);
      expect(review.cappedHeads).toEqual([third]);
      expect(review.note).toContain("stopped at the round cap (2 rounds)");
    });

    it("counts a head still under review toward the cap", () => {
      const t = trial();
      const release = join(t.root, "release-review");
      t.env.FAKE_GH_REVIEW_ROUNDS = "1";
      t.env.FAKE_GH_FINDINGS_CMD = hook(t, "slow.sh", `while [ ! -e "${release}" ]; do sleep 0.05; done\necho '[]'\n`);
      try {
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        expect(heads(t)[0]).toMatchObject({ hooks: "running", findings: null });
        // A second push lands while the first review still runs: under a cap of 1 it is not a second round.
        commit(t, "second.txt", "second\n");
        push(t);
        ok(t, ["pr", "view", "1", "--json", "headRefOid"]);
        expect(heads(t)[1]).toMatchObject({ findingsCmd: null, reviewSkipped: "round cap 1 reached" });
      } finally {
        writeFileSync(release, "");
        killRunners(t);
      }
    });

    it("refuses a FAKE_GH_REVIEW_ROUNDS that is not a positive integer", () => {
      const t = trial();
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_REVIEW_ROUNDS = "0";
      t.env.FAKE_GH_FINDINGS_CMD = findingsCmd(t, "none", []);
      push(t);
      const result = gh(t, ["pr", "create", "--title", "x"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FAKE_GH_REVIEW_ROUNDS must be a positive integer");
    });

    it("reads a findings command's exit 3 as an unreviewed head that is not a round", () => {
      const t = trial();
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_REVIEW_ROUNDS = "1";
      t.env.FAKE_GH_FINDINGS_CMD = hook(t, "unavailable.sh", "echo starting >&2\necho 'local review unavailable: no workflow' >&2\nexit 3\n");
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      const [head] = heads(t);
      expect(head).toMatchObject({ findings: null, findingsError: null, reviewUnavailable: "local review unavailable: no workflow" });
      expect(JSON.parse(readFileSync(t.state, "utf8")).prs[0].reviewThreads).toEqual([]);
      const review = JSON.parse(ok(t, ["pr", "view", "1", "--json", "statusCheckRollup"])).statusCheckRollup;
      expect(review).toEqual([expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "NEUTRAL" })]);

      // The unavailable head was not a round, so under a cap of 1 the next head is still reviewed.
      t.env.FAKE_GH_FINDINGS_CMD = findingsCmd(t, "one", [finding("P2", "Reviewed")]);
      commit(t, "second.txt", "second\n");
      push(t);
      expect(rollup(t)).toEqual([expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "SUCCESS" })]);
      expect(heads(t)[1]).toMatchObject({ reviewSkipped: null, reviewUnavailable: null, findings: [expect.objectContaining({ title: "Reviewed" })] });
      expect(JSON.parse(readFileSync(t.state, "utf8")).prs[0].reviewThreads).toHaveLength(1);
    });

    it("keeps any other non-zero exit of the findings command a FAILURE", () => {
      const t = trial();
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_FINDINGS_CMD = hook(t, "broken.sh", "echo 'local review unavailable: no workflow' >&2\nexit 1\n");
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      expect(rollup(t)).toEqual([expect.objectContaining({ name: "fake-gh/review", status: "COMPLETED", conclusion: "FAILURE" })]);
      const [head] = heads(t);
      expect(head).toMatchObject({ findings: null, reviewUnavailable: null, findingsError: expect.stringContaining("exited 1") });
    });

    it("lists and posts the PR's conversation comments with stable ids", () => {
      const t = trial();
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      const url = ok(t, ["pr", "comment", "1", "--body", "first"]).trim();
      const body = join(t.root, "body.md");
      writeFileSync(body, "second");
      const posted = JSON.parse(ok(t, ["api", "repos/trial/sandbox/issues/1/comments", "-F", `body=@${body}`]));
      expect(posted).toMatchObject({ body: "second", user: { login: "ralph-trial" } });
      expect(ok(t, ["api", "repos/trial/sandbox/issues/1/comments", "--jq", ".[].body"])).toBe("first\nsecond\n");
      const listed = JSON.parse(ok(t, ["api", "repos/{owner}/{repo}/issues/1/comments"]));
      expect(listed).toEqual([
        { id: Number(url.split("#issuecomment-")[1]), body: "first", user: { login: "ralph-trial" }, html_url: url, created_at: expect.any(String) },
        { id: posted.id, body: "second", user: { login: "ralph-trial" }, html_url: posted.html_url, created_at: expect.any(String) },
      ]);
      expect(posted.id).not.toBe(listed[0].id);
      expect(JSON.parse(ok(t, ["pr", "view", "1", "--json", "comments"])).comments.map((c: { url: string }) => c.url)).toEqual([url, posted.html_url]);
    });

    it("refuses mutations, other repos, unknown ids and methods it would only pretend", () => {
      const t = trial();
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      const mutation = ["api", "graphql", "-f", "query=mutation { resolveReviewThread(input: {threadId: \"x\"}) { thread { id } } }"];
      for (const args of [mutation, ["api", "-X", "PATCH", "repos/trial/sandbox/issues/1/comments"], ["api", "repos/trial/sandbox/pulls/1/reviews"]]) {
        const result = gh(t, args);
        expect(result.status, args.join(" ")).toBe(1);
        expect(result.stderr).toContain(`fake gh: unsupported: gh ${args.join(" ")}`);
      }
      const other = gh(t, ["api", "repos/x/y/pulls/1/comments"]);
      expect(other.status).toBe(1);
      expect(other.stderr).toContain("HTTP 404");
      expect(other.stderr).toContain("repos/x/y/pulls/1/comments");
      const unknown = gh(t, ["api", "repos/trial/sandbox/pulls/1/comments/999/replies", "-f", "body=hi"]);
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("HTTP 404");

      const query = "query { reviewThreads }";
      const wrongRepo = gh(t, ["api", "graphql", "-f", `query=${query}`, "-F", "owner=x", "-F", "name=y", "-F", "pr=1"]);
      expect(wrongRepo.status).toBe(1);
      expect(JSON.parse(wrongRepo.stdout).data.repository).toBeNull();
      const missing = gh(t, ["api", "graphql", "-f", `query=${query}`, "-F", "owner=trial", "-F", "name=sandbox", "-F", "pr=9"]);
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stdout).data.repository.pullRequest).toBeNull();
      expect(reviewThreads(t, ["9"]).status).toBe(5);
    });

    describe("review-threads.ts under a GitHub throttle (#658)", () => {
      const throttled = "GraphQL: API rate limit already exceeded for user ID 21047325";

      it("waits out a throttle that clears, then reads the threads", () => {
        const t = trial();
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        // No --repo, so the `repo view` lookup is the call that is throttled.
        const result = reviewThreads(t, ["1"], {
          FAKE_GH_FAIL: `repo view:1:${throttled}`,
          RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS: "3",
          RALPH_FRONTIER_RATE_LIMIT_BASE_SECONDS: "1",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("PR #1: no open review threads");
      });

      it("waits out a throttle on the thread page too, with --repo skipping the lookup", () => {
        const t = trial();
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        const result = reviewThreads(t, ["1", "--repo", "trial/sandbox"], {
          FAKE_GH_FAIL: `api graphql:1:${throttled}`,
          RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS: "3",
          RALPH_FRONTIER_RATE_LIMIT_BASE_SECONDS: "1",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      });

      it("exits 75 when the throttle outlasts its budget, naming the rate limit", () => {
        const t = trial();
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        const result = reviewThreads(t, ["1"], {
          FAKE_GH_FAIL: `api graphql:always:${throttled}`,
          RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS: "0",
        });
        expect(result.status).toBe(75);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("rate limit");
        expect(result.stderr).toMatch(/retry later \(in ~\d+s\)/);
      });

      it("caps its wait below the model's Bash timeout, whatever the frontier budget says", () => {
        const t = trial();
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        // A 300 s base makes the first wait at least 150 s: inside a 900 s budget,
        // over the 60 s cap, so the tool must give up at once rather than sleep.
        const started = Date.now();
        const result = reviewThreads(t, ["1"], {
          FAKE_GH_FAIL: `api graphql:always:${throttled}`,
          RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS: "900",
          RALPH_FRONTIER_RATE_LIMIT_BASE_SECONDS: "300",
        });
        expect(result.status).toBe(75);
        expect(Date.now() - started).toBeLessThan(60_000);
      });

      it("still exits 5 on a gh failure that is not a throttle, and 64 on usage", () => {
        const t = trial();
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        const notFound = reviewThreads(t, ["1"], { FAKE_GH_FAIL: "api graphql:always:gh: Not Found (HTTP 404)" });
        expect(notFound.status).toBe(5);
        expect(notFound.stderr).toContain("HTTP 404");
        expect(reviewThreads(t, []).status).toBe(64);
        expect(reviewThreads(t, ["1", "--bogus"]).status).toBe(64);
      });
    });
  });

  describe("FAKE_GH_FAIL", () => {
    const throttled = "GraphQL: API rate limit already exceeded for user ID 21047325";

    it("fails the named subcommand the given number of times, across processes, then answers", () => {
      const t = trial();
      t.env.FAKE_GH_FAIL = `repo view:2:${throttled}`;
      for (let i = 0; i < 2; i++) {
        const result = gh(t, ["repo", "view", "--json", "nameWithOwner"]);
        expect(result.status, `call ${i + 1}`).toBe(1);
        expect(result.stderr).toBe(`${throttled}\n`);
      }
      expect(JSON.parse(ok(t, ["repo", "view", "--json", "nameWithOwner"]))).toEqual({ nameWithOwner: "trial/sandbox" });
      // Another subcommand is never failed, and a spent count stays spent.
      expect(ok(t, ["pr", "list", "--json", "number"]).trim()).toBe("[]");
      expect(gh(t, ["repo", "view"]).status).toBe(0);
    });

    it("fails `api graphql` on every call with `always`, wherever its flags sit", () => {
      const t = trial();
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      t.env.FAKE_GH_FAIL = `api graphql:always:${throttled}`;
      const query = "query { reviewThreads }";
      const fields = ["-f", `query=${query}`, "-F", "owner=trial", "-F", "name=sandbox", "-F", "pr=1"];
      for (const args of [["api", "graphql", ...fields], ["api", ...fields, "graphql"], ["api", ...fields.slice(0, 2), "graphql", ...fields.slice(2)]]) {
        const result = gh(t, args);
        expect(result.status, args.join(" ")).toBe(1);
        expect(result.stderr).toBe(`${throttled}\n`);
        expect(result.stdout).toBe("");
      }
      // A REST endpoint under `api` is not the one named.
      expect(ok(t, ["api", "repos/trial/sandbox/issues/1/comments"]).trim()).toBe("[]");
    });

    it("refuses a malformed FAKE_GH_FAIL", () => {
      const t = trial();
      for (const value of ["repo view:twice:boom", "repo:2:boom", "repo view:2:", "repo view:-1:boom"]) {
        const result = gh(t, ["repo", "view"], { FAKE_GH_FAIL: value });
        expect(result.status, value).toBe(1);
        expect(result.stderr, value).toContain("FAKE_GH_FAIL must be <subcommand>:<times>:<stderr>");
      }
    });
  });

  describe("review check, merges and heads", () => {
    it("holds CI at wait until the findings are recorded and their threads posted", () => {
      const t = trial();
      const release = join(t.root, "release-review");
      t.env.FAKE_GH_CHECKS_CMD = hook(t, "fast.sh", `echo '[{"name":"ci","conclusion":"SUCCESS"}]'\n`);
      t.env.FAKE_GH_FINDINGS_CMD = hook(
        t,
        "review.sh",
        `while [ ! -e "${release}" ]; do sleep 0.05; done\necho '[{"path":"feature.txt","line":1,"priority":"P2","title":"t","body":"b"}]'\n`,
      );
      const snapshotFields = ["pr", "view", "1", "--json", "state,mergedAt,labels,headRefOid,statusCheckRollup"];
      const verdict = () => judgeCi(relevantChecks(parsePrWaitSnapshot(ok(t, snapshotFields))?.checks ?? [], []), 0, 3);
      try {
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        // The checks command finishes while the review is still running: CI must not read done.
        waitFor(() => heads(t)[0]?.checks != null, "the checks command to be recorded");
        expect(verdict()).toBe("wait");
        expect(rollup(t)).toEqual([
          expect.objectContaining({ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }),
          expect.objectContaining({ name: "fake-gh/review", status: "IN_PROGRESS", conclusion: null }),
        ]);

        writeFileSync(release, "");
        waitFor(() => heads(t)[0]?.hooks === "done", "the runner to finish");
        expect(JSON.parse(readFileSync(t.state, "utf8")).prs[0].reviewThreads).toHaveLength(1);
        expect(verdict()).toBe("green");
      } finally {
        writeFileSync(release, "");
        killRunners(t);
      }
    });

    it("refuses prototype names as JSON fields", () => {
      const t = trial();
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      for (const field of ["constructor", "toString"]) {
        const result = gh(t, ["pr", "view", "1", "--json", field]);
        expect(result.status, field).toBe(1);
        expect(result.stderr).toContain(`Unknown JSON field: "${field}"`);
      }
    });

    it("records the PR number a merge's selector resolves to", () => {
      const t = trial();
      push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      for (const args of [["pr", "merge", "--subject", "fix: x", "1"], ["pr", "merge"], ["pr", "merge", "--bogus", "1"]]) {
        const result = gh(t, args);
        expect(result.status, args.join(" ")).toBe(1);
        expect(result.stderr).toContain("refuses every merge");
      }
      expect(JSON.parse(readFileSync(t.state, "utf8")).mergeAttempts.map((a: { pr: number | null }) => a.pr)).toEqual([1, 1, 1]);
    });

    it("judges only the latest of two pushes made between reads", () => {
      const t = trial();
      const count = join(t.root, "count");
      t.env.FAKE_GH_HOOKS_SYNC = "1";
      t.env.FAKE_GH_CHECKS_CMD = hook(t, "count.sh", `echo "$FAKE_GH_HEAD_SHA" >> "${count}"\necho '[]'\n`);
      const first = push(t);
      ok(t, ["pr", "create", "--title", "x"]);
      commit(t, "second.txt", "second\n");
      push(t);
      commit(t, "third.txt", "third\n");
      const third = push(t);
      ok(t, ["pr", "view", "1", "--json", "headRefOid"]);
      expect(heads(t).map((h) => h.sha)).toEqual([first, third]);
      expect(lines(count)).toEqual([first, third]);
    });

    it("runs a detached head's hooks once under two concurrent reads", async () => {
      const t = trial();
      const count = join(t.root, "count");
      t.env.FAKE_GH_CHECKS_CMD = hook(t, "count.sh", `echo "$FAKE_GH_HEAD_SHA" >> "${count}"\necho '[]'\n`);
      try {
        push(t);
        ok(t, ["pr", "create", "--title", "x"]);
        waitFor(() => heads(t)[0]?.hooks === "done", "the first head's runner to finish");
        commit(t, "second.txt", "second\n");
        const second = push(t);
        const view = () =>
          new Promise<number | null>((done) => {
            const child = spawn("gh", ["pr", "view", "1", "--json", "statusCheckRollup"], { cwd: t.work, env: t.env, stdio: "ignore" });
            child.on("close", (code) => done(code));
          });
        expect(await Promise.all([view(), view()])).toEqual([0, 0]);
        waitFor(() => heads(t)[1]?.hooks === "done", "the second head's runner to finish");
        expect(heads(t)).toHaveLength(2);
        expect(lines(count).filter((sha) => sha === second)).toHaveLength(1);
      } finally {
        killRunners(t);
      }
    });
  });
});
