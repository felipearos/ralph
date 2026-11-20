// @vitest-environment node
/**
 * The frontier, Following and PR-status reads, through the CLI read module
 * over an injected executor and clock (#608). The executor answers those three
 * reads from a script, so their failures can be produced on demand and their
 * TTL advanced without waiting. Every other read in the snapshot (loop state,
 * observe, claims) goes through the same injected executor since #609, so an
 * invocation the script does not answer falls through to the real process
 * executor and runs the real CLI against the scratch fixture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ADAPTER_ENV, FRONTIER_RETRY_BUDGET_ENV, RalphContractError, configCheckout, createRalphAdapter } from "./adapter";
import type { ExecResult, Executor, Invocation } from "./control-adapter";
import { createProcessExecutor } from "./executor";
import { cleanupFixtures, createFixture, writeProjectConfig, type Fixture } from "./fixtures";
import { createRecordingExecutor, fallThrough, type RecordingExecutor } from "./recording-executor";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("bun");

const CLI_DIR = join(__dirname, "..");
const TTL = 60_000;

afterAll(cleanupFixtures);

const isFrontier = (i: Invocation): boolean => (i.args[0] ?? "").endsWith(join("frontier", "next-tasks.ts"));
const isFollowing = (i: Invocation): boolean => (i.args[0] ?? "").endsWith(join("verifier", "following.ts"));
const isPulls = (state: "open" | "merged") => (i: Invocation): boolean =>
  i.command === "gh" && ["pr", "list", "--state", state].every((arg, index) => i.args[index] === arg);

const ok = (value: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });

// The shape the frontier narrow tests in adapter.test.ts accept as an empty backlog.
const emptyFrontier = {
  ready: [],
  occupied: [],
  specs: [],
  inFlight: [],
  blocked: [],
  gates: [],
  stuck: [],
  tree: [],
  stuckReasons: [],
  untriaged: [],
  triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
};

const openPulls = [{ number: 12, isDraft: false, closingIssuesReferences: [{ number: 7 }], statusCheckRollup: [] }];

const followingWatch = {
  pr: 574,
  ticket: 563,
  ticketRef: "#563",
  mode: "observe",
  round: 1,
  mergedAt: "2026-10-29T10:00:00.000Z",
  deployedAt: "2026-10-29T10:05:00.000Z",
  deployUrl: "https://example.vercel.app",
  openedAt: "2026-10-29T10:06:00.000Z",
  state: "in-progress",
  nextCheckIn: { offsetHours: 1, dueAt: "2026-10-29T11:05:00.000Z" },
  checkInsDone: 0,
  checkInsTotal: 3,
  verdict: null,
  wouldBe: [{ verdict: "ticket", reason: "500 on /feed", at: 1 }],
  notVerifiableLive: [{ criterion: "emails arrive", detail: null }],
};

// A verifier loop needs the config's `verifier` block, or the roster itself is refused.
const withVerifier = (f: Fixture): void => {
  writeProjectConfig(f.root, ["ralph", { name: "sent", role: "verifier" }]);
  const path = join(f.root, ".ralph", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const verifier = {
    productionUrl: "https://example.app",
    deploy: { source: "vercel", project: "prj_example" },
    sentry: { org: "example", project: "web" },
  };
  writeFileSync(path, JSON.stringify({ ...config, verifier }));
};

/**
 * A recording executor answering the scripted reads; anything else runs for
 * real, unrecorded, so `calls` holds the scripted reads alone.
 */
const scripted = (
  answers: {
    frontier?: ExecResult | (() => ExecResult);
    open?: ExecResult | (() => ExecResult);
    merged?: ExecResult;
    following?: ExecResult;
  } = {},
): RecordingExecutor =>
  fallThrough(
    createRecordingExecutor()
      .on(isFrontier, answers.frontier ?? ok(emptyFrontier))
      .on(isPulls("open"), answers.open ?? ok(openPulls))
      .on(isPulls("merged"), answers.merged ?? ok([]))
      .on(isFollowing, answers.following ?? ok({ version: 1, watches: [] })),
    createProcessExecutor(),
  );

