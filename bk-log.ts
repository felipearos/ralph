#!/usr/bin/env bun
/**
 * Read a Buildkite build's failure out of its job logs, for a session that
 * has a red `buildkite/<pipeline>` check and nothing else to go on.
 *
 * Without this, an iteration could not see why CI was red: the build page
 * answers 403 and there is no `bk` CLI. So it re-ran the gates locally, got
 * green, and parked the ticket "red twice in CI; not reproducible locally" for
 * a human. Of the three tickets parked that way on 2026-09-27, two were one
 * known flaky timeout and the third a real root-suite vitest failure the
 * session never ran, because it had only run the mobile checks. Every one was
 * written in the log.
 *
 *   bun bk-log.ts <build>              2425, or a build URL (…/builds/2425)
 *   bun bk-log.ts --pr <n>             the build the PR's buildkite check links
 *   bun bk-log.ts --branch <name>      the latest build of a branch (a merge
 *                                      queue's `mergify/merge-queue/…` branch)
 *     --full <dir>    also write each failed job's whole cleaned log to <dir>
 *                     (with --job, the named job's)
 *     --json          the digest as JSON
 *     --no-history    skip the look at the pipeline's other recent builds
 *   bun bk-log.ts <build> --job <key>  one job's whole cleaned log, WHATEVER
 *                                      its state (key = step key, job id or
 *                                      exact name), e.g. `--job e2e`
 *     --grep <regex>  only the lines that match, with their line numbers
 *   bun bk-log.ts --check-token        is the read token usable, and read-only?
 *   bun bk-log.ts --check-retry-token  is the retry token the narrow write one?
 *
 * The digest is bounded: per failed job, its name, step key, the command that
 * was running, the failing tests with the first lines of their error, the
 * runner's summary, and the exit line. When no known marker matches, the last
 * lines before the job ended stand in.
 *
 * Then the history: how many of this branch's recent builds were red, and
 * which failing files are also red on the pipeline's other branches right
 * now. A test that fails on main or on an unrelated PR is not the diff's
 * fault. On 2026-09-29 rulo parked PR #1814 after two reds on a
 * library-merge timeout that unrelated PR #1809 hit too; it found that out
 * by hand, and the rule it followed had no way to count it.
 *
 * Then, when the ci-doctor has run, a `known:` line under each failing test
 * the doctor's store already recognises — a confirmed flake with its red count
 * and open fix PR, a main-red regression naming the build the test went red
 * on — and a `known infra:` section for open incidents. That store is a local
 * file (`<git-common-dir>/ralph/ci-health.json`), so this costs no API call,
 * and a missing or unreadable one changes neither the digest nor the exit code.
 *
 * The token is `RALPH_BUILDKITE_READ_TOKEN`: a dedicated token with only
 * `read_builds` and `read_build_logs`, which the supervisor exports once
 * `--check-token` has passed. The project's own `BUILDKITE_API_TOKEN` is
 * withheld from the loop and never read here (see README "Buildkite logs").
 *
 * `--check-retry-token` checks a SECOND, separate token,
 * `RALPH_BUILDKITE_RETRY_TOKEN`, whose one scope is `write_builds`: the
 * ci-doctor's gate retries a candidate flake's failed job with it
 * (`ci-doctor/retry.ts`), the pr-medic's gate declares it for the same purpose
 * (felipearos/ralph#245), and no model session is ever handed it. Nothing in
 * this file reads it for any other purpose, and `--check-token` does not read
 * it at all — the read token stays read-only.
 * It is never printed. The organization and pipeline come from a build URL
 * when one is given, else `RALPH_BUILDKITE_ORG` / `RALPH_BUILDKITE_PIPELINE`;
 * the pipeline defaults to the project's `buildkite/<slug>` required check and
 * the organization to the one its recent builds of that pipeline are under.
 *
 * `--job` exists because the digest reads failed jobs only, and some evidence
 * lives in a job that passed: #1898's per-step timings were printed by a green
 * e2e job, and the loop parked the ticket because nothing here would open it.
 *
 * Exit: 0 digest or `--job` log printed (a passing build included), 1 no token,
 * nothing to resolve against or no job matching `--job`, 2 Buildkite or
 * GitHub could not be read, 3 the token is not read-only (`--check-token`) or
 * not exactly `write_builds` (`--check-retry-token`), 64 usage.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { knownNotes, type FailureRef, type KnownNotes } from "./ci-doctor/known";
import { identify, readStore as readCiHealthStore, storePathFromGit as ciHealthStorePath } from "./ci-doctor/store";
import { projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { parseCheck } from "./pr-wait";

export const API = "https://api.buildkite.com/v2";
const REQUEST_TIMEOUT_MS = 60_000;

/* --------------------------------------------------------------------------
 * Log cleaning and the digest. Pure.
 * ----------------------------------------------------------------------- */

// CSI (colours, cursor show/hide), OSC and APC (`\x1b_bk;t=…\x07`, Buildkite's
// timestamps), then any bare timestamp an earlier strip left behind.
// oxlint-disable-next-line no-control-regex -- matching escapes is the point
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07|\x1b[()][A-Za-z0-9]|_bk;t=\d+\x07?/g;

/** The log as a terminal would have shown it: no escapes, `\r` overwrites applied. */
export function cleanLog(raw: string): string {
  return raw
    .replace(ESCAPES, "")
    // oxlint-disable-next-line no-control-regex -- a stray ESC the patterns missed
    .replace(/\x1b/g, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/\r+$/, "");
      if (!trimmed.includes("\r")) return trimmed;
      const segments = trimmed.split("\r").filter((segment) => segment !== "");
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}

export interface Failure {
  /** `FAIL  file > suite > test`, `● Suite › test`, a playwright title, a tsc error. */
  title: string;
  /** The first lines of its error, trimmed. */
  detail: string[];
  /**
   * The test file this failure is in, when the title does not already name it:
   * a jest `●` block takes it from the `FAIL <path>` header jest prints above
   * that file's blocks (#237). Absent for every other shape — vitest and
   * playwright titles carry their own path, and a tsc or eslint failure is not
   * a test. `ci-doctor/store.ts`'s `identify` reads it, which is what lets a
   * job that ran hundreds of files still key a failure by its file.
   */
  file?: string;
}

