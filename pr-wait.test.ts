// @vitest-environment node
/**
 * What `pr-wait.ts` promises the supervisor: an outcome for every ending, the
 * failing checks with their links on red, and never a green read off a head
 * the session did not push. The reader is injected, so the polling is under
 * test against sequences of real `gh pr view` shapes.
 */
import { describe, expect, it } from "vitest";

import {
  judgeCi,
  parseArgs,
  parseCheck,
  parseSnapshot,
  readSnapshot,
  relevantChecks,
  wait,
  type Gh,
  type Options,
  type PrSnapshot,
  type Read,
} from "./pr-wait";
import { MAX_CONSECUTIVE_FAILURES } from "./merge-wait";

const run = (name: string, status: string, conclusion: string | null = null) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://ci.example/${name}`,
});
const context = (name: string, state: string) => ({
  __typename: "StatusContext",
  context: name,
  state,
  targetUrl: `https://ci.example/${name}`,
});

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "OPEN",
  mergedAt: null,
  labels: [],
  head: "abc",
  checks: [],
  ...over,
});

const options = (over: Partial<Options> = {}): Options => ({
  pr: "7",
  mode: "ci",
  repo: null,
  head: null,
  required: [],
  ciTimeoutSeconds: 60,
  queueTimeoutSeconds: 60,
  intervalSeconds: 0,
  gracePolls: 2,
  labels: { queued: "queued", dequeued: "dequeued" },
  ...over,
});

/** A reader that answers from a list, repeating the last answer forever. */
const sequence = (reads: Array<PrSnapshot | "fail">): ((pr: string, repo: string | null) => Read) => {
  let i = 0;
  return () => {
    const next = reads[Math.min(i, reads.length - 1)]!;
    i += 1;
    return next === "fail" ? { ok: false, error: "boom" } : { ok: true, snapshot: next };
  };
};

describe("reading checks", () => {
  it.each([
    [run("build", "IN_PROGRESS"), "pending"],
    [run("build", "QUEUED"), "pending"],
    [run("build", "COMPLETED", "SUCCESS"), "pass"],
    [run("build", "COMPLETED", "SKIPPED"), "skip"],
    [run("build", "COMPLETED", "NEUTRAL"), "skip"],
    [run("build", "COMPLETED", "FAILURE"), "fail"],
    [run("build", "COMPLETED", "TIMED_OUT"), "fail"],
    [run("build", "COMPLETED", "CANCELLED"), "fail"],
    [context("buildkite/loggd", "PENDING"), "pending"],
    [context("buildkite/loggd", "SUCCESS"), "pass"],
    [context("buildkite/loggd", "FAILURE"), "fail"],
    [context("buildkite/loggd", "ERROR"), "fail"],
  ])("%o reads as %s", (raw, state) => {
    expect(parseCheck(raw)?.state).toBe(state);
  });

  it("parses the snapshot gh returns", () => {
    const parsed = parseSnapshot(
      JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        labels: [{ name: "queued" }],
        headRefOid: "abc",
        statusCheckRollup: [context("buildkite/loggd", "FAILURE")],
      }),
    );
    expect(parsed).toEqual({
      state: "OPEN",
      mergedAt: null,
      labels: ["queued"],
      head: "abc",
      checks: [{ name: "buildkite/loggd", state: "fail", url: "https://ci.example/buildkite/loggd" }],
    });
    expect(parseSnapshot("not json")).toBeNull();
    expect(parseSnapshot(JSON.stringify({ state: "WEIRD", labels: [] }))).toBeNull();
  });

  it("judges only the required checks, and a missing one is pending", () => {
    const checks = [
      { name: "Mergify Merge Queue", state: "pending" as const, url: null },
      { name: "Vercel", state: "pass" as const, url: null },
    ];
    expect(relevantChecks(checks, ["buildkite/loggd", "Vercel"])).toEqual([
      { name: "buildkite/loggd", state: "pending", url: null },
      { name: "Vercel", state: "pass", url: null },
    ]);
    expect(relevantChecks(checks, [])).toEqual(checks);
  });

  it.each([
    [[], 1, "wait"],
    [[], 2, "no-checks"],
    [[{ state: "pending" }, { state: "fail" }], 5, "wait"],
    [[{ state: "pass" }, { state: "fail" }], 1, "red"],
    [[{ state: "pass" }, { state: "skip" }], 1, "green"],
  ])("checks %o on poll %d → %s", (states, polls, verdict) => {
    const checks = states.map((check, i) => ({ name: `c${i}`, url: null, ...check })) as never;
    expect(judgeCi(checks, polls, 2)).toBe(verdict);
  });
});