const count = (rec: RecordingExecutor, match: (i: Invocation) => boolean): number =>
  rec.calls.filter((call) => match(call.invocation)).length;

const setup = (name: string, options: { verifier?: boolean } = {}) => {
  const f = createFixture(name);
  if (options.verifier === true) withVerifier(f);
  f.registry([f.worktree("wt-ralph")]);
  return f;
};

const adapterFor = (f: Fixture, exec: Executor, clock: { t: number }) =>
  createRalphAdapter({
    cliDir: CLI_DIR,
    roots: [f.root],
    env: { PATH: `${f.bin}:${process.env.PATH ?? ""}` },
    frontierTtlMs: TTL,
    exec,
    now: () => clock.t,
  });

describe("the frontier read through the CLI reader", () => {
  it("narrows the view and the PR chips from the executor, from the root, under RALPH_PROJECT", async () => {
    const f = setup("cli-frontier");
    const rec = scripted();
    const clock = { t: 1_700_000_000_000 };
    const snapshot = await adapterFor(f, rec.exec, clock).read();
    expect(snapshot.frontier).toMatchObject({ view: { ready: [], tree: [] }, problem: null });
    expect(snapshot.frontier?.readAt).toBe(new Date(clock.t).toISOString());
    expect(snapshot.frontier?.prs).not.toBeNull();
    expect(snapshot.frontier?.prs?.length).toBeGreaterThan(0);
    const frontier = rec.calls.find((call) => isFrontier(call.invocation))!.invocation;
    expect(frontier.cwd).toBe(f.root);
    expect(frontier.env[ADAPTER_ENV.project]).toBe(configCheckout(f.root));
    expect(frontier.args.slice(1)).toEqual(["--dry-run", "--json"]);
    // No rate-limit patience: a throttle must fail inside the timeout, with its reason.
    expect(frontier.env[FRONTIER_RETRY_BUDGET_ENV]).toBe("0");
  });

  it("serves one read for the TTL, and re-runs it after", async () => {
    const f = setup("cli-frontier-ttl", { verifier: true });
    const rec = scripted();
    const clock = { t: 1_700_000_000_000 };
    const adapter = adapterFor(f, rec.exec, clock);
    const first = await adapter.read();
    const scriptedCalls = (): number[] =>
      [isFrontier, isPulls("open"), isPulls("merged"), isFollowing].map((match) => count(rec, match));
    expect(scriptedCalls()).toEqual([1, 1, 1, 1]);
    clock.t += TTL - 1;
    const second = await adapter.read();
    expect(scriptedCalls()).toEqual([1, 1, 1, 1]);
    expect(second.frontier).toEqual(first.frontier);
    expect(second.following).toEqual(first.following);
    clock.t += 2;
    const third = await adapter.read();
    expect(scriptedCalls()).toEqual([2, 2, 2, 2]);
    expect(third.frontier?.readAt).toBe(new Date(clock.t).toISOString());
  });

  it("reports an unavailable frontier as unknown with its reason, and the snapshot resolves", async () => {
    const f = setup("cli-frontier-down");
    const rec = scripted({ frontier: { status: 1, stdout: "", stderr: "gh: not logged in\n" } });
    const snapshot = await adapterFor(f, rec.exec, { t: 1_700_000_000_000 }).read();
    expect(snapshot.frontier?.view).toBeNull();
    expect(snapshot.frontier?.problem).toBe("gh: not logged in");
  });

  it("keeps serving the last good backlog, marked stale, while a refresh fails, and clears it on recovery", async () => {
    const f = setup("cli-frontier-stale");
    const throttled: ExecResult = {
      status: 75,
      stdout: "",
      stderr: "GitHub rate limit (unspecified) — retry later (in ~60s): gh issue list failed\n",
    };
    const answers: ExecResult[] = [ok(emptyFrontier), throttled, ok({ ...emptyFrontier, untriaged: [] })];
    const opens = [ok(openPulls), ok([{ ...openPulls[0], number: 13 }])];
    const rec = scripted({ frontier: () => answers.shift() ?? throttled, open: () => opens.shift() ?? ok(openPulls) });
    const clock = { t: 1_700_000_000_000 };
    const adapter = adapterFor(f, rec.exec, clock);
    const good = await adapter.read();
    const goodAt = new Date(clock.t).toISOString();
    expect(good.frontier).toMatchObject({ readAt: goodAt, problem: null, failedAt: null });

    clock.t += TTL + 1;
    const stale = await adapter.read();
    expect(stale.frontier?.view).toEqual(good.frontier?.view);
    expect(stale.frontier?.readAt).toBe(goodAt);
    expect(stale.frontier?.failedAt).toBe(new Date(clock.t).toISOString());
    expect(stale.frontier?.problem).toMatch(/^GitHub rate limit/);
    // The PR reads succeeded on this refresh, so its newer chips are served.
    expect(good.frontier?.prs?.map((pr) => pr.pr)).toEqual([12]);
    expect(stale.frontier?.prs?.map((pr) => pr.pr)).toEqual([13]);

    clock.t += TTL + 1;
    const recovered = await adapter.read();
    expect(recovered.frontier).toMatchObject({ readAt: new Date(clock.t).toISOString(), problem: null, failedAt: null });
    expect(count(rec, isFrontier)).toBe(3);
  });

  it("throws on frontier drift, and does not keep it", async () => {
    const f = setup("cli-frontier-drift");
    const rec = scripted({ frontier: { status: 0, stdout: "nope", stderr: "" } });
    const adapter = adapterFor(f, rec.exec, { t: 1_700_000_000_000 });
    await expect(adapter.read()).rejects.toThrow(RalphContractError);
    await expect(adapter.read()).rejects.toThrow(RalphContractError);
    expect(count(rec, isFrontier)).toBe(2);
  });

  it.each([
    ["exits non-zero", { status: 1, stdout: "", stderr: "gh: rate limited" }],
    ["prints non-JSON", { status: 0, stdout: "nope", stderr: "" }],
  ])("costs only the chips when a PR read %s", async (_name, answer) => {
    const f = setup("cli-pulls-down");
    const rec = scripted({ merged: answer });
    const snapshot = await adapterFor(f, rec.exec, { t: 1_700_000_000_000 }).read();
    expect(snapshot.frontier).toMatchObject({ view: { ready: [] }, problem: null, prs: null });
  });
});