export interface Digest {
  /** The last `$ <command>` before the first failure: which suite or script it was. */
  command: string | null;
  failures: Failure[];
  /** The runner's own totals: `❯ file (N tests | M failed)`, `Test Files …`, `Tests: …`. */
  summary: string[];
  /** `error: script "x" exited with code N` and the agent's own exit line. */
  exit: string[];
  /** The failing test files, as the runner named them (relative to where it ran). */
  files: string[];
  /** Only when nothing above matched: the last lines before the job ended. */
  tail: string[];
  /** Every failure is a timeout — a flake candidate, not proof of one. */
  timeoutsOnly: boolean;
}

export const LIMITS = { failures: 12, detail: 4, summary: 12, tail: 25, width: 240 } as const;

const clip = (line: string): string => {
  const flat = line.replace(/\s+$/, "");
  return flat.length > LIMITS.width ? `${flat.slice(0, LIMITS.width - 1)}…` : flat;
};

// vitest's `Hook timed out in 10000ms` is a beforeAll/afterAll that ran out of
// time, the same host-load flake as a test that did: build 2626 was all hook
// and test timeouts, and without this the digest called it a real error.
export const TIMEOUT = /(?:Test|Hook) timed out in \d+ ?ms|Exceeded timeout of \d+ ?ms|Test timeout of \d+ ?ms exceeded|Timeout of \d+ ?ms exceeded|thrown: "Exceeded timeout/i;

/** A line that starts a failure block, and the title it carries. */
function failureTitle(line: string): string | null {
  // vitest's detail section: ` FAIL  src/x.test.ts > suite > test`. The
  // per-file progress line (`FAIL  src/x.test.ts`) carries no `>` and is
  // left to the summary, so a file is not counted twice.
  const vitest = /^\s*FAIL\s+(\S.*\s>\s.+)$/.exec(line);
  if (vitest) return `FAIL ${vitest[1]!.trim()}`;
  // vitest, a file that failed as a whole (an import or setup error).
  const suite = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\[/.exec(line);
  if (suite) return `FAIL ${suite[1]!} (whole file)`;
  // vitest's run-level errors: `⎯⎯ Startup Error ⎯⎯`, `⎯⎯ Unhandled Errors ⎯⎯`.
  const run = /^\s*⎯+\s+(Startup Error|Unhandled Errors?|Unhandled Rejection)\s+⎯+/.exec(line);
  if (run) return `vitest: ${run[1]!}`;
  // jest: `  ● Suite › test`. Console blocks share the bullet.
  const jest = /^\s*●\s+(.+›.+)$/.exec(line);
  if (jest && !/^\s*●\s+Console/.test(line)) return `● ${jest[1]!.trim()}`;
  // playwright's list of failures: `  1) [chromium] › e2e/a.spec.ts:12:5 › title`.
  const playwright = /^\s*\d+\)\s+(\[[^\]]+\]\s+›\s+.+)$/.exec(line);
  if (playwright) return playwright[1]!.trim();
  return null;
}

/** A line that ends a failure block's detail. */
const DETAIL_END = /^\s*$|^\s*❯\s|^\s*⎯|^\s*at\s|^\s*\d+\s*\|/;

/**
 * jest's per-file header — ` FAIL  app/components/__tests__/x.test.tsx (5.1 s)`
 * — which it prints above that file's `●` blocks. It is the only place a jest
 * failure's path appears, so `digestLog` reads it for the blocks that follow
 * (#237), and `SUMMARY` below keeps the line itself. ONE regex for both, so
 * that adding jest's next extension cannot teach one of them a file the other
 * does not recognise.
 *
 * vitest's per-file progress line has the same shape. Tracking it costs
 * nothing: a vitest failure names its file in its own title, and that branch
 * wins in `identify`.
 */
const TEST_FILE_HEADER = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:\(|$)/;

const SUMMARY = [
  /^\s*❯\s+\S+\s+\(\d+ tests? \| \d+ failed\)/, // vitest, per file
  /^\s*Test Files\s+\d+ failed/, // vitest
  /^\s*Tests\s+\d+ failed/, // vitest
  /^\s*Test Suites:\s+\d+ failed/, // jest
  /^\s*Tests:\s+\d+ failed/, // jest
  TEST_FILE_HEADER, // jest per file
  /^\s*\d+ failed\s*$/, // playwright
  /^\s*✘\s+/, // playwright, per test
  /^\s*✖ \d+ problems? \([1-9]\d* errors?/, // eslint
  /^Found \d+ errors? in /, // tsc
];

const TSC = /^\S.*\(\d+,\d+\): error TS\d+:|^\S+:\d+:\d+ - error TS\d+:/;
const ESLINT_ERROR = /^\s+\d+:\d+\s+error\s+/;

const EXIT = [
  /^\s*error: script "[^"]+" exited with code \d+/,
  /Error: The command exited with status \d+/,
  /^\s*(?:ERROR: )?Process completed with exit code \d+/,
];

/** The job ended here; Buildkite's hooks follow. */
const JOB_END = /^\s*~~~ Running (?:repository|global|plugin) [\w-]*\s*pre-exit hook|^\s*user command error:/;

const COMMAND = /^\s*\$ (\S.*)$/;

