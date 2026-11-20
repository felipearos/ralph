// @vitest-environment node
/**
 * What `bk-log.ts` promises a session with a red Buildkite check: the failing
 * job, the command it was running, the failing tests with the first lines of
 * their error, and whether every failure was a timeout — bounded, and never
 * the token. The logs below are trimmed from real loggd builds (2425, 2377,
 * 2373, 2626) with Buildkite's escapes left in, so the cleaner is under test too.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  Buildkite,
  HISTORY,
  LIMITS,
  branchRecord,
  buildUrlFromRollup,
  cleanLog,
  crossReference,
  digestLog,
  failedJobs,
  HelperError,
  formatReport,
  main,
  otherRedBuilds,
  parseArgs,
  parseBuildRef,
  pipelineFromChecks,
  resolveOrg,
  retryTokenFrom,
  tokenFrom,
  writeScopes,
  type Build,
  type Fetcher,
  type JobReport,
} from "./bk-log";
import { emptyStore, identify, storePathFromGit, type Case, type CaseKind, type CaseState, type CiHealthStore } from "./ci-doctor/store";

const ts = (n: number): string => `\x1b_bk;t=${1790000000000 + n}\x07`;

/** Build 2425: a real root-suite assertion, after a lint run full of warnings. */
const ROOT_ASSERTION = [
  `${ts(1)}~~~ Running commands`,
  `${ts(2)}$ eslint src/ mobile/ packages/`,
  "  54:7   warning  Error: Avoid constructing JSX within try/catch",
  "\x1b[31m\x1b[1m✖ 2325 problems (0 errors, 2325 warnings)\x1b[22m\x1b[39m",
  `${ts(3)}$ jest`,
  "Test Suites: 212 passed, 212 total",
  `${ts(4)}$ bun x vitest run --coverage`,
  " \x1b[31m❯\x1b[39m src/app/api/v1/mobile-api-error-conformance.test.ts (13 tests | \x1b[31m1 failed\x1b[39m) 50ms",
  "     \x1b[31m×\x1b[39m never grows the allowlist against the base branch 37ms",
  "",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  src/app/api/v1/mobile-api-error-conformance.test.ts > mobile API Error conformance > never grows the allowlist against the base branch",
  "AssertionError: MOBILE_ENVELOPE_CALLERS may only shrink; new paths: mobile/hooks/useLists.ts: expected [ …(1) ] to deeply equal []",
  "",
  "- Expected",
  "+ Received",
  "",
  " ❯ src/app/api/v1/mobile-api-error-conformance.test.ts:533:96",
  "",
  " Test Files  1 failed | 574 passed (575)",
  "      Tests  1 failed | 8564 passed (8565)",
  "",
  '\x1b[?25herror: script "test:coverage" exited with code 1',
  "^^^ +++",
  "🚨 Error: The command exited with status 1",
  "user command error: exit status 1",
  `${ts(5)}~~~ Running repository pre-exit hook`,
  "$ .buildkite/hooks/pre-exit",
].join("\r\n");

/** Build 2377: the known media-mode timeout. */
const TIMEOUT = [
  "$ bun x vitest run --coverage",
  " ❯ src/app/api/v1/media-mode-conformance.test.ts (42 tests | 1 failed) 9186ms",
  " FAIL  src/app/api/v1/media-mode-conformance.test.ts > Media Mode conformance (real tree) > routes every mobile read through the Media Mode Scope",
  "Error: Test timed out in 5000ms.",
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  " ❯ src/app/api/v1/media-mode-conformance.test.ts:589:3",
  " Test Files  1 failed | 573 passed (574)",
  'error: script "test:coverage" exited with code 1',
].join("\n");

/** Build 2626 (PR #1814, a mobile-only diff): a test timeout and two whole files whose hooks timed out. */
const HOOK_TIMEOUTS = [
  "$ bun x vitest run --coverage",
  " FAIL  src/server/imports/library-merge.integration.test.ts > Library Merge > returns exact counts over several batches and totals matching real account counts",
  "Error: Test timed out in 5000ms.",
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  "",
  " FAIL  src/server/queries/scoreAggregate.deletion.integration.test.ts > scoreAggregate deletion",
  "Error: Hook timed out in 10000ms.",
  'If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".',
  "",
  " FAIL  src/server/queries/scoreAggregate.read-path.integration.test.ts > scoreAggregate read path",
  "Error: Hook timed out in 10000ms.",
  "",
  " Test Files  3 failed | 571 passed (574)",
  'error: script "test:coverage" exited with code 1',
].join("\n");

describe("cleanLog", () => {
  it("strips colours, cursor codes and Buildkite timestamps, and applies carriage returns", () => {
    const clean = cleanLog(`${ts(1)}\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 100%\n\x1b[?25hdone _bk;t=17\x07`);
    expect(clean).toBe("ok\nprogress 100%\ndone ");
  });
});

