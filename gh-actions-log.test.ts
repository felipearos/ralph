// @vitest-environment node
/**
 * What `gh-actions-log.ts` promises a session with a red GitHub Actions check:
 * bk-log's digest for an Actions run — the failing job and step, the command,
 * the failing tests with their error, the exit line — plus one guarded re-run,
 * all through an injected gh and never with the token in the output.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Gh, GhResult } from "./pr-wait";
import { branchRun, cleanActionsLog, main, parseActionsUrl, probeActionsRead } from "./gh-actions-log";

const REPO = "acme-org/acme-app";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const ENV: NodeJS.ProcessEnv = {
  RALPH_PROJECT_REPO: REPO,
  RALPH_REQUIRED_CHECKS: "test",
  GH_TOKEN: TOKEN,
};
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const RUN_URL = `https://github.com/${REPO}/actions/runs/700`;

type Route = Partial<GhResult>;
type Fake = Gh & { calls: string[] };

/** A gh whose answers are keyed by the joined args; an unknown call is a 404. */
function fakeGh(routes: Record<string, Route>): Fake {
  const calls: string[] = [];
  const gh = ((args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    const route = routes[key];
    if (!route) return { status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) ${key}` };
    return { status: 0, stdout: "", stderr: "", ...route };
  }) as Fake;
  gh.calls = calls;
  return gh;
}

const ok = (body: unknown): Route => ({ status: 0, stdout: typeof body === "string" ? body : JSON.stringify(body) });

const LOG = [
  "﻿2026-11-24T10:00:00.1000000Z ##[group]Run actions/checkout@v4",
  "2026-11-24T10:00:00.2000000Z with:",
  "2026-11-24T10:00:00.3000000Z ##[endgroup]",
  "2026-11-24T10:00:05.0000000Z ##[group]Run bun run test",
  "2026-11-24T10:00:05.1000000Z \x1b[36;1mbun run test\x1b[0m",
  "2026-11-24T10:00:05.2000000Z shell: /usr/bin/bash -e {0}",
  "2026-11-24T10:00:05.3000000Z ##[endgroup]",
  "2026-11-24T10:01:00.0000000Z  ✓ src/ok.test.ts (3 tests) 12ms",
  "2026-11-24T10:01:01.0000000Z ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "2026-11-24T10:01:01.1000000Z ",
  "2026-11-24T10:01:01.2000000Z  FAIL  src/claim.test.ts > claim > keeps the lease",
  "2026-11-24T10:01:01.3000000Z AssertionError: expected 'lost' to be 'held'",
  "2026-11-24T10:01:01.4000000Z  ❯ src/claim.test.ts:42:7",
  "2026-11-24T10:01:02.0000000Z  Test Files  1 failed | 9 passed (10)",
  "2026-11-24T10:01:02.1000000Z       Tests  1 failed | 30 passed (31)",
  "2026-11-24T10:01:03.0000000Z error: script \"test\" exited with code 1",
  "2026-11-24T10:01:03.1000000Z ##[error]Process completed with exit code 1.",
].join("\n");

const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 700,
  name: "CI",
  head_branch: "rafa/50-actions",
  head_sha: HEAD,
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  html_url: RUN_URL,
  event: "pull_request",
  ...over,
});

const testJob = {
  id: 9001,
  name: "test",
  status: "completed",
  conclusion: "failure",
  html_url: `${RUN_URL}/job/9001`,
  steps: [
    { name: "Set up job", number: 1, status: "completed", conclusion: "success" },
    { name: "Test", number: 4, status: "completed", conclusion: "failure" },
  ],
};
const lintJob = {
  id: 9002,
  name: "lint",
  status: "completed",
  conclusion: "success",
  html_url: `${RUN_URL}/job/9002`,
  steps: [{ name: "Lint", number: 3, status: "completed", conclusion: "success" }],
};

function routes(over: { run?: Record<string, unknown>; jobs?: unknown[] } = {}): Record<string, Route> {
  return {
    [`api repos/${REPO}/actions/runs/700`]: ok(run(over.run)),
    [`api repos/${REPO}/actions/runs/700/jobs?per_page=100&page=1`]: ok({ jobs: over.jobs ?? [testJob, lintJob] }),
    [`api --allow-escape-sequences repos/${REPO}/actions/jobs/9001/logs`]: ok(LOG),
    [`api --allow-escape-sequences repos/${REPO}/actions/jobs/9002/logs`]: ok("2026-11-24T10:00:00.0000000Z Found 0 warnings and 0 errors."),
  };
}

const POST = `api -X POST repos/${REPO}/actions/runs/700/rerun-failed-jobs`;

let out: string[] = [];
let err: string[] = [];
const capture = (): void => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
};
afterEach(() => {
  // No token text in anything printed, by any test.
  expect([...out, ...err].join("\n")).not.toContain(TOKEN);
  vi.restoreAllMocks();
});

describe("parseActionsUrl", () => {
  it("reads a run URL and a job URL", () => {
    expect(parseActionsUrl(RUN_URL)).toEqual({ repo: REPO, run: "700" });
    expect(parseActionsUrl(`${RUN_URL}/job/9001?pr=12`)).toEqual({ repo: REPO, run: "700", job: "9001" });
  });

  it("is null for anything that is not an Actions run", () => {
    expect(parseActionsUrl("https://buildkite.com/acme/acme-app/builds/2425")).toBeNull();
    expect(parseActionsUrl(`https://github.com/${REPO}/pull/12`)).toBeNull();
    expect(parseActionsUrl(`https://github.com/${REPO}/actions/runs/abc`)).toBeNull();
  });
});

