import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backtestDeps, buildBacktestSample, codexJudgeModel, configArms, defaultPanelNote, judgeSpecs, repeatCount, usageLimit, parseBacktest, renderBacktestSample, trackerTickets, type BacktestDeps, type BacktestTicket } from "./backtest";
import { backtestRunDir } from "./backtest-trial";
import { SITE, fakeJira } from "./clerk/fakes";
import { clerkMetricsPath } from "./clerk/metrics";
import { pullsCachePath, type PullRef } from "./clerk/pulls";
import { clerkStorePath } from "./clerk/store";
import { fixtureGitEnv, stripGitLocationEnv } from "./test-git-env";
import { subprocessSuite } from "./test-timeouts";
import { createFakeTracker } from "./tracker/fake";
import { seedLocalTracker } from "./tracker/local";

subprocessSuite("runs git init for the ledger and bun experiments.ts backtest with stubbed gh and model CLIs");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const EXPERIMENTS = join(import.meta.dirname, "experiments.ts");
const NOW = Date.parse("2026-10-20T12:00:00Z");
const REPO = "org/app";
const OTHER = "org/other";

const roots: string[] = [];
// The in-process builder resolves the ledger and PR cache with `git rev-parse`
// on process.env; a pre-push hook's GIT_DIR would point it at this checkout.
beforeEach(() => { stripGitLocationEnv(); });
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-backtest-test-"))); roots.push(root); return root; };

const moved = (oaKey: string, key: string, at: string) => ({ v: 1, kind: "moved", at, report: `r-${oaKey}-${at}`, key, oaKey, mode: "live" });
const pull = (repo: string, number: number, state: PullRef["state"], keys: string[], at = "2026-10-05T00:00:00Z"): PullRef =>
  ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, state, at, keys });
const view = (number: number, extra: { body?: string; headRefName?: string; createdAt: string; mergedAt: string; author?: string }) => ({
  number, title: `PR ${number}`, body: extra.body ?? "Fixes the thing.", headRefName: extra.headRefName ?? `fix-${number}`,
  author: { login: extra.author ?? "someone" }, createdAt: extra.createdAt, mergedAt: extra.mergedAt, baseRefOid: `base${number}`, headRefOid: `head${number}`,
});
const LOOP_BODY = "Done.\n\n🤖 rafa loop — run 2026-10-04T10:00:00Z";

/** A git repo with a clerk config, a ledger and a fresh PR cache, all under one scratch dir. A null tracker leaves the `tracker` key out: GitHub's. */
function world(tracker: Record<string, unknown> | null = { kind: "jira", site: "x.atlassian.net", project: "OA" }, nowMs = NOW) {
  const root = scratch();
  mkdirSync(join(root, ".ralph"), { recursive: true });
  writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({
    repo: "your-org/your-repo", owner: "your-github-login", baseBranch: "main", displayName: "Fixture",
    secrets: { runner: "none", withhold: [] }, refuseFiles: [], envCheck: [], requiredChecks: [], gates: {},
    promptFragment: ".ralph/prompt.md", coderFragment: ".ralph/coder.md", plan: ".ralph/plan.md", journal: { dir: "journal/fixture" },
    loops: [{ name: "clara", role: "clerk" }, "rafa"],
    appLabels: { backoffice: "acme-backoffice", pwa: "acme-pwa" },
    clerk: { channel: "C0123ABCD", jira: { site: "x.atlassian.net", project: "OA" }, prRepos: [REPO, OTHER] },
    ...(tracker === null ? {} : { tracker }),
  }));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch=main"], { env: fixtureGitEnv({}) });
  const ledger = clerkMetricsPath("clara", root);
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, [
    moved("OA-9", "OAI-9", "2026-09-30T00:00:00Z"),
    moved("OA-8", "OAI-8", "2026-09-20T00:00:00Z"),
    moved("OA-1", "OAI-1", "2026-10-01T00:00:00Z"),
    moved("OA-2", "OAI-2", "2026-10-02T00:00:00Z"),
    moved("OA-6", "OAI-6", "2026-10-03T00:00:00Z"),
    moved("OA-5", "OAI-5", "2026-10-04T00:00:00Z"),
    moved("OA-2", "OAI-2", "2026-10-06T00:00:00Z"),
    moved("HELD-3", "OAI-3", "2026-10-07T00:00:00Z"),
    moved("SHADOW-4", "OAI-4", "2026-10-07T00:00:00Z"),
    moved("OA-7", "OAI-7", "2026-10-08T00:00:00Z"),
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const pulls = [
    pull(REPO, 11, "mergeado", ["OAI-1"], "2026-10-03T00:00:00Z"),
    pull(REPO, 12, "mergeado", ["OA-1"], "2026-10-05T00:00:00Z"),
    pull(REPO, 13, "cerrado", ["OA-1"]),
    pull(REPO, 21, "mergeado", ["OA-2"]),
    pull(REPO, 51, "mergeado", ["OA-5"]),
    pull(REPO, 52, "mergeado", ["OA-5"]),
    pull(REPO, 61, "abierto", ["OA-6"]),
    pull(REPO, 71, "mergeado", ["OAI-7"]),
    pull(REPO, 72, "mergeado", ["OA-7"]),
    pull(OTHER, 91, "mergeado", ["OA-9"]),
  ];
  const cache = pullsCachePath(clerkStorePath("clara", root));
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ v: 1, triedAt: new Date(nowMs).toISOString(), repos: [REPO, OTHER], pulls }));
  return root;
}

