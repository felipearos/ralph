// @vitest-environment node
/**
 * What `ci-doctor/actions-source.ts` promises (#52): a scan over GitHub
 * Actions runs records the same builds, failure rows and cases a scan over
 * Buildkite builds would. GitHub is the fake in `actions-fake.ts`, git a
 * record; nothing here spawns a process or calls the network.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HelperError } from "../bk-log";
import type { ActionsJob, ActionsRun } from "../gh-actions-log";
import type { Gh } from "../pr-wait";
import { fakeActions, type FakeActions } from "./actions-fake";
import { actionsSource } from "./actions-source";
import { GitFacts, defaultScanOptions, scan, type GitRun, type ScanOptions } from "./scan";
import { readStore } from "./store";

const REPO = "acme-org/acme-app";
const OPTIONS: ScanOptions = defaultScanOptions("acme-org", "acme-app", { baseBranch: "main" });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string): number => Date.parse(iso);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-health-actions-"));
  dirs.push(dir);
  return join(dir, "ralph", "ci-health.json");
}

const T_FILE = "src/server/slow.integration.test.ts";
const T = `${T_FILE} > slow > counts`;

/** A raw Actions job log, timestamps and runner markers included, of a vitest timeout. */
const testLog = [
  "##[group]Run bun x vitest run --coverage",
  "bun x vitest run --coverage",
  "##[endgroup]",
  ` FAIL  ${T_FILE} > slow > counts`,
  "Error: Test timed out in 5000ms.",
  ` ❯ ${T_FILE}:12:3`,
  " Test Files  1 failed | 10 passed (11)",
  "##[error]Process completed with exit code 1.",
]
  .map((line) => `2026-09-28T11:00:00.0000000Z ${line}`)
  .join("\n");

const setupLog = [
  "Current runner version: '2.320.0'",
  "##[error]Failed to download action 'https://api.github.com/repos/actions/checkout/tarball/v4'. Could not resolve host: api.github.com",
]
  .map((line) => `2026-09-28T11:00:00.0000000Z ${line}`)
  .join("\n");

const sha = (n: number): string => n.toString(16).padStart(40, "a");
const tree = (n: number): string => n.toString(16).padStart(40, "e");

interface RunSpec {
  id: number;
  commit: string;
  conclusion: string | null;
  finished: string;
  branch?: string;
  attempt?: number;
  message?: string;
}

function run(spec: RunSpec): ActionsRun {
  const finished = at(spec.finished);
  return {
    id: spec.id,
    name: "CI",
    head_branch: spec.branch ?? "main",
    head_sha: spec.commit,
    status: "completed",
    conclusion: spec.conclusion,
    run_attempt: spec.attempt ?? 1,
    html_url: `https://github.com/${REPO}/actions/runs/${spec.id}`,
    event: "push",
    workflow_id: 7,
    created_at: new Date(finished - 10 * MINUTE).toISOString(),
    run_started_at: new Date(finished - 9 * MINUTE).toISOString(),
    updated_at: spec.finished,
    head_commit: { message: spec.message ?? `change ${spec.id} (#${spec.id + 100})` },
    pull_requests: [],
  };
}

/** A job whose `failedIn` step failed (or none: it passed). */
function job(id: number, conclusion: string, attempt = 1, failedIn: string | null = conclusion === "failure" ? "Run tests" : null): ActionsJob {
  const names = ["Set up job", "Run actions/checkout@v4", "Run tests", "Complete job"];
  let failed = false;
  const steps = names.map((name, index) => {
    if (failed) return { name, number: index + 1, status: "completed", conclusion: "skipped" };
    if (name === failedIn) {
      failed = true;
      return { name, number: index + 1, status: "completed", conclusion: "failure" };
    }
    return { name, number: index + 1, status: "completed", conclusion: "success" };
  });
  return {
    id,
    name: "test",
    status: "completed",
    conclusion,
    run_attempt: attempt,
    html_url: `https://github.com/${REPO}/actions/runs/1/job/${id}`,
    steps,
  };
}

