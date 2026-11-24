// @vitest-environment node
/**
 * #52: the ci-doctor wired for a project whose CI is GitHub Actions. A
 * candidate flake found by scanning Actions runs is re-run as one Actions job,
 * under the same `ciDoctor.retry` ceilings a Buildkite retry spends; and the
 * gate's `retryDepsFrom` picks that wiring from the required checks alone, with
 * no token of ours.
 *
 * `retryDepsFrom` asks git where the store lives (`storePathFromGit`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ActionsJob, ActionsRun } from "../gh-actions-log";
import { subprocessSuite } from "../test-timeouts";
import { fakeActions } from "./actions-fake";
import { actionsSource, isActionsProject } from "./actions-source";
import { checkIncidents } from "./classify";
import { retryDepsFrom, scannedJobNames } from "./gate";
import { retryOnce, type RetryDeps } from "./retry";
import { defaultScanOptions, scan } from "./scan";
import { readStore } from "./store";

subprocessSuite("git");

const REPO = "acme-org/acme-app";
const NOW = Date.parse("2026-09-28T12:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ci-actions-wiring-"));
  dirs.push(dir);
  return dir;
};

const failingLog = (file: string): string =>
  [
    "##[group]Run bun x vitest run",
    "##[endgroup]",
    ` FAIL  ${file} > flaps > once`,
    "Error: Test timed out in 5000ms.",
    ` ❯ ${file}:3:1`,
    " Test Files  1 failed | 4 passed (5)",
    "##[error]Process completed with exit code 1.",
  ]
    .map((line) => `2026-09-28T11:00:00.0000000Z ${line}`)
    .join("\n");

function run(id: number, conclusion: string, finished: string): ActionsRun {
  const at = Date.parse(finished);
  return {
    id,
    name: "CI",
    head_branch: "main",
    head_sha: id.toString(16).padStart(40, "a"),
    status: "completed",
    conclusion,
    run_attempt: 1,
    event: "push",
    created_at: new Date(at - 600_000).toISOString(),
    run_started_at: new Date(at - 540_000).toISOString(),
    updated_at: finished,
    head_commit: { message: `change ${id}` },
    pull_requests: [],
  };
}

const job = (id: number, conclusion: string): ActionsJob => ({
  id,
  name: "test",
  status: "completed",
  conclusion,
  run_attempt: 1,
  steps: [
    { name: "Set up job", number: 1, status: "completed", conclusion: "success" },
    { name: "Run tests", number: 2, status: "completed", conclusion: conclusion === "success" ? "success" : "failure" },
  ],
});

/** A store scanned from Actions: a green main run, then one red run per given test file. */
async function scannedStore(files: string[]): Promise<string> {
  const runs = [run(1001, "success", "2026-09-28T09:00:00Z")];
  const jobs: Record<number, ActionsJob[]> = { 1001: [job(2001, "success")] };
  const logs: Record<number, string> = {};
  files.forEach((file, i) => {
    runs.push(run(1002 + i, "failure", `2026-09-28T1${i}:00:00Z`));
    jobs[1002 + i] = [job(2002 + i, "failure")];
    logs[2002 + i] = failingLog(file);
  });
  const fake = fakeActions(runs, jobs, logs);
  fake.setNow(NOW);
  const path = join(tempDir(), "ci-health.json");
  await scan(actionsSource(fake.gh, REPO, { now: () => NOW }), null, path, defaultScanOptions("acme-org", "acme-app", { baseBranch: "main" }), NOW);
  return path;
}

/** `retryOnce` wired as `retryDepsFrom` wires an Actions project, with a recording `put`. */
function actionsDeps(path: string, config: unknown = null): RetryDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    storePath: path,
    org: async () => REPO,
    pipeline: REPO,
    retryPath: (_org, _pipeline, _build, id) => `repos/${REPO}/actions/jobs/${id}/rerun`,
    baseBranch: "main",
    config,
    now: () => NOW,
    put: async (p) => {
      calls.push(p);
    },
    readCi: () => ({ busy: false, detail: "nothing pending" }),
    ciReadCalls: 3,
    afford: () => true,
    hostLeaseBusy: () => ({ busy: false, detail: "no holder, no queue" }),
    branchHead: () => null,
  };
}