const VIEWS: Record<string, ReturnType<typeof view>> = {
  [`${REPO}#11`]: view(11, { createdAt: "2026-10-02T00:00:00Z", mergedAt: "2026-10-03T00:00:00Z" }),
  // Opened before #11 but merged after it: merge order, not open order, decides which is first.
  [`${REPO}#12`]: view(12, { createdAt: "2026-10-01T12:00:00Z", mergedAt: "2026-10-05T00:00:00Z" }),
  [`${REPO}#21`]: view(21, { author: "felipearosr", headRefName: "felipearosr/oa-2", createdAt: "2026-10-06T00:00:00Z", mergedAt: "2026-10-07T00:00:00Z" }),
  [`${REPO}#51`]: view(51, { body: LOOP_BODY, createdAt: "2026-10-04T00:00:00Z", mergedAt: "2026-10-05T00:00:00Z" }),
  [`${REPO}#52`]: view(52, { headRefName: "rafa/oa-5-fix", createdAt: "2026-10-04T00:00:00Z", mergedAt: "2026-10-05T00:00:00Z" }),
  [`${REPO}#71`]: view(71, { createdAt: "2026-10-09T00:00:00Z", mergedAt: "2026-10-10T00:00:00Z" }),
  [`${REPO}#72`]: view(72, { body: LOOP_BODY, createdAt: "2026-10-09T00:00:00Z", mergedAt: "2026-10-10T00:00:00Z" }),
  [`${OTHER}#91`]: view(91, { createdAt: "2026-10-01T00:00:00Z", mergedAt: "2026-10-02T00:00:00Z" }),
};

/** A gh that answers fixtures and records every call. */
function stubGh() {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      const found = VIEWS[`${args[4]}#${args[2]}`];
      if (found === undefined) throw new Error(`no fixture for ${args[4]}#${args[2]}`);
      return JSON.stringify(found);
    }
    if (args[0] === "api") return `mb-${/compare\/([^.]+)\.\.\./.exec(args[1]!)?.[1]}\n`;
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

const comment = (body: string, createdAt?: string) => ({ body, ...(createdAt === undefined ? {} : { createdAt }), author: "someone" });
function tracker() {
  return createFakeTracker({
    kind: "jira", key: "OA",
    issues: [
      // "during" follows #12's opening but precedes #11's, the first PR to merge: work had begun.
      { number: 1, title: "One", body: "The ask.", comments: [comment("before", "2026-10-01T00:00:00Z"), comment("during", "2026-10-01T18:00:00Z"), comment("after", "2026-10-03T00:00:00Z"), comment("undated")] },
      { number: 2, title: "Two", comments: [comment("before", "2026-10-05T00:00:00Z")] },
      { number: 7, title: "Seven", comments: [] },
      { number: 9, title: "Nine", comments: [] },
    ],
  });
}

const raw = (project: string, extra: Record<string, unknown> = {}) => ({
  project, clerk: "clara", sample: { cap: 3, since: "2026-09-25T00:00:00Z" },
  lineup: "codex", caps: { trialMinutes: 90, batchMinutes: 720 }, rates: { inputPerMTok: 15, outputPerMTok: 75 }, ...extra,
});
const deps = (gh: BacktestDeps["gh"], fake = tracker()): BacktestDeps =>
  ({ gh, tickets: trackerTickets(fake), prRepos: [REPO, OTHER], loopNames: ["clara", "rafa", "ralph"], nowMs: NOW });