/** A clone that knows each commit's parent and tree. */
function synthGit(commits: { sha: string; parent: string | null; tree: string }[]): GitRun {
  const record: Record<string, string | null> = {};
  for (const commit of commits) {
    record[`cat-file -e ${commit.sha}^{commit}`] = "";
    record[`rev-parse ${commit.sha}^{tree}`] = commit.tree;
    record[`rev-parse ${commit.sha}^`] = commit.parent;
    record[`merge-base origin/main ${commit.sha}`] = commits[0]!.sha;
  }
  return (args) => (args[0] === "fetch" ? (args.length > 4 ? null : "") : (record[args.join(" ")] ?? null));
}

async function poll(fake: FakeActions, git: GitRun | null, path: string, now: number, gh: Gh = fake.gh) {
  fake.setNow(now);
  return scan(actionsSource(gh, REPO), git === null ? null : new GitFacts(git, OPTIONS.baseBranch), path, OPTIONS, now);
}

describe("a scan over GitHub Actions runs", () => {
  it("records a failed run on main within the window, and its failure rows from the job log", async () => {
    const fake = fakeActions(
      [
        run({ id: 1001, commit: sha(1), conclusion: "success", finished: "2026-09-28T10:00:00Z" }),
        run({ id: 1002, commit: sha(2), conclusion: "failure", finished: "2026-09-28T11:00:00Z" }),
      ],
      { 1001: [job(2001, "success")], 1002: [job(2002, "failure")] },
      { 2002: testLog },
    );
    const path = storeFile();
    const result = await poll(fake, null, path, at("2026-09-28T12:00:00Z"));
    expect(result.logsRead).toBe(1);
    expect(fake.calls.some((call) => /\/runs\/1002\/jobs\?.*filter=all/.test(call))).toBe(true);
    const store = readStore(path);
    expect(store.builds.map((build) => build.number)).toEqual([1001, 1002]);
    expect(store.builds[1]).toMatchObject({
      number: 1002,
      branch: "main",
      commit: sha(2),
      state: "failed",
      source: "push",
      finishedAt: "2026-09-28T11:00:00Z",
      prs: [1102],
      steps: { "CI/test": "failed" },
    });
    expect(store.failures).toMatchObject([{ testId: T, build: 1002, job: "2002", step: "CI/test", kind: "timeout", retried: false }]);
  });

  it("does not record a run that finished before the window", async () => {
    const now = at("2026-09-28T12:00:00Z");
    const old = new Date(now - (OPTIONS.windowHours + 1) * HOUR).toISOString();
    const fake = fakeActions(
      [run({ id: 1001, commit: sha(1), conclusion: "failure", finished: old })],
      { 1001: [job(2001, "failure")] },
      { 2001: testLog },
    );
    const path = storeFile();
    await poll(fake, null, path, now);
    const store = readStore(path);
    expect(store.builds).toEqual([]);
    expect(store.failures).toEqual([]);
  });

  it("reads a job that failed in Set up job as bootstrap, and one that failed in a run step as tests", async () => {
    const fake = fakeActions(
      [
        run({ id: 1001, commit: sha(1), conclusion: "failure", finished: "2026-09-28T10:00:00Z", branch: "ralph/1-a" }),
        run({ id: 1002, commit: sha(2), conclusion: "failure", finished: "2026-09-28T11:00:00Z", branch: "rafa/2-b" }),
      ],
      { 1001: [job(2001, "failure", 1, "Set up job")], 1002: [job(2002, "failure")] },
      { 2001: setupLog, 2002: testLog },
    );
    const path = storeFile();
    await poll(fake, null, path, at("2026-09-28T12:00:00Z"));
    const store = readStore(path);
    const setup = store.failures.filter((row) => row.job === "2001");
    expect(setup).toHaveLength(1);
    expect(setup[0]!.testId).toMatch(/^bootstrap:/);
    expect(setup[0]!.kind).toBe("bootstrap");
    expect(store.failures.filter((row) => row.job === "2002").map((row) => row.testId)).toEqual([T]);
  });

  it("records an earlier attempt's failed job as retried", async () => {
    const fake = fakeActions(
      [run({ id: 1002, commit: sha(2), conclusion: "success", finished: "2026-09-28T11:40:00Z", attempt: 2 })],
      { 1002: [job(2002, "failure", 1), job(2003, "success", 2)] },
      { 2002: testLog },
    );
    const path = storeFile();
    await poll(fake, null, path, at("2026-09-28T12:00:00Z"));
    const store = readStore(path);
    expect(store.failures).toMatchObject([{ testId: T, job: "2002", retried: true }]);
    expect(store.builds[0]).toMatchObject({ state: "passed", steps: { "CI/test": "passed" } });
  });

  it("makes a flake of a test red on main and green on the re-run of the same commit", async () => {
    const git = synthGit([{ sha: sha(2), parent: sha(1), tree: tree(2) }]);
    const path = storeFile();
    const red = fakeActions(
      [run({ id: 1002, commit: sha(2), conclusion: "failure", finished: "2026-09-28T11:00:00Z" })],
      { 1002: [job(2002, "failure", 1)] },
      { 2002: testLog },
    );
    await poll(red, git, path, at("2026-09-28T11:30:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toMatchObject({ state: "candidate" });

    // The run is re-run and passes: same run id, attempt 2, finished later.
    const rerun = fakeActions(
      [run({ id: 1002, commit: sha(2), conclusion: "success", finished: "2026-09-28T11:40:00Z", attempt: 2 })],
      { 1002: [job(2002, "failure", 1), job(2003, "success", 2)] },
    );
    await poll(rerun, git, path, at("2026-09-28T12:00:00Z"));
    expect(rerun.calls.filter((call) => call.endsWith("/logs"))).toEqual([]); // the red job's log was read the first time
    const store = readStore(path);
    expect(store.failures.filter((row) => row.job === "2002")).toMatchObject([{ retried: true }]);
    expect(store.cases[`flake:${T}`]).toMatchObject({ kind: "flake", state: "confirmed", rule: "same tree, both colours" });
  });

  it("makes a regression of a test red on two consecutive main runs after a green one", async () => {
    const fake = fakeActions(
      [
        run({ id: 1001, commit: sha(1), conclusion: "success", finished: "2026-09-28T10:00:00Z" }),
        run({ id: 1002, commit: sha(2), conclusion: "failure", finished: "2026-09-28T11:00:00Z", message: "feat: slower counts (#1234)" }),
        run({ id: 1003, commit: sha(3), conclusion: "failure", finished: "2026-09-28T12:00:00Z" }),
      ],
      { 1001: [job(2001, "success")], 1002: [job(2002, "failure")], 1003: [job(2003, "failure")] },
      { 2002: testLog, 2003: testLog },
    );
    const git = synthGit([
      { sha: sha(1), parent: sha(0), tree: tree(1) },
      { sha: sha(2), parent: sha(1), tree: tree(2) },
      { sha: sha(3), parent: sha(2), tree: tree(3) },
    ]);
    const path = storeFile();
    await poll(fake, git, path, at("2026-09-28T12:30:00Z"));
    const store = readStore(path);
    const regression = store.cases[`regression:${T}`];
    expect(regression).toMatchObject({ kind: "regression", state: "confirmed" });
    expect(regression!.culprit).toMatchObject({ commit: sha(2), build: 1002, parentBuild: 1001, pr: 1234 });
    expect(store.cases[`flake:${T}`]).toBeUndefined();
    expect(store.main).toMatchObject({ state: "red", build: 1002 });
  });

  it("throws and leaves the store alone when the runs list cannot be read", async () => {
    const fake = fakeActions([run({ id: 1001, commit: sha(1), conclusion: "failure", finished: "2026-09-28T11:00:00Z" })]);
    const failing: Gh = (args) =>
      /\/actions\/runs\?/.test(args[1] ?? "") ? { status: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" } : fake.gh(args);
    const path = storeFile();
    await expect(poll(fake, null, path, at("2026-09-28T12:00:00Z"), failing)).rejects.toBeInstanceOf(HelperError);
    expect(existsSync(path)).toBe(false);
  });
});