export function digestLog(log: string): Digest {
  const lines = log.split("\n");
  const failures: Failure[] = [];
  const seen = new Set<string>();
  const summary: string[] = [];
  const exit: string[] = [];
  let command: string | null = null;
  let firstFailureCommand: string | null | undefined;
  let lastEslintFile: string | null = null;
  let lastTestFile: string | null = null;

  // Deduped on the title AND the file, not the title alone: two test files in
  // one job can share a describe title, and before #237 the second one's block
  // was dropped as a repeat of the first — which is how a case key came to
  // collide across files. Keyed by title alone it would now be worse than that:
  // the surviving row would carry the FIRST file, naming a file the failure is
  // not in, and `greenNextWithoutTouching` would test the wrong path.
  const addFailure = (title: string, detail: string[], file?: string | null): void => {
    const id = `${file ?? ""}\u0000${title}`;
    if (seen.has(id)) return;
    seen.add(id);
    failures.push({ title: clip(title), detail: detail.map(clip), ...(file ? { file } : {}) });
    if (firstFailureCommand === undefined) firstFailureCommand = command;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const cmd = COMMAND.exec(line);
    if (cmd) {
      command = cmd[1]!.trim();
      continue;
    }
    const header = TEST_FILE_HEADER.exec(line);
    if (header) lastTestFile = header[1]!;
    const title = failureTitle(line);
    if (title !== null) {
      const detail: string[] = [];
      for (let j = i + 1; j < lines.length && detail.length < LIMITS.detail; j += 1) {
        const next = lines[j]!;
        if (detail.length > 0 && DETAIL_END.test(next)) break;
        if (next.trim() === "") continue;
        // playwright/jest put the error one blank line down; stop at the next block.
        if (failureTitle(next) !== null || DETAIL_END.test(next)) break;
        detail.push(next.trim());
      }
      // Only a jest block needs the header's path: every other title carries
      // its own, and attaching a stale one to, say, a vitest startup error
      // would claim a file the error is not in.
      addFailure(title, detail, title.startsWith("● ") ? lastTestFile : null);
      continue;
    }
    if (TSC.test(line)) {
      addFailure(line.trim(), []);
      continue;
    }
    if (/^\/\S+\.[cm]?[jt]sx?$/.test(line.trim())) lastEslintFile = line.trim();
    if (ESLINT_ERROR.test(line)) {
      addFailure(lastEslintFile ? `${lastEslintFile}: ${line.trim()}` : line.trim(), []);
      continue;
    }
    if (SUMMARY.some((pattern) => pattern.test(line))) {
      const entry = clip(line.trim());
      if (!summary.includes(entry)) summary.push(entry);
      if (firstFailureCommand === undefined && /failed|problems|errors?|✘/.test(line)) firstFailureCommand = command;
      continue;
    }
    if (EXIT.some((pattern) => pattern.test(line))) {
      const entry = clip(line.trim());
      if (!exit.includes(entry)) exit.push(entry);
    }
  }

  let tail: string[] = [];
  if (failures.length === 0 && summary.length === 0) {
    const end = lines.findIndex((line) => JOB_END.test(line));
    const upto = end === -1 ? lines.length : end;
    tail = lines
      .slice(0, upto)
      .filter((line) => line.trim() !== "" && !/^\s*\^\^\^ \+\+\+\s*$/.test(line))
      .slice(-LIMITS.tail)
      .map(clip);
  }

  const files: string[] = [];
  const addFile = (file: string | undefined): void => {
    if (file && !files.includes(file)) files.push(file);
  };
  for (const failure of failures) addFile(/^FAIL (\S+) (?:>|\(whole file\))/.exec(failure.title)?.[1]);
  for (const line of summary) {
    addFile(/^❯\s+(\S+)\s+\(\d+ tests? \| \d+ failed\)/.exec(line)?.[1] ?? /^FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/.exec(line)?.[1]);
  }

  const withDetail = failures.filter((failure) => failure.detail.length > 0);
  return {
    command: firstFailureCommand ?? null,
    failures,
    summary: summary.slice(0, LIMITS.summary),
    exit,
    files,
    tail,
    timeoutsOnly:
      withDetail.length > 0 &&
      withDetail.length === failures.length &&
      withDetail.every((failure) => failure.detail.some((line) => TIMEOUT.test(line))),
  };
}

/* --------------------------------------------------------------------------
 * Builds and jobs.
 * ----------------------------------------------------------------------- */

export interface Job {
  id: string;
  type: string;
  name: string | null;
  state: string;
  step_key?: string | null;
  exit_status?: number | null;
  soft_failed?: boolean;
  retried?: boolean;
  web_url?: string | null;
  /**
   * Did the job's own commands run? Only a source whose log lacks Buildkite's
   * `~~~ Running commands` marker (GitHub Actions) sets it; unset, the
   * ci-doctor reads the marker as before.
   */
  ran?: boolean;
}

export interface Build {
  number: number;
  state: string;
  branch?: string;
  commit?: string;
  web_url?: string;
  pull_request?: { id?: string | null } | null;
  jobs?: Job[];
}

const FAILED_STATES = new Set(["failed", "timed_out", "canceled", "expired", "errored"]);

/** Script jobs that failed and count: not soft-failed, not superseded by a retry. */
export function failedJobs(build: Build): Job[] {
  return (build.jobs ?? []).filter(
    (job) => job.type === "script" && FAILED_STATES.has(job.state) && !job.soft_failed && !job.retried,
  );
}

/** How many recent builds the history reads, and how many other branches' logs it opens. */
export const HISTORY = { branchBuilds: 20, recentBuilds: 30, otherLogs: 6 } as const;

const FINISHED_STATES = new Set(["passed", "failed", "timed_out", "canceled", "errored"]);

export interface OtherBuild {
  number: number;
  branch: string;
  /** The failing files its failed jobs' logs name. */
  files: string[];
}

export interface History {
  branch: string | null;
  /** This branch's recent finished builds, and how many of them were red. */
  branchFinished: number;
  branchRed: number;
  /** Each failing file here that is also red on another branch, with those builds. */
  elsewhere: { file: string; builds: { number: number; branch: string }[] }[];
  /** Other branches' red builds whose logs were read. */
  scanned: number;
  /** Why the history is partial or missing; the digest above stands either way. */
  error: string | null;
}

/** Count a branch's recent finished builds and its red ones. */
export function branchRecord(builds: readonly Build[]): { finished: number; red: number } {
  const finished = builds.filter((build) => FINISHED_STATES.has(build.state));
  return { finished: finished.length, red: finished.filter((build) => FAILED_STATES.has(build.state)).length };
}

/** Other branches' red builds worth opening, newest first: not this build, not this branch. */
export function otherRedBuilds(builds: readonly Build[], self: Build, limit: number = HISTORY.otherLogs): Build[] {
  return builds
    .filter((build) => build.number !== self.number && build.branch && build.branch !== self.branch)
    .filter((build) => FAILED_STATES.has(build.state))
    .slice(0, limit);
}

