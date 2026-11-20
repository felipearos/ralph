// @vitest-environment node
/**
 * What `ci-doctor/scan.ts` promises: one Buildkite builds call per poll, each
 * failed job's log read at most once, and a ci-health store whose cases say
 * what loggd's own CI history says. The replays use recorded builds and logs
 * from loggd (fixtures/ci-doctor), and git answers recorded from the loggd
 * clone; nothing here calls Buildkite, GitHub or a real clone.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Buildkite, HelperError, type Job } from "../bk-log";
import { classify, checkIncidents, pathsIn, touches } from "./classify";
import { ORG, PIPELINE, fakeBuildkite, loadBuilds, loadGit, replayGit, type FakeBuildkite } from "./fixture-replay";
import {
  GitFacts,
  bootstrapReason,
  defaultScanOptions,
  kindOf,
  mergedPrs,
  prune,
  rollUpFlakeReds,
  rowsFromLog,
  scan,
  type ApiBuild,
  type GitRun,
  type ScanOptions,
} from "./scan";
import {
  KNOWN_FLAKE_STATES,
  emptyStore,
  identify,
  readStore,
  storePathFromGit,
  type Case,
  type CaseState,
  type CiHealthStore,
} from "./store";

const HOUR = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

const MEDIA_MODE =
  "src/app/api/v1/media-mode-conformance.test.ts > Media Mode conformance (real tree) > routes every mobile read through the Media Mode Scope";
const ALLOWLIST =
  "src/app/api/v1/mobile-api-error-conformance.test.ts > mobile API Error conformance > never grows the allowlist against the base branch";
const LIBRARY_MERGE =
  "src/server/imports/library-merge.integration.test.ts > Library Merge > returns exact counts over several batches and totals matching real account counts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-health-"));
  dirs.push(dir);
  return join(dir, "ralph", "ci-health.json");
}

const OPTIONS: ScanOptions = defaultScanOptions(ORG, PIPELINE);

const listCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/builds\?/.test(call));
const logCalls = (calls: readonly string[]): string[] => calls.filter((call) => call.endsWith("/log"));

async function poll(fake: FakeBuildkite, git: GitRun | null, path: string, now: number, options: ScanOptions = OPTIONS) {
  fake.setNow(now);
  return scan(new Buildkite("test-token", fake.fetcher), git === null ? null : new GitFacts(git, options.baseBranch), path, options, now);
}

/** Poll every `stepHours` from `from` to `to`, as a gate would (at a coarser period). */
async function replay(fake: FakeBuildkite, git: GitRun, path: string, from: number, to: number, stepHours = 2): Promise<CiHealthStore[]> {
  const stores: CiHealthStore[] = [];
  for (let now = from; now <= to; now += stepHours * HOUR) {
    await poll(fake, git, path, now);
    stores.push(readStore(path));
  }
  return stores;
}

/** Scan until a full-window backfill is done. */
async function rebuild(fake: FakeBuildkite, git: GitRun | null, path: string, now: number): Promise<number> {
  let polls = 0;
  do {
    await poll(fake, git, path, now);
    polls += 1;
  } while (readStore(path).backfill !== null && polls < 20);
  return polls;
}