describe("digestLog", () => {
  it("names the failing root vitest test, its assertion, its command and its exit", () => {
    const digest = digestLog(cleanLog(ROOT_ASSERTION));
    expect(digest.command).toBe("bun x vitest run --coverage");
    expect(digest.files).toEqual(["src/app/api/v1/mobile-api-error-conformance.test.ts"]);
    expect(digest.failures).toEqual([
      {
        title:
          "FAIL src/app/api/v1/mobile-api-error-conformance.test.ts > mobile API Error conformance > never grows the allowlist against the base branch",
        detail: [expect.stringContaining("AssertionError: MOBILE_ENVELOPE_CALLERS may only shrink")],
      },
    ]);
    expect(digest.timeoutsOnly).toBe(false);
    // A lint run with warnings only is not the failure, and says nothing here.
    expect(digest.summary.some((line) => line.includes("problems"))).toBe(false);
    expect(digest.summary).toContain("Test Files  1 failed | 574 passed (575)");
    expect(digest.exit).toEqual([
      'error: script "test:coverage" exited with code 1',
      "🚨 Error: The command exited with status 1",
    ]);
    expect(digest.tail).toEqual([]);
  });

  it("marks a run whose only failures are timeouts", () => {
    const digest = digestLog(TIMEOUT);
    expect(digest.timeoutsOnly).toBe(true);
    expect(digest.failures[0]!.detail[0]).toBe("Error: Test timed out in 5000ms.");
  });

  it("counts a vitest hook timeout as a timeout, as build 2626's were", () => {
    const digest = digestLog(HOOK_TIMEOUTS);
    expect(digest.failures).toHaveLength(3);
    expect(digest.timeoutsOnly).toBe(true);
    expect(digest.files).toEqual([
      "src/server/imports/library-merge.integration.test.ts",
      "src/server/queries/scoreAggregate.deletion.integration.test.ts",
      "src/server/queries/scoreAggregate.read-path.integration.test.ts",
    ]);
  });

  it("reads jest blocks from the mobile suite", () => {
    const digest = digestLog(
      [
        "$ jest",
        "FAIL __tests__/home-feed-sections.test.tsx (5.1 s)",
        "  ● HomeFeed › renders the sections in order",
        "",
        "    expect(received).toEqual(expected) // deep equality",
        "",
        "      12 |   expect(a).toEqual(b);",
        "Test Suites: 1 failed, 211 passed, 212 total",
        "Tests:       1 failed, 2000 passed, 2001 total",
      ].join("\n"),
    );
    expect(digest.command).toBe("jest");
    expect(digest.failures).toEqual([
      {
        title: "● HomeFeed › renders the sections in order",
        detail: ["expect(received).toEqual(expected) // deep equality"],
        file: "__tests__/home-feed-sections.test.tsx",
      },
    ]);
    expect(digest.files).toEqual(["__tests__/home-feed-sections.test.tsx"]);
    expect(digest.summary).toContain("Test Suites: 1 failed, 211 passed, 212 total");
  });

  it("reads playwright failures", () => {
    const digest = digestLog(
      [
        "$ playwright test",
        "  ✘  3 [chromium] › e2e/onboarding.spec.ts:12:5 › signs up (30.0s)",
        "  1) [chromium] › e2e/onboarding.spec.ts:12:5 › signs up ────",
        "",
        "    Test timeout of 30000ms exceeded.",
        "",
        "  1 failed",
      ].join("\n"),
    );
    expect(digest.failures[0]!.title).toBe("[chromium] › e2e/onboarding.spec.ts:12:5 › signs up ────");
    expect(digest.timeoutsOnly).toBe(true);
    expect(digest.summary).toContain("1 failed");
  });

  it("reads vitest run-level errors, like a startup failure in the E2E job", () => {
    const digest = digestLog(
      [
        "$ bun x vitest run --config vitest.security.config.ts",
        "⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯",
        "Error: Supabase Auth was not stable within 120000ms after 239 attempts",
        "    at Object.waitForSupabaseAuth (scripts/wait-for-supabase-auth.ts:102:9)",
        'error: script "test:security" exited with code 1',
      ].join("\n"),
    );
    expect(digest.command).toBe("bun x vitest run --config vitest.security.config.ts");
    expect(digest.failures).toEqual([
      { title: "vitest: Startup Error", detail: ["Error: Supabase Auth was not stable within 120000ms after 239 attempts"] },
    ]);
    expect(digest.timeoutsOnly).toBe(false);
  });

  it("reads type errors and lint errors", () => {
    const digest = digestLog(
      [
        "$ tsc --noEmit",
        "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "$ eslint .",
        "/data/buildkite/builds/x/loggd/src/b.ts",
        "  4:1  error  'x' is defined but never used  no-unused-vars",
        "✖ 1 problem (1 error, 0 warnings)",
      ].join("\n"),
    );
    expect(digest.command).toBe("tsc --noEmit");
    expect(digest.failures.map((failure) => failure.title)).toEqual([
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "/data/buildkite/builds/x/loggd/src/b.ts: 4:1  error  'x' is defined but never used  no-unused-vars",
    ]);
    expect(digest.summary).toContain("✖ 1 problem (1 error, 0 warnings)");
  });

  it("attaches each jest failure to the file jest printed above it (#237)", () => {
    const digest = digestLog(
      [
        "$ bunx jest --ci",
        " FAIL  app/components/__tests__/activity.test.tsx (8.3 s)",
        "  ● Activity tab show grouping › groups by day",
        "    expect(received).toBe(expected)",
        "",
        " FAIL  app/components/__tests__/diary.test.tsx",
        "  ● DiaryTab media mode › applies a TV-only genre",
        "    Unable to find an element with text: Drama",
        "",
        "Tests:       2 failed, 418 passed, 420 total",
      ].join("\n"),
    );
    expect(digest.failures.map((failure) => [failure.title, failure.file])).toEqual([
      ["● Activity tab show grouping › groups by day", "app/components/__tests__/activity.test.tsx"],
      ["● DiaryTab media mode › applies a TV-only genre", "app/components/__tests__/diary.test.tsx"],
    ]);
    // Both files are the digest's own failing files, so `failing files:` names
    // them even though only the per-file summary lines mentioned them before.
    expect(digest.files).toEqual(["app/components/__tests__/activity.test.tsx", "app/components/__tests__/diary.test.tsx"]);
    // The per-file header stays in the summary: it is the runner's own total.
    expect(digest.summary).toContain("FAIL  app/components/__tests__/activity.test.tsx (8.3 s)");
    expect(identify(digest.failures[1]!.title, digest.files, digest.failures[1]!.file)).toEqual({
      testId: "app/components/__tests__/diary.test.tsx > DiaryTab media mode > applies a TV-only genre",
      file: "app/components/__tests__/diary.test.tsx",
    });
  });

  it("keeps both files when two of them share a describe title (#237)", () => {
    // The collision the ticket names, in ONE job. Deduped on the title alone,
    // the second file's block was dropped as a repeat — and with the file
    // attached that would be worse than a drop: the surviving row would name
    // `a.test.tsx` for a failure that happened in `b.test.tsx`, and
    // `greenNextWithoutTouching` would test the wrong path.
    const digest = digestLog(
      [
        " FAIL  app/a.test.tsx",
        "  ● Shared suite › renders",
        "    Error: nope",
        "",
        " FAIL  app/b.test.tsx",
        "  ● Shared suite › renders",
        "    Error: nope",
        "",
      ].join("\n"),
    );
    expect(digest.failures.map((failure) => failure.file)).toEqual(["app/a.test.tsx", "app/b.test.tsx"]);
    // Still one row per file, not per repeat: a file's own block appearing
    // twice (jest's summary re-prints it) is the dedupe's real job.
    const twice = digestLog([" FAIL  app/a.test.tsx", "  ● s › t", "", " FAIL  app/a.test.tsx", "  ● s › t", ""].join("\n"));
    expect(twice.failures).toHaveLength(1);
  });

  it("never attaches a header's file to a failure that is not a jest block", () => {
    const digest = digestLog(
      [
        " FAIL  src/a.test.ts (2.0 s)",
        "  ● a › b",
        "    Error: nope",
        "",
        "⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯",
        "Error: Supabase Auth was not stable",
        "src/b.ts(3,7): error TS2322: bad",
      ].join("\n"),
    );
    expect(digest.failures.map((failure) => failure.file)).toEqual(["src/a.test.ts", undefined, undefined]);
  });

  it("falls back to the last lines before the job ended when nothing matches", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const digest = digestLog([...lines, "user command error: exit status 1", "~~~ Running repository pre-exit hook", "hook noise"].join("\n"));
    expect(digest.failures).toEqual([]);
    expect(digest.tail).toHaveLength(LIMITS.tail);
    expect(digest.tail.at(-1)).toBe("line 59");
  });

  it("stays bounded on a wall of failures and very long lines", () => {
    const wall = Array.from({ length: 50 }, (_, i) => [` FAIL  src/t${i}.test.ts > s > t${i}`, `Error: ${"x".repeat(1000)}`, ""].join("\n"));
    const digest = digestLog(wall.join("\n"));
    expect(digest.failures).toHaveLength(50);
    expect(digest.failures.every((failure) => failure.detail.every((line) => line.length <= LIMITS.width))).toBe(true);
  });
});