describe("an Actions project's retry", () => {
  it("re-runs the candidate flake's failed job once, through the Actions path", async () => {
    const path = await scannedStore(["src/a.test.ts"]);
    expect(Object.values(readStore(path).cases).map((value) => value.state)).toContain("candidate");
    const wired = actionsDeps(path);
    expect((await retryOnce(wired)).outcome).toBe("retried");
    expect(wired.calls).toEqual([`repos/${REPO}/actions/jobs/2002/rerun`]);

    // perCandidate is 1: the same candidate is not re-run again.
    const again = await retryOnce(wired);
    expect(again.outcome).toBe("none");
    expect(wired.calls).toHaveLength(1);
  });

  it("reserves the re-run POST with the idle read, so an allowance one call short makes no retry", async () => {
    const path = await scannedStore(["src/a.test.ts"]);
    const wired = { ...actionsDeps(path), putGhCalls: 1, afford: (calls: number) => calls <= 3 };
    expect((await retryOnce(wired)).outcome).toBe("no-budget");
    expect(wired.calls).toEqual([]);
  });

  it("honours ciDoctor.retry.perDay across candidates", async () => {
    const path = await scannedStore(["src/a.test.ts", "src/b.test.ts"]);
    const wired = actionsDeps(path, { ciDoctor: { retry: { perDay: 1 } } });
    expect((await retryOnce(wired)).outcome).toBe("retried");
    expect((await retryOnce(wired)).outcome).toBe("capped");
    expect(wired.calls).toHaveLength(1);
    expect(wired.calls[0]).toMatch(new RegExp(`^repos/${REPO}/actions/jobs/\\d+/rerun$`));
  });
});

describe("retryDepsFrom", () => {
  it("wires an Actions project without any Buildkite token", async () => {
    const deps = retryDepsFrom(tempDir(), {
      RALPH_REQUIRED_CHECKS: "test",
      RALPH_PROJECT_REPO: REPO,
      RALPH_BASE_BRANCH: "main",
    });
    expect(deps).toBeDefined();
    expect(deps!.retryPath!("x", "y", 1, "99")).toBe(`repos/${REPO}/actions/jobs/99/rerun`);
    expect(await deps!.org()).toBe(REPO);
    expect(deps!.baseBranch).toBe("main");
  });

  it("still needs the Buildkite tokens for a Buildkite project", () => {
    expect(
      retryDepsFrom(tempDir(), { RALPH_REQUIRED_CHECKS: "buildkite/acme", RALPH_PROJECT_REPO: REPO, RALPH_BASE_BRANCH: "main" }),
    ).toBeUndefined();
  });

  it("makes no retry for an Actions project whose repository is unknown", () => {
    expect(retryDepsFrom(tempDir(), { RALPH_REQUIRED_CHECKS: "test", RALPH_BASE_BRANCH: "main" })).toBeUndefined();
  });
});

describe("isActionsProject", () => {
  it("reads the required checks the way ci-log.ts does", () => {
    expect(isActionsProject(["test"], {})).toBe(true);
    expect(isActionsProject(["buildkite/acme-app"], {})).toBe(false);
  });

  it("keeps a project that names a Buildkite pipeline on Buildkite, whatever its checks say", () => {
    expect(isActionsProject([], { RALPH_BUILDKITE_PIPELINE: "acme-app" })).toBe(false);
    expect(isActionsProject(["test"], { RALPH_BUILDKITE_PIPELINE: "acme-app" })).toBe(false);
  });
});

describe("the gh calls an Actions retry spends", () => {
  it("charges the re-run POST to the gate's allowance, on success and on fault", async () => {
    const path = await scannedStore(["src/a.test.ts", "src/b.test.ts"]);
    const wired = { ...actionsDeps(path), putGhCalls: 1 };
    const done = await retryOnce(wired);
    expect(done.outcome).toBe("retried");
    expect(done.ghCalls).toBe(wired.ciReadCalls + 1);

    const failing = {
      ...actionsDeps(path),
      putGhCalls: 1,
      put: async () => {
        throw new Error("HTTP 403");
      },
    };
    const fault = await retryOnce(failing);
    expect(fault.outcome).toBe("fault");
    expect(fault.ghCalls).toBe(failing.ciReadCalls + 1);
  });

  it("is wired at one call per re-run by retryDepsFrom", () => {
    const deps = retryDepsFrom(tempDir(), { RALPH_REQUIRED_CHECKS: "test", RALPH_PROJECT_REPO: REPO, RALPH_BASE_BRANCH: "main" });
    expect(deps!.putGhCalls).toBe(1);
  });
});

describe("check incidents on an Actions project", () => {
  const red = (pr: number, name: string) => ({ pr, name, state: "failure", description: "Process completed with exit code 1." });

  it("does not count a required check the scan already reads as a job", async () => {
    const path = await scannedStore(["src/a.test.ts"]);
    const scanned = scannedJobNames(readStore(path));
    expect([...scanned]).toEqual(["test"]);
    const readings = [red(1, "test"), red(2, "test"), red(3, "test")];
    expect(Object.keys(checkIncidents(readings, 3, scanned))).toEqual([]);
    // Without the scan's names it is the incident it used to be.
    expect(Object.keys(checkIncidents(readings))).toHaveLength(1);
    // Another check, red on three PRs, still is one.
    expect(Object.keys(checkIncidents([red(1, "Vercel"), red(2, "Vercel"), red(3, "Vercel")], 3, scanned))).toHaveLength(1);
  });
});