const summary = (store: CiHealthStore) =>
  Object.fromEntries(
    Object.entries(store.cases)
      .map(([key, value]) => [key, { kind: value.kind, state: value.state, cost72h: value.cost72h, rule: value.rule ?? null }] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/* --------------------------------------------------------------------------
 * The loggd replays.
 * ----------------------------------------------------------------------- */

describe("replaying loggd's CI, 2026-09-27..28", () => {
  const START = at("2026-09-27T00:00:00Z");
  const END = at("2026-09-29T00:00:00Z");

  it("makes one builds call per poll and reads each failed job's log once across polls (AC1)", async () => {
    const fake = fakeBuildkite(loadBuilds());
    const path = storeFile();
    const misses: string[] = [];
    const git = replayGit(loadGit(), misses);
    let before = 0;
    for (let now = START; now <= END; now += 2 * HOUR) {
      await poll(fake, git, path, now);
      expect(listCalls(fake.calls.slice(before))).toHaveLength(1);
      before = fake.calls.length;
    }
    const logs = logCalls(fake.calls);
    expect(logs.length).toBeGreaterThan(30);
    expect(new Set(logs).size).toBe(logs.length);

    // Nothing new: one call, no log.
    await poll(fake, git, path, END + 5 * 60_000);
    expect(listCalls(fake.calls.slice(before))).toHaveLength(1);
    expect(logCalls(fake.calls.slice(before))).toHaveLength(0);
    expect(misses).toEqual([]);
  });

  it("confirms the media-mode timeout by main flip, with 4 main reds and 2 queue reds, and finds no main regression (AC2)", async () => {
    const fake = fakeBuildkite(loadBuilds());
    const path = storeFile();
    const stores = await replay(fake, replayGit(loadGit()), path, START, END);
    for (const store of stores) {
      expect(Object.keys(store.cases).filter((key) => key.startsWith("regression:"))).toEqual([]);
    }
    const store = stores.at(-1)!;
    const media = store.cases[`flake:${MEDIA_MODE}`];
    expect(media).toMatchObject({ kind: "flake", state: "confirmed" });
    expect(media!.rule).toContain("main flip");
    expect(media!.cost72h.mainReds).toBe(4);
    expect(media!.cost72h.dequeues).toBe(2);
    expect(media!.evidence.filter((row) => row.branch === "main").map((row) => row.build)).toEqual([2357, 2364, 2367, 2417]);
    expect(media!.evidence.every((row) => row.kind === "timeout")).toBe(true);
    expect(store.main).toMatchObject({ state: "green" });
  });

  it("rebuilds the same cases from a full-window scan after the store is deleted (AC7)", async () => {
    const fake = fakeBuildkite(loadBuilds());
    const path = storeFile();
    const git = replayGit(loadGit());
    await replay(fake, git, path, START, END);
    const incremental = readStore(path);

    rmSync(path);
    const before = fake.calls.length;
    const polls = await rebuild(fake, git, path, END);
    expect(polls).toBeGreaterThan(1); // more than 100 builds in the window: paged, one call each
    expect(listCalls(fake.calls.slice(before))).toHaveLength(polls);
    const rebuilt = readStore(path);
    expect(summary(rebuilt)).toEqual(summary(incremental));
    expect(Object.keys(rebuilt.cases).length).toBeGreaterThan(0);
    expect(rebuilt.main).toEqual(incremental.main);
  });
});

describe("replaying PR #1710 (rulo/1537-use-feed, builds 2422 and 2425)", () => {
  it("calls the allowlist ratchet PR-specific, not a flake (AC3)", async () => {
    const until = at("2026-09-28T11:31:00Z");
    // PR #1710's two red builds, and main's history for the base they were checked against.
    const builds = loadBuilds().filter(
      (build) => [2422, 2425].includes(build.number) || (build.branch === "main" && at(build.finished_at!) <= until),
    );
    const fake = fakeBuildkite(builds);
    const path = storeFile();
    const misses: string[] = [];
    await rebuild(fake, replayGit(loadGit(), misses), path, until);
    const store = readStore(path);
    const key = `pr-specific:rulo/1537-use-feed:${ALLOWLIST}`;
    expect(store.cases[key]).toMatchObject({ kind: "pr-specific", state: "confirmed" });
    expect(store.cases[key]!.evidence.map((row) => row.build)).toEqual([2422, 2425]);
    expect(store.cases[`flake:${ALLOWLIST}`]).toBeUndefined();
    expect(misses).toEqual([]);
  });
});

describe("replaying 2026-09-29's library-merge timeouts (2622, 2626, 2627)", () => {
  it("confirms the timeout across two branches, and records each PR build's changed files", async () => {
    const now = at("2026-09-29T11:10:00Z");
    const builds = loadBuilds().filter((build) => build.number >= 2622);
    const fake = fakeBuildkite(builds);
    const path = storeFile();
    const misses: string[] = [];
    await rebuild(fake, replayGit(loadGit(), misses), path, now);
    const store = readStore(path);
    const flake = store.cases[`flake:${LIBRARY_MERGE}`];
    expect(flake).toMatchObject({ kind: "flake", state: "confirmed" });
    expect(flake!.rule).toContain("cross-branch recurrence");
    expect(flake!.cost72h).toEqual({ redBuilds: 3, mainReds: 0, dequeues: 0 });
    // Hook timeouts in whole files, from 2626.
    expect(store.failures.filter((row) => row.build === 2626).map((row) => row.kind).sort()).toEqual(["hook-timeout", "hook-timeout", "timeout"]);
    const red = store.builds.find((build) => build.number === 2626)!;
    expect(red.changedFiles).not.toBeNull();
    expect(touches(red.changedFiles!, "src/server/imports/library-merge.integration.test.ts")).toBe(false);
    expect(misses).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * Synthetic CI: the rules the recorded days do not exercise.
 * ----------------------------------------------------------------------- */

const T_FILE = "src/server/slow.integration.test.ts";
const T = `${T_FILE} > slow > counts`;

const timeoutLog = [
  "~~~ Running commands",
  "$ bun x vitest run --coverage",
  ` FAIL  ${T_FILE} > slow > counts`,
  "Error: Test timed out in 5000ms.",
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  ` ❯ ${T_FILE}:12:3`,
  " Test Files  1 failed | 10 passed (11)",
  'error: script "test:coverage" exited with code 1',
].join("\n");

const sha = (n: number): string => n.toString(16).padStart(40, "a");
const tree = (n: number): string => n.toString(16).padStart(40, "e");

interface Synth {
  number: number;
  branch?: string;
  commit: string;
  state: "passed" | "failed";
  finished: string;
  message?: string;
  source?: string;
  retried?: boolean;
  exit?: number;
}

function synthBuild(spec: Synth): ApiBuild {
  const jobs: Job[] = [];
  if (spec.retried) {
    jobs.push({ id: `job-${spec.number}-first`, type: "script", name: "quality", state: "failed", step_key: "quality", exit_status: 1, retried: true });
  }
  jobs.push({
    id: `job-${spec.number}`,
    type: "script",
    name: "quality",
    state: spec.state,
    step_key: "quality",
    exit_status: spec.state === "passed" ? 0 : (spec.exit ?? 1),
    retried: false,
  });
  const finished = at(spec.finished);
  return {
    number: spec.number,
    state: spec.state,
    branch: spec.branch ?? "main",
    commit: spec.commit,
    message: spec.message ?? `change ${spec.number} (#${spec.number + 100})`,
    source: spec.source ?? "webhook",
    created_at: new Date(finished - 10 * 60_000).toISOString(),
    started_at: new Date(finished - 9 * 60_000).toISOString(),
    finished_at: spec.finished,
    pull_request: null,
    jobs,
  };
}

/** A clone that knows each commit's parent and tree, and the listed diffs. */
function synthGit(commits: { sha: string; parent: string | null; tree: string }[], diffs: Record<string, string[]> = {}): GitRun {
  const record: Record<string, string | null> = {};
  for (const commit of commits) {
    record[`cat-file -e ${commit.sha}^{commit}`] = "";
    record[`rev-parse ${commit.sha}^{tree}`] = commit.tree;
    record[`rev-parse ${commit.sha}^`] = commit.parent;
    record[`merge-base origin/main ${commit.sha}`] = commits[0]!.sha;
  }
  for (const [pair, files] of Object.entries(diffs)) record[`diff --name-only ${pair}`] = files.join("\n");
  return (args) => (args[0] === "fetch" ? (args.length > 4 ? null : "") : (record[args.join(" ")] ?? null));
}

describe("a regression on main (AC4)", () => {
  it("is a regression after a green parent, even for a timeout, with the culprit named", async () => {
    const builds = [
      synthBuild({ number: 1, commit: sha(1), state: "passed", finished: "2026-09-28T10:00:00Z" }),
      synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z", message: "feat: slower counts (#1234)" }),
      synthBuild({ number: 3, commit: sha(3), state: "failed", finished: "2026-09-28T12:00:00Z" }),
    ];
    const logs = { "job-2": timeoutLog, "job-3": timeoutLog };
    const git = synthGit([
      { sha: sha(1), parent: sha(0), tree: tree(1) },
      { sha: sha(2), parent: sha(1), tree: tree(2) },
      { sha: sha(3), parent: sha(2), tree: tree(3) },
    ]);
    const path = storeFile();
    await rebuild(fakeBuildkite(builds, logs), git, path, at("2026-09-28T12:30:00Z"));
    const store = readStore(path);
    const regression = store.cases[`regression:${T}`];
    expect(regression).toMatchObject({ kind: "regression", state: "confirmed" });
    expect(regression!.culprit).toEqual({ commit: sha(2), build: 2, parentBuild: 1, pr: 1234, unambiguous: true, why: [] });
    expect(store.cases[`flake:${T}`]).toBeUndefined();
    expect(store.main).toMatchObject({ state: "red", build: 2 });
  });

  it("marks the culprit ambiguous when a main commit between green and red was never built", async () => {
    const builds = [
      synthBuild({ number: 1, commit: sha(1), state: "passed", finished: "2026-09-28T10:00:00Z" }),
      // sha(9) landed on main between them and never got a build.
      synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" }),
      synthBuild({ number: 3, commit: sha(3), state: "failed", finished: "2026-09-28T12:00:00Z" }),
    ];
    const git = synthGit([
      { sha: sha(1), parent: sha(0), tree: tree(1) },
      { sha: sha(2), parent: sha(9), tree: tree(2) },
      { sha: sha(3), parent: sha(2), tree: tree(3) },
    ]);
    const path = storeFile();
    await rebuild(fakeBuildkite(builds, { "job-2": timeoutLog, "job-3": timeoutLog }), git, path, at("2026-09-28T12:30:00Z"));
    const culprit = readStore(path).cases[`regression:${T}`]!.culprit!;
    expect(culprit).toMatchObject({ commit: sha(2), unambiguous: false });
    expect(culprit.why.join(" ")).toMatch(/never built/);
  });

  it("is not a regression when a queue build since the first red passed the test", async () => {
    const builds = [
      synthBuild({ number: 1, commit: sha(1), state: "passed", finished: "2026-09-28T10:00:00Z" }),
      synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" }),
      synthBuild({ number: 3, branch: "mergify/merge-queue/abc", commit: sha(7), state: "passed", finished: "2026-09-28T11:20:00Z" }),
      synthBuild({ number: 4, commit: sha(3), state: "failed", finished: "2026-09-28T12:00:00Z" }),
    ];
    const git = synthGit([
      { sha: sha(1), parent: sha(0), tree: tree(1) },
      { sha: sha(2), parent: sha(1), tree: tree(2) },
      { sha: sha(7), parent: sha(2), tree: tree(7) },
      { sha: sha(3), parent: sha(2), tree: tree(3) },
    ]);
    const path = storeFile();
    await rebuild(fakeBuildkite(builds, { "job-2": timeoutLog, "job-4": timeoutLog }), git, path, at("2026-09-28T12:30:00Z"));
    const store = readStore(path);
    expect(store.cases[`regression:${T}`]).toBeUndefined();
    expect(store.cases[`flake:${T}`]).toMatchObject({ kind: "flake" });
  });
});

describe("infrastructure (AC5)", () => {
  it("classifies a job that failed before its commands ran as infra, keyed by signature", async () => {
    const checkout = [
      "~~~ Preparing working directory",
      "$ git fetch -v --prune -- origin 1234",
      "fatal: unable to access 'https://github.com/felipearos/loggd.git/': Could not resolve host: github.com",
      "🚨 Error: The checkout hook exited with status 128",
    ].join("\n");
    const builds = [
      synthBuild({ number: 1, commit: sha(1), state: "passed", finished: "2026-09-28T10:00:00Z" }),
      synthBuild({ number: 2, branch: "ralph/1-a", commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z", exit: 128 }),
      synthBuild({ number: 3, branch: "rafa/2-b", commit: sha(3), state: "failed", finished: "2026-09-28T11:05:00Z", exit: -1 }),
    ];
    const path = storeFile();
    await rebuild(fakeBuildkite(builds, { "job-2": checkout, "job-3": "" }), null, path, at("2026-09-28T12:00:00Z"));
    const store = readStore(path);
    expect(store.cases["infra:bootstrap:checkout"]).toMatchObject({ kind: "infra", state: "confirmed" });
    expect(store.cases["infra:bootstrap:checkout"]!.evidence[0]!.line).toMatch(/^fatal: unable to access/);
    expect(store.cases["infra:bootstrap:agent-lost"]).toMatchObject({ kind: "infra" });
    expect(Object.keys(store.cases).every((key) => key.startsWith("infra:"))).toBe(true);
  });

  it("reads a lost agent, a hook and docker from the log, and a job whose commands ran as not bootstrap", () => {
    const job = (exit: number | null): Job => ({ id: "j", type: "script", name: "q", state: "failed", exit_status: exit });
    expect(bootstrapReason(job(-1), "")).toMatchObject({ reason: "agent-lost" });
    expect(bootstrapReason(job(255), "~~~ Preparing working directory\nError response from daemon: no space left on device")).toMatchObject({ reason: "docker" });
    expect(bootstrapReason(job(255), "~~~ Running global environment hook\n🚨 Error: The global environment hook exited with status 255")).toMatchObject({ reason: "hook" });
    expect(bootstrapReason(job(1), timeoutLog)).toBeNull();
    expect(bootstrapReason(job(-1), `~~~ Running commands\n$ jest\nsome output`)).toMatchObject({ reason: "agent-lost" });
  });

  it("calls a non-Buildkite check red on 3 PRs with one description an incident", () => {
    const red = (pr: number, description = "Deployment has failed") => ({ pr, name: "Vercel", state: "failure", description });
    expect(Object.keys(checkIncidents([red(1), red(2)]))).toEqual([]);
    expect(Object.keys(checkIncidents([red(1), red(2), red(3), red(4, "other")]))).toEqual(["infra:check:Vercel:Deployment has failed"]);
    expect(Object.keys(checkIncidents([{ ...red(1), name: "buildkite/loggd" }, { ...red(2), name: "buildkite/loggd" }, { ...red(3), name: "buildkite/loggd" }]))).toEqual([]);
  });

  it("calls a build that sat scheduled for more than 30 min an incident", async () => {
    const slow = synthBuild({ number: 5, commit: sha(5), state: "passed", finished: "2026-09-28T11:00:00Z" });
    slow.created_at = "2026-09-28T10:00:00Z";
    slow.started_at = "2026-09-28T10:45:00Z";
    const path = storeFile();
    await rebuild(fakeBuildkite([slow]), null, path, at("2026-09-28T12:00:00Z"));
    expect(readStore(path).cases["infra:scheduled-wait"]).toMatchObject({ kind: "infra", state: "confirmed" });
  });
});

describe("candidates and retries", () => {
  it("keeps a single occurrence a candidate, and retires it after 48 h without recurrence (AC6)", async () => {
    const builds = [
      synthBuild({ number: 1, commit: sha(1), state: "passed", finished: "2026-09-28T10:00:00Z" }),
      synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" }),
    ];
    const fake = fakeBuildkite(builds, { "job-2": timeoutLog });
    const git = synthGit([
      { sha: sha(1), parent: sha(0), tree: tree(1) },
      { sha: sha(2), parent: sha(1), tree: tree(2) },
    ]);
    const path = storeFile();
    await poll(fake, git, path, at("2026-09-28T12:00:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toMatchObject({ state: "candidate" });
    await poll(fake, git, path, at("2026-09-30T10:00:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toMatchObject({ state: "candidate" });
    await poll(fake, git, path, at("2026-09-30T11:30:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toMatchObject({ state: "retired" });
    // Out of the window, it is gone.
    await poll(fake, git, path, at("2026-10-01T12:00:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toBeUndefined();
    expect(readStore(path).failures).toEqual([]);
  });

  it("records a retried job as a retry, and a passing retry confirms by same tree, both colours", async () => {
    const red = synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" });
    const git = synthGit([{ sha: sha(2), parent: sha(1), tree: tree(2) }]);
    const path = storeFile();
    const fake = fakeBuildkite([red], { "job-2": timeoutLog, "job-2-first": timeoutLog });
    await poll(fake, git, path, at("2026-09-28T11:30:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toMatchObject({ state: "candidate" });

    // Someone retries the job and it passes: the build finishes again, later, green.
    const retried = synthBuild({ number: 2, commit: sha(2), state: "passed", finished: "2026-09-28T11:40:00Z", retried: true });
    retried.jobs![0]!.id = "job-2";
    retried.jobs![1]!.id = "job-2-retry";
    const again = fakeBuildkite([retried]);
    await poll(again, git, path, at("2026-09-28T12:00:00Z"));
    expect(logCalls(again.calls)).toEqual([]); // the red job's log was read the first time
    const store = readStore(path);
    expect(store.failures.filter((row) => row.job === "job-2")).toMatchObject([{ retried: true }]);
    expect(store.cases[`flake:${T}`]).toMatchObject({ state: "confirmed", rule: "same tree, both colours" });
    expect(store.cases[`flake:${T}`]!.cost72h.redBuilds).toBe(0);
  });

  it("a retried job that FAILS again does not confirm the candidate (#161 AC 5)", async () => {
    const red = synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" });
    const git = synthGit([{ sha: sha(2), parent: sha(1), tree: tree(2) }]);
    const path = storeFile();
    const fake = fakeBuildkite([red], { "job-2": timeoutLog, "job-2-first": timeoutLog });
    await poll(fake, git, path, at("2026-09-28T11:30:00Z"));
    expect(readStore(path).cases[`flake:${T}`]).toMatchObject({ state: "candidate" });

    // The doctor retries it (`ci-doctor/retry.ts`) and the retry is red too.
    // The build is still failed, so there is no green of this tree to set
    // beside the red, and the case must stay a candidate: a retry can confirm
    // a flake and must never, by itself, convict one.
    const retried = synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:40:00Z", retried: true });
    retried.jobs![0]!.id = "job-2";
    retried.jobs![1]!.id = "job-2-retry";
    const again = fakeBuildkite([retried], { "job-2-retry": timeoutLog });
    await poll(again, git, path, at("2026-09-28T12:00:00Z"));

    const store = readStore(path);
    // The ORIGINAL job's row is marked, and the retry's own red stands as the
    // case's one unretried row. `redBuilds` cannot tell those apart — both are
    // build #2 — so the rows themselves are what this asserts.
    expect(store.failures.filter((row) => row.job === "job-2")).toMatchObject([{ retried: true }]);
    expect(store.failures.filter((row) => row.testId === T && !row.retried).map((row) => row.job)).toEqual(["job-2-retry"]);
    expect(store.cases[`flake:${T}`]).toMatchObject({ state: "candidate", rule: null });
  });

  it("keeps a flake found on a PR only when its diff leaves the test's file alone", async () => {
    const builds = [
      synthBuild({ number: 1, branch: "ralph/1-a", commit: sha(1), state: "failed", finished: "2026-09-28T10:00:00Z" }),
      synthBuild({ number: 2, branch: "rafa/2-b", commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" }),
    ];
    const commits = [
      { sha: sha(0), parent: null, tree: tree(0) },
      { sha: sha(1), parent: sha(0), tree: tree(1) },
      { sha: sha(2), parent: sha(0), tree: tree(2) },
    ];
    const git = synthGit(commits, {
      [`${sha(0)} ${sha(1)}`]: ["src/unrelated.ts"],
      [`${sha(0)} ${sha(2)}`]: [T_FILE],
    });
    const path = storeFile();
    await rebuild(fakeBuildkite(builds, { "job-1": timeoutLog, "job-2": timeoutLog }), git, path, at("2026-09-28T12:00:00Z"));
    const flake = readStore(path).cases[`flake:${T}`]!;
    expect(flake.state).toBe("candidate");
    expect(flake.evidence.map((row) => row.branch)).toEqual(["ralph/1-a", "rafa/2-b"]);
  });
});

/* --------------------------------------------------------------------------
 * The per-day metrics (#163).
 * ----------------------------------------------------------------------- */

/** A build record with only the fields the rollup reads spelled out. */
const record = (number: number, finishedAt: string, state = "failed"): CiHealthStore["builds"][number] => ({
  number,
  branch: "main",
  commit: `c${number}`,
  state,
  source: null,
  createdAt: finishedAt,
  startedAt: finishedAt,
  finishedAt,
  pr: null,
  prs: [],
  steps: {},
  tree: null,
  parent: null,
  sincePrevious: null,
  changedFiles: null,
  branchPaths: null,
});

const failure = (testId: string, build: number): CiHealthStore["failures"][number] => ({
  testId,
  file: null,
  build,
  branch: "main",
  commit: `c${build}`,
  job: `job-${build}-${testId}`,
  step: null,
  kind: "timeout",
  line: testId,
  finishedAt: "2026-10-05T00:00:00.000Z",
  retried: false,
});

const flakeCase = (state: CaseState): Case => ({
  kind: "flake",
  state,
  evidence: [],
  cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
});

describe("known-flake reds per day (#163)", () => {
  const START = at("2026-09-27T00:00:00Z");
  const END = at("2026-09-29T00:00:00Z");

  it("counts, per UTC day, the loggd reds whose failing tests are all known flakes", async () => {
    const fake = fakeBuildkite(loadBuilds());
    const path = storeFile();
    const stores = await replay(fake, replayGit(loadGit()), path, START, END);
    const store = stores.at(-1)!;

    const reds = Object.fromEntries(
      Object.entries(store.metrics).map(([day, value]) => [day, value.knownFlakeReds]),
    );
    expect(reds).toEqual({ "2026-09-27": 1, "2026-09-28": 23 });

    // And the literals above mean what they say: recount the same question
    // from the store's own evidence and assert the two agree EXACTLY, so a
    // fixture change that moves the numbers cannot leave them quietly
    // meaningless. Exact equality is available here only because the replay
    // spans 48 hours inside a 72-hour window, so the final store still holds
    // every build it ever counted and the running maximum has nothing to
    // remember that the recount cannot see. `KNOWN_FLAKE_STATES` is imported
    // rather than re-spelled: a second copy of the state list would agree with
    // a typo in the first.
    const failing = new Map<number, Set<string>>();
    for (const row of store.failures) {
      const seen = failing.get(row.build) ?? new Set<string>();
      seen.add(row.testId);
      failing.set(row.build, seen);
    }
    const known = (testId: string): boolean => {
      const state = store.cases[`flake:${testId}`]?.state;
      return state !== undefined && KNOWN_FLAKE_STATES.has(state);
    };
    const recounted: Record<string, number> = {};
    for (const build of store.builds) {
      const tests = failing.get(build.number);
      if (tests === undefined || tests.size === 0 || ![...tests].every(known)) continue;
      const day = build.finishedAt.slice(0, 10);
      recounted[day] = (recounted[day] ?? 0) + 1;
    }
    expect(reds).toEqual(recounted);
  });

  it("does not count a build that also failed on a test nobody has classified", () => {
    const store = emptyStore();
    store.builds = [record(10, "2026-10-05T09:00:00.000Z"), record(11, "2026-10-05T10:00:00.000Z")];
    store.failures = [failure("a > one", 10), failure("a > one", 11), failure("b > two", 11)];
    store.cases["flake:a > one"] = flakeCase("confirmed");

    rollUpFlakeReds(store);

    expect(store.metrics).toEqual({ "2026-10-05": { knownFlakeReds: 1, parkedOnFlake: 0 } });
  });

  it("does not count a candidate the doctor has not confirmed yet", () => {
    const store = emptyStore();
    store.builds = [record(10, "2026-10-05T09:00:00.000Z")];
    store.failures = [failure("a > one", 10)];
    store.cases["flake:a > one"] = flakeCase("candidate");

    rollUpFlakeReds(store);

    expect(store.metrics).toEqual({});
  });

  it("counts a build that finished green only because its flaky job was retried", () => {
    // This is the one case reading `build.state` instead of the failure rows
    // would decide differently, and it matches `scan.ts`'s own `isRed`: the
    // iteration waited for both runs and learned nothing from either.
    const store = emptyStore();
    store.builds = [record(10, "2026-10-05T09:00:00.000Z", "passed")];
    store.failures = [{ ...failure("a > one", 10), retried: true }];
    store.cases["flake:a > one"] = flakeCase("confirmed");

    rollUpFlakeReds(store);

    expect(store.metrics["2026-10-05"]).toEqual({ knownFlakeReds: 1, parkedOnFlake: 0 });
  });

  it("does not count a build with no failing tests, and creates no day for it", () => {
    const store = emptyStore();
    store.builds = [record(10, "2026-10-05T09:00:00.000Z", "passed")];
    store.cases["flake:a > one"] = flakeCase("confirmed");

    rollUpFlakeReds(store);

    expect(store.metrics).toEqual({});
  });

  it("skips a build whose finish it cannot read rather than filing it under a bogus day", () => {
    const store = emptyStore();
    store.builds = [record(10, "")];
    store.failures = [failure("a > one", 10)];
    store.cases["flake:a > one"] = flakeCase("confirmed");

    rollUpFlakeReds(store);

    expect(store.metrics).toEqual({});
  });

  it("never lowers a day the 72-hour window has since dropped the builds for", () => {
    const store = emptyStore();
    store.metrics["2026-10-01"] = { knownFlakeReds: 9, parkedOnFlake: 4 };
    store.builds = [record(10, "2026-10-01T09:00:00.000Z")];
    store.failures = [failure("a > one", 10)];
    store.cases["flake:a > one"] = flakeCase("fixed");

    rollUpFlakeReds(store);

    expect(store.metrics["2026-10-01"]).toEqual({ knownFlakeReds: 9, parkedOnFlake: 4 });
  });

  it("leaves the gate's parked count on a day it raises", () => {
    const store = emptyStore();
    store.metrics["2026-10-05"] = { knownFlakeReds: 0, parkedOnFlake: 3 };
    store.builds = [record(10, "2026-10-05T09:00:00.000Z")];
    store.failures = [failure("a > one", 10)];
    store.cases["flake:a > one"] = flakeCase("filed");

    rollUpFlakeReds(store);

    expect(store.metrics["2026-10-05"]).toEqual({ knownFlakeReds: 1, parkedOnFlake: 3 });
  });

  it("prunes a metrics day past 30 days and keeps one inside them", () => {
    const now = at("2026-10-05T12:00:00Z");
    const store = emptyStore();
    store.metrics["2026-09-06"] = { knownFlakeReds: 1, parkedOnFlake: 1 };
    store.metrics["2026-09-04"] = { knownFlakeReds: 2, parkedOnFlake: 2 };

    prune(store, now, OPTIONS);

    expect(Object.keys(store.metrics)).toEqual(["2026-09-06"]);
  });
});

/* --------------------------------------------------------------------------
 * The poll's edges.
 * ----------------------------------------------------------------------- */

describe("the poll", () => {
  it("leaves the store untouched when Buildkite cannot list builds", async () => {
    const path = storeFile();
    const failing: FakeBuildkite = {
      calls: [],
      setNow() {},
      fetcher: async () => new Response(JSON.stringify({ message: "boom" }), { status: 502 }),
    };
    await expect(poll(failing, null, path, at("2026-09-28T12:00:00Z"))).rejects.toBeInstanceOf(HelperError);
    expect(readStore(path)).toEqual(emptyStore());
  });

  it("records an unreadable log once, as a row that says so", async () => {
    const red = synthBuild({ number: 2, commit: sha(2), state: "failed", finished: "2026-09-28T11:00:00Z" });
    const path = storeFile();
    const fake = fakeBuildkite([red]);
    await poll(fake, null, path, at("2026-09-28T11:30:00Z"));
    await poll(fake, null, path, at("2026-09-28T11:40:00Z"));
    expect(logCalls(fake.calls)).toHaveLength(1);
    expect(readStore(path).failures).toMatchObject([{ testId: "step:quality", kind: "no-marker" }]);
    expect(readStore(path).failures[0]!.line).toMatch(/^log unreadable: Buildkite 404/);
  });

  it("starts from the window's start, then from the newest finish it has seen", async () => {
    const path = storeFile();
    const fake = fakeBuildkite([synthBuild({ number: 1, commit: sha(1), state: "passed", finished: "2026-09-28T10:00:00Z" })]);
    await poll(fake, null, path, at("2026-09-28T12:00:00Z"));
    await poll(fake, null, path, at("2026-09-28T12:05:00Z"));
    const [first, second] = listCalls(fake.calls);
    expect(first).toContain(`finished_from=${encodeURIComponent("2026-09-25T12:00:00.000Z")}`);
    expect(second).toContain(`finished_from=${encodeURIComponent("2026-09-28T10:00:00Z")}`);
    expect(first).toContain("per_page=100");
  });

  it("rebuilds from nothing when the store file is corrupt", async () => {
    const path = storeFile();
    await poll(fakeBuildkite([]), null, path, at("2026-09-28T12:00:00Z"));
    writeFileSync(path, "{ not json");
    expect(readStore(path)).toEqual(emptyStore());
    writeFileSync(path, JSON.stringify({ version: 99 }));
    expect(readStore(path)).toEqual(emptyStore());
  });

  it("keeps the store in the git common directory, shared by every worktree", () => {
    const path = storePathFromGit(process.cwd());
    expect(path.endsWith(join("ralph", "ci-health.json"))).toBe(true);
    expect(path).not.toContain(join(".git", "worktrees"));
  });
});

/* --------------------------------------------------------------------------
 * Pure pieces.
 * ----------------------------------------------------------------------- */

describe("rows from a log", () => {
  it("keys vitest, jest and playwright failures by file and title", () => {
    expect(identify(`FAIL ${T_FILE} > slow > counts`, [])).toEqual({ testId: T, file: T_FILE });
    expect(identify(`FAIL ${T_FILE} (whole file)`, [])).toEqual({ testId: T_FILE, file: T_FILE });
    expect(identify("● DiaryTab media mode › applies a TV-only genre", ["components/__tests__/diary.test.tsx"])).toEqual({
      testId: "components/__tests__/diary.test.tsx > DiaryTab media mode > applies a TV-only genre",
      file: "components/__tests__/diary.test.tsx",
    });
    expect(identify("● DiaryTab › x", ["a.test.tsx", "b.test.tsx"])).toEqual({ testId: "DiaryTab > x", file: null });
    expect(identify("[chromium-authenticated] › e2e/feed-controls.spec.ts:82:3 › Private feed controls @authenticated › persists", [])).toEqual({
      testId: "e2e/feed-controls.spec.ts > Private feed controls @authenticated > persists",
      file: "e2e/feed-controls.spec.ts",
    });
    expect(identify("vitest: Startup Error", [])).toEqual({ testId: "vitest: Startup Error", file: null });
  });

  it("prefers the file the digest attached to a jest failure over the whole job's files (#237)", () => {
    // The mobile case: hundreds of test files in one job, so the guess above
    // can resolve none of them. The `FAIL <path>` header can.
    expect(identify("● Activity tab show grouping › groups by day", ["a.test.tsx", "b.test.tsx"], "app/__tests__/activity.test.tsx")).toEqual({
      testId: "app/__tests__/activity.test.tsx > Activity tab show grouping > groups by day",
      file: "app/__tests__/activity.test.tsx",
    });
    // It wins over a single-file job's guess too: the header is what the
    // runner said about THIS failure.
    expect(identify("● s › t", ["guess.test.ts"], "real.test.ts")).toEqual({ testId: "real.test.ts > s > t", file: "real.test.ts" });
    // Null and undefined both mean "the digest does not know".
    expect(identify("● s › t", ["guess.test.ts"], null)).toEqual({ testId: "guess.test.ts > s > t", file: "guess.test.ts" });
    // A non-jest title keeps its own file, whatever is passed.
    expect(identify(`FAIL ${T_FILE} > slow > counts`, [], "other.test.ts")).toEqual({ testId: T, file: T_FILE });
  });

  it("tells a hook timeout from a test timeout from an assertion", () => {
    expect(kindOf(["Error: Hook timed out in 10000ms."])).toBe("hook-timeout");
    expect(kindOf(["Error: Test timed out in 5000ms."])).toBe("timeout");
    expect(kindOf(["AssertionError: expected true to be false"])).toBe("assertion");
  });

  it("falls back to the runner's per-file summary when no failure marker matched", () => {
    const build = synthBuild({ number: 9, commit: sha(9), state: "failed", finished: "2026-09-28T11:00:00Z" });
    const log = ["~~~ Running commands", "$ jest", "FAIL  components/__tests__/library-recovery.test.tsx", "Test Suites: 1 failed, 342 passed, 343 total"].join("\n");
    expect(rowsFromLog(build, build.jobs![0]!, log, false)).toMatchObject([
      { testId: "components/__tests__/library-recovery.test.tsx", kind: "no-marker", step: "quality" },
    ]);
  });

  it("reads the merged PR from a squash commit's trailing (#n)", () => {
    expect(mergedPrs("perf(api): verify bearer tokens locally (#1409) (#1458)")).toEqual([1458]);
    expect(mergedPrs("Merge of #1707")).toEqual([1707]);
    expect(mergedPrs("chore: no number")).toEqual([]);
  });

  it("finds the paths a ratchet's line names", () => {
    expect(pathsIn("MOBILE_ENVELOPE_CALLERS may only shrink; new paths: mobile/hooks/useLists.ts, mobile/app/list/[id]/manage.tsx: expected")).toEqual([
      "mobile/hooks/useLists.ts",
      "mobile/app/list/[id]/manage.tsx",
    ]);
    expect(touches(["mobile/components/__tests__/x.test.tsx"], "components/__tests__/x.test.tsx")).toBe(true);
    expect(touches(["src/a.ts"], "a.ts")).toBe(true);
    expect(touches(["src/ab.ts"], "b.ts")).toBe(false);
  });

  it("classifies an empty store as nothing, with main unknown", () => {
    expect(classify(emptyStore(), Date.now())).toEqual({ cases: {}, main: { state: "unknown", since: "", build: 0 } });
  });
});

describe("a starved job is one infra incident, not a flake per test", () => {
  // Build 20 is red on `quality`; build 21 is the same commit, green on it —
  // the "same tree, both colours" evidence that alone confirms a flake.
  const store = (failures: CiHealthStore["failures"]): CiHealthStore => {
    const out = emptyStore();
    out.builds = [
      { ...record(20, "2026-10-07T01:00:00.000Z"), commit: "c20", steps: { quality: "failed" } },
      { ...record(21, "2026-10-07T02:00:00.000Z", "passed"), commit: "c20", steps: { quality: "passed" } },
    ];
    out.failures = failures;
    return out;
  };
  const timedOut = (testId: string, file: string | null = null): CiHealthStore["failures"][number] => ({
    ...failure(testId, 20),
    file,
    step: "quality",
    line: "Error: Test timed out in 5000ms.",
  });
  const NOW = at("2026-10-07T03:00:00Z");

  it("files the timeouts of 4+ unrelated groups in one job as infra:starved-job and confirms none of them", () => {
    const { cases } = classify(
      store([
        timedOut("Activity tab > collapses"),
        timedOut("Activity tab > dismisses"),
        timedOut("List detail > opens"),
        timedOut("Home Feed > shows"),
        timedOut("src/a.integration.test.ts > a > works", "src/a.integration.test.ts"),
      ]),
      NOW,
    );
    expect(Object.keys(cases)).toEqual(["infra:starved-job"]);
    expect(cases["infra:starved-job"]).toMatchObject({ kind: "infra", state: "confirmed" });
    expect(cases["infra:starved-job"]!.evidence).toEqual([
      expect.objectContaining({ build: 20, line: "5 tests in 4 unrelated groups timed out together in quality" }),
    ]);
  });

  it("still confirms timeouts in fewer than 4 groups as flakes", () => {
    const { cases } = classify(store([timedOut("Activity tab > collapses"), timedOut("List detail > opens"), timedOut("Home Feed > shows")]), NOW);
    expect(Object.keys(cases).sort()).toEqual(["flake:Activity tab > collapses", "flake:Home Feed > shows", "flake:List detail > opens"]);
    expect(cases["flake:List detail > opens"]).toMatchObject({ state: "confirmed", rule: "same tree, both colours" });
  });

  it("does not call one file timing out in every test starved", () => {
    const file = "src/slow.integration.test.ts";
    const { cases } = classify(store(["one", "two", "three", "four"].map((name) => timedOut(`${file} > slow > ${name}`, file))), NOW);
    expect(Object.keys(cases).every((key) => key.startsWith("flake:"))).toBe(true);
    expect(Object.keys(cases)).toHaveLength(4);
  });

  it("keeps an assertion in a starved job as evidence for its own test", () => {
    const assertion = { ...timedOut("Profile gate > renders"), kind: "assertion" as const, line: "expect(x).toBe(y)" };
    const { cases } = classify(
      store([timedOut("A > one"), timedOut("B > two"), timedOut("C > three"), timedOut("D > four"), assertion]),
      NOW,
    );
    // The assertion goes to the ordinary rules, where one sighting is not
    // flake-shaped — so no case, rather than being swallowed by the incident.
    expect(Object.keys(cases)).toEqual(["infra:starved-job"]);
    expect(cases["infra:starved-job"]!.evidence[0]!.line).toBe("4 tests in 4 unrelated groups timed out together in quality");
  });
});