describe("waiting", () => {
  it("waits out pending checks, then reports red with the failing check's link", async () => {
    const result = await wait(
      options({ required: ["buildkite/loggd"] }),
      sequence([
        snapshot({ checks: [] }),
        snapshot({ checks: [{ name: "buildkite/loggd", state: "pending", url: null }] }),
        snapshot({ checks: [{ name: "buildkite/loggd", state: "fail", url: "https://bk/1840" }] }),
      ]),
    );
    expect(result).toMatchObject({
      outcome: "red",
      polls: 3,
      checks: [{ name: "buildkite/loggd", state: "fail", url: "https://bk/1840" }],
      detail: "failed: buildkite/loggd",
    });
  });

  it("ignores a queue's own pending check-run when judging CI", async () => {
    const result = await wait(
      options({ required: ["Vercel"] }),
      sequence([
        snapshot({
          checks: [
            { name: "Vercel", state: "pass", url: null },
            { name: "Mergify Merge Queue", state: "pending", url: null },
          ],
        }),
      ]),
    );
    expect(result.outcome).toBe("green");
  });

  it("never reads a green off a head the session did not push", async () => {
    const stale = snapshot({ head: "old", checks: [{ name: "Vercel", state: "pass", url: null }] });
    const result = await wait(options({ head: "new" }), sequence([stale]));
    expect(result.outcome).toBe("head-mismatch");

    const caughtUp = await wait(
      options({ head: "new" }),
      sequence([stale, snapshot({ head: "new", checks: [{ name: "Vercel", state: "fail", url: null }] })]),
    );
    expect(caughtUp.outcome).toBe("red");
  });

  it("follows a PR into the queue and reports the merge", async () => {
    const result = await wait(
      options(),
      sequence([
        snapshot({ labels: ["queued"] }),
        snapshot({ labels: ["queued"] }),
        snapshot({ state: "MERGED", mergedAt: "2026-09-19T13:55:00Z" }),
      ]),
    );
    expect(result).toMatchObject({ outcome: "merged", mode: "merge", detail: "merged 2026-09-19T13:55:00Z" });
  });

  it("reports a dequeue in merge mode, and a PR that never got in", async () => {
    const fell = await wait(options({ mode: "merge" }), sequence([snapshot({ labels: ["queued"] }), snapshot()]));
    expect(fell.outcome).toBe("dequeued");
    expect(fell.detail).toContain("left the queue");

    const never = await wait(options({ mode: "merge" }), sequence([snapshot()]));
    expect(never.outcome).toBe("dequeued");
    expect(never.detail).toContain("never entered the queue");
  });

  it("reports closed, unreadable and timeout rather than hanging", async () => {
    expect((await wait(options(), sequence([snapshot({ state: "CLOSED" })]))).outcome).toBe("closed");
    expect((await wait(options(), sequence(["fail"]))).outcome).toBe("unreadable");
    const timeout = await wait(
      options({ ciTimeoutSeconds: 0 }),
      sequence([snapshot({ checks: [{ name: "Vercel", state: "pending", url: null }] })]),
    );
    expect(timeout).toMatchObject({ outcome: "timeout", detail: "checks still pending after 0s" });
  });
});

const RATE_LIMITED = "GraphQL: API rate limit already exceeded for user ID 1.";

/**
 * A fake gh: each answer is keyed by the start of the joined args, and every
 * call is recorded. A string answers stdout with status 0; an Error answers a
 * failure carrying that message on stderr.
 */
const fakeGh = (answers: Array<[string, string | Error]>): { gh: Gh; calls: string[][] } => {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const joined = args.join(" ");
    const answer = answers.find(([prefix]) => joined.startsWith(prefix))?.[1] ?? new Error(`no fake for ${joined}`);
    return answer instanceof Error
      ? { status: 1, stdout: "", stderr: answer.message }
      : { status: 0, stdout: answer, stderr: "" };
  };
  return { gh, calls };
};

const pullJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ state: "open", merged_at: null, labels: [{ name: "ralph-wip" }], head: { sha: "abc" }, ...over });
const runsJson = (runs: unknown[] = []) => JSON.stringify({ total_count: runs.length, check_runs: runs });
const statusJson = (statuses: unknown[] = []) => JSON.stringify({ state: "pending", statuses });
const restRun = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
  details_url: `https://ci.example/${name}`,
});
const restStatus = (name: string, state: string) => ({ context: name, state, target_url: `https://bk/${name}` });

const reader = (gh: Gh) => (pr: string, repo: string | null) => readSnapshot(pr, repo, gh);

describe("reading over REST when GraphQL is rate limited", () => {
  it("reads the PR, its check-runs and its legacy statuses, and judges green", async () => {
    const { gh, calls } = fakeGh([
      ["pr view", new Error(RATE_LIMITED)],
      ["api repos/{owner}/{repo}/pulls/7", pullJson()],
      ["api repos/{owner}/{repo}/commits/abc/check-runs", runsJson([restRun("lint", "completed", "success")])],
      ["api repos/{owner}/{repo}/commits/abc/status", statusJson([restStatus("buildkite/loggd", "success")])],
    ]);
    const result = await wait(options({ required: ["buildkite/loggd", "lint"] }), reader(gh));
    expect(result).toMatchObject({ outcome: "green", head: "abc" });
    expect(calls.map((args) => args[1])).toEqual([
      "view",
      "repos/{owner}/{repo}/pulls/7",
      "repos/{owner}/{repo}/commits/abc/check-runs?per_page=100",
      "repos/{owner}/{repo}/commits/abc/status",
    ]);
  });

  it("names the repo in the REST path when one is given", () => {
    const { gh, calls } = fakeGh([
      ["pr view", new Error("was submitted too quickly")],
      ["api repos/o/r/pulls/7", pullJson()],
      ["api repos/o/r/commits/abc/check-runs", runsJson()],
      ["api repos/o/r/commits/abc/status", statusJson()],
    ]);
    expect(readSnapshot("7", "o/r", gh)).toMatchObject({ ok: true, via: "rest" });
    expect(calls[0]).toContain("--repo");
    expect(calls[1]).toEqual(["api", "repos/o/r/pulls/7"]);
  });

  it("reports red when the legacy buildkite status failed", async () => {
    const { gh } = fakeGh([
      ["pr view", new Error(RATE_LIMITED)],
      ["api repos/{owner}/{repo}/pulls/7", pullJson()],
      ["api repos/{owner}/{repo}/commits/abc/check-runs", runsJson([restRun("lint", "completed", "success")])],
      ["api repos/{owner}/{repo}/commits/abc/status", statusJson([restStatus("buildkite/loggd", "failure")])],
    ]);
    const result = await wait(options({ required: ["buildkite/loggd"] }), reader(gh));
    expect(result).toMatchObject({
      outcome: "red",
      checks: [{ name: "buildkite/loggd", state: "fail", url: "https://bk/buildkite/loggd" }],
    });
  });

  it.each([
    [restRun("b", "in_progress", null), "pending"],
    [restRun("b", "completed", "timed_out"), "fail"],
    [restRun("b", "completed", "skipped"), "skip"],
    [restRun("b", "completed", "neutral"), "skip"],
  ])("REST check-run %o reads as %s", (run, state) => {
    const { gh } = fakeGh([
      ["pr view", new Error(RATE_LIMITED)],
      ["api repos/{owner}/{repo}/pulls/7", pullJson()],
      ["api repos/{owner}/{repo}/commits/abc/check-runs", runsJson([run])],
      ["api repos/{owner}/{repo}/commits/abc/status", statusJson()],
    ]);
    const got = readSnapshot("7", null, gh);
    expect(got.ok && got.snapshot.checks[0]?.state).toBe(state);
  });

  it("maps merged_at to MERGED and closed to CLOSED", async () => {
    const answers = (pull: string): Array<[string, string | Error]> => [
      ["pr view", new Error(RATE_LIMITED)],
      ["api repos/{owner}/{repo}/pulls/7", pull],
      ["api repos/{owner}/{repo}/commits/abc/check-runs", runsJson()],
      ["api repos/{owner}/{repo}/commits/abc/status", statusJson()],
    ];
    const merged = await wait(
      options(),
      reader(fakeGh(answers(pullJson({ state: "closed", merged_at: "2026-11-04T20:00:00Z" }))).gh),
    );
    expect(merged).toMatchObject({ outcome: "merged", detail: "merged 2026-11-04T20:00:00Z" });
    const closed = await wait(options(), reader(fakeGh(answers(pullJson({ state: "closed" }))).gh));
    expect(closed.outcome).toBe("closed");
  });

  it("names when the GraphQL quota resets when REST fails too", async () => {
    const { gh } = fakeGh([
      ["pr view", new Error(RATE_LIMITED)],
      ["api repos/", new Error("HTTP 502: Bad Gateway")],
      ["api rate_limit", JSON.stringify({ resources: { graphql: { remaining: 0, reset: 1793817185 } } })],
    ]);
    const result = await wait(options(), reader(gh));
    const iso = "2026-11-04T18:33:05Z";
    expect(result.outcome).toBe("unreadable");
    expect(result.resetAt).toBe(iso);
    expect(result.detail).toContain(iso);
    expect(result.detail).toContain("HTTP 502");
  });

  it("names no reset time for a secondary limit, which refuses reads with quota left", async () => {
    const { gh } = fakeGh([
      ["pr view", new Error("You have exceeded a secondary rate limit.")],
      ["api repos/", new Error("You have exceeded a secondary rate limit.")],
      ["api rate_limit", JSON.stringify({ resources: { graphql: { remaining: 4200, reset: 1793817185 } } })],
    ]);
    const result = await wait(options(), reader(gh));
    expect(result.outcome).toBe("unreadable");
    expect(result).not.toHaveProperty("resetAt");
    expect(result.detail).toContain("failed 5 times in a row");
  });

  it("stays unreadable without a reset time when rate_limit fails as well", async () => {
    const { gh } = fakeGh([
      ["pr view", new Error(RATE_LIMITED)],
      ["api repos/", new Error("HTTP 502: Bad Gateway")],
      ["api rate_limit", new Error("HTTP 502: Bad Gateway")],
    ]);
    const result = await wait(options(), reader(gh));
    expect(result.outcome).toBe("unreadable");
    expect(result).not.toHaveProperty("resetAt");
  });

  it("does not fall back to REST for an error that is not a rate limit", async () => {
    const { gh, calls } = fakeGh([
      ["pr view", new Error("GraphQL: Could not resolve to a PullRequest with the number of 7.")],
    ]);
    const result = await wait(options(), reader(gh));
    expect(result.outcome).toBe("unreadable");
    expect(calls.every((args) => args[0] === "pr")).toBe(true);
    expect(calls.length).toBe(MAX_CONSECUTIVE_FAILURES);
  });
});

describe("arguments", () => {
  it("takes the required checks from the project config when none are named", () => {
    const previous = process.env.RALPH_REQUIRED_CHECKS;
    process.env.RALPH_REQUIRED_CHECKS = "buildkite/loggd\nVercel\n";
    try {
      expect(parseArgs(["7"])).toMatchObject({ pr: "7", mode: "ci", required: ["buildkite/loggd", "Vercel"] });
      expect(parseArgs(["7", "--required", "only"])).toMatchObject({ required: ["only"] });
    } finally {
      if (previous === undefined) delete process.env.RALPH_REQUIRED_CHECKS;
      else process.env.RALPH_REQUIRED_CHECKS = previous;
    }
  });

  it("refuses what it cannot run", () => {
    expect(parseArgs([])).toMatch(/which pull request/);
    expect(parseArgs(["7", "--mode", "later"])).toMatch(/--mode/);
    expect(parseArgs(["7", "--interval", "-1"])).toMatch(/--interval/);
    expect(parseArgs(["7", "8"])).toMatch(/one pull request/);
  });
});