describe("cleanActionsLog", () => {
  it("strips timestamps and turns the runner's markers into what the digest reads", () => {
    const log = cleanActionsLog(LOG);
    expect(log).not.toMatch(/2026-11-24T/);
    expect(log).toContain("$ bun run test");
    expect(log).not.toContain("##[");
    expect(log).toContain("Process completed with exit code 1.");
  });
});

describe("the digest", () => {
  it("names the failing job, step, command, test, file and exit line", () => {
    capture();
    expect(main(["700"], ENV, fakeGh(routes()))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`Run #700 failure — CI on rafa/50-actions @ ${HEAD.slice(0, 10)} (attempt 1)`);
    expect(text).toContain(RUN_URL);
    expect(text).toContain("1 failed job (of 2)");
    expect(text).toContain('== test [9001] — failure, step "Test"');
    expect(text).toContain(`   ${RUN_URL}/job/9001`);
    expect(text).toContain("   command: $ bun run test");
    expect(text).toContain("   failing files: src/claim.test.ts");
    expect(text).toContain("   - FAIL src/claim.test.ts > claim > keeps the lease");
    expect(text).toContain("AssertionError: expected 'lost' to be 'held'");
    expect(text).toContain("   exit: Process completed with exit code 1.");
    expect(text).not.toContain("== lint");
  });

  it("reads a log through a gh too old to know --allow-escape-sequences", () => {
    capture();
    const old = routes();
    old[`api --allow-escape-sequences repos/${REPO}/actions/jobs/9001/logs`] = {
      status: 1,
      stderr: "unknown flag: --allow-escape-sequences",
    };
    old[`api repos/${REPO}/actions/jobs/9001/logs`] = ok(LOG);
    expect(main(["700"], ENV, fakeGh(old))).toBe(0);
    expect(out.join("\n")).toContain("   - FAIL src/claim.test.ts > claim > keeps the lease");
  });

  it("a job URL selects its run and still prints the whole-run digest", () => {
    capture();
    expect(main([`${RUN_URL}/job/9002`], {}, fakeGh(routes()))).toBe(0);
    expect(out.join("\n")).toContain('== test [9001] — failure, step "Test"');
  });

  it("prints JSON with --json", () => {
    capture();
    expect(main(["700", "--json"], ENV, fakeGh(routes()))).toBe(0);
    const body = JSON.parse(out.join("\n")) as { run: { id: number }; failed: Array<{ step: string; command: string }> };
    expect(body.run.id).toBe(700);
    expect(body.failed[0]).toMatchObject({ step: "Test", command: "bun run test" });
  });

  it("says a passing run has no failed jobs, and how to read one", () => {
    capture();
    const gh = fakeGh(routes({ run: { conclusion: "success" }, jobs: [lintJob] }));
    expect(main(["700"], ENV, gh)).toBe(0);
    expect(out.join("\n")).toContain("no failed jobs (of 1)");
    expect(out.join("\n")).toContain("a passing job's output: --job <name> [--grep <regex>]");
  });

  it("--full writes each failed job's cleaned log", () => {
    capture();
    const dir = mkdtempSync(join(tmpdir(), "gha-log-"));
    try {
      expect(main(["700", "--full", dir], ENV, fakeGh(routes()))).toBe(0);
      const saved = join(dir, "gha-700-test.log");
      expect(existsSync(saved)).toBe(true);
      expect(readFileSync(saved, "utf8")).toContain("$ bun run test");
      expect(out.join("\n")).toContain(`   full log: ${saved}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("jobs past the first page", () => {
  it("follows the pages, so a failing job on page 2 is in the digest and --job", () => {
    capture();
    const filler = Array.from({ length: 100 }, (_, i) => ({ ...lintJob, id: 8000 + i, name: `shard ${i}` }));
    const paged = routes();
    paged[`api repos/${REPO}/actions/runs/700/jobs?per_page=100&page=1`] = ok({ total_count: 101, jobs: filler });
    paged[`api repos/${REPO}/actions/runs/700/jobs?per_page=100&page=2`] = ok({ total_count: 101, jobs: [testJob] });
    const gh = fakeGh(paged);
    expect(main(["700"], ENV, gh)).toBe(0);
    expect(out.join("\n")).toContain("1 failed job (of 101)");
    expect(out.join("\n")).toContain('== test [9001] — failure, step "Test"');
    expect(gh.calls).not.toContain(`api repos/${REPO}/actions/runs/700/jobs?per_page=100&page=3`);
    capture();
    expect(main(["700", "--job", "test"], ENV, fakeGh(paged))).toBe(0);
  });
});

describe("an unreadable log", () => {
  const unreadable = (): Record<string, Route> => {
    const broken = routes();
    broken[`api --allow-escape-sequences repos/${REPO}/actions/jobs/9001/logs`] = { status: 1, stderr: "gh: HTTP 502 Bad Gateway" };
    return broken;
  };

  it("still prints the digest, and exits 2", () => {
    capture();
    expect(main(["700"], ENV, fakeGh(unreadable()))).toBe(2);
    expect(out.join("\n")).toContain("== test [9001] — failure");
    expect(out.join("\n")).toContain("log unreadable:");
    expect(err.join("\n")).toContain("1 job log could not be read");
  });

  it("still prints the --json digest, and exits 2", () => {
    capture();
    expect(main(["700", "--json"], ENV, fakeGh(unreadable()))).toBe(2);
    const body = JSON.parse(out.join("\n")) as { failed: Array<{ error: string | null }> };
    expect(body.failed[0]!.error).toContain("502");
  });

  it("exits 2 on --job too", () => {
    capture();
    expect(main(["700", "--job", "test"], ENV, fakeGh(unreadable()))).toBe(2);
    expect(out.join("\n")).toContain("log unreadable:");
  });
});

describe("--branch", () => {
  const BRANCH = `api repos/${REPO}/actions/runs?branch=rafa%2F50&per_page=20`;

  it("reads the newest commit's red run, not a newer green one of another workflow", () => {
    capture();
    const gh = fakeGh({
      ...routes(),
      [BRANCH]: ok({
        workflow_runs: [
          { id: 710, name: "Lint", workflow_id: 2, head_sha: HEAD, status: "completed", conclusion: "success" },
          { id: 700, name: "CI", workflow_id: 1, head_sha: HEAD, status: "completed", conclusion: "failure" },
          { id: 690, name: "Lint", workflow_id: 2, head_sha: HEAD, status: "completed", conclusion: "failure" },
        ],
      }),
    });
    expect(main(["--branch", "rafa/50"], ENV, gh)).toBe(0);
    expect(gh.calls).toContain(`api repos/${REPO}/actions/runs/700`);
    expect(gh.calls).not.toContain(`api repos/${REPO}/actions/runs/710`);
  });

  it("keeps the newest run per workflow at the newest commit, else the newest run", () => {
    const run = (id: number, workflow_id: number, head_sha: string, conclusion: string) =>
      ({ id, workflow_id, head_sha, status: "completed", conclusion });
    // An older attempt of the same workflow, or a red on an older commit, is not the branch's red now.
    expect(branchRun([run(3, 1, "b", "success"), run(2, 1, "b", "failure"), run(1, 2, "a", "failure")])!.id).toBe(3);
    expect(branchRun([run(3, 1, "b", "success"), run(2, 2, "b", "timed_out")])!.id).toBe(2);
    expect(branchRun([])).toBeNull();
  });
});

describe("--pr", () => {
  it("takes the run of the failing required Actions check", () => {
    capture();
    const rollup = [
      { __typename: "StatusContext", context: "buildkite/acme", state: "FAILURE", targetUrl: "https://buildkite.com/acme/acme-app/builds/1" },
      { name: "e2e", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/${REPO}/actions/runs/600/job/1` },
      { name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN_URL}/job/9001` },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: `${RUN_URL}/job/9002` },
    ];
    const gh = fakeGh({
      ...routes(),
      [`pr view 12 --repo ${REPO} --json statusCheckRollup,headRefOid`]: ok({ statusCheckRollup: rollup, headRefOid: HEAD }),
    });
    expect(main(["--pr", "12"], ENV, gh)).toBe(0);
    expect(gh.calls).toContain(`api repos/${REPO}/actions/runs/700`);
    expect(gh.calls).not.toContain(`api repos/${REPO}/actions/runs/600`);
  });

  it("says so when the PR has no Actions check at all", () => {
    capture();
    const gh = fakeGh({
      [`pr view 12 --repo ${REPO} --json statusCheckRollup,headRefOid`]: ok({
        statusCheckRollup: [{ __typename: "StatusContext", context: "buildkite/acme", state: "FAILURE", targetUrl: "https://buildkite.com/x" }],
        headRefOid: HEAD,
      }),
    });
    expect(main(["--pr", "12"], ENV, gh)).toBe(1);
    expect(err.join("\n")).toContain("PR #12 has no GitHub Actions check; its checks: buildkite/acme (fail)");
  });
});

describe("--job", () => {
  it("prints one job's whole cleaned log", () => {
    capture();
    expect(main(["700", "--job", "test"], ENV, fakeGh(routes()))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("== test [9001] — failure");
    expect(text).toContain("AssertionError: expected 'lost' to be 'held'");
    expect(text).not.toMatch(/2026-11-24T/);
  });

  it("greps it, by name or id", () => {
    capture();
    expect(main(["700", "--job", "9001", "--grep", "AssertionError"], ENV, fakeGh(routes()))).toBe(0);
    expect(out.join("\n")).toMatch(/\d+: AssertionError: expected 'lost' to be 'held'/);
    expect(out.join("\n")).not.toContain("Test Files");
  });

  it("says when no line matches", () => {
    capture();
    expect(main(["700", "--job", "lint", "--grep", "nothing-here"], ENV, fakeGh(routes()))).toBe(0);
    expect(out.join("\n")).toContain("(no line matches /nothing-here/)");
  });

  it("names the run's jobs when none matches", () => {
    capture();
    expect(main(["700", "--job", "e2e"], ENV, fakeGh(routes()))).toBe(1);
    expect(err.join("\n")).toContain('no job of run #700 is named e2e; its jobs: "test" [9001] (failure), "lint" [9002] (success)');
  });
});

describe("--rerun", () => {
  it("re-runs the failed jobs once", () => {
    capture();
    const gh = fakeGh({ ...routes(), [POST]: ok("") });
    expect(main(["700", "--rerun"], ENV, gh)).toBe(0);
    expect(gh.calls).toContain(POST);
    expect(out.join("\n")).toBe(`re-ran the failed jobs of run #700 (attempt 2 will follow): ${RUN_URL}`);
  });

  const refusals: Array<[string, Parameters<typeof routes>[0], RegExp]> = [
    ["not completed", { run: { status: "in_progress", conclusion: null } }, /in_progress, not completed/],
    ["already re-run", { run: { run_attempt: 2 } }, /already re-run \(attempt 2\); one re-run per red is the limit/],
    ["no failed job", { run: { conclusion: "success" }, jobs: [lintJob] }, /has no failed job/],
  ];
  for (const [what, over, message] of refusals) {
    it(`refuses when the run is ${what}, without a POST`, () => {
      capture();
      const gh = fakeGh({ ...routes(over), [POST]: ok("") });
      expect(main(["700", "--rerun"], ENV, gh)).toBe(1);
      expect(err.join("\n")).toMatch(message);
      expect(gh.calls).not.toContain(POST);
    });
  }

  it("lists an action_required job and refuses its re-run by name, not as 'no failed job'", () => {
    capture();
    const waiting = { ...testJob, conclusion: "action_required", steps: [] };
    const gh = fakeGh({ ...routes({ run: { conclusion: "action_required" }, jobs: [waiting, lintJob] }), [POST]: ok("") });
    main(["700"], ENV, gh);
    expect(out.join("\n")).toContain("== test [9001] — action_required");
    capture();
    expect(main(["700", "--rerun"], ENV, gh)).toBe(1);
    expect(err.join("\n")).toContain("job test is action_required, which a re-run cannot clear; a person must approve it");
    expect(err.join("\n")).not.toContain("no failed job");
    expect(gh.calls).not.toContain(POST);
  });

  it("refuses with --pr when the run is not of the PR's head", () => {
    capture();
    const gh = fakeGh({
      ...routes(),
      [POST]: ok(""),
      [`pr view 12 --repo ${REPO} --json statusCheckRollup,headRefOid`]: ok({
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN_URL}/job/9001` }],
        headRefOid: "ffffffffffffffffffffffffffffffffffffffff",
      }),
    });
    expect(main(["--pr", "12", "--rerun"], ENV, gh)).toBe(1);
    expect(err.join("\n")).toContain("a re-run of an old commit proves nothing about the head");
    expect(gh.calls).not.toContain(POST);
  });
});

describe("--pr --rerun", () => {
  const VIEW = `pr view 12 --repo ${REPO} --json statusCheckRollup,headRefOid`;
  const RUN_600 = `https://github.com/${REPO}/actions/runs/600`;
  const POST_600 = `api -X POST repos/${REPO}/actions/runs/600/rerun-failed-jobs`;
  const e2eJob = { ...testJob, id: 6001, name: "e2e", html_url: `${RUN_600}/job/6001` };
  const twoRuns = (over: { run600?: Record<string, unknown> } = {}): Record<string, Route> => ({
    ...routes(),
    [`api repos/${REPO}/actions/runs/600`]: ok(run({ id: 600, html_url: RUN_600, ...over.run600 })),
    [`api repos/${REPO}/actions/runs/600/jobs?per_page=100&page=1`]: ok({ jobs: [e2eJob] }),
  });
  const rollup = (...extra: unknown[]) => [
    { name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN_URL}/job/9001` },
    { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN_URL}/job/9002` },
    { name: "e2e", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN_600}/job/6001` },
    { name: "deploy", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme-org/acme-app/actions/runs/500" },
    ...extra,
  ];

  it("re-runs every red Actions run at the PR's head, once each", () => {
    capture();
    const gh = fakeGh({ ...twoRuns(), [POST]: ok(""), [POST_600]: ok(""), [VIEW]: ok({ statusCheckRollup: rollup(), headRefOid: HEAD }) });
    expect(main(["--pr", "12", "--rerun"], ENV, gh)).toBe(0);
    expect(gh.calls.filter((call) => call === POST)).toHaveLength(1);
    expect(gh.calls.filter((call) => call === POST_600)).toHaveLength(1);
    expect(gh.calls).not.toContain(`api repos/${REPO}/actions/runs/500`);
    expect(out.join("\n").split("\n")).toEqual([
      `re-ran the failed jobs of run #700 (attempt 2 will follow): ${RUN_URL}`,
      `re-ran the failed jobs of run #600 (attempt 2 will follow): ${RUN_600}`,
    ]);
  });

  it("refuses a run linked in another repository, and a run already re-run, and still re-runs the rest", () => {
    capture();
    const foreign = { name: "x", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/example-org/elsewhere/actions/runs/800" };
    const gh = fakeGh({
      ...twoRuns({ run600: { run_attempt: 2 } }),
      [POST]: ok(""),
      [POST_600]: ok(""),
      [VIEW]: ok({ statusCheckRollup: rollup(foreign), headRefOid: HEAD }),
    });
    expect(main(["--pr", "12", "--rerun"], ENV, gh)).toBe(0);
    expect(gh.calls).toContain(POST);
    expect(gh.calls).not.toContain(POST_600);
    expect(gh.calls.some((call) => call.includes("example-org/elsewhere"))).toBe(false);
    const text = out.join("\n");
    expect(text).toContain("re-ran the failed jobs of run #700");
    expect(text).toContain("not re-running: run #600 was already re-run (attempt 2)");
    expect(text).toContain(`not re-running run #800: its check links example-org/elsewhere, not ${REPO}`);
  });

  it("matches the repository case-insensitively", () => {
    capture();
    const upper = [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/ACME-org/Acme-App/actions/runs/700` }];
    const gh = fakeGh({ ...routes(), [POST]: ok(""), [VIEW]: ok({ statusCheckRollup: upper, headRefOid: HEAD }) });
    expect(main(["--pr", "12", "--rerun"], ENV, gh)).toBe(0);
    expect(gh.calls).toContain(POST);
  });

  it("exits 1 with every reason on stderr when all are refused", () => {
    capture();
    const gh = fakeGh({
      ...twoRuns(),
      [POST]: ok(""),
      [POST_600]: ok(""),
      [VIEW]: ok({ statusCheckRollup: rollup(), headRefOid: "ffffffffffffffffffffffffffffffffffffffff" }),
    });
    expect(main(["--pr", "12", "--rerun"], ENV, gh)).toBe(1);
    expect(err.join("\n").match(/a re-run of an old commit proves nothing about the head/g)).toHaveLength(2);
    expect(gh.calls).not.toContain(POST);
    expect(gh.calls).not.toContain(POST_600);
  });

  it("exits 75 when the re-run is rate-limited", () => {
    capture();
    const gh = fakeGh({
      ...routes(),
      [POST]: { status: 1, stderr: "gh: API rate limit exceeded (HTTP 403)" },
      [VIEW]: ok({ statusCheckRollup: rollup().slice(0, 1), headRefOid: HEAD }),
    });
    expect(main(["--pr", "12", "--rerun"], ENV, gh)).toBe(75);
  });
});

describe("--check-token", () => {
  const runs = `api repos/${REPO}/actions/runs?per_page=1`;
  const jobs = `api repos/${REPO}/actions/runs/700/jobs?per_page=1`;

  it("passes when gh reads the runs and a run's jobs", () => {
    capture();
    const gh = fakeGh({ [runs]: ok({ workflow_runs: [{ id: 700 }] }), [jobs]: ok({ jobs: [] }) });
    expect(main(["--check-token"], ENV, gh)).toBe(0);
    expect(out.join("\n")).toContain(`gh can read ${REPO}'s Actions runs and job logs`);
    expect(probeActionsRead(REPO, gh)).toEqual({ status: "ok" });
  });

  it("exits 3 with the scope hint on a 403", () => {
    capture();
    const gh = fakeGh({ [runs]: { status: 1, stderr: "gh: Resource not accessible by personal access token (HTTP 403)" } });
    expect(main(["--check-token"], ENV, gh)).toBe(3);
    expect(err.join("\n")).toContain("(classic: repo; fine-grained: Actions read)");
  });

  it("exits 2 when GitHub is unreachable", () => {
    capture();
    const gh = fakeGh({ [runs]: { status: 1, stderr: "dial tcp: lookup api.github.com: no such host" } });
    expect(main(["--check-token"], ENV, gh)).toBe(2);
    expect(probeActionsRead(REPO, gh).status).toBe("unreachable");
  });
});

describe("failures", () => {
  it("exits 75 when GitHub rate-limits the read", () => {
    capture();
    const gh = fakeGh({ [`api repos/${REPO}/actions/runs/700`]: { status: 1, stderr: "gh: API rate limit exceeded for user (HTTP 403)" } });
    expect(main(["700"], ENV, gh)).toBe(75);
    expect(err.join("\n")).toContain("GitHub rate-limited the read");
  });

  it("exits 2 with the scope hint on a 404, and never echoes a token", () => {
    capture();
    const gh = fakeGh({ [`api repos/${REPO}/actions/runs/700`]: { status: 1, stderr: `gh: Not Found (HTTP 404) token ${TOKEN}` } });
    expect(main(["700"], ENV, gh)).toBe(2);
    expect(err.join("\n")).toContain(`gh's token needs Actions read on ${REPO}`);
  });

  it("refuses bad usage with 64", () => {
    capture();
    const gh = fakeGh({});
    expect(main([], ENV, gh)).toBe(64);
    expect(main(["700", "--job", "test", "--json"], ENV, gh)).toBe(64);
    expect(main(["700", "--grep", "x"], ENV, gh)).toBe(64);
    expect(main(["https://buildkite.com/acme/acme-app/builds/1"], ENV, gh)).toBe(64);
    expect(gh.calls).toEqual([]);
  });
});