describe("resolution helpers", () => {
  it("parses build numbers and build or job URLs", () => {
    expect(parseBuildRef("2425")).toEqual({ org: null, pipeline: null, number: 2425 });
    expect(parseBuildRef("#2425")).toEqual({ org: null, pipeline: null, number: 2425 });
    expect(parseBuildRef("https://buildkite.com/felipe-aros/loggd/builds/2377#01a0e6b3")).toEqual({
      org: "felipe-aros",
      pipeline: "loggd",
      number: 2377,
    });
    expect(parseBuildRef("main")).toBeNull();
  });

  it("takes the pipeline from exactly one buildkite required check", () => {
    expect(pipelineFromChecks(["buildkite/loggd", "Vercel"])).toBe("loggd");
    expect(pipelineFromChecks(["Vercel"])).toBeNull();
    expect(pipelineFromChecks(["buildkite/a", "buildkite/b"])).toBeNull();
  });

  it("finds the build URL a PR's buildkite check links to", () => {
    const rollup = [
      { __typename: "CheckRun", name: "Vercel", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://vercel.com/x" },
      {
        __typename: "StatusContext",
        context: "buildkite/loggd",
        state: "FAILURE",
        targetUrl: "https://buildkite.com/felipe-aros/loggd/builds/2425",
      },
    ];
    expect(buildUrlFromRollup(rollup, "loggd")).toBe("https://buildkite.com/felipe-aros/loggd/builds/2425");
    expect(buildUrlFromRollup(rollup, null)).toBe("https://buildkite.com/felipe-aros/loggd/builds/2425");
    expect(buildUrlFromRollup([], "loggd")).toBeNull();
  });

  it("counts only script jobs that failed for real", () => {
    const build: Build = {
      number: 1,
      state: "failed",
      jobs: [
        { id: "a", type: "script", name: "quality", state: "failed" },
        { id: "b", type: "script", name: "smoke", state: "broken" },
        { id: "c", type: "script", name: "soft", state: "failed", soft_failed: true },
        { id: "d", type: "script", name: "old", state: "failed", retried: true },
        { id: "e", type: "waiter", name: null, state: "failed" },
        { id: "f", type: "script", name: "e2e", state: "timed_out" },
      ],
    };
    expect(failedJobs(build).map((job) => job.id)).toEqual(["a", "f"]);
  });

  it("reads only the dedicated RALPH_BUILDKITE_READ_TOKEN, never the withheld BUILDKITE_API_TOKEN", () => {
    expect(tokenFrom({ BUILDKITE_API_TOKEN: "a", RALPH_BUILDKITE_READ_TOKEN: "b" })).toBe("b");
    expect(tokenFrom({ BUILDKITE_API_TOKEN: "a" })).toBeNull();
    expect(tokenFrom({ RALPH_BUILDKITE_READ_TOKEN: " " })).toBeNull();
  });

  it("reads the retry token from its own variable, and never from the read token's", () => {
    expect(retryTokenFrom({ RALPH_BUILDKITE_RETRY_TOKEN: "w" })).toBe("w");
    expect(retryTokenFrom({ RALPH_BUILDKITE_READ_TOKEN: "r" })).toBeNull();
    expect(retryTokenFrom({ RALPH_BUILDKITE_RETRY_TOKEN: " " })).toBeNull();
    // And the other direction: the read path must not pick up the write token.
    expect(tokenFrom({ RALPH_BUILDKITE_RETRY_TOKEN: "w" })).toBeNull();
  });

  it("treats every non-read scope as a write scope", () => {
    expect(writeScopes(["read_builds", "read_build_logs"])).toEqual([]);
    expect(writeScopes(["read_builds", "write_builds", "graphql"])).toEqual(["write_builds", "graphql"]);
  });

  it("counts a branch's finished builds and its red ones, ignoring running ones", () => {
    const builds = [
      { number: 5, state: "running" },
      { number: 4, state: "failed" },
      { number: 3, state: "failed" },
      { number: 2, state: "passed" },
      { number: 1, state: "canceled" },
    ] as Build[];
    expect(branchRecord(builds)).toEqual({ finished: 4, red: 3 });
  });

  it("picks other branches' red builds, newest first and bounded", () => {
    const self = { number: 2626, state: "failed", branch: "rulo/1593" } as Build;
    const recent = [
      { number: 2627, state: "running", branch: "ralph/1630" },
      self,
      { number: 2625, state: "failed", branch: "remo/1809" },
      { number: 2624, state: "passed", branch: "main" },
      { number: 2622, state: "failed", branch: "rulo/1593" },
      { number: 2621, state: "failed", branch: "main" },
      { number: 2620, state: "failed", branch: "rafa/1700" },
    ] as Build[];
    expect(otherRedBuilds(recent, self).map((build) => build.number)).toEqual([2625, 2621, 2620]);
    expect(otherRedBuilds(recent, self, 1).map((build) => build.number)).toEqual([2625]);
  });

  it("names each failing file that another branch's red build shares", () => {
    const others = [
      { number: 2625, branch: "remo/1809", files: ["src/a.test.ts", "src/c.test.ts"] },
      { number: 2621, branch: "main", files: ["src/a.test.ts"] },
    ];
    expect(crossReference(["src/a.test.ts", "src/b.test.ts"], others)).toEqual([
      {
        file: "src/a.test.ts",
        builds: [
          { number: 2625, branch: "remo/1809" },
          { number: 2621, branch: "main" },
        ],
      },
    ]);
  });

  it("parses its arguments", () => {
    expect(parseArgs(["2425", "--full", "/tmp/x"])).toMatchObject({ build: "2425", full: "/tmp/x" });
    expect(parseArgs(["--pr", "#1710"])).toMatchObject({ pr: "1710" });
    expect(parseArgs(["--branch", "mergify/merge-queue/abc", "--json"])).toMatchObject({
      branch: "mergify/merge-queue/abc",
      json: true,
    });
    expect(parseArgs(["--check-token"])).toMatchObject({ checkToken: true, checkRetryToken: false });
    expect(parseArgs(["--check-retry-token"])).toMatchObject({ checkRetryToken: true, checkToken: false });
    expect(parseArgs(["--check-retry-token", "2425"])).toMatch(/--check-retry-token takes no build/);
    expect(parseArgs(["--check-token", "--check-retry-token"])).toMatch(/name one of --check-token and --check-retry-token/);
    expect(parseArgs(["2425"])).toMatchObject({ history: true });
    expect(parseArgs(["2425", "--no-history"])).toMatchObject({ history: false });
    expect(parseArgs([])).toMatch(/name one build/);
    expect(parseArgs(["1", "2"])).toMatch(/one build at a time/);
    expect(parseArgs(["--pr", "abc"])).toMatch(/PR number/);
    expect(parseArgs(["--full"])).toMatch(/needs a value/);
    expect(parseArgs(["3205", "--job", "e2e", "--grep", "step-timing"])).toMatchObject({
      build: "3205",
      job: "e2e",
      grep: /step-timing/,
    });
    expect(parseArgs(["3205", "--grep", "x"])).toMatch(/name it with --job/);
    expect(parseArgs(["3205", "--job", "e2e", "--json"])).toMatch(/--json is for the digest/);
    expect(parseArgs(["3205", "--job", "e2e", "--grep", "("])).toMatch(/not a valid regex/);
  });
});

describe("main", () => {
  const TOKEN = "bkua_0123456789abcdef0123456789abcdef01234567";
  /**
   * Every `main` call here passes RALPH_PROJECT. Without it `readKnown`
   * resolves `<git-common-dir>/ralph/ci-health.json` from `process.cwd()` —
   * which in a test run is the OPERATOR'S LIVE STORE, so a doctor running on
   * this repo would start changing these digests. `test-ralph-env.setup.ts`
   * deletes the variable on purpose, so each suite that needs one says so.
   */
  const EMPTY_PROJECT = mkdtempSync(join(tmpdir(), "bk-no-store-"));
  afterAll(() => rmSync(EMPTY_PROJECT, { recursive: true, force: true }));
  let out: string[] = [];
  let err: string[] = [];

  const capture = (): void => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
  };
  afterEach(() => vi.restoreAllMocks());

  const build: Build = {
    number: 2425,
    state: "failed",
    branch: "rulo/1537-use-feed",
    commit: "270582398eecab69a210a57f08f8f16c90dc94a3",
    web_url: "https://buildkite.com/felipe-aros/loggd/builds/2425",
    pull_request: { id: "1710" },
    jobs: [
      { id: "up", type: "script", name: ":pipeline: Upload", state: "passed", exit_status: 0 },
      {
        id: "q",
        type: "script",
        name: ":eslint: Lint, Type Check, Unit Tests & Build",
        state: "failed",
        step_key: "quality",
        exit_status: 1,
      },
    ],
  };

  /** A Buildkite that answers these paths, and records what it was asked with. */
  const fake = (routes: Record<string, unknown>, seen: RequestInit[] = []): Fetcher =>
    async (url, init) => {
      seen.push(init);
      const path = url.replace("https://api.buildkite.com/v2", "");
      if (!(path in routes)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      const body = routes[path];
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    };

  it("says there is no token, in words, instead of crashing", async () => {
    capture();
    expect(await main(["2425"], { BUILDKITE_API_TOKEN: "withheld-operator-token" })).toBe(1);
    expect(err.join("\n")).toContain("no Buildkite token");
  });

  it("digests a failed build end to end, writes the full log, and never prints the token", async () => {
    capture();
    const dir = mkdtempSync(join(tmpdir(), "bk-log-"));
    const seen: RequestInit[] = [];
    const routes = {
      "/organizations/felipe-aros/pipelines/loggd/builds/2425": build,
      "/organizations/felipe-aros/pipelines/loggd/builds/2425/jobs/q/log": ROOT_ASSERTION,
    };
    const code = await main(
      ["https://buildkite.com/felipe-aros/loggd/builds/2425", "--full", dir],
      { RALPH_BUILDKITE_READ_TOKEN: TOKEN, RALPH_PROJECT: EMPTY_PROJECT },
      fake(routes, seen),
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Build #2425 failed — rulo/1537-use-feed @ 270582398e (PR #1710)");
    expect(text).toContain("1 failed job (of 2)");
    expect(text).toContain("== :eslint: Lint, Type Check, Unit Tests & Build [quality] — failed, exit 1");
    expect(text).toContain("command: $ bun x vitest run --coverage");
    expect(text).toContain("- FAIL src/app/api/v1/mobile-api-error-conformance.test.ts > mobile API Error conformance");
    expect(text).toContain("kind: error, not a timeout");
    expect(text).not.toContain(TOKEN);
    expect(err.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(join(dir, "bk-2425-quality.log"), "utf8")).toContain("AssertionError: MOBILE_ENVELOPE_CALLERS");
    // The history could not be read here; it says so and the digest stands.
    expect(text).toContain("partial: Buildkite 404");
    // The log is asked for as text, with the token only in the header.
    expect(seen[1]!.headers).toMatchObject({ Accept: "text/plain", Authorization: `Bearer ${TOKEN}` });
  });

  it("reports this branch's reds and the failing files other branches share", async () => {
    capture();
    const base = "/organizations/felipe-aros/pipelines/loggd/builds";
    const quality = (id: string, state = "failed") => ({ id, type: "script", name: "quality", state, step_key: "quality", exit_status: 1 });
    const b2626: Build = {
      number: 2626,
      state: "failed",
      branch: "rulo/1593-list-surfaces-stale",
      web_url: "https://buildkite.com/felipe-aros/loggd/builds/2626",
      jobs: [quality("q")],
    };
    const routes = {
      [`${base}/2626`]: b2626,
      [`${base}/2626/jobs/q/log`]: HOOK_TIMEOUTS,
      [`${base}?branch=rulo%2F1593-list-surfaces-stale&per_page=20`]: [
        b2626,
        { number: 2622, state: "failed", branch: b2626.branch },
        { number: 2620, state: "failed", branch: b2626.branch },
        { number: 2618, state: "passed", branch: b2626.branch },
      ],
      [`${base}?per_page=30`]: [
        b2626,
        { number: 2625, state: "failed", branch: "remo/1809-x", jobs: [quality("r")] },
        { number: 2624, state: "passed", branch: "main", jobs: [quality("m", "passed")] },
        { number: 2621, state: "failed", branch: "main", jobs: [quality("n")] },
      ],
      [`${base}/2625/jobs/r/log`]: TIMEOUT.replace(
        "src/app/api/v1/media-mode-conformance.test.ts > Media Mode",
        "src/server/imports/library-merge.integration.test.ts > Library Merge",
      ),
      [`${base}/2621/jobs/n/log`]: HOOK_TIMEOUTS,
    };
    const code = await main([b2626.web_url!], { RALPH_BUILDKITE_READ_TOKEN: TOKEN, RALPH_PROJECT: EMPTY_PROJECT }, fake(routes));
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("kind: timeout only");
    expect(text).toContain("this branch: 3 red of its last 4 finished builds");
    expect(text).toContain(
      "also red on other branches: src/server/imports/library-merge.integration.test.ts (#2625 remo/1809-x, #2621 main) — main included",
    );
    expect(text).toContain("also red on other branches: src/server/queries/scoreAggregate.deletion.integration.test.ts (#2621 main)");
    expect(text).not.toContain("partial:");

    capture();
    expect(
      await main([b2626.web_url!, "--no-history"], { RALPH_BUILDKITE_READ_TOKEN: TOKEN, RALPH_PROJECT: EMPTY_PROJECT }, fake(routes)),
    ).toBe(0);
    expect(out.join("\n")).not.toContain("history:");
  });

  it("resolves a bare build number from the project's required check and the org its builds are under", async () => {
    capture();
    const routes = {
      // A read_builds-only token cannot list organizations; its builds say which.
      "/builds?per_page=30": [
        { number: 9, state: "passed", web_url: "https://buildkite.com/other-org/other/builds/9" },
        { number: 2424, state: "passed", web_url: "https://buildkite.com/felipe-aros/loggd/builds/2424" },
      ],
      "/organizations/felipe-aros/pipelines/loggd/builds/2425": { ...build, jobs: build.jobs!.slice(0, 1), state: "passed" },
    };
    const code = await main(["2425", "--json"], { RALPH_BUILDKITE_READ_TOKEN: TOKEN, RALPH_REQUIRED_CHECKS: "buildkite/loggd\nVercel", RALPH_PROJECT_REPO: "o/r", RALPH_PROJECT: EMPTY_PROJECT }, fake(routes));
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      build: { org: "felipe-aros", pipeline: "loggd", number: 2425, state: "passed" },
      failed: [],
    });
  });

  it("reports an API refusal without the token", async () => {
    capture();
    const code = await main(
      ["https://buildkite.com/felipe-aros/loggd/builds/9"],
      { RALPH_BUILDKITE_READ_TOKEN: TOKEN, RALPH_PROJECT: EMPTY_PROJECT },
      async () => new Response(JSON.stringify({ message: "Authentication required" }), { status: 401 }),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Buildkite 401");
    expect(err.join("\n")).not.toContain(TOKEN);
  });

  it("passes a read-only token and refuses one with a write scope", async () => {
    capture();
    expect(
      await main(["--check-token"], { RALPH_BUILDKITE_READ_TOKEN: TOKEN }, fake({ "/access-token": { scopes: ["read_builds", "read_build_logs"] } })),
    ).toBe(0);
    expect(out.join("\n")).toContain("read-only (read_builds, read_build_logs) — missing read_artifacts");
    expect(
      await main(
        ["--check-token"],
        { RALPH_BUILDKITE_READ_TOKEN: TOKEN },
        fake({ "/access-token": { scopes: ["read_builds", "read_build_logs", "read_artifacts"] } }),
      ),
    ).toBe(0);
    expect(out.at(-1)).not.toContain("missing");
    expect(
      await main(["--check-token"], { RALPH_BUILDKITE_READ_TOKEN: TOKEN }, fake({ "/access-token": { scopes: ["read_builds", "write_builds"] } })),
    ).toBe(3);
    expect(err.join("\n")).toContain("not read-only (write_builds)");
  });
  describe("Buildkite.put — the harness's one HTTP write", () => {
    const RETRY = "bkua_fedcba9876543210fedcba9876543210fedcba98";

    it("is a PUT with no body, carrying the token it was built with", async () => {
      const seen: RequestInit[] = [];
      const urls: string[] = [];
      const fetcher: Fetcher = async (url, init) => {
        urls.push(url);
        seen.push(init);
        return new Response("", { status: 200 });
      };
      await new Buildkite(RETRY, fetcher).put("/organizations/o/pipelines/p/builds/10/jobs/j/retry");
      expect(urls).toEqual(["https://api.buildkite.com/v2/organizations/o/pipelines/p/builds/10/jobs/j/retry"]);
      expect(seen[0]!.method).toBe("PUT");
      // No body: Buildkite's retry endpoint takes none, and a body would be
      // the one place a caller could smuggle something into the write.
      expect(seen[0]!.body ?? null).toBeNull();
      expect((seen[0]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${RETRY}`);
    });

    it("turns a refusal into a HelperError the gate can report, and says when the scope is the problem", async () => {
      const refuse = (status: number): Fetcher => async () =>
        new Response(JSON.stringify({ message: "Forbidden" }), { status });
      for (const status of [401, 403]) {
        const error = await new Buildkite(RETRY, refuse(status)).put("/x/retry").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HelperError);
        expect((error as HelperError).code).toBe(2);
        expect((error as HelperError).message).toContain(`Buildkite ${status} on PUT /x/retry`);
        expect((error as HelperError).message).toContain("not write_builds");
        expect((error as HelperError).message).not.toContain(RETRY);
      }
      // A 500 is not a scope problem and must not be reported as one.
      const server = await new Buildkite(RETRY, refuse(500)).put("/x/retry").catch((e: unknown) => e);
      expect((server as HelperError).message).toContain("Buildkite 500 on PUT /x/retry");
      expect((server as HelperError).message).not.toContain("write_builds");
    });

    it("leaves a GET's own message unchanged: a read says neither PUT nor write_builds", async () => {
      // `request` is shared, and the read path's wording is what every
      // existing caller's output is asserted against.
      const error = await new Buildkite(TOKEN, async () =>
        new Response(JSON.stringify({ message: "Authentication required" }), { status: 401 }),
      )
        .json("/builds")
        .catch((e: unknown) => e);
      expect((error as HelperError).message).toBe(
        "Buildkite 401 on /builds: Authentication required (the token is missing, wrong or revoked)",
      );
    });
  });

  it("resolveOrg needs a READING token: a write-only one cannot answer either of its reads", async () => {
    // Why `ci-doctor/gate.ts`'s `retryDep` requires the read token as well as
    // the retry token. Both of `resolveOrg`'s probes are reads, both swallow
    // their error, and a token whose scope list is exactly `write_builds`
    // 401s on each — so asking it leaves no organization and a throw.
    const refusesReads: Fetcher = async () =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    const error = await resolveOrg(new Buildkite("bkua_write_only", refusesReads), {}, "loggd").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HelperError);
    expect((error as HelperError).message).toContain("which Buildkite organization?");
    // And with the org named outright it never reads at all, which is the one
    // configuration in which a write-only token would have been enough.
    const seen: string[] = [];
    const counted: Fetcher = async (url) => {
      seen.push(url);
      return new Response("[]", { status: 200 });
    };
    expect(await resolveOrg(new Buildkite("bkua_write_only", counted), { RALPH_BUILDKITE_ORG: "loggd" }, "loggd")).toBe(
      "loggd",
    );
    expect(seen).toEqual([]);
  });

  describe("--job — a job's log whatever its state", () => {
    // #1898: the per-step timings a green e2e job printed were unreachable,
    // because the digest only opens failed jobs.
    const green: Build = {
      number: 3205,
      state: "passed",
      branch: "rafa/1898-e2e-journey-budgets",
      web_url: "https://buildkite.com/felipe-aros/loggd/builds/3205",
      jobs: [
        { id: "q", type: "script", name: ":eslint: Lint", state: "passed", step_key: "quality" },
        { id: "old", type: "script", name: ":playwright: E2E", state: "failed", step_key: "e2e", retried: true },
        { id: "e", type: "script", name: ":playwright: E2E", state: "passed", step_key: "e2e" },
      ],
    };
    const LOG = [
      `${ts(1)}Running 777 tests using 8 workers\r\n`,
      `${ts(2)}[step-timing] feed-controls.spec.ts:16 … total 4420ms, budget 90000ms\r\n`,
      `${ts(3)}  768 passed (3.6m)\r\n`,
    ].join("");
    const routes = {
      "/organizations/felipe-aros/pipelines/loggd/builds/3205": green,
      "/organizations/felipe-aros/pipelines/loggd/builds/3205/jobs/e/log": LOG,
    };
    const env = (): NodeJS.ProcessEnv => ({ RALPH_BUILDKITE_READ_TOKEN: TOKEN, RALPH_PROJECT: EMPTY_PROJECT });

    it("prints a PASSING job's matching lines, from the retry not the superseded attempt", async () => {
      capture();
      const code = await main([green.web_url!, "--job", "e2e", "--grep", "step-timing"], env(), fake(routes));
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("Build #3205 passed — rafa/1898-e2e-journey-budgets");
      expect(text).toContain("== :playwright: E2E [e2e] — passed");
      expect(text).toContain("2: [step-timing] feed-controls.spec.ts:16 … total 4420ms, budget 90000ms");
      expect(text).not.toContain("768 passed");
      expect(text).not.toContain(TOKEN);
    });

    it("prints the whole cleaned log without --grep, and saves it with --full", async () => {
      capture();
      const dir = mkdtempSync(join(tmpdir(), "bk-job-"));
      expect(await main([green.web_url!, "--job", "e2e", "--full", dir], env(), fake(routes))).toBe(0);
      expect(out.join("\n")).toContain("768 passed (3.6m)");
      expect(readFileSync(join(dir, "bk-3205-e2e.log"), "utf8")).toContain("Running 777 tests using 8 workers");
      rmSync(dir, { recursive: true, force: true });
    });

    it("names the build's jobs when the key matches none", async () => {
      capture();
      expect(await main([green.web_url!, "--job", "nope"], env(), fake(routes))).toBe(1);
      expect(err.join("\n")).toContain(
        'no script job of build #3205 is named nope; its jobs: quality ":eslint: Lint" (passed), e2e ":playwright: E2E" (passed)',
      );
    });

    it("reports a job whose log cannot be read, and still prints its sibling shards", async () => {
      capture();
      const sharded: Build = {
        ...green,
        jobs: [
          { id: "s1", type: "script", name: ":playwright: E2E 1/2", state: "waiting", step_key: "e2e" },
          { id: "s2", type: "script", name: ":playwright: E2E 2/2", state: "passed", step_key: "e2e" },
          { id: "s3", type: "script", name: ":playwright: E2E 3/3", state: "passed", step_key: "e2e" },
        ],
      };
      const dir = mkdtempSync(join(tmpdir(), "bk-shards-"));
      const code = await main(
        [green.web_url!, "--job", "e2e", "--full", dir],
        env(),
        fake({
          "/organizations/felipe-aros/pipelines/loggd/builds/3205": sharded,
          "/organizations/felipe-aros/pipelines/loggd/builds/3205/jobs/s2/log": "shard two\n",
          "/organizations/felipe-aros/pipelines/loggd/builds/3205/jobs/s3/log": "shard three\n",
        }),
      );
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toMatch(/== :playwright: E2E 1\/2 \[e2e\] — waiting\n {3}log unreadable: .*404/);
      // Shards share a step key: each keeps its own file instead of overwriting the last.
      expect(readFileSync(join(dir, "bk-3205-e2e-s2.log"), "utf8")).toContain("shard two");
      expect(readFileSync(join(dir, "bk-3205-e2e-s3.log"), "utf8")).toContain("shard three");
      rmSync(dir, { recursive: true, force: true });
    });

    it("points a passing build's digest at --job", async () => {
      capture();
      expect(await main([green.web_url!, "--no-history"], env(), fake(routes))).toBe(0);
      expect(out.join("\n")).toContain("a passing job's output: --job <step-key>");
    });
  });

  describe("--check-retry-token", () => {
    const RETRY = "bkua_fedcba9876543210fedcba9876543210fedcba98";
    const run = (scopes: string[]) =>
      main(["--check-retry-token"], { RALPH_BUILDKITE_RETRY_TOKEN: RETRY }, fake({ "/access-token": { scopes } }));

    it("accepts a token whose only scope is write_builds", async () => {
      capture();
      expect(await run(["write_builds"])).toBe(0);
      expect(out.join("\n")).toContain("retry token ok, write_builds only");
      expect(out.join("\n")).not.toContain(RETRY);
    });

    it("refuses anything wider or narrower, and never prints the token", async () => {
      for (const scopes of [["write_builds", "read_builds"], ["write_builds", "write_pipelines"], ["read_builds"], []]) {
        capture();
        expect(await run(scopes)).toBe(3);
        expect(err.join("\n")).toContain("not exactly write_builds");
        expect(err.join("\n")).not.toContain(RETRY);
      }
    });

    it("names its own variable when the token is absent, and does not fall back to the read token", async () => {
      capture();
      expect(await main(["--check-retry-token"], { RALPH_BUILDKITE_READ_TOKEN: TOKEN })).toBe(1);
      expect(err.join("\n")).toContain("RALPH_BUILDKITE_RETRY_TOKEN is not set");
    });

    it("leaves --check-token reading the read token alone", async () => {
      capture();
      // A host with only the retry token cannot answer `--check-token` at all:
      // the two checks must not share a credential in either direction.
      expect(await main(["--check-token"], { RALPH_BUILDKITE_RETRY_TOKEN: RETRY })).toBe(1);
      expect(err.join("\n")).toContain("RALPH_BUILDKITE_READ_TOKEN is not set");
    });
  });

  /* ----------------------------------------------------------------------
   * The ci-doctor's `known:` lines (#154). The store is a local file, so
   * every test here asserts the request count is untouched.
   * ------------------------------------------------------------------- */

  describe("known: lines from the ci-health store", () => {
    const TEST_ID =
      "src/app/api/v1/mobile-api-error-conformance.test.ts > mobile API Error conformance > never grows the allowlist against the base branch";
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /**
     * A real git repo outside this checkout, so the store lands where
     * production puts it — `<git-common-dir>/ralph/ci-health.json` — rather
     * than at `storePathFromGit`'s non-repo fallback, which is a path the
     * doctor never writes. Outside the checkout because pointing
     * RALPH_PROJECT inside it would resolve the operator's LIVE store.
     */
    const projectWithStore = (store: CiHealthStore | string | null): string => {
      const dir = mkdtempSync(join(tmpdir(), "bk-known-"));
      dirs.push(dir);
      execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
      if (store !== null) {
        const path = storePathFromGit(dir);
        expect(path).toBe(join(dir, ".git", "ralph", "ci-health.json"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, typeof store === "string" ? store : JSON.stringify(store));
      }
      return dir;
    };

    const kase = (over: Partial<Case> & { kind: CaseKind; state: CaseState }): Case => ({
      evidence: [],
      cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
      issue: null,
      pr: null,
      fixAttempts: 0,
      unparks: {},
      ...over,
    });

    const routes = {
      "/organizations/felipe-aros/pipelines/loggd/builds/2425": build,
      "/organizations/felipe-aros/pipelines/loggd/builds/2425/jobs/q/log": ROOT_ASSERTION,
    };
    const env = (project: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      RALPH_BUILDKITE_READ_TOKEN: TOKEN,
      RALPH_PROJECT: project,
      RALPH_PROJECT_REPO: "felipearos/loggd",
      ...extra,
    });

    /**
     * One `main` run over the fixed routes, returning its text and every URL
     * it asked for. The URL LIST, not just its length: a relative count would
     * still pass if reading the store fetched something, since both arms of
     * the comparison run the same new code.
     */
    const digest = async (project: string, argv: string[] = []): Promise<{ text: string; urls: string[]; code: number }> => {
      capture();
      const urls: string[] = [];
      const counting: Fetcher = async (url, init) => {
        urls.push(url);
        return fake(routes)(url, init);
      };
      const code = await main(["https://buildkite.com/felipe-aros/loggd/builds/2425", ...argv], env(project), counting);
      return { text: out.join("\n"), urls, code };
    };

    it("prints the doctor's verdict for a confirmed flake, and asks Buildkite for nothing more", async () => {
      const silent = await digest(projectWithStore(null));
      const known = await digest(
        projectWithStore({
          ...emptyStore(),
          cases: {
            [`flake:${TEST_ID}`]: kase({
              kind: "flake",
              state: "confirmed",
              evidence: [{ build: 2400, branch: "main", commit: "abc", kind: "timeout", line: "timed out" }],
              cost72h: { redBuilds: 9, mainReds: 2, dequeues: 0 },
              issue: 1901,
              pr: 1910,
            }),
          },
        }),
      );
      expect(known.text).toContain("known: loggd #1901 — confirmed flake (timeout, 9 reds/72h), fix PR #1910 open");
      // AC 1: the store is a file. The request list is identical, and it is
      // exactly the two calls the digest itself needs — the build and its log.
      expect(known.urls).toEqual(silent.urls);
      expect(known.urls).toEqual([
        "https://api.buildkite.com/v2/organizations/felipe-aros/pipelines/loggd/builds/2425",
        "https://api.buildkite.com/v2/organizations/felipe-aros/pipelines/loggd/builds/2425/jobs/q/log",
        `https://api.buildkite.com/v2/organizations/felipe-aros/pipelines/loggd/builds?branch=rulo%2F1537-use-feed&per_page=${HISTORY.branchBuilds}`,
        `https://api.buildkite.com/v2/organizations/felipe-aros/pipelines/loggd/builds?per_page=${HISTORY.recentBuilds}`,
      ]);
      expect(known.code).toBe(0);
    });

    it("names the build main went red on for a regression case", async () => {
      const { text } = await digest(
        projectWithStore({
          ...emptyStore(),
          main: { state: "red", since: "2026-10-01T00:00:00Z", build: 2701 },
          cases: {
            [`regression:${TEST_ID}`]: kase({
              kind: "regression",
              state: "confirmed",
              evidence: [{ build: 2701, branch: "main", commit: "abc", kind: "assertion", line: "x" }],
              cost72h: { redBuilds: 3, mainReds: 3, dequeues: 0 },
            }),
          },
        }),
      );
      expect(text).toMatch(/known: main red since build 2701 on this test — not the diff/);
    });

    it("lists an open infra incident in its own section", async () => {
      const { text } = await digest(
        projectWithStore({
          ...emptyStore(),
          cases: {
            "infra:bootstrap:agent-lost": kase({
              kind: "infra",
              state: "confirmed",
              rule: "failed before the runner started",
              cost72h: { redBuilds: 4, mainReds: 1, dequeues: 0 },
            }),
          },
        }),
      );
      expect(text).toContain("known infra:");
      expect(text).toContain("bootstrap:agent-lost — failed before the runner started (4 red builds/72h)");
    });

    it("changes neither the digest nor the exit code when the store is missing or corrupt", async () => {
      const absent = await digest(projectWithStore(null));
      for (const store of ["not json at all {{{", JSON.stringify({ ...emptyStore(), version: 99 }), ""]) {
        const bad = await digest(projectWithStore(store));
        expect(bad.text).toBe(absent.text);
        expect(bad.code).toBe(absent.code);
        expect(bad.urls).toEqual(absent.urls);
      }
      expect(absent.text).not.toContain("known");
    });

    it("carries known in --json: null with no store, populated with one", async () => {
      const { text: silent } = await digest(projectWithStore(null), ["--json"]);
      expect(JSON.parse(silent)).toMatchObject({ known: null });
      const { text } = await digest(
        projectWithStore({
          ...emptyStore(),
          cases: {
            [`flake:${TEST_ID}`]: kase({ kind: "flake", state: "confirmed", cost72h: { redBuilds: 2, mainReds: 0, dequeues: 0 } }),
          },
        }),
        ["--json"],
      );
      expect(JSON.parse(text).known.byTestId[TEST_ID]).toEqual(["confirmed flake (2 reds/72h)"]);
    });

    it("puts the verdict between the failure title and its first detail line", () => {
      const reports: JobReport[] = [
        { job: build.jobs![1]!, url: null, digest: digestLog(cleanLog(ROOT_ASSERTION)), error: null, saved: null },
      ];
      const lines = formatReport(build, reports, 2, null, {
        byTestId: { [TEST_ID]: ["confirmed flake (timeout, 9 reds/72h)"] },
        incidents: [],
      }).split("\n");
      const title = lines.findIndex((line) => line === `   - FAIL ${TEST_ID}`);
      expect(title).toBeGreaterThan(-1);
      expect(lines[title + 1]).toBe("       known: confirmed flake (timeout, 9 reds/72h)");
      expect(lines[title + 2]).toContain("AssertionError: MOBILE_ENVELOPE_CALLERS");
    });
  });
});