/** Every gh call the dry run may make: reads only. */
const readOnly = (args: string[]): boolean =>
  ((args[0] === "pr" && (args[1] === "view" || args[1] === "list")) || (args[0] === "api" && /^repos\/[^/]+\/[^/]+\/compare\//.test(args[1] ?? "")))
  && !args.includes("-X") && !args.includes("--method");

describe("buildBacktestSample", () => {
  it("lists the newest moved tickets with merged human PRs, up to the cap, with merge-bases and frozen comments", async () => {
    const root = world();
    const { gh, calls } = stubGh();
    const fake = tracker();
    const config = parseBacktest(raw(root));
    const sample = await buildBacktestSample(config, deps(gh, fake));

    expect(sample.tickets.map((ticket) => ticket.oaKey)).toEqual(["OA-7", "OA-2", "OA-1"]);
    expect(sample.skipped).toEqual([
      { oaKey: "OA-5", intakeKey: "OAI-5", reason: "only loop PRs" },
      { oaKey: "OA-6", intakeKey: "OAI-6", reason: "no merged PR" },
    ]);
    const [seven, two, one] = sample.tickets;
    // The duplicate move keeps the latest one.
    expect(two).toMatchObject({ movedAt: "2026-10-06T00:00:00Z", repo: REPO, mergeBase: "mb-base21", ticketRef: "OA-2", comments: { kept: 1, dropped: 0 } });
    expect(two!.humanPrs.map((pr) => pr.number)).toEqual([21]);
    expect(seven!.humanPrs.map((pr) => pr.number)).toEqual([71]);
    expect(one).toMatchObject({ intakeKey: "OAI-1", mergeBase: "mb-base12", startedAt: "2026-10-01T12:00:00Z", comments: { kept: 1, dropped: 3 } });
    expect(one!.frozen).toEqual({ title: "One", body: "The ask.", comments: [{ author: "someone", createdAt: "2026-10-01T00:00:00Z", body: "before" }] });
    expect(sample.arms).toEqual({ b: "live lineup", c: "codex" });
    expect(sample.notes).toEqual([]);

    expect(calls.every(readOnly)).toBe(true);
    expect(calls.some((args) => args[1] === "list")).toBe(false);
    expect(fake.writes).toEqual([]);
    // Past the cap nothing more is read: OA-9 is never viewed.
    expect(calls.some((args) => args.includes(OTHER))).toBe(false);

    const text = renderBacktestSample(sample, config);
    expect(text).toContain("OA-1 (intake OAI-1) — org/app");
    expect(text).toContain("merge-base: mb-base12");
    expect(text).toContain("OA-5 (intake OAI-5): only loop PRs");
    expect(text).toContain("no model was called");
  });

  it("gives a ticket with two merged human PRs one entry, in merge order, frozen at the first opened", async () => {
    const root = world();
    const { gh } = stubGh();
    const sample = await buildBacktestSample(parseBacktest(raw(root)), deps(gh));
    const one = sample.tickets.find((ticket) => ticket.oaKey === "OA-1")!;
    expect(one.humanPrs.map((pr) => [pr.number, pr.createdAt, pr.mergedAt])).toEqual([
      [11, "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"],
      [12, "2026-10-01T12:00:00Z", "2026-10-05T00:00:00Z"],
    ]);
    // #12 was opened first, so human work began then even though #11 merged first.
    expect(one.startedAt).toBe("2026-10-01T12:00:00Z");
    expect(one.mergeBase).toBe("mb-base12");
  });

  it("takes the merge-base from the first PR's first commit, not a head later updated from the base", async () => {
    const root = world();
    const { gh, calls } = stubGh();
    const original = VIEWS[`${REPO}#12`]!;
    VIEWS[`${REPO}#12`] = { ...original, commits: [{ oid: "first12" }, { oid: "merge-main-into-12" }] } as typeof original;
    let sample;
    try {
      sample = await buildBacktestSample(parseBacktest(raw(root)), deps(gh));
    } finally { VIEWS[`${REPO}#12`] = original; }
    expect(calls).toContainEqual(["api", `repos/${REPO}/compare/base12...first12`, "--jq", ".merge_base_commit.sha"]);
    // Both ends of the human's work stay in the sample for scoring.
    const twelve = sample.tickets.find((ticket) => ticket.oaKey === "OA-1")!.humanPrs.find((pr) => pr.number === 12);
    expect(twelve).toMatchObject({ firstCommit: "first12", headRefOid: "head12" });
  });

  it("skips tickets older than a full cached PR list, and a ticket whose PRs another already holds", async () => {
    const root = world();
    const cache = pullsCachePath(clerkStorePath("clara", root));
    const read = JSON.parse(readFileSync(cache, "utf8")) as { pulls: PullRef[] };
    // A full window for REPO whose oldest entry is 2026-10-02: OA-1 (moved 10-01) may have lost PRs off its end.
    for (let n = 0; read.pulls.filter((pull) => pull.repo === REPO).length < 200; n++) read.pulls.push(pull(REPO, 1000 + n, "abierto", [], "2026-10-02T00:00:00Z"));
    // OA-2's PR also names OA-6, so whichever is sampled second is a duplicate.
    read.pulls.find((pull) => pull.number === 21)!.keys.push("OA-6");
    writeFileSync(cache, JSON.stringify(read));
    const { gh } = stubGh();
    const fake = tracker();
    fake.put({ number: 6, title: "Six" });
    const sample = await buildBacktestSample(parseBacktest(raw(root, { sample: { cap: 5 } })), deps(gh, fake));
    expect(sample.skipped).toContainEqual({ oaKey: "OA-6", intakeKey: "OAI-6", reason: `PR already sampled: ${REPO}#21` });
    expect(sample.skipped).toContainEqual({ oaKey: "OA-1", intakeKey: "OAI-1", reason: "PR list too short: the cached PRs reach back only to 2026-10-02T00:00:00.000Z" });
    expect(sample.tickets.map((ticket) => ticket.oaKey)).not.toContain("OA-1");
  });

  it("never samples a ticket or a PR the permanent ledger holds, and they do not eat the cap", async () => {
    const root = world();
    const { gh } = stubGh();
    const config = parseBacktest(raw(root, { sample: { cap: 5 } }));
    const all = await buildBacktestSample(config, deps(gh));
    expect(all.tickets.length).toBeGreaterThan(1);
    const [first, second] = all.tickets as [BacktestTicket, BacktestTicket];
    const recorded = { tickets: [first.oaKey], prs: [`${second.repo}#${second.humanPrs[0]!.number}`] };
    const left = await buildBacktestSample({ ...config, sample: { ...config.sample, recorded, cap: 1 } }, deps(gh));
    expect(left.tickets.map((ticket) => ticket.oaKey)).not.toContain(first.oaKey);
    expect(left.tickets.map((ticket) => ticket.oaKey)).not.toContain(second.oaKey);
    expect(left.skipped).toContainEqual(expect.objectContaining({ oaKey: second.oaKey, reason: expect.stringContaining("PR already sampled") }));
  });

  it("skips a ticket whose PR or tracker read fails, and keeps going", async () => {
    const root = world();
    const { gh } = stubGh();
    const failing: BacktestDeps["gh"] = async (args) => {
      if (args[2] === "71") throw new Error("gh pr view failed: HTTP 502");
      return gh(args);
    };
    const fake = tracker();
    fake.issues.delete(2);
    const sample = await buildBacktestSample(parseBacktest(raw(root, { sample: { cap: 2 } })), deps(failing, fake));
    expect(sample.skipped.map((skip) => [skip.oaKey, skip.reason.split(":")[0]])).toEqual([
      ["OA-7", "unreadable PR"], ["OA-2", "unreadable ticket"], ["OA-5", "only loop PRs"], ["OA-6", "no merged PR"],
    ]);
    expect(sample.tickets.map((ticket) => ticket.oaKey)).toEqual(["OA-1", "OA-9"]);
  });

  it("skips split work across two repos, even when sample.repos names one of them", async () => {
    const root = world();
    const cache = pullsCachePath(clerkStorePath("clara", root));
    const read = JSON.parse(readFileSync(cache, "utf8")) as { pulls: PullRef[] };
    read.pulls.push(pull(OTHER, 92, "mergeado", ["OA-7"], "2026-10-10T00:00:00Z"));
    writeFileSync(cache, JSON.stringify(read));
    VIEWS[`${OTHER}#92`] = view(92, { createdAt: "2026-10-09T00:00:00Z", mergedAt: "2026-10-10T00:00:00Z" });
    try {
      for (const sample of [{ cap: 1 }, { cap: 1, repos: [REPO] }]) {
        const { gh } = stubGh();
        const built = await buildBacktestSample(parseBacktest(raw(root, { sample })), deps(gh));
        expect(built.skipped[0]).toEqual({ oaKey: "OA-7", intakeKey: "OAI-7", reason: `unknown repo: human PRs in ${REPO}, ${OTHER}` });
      }
    } finally { delete VIEWS[`${OTHER}#92`]; }
  });

  it("refuses sample.repos outside the project's prRepos", async () => {
    const root = world();
    const { gh, calls } = stubGh();
    const config = parseBacktest(raw(root, { sample: { cap: 1, repos: ["org/elsewhere"] } }));
    await expect(buildBacktestSample(config, deps(gh))).rejects.toThrow(/backtest config: sample\.repos names org\/elsewhere/);
    expect(calls).toEqual([]);
  });
});

describe("backtestDeps on a clerk project without a keyed tracker", () => {
  /** A world with no `tracker` key, with the clerk's Jira on the fake's site. */
  function clerkWorld() {
    const root = world(null);
    const path = join(root, ".ralph", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as { tracker: unknown; clerk: { jira: Record<string, string> } };
    expect(config.tracker).toBeUndefined();
    config.clerk.jira = { site: SITE, project: "OA", intakeProject: "OAI" };
    writeFileSync(path, JSON.stringify(config));
    return root;
  }
  const TOKEN = { RALPH_CLERK_JIRA_TOKEN: "bot@example.com:token" };

  it("reads each ticket from the clerk's Jira, OA key first, then the intake key, and writes nothing", async () => {
    const root = clerkWorld();
    const jira = fakeJira("OA", { projects: ["OAI"] });
    // OA-1's first PR (#12) opened 2026-10-01T12:00:00Z: the comments straddle it.
    jira.add({
      key: "OA-1", summary: "One", description: "The ask.", comments: ["before", "after", "undated"],
      commentTimes: ["2026-10-01T08:00:00.000-0300", "2026-10-03T00:00:00.000-0300", ""],
    });
    // OA-2 was never created in OA: its intake ticket is the one there is.
    jira.add({ key: "OAI-2", summary: "Two", description: "Intake ask.", comments: ["early"], commentTimes: ["2026-10-05T00:00:00.000Z"] });
    jira.add({ key: "OA-9", summary: "Nine" });
    // OA-7 is in neither board.
    const built = await backtestDeps(parseBacktest(raw(root)), { env: TOKEN, fetch: jira.fetch, nowMs: NOW });
    const { gh, calls } = stubGh();
    const sample = await buildBacktestSample(parseBacktest(raw(root)), { ...built, gh });

    expect(sample.tickets.map((ticket) => ticket.oaKey)).toEqual(["OA-2", "OA-1", "OA-9"]);
    expect(sample.skipped).toContainEqual({ oaKey: "OA-7", intakeKey: "OAI-7", reason: "unreadable ticket: neither OA-7 nor OAI-7 is in the clerk's Jira" });
    const [two, one] = sample.tickets;
    expect(one).toMatchObject({ ticketRef: "OA-1", comments: { kept: 1, dropped: 2 } });
    expect(one!.frozen).toEqual({
      title: "One", body: "The ask.",
      comments: [{ author: "Persona de Prueba", createdAt: "2026-10-01T08:00:00.000-0300", body: "before" }],
    });
    // #21 opened 2026-10-06, after OAI-2's comment.
    expect(two).toMatchObject({ ticketRef: "OAI-2", comments: { kept: 1, dropped: 0 }, frozen: { title: "Two", body: "Intake ask.", comments: [{ body: "early" }] } });
    expect(calls.every(readOnly)).toBe(true);
    expect(jira.writes()).toEqual([]);
    expect(renderBacktestSample(sample, parseBacktest(raw(root)))).toContain("frozen ticket OAI-2: 1 comment kept, 0 dropped");
  });

  it("reads the OA ticket when the intake ticket exists too", async () => {
    const root = clerkWorld();
    const jira = fakeJira("OA", { projects: ["OAI"] });
    jira.add({ key: "OA-1", summary: "Team ticket", description: "The OA ask." });
    jira.add({ key: "OAI-1", summary: "Report", description: "The intake report." });
    const built = await backtestDeps(parseBacktest(raw(root)), { env: TOKEN, fetch: jira.fetch, nowMs: NOW });
    const sample = await buildBacktestSample(parseBacktest(raw(root)), { ...built, gh: stubGh().gh });
    expect(sample.tickets.find((ticket) => ticket.oaKey === "OA-1")).toMatchObject({ ticketRef: "OA-1", frozen: { title: "Team ticket", body: "The OA ask." } });
  });

  it("refuses to start without the clerk's Jira credential", async () => {
    const root = clerkWorld();
    const jira = fakeJira("OA", { projects: ["OAI"] });
    for (const env of [{}, { RALPH_CLERK_JIRA_TOKEN: "no-colon" }]) {
      const rejected = backtestDeps(parseBacktest(raw(root)), { env, fetch: jira.fetch, nowMs: NOW });
      await expect(rejected).rejects.toThrow(/RALPH_CLERK_JIRA_TOKEN/);
    }
    expect(jira.calls.length).toBe(0);
  });

  it("refuses to start when Jira refuses the credential", async () => {
    const root = clerkWorld();
    const jira = fakeJira("OA", { projects: ["OAI"] });
    jira.fail("/rest/api/3/project/", { status: 401 }, { always: true });
    await expect(backtestDeps(parseBacktest(raw(root)), { env: TOKEN, fetch: jira.fetch, nowMs: NOW }))
      .rejects.toThrow(/RALPH_CLERK_JIRA_TOKEN cannot read the clerk's Jira project OA.*HTTP 401/);
  });

  it("refuses to start when the token cannot read the intake board", async () => {
    const root = clerkWorld();
    // OAI is not among the projects the token can read: the fake answers 404 for it.
    const jira = fakeJira("OA");
    await expect(backtestDeps(parseBacktest(raw(root)), { env: TOKEN, fetch: jira.fetch, nowMs: NOW }))
      .rejects.toThrow(/RALPH_CLERK_JIRA_TOKEN cannot read the clerk's Jira project OAI/);
  });
});

describe("parseBacktest", () => {
  const base = raw("/abs/project");
  it("accepts the documented config and fills the optional keys", () => {
    expect(parseBacktest({ ...base, lineup: undefined, rates: null, sample: { cap: 2 } })).toEqual({
      project: "/abs/project", clerk: "clara", sample: { cap: 2, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 90, batchMinutes: 720 }, rates: null, sources: {},
      scoring: {
        testGlobs: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "e2e/**"],
        testCommand: "npx vitest run {file}", setup: null, review: true,
        judge: { model: "claude-opus-5-5", seed: null, defaultPanel: true },
      },
    });
  });
  it("takes scoring overrides key by key, the rest defaulted", () => {
    expect(parseBacktest({ ...base, scoring: { testCommand: "bun x vitest run {file}", setup: "bun install", review: false } }).scoring).toEqual({
      testGlobs: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "e2e/**"],
      testCommand: "bun x vitest run {file}", setup: "bun install", review: false,
      judge: { model: "claude-opus-5-5", seed: null, defaultPanel: true },
    });
    expect(parseBacktest({ ...base, scoring: { testGlobs: ["test/**/*.ts"] } }).scoring.testGlobs).toEqual(["test/**/*.ts"]);
  });
  it("turns the judge off with false and takes its model and seed", () => {
    expect(parseBacktest({ ...base, scoring: { judge: false } }).scoring.judge).toBeNull();
    expect(parseBacktest({ ...base, scoring: { judge: { model: "claude-sonnet-5-5", seed: "fixed" } } }).scoring.judge)
      .toEqual({ model: "claude-sonnet-5-5", seed: "fixed" });
    expect(parseBacktest({ ...base, scoring: { judge: {} } }).scoring.judge).toEqual({ model: "claude-opus-5-5", seed: null, defaultPanel: true });
  });
  it("takes the judge's contested rule only when given, absent read as inversion (#818)", () => {
    expect(parseBacktest(base).scoring.judge).not.toHaveProperty("contested");
    expect(parseBacktest({ ...base, scoring: { judge: { seed: "s" } } }).scoring.judge).not.toHaveProperty("contested");
    expect(parseBacktest({ ...base, scoring: { judge: { contested: "inversion" } } }).scoring.judge!.contested).toEqual({ kind: "inversion" });
    expect(parseBacktest({ ...base, scoring: { judge: { contested: { spread: 2 } } } }).scoring.judge!.contested).toEqual({ kind: "spread", points: 2 });
    expect(parseBacktest({ ...base, scoring: { judge: { contested: { spread: 4 } } } }).scoring.judge!.contested).toEqual({ kind: "spread", points: 4 });
  });
  it("takes named arms, each a lineup and an optional overlay, and leaves arms out when none are named (#801)", () => {
    const parsed = parseBacktest({ ...base, lineup: null, arms: [{ name: "opus" }, { name: "sonnet", lineup: "sonnet-coder" }, { name: "short", overlay: "/srv/short" }] });
    expect(parsed.arms).toEqual([
      { name: "opus", lineup: "live", overlay: null },
      { name: "sonnet", lineup: "sonnet-coder", overlay: null },
      { name: "short", lineup: "live", overlay: "/srv/short" },
    ]);
    expect(configArms(parsed)).toEqual(parsed.arms);
    // A legacy config keeps its shape, so the run directory it hashes to does not move.
    expect("arms" in parseBacktest(base)).toBe(false);
    expect(configArms(parseBacktest(base))).toEqual([{ name: "b", lineup: "live", overlay: null }, { name: "c", lineup: "codex", overlay: null }]);
    expect(configArms(parseBacktest({ ...base, lineup: null }))).toEqual([{ name: "b", lineup: "live", overlay: null }]);
  });
  it("takes a judge panel of Claude and Codex judges, each named by its model unless the config names it (#801)", () => {
    const judge = parseBacktest({ ...base, scoring: { judge: { panel: [{ runner: "claude", model: "claude-opus-5-5" }, { runner: "codex", model: "gpt-6-luna", name: "gpt" }] } } }).scoring.judge!;
    expect(judgeSpecs(judge)).toEqual([
      { name: "claude-opus-5-5", runner: "claude", model: "claude-opus-5-5" },
      { name: "gpt", runner: "codex", model: "gpt-6-luna" },
    ]);
    // No panel and no model: the default panel of #817, injected so the repo's models.json does not matter.
    expect(judgeSpecs(parseBacktest(base).scoring.judge!, "gpt-x")).toEqual([
      { name: "opus", runner: "claude", model: "claude-opus-5-5" },
      { name: "gpt", runner: "codex", model: "gpt-x" },
    ]);
  });
  it("judges with Opus and the Codex model when a config names no judge model or panel, and one judge on a named model (#817)", () => {
    const opusAndGpt = [{ name: "opus", runner: "claude", model: "claude-opus-5-5" }, { name: "gpt", runner: "codex", model: "gpt-x" }];
    for (const judge of [undefined, {}, { seed: "s" }]) {
      const parsed = parseBacktest({ ...base, scoring: judge === undefined ? {} : { judge } }).scoring.judge!;
      expect(judgeSpecs(parsed, "gpt-x")).toEqual(opusAndGpt);
      expect(defaultPanelNote(parsed, "gpt-x")).toBeNull();
    }
    expect(parseBacktest({ ...base, scoring: { judge: { seed: "s" } } }).scoring.judge!.seed).toBe("s");
    const named = parseBacktest({ ...base, scoring: { judge: { model: "claude-sonnet-5-5" } } }).scoring.judge!;
    expect(judgeSpecs(named, "gpt-x")).toEqual([{ name: "claude-sonnet-5-5", runner: "claude", model: "claude-sonnet-5-5" }]);
    expect(defaultPanelNote(named, null)).toBeNull();
    expect(parseBacktest({ ...base, scoring: { judge: false } }).scoring.judge).toBeNull();
    expect(defaultPanelNote(null, null)).toBeNull();
    // No Codex model: Opus alone, and a note that says why.
    const fallback = parseBacktest(base).scoring.judge!;
    expect(judgeSpecs(fallback, null)).toEqual([{ name: "opus", runner: "claude", model: "claude-opus-5-5" }]);
    expect(defaultPanelNote(fallback, null)).toMatch(/Opus alone .*no Codex model/);
  });
  it("reads the first codex model from models.json, and null, never a throw, when there is none (#817)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-judge-"));
    try {
      const path = join(dir, "models.json");
      writeFileSync(path, JSON.stringify({ stages: { coder: { runner: "claude", model: "claude-opus-5-5" }, review: { runner: "codex", model: "gpt-x" }, other: { runner: "codex", model: "gpt-y" } } }));
      expect(codexJudgeModel(path)).toBe("gpt-x");
      writeFileSync(path, JSON.stringify({ stages: { coder: { runner: "claude", model: "claude-opus-5-5" } } }));
      expect(codexJudgeModel(path)).toBeNull();
      expect(codexJudgeModel(join(dir, "missing.json"))).toBeNull();
      writeFileSync(path, "{ not json");
      expect(codexJudgeModel(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("repeats a disputed case twice on a PR source and never on a clerk backtest, unless the config says (#801)", () => {
    expect(repeatCount(parseBacktest(base))).toBe(0);
    expect(repeatCount(parseBacktest({ ...base, repeats: 3 }))).toBe(3);
    expect(repeatCount({ source: { kind: "pr", repo: "o/r", prs: [1], ticket: null } })).toBe(2);
    expect(repeatCount({ source: { kind: "pr", repo: "o/r", prs: [1], ticket: null }, repeats: 0 })).toBe(0);
  });
  describe("a noise floor plan (#859)", () => {
    const live = [1, 2, 3].map((i) => ({ name: `live-${i}`, lineup: "live", overlay: null }));
    const floor = { ...base, clerk: undefined, sample: undefined, lineup: undefined, source: { kind: "set" }, arms: live, noiseFloor: { measuredAt: "2026-11-19T10:00:00Z" } };
    it("returns noiseFloor on a set run of identical live arms, and repeats nothing by default", () => {
      const config = parseBacktest(floor);
      expect(config.noiseFloor).toEqual({ measuredAt: "2026-11-19T10:00:00Z" });
      expect(repeatCount(config)).toBe(0);
      expect(parseBacktest({ ...floor, repeats: 0 }).repeats).toBe(0);
      expect(parseBacktest({ ...floor, noiseFloor: undefined }).noiseFloor).toBeUndefined();
      expect("noiseFloor" in parseBacktest({ ...floor, noiseFloor: undefined })).toBe(false);
    });
    it("refuses a malformed or misplaced noiseFloor", () => {
      expect(() => parseBacktest({ ...floor, noiseFloor: "2026-11-19" })).toThrow(/noiseFloor must be an object/);
      expect(() => parseBacktest({ ...floor, noiseFloor: { measuredAt: "2026-11-19T10:00:00Z", arms: 3 } })).toThrow(/unknown key noiseFloor.arms/);
      expect(() => parseBacktest({ ...floor, noiseFloor: { measuredAt: "" } })).toThrow(/measuredAt/);
      expect(() => parseBacktest({ ...floor, noiseFloor: { measuredAt: "not a time" } })).toThrow(/measuredAt/);
      expect(() => parseBacktest({ ...floor, noiseFloor: {} })).toThrow(/measuredAt/);
      expect(() => parseBacktest({ ...floor, source: { kind: "pr", repo: "o/r", prs: [1] } })).toThrow(/needs a set source/);
      expect(() => parseBacktest({ ...base, arms: live, lineup: undefined, noiseFloor: floor.noiseFloor })).toThrow(/needs a set source/);
      expect(() => parseBacktest({ ...floor, repeats: 1 })).toThrow(/runs no repeats/);
      expect(() => parseBacktest({ ...floor, arms: undefined })).toThrow(/at least 2 arms/);
      expect(() => parseBacktest({ ...floor, arms: [live[0]] })).toThrow(/at least 2 arms/);
      expect(() => parseBacktest({ ...floor, arms: [live[0], { name: "codex", lineup: "codex", overlay: null }] })).toThrow(/live lineup/);
      expect(() => parseBacktest({ ...floor, arms: [live[0], { name: "tuned", lineup: "live", overlay: "/abs/overlay" }] })).toThrow(/no overlay/);
    });
    it("hashes measuredAt into the run directory, so a second measurement is a new run, not a resume", () => {
      const first = backtestRunDir(parseBacktest(floor));
      expect(backtestRunDir(parseBacktest(floor))).toBe(first);
      expect(backtestRunDir(parseBacktest({ ...floor, noiseFloor: { measuredAt: "2026-11-20T10:00:00Z" } }))).not.toBe(first);
    });
  });
  it("guards usage at 90% unless the config names a limit or turns it off (#801)", () => {
    expect(usageLimit(parseBacktest(base))).toBe(90);
    expect(usageLimit(parseBacktest({ ...base, usageGuard: 75 }))).toBe(75);
    expect(usageLimit(parseBacktest({ ...base, usageGuard: false }))).toBeNull();
  });
  it("turns the analyst off with false and takes its model; a config that names none leaves it on (#801)", () => {
    expect(parseBacktest({ ...base, scoring: { analyst: false } }).scoring.analyst).toBeNull();
    expect(parseBacktest({ ...base, scoring: { analyst: { model: "claude-sonnet-5-5" } } }).scoring.analyst).toEqual({ model: "claude-sonnet-5-5" });
    expect(parseBacktest(base).scoring.analyst).toBeUndefined();
  });
  it("takes sources as owner/name to an absolute checkout path", () => {
    expect(parseBacktest({ ...base, sources: { "org/app": "/src/app", "org/other": "/src/other" } }).sources)
      .toEqual({ "org/app": "/src/app", "org/other": "/src/other" });
  });
  it.each([
    [{ ...base, sample: { since: "2026-10-01T00:00:00Z" } }, "sample.cap must be a positive integer"],
    [{ ...base, sample: { cap: 1.5 } }, "sample.cap must be a positive integer"],
    [{ ...base, caps: { trialMins: 90, batchMinutes: 720 } }, "unknown key caps.trialMins"],
    [{ ...base, sample: { cap: 1, extra: true } }, "unknown key sample.extra"],
    [{ ...base, surprise: 1 }, "unknown key surprise"],
    [{ ...base, caps: { trialMinutes: 800, batchMinutes: 720 } }, "caps.trialMinutes must not exceed caps.batchMinutes"],
    [{ ...base, caps: { trialMinutes: 0, batchMinutes: 720 } }, "caps.trialMinutes must be a positive number"],
    [{ ...base, caps: { trialMinutes: 90 } }, "caps.batchMinutes must be a positive number"],
    [{ ...base, rates: { inputPerMTok: 15 } }, "rates.outputPerMTok must be a non-negative number"],
    [{ ...base, rates: { inputPerMTok: -1, outputPerMTok: 75 } }, "rates.inputPerMTok must be a non-negative number"],
    [{ ...base, rates: { inputPerMTok: 1, outputPerMTok: 2, cache: 3 } }, "unknown key rates.cache"],
    [{ ...base, project: "relative/path" }, "project must be an absolute path"],
    [{ ...base, clerk: "Clara" }, "clerk must be"],
    [{ ...base, lineup: "" }, "lineup must be"],
    [{ ...base, sample: { cap: 1, since: "2026-10-01T00:00:00" } }, "sample.since must be an ISO 8601 time with a timezone"],
    [{ ...base, sample: { cap: 1, repos: [] } }, "sample.repos must be a non-empty list"],
    [{ ...base, sources: { "org/app": "src/app" } }, "sources.org/app must be an absolute path"],
    [{ ...base, sources: { app: "/src/app" } }, "sources key app must be an owner/name repo"],
    [{ ...base, sources: ["/src/app"] }, "sources must be an object"],
    [{ ...base, scoring: { testCommand: "npx vitest run" } }, "scoring.testCommand must be a shell command containing {file}"],
    [{ ...base, scoring: { testGlobs: [] } }, "scoring.testGlobs must be a non-empty list"],
    [{ ...base, scoring: { setup: 3 } }, "scoring.setup must be a shell command, or null"],
    [{ ...base, scoring: { review: "yes" } }, "scoring.review must be true or false"],
    [{ ...base, scoring: { gates: true } }, "unknown key scoring.gates"],
    [{ ...base, scoring: { judge: { model: "x", temperature: 0 } } }, "unknown key scoring.judge.temperature"],
    [{ ...base, scoring: { judge: true } }, "scoring.judge must be false or an object"],
    [{ ...base, scoring: { judge: { model: "" } } }, "scoring.judge.model must be a model id"],
    [{ ...base, scoring: [] }, "scoring must be an object"],
    [{ ...base, arms: [{ name: "x" }] }, "name arms or lineup, not both"],
    [{ ...base, scoring: { judge: { panel: [] } } }, "scoring.judge.panel must be a non-empty list"],
    [{ ...base, scoring: { analyst: true } }, "scoring.analyst must be false or an object with model"],
    [{ ...base, repeats: 4 }, "repeats must be an integer from 0 to 3"],
    [{ ...base, usageGuard: 0 }, "usageGuard must be a usage percentage from 1 to 100, or false"],
    [{ ...base, usageGuard: "90" }, "usageGuard must be a usage percentage from 1 to 100, or false"],
    [{ ...base, repeats: 1.5 }, "repeats must be an integer from 0 to 3"],
    [{ ...base, scoring: { analyst: { model: "" } } }, "scoring.analyst.model must be a model id"],
    [{ ...base, scoring: { judge: { panel: [{ runner: "gemini", model: "g" }] } } }, "scoring.judge.panel[0].runner must be claude or codex"],
    [{ ...base, scoring: { judge: { panel: [{ runner: "claude", model: "m" }, { runner: "claude", model: "m" }] } } }, "scoring.judge.panel[1] is a second judge named m"],
    [{ ...base, lineup: null, arms: [] }, "arms must be a non-empty list"],
    [{ ...base, scoring: { judge: { contested: "spread" } } }, "scoring.judge.contested must be \"inversion\" or { spread: <points above 0, at most 4> }"],
    [{ ...base, scoring: { judge: { contested: { spread: 0 } } } }, "scoring.judge.contested must be"],
    [{ ...base, scoring: { judge: { contested: { spread: 5 } } } }, "scoring.judge.contested must be"],
    [{ ...base, scoring: { judge: { contested: { spread: "2" } } } }, "scoring.judge.contested must be"],
    [{ ...base, scoring: { judge: { contested: { spread: 2, x: 1 } } } }, "unknown key scoring.judge.contested.x"],
    [{ ...base, lineup: null, arms: [{ name: "a" }] }, "arms[0].name must be a kebab-case name other than \"a\""],
    [{ ...base, lineup: null, arms: [{ name: "x" }, { name: "x" }] }, "arms[1].name x is used twice"],
    [{ ...base, lineup: null, arms: [{ name: "x", overlay: "rel/dir" }] }, "arms[0].overlay must be an absolute path"],
    [{ ...base, lineup: null, arms: [{ name: "x", lineup: "Opus" }] }, "arms[0].lineup must be"],
    [{ ...base, lineup: null, arms: [{ name: "x", model: "opus" }] }, "unknown key arms[0].model"],
    [{ ...base, lineup: null, arms: Array.from({ length: 7 }, (_, i) => ({ name: `x${i}` })) }, "arms names 7 arms; at most 6"],
  ])("names the offending key: %#", (config, error) => {
    expect(() => parseBacktest(config)).toThrow(`backtest config: ${error}`);
  });

  it("parses the README's eval plan example (#801)", () => {
    const readme = readFileSync(join(import.meta.dirname, "README.md"), "utf8");
    const start = readme.indexOf("\n## Compare arms on merged work\n");
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start + 1, readme.indexOf("\n## ", start + 1));
    const [block] = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const plan = parseBacktest(JSON.parse(block!));
    expect(plan.source).toMatchObject({ kind: "pr", prs: [2731], ticket: "#2702" });
    expect(configArms(plan).map((arm) => arm.name)).toEqual(["opus", "sonnet", "short-prompt"]);
    expect(judgeSpecs(plan.scoring.judge!).map((judge) => judge.runner)).toEqual(["claude", "codex"]);
  });

  // The README is where an operator copies a config from, so its examples must parse as written.
  it("parses the README's backtest config examples", () => {
    const readme = readFileSync(join(import.meta.dirname, "README.md"), "utf8");
    const start = readme.indexOf("\n## Backtest human tickets\n");
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start + 1, readme.indexOf("\n## ", start + 1));
    const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(blocks).toHaveLength(2);
    const config = parseBacktest(JSON.parse(blocks[0]!));
    expect(config.scoring.judge).toEqual({ model: "claude-opus-5-5", seed: null });
    // The second is the scoring block alone, a fragment of the first.
    const scored = parseBacktest({ ...JSON.parse(blocks[0]!), ...JSON.parse(`{${blocks[1]!}}`) });
    expect(scored.scoring).toMatchObject({ testCommand: "npx vitest run {file}", setup: "npm ci", judge: { model: "claude-opus-5-5", seed: "march" } });
  });
});

describe("experiments.ts backtest", () => {
  /** A PATH dir of stubs: gh answers fixtures and logs, every model CLI logs and fails. */
  function stubs(root: string) {
    const bin = join(root, "bin");
    const fixtures = join(root, "gh-fixtures");
    mkdirSync(bin); mkdirSync(fixtures);
    for (const [key, value] of Object.entries(VIEWS)) writeFileSync(join(fixtures, `${key.replace("/", "_").replace("#", "-")}.json`), JSON.stringify(value));
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(join(root, "gh.log"))}
if [ "$1 $2" = "pr view" ]; then repo="$5"; cat ${JSON.stringify(fixtures)}/"\${repo/\\//_}-$3.json"; exit $?; fi
if [ "$1" = api ]; then base="\${2#*compare/}"; echo "mb-\${base%%...*}"; exit 0; fi
exit 1
`);
    for (const model of ["claude", "codex", "opencode"]) {
      writeFileSync(join(bin, model), `#!/usr/bin/env bash\necho "${model} $*" >> ${JSON.stringify(join(root, "model.log"))}\nexit 1\n`);
    }
    for (const name of ["gh", "claude", "codex", "opencode"]) chmodSync(join(bin, name), 0o755);
    return bin;
  }
  const run = (root: string, args: string[]) => spawnSync(BUN, [EXPERIMENTS, ...args], {
    cwd: root, encoding: "utf8", env: fixtureGitEnv({ PATH: `${stubs(root)}:${process.env.PATH ?? ""}` }),
  });

  it("prints the sample through a local tracker, calls no model and makes only gh reads", async () => {
    const tickets = join(scratch(), "tickets.json");
    // The CLI reads the real clock, so the cache is fresh by it: no `pr list` refresh.
    const root = world({ kind: "local", key: "OA", file: tickets }, Date.now());
    for (const number of [1, 2, 7]) await seedLocalTracker(tickets, { key: "OA", issue: { number, title: `Ticket ${number}`, comments: [comment("early", "2026-09-01T00:00:00Z")] } });
    const config = join(root, "backtest.json");
    writeFileSync(config, JSON.stringify(raw(root)));
    const before = readFileSync(tickets, "utf8");
    const out = run(root, ["backtest", config, "--dry-run"]);
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("OA-1 (intake OAI-1) — org/app");
    expect(out.stdout).toContain("frozen ticket OA-1: 1 comment kept, 0 dropped");
    expect(out.stdout).toContain("no model was called");
    expect(existsSync(join(root, "model.log"))).toBe(false);
    const calls = readFileSync(join(root, "gh.log"), "utf8").trim().split("\n").map((line) => line.split(" "));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(readOnly)).toBe(true);
    expect(calls.some((args) => args[1] === "list")).toBe(false);
    expect(readFileSync(tickets, "utf8")).toBe(before);
  });

  it("fails a run fast when a sampled repo has no sources checkout: no model, no trial", async () => {
    const tickets = join(scratch(), "tickets.json");
    const root = world({ kind: "local", key: "OA", file: tickets }, Date.now());
    for (const number of [1, 2, 7]) await seedLocalTracker(tickets, { key: "OA", issue: { number, title: `Ticket ${number}`, comments: [] } });
    const config = join(root, "backtest.json");
    writeFileSync(config, JSON.stringify(raw(root)));
    const runDir = join(root, "run");
    const out = run(root, ["backtest", config, "--run-dir", runDir]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`no checkout of ${REPO}`);
    expect(out.stderr).toContain(`"sources": { "${REPO}"`);
    expect(existsSync(join(root, "model.log"))).toBe(false);
    expect(existsSync(runDir)).toBe(false);
  });

  it("refuses --dry-run with --run-dir", () => {
    const root = scratch();
    const out = run(root, ["backtest", join(root, "missing.json"), "--dry-run", "--run-dir", "x"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("--dry-run and --run-dir do not go together");
    expect(out.stderr).toContain("usage: experiments.ts");
  });

  it("refuses a clerk that is not a clerk on the project's roster", () => {
    const root = world();
    const config = join(root, "backtest.json");
    writeFileSync(config, JSON.stringify(raw(root, { clerk: "rafa" })));
    const out = run(root, ["backtest", config, "--dry-run"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("backtest config: clerk rafa is not a clerk on the project's roster");
  });

  it("names the bad key of an invalid config", () => {
    const root = scratch();
    const config = join(root, "backtest.json");
    writeFileSync(config, JSON.stringify({ ...raw(root), sample: {} }));
    const out = run(root, ["backtest", config, "--dry-run"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("backtest config: sample.cap must be a positive integer");
  });

  it("eval --dry-run freezes the PRs a plan's source names, through the project's tracker, and calls no model (#801)", async () => {
    const tickets = join(scratch(), "tickets.json");
    const root = world({ kind: "local", key: "OA", file: tickets }, Date.now());
    await seedLocalTracker(tickets, { key: "OA", issue: { number: 1, title: "Ticket 1", comments: [comment("early", "2026-09-01T00:00:00Z"), comment("late", "2026-10-02T06:00:00Z")] } });
    const plan = join(root, "plan.json");
    writeFileSync(plan, JSON.stringify({
      project: root, source: { kind: "pr", repo: REPO, prs: [11, 12], ticket: "OA-1" },
      arms: [{ name: "opus" }, { name: "sonnet", lineup: "sonnet-coder" }], caps: { trialMinutes: 60, batchMinutes: 240 },
    }));
    const out = run(root, ["eval", plan, "--dry-run"]);
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`Eval dry run — ${REPO} #11, #12, ticket OA-1`);
    expect(out.stdout).toContain("frozen ticket OA-1: 1 comment kept, 1 dropped");
    expect(out.stdout).toContain("reference: a person's merged work");
    expect(out.stdout).toContain("  sonnet: lineup sonnet-coder");
    expect(existsSync(join(root, "model.log"))).toBe(false);
    const calls = readFileSync(join(root, "gh.log"), "utf8").trim().split("\n").map((line) => line.split(" "));
    expect(calls.every(readOnly)).toBe(true);
  });

  it("says run and report are retired, and where to go instead", () => {
    const root = scratch();
    const out = run(root, ["run", join(root, "model-ab.json")]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("run is retired; compare arms on a merged PR with eval");
  });
});