/** Which of `files` fail on the other builds too. */
export function crossReference(files: readonly string[], others: readonly OtherBuild[]): History["elsewhere"] {
  return files
    .map((file) => ({
      file,
      builds: others.filter((other) => other.files.includes(file)).map(({ number, branch }) => ({ number, branch })),
    }))
    .filter((entry) => entry.builds.length > 0);
}

export interface BuildRef {
  org: string | null;
  pipeline: string | null;
  number: number;
}

const BUILD_URL = /buildkite\.com\/([^/\s]+)\/([^/\s]+)\/builds\/(\d+)/;

/** `2425`, `#2425`, or a build (or job) URL. */
export function parseBuildRef(arg: string): BuildRef | null {
  const url = BUILD_URL.exec(arg);
  if (url) return { org: url[1]!, pipeline: url[2]!, number: Number(url[3]) };
  const bare = /^#?(\d+)$/.exec(arg.trim());
  return bare ? { org: null, pipeline: null, number: Number(bare[1]) } : null;
}

/** The pipeline slug a `buildkite/<slug>` required check names, if exactly one does. */
export function pipelineFromChecks(checks: readonly string[]): string | null {
  const slugs = checks.map((name) => /^buildkite\/([\w.-]+)$/.exec(name.trim())?.[1]).filter(Boolean) as string[];
  return slugs.length === 1 ? slugs[0]! : null;
}

/** The build URL a PR's buildkite check links to, preferring `buildkite/<pipeline>`. */
export function buildUrlFromRollup(rollup: unknown, pipeline: string | null): string | null {
  const checks = (Array.isArray(rollup) ? rollup : [])
    .map(parseCheck)
    .filter((check) => check !== null && check.url !== null && BUILD_URL.test(check.url));
  const preferred = pipeline === null ? undefined : checks.find((check) => check!.name === `buildkite/${pipeline}`);
  const any = preferred ?? checks.find((check) => check!.name.startsWith("buildkite")) ?? checks[0];
  return any?.url ?? null;
}

/** The token the helper reads, or null. Never logged. */
export function tokenFrom(env: NodeJS.ProcessEnv): string | null {
  const token = env.RALPH_BUILDKITE_READ_TOKEN?.trim();
  return token ? token : null;
}

/**
 * The RETRY token, or null. A different variable from `tokenFrom`'s on
 * purpose: the two credentials are checked against opposite rules and only
 * one of them ever reaches a model session, so a caller that confused them
 * would hand the write token to the wrong process.
 */
export function retryTokenFrom(env: NodeJS.ProcessEnv): string | null {
  const token = env.RALPH_BUILDKITE_RETRY_TOKEN?.trim();
  return token ? token : null;
}

/** Scopes that let a token change anything. A read-only token has none. */
export function writeScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !scope.startsWith("read_"));
}

/* --------------------------------------------------------------------------
 * Output.
 * ----------------------------------------------------------------------- */

export interface JobReport {
  job: Job;
  url: string | null;
  digest: Digest | null;
  error: string | null;
  saved: string | null;
}

export function formatHistory(history: History): string[] {
  const out = ["", "history:"];
  if (history.branch !== null && history.branchFinished > 0) {
    out.push(`   this branch: ${history.branchRed} red of its last ${history.branchFinished} finished builds`);
  }
  for (const { file, builds } of history.elsewhere) {
    const list = builds.map((build) => `#${build.number} ${build.branch}`).join(", ");
    const main = builds.some((build) => /^(?:main|master)$/.test(build.branch)) ? " — main included" : "";
    out.push(`   also red on other branches: ${file} (${list})${main}`);
  }
  if (history.scanned > 0 && history.elsewhere.length === 0) {
    out.push(`   no failing file here is red in the ${history.scanned} other red build${history.scanned === 1 ? "" : "s"} read`);
  }
  if (history.error) out.push(`   partial: ${history.error}`);
  return out.length > 2 ? out : [];
}

/**
 * What the ci-doctor's store already knows about this build's failures: the
 * `known:` lines, and the open infra incidents.
 *
 * No network call — the store is a local file beside the claim and host
 * leases. Null when there is nothing to say, so that a project with no doctor
 * running (every project, until one is onboarded) gets the digest it got
 * before: no store, an unreadable store and a store that knows none of these
 * tests are all indistinguishable here, by design.
 */
export function readKnown(build: Build, reports: readonly JobReport[], env: NodeJS.ProcessEnv): KnownNotes | null {
  try {
    const store = readCiHealthStore(ciHealthStorePath(projectRoot(process.cwd(), env)));
    const failures: FailureRef[] = [];
    for (const { digest } of reports) {
      if (digest === null) continue;
      // Every failure, not the LIMITS.failures slice the printer truncates to:
      // a verdict is cheap and the truncated ones still reach --json.
      for (const failure of digest.failures) failures.push({ title: failure.title, files: digest.files, file: failure.file ?? null });
    }
    // `felipearos/loggd` → `loggd`: the slug is what a human reads an issue
    // reference as, and it is the project's own name on both GitHub and here.
    const repo = projectFacts(env).repo ?? "";
    const slash = repo.indexOf("/");
    const notes = knownNotes(store, failures, {
      branch: build.branch ?? null,
      repoSlug: slash === -1 ? null : repo.slice(slash + 1),
    });
    return Object.keys(notes.byTestId).length === 0 && notes.incidents.length === 0 ? null : notes;
  } catch {
    // A path that could not be resolved is not a reason to fail a log read.
    return null;
  }
}

/**
 * The store's open infra incidents, or nothing when it holds none. Only that
 * section: the per-test `known:` lines are printed inline below, beside the
 * failure they judge.
 */
export function formatKnownInfra(known: KnownNotes): string[] {
  if (known.incidents.length === 0) return [];
  return ["", "known infra:", ...known.incidents.map((line) => `   ${line}`)];
}

/**
 * One job's digest, as the lines under its `== name` header: the command, the
 * failing files and tests (with the ci-doctor's `known:` verdicts), the
 * summary, the tail and the exit line. Shared with `gh-actions-log.ts`, so a
 * session reads a Buildkite job and a GitHub Actions job the same way.
 */
