import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestPr, BacktestTicket } from "./backtest";
import type { JudgeCall } from "./backtest-judge";
import type { TrialRow } from "./backtest-report";
import { scoreBacktest, scoreRepeats, type TicketScore } from "./backtest-score";
import { AXES } from "./eval-panel";
import type { LocalReviewOptions, LocalReviewResult } from "./local-review";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("git, sh");

const env = () => fixtureGitEnv({
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * A source repo with a merge base and a human PR adding `add.sh` and its
 * test, plus a test the PR touches that already passes at the base; and agent
 * work on top of the same base: right, wrong, and conflicting with the test.
 * `check` replaces the gate's script; with `config: false` the merge base has
 * no project config, and with it or `sandboxGates` the agents start from a
 * sandbox base whose config commit names those gates (the merge base's by default).
 */
function fixture(opts: { check?: string; config?: boolean; sandboxGates?: Record<string, string> } = {}) {
  const root = realpathSync(scratchDir("backtest-score-"));
  const source = join(root, "app");
  mkdirSync(source);
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  const projectConfig = { ".ralph/config.json": JSON.stringify({ baseBranch: "main", gates: { test: "sh check.sh" } }) };
  const mergeBase = commit(source, {
    ...(opts.config === false ? {} : projectConfig),
    "check.sh": opts.check ?? "test -f add.sh\n",
    "old.test.sh": "exit 0\n",
  }, "base");
  git(source, ["checkout", "--quiet", "-b", "human"]);
  const humanFirst = commit(source, {
    "add.sh": "echo $((1 + 2))\n",
    "add.test.sh": "test \"$(sh add.sh)\" = 3\n",
  }, "add");
  // Main moves on with someone else's test, and the human branch merges it in: not this ticket's evidence.
  git(source, ["checkout", "--quiet", "main"]);
  commit(source, { "other.test.sh": "exit 1\n" }, "unrelated work");
  git(source, ["checkout", "--quiet", "human"]);
  git(source, ["merge", "--quiet", "--no-ff", "--no-edit", "main"]);
  const humanFinal = commit(source, { "old.test.sh": "# still fine\nexit 0\n" }, "touch old test");
  git(source, ["checkout", "--quiet", "main"]);

  // A human head the source never fetched: only `fetchHumanPr` can bring it in.
  const elsewhere = join(root, "elsewhere");
  git(root, ["clone", "--quiet", "--branch", "human", source, elsewhere]);
  const unfetched = commit(elsewhere, { "README.md": "late\n", "late.test.sh": "test -f add.sh\n" }, "late human push");

  const agents = join(root, "agents");
  git(root, ["clone", "--quiet", source, agents]);
  git(agents, ["checkout", "--quiet", "-b", "sandbox", mergeBase]);
  const sandboxConfig = { ".ralph/config.json": JSON.stringify({ baseBranch: "main", gates: opts.sandboxGates ?? { test: "sh check.sh" } }) };
  const sandbox = opts.config === false || opts.sandboxGates ? commit(agents, sandboxConfig, "sandbox config") : mergeBase;
  git(agents, ["checkout", "--quiet", "-b", "arm-b", sandbox]);
  const bFirst = commit(agents, { "add.sh": "echo 4\n" }, "b first");
  const bFinal = commit(agents, { "add.sh": "echo 3\n" }, "b final");
  git(agents, ["checkout", "--quiet", "-b", "arm-c", sandbox]);
  const cHead = commit(agents, { "add.sh": "echo 5\n" }, "c only");
  git(agents, ["checkout", "--quiet", "-b", "arm-conflict", sandbox]);
  const conflictHead = commit(agents, { "add.sh": "echo 3\n", "add.test.sh": "exit 1\n" }, "own test");
  return { root, source, elsewhere, agents, mergeBase, sandbox, humanFirst, humanFinal, unfetched, bFirst, bFinal, cHead, conflictHead };
}

type Fixture = ReturnType<typeof fixture>;

const pr = (overrides: Partial<BacktestPr>): BacktestPr => ({
  number: 7, url: "https://github.com/your-org/your-repo/pull/7", createdAt: "2026-10-02T10:00:00Z",
  mergedAt: "2026-10-02T12:00:00Z", headRefName: "human", firstCommit: "", headRefOid: "", ...overrides,
});

const ticket = (oaKey: string, f: Fixture, humanPrs: BacktestPr[]): BacktestTicket => ({
  oaKey, intakeKey: null, movedAt: "2026-10-01T10:00:00Z", repo: "your-org/your-repo", humanPrs,
  mergeBase: f.mergeBase, startedAt: humanPrs[0]!.createdAt, ticketRef: oaKey,
  comments: { kept: 0, dropped: 0 }, frozen: { title: oaKey, body: "", comments: [] },
});

const row = (oaKey: string, arm: "b" | "c", heads: TrialRow["heads"]): TrialRow => ({
  ticket: oaKey, arm, lineup: arm === "b" ? "live" : "codex", outcome: "green-pr", detail: "COMPLETE",
  gates: [{ name: "trial/test", conclusion: arm === "b" ? "SUCCESS" : "FAILURE" }], weakening: [],
  reviewRounds: 0, reviewThreads: 0, wallSeconds: 60, tokens: null, cost: { usd: null, source: "unknown" },
  artifacts: `${oaKey}/${arm}`, models: [], heads,
});

const config = (f: Fixture): BacktestConfig => ({
  project: "fixture", clerk: "clara", sample: { cap: 10, since: null, repos: null }, lineup: "codex",
  caps: { trialMinutes: 1, batchMinutes: 10 }, rates: null, sources: { "your-org/your-repo": f.source },
  scoring: { testGlobs: ["**/*.test.sh"], testCommand: "sh {file}", setup: "touch .setup-ran", review: true, judge: null },
});

/** The fixture's config with the judge on. */
const judged = (f: Fixture, seed: string | null): BacktestConfig => ({ ...config(f), scoring: { ...config(f).scoring, review: false, judge: { model: "m", seed } } });

/** A stub judge factory: records each call's options and prompt, and answers with `answer(prompt)`. */
function judgeStub(answer: (prompt: string) => string) {
  const calls: { opts: { model: string; cwd: string; logPath: string }; prompt: string }[] = [];
  const factory = (opts: { model: string; cwd: string; logPath: string }): JudgeCall => async (prompt) => {
    calls.push({ opts, prompt });
    return { ok: true, text: answer(prompt) };
  };
  return { calls, factory };
}

/** Every label the prompt shows, tied in one tier and scored 3 on every axis. */
const tieAll = (prompt: string): string => {
  const labels = [...prompt.matchAll(/^## Candidate (\d+)/gm)].map((m) => m[1]!);
  const axes = Object.fromEntries(AXES.map((axis) => [axis, { score: 3, evidence: "alike" }]));
  return JSON.stringify({ ranking: [labels], candidates: Object.fromEntries(labels.map((label) => [label, { axes, better: "nothing" }])), reason: "all alike" });
};

/** A run dir as the batch runner leaves it: state.json, the rows, a bundle and a result per arm. */
function runDir(f: Fixture): string {
  const dir = join(f.root, "run");
  const bundle = (oaKey: string, arm: string, branch: string) => {
    mkdirSync(join(dir, oaKey, arm), { recursive: true });
    git(f.agents, ["bundle", "create", "--quiet", join(dir, oaKey, arm, "arm.bundle"), branch]);
    writeFileSync(join(dir, oaKey, arm, "result.json"), "{\"outcome\":{\"kind\":\"finished\"}}\n");
  };
  bundle("OA-1", "b", "arm-b");
  bundle("OA-1", "c", "arm-c");
  bundle("OA-2", "b", "arm-conflict");
  const humanPrs = [pr({ firstCommit: f.humanFirst, headRefOid: f.humanFinal })];
  const state = {
    version: 1, id: "run", startedAt: "2026-10-28T00:00:00Z", config: config(f),
    sample: {
      tickets: [
        ticket("OA-1", f, humanPrs),
        ticket("OA-2", f, [
          pr({ number: 8, firstCommit: f.humanFirst, headRefOid: f.humanFirst, createdAt: "2026-10-03T00:00:00Z", mergedAt: "2026-10-03T01:00:00Z" }),
          pr({ number: 9, firstCommit: f.unfetched, headRefOid: f.unfetched, createdAt: "2026-10-03T02:00:00Z", mergedAt: "2026-10-03T04:00:00Z" }),
        ]),
      ],
      skipped: [], notes: [], arms: { b: "live lineup", c: "codex" },
    },
    rows: {
      "OA-1/b": row("OA-1", "b", { base: f.sandbox, first: f.bFirst, final: f.bFinal }),
      "OA-1/c": row("OA-1", "c", { base: f.sandbox, first: f.cHead, final: f.cHead }),
      "OA-2/b": row("OA-2", "b", { base: f.sandbox, first: f.conflictHead, final: f.conflictHead }),
    },
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  return dir;
}

function deps(f: Fixture) {
  const reviews: { base: string; head: string | undefined; out: string | undefined; workflowFile?: string | undefined }[] = [];
  const fetched: number[] = [];
  const gh: string[][] = [];
  return {
    reviews, fetched, gh,
    deps: {
      review: async (opts: LocalReviewOptions): Promise<LocalReviewResult> => {
        reviews.push({ base: opts.base, head: opts.head, out: opts.out, workflowFile: opts.workflowFile });
        if (opts.head === f.cHead) return { status: "unavailable", reason: "claude is out", base: opts.base, head: opts.head };
        return {
          status: "ok", base: opts.base, head: opts.head!, playwright: "skipped", playwrightNote: null,
          workflow: { path: ".github/workflows/revision-claude.yml", ref: opts.base }, costUsd: null, durationMs: null,
          findings: [
            { priority: "P1", path: "add.sh", line: 1, title: "wrong", text: "it is wrong" },
            { priority: "P3", path: "add.sh", line: null, title: "nit", text: "a nit" },
          ],
          screenshots: [join(opts.out!, "screenshots", "home.png")],
        };
      },
      gh: async (args: string[]) => {
        gh.push(args);
        if (args[1]!.endsWith("/pulls/9/reviews")) throw new Error("gh: HTTP 502");
        return JSON.stringify([[
          { state: "COMMENTED", commit_id: "aaa" },
          { state: "CHANGES_REQUESTED", commit_id: "aaa" },
        ], [
          { state: "APPROVED", commit_id: "bbb" },
          { state: "PENDING", commit_id: "ccc" },
        ]]);
      },
      fetchHumanPr: (clone: string, _repo: string, number: number) => {
        fetched.push(number);
        if (number === 9) git(clone, ["fetch", "--quiet", f.elsewhere, "human:refs/human/9"]);
      },
      log: () => {},
      scratchParent: f.root,
    },
  };
}

describe("scoreBacktest", () => {
  it("scores the human arm and every agent arm, and a rescore rewrites only the scores", async () => {
    const f = fixture();
    const dir = runDir(f);
    const stub = deps(f);
    const scores = await scoreBacktest(dir, config(f), stub.deps);
    const [one, two] = scores as [TicketScore, TicketScore];

    // Held-out: the PR's new test fails at the base, the touched one already passes.
    expect(one.baseline).toEqual([{ path: "add.test.sh", result: "fail" }, { path: "old.test.sh", result: "pass" }]);
    const [a, b, c] = one.arms;
    expect(a).toMatchObject({
      arm: "a", heads: { first: f.humanFirst, final: f.humanFinal }, heldOut: null,
      gates: [{ name: "trial/test", conclusion: "SUCCESS" }],
      human: { openToMergeSeconds: 7200, rounds: 1 },
    });
    expect(b).toMatchObject({
      arm: "b", heads: { first: f.bFirst, final: f.bFinal },
      heldOut: { status: "ok", files: [
        { path: "add.test.sh", baseline: "fail", result: "pass" },
        { path: "old.test.sh", baseline: "pass", result: "pass" },
      ] },
      gates: [{ name: "trial/test", conclusion: "SUCCESS" }], human: null,
    });
    expect(c!.heldOut).toEqual({ status: "ok", files: [
      { path: "add.test.sh", baseline: "fail", result: "fail" },
      { path: "old.test.sh", baseline: "pass", result: "pass" },
    ] });
    // OA-2's two PRs: each one's own tests, and neither the merged-in other.test.sh nor old.test.sh, which no PR's own commits touched.
    expect(two.baseline).toEqual([{ path: "add.test.sh", result: "fail" }, { path: "late.test.sh", result: "fail" }]);
    const conflict = two.arms[1]!;
    expect(conflict.heldOut).toMatchObject({ status: "not-applicable" });
    expect((conflict.heldOut as { reason: string }).reason).toMatch(/add\.test\.sh/);

    // Reviews: human and agent first + final against their own bases; one call when first === final.
    expect(stub.reviews.filter((call) => call.out!.includes("/OA-1/"))).toEqual([
      { base: f.mergeBase, head: f.humanFirst, out: join(dir, "OA-1", "a", "review-first") },
      { base: f.mergeBase, head: f.humanFinal, out: join(dir, "OA-1", "a", "review-final") },
      { base: f.mergeBase, head: f.bFirst, out: join(dir, "OA-1", "b", "review-first") },
      { base: f.mergeBase, head: f.bFinal, out: join(dir, "OA-1", "b", "review-final") },
      { base: f.mergeBase, head: f.cHead, out: join(dir, "OA-1", "c", "review-first") },
    ]);
    expect(b!.review!.final).toEqual({
      status: "ok", head: f.bFinal, counts: { P1: 1, P2: 0, P3: 1 }, findings: expect.any(Array),
      dir: "OA-1/b/review-final", screenshots: ["OA-1/b/review-final/screenshots/home.png"],
    });
    expect(c!.review).toEqual({
      first: { status: "unavailable", head: f.cHead, reason: "claude is out" },
      final: { status: "unavailable", head: f.cHead, reason: "claude is out" },
    });

    // A head missing from the source comes in through fetchHumanPr; a gh failure is a note, not a throw.
    expect(stub.fetched).toEqual([8, 9]);
    expect(two.arms[0]).toMatchObject({ heads: { first: f.humanFirst, final: f.unfetched }, human: { openToMergeSeconds: 4 * 3600, rounds: null } });
    expect(two.arms[0]!.notes.join("\n")).toMatch(/#9: gh: HTTP 502/);
    expect(stub.gh[0]).toEqual(["api", "repos/your-org/your-repo/pulls/7/reviews", "--paginate", "--slurp"]);

    expect(JSON.parse(readFileSync(join(dir, "OA-1", "scores.json"), "utf8"))).toEqual(one);
    expect(JSON.parse(readFileSync(join(dir, "OA-2", "scores.json"), "utf8"))).toEqual(two);

    // The rescore: trial artifacts untouched, scores recomputed over the old file.
    const bundle = join(dir, "OA-1", "b", "arm.bundle");
    const before = { bundle: statSync(bundle).mtimeMs, result: readFileSync(join(dir, "OA-1", "b", "result.json"), "utf8"), state: readFileSync(join(dir, "state.json"), "utf8") };
    writeFileSync(join(dir, "OA-1", "scores.json"), "stale\n");
    const again = await scoreBacktest(dir, config(f), deps(f).deps);
    expect(statSync(bundle).mtimeMs).toBe(before.bundle);
    expect(readFileSync(join(dir, "OA-1", "b", "result.json"), "utf8")).toBe(before.result);
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before.state);
    const rescored = JSON.parse(readFileSync(join(dir, "OA-1", "scores.json"), "utf8")) as TicketScore;
    expect(rescored).toEqual(again[0]);
    expect(rescored.arms[1]!.heldOut).toEqual(b!.heldOut);
  });

  it("writes nothing for a ticket whose scoring a Ctrl-C cut short, and starts no later ticket", async () => {
    const f = fixture();
    const dir = runDir(f);
    writeFileSync(join(dir, "OA-1", "scores.json"), "previous\n");
    const controller = new AbortController();
    const stub = deps(f);
    const review = stub.deps.review;
    const scores = await scoreBacktest(dir, config(f), {
      ...stub.deps,
      signal: controller.signal,
      review: async (opts: LocalReviewOptions) => { controller.abort(); return review(opts); },
    });
    expect(scores).toEqual([]);
    expect(readFileSync(join(dir, "OA-1", "scores.json"), "utf8")).toBe("previous\n");
    expect(existsSync(join(dir, "OA-2", "scores.json"))).toBe(false);
    // Nothing is spawned or reviewed after the abort: one review call, the one that stopped it.
    expect(stub.reviews).toHaveLength(1);
  });

  it("degrades a ticket whose source cannot be cloned and scores the next", async () => {
    const f = fixture();
    const dir = runDir(f);
    const broken = { ...config(f), sources: { "your-org/your-repo": join(f.root, "missing") }, scoring: { ...config(f).scoring, review: false } };
    const scores = await scoreBacktest(dir, broken, deps(f).deps);
    expect(scores).toHaveLength(2);
    expect(scores[0]!.arms[0]!.notes[0]).toMatch(/^scoring: git clone/);
    expect(scores[0]!.arms[1]).toMatchObject({ arm: "b", heldOut: { status: "none" }, review: null });
  });

  it("judges each ticket's arm diffs blind, seeded by the config", async () => {
    const f = fixture();
    const dir = runDir(f);
    const judge = judgeStub(tieAll);
    const [one, two] = await scoreBacktest(dir, judged(f, "fixed"), { ...deps(f).deps, judge: judge.factory }) as [TicketScore, TicketScore];
    expect(one.judge).toMatchObject({ status: "ok", seed: "fixed", tie: true, reason: "all alike" });
    expect([...one.judge!.order].sort()).toEqual(["a", "b", "c"]);
    expect([...two.judge!.order].sort()).toEqual(["a", "b"]);
    expect(judge.calls).toHaveLength(2);
    const prompt = judge.calls[0]!.prompt;
    // The human's change, and each agent arm's own final diff against its sandbox base.
    expect(prompt).toContain("+echo $((1 + 2))");
    expect(prompt).toContain("+echo 3");
    expect(prompt).toContain("+echo 5");
    // b's first head, before its review round, is shown as its own section (#801).
    expect(prompt).toContain("+echo 4");
    expect(prompt.match(/### First head/g)).toHaveLength(1);
    // The human's own commits only: the main the branch merged in is someone else's work.
    expect(prompt).toContain("+# still fine");
    expect(prompt).not.toContain("other.test.sh");
    // Two PRs, the second on top of the merge of main: each PR's own change, and nothing from main.
    const second = judge.calls[1]!.prompt;
    expect(second).toContain("+echo $((1 + 2))");
    expect(second).toContain("+late");
    expect(second).not.toContain("other.test.sh");
    expect(judge.calls[0]!.opts).toMatchObject({ model: "m", logPath: join(dir, "OA-1", "scoring-logs", "judge-m.log") });
    expect(one.panel).toMatchObject({ seed: "fixed", contested: [], verdicts: [{ judge: { name: "m", runner: "claude", model: "m" }, status: "ok" }] });
    expect(judge.calls[0]!.opts.cwd.startsWith(join(f.root, "backtest-score-"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "OA-1", "scores.json"), "utf8"))).toEqual(one);
  });

  it("asks every judge on a two-family panel, each with its own log, and reports what they contest (#801)", async () => {
    const f = fixture();
    const dir = runDir(f);
    const base = judged(f, "fixed");
    const panel = [{ name: "opus", runner: "claude" as const, model: "claude-opus-5-5" }, { name: "gpt", runner: "codex" as const, model: "gpt-6-luna" }];
    const asked: { name: string; logPath: string }[] = [];
    // Opus scores candidates by their label, GPT against it: every pair is inverted on every axis.
    const scored = (up: boolean) => (prompt: string): string => {
      const labels = [...prompt.matchAll(/^## Candidate (\d+)/gm)].map((m) => m[1]!);
      const candidates = Object.fromEntries(labels.map((label) => {
        const score = up ? Number(label) : 6 - Number(label);
        return [label, { axes: Object.fromEntries(AXES.map((axis) => [axis, { score, evidence: "e" }])), better: "b" }];
      }));
      return JSON.stringify({ ranking: labels.map((label) => [label]), candidates, reason: "r" });
    };
    const [one] = await scoreBacktest(dir, { ...base, scoring: { ...base.scoring, judge: { ...base.scoring.judge!, panel } } }, {
      ...deps(f).deps,
      panelJudge: (spec, opts) => async (prompt) => {
        asked.push({ name: spec.name, logPath: opts.logPath });
        return { ok: true, text: scored(spec.runner === "claude")(prompt) };
      },
    }) as [TicketScore];
    expect(asked.filter((call) => call.logPath.includes(join("OA-1", "scoring-logs"))).map((call) => call.logPath.split("/").at(-1))).toEqual(["judge-opus.log", "judge-gpt.log"]);
    expect(one.panel!.verdicts.map((verdict) => `${verdict.judge.name}:${verdict.status}`)).toEqual(["opus:ok", "gpt:ok"]);
    // Three candidates, three pairs, five axes, every one inverted.
    expect(one.panel!.contested).toHaveLength(15);
    expect(one.panel!.contested[0]).toMatchObject({ axis: "correctness", judges: ["opus", "gpt"] });
  });

  it("asks Opus and the Codex model when the config names no judge model or panel, and Opus alone when there is no Codex model (#817)", async () => {
    const f = fixture();
    const dir = runDir(f);
    const base = config(f);
    const defaulted: BacktestConfig = { ...base, scoring: { ...base.scoring, review: false, judge: { model: "claude-opus-5-5", seed: "fixed", defaultPanel: true } } };
    const ask = async (codexModel: string | null): Promise<string[]> => {
      const asked: string[] = [];
      await scoreBacktest(dir, defaulted, {
        ...deps(f).deps, codexModel,
        panelJudge: (spec) => async () => { asked.push(`${spec.runner}:${spec.model}`); return { ok: false, reason: "stub" }; },
      });
      return [...new Set(asked)];
    };
    expect(await ask("gpt-x")).toEqual(["claude:claude-opus-5-5", "codex:gpt-x"]);
    expect(await ask(null)).toEqual(["claude:claude-opus-5-5"]);
  });

  it("seeds the judge with the run's id when the config names no seed", async () => {
    const f = fixture();
    const dir = runDir(f);
    const scores = await scoreBacktest(dir, judged(f, null), { ...deps(f).deps, judge: judgeStub(tieAll).factory });
    expect(scores.map((score) => score.judge?.seed)).toEqual(["run", "run"]);
  });

  it("records no verdict and calls no judge when scoring.judge is off", async () => {
    const f = fixture();
    const dir = runDir(f);
    const judge = judgeStub(tieAll);
    const scores = await scoreBacktest(dir, { ...config(f), scoring: { ...config(f).scoring, review: false } }, { ...deps(f).deps, judge: judge.factory });
    expect(scores.map((score) => score.judge)).toEqual([null, null]);
    expect(judge.calls).toEqual([]);
    // No diff is read for a judge that is off, so no arm carries a judge note.
    expect(scores.flatMap((score) => score.arms.flatMap((arm) => arm.notes)).filter((note) => note.startsWith("judge:"))).toEqual([]);
  });

  it("marks a garbage answer unavailable and scores everything else the same", async () => {
    const f = fixture();
    const dir = runDir(f);
    const good = await scoreBacktest(dir, judged(f, "fixed"), { ...deps(f).deps, judge: judgeStub(tieAll).factory });
    const bad = await scoreBacktest(dir, judged(f, "fixed"), { ...deps(f).deps, judge: judgeStub(() => "I liked them all").factory });
    expect(bad[0]!.judge).toMatchObject({ status: "unavailable", seed: "fixed", reason: "m: answered with no JSON object" });
    expect(bad.map((score) => score.arms)).toEqual(good.map((score) => score.arms));
    expect(bad.map((score) => score.baseline)).toEqual(good.map((score) => score.baseline));
  });

  /** Always red on one test; arm c's head (add.sh prints 5) breaks a second. */
  const redCheck = [
    "echo ' FAIL  src/a.test.ts > a > fails'",
    "[ \"$(sh add.sh 2>/dev/null)\" = 5 ] && echo ' FAIL  src/b.test.ts > b > breaks'",
    "exit 1",
    "",
  ].join("\n");

  it("judges every arm's gates against the tests the merge base already fails", async () => {
    const f = fixture({ check: redCheck });
    const dir = runDir(f);
    // Rows saved before #579: both agent arms' trial/test judged FAILURE by exit code.
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { rows: Record<string, TrialRow> };
    for (const key of ["OA-1/b", "OA-1/c"]) state.rows[key] = { ...state.rows[key]!, outcome: "failed", gates: [{ name: "trial/test", conclusion: "FAILURE" }] };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
    const [one] = await scoreBacktest(dir, { ...config(f), scoring: { ...config(f).scoring, review: false } }, deps(f).deps) as [TicketScore];

    const red = ["src/a.test.ts > a > fails"];
    expect(one.baseRed).toEqual({ version: 1, base: f.mergeBase, gates: { "trial/test": { conclusion: "FAILURE", failures: red } } });
    const [a, b, c] = one.arms;
    expect(a!.gates).toEqual([{ name: "trial/test", conclusion: "SUCCESS", baseRed: red }]);
    expect(b!.gates).toEqual([{ name: "trial/test", conclusion: "SUCCESS", baseRed: red }]);
    expect(c!.gates).toEqual([{ name: "trial/test", conclusion: "FAILURE" }]);
    expect(readFileSync(join(dir, "OA-1", "scoring-logs", "base-gates.log"), "utf8")).toContain("FAIL  src/a.test.ts > a > fails");
    expect(readFileSync(join(dir, "OA-1", "scoring-logs", "c-gates.log"), "utf8")).toContain("FAIL  src/b.test.ts > b > breaks");
    // OA-2's agent row passed its gate in the trial: it is never re-run.
    expect(existsSync(join(dir, "OA-2", "scoring-logs", "b-gates.log"))).toBe(false);
  });

  it("leaves a row alone whose trial already judged its checks against a base record", async () => {
    const f = fixture({ check: redCheck });
    const dir = runDir(f);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { rows: Record<string, TrialRow> };
    state.rows["OA-1/b"] = { ...state.rows["OA-1/b"]!, outcome: "failed", gates: [{ name: "trial/test", conclusion: "FAILURE" }] };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(dir, "OA-1", "b", "result.json"), JSON.stringify({ outcome: { kind: "finished" }, baseRed: { version: 1, base: f.sandbox, gates: {} } }));
    const [one] = await scoreBacktest(dir, { ...config(f), scoring: { ...config(f).scoring, review: false } }, deps(f).deps) as [TicketScore];
    const b = one.arms[1]!;
    expect(b.gates).toEqual([{ name: "trial/test", conclusion: "FAILURE" }]);
    expect(b.notes.filter((note) => note.startsWith("gates:"))).toEqual([]);
    expect(existsSync(join(dir, "OA-1", "scoring-logs", "b-gates.log"))).toBe(false);
  });

  it("takes the gates from an arm's sandbox base over the merge base's", async () => {
    const f = fixture({ sandboxGates: { test: "sh check.sh", lint: "true" } });
    const dir = runDir(f);
    const [one] = await scoreBacktest(dir, { ...config(f), scoring: { ...config(f).scoring, review: false } }, deps(f).deps) as [TicketScore];
    const human = one.arms[0]!;
    expect(human.gates).toEqual([{ name: "trial/test", conclusion: "SUCCESS" }, { name: "trial/lint", conclusion: "SUCCESS" }]);
    expect(human.notes).toContain(`gates: taken from the sandbox base ${f.sandbox}, the config the trials ran with`);
    // check.sh fails on the merge base, naming no test.
    expect(one.baseRed).toEqual({ version: 1, base: f.mergeBase, gates: {
      "trial/test": { conclusion: "FAILURE", failures: [] }, "trial/lint": { conclusion: "SUCCESS", failures: [] },
    } });
  });

  it("reviews every arm with the source checkout's workflow when it has one, else with the base's", async () => {
    const f = fixture();
    const without = deps(f);
    await scoreBacktest(runDir(f), config(f), without.deps);
    expect(without.reviews.length).toBeGreaterThan(0);
    expect(without.reviews.every((r) => r.workflowFile === undefined)).toBe(true);

    // A merge base older than the workflow has none: today's review, from the live checkout, judges every arm.
    const workflow = join(f.source, ".github", "workflows", "revision-claude.yml");
    mkdirSync(join(f.source, ".github", "workflows"), { recursive: true });
    writeFileSync(workflow, "name: Revisión Claude\n");
    const withFile = deps(f);
    await scoreBacktest(runDir(f), config(f), withFile.deps);
    expect(withFile.reviews.length).toBe(without.reviews.length);
    expect(withFile.reviews.every((r) => r.workflowFile === workflow)).toBe(true);
  });

  it("still finds the gates on a sandbox base when the merge base has no project config", async () => {
    const f = fixture({ config: false });
    const dir = runDir(f);
    const [one] = await scoreBacktest(dir, { ...config(f), scoring: { ...config(f).scoring, review: false } }, deps(f).deps) as [TicketScore];
    expect(one.arms[0]!.gates).toEqual([{ name: "trial/test", conclusion: "SUCCESS" }]);
  });
});

describe("scoreRepeats", () => {
  /** OA-1 repeated once: b's repeat wrote c's wrong answer, c's repeat b's right one. OA-2 never repeated. */
  function repeated(f: Fixture): string {
    const dir = runDir(f);
    for (const [arm, branch] of [["b-r1", "arm-c"], ["c-r1", "arm-b"]] as const) {
      mkdirSync(join(dir, "OA-1", arm), { recursive: true });
      git(f.agents, ["bundle", "create", "--quiet", join(dir, "OA-1", arm, "arm.bundle"), branch]);
      writeFileSync(join(dir, "OA-1", arm, "result.json"), "{\"outcome\":{\"kind\":\"finished\"}}\n");
    }
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { rows: Record<string, TrialRow> };
    state.rows["OA-1/b/r1"] = { ...row("OA-1", "b", { base: f.sandbox, first: f.cHead, final: f.cHead }), artifacts: "OA-1/b-r1", repeat: 1 };
    state.rows["OA-1/c/r1"] = { ...row("OA-1", "c", { base: f.sandbox, first: f.bFirst, final: f.bFinal }), artifacts: "OA-1/c-r1", repeat: 1 };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
    return dir;
  }

  it("scores and judges each repeat as a first trial, beside the case's first scores, reusing the reference's (#821)", async () => {
    const f = fixture();
    const dir = repeated(f);
    const cfg: BacktestConfig = { ...config(f), scoring: { ...config(f).scoring, judge: { model: "m", seed: "fixed" } } };
    const firsts = await scoreBacktest(dir, cfg, { ...deps(f).deps, judge: judgeStub(tieAll).factory });
    const first = readFileSync(join(dir, "OA-1", "scores.json"), "utf8");

    const stub = deps(f);
    const judge = judgeStub(tieAll);
    const [one, ...rest] = await scoreRepeats(dir, cfg, { ...stub.deps, judge: judge.factory }, { references: firsts });
    expect(rest).toEqual([]);
    expect(one).toMatchObject({ ticket: "OA-1", repeat: 1 });
    const [a, b, c] = one!.arms;
    // Each repeat's own trees: b's repeat fails the held-out test, c's passes it.
    expect(b).toMatchObject({ arm: "b", heads: { first: f.cHead, final: f.cHead } });
    expect((b!.heldOut as { files: { path: string; result: string }[] }).files.find((file) => file.path === "add.test.sh")!.result).toBe("fail");
    expect((c!.heldOut as { files: { path: string; result: string }[] }).files.find((file) => file.path === "add.test.sh")!.result).toBe("pass");
    // Reviewed from the repeat's own directory; the reference is not reviewed nor read from GitHub again.
    expect(stub.reviews.map((call) => call.out)).toEqual([
      join(dir, "OA-1", "b-r1", "review-first"),
      join(dir, "OA-1", "c-r1", "review-first"),
      join(dir, "OA-1", "c-r1", "review-final"),
    ]);
    expect(stub.gh).toEqual([]);
    const reference = firsts[0]!.arms[0]!;
    expect(a).toMatchObject({ arm: "a", gates: reference.gates, review: reference.review, human: reference.human });

    // The panel judged the repeat on its own seed, with the reference among the candidates, logged apart from the first's.
    expect(one!.panel).toMatchObject({ seed: "fixed/r1", verdicts: [{ status: "ok" }] });
    expect([...one!.panel!.order].sort()).toEqual(["a", "b", "c"]);
    expect(judge.calls.map((call) => call.opts.logPath)).toEqual([join(dir, "OA-1", "scoring-logs-r1", "judge-m.log")]);

    expect(JSON.parse(readFileSync(join(dir, "OA-1", "scores-r1.json"), "utf8"))).toEqual(one);
    // The first trial's scores, which the verdict is, are untouched.
    expect(readFileSync(join(dir, "OA-1", "scores.json"), "utf8")).toBe(first);
    expect(existsSync(join(dir, "OA-2", "scores-r1.json"))).toBe(false);

    // Limited to named cases: OA-2 has no repeat, so nothing is scored.
    expect(await scoreRepeats(dir, cfg, deps(f).deps, { references: firsts, tickets: ["OA-2"] })).toEqual([]);
  });

  it("still judges a repeat whose case has no first score, and says the reference's checks are missing", async () => {
    const f = fixture();
    const dir = repeated(f);
    const [one] = await scoreRepeats(dir, judged(f, "fixed"), { ...deps(f).deps, judge: judgeStub(tieAll).factory }, { references: [] });
    expect(one!.judge).toMatchObject({ status: "ok", seed: "fixed/r1" });
    expect(one!.arms[0]).toMatchObject({ arm: "a", gates: null, review: null, human: null });
    expect(one!.arms[0]!.notes.join("\n")).toMatch(/first scoring is missing/);
  });
});

describe("scoreBacktest with an operator check (#857)", () => {
  it("grades each agent arm's final tree with the case's check, and leaves the rest of the scores alone", async () => {
    const f = fixture();
    const dir = runDir(f);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { sample: Record<string, unknown> };
    state.sample.set = { version: null, selected: ["OA-1", "OA-2"], checks: ["OA-1"], checkRuns: { "OA-1": { test: "add.test.sh" } } };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
    const [one, two] = await scoreBacktest(dir, config(f), deps(f).deps) as [TicketScore, TicketScore];

    const [a, b, c] = one.arms;
    expect("check" in a!).toBe(false);
    // The reference's add.test.sh on b's right sum and c's wrong one.
    expect(b!.check).toEqual({ result: "pass" });
    expect(c!.check).toEqual({ result: "fail" });
    // A case without a check has no check key at all.
    expect(two.arms.every((arm) => !("check" in arm))).toBe(true);
  });
});