describe("the Following read through the CLI reader", () => {
  it("carries the narrowed view", async () => {
    const f = setup("cli-following", { verifier: true });
    const rec = scripted({ following: ok({ version: 1, watches: [followingWatch] }) });
    const clock = { t: 1_700_000_000_000 };
    const snapshot = await adapterFor(f, rec.exec, clock).read();
    expect(snapshot.following).toEqual({
      readAt: new Date(clock.t).toISOString(),
      view: { version: 1, watches: [followingWatch] },
      problem: null,
    });
    const following = rec.calls.find((call) => isFollowing(call.invocation))!.invocation;
    expect(following.cwd).toBe(f.root);
    expect(following.env[ADAPTER_ENV.project]).toBe(configCheckout(f.root));
  });

  it("degrades exit 1 to its stderr, and the snapshot resolves", async () => {
    const f = setup("cli-following-down", { verifier: true });
    const rec = scripted({ following: { status: 1, stdout: "", stderr: "the watch store is unreadable\n" } });
    const snapshot = await adapterFor(f, rec.exec, { t: 1_700_000_000_000 }).read();
    expect(snapshot.following).toMatchObject({ view: null, problem: "the watch store is unreadable" });
    expect(snapshot.roster.map((entry) => entry.name)).toEqual(["ralph", "sent"]);
  });

  it("degrades non-JSON instead of throwing", async () => {
    const f = setup("cli-following-drift", { verifier: true });
    const rec = scripted({ following: { status: 0, stdout: "nope", stderr: "" } });
    const snapshot = await adapterFor(f, rec.exec, { t: 1_700_000_000_000 }).read();
    expect(snapshot.following).toMatchObject({ view: null, problem: expect.stringMatching(/not JSON/) });
    expect(snapshot.frontier?.problem).toBeNull();
  });
});