export function formatDigest(digest: Digest, known: KnownNotes | null = null): string[] {
  const out: string[] = [];
  if (digest.command) out.push(`   command: $ ${digest.command}`);
  if (digest.files.length > 0) out.push(`   failing files: ${digest.files.join(" ")}`);
  if (digest.failures.length > 0) {
    out.push(
      digest.timeoutsOnly
        ? "   kind: timeout only — a flake candidate if the test is unrelated to the diff"
        : "   kind: error, not a timeout — reproduce it with the command above, on the failing file",
    );
    out.push("   failures:");
    // Resolved through `identify`, not looked up by title: that is what makes
    // a verdict belong to the test it was recorded against (see `byTestId`).
    const verdicts = (failure: Failure): string[] =>
      known?.byTestId[identify(failure.title, digest.files, failure.file).testId] ?? [];
    for (const failure of digest.failures.slice(0, LIMITS.failures)) {
      // The file only when the title does not already name it: a jest block
      // says `● Suite › test` and nothing else, and a doctor that has to
      // search for the file before it can fix anything is #237's complaint.
      //
      // A SUFFIX, not the `FAIL <file> > <test>` shape `gate.ts`'s `testIdOf`
      // parses, which is a known limit rather than an oversight: a blocked
      // loop quoting this line gives `testIdOf` the file alone, so
      // `actionable` looks up `flake:<file>` and misses the `flake:<file> >
      // <test>` case key. That missed the same way before #237 (it resolved
      // to null), so nothing regresses; closing it means changing the line a
      // human reads, which is its own ticket.
      out.push(`   - ${failure.title}${failure.file ? ` — ${failure.file}` : ""}`);
      // The doctor's verdict first, then the error text that is its evidence.
      for (const line of verdicts(failure)) out.push(`       known: ${line}`);
      for (const line of failure.detail) out.push(`       ${line}`);
    }
    const hidden = digest.failures.slice(LIMITS.failures);
    if (hidden.length > 0) {
      // Say how many of the hidden ones the doctor knows. §5.4 asks a coder
      // whether EVERY failure is a flake, and without this a store-known
      // flake past the cap is answerable only from `--json`.
      const knownHidden = hidden.filter((failure) => verdicts(failure).length > 0).length;
      const judged = knownHidden > 0 ? `${knownHidden} known to the ci-doctor; ` : "";
      out.push(`   … ${hidden.length} more (${judged}--full for the whole log)`);
    }
  }
  if (digest.summary.length > 0) {
    out.push("   summary:");
    for (const line of digest.summary) out.push(`     ${line}`);
  }
  if (digest.tail.length > 0) {
    out.push("   no known failure marker; the last lines before the job ended:");
    for (const line of digest.tail) out.push(`     ${line}`);
  }
  for (const line of digest.exit) out.push(`   exit: ${line}`);
  return out;
}

export function formatReport(
  build: Build,
  reports: JobReport[],
  total: number,
  history: History | null = null,
  known: KnownNotes | null = null,
): string {
  const out: string[] = [];
  const pr = build.pull_request?.id ? ` (PR #${build.pull_request.id})` : "";
  const commit = build.commit ? ` @ ${build.commit.slice(0, 10)}` : "";
  out.push(`Build #${build.number} ${build.state} — ${build.branch ?? "?"}${commit}${pr}`);
  if (build.web_url) out.push(build.web_url);
  if (reports.length === 0) {
    out.push(
      FAILED_STATES.has(build.state)
        ? `no failed script job of ${total} (a soft-failed, retried or non-script step?)`
        : `no failed jobs (of ${total})`,
    );
    out.push("a passing job's output: --job <step-key> [--grep <regex>]");
    return out.join("\n");
  }
  out.push(`${reports.length} failed job${reports.length === 1 ? "" : "s"} (of ${total})`);
  for (const { job, url, digest, error, saved } of reports) {
    out.push("");
    const key = job.step_key ? ` [${job.step_key}]` : "";
    const status = job.exit_status === null || job.exit_status === undefined ? "" : `, exit ${job.exit_status}`;
    out.push(`== ${job.name ?? job.id}${key} — ${job.state}${status}`);
    if (url) out.push(`   ${url}`);
    if (saved) out.push(`   full log: ${saved}`);
    if (error) {
      out.push(`   log unreadable: ${error}`);
      continue;
    }
    if (digest === null) continue;
    out.push(...formatDigest(digest, known));
  }
  // Before the history: a recorded verdict outranks a count of red builds.
  if (known !== null) out.push(...formatKnownInfra(known));
  if (history !== null) out.push(...formatHistory(history));
  return out.join("\n");
}

/* --------------------------------------------------------------------------
 * I/O.
 * ----------------------------------------------------------------------- */

export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "HelperError";
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class Buildkite {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  /**
   * Every request, with the one error vocabulary. `method` appears in the
   * failure only when it is not a GET, so a read's message is unchanged.
   */
  private async request(path: string, method: "GET" | "PUT", accept: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${API}${path}`, {
        ...(method === "GET" ? {} : { method }),
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new HelperError(`Buildkite unreachable: ${error instanceof Error ? error.message : String(error)}`, 2);
    }
    if (!response.ok) {
      let message = "";
      try {
        message = ((await response.json()) as { message?: string }).message ?? "";
      } catch {
        // Not JSON; the status says enough.
      }
      // A write can be refused for want of the scope as well as the token, and
      // 403 is how Buildkite says so.
      const wrong = response.status === 401 || (method === "PUT" && response.status === 403);
      const why = method === "PUT" ? "missing, wrong, revoked or not write_builds" : "missing, wrong or revoked";
      const hint = wrong ? ` (the token is ${why})` : "";
      const where = method === "GET" ? path : `${method} ${path}`;
      throw new HelperError(`Buildkite ${response.status} on ${where}${message ? `: ${message}` : ""}${hint}`, 2);
    }
    return response;
  }

  private async get(path: string, accept = "application/json"): Promise<Response> {
    return this.request(path, "GET", accept);
  }

  async json<T>(path: string): Promise<T> {
    return (await (await this.get(path)).json()) as T;
  }

  /**
   * The one write this helper can make: `PUT`, no body, the response thrown
   * away. It exists for `ci-doctor/retry.ts`, whose token is the only one that
   * could succeed at it — the read token's own check refuses any write scope,
   * so a read-token caller gets a 401 or 403 from Buildkite rather than a retry.
   */
  async put(path: string): Promise<void> {
    await this.request(path, "PUT", "application/json");
  }

  async text(path: string): Promise<string> {
    return (await this.get(path, "text/plain")).text();
  }
}

export interface Options {
  build: string | null;
  pr: string | null;
  branch: string | null;
  full: string | null;
  json: boolean;
  checkToken: boolean;
  checkRetryToken: boolean;
  history: boolean;
  job: string | null;
  grep: RegExp | null;
}

export const USAGE =
  "usage: bk-log.ts <build-number|build-url> | --pr <n> | --branch <name>  [--full <dir>] [--json] [--no-history]\n" +
  "       bk-log.ts <build-number|build-url> | --pr <n> | --branch <name>  --job <step-key|id|name> [--grep <regex>] [--full <dir>]\n" +
  "       bk-log.ts --check-token | --check-retry-token";

export function parseArgs(argv: string[]): Options | string {
  const options: Options = {
    build: null, pr: null, branch: null, full: null, json: false, checkToken: false, checkRetryToken: false, history: true,
    job: null, grep: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--pr":
      case "--branch":
      case "--full":
      case "--job":
      case "--grep":
        if (!value || value.startsWith("--")) return `${arg} needs a value`;
        i += 1;
        if (arg === "--pr") options.pr = value.replace(/^#/, "");
        else if (arg === "--branch") options.branch = value;
        else if (arg === "--job") options.job = value;
        else if (arg === "--grep") {
          try {
            options.grep = new RegExp(value);
          } catch {
            return `--grep is not a valid regex: ${value}`;
          }
        } else options.full = value;
        break;
      case "--json":
        options.json = true;
        break;
      case "--check-token":
        options.checkToken = true;
        break;
      case "--check-retry-token":
        options.checkRetryToken = true;
        break;
      case "--no-history":
        options.history = false;
        break;
      case "-h":
      case "--help":
        return "help";
      default:
        if (arg.startsWith("-")) return `unknown flag ${arg}`;
        if (options.build !== null) return `one build at a time, got ${options.build} and ${arg}`;
        options.build = arg;
    }
  }
  const targets = [options.build, options.pr, options.branch].filter((target) => target !== null).length;
  if (options.checkToken && options.checkRetryToken) return "name one of --check-token and --check-retry-token";
  // The two checks read different variables and judge them by opposite rules,
  // so there is no one answer to give when both are asked for.
  if (options.checkToken) return targets === 0 ? options : "--check-token takes no build";
  if (options.checkRetryToken) return targets === 0 ? options : "--check-retry-token takes no build";
  if (targets !== 1) return "name one build: a number, a build URL, --pr <n> or --branch <name>";
  if (options.grep !== null && options.job === null) return "--grep reads one job's log; name it with --job";
  if (options.job !== null && options.json) return "--job prints the log itself; --json is for the digest";
  if (options.pr !== null && !/^\d+$/.test(options.pr)) return `--pr needs a PR number, got ${options.pr}`;
  return options;
}

/**
 * The project's repo and required checks: what `ralph.sh` exports, else the
 * project's `.ralph/config.json`, so a run by hand from a checkout works too.
 */
export function projectFacts(env: NodeJS.ProcessEnv): { repo: string | null; checks: string[] } {
  let repo = env.RALPH_PROJECT_REPO?.trim() || null;
  let checks = (env.RALPH_REQUIRED_CHECKS ?? "").split("\n").filter((name) => name.trim() !== "");
  if (repo === null || checks.length === 0) {
    try {
      const config = loadProjectConfig(projectRoot(process.cwd(), env));
      repo ??= config.repo;
      if (checks.length === 0) checks = config.requiredChecks;
    } catch {
      // Not in a project: a build URL, or the RALPH_BUILDKITE_* overrides, still work.
    }
  }
  return { repo, checks };
}

function prBuildUrl(pr: string, env: NodeJS.ProcessEnv, pipeline: string | null): string {
  const args = ["pr", "view", pr, "--json", "statusCheckRollup"];
  const { repo } = projectFacts(env);
  if (repo) args.push("--repo", repo);
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new HelperError(`gh pr view ${pr} failed: ${(result.stderr || result.error?.message || "").trim()}`, 2);
  }
  let rollup: unknown;
  try {
    rollup = (JSON.parse(result.stdout) as { statusCheckRollup?: unknown }).statusCheckRollup;
  } catch {
    throw new HelperError(`gh pr view ${pr}: unparseable output`, 2);
  }
  const url = buildUrlFromRollup(rollup, pipeline);
  if (url === null) throw new HelperError(`PR #${pr} has no Buildkite check with a build link yet`, 1);
  return url;
}

export function configuredPipeline(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.RALPH_BUILDKITE_PIPELINE?.trim();
  if (explicit) return explicit;
  return pipelineFromChecks(projectFacts(env).checks);
}

/**
 * The organization, when nothing named it. A token with only `read_builds` and
 * `read_build_logs` cannot list organizations, but it can list recent builds,
 * and a build of this pipeline carries its organization in its URL.
 */
export async function resolveOrg(api: Buildkite, env: NodeJS.ProcessEnv, pipeline: string): Promise<string> {
  const explicit = env.RALPH_BUILDKITE_ORG?.trim();
  if (explicit) return explicit;
  const builds = await api.json<Build[]>("/builds?per_page=30").catch(() => [] as Build[]);
  const orgs = new Set(
    builds
      .map((build) => parseBuildRef(build.web_url ?? ""))
      .filter((ref) => ref !== null && ref.pipeline === pipeline)
      .map((ref) => ref!.org!),
  );
  if (orgs.size === 1) return [...orgs][0]!;
  const listed = await api.json<{ slug: string }[]>("/organizations").catch(() => []);
  if (listed.length === 1) return listed[0]!.slug;
  throw new HelperError("which Buildkite organization? set RALPH_BUILDKITE_ORG, or pass a build URL", 1);
}

export async function resolveBuild(
  options: Options,
  api: Buildkite,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ org: string; pipeline: string; number: number }> {
  const pipeline = configuredPipeline(env);
  let ref: BuildRef | null;
  if (options.pr !== null) {
    ref = parseBuildRef(prBuildUrl(options.pr, env, pipeline));
  } else if (options.build !== null) {
    ref = parseBuildRef(options.build);
    if (ref === null) throw new HelperError(`not a build number or build URL: ${options.build}`, 64);
  } else {
    ref = { org: null, pipeline: null, number: 0 };
  }
  const slug = ref!.pipeline ?? pipeline;
  if (slug === null) {
    throw new HelperError("which pipeline? set RALPH_BUILDKITE_PIPELINE, or pass a build URL", 1);
  }
  const org = ref!.org ?? (await resolveOrg(api, env, slug));
  if (options.branch !== null) {
    const builds = await api.json<Build[]>(
      `/organizations/${org}/pipelines/${slug}/builds?branch=${encodeURIComponent(options.branch)}&per_page=1`,
    );
    if (builds.length === 0) throw new HelperError(`no ${slug} build for branch ${options.branch}`, 1);
    return { org, pipeline: slug, number: builds[0]!.number };
  }
  return { org, pipeline: slug, number: ref!.number };
}

/**
 * This branch's red count, and the failing files that other branches' recent
 * red builds share. Bounded: two build lists and at most `HISTORY.otherLogs`
 * builds' logs, only the jobs on the steps that failed here. Never throws: a
 * history it could not read says so and leaves the digest alone.
 */
export async function readHistory(
  api: Buildkite,
  org: string,
  pipeline: string,
  build: Build,
  reports: readonly JobReport[],
): Promise<History> {
  const history: History = { branch: build.branch ?? null, branchFinished: 0, branchRed: 0, elsewhere: [], scanned: 0, error: null };
  const base = `/organizations/${org}/pipelines/${pipeline}/builds`;
  const errors: string[] = [];
  if (build.branch) {
    try {
      const own = await api.json<Build[]>(`${base}?branch=${encodeURIComponent(build.branch)}&per_page=${HISTORY.branchBuilds}`);
      const record = branchRecord(own);
      history.branchFinished = record.finished;
      history.branchRed = record.red;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const files = [...new Set(reports.flatMap((report) => report.digest?.files ?? []))];
  const steps = new Set(reports.map((report) => report.job.step_key).filter(Boolean));
  if (files.length > 0) {
    try {
      const recent = await api.json<Build[]>(`${base}?per_page=${HISTORY.recentBuilds}`);
      const others: OtherBuild[] = [];
      for (const other of otherRedBuilds(recent, build)) {
        const jobs = failedJobs(other).filter((job) => steps.size === 0 || steps.has(job.step_key));
        const otherFiles: string[] = [];
        for (const job of jobs) {
          try {
            otherFiles.push(...digestLog(cleanLog(await api.text(`${base}/${other.number}/jobs/${job.id}/log`))).files);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        others.push({ number: other.number, branch: other.branch!, files: otherFiles });
      }
      history.scanned = others.length;
      history.elsewhere = crossReference(files, others);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) history.error = errors[0]! + (errors.length > 1 ? ` (+${errors.length - 1} more)` : "");
  return history;
}

/**
 * The script jobs `key` names — by step key, job id or exact name — in any
 * state, minus the ones a retry superseded (the retry is the job that counts).
 */
export function jobsNamed(build: Build, key: string): Job[] {
  return (build.jobs ?? []).filter(
    (job) => job.type === "script" && !job.retried && (job.step_key === key || job.id === key || job.name === key),
  );
}

/** `--grep`: the matching lines, each prefixed with its 1-based line number. */
export function grepLog(log: string, pattern: RegExp): string[] {
  const out: string[] = [];
  log.split("\n").forEach((line, index) => {
    if (pattern.test(line)) out.push(`${index + 1}: ${line}`);
  });
  return out;
}

const safeName = (value: string): string => value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";

/**
 * One job's cleaned log, saved under `full` when given. Parallel shards share a
 * step key, so a key that more than one of `jobs` carries gets the job id too —
 * otherwise each shard's file overwrites the last. Never throws: an unreadable
 * log (a job still waiting, skipped, or gone) is that job's `error`.
 */
async function readJobLog(
  api: Buildkite,
  base: string,
  number: number,
  job: Job,
  jobs: readonly Job[],
  full: string | null,
): Promise<{ log: string | null; saved: string | null; error: string | null }> {
  try {
    const log = cleanLog(await api.text(`${base}/jobs/${job.id}/log`));
    let saved: string | null = null;
    if (full !== null) {
      const key = job.step_key ?? job.id;
      const shared = jobs.filter((other) => (other.step_key ?? other.id) === key).length > 1;
      mkdirSync(full, { recursive: true });
      saved = join(full, `bk-${number}-${safeName(shared ? `${key}-${job.id}` : key)}.log`);
      writeFileSync(saved, log);
    }
    return { log, saved, error: null };
  } catch (error) {
    return { log: null, saved: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function run(
  options: Options,
  api: Buildkite,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string; json: unknown }> {
  const { org, pipeline, number } = await resolveBuild(options, api, env);
  const base = `/organizations/${org}/pipelines/${pipeline}/builds/${number}`;
  const build = await api.json<Build>(base);
  if (options.job !== null) return jobLogs(options, options.job, api, base, build);
  const failed = failedJobs(build);
  const reports: JobReport[] = [];
  for (const job of failed) {
    const url = job.web_url ?? (build.web_url ? `${build.web_url}#${job.id}` : null);
    const { log, saved, error } = await readJobLog(api, base, number, job, failed, options.full);
    reports.push({ job, url, digest: log === null ? null : digestLog(log), error, saved });
  }
  const total = (build.jobs ?? []).filter((job) => job.type === "script").length;
  const history = options.history && reports.length > 0 ? await readHistory(api, org, pipeline, build, reports) : null;
  // Unconditional, and not gated on --no-history: it costs no request, and an
  // open infra incident is worth knowing even on a build that passed.
  const known = readKnown(build, reports, env);
  return {
    text: formatReport(build, reports, total, history, known),
    json: {
      build: { org, pipeline, number, state: build.state, branch: build.branch, commit: build.commit, url: build.web_url },
      failed: reports.map(({ job, url, digest, error, saved }) => ({
        name: job.name,
        step: job.step_key ?? null,
        state: job.state,
        exit: job.exit_status ?? null,
        url,
        saved,
        error,
        ...digest,
      })),
      history,
      known,
    },
  };
}

/** `--job`: the named jobs' logs, whole or grepped, under the same `== name [key] — state` header the digest uses. */
async function jobLogs(
  options: Options,
  key: string,
  api: Buildkite,
  base: string,
  build: Build,
): Promise<{ text: string; json: unknown }> {
  const jobs = jobsNamed(build, key);
  if (jobs.length === 0) {
    const named = (build.jobs ?? [])
      .filter((job) => job.type === "script" && !job.retried)
      .map((job) => `${job.step_key ?? job.id} "${job.name ?? ""}" (${job.state})`);
    throw new HelperError(`no script job of build #${build.number} is named ${key}; its jobs: ${named.join(", ")}`, 1);
  }
  const out = [`Build #${build.number} ${build.state} — ${build.branch ?? "?"}`];
  for (const job of jobs) {
    const { log, saved, error } = await readJobLog(api, base, build.number, job, jobs, options.full);
    const step = job.step_key ? ` [${job.step_key}]` : "";
    const exit = job.exit_status === null || job.exit_status === undefined ? "" : `, exit ${job.exit_status}`;
    out.push("", `== ${job.name ?? job.id}${step} — ${job.state}${exit}`);
    if (saved) out.push(`   full log: ${saved}`);
    if (log === null) {
      out.push(`   log unreadable: ${error}`);
      continue;
    }
    const lines = options.grep === null ? [log] : grepLog(log, options.grep);
    out.push(...(lines.length > 0 ? lines : [`(no line matches ${options.grep})`]));
  }
  // The log is the output; there is no digest to put in JSON (parseArgs refuses --json with --job).
  return { text: out.join("\n"), json: null };
}

/**
 * The read scopes a loop's token should carry. `read_artifacts` is what lets a
 * loop pull a failed Playwright run's `-actual.png` to update a screenshot
 * baseline after an intended layout change; without it the loop parks the
 * ticket for a human (loggd #2013, 2026-10-06).
 */
export const READ_SCOPES = ["read_builds", "read_build_logs", "read_artifacts"] as const;

/** `--check-token`: usable, and without a single write scope. A missing read scope is named, not refused. */
export async function checkToken(api: Buildkite): Promise<{ code: number; message: string }> {
  const { scopes = [] } = await api.json<{ scopes?: string[] }>("/access-token");
  const writes = writeScopes(scopes);
  if (writes.length > 0) {
    return { code: 3, message: `the Buildkite token is not read-only (${writes.join(", ")}); refusing to use it` };
  }
  const missing = READ_SCOPES.filter((scope) => !scopes.includes(scope));
  const advice = missing.length === 0 ? "" : ` — missing ${missing.join(", ")}: add it to RALPH_BUILDKITE_READ_TOKEN's scopes`;
  return { code: 0, message: `Buildkite token ok, read-only (${scopes.join(", ") || "no scopes"})${advice}` };
}

/** The one scope the retry token may carry, and the only one it may carry. */
export const RETRY_SCOPE = "write_builds";

/**
 * `--check-retry-token`: the scope list is EXACTLY `["write_builds"]`.
 *
 * Exactly, not "includes": the gate acts with this token unattended, so
 * `write_builds` beside `write_pipelines` — or beside a read scope, which
 * would make it a drop-in for the read token — is a wider credential than the
 * doctor asked for, and a wider one is refused rather than used narrowly.
 */
export async function checkRetryToken(api: Buildkite): Promise<{ code: number; message: string }> {
  const { scopes = [] } = await api.json<{ scopes?: string[] }>("/access-token");
  if (scopes.length === 1 && scopes[0] === RETRY_SCOPE) {
    return { code: 0, message: `Buildkite retry token ok, ${RETRY_SCOPE} only` };
  }
  const writes = writeScopes(scopes);
  const found = scopes.length === 0 ? "no scopes" : scopes.join(", ");
  const why =
    writes.includes(RETRY_SCOPE)
      ? `it carries more than ${RETRY_SCOPE} (${found})`
      : `it does not carry ${RETRY_SCOPE} (${found})`;
  return { code: 3, message: `the Buildkite retry token is not exactly ${RETRY_SCOPE}: ${why}; refusing to use it` };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, fetcher?: Fetcher): Promise<number> {
  const options = parseArgs(argv);
  if (options === "help") {
    console.log(USAGE);
    return 0;
  }
  if (typeof options === "string") {
    console.error(`bk-log: ${options}\n${USAGE}`);
    return 64;
  }
  // Before the read token is looked for: `--check-retry-token` reads a
  // different variable, and a doctor host that has the retry token and not the
  // read one must still be able to prove it.
  if (options.checkRetryToken) {
    const retryToken = retryTokenFrom(env);
    if (retryToken === null) {
      console.error(
        "bk-log: no Buildkite retry token — RALPH_BUILDKITE_RETRY_TOKEN is not set. The supervisor reads it " +
          "for a ci-doctor loop and exports it to that role's intake gate alone; without it, the doctor runs " +
          "on natural reruns only.",
      );
      return 1;
    }
    try {
      const { code, message } = await checkRetryToken(new Buildkite(retryToken, fetcher));
      (code === 0 ? console.log : console.error)(`bk-log: ${message}`);
      return code;
    } catch (error) {
      if (error instanceof HelperError) {
        console.error(`bk-log: ${error.message}`);
        return error.code;
      }
      throw error;
    }
  }
  const token = tokenFrom(env);
  if (token === null) {
    console.error(
      "bk-log: no Buildkite token — RALPH_BUILDKITE_READ_TOKEN is not set. The supervisor exports it " +
        "at start when the secrets scope holds a read-only one; without it, CI logs are not readable from here.",
    );
    return 1;
  }
  const api = new Buildkite(token, fetcher);
  try {
    if (options.checkToken) {
      const { code, message } = await checkToken(api);
      (code === 0 ? console.log : console.error)(`bk-log: ${message}`);
      return code;
    }
    const result = await run(options, api, env);
    console.log(options.json ? JSON.stringify(result.json, null, 2) : result.text);
    return 0;
  } catch (error) {
    if (error instanceof HelperError) {
      console.error(`bk-log: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`bk-log: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
