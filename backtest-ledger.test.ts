import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestSample, BacktestTicket } from "./backtest";
import {
  experimentsDir, ledgerEntries, mergeLedger, parseLedger, publishResults, readRecorded, renderResults, runNightly, type LedgerEntry, type NightlyDeps,
} from "./backtest-ledger";
import type { BacktestReport, TrialRow } from "./backtest-report";
import { trialConfig } from "./backtest-run";
import type { ArmScore, TicketScore } from "./backtest-score";
import { stampJudgeAccuracy } from "./eval-judge-accuracy";
import type { PanelResult } from "./eval-panel";
import type { GitRunner } from "./publish-journal";
import { MIXED_SET_CASES, mixedSetReport } from "./fixtures/evals/mixed-set";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("publishes backtest results to a scratch origin through git");

const env = fixtureGitEnv({
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});
const git: GitRunner = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", env });
  return { status: result.status ?? 124, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const must = (args: string[]): string => {
  const result = git(args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A bare origin and a harness clone of it, as the journal publisher sees them. */
function harness() {
  const root = scratchDir("backtest-ledger-");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  must(["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  must(["clone", "--quiet", origin, home]);
  must(["-C", home, "checkout", "--quiet", "-b", "main"]);
  writeFileSync(join(home, "README.md"), "harness\n");
  must(["-C", home, "add", "."]);
  must(["-C", home, "commit", "--quiet", "-m", "init"]);
  must(["-C", home, "push", "--quiet", "origin", "main"]);
  return { root, origin, home, worktree: join(root, "journal-wt") };
}

const ticket = (oaKey: string, pr: number): BacktestTicket => ({
  oaKey, intakeKey: `I-${oaKey}`, movedAt: "2026-10-28T00:00:00Z", repo: "org/app",
  humanPrs: [{ number: pr, url: `https://example.invalid/${pr}`, createdAt: "2026-10-28T01:00:00Z", mergedAt: "2026-10-28T02:00:00Z", headRefName: "fix", firstCommit: "f", headRefOid: "h" }],
  mergeBase: "m", startedAt: "2026-10-28T01:00:00Z", ticketRef: oaKey, comments: { kept: 0, dropped: 0 },
  frozen: { title: `Title | ${oaKey}`, body: "", comments: [] },
});
const row = (oaKey: string, outcome: TrialRow["outcome"], over: Partial<TrialRow> = {}): TrialRow => ({
  ticket: oaKey, arm: "b", lineup: "live", outcome, detail: "", gates: [{ name: "t", conclusion: "SUCCESS" }], weakening: [],
  reviewRounds: 1, reviewThreads: 0, wallSeconds: 1000, handoffSeconds: 900, tokens: null, cost: { usd: 20, source: "reported" }, artifacts: "", models: [], ...over,
});
const arm = (name: "a" | "b", over: Partial<ArmScore> = {}): ArmScore => ({
  arm: name, heads: { first: null, final: null }, heldOut: null, gates: [{ name: "t", conclusion: "SUCCESS" }, { name: "u", conclusion: "FAILURE" }], review: null,
  human: name === "a" ? { openToMergeSeconds: 7200, rounds: 2 } : null, notes: [], ...over,
});
const axes = (scores: [number | null, number | null, number | null, number | null, number | null]) => {
  const [correctness, scope, tests, maintainability, review] = scores.map((value) => ({ score: value, evidence: "long evidence text" }));
  return { correctness: correctness!, scope: scope!, tests: tests!, maintainability: maintainability!, review: review! };
};
const panel: PanelResult = {
  seed: "s", order: ["a", "b"],
  verdicts: [
    {
      judge: { name: "opus", runner: "claude", model: "claude-opus" }, status: "ok", ranking: [["b"], ["a"]], reason: "r",
      arms: { b: { axes: axes([5, 4, 3, 4, null]), better: "b better" }, a: { axes: axes([3, 5, 2, 3, null]), better: "a" } },
    },
    {
      judge: { name: "gpt", runner: "codex", model: "gpt-5" }, status: "ok", ranking: [["a"], ["b"]], reason: "r",
      arms: { a: { axes: axes([4, 4, 4, 4, null]), better: "" }, b: { axes: axes([3, 4, 2, 4, null]), better: "" } },
    },
    { judge: { name: "sonnet", runner: "claude", model: "claude-sonnet" }, status: "unavailable", reason: "timed | out" },
  ],
  contested: [{ axis: "correctness", arms: ["a", "b"], judges: ["opus", "gpt"] }],
  aggregate: { status: "ok", seed: "s", order: ["a", "b"], ranking: [["b"], ["a"]], winners: ["b"], tie: false, reason: "agg" },
};
const score = (oaKey: string, winners: ("a" | "b")[] = ["b"], withPanel?: PanelResult): TicketScore => ({
  ticket: oaKey, scoredAt: "2026-10-29T00:00:00Z", baseline: [],
  arms: [
    arm("a", { review: { first: { status: "unavailable", head: null, reason: "x" }, final: { status: "ok", head: "h", counts: { P1: 0, P2: 1, P3: 0 }, findings: [], dir: "", screenshots: [] } } }),
    arm("b", { heldOut: { status: "ok", files: [{ path: "x", baseline: "fail", result: "pass" }, { path: "y", baseline: "fail", result: "fail" }] } }),
  ],
  judge: { status: "ok", seed: "s", order: ["a", "b"], ranking: [winners], winners, tie: winners.length > 1, reason: `because ${oaKey}` },
  ...(withPanel ? { panel: withPanel } : {}),
});
const report = (rows: TrialRow[], scores: TicketScore[], over: Partial<BacktestReport> = {}): BacktestReport => ({
  id: "run-1", startedAt: "s", finishedAt: "2026-10-29T01:00:00Z", arms: { b: "live lineup", c: null }, rows, skipped: [], notes: [], stoppedBy: null, scores, ...over,
});
const entry = (oaKey: string, pr = 1, winners: ("a" | "b")[] = ["b"], withPanel?: PanelResult): LedgerEntry =>
  ledgerEntries(report([row(oaKey, "green-pr")], [score(oaKey, winners, withPanel)]), [ticket(oaKey, pr)])[0]!;

describe("ledgerEntries", () => {
  it("summarises a scored ticket, and leaves out one whose trial did not run, so it is retried", () => {
    const entries = ledgerEntries(
      report([row("OA-1", "green-pr"), row("OA-2", "not-run")], [score("OA-1"), score("OA-2")]),
      [ticket("OA-1", 1), ticket("OA-2", 2)],
    );
    expect(entries.map((e) => e.ticket)).toEqual(["OA-1"]);
    expect(entries[0]).toMatchObject({
      run: "run-1", repo: "org/app", prs: [{ number: 1 }], judge: { winners: ["b"], tie: false, reason: "because OA-1" },
      human: { openToMergeSeconds: 7200, rounds: 2, gates: "1/2", review: { P2: 1 } },
      agents: [{ arm: "b", outcome: "green-pr", handoffSeconds: 900, costUsd: 20, gates: "1/2", review: null, heldOut: "1/2" }],
    });
  });

  it("carries the panel's scores, judges and contested axes, without the evidence", () => {
    const got = entry("OA-1", 1, ["b"], panel);
    expect(got.panel).toEqual({
      verdicts: [
        { judge: { name: "opus", runner: "claude", model: "claude-opus" }, status: "ok", arms: {
          b: { correctness: 5, scope: 4, tests: 3, maintainability: 4, review: null },
          a: { correctness: 3, scope: 5, tests: 2, maintainability: 3, review: null },
        } },
        { judge: { name: "gpt", runner: "codex", model: "gpt-5" }, status: "ok", arms: {
          a: { correctness: 4, scope: 4, tests: 4, maintainability: 4, review: null },
          b: { correctness: 3, scope: 4, tests: 2, maintainability: 4, review: null },
        } },
        { judge: { name: "sonnet", runner: "claude", model: "claude-sonnet" }, status: "unavailable", reason: "timed | out" },
      ],
      contested: [{ axis: "correctness", arms: ["a", "b"], judges: ["opus", "gpt"] }],
    });
    const json = JSON.stringify(got);
    expect(json).not.toContain("evidence");
    expect(json).not.toContain("better");
  });

  it("records the first trial's verdict when the repeats are scored and judged otherwise (#821)", () => {
    const first = ledgerEntries(report([row("OA-1", "green-pr")], [score("OA-1", ["b"])]), [ticket("OA-1", 1)]);
    // A failed, judged repeat whose panel ranked the human first: evidence in the report, not the verdict.
    const repeat = { ...score("OA-1", ["a"]), repeat: 1, arms: [arm("a"), arm("b", { heldOut: { status: "ok" as const, files: [{ path: "x", baseline: "fail" as const, result: "fail" as const }] } })] };
    const withRepeats = ledgerEntries(
      report([row("OA-1", "green-pr"), row("OA-1", "failed", { repeat: 1 })], [score("OA-1", ["b"])], { repeatScores: [repeat] }),
      [ticket("OA-1", 1)],
    );
    expect(withRepeats).toEqual(first);
    expect(withRepeats[0]).toMatchObject({ judge: { winners: ["b"] }, agents: [{ outcome: "green-pr", heldOut: "1/2" }] });
  });

  it("records a null panel when the score has none", () => {
    expect(entry("OA-1").panel).toBeNull();
    expect(entry("OA-1", 1, ["b"], { ...panel, verdicts: [], contested: [] }).panel).toBeNull();
  });

  it("leaves out a ticket that was never scored", () => {
    expect(ledgerEntries(report([row("OA-1", "green-pr")], []), [ticket("OA-1", 1)])).toEqual([]);
  });
});

describe("the ledger file", () => {
  it("keeps a ticket's first verdict", () => {
    const merged = mergeLedger([entry("OA-1")], [{ ...entry("OA-1"), run: "later" }, entry("OA-2", 2)]);
    expect(merged.map((e) => [e.ticket, e.run])).toEqual([["OA-1", "run-1"], ["OA-2", "run-1"]]);
  });

  it("keeps a ticket's first verdict when a later run brings a panel", () => {
    const merged = mergeLedger([entry("OA-1")], [{ ...entry("OA-1", 1, ["b"], panel), run: "later" }]);
    expect(merged).toEqual([entry("OA-1")]);
  });

  it("reads a line written before the panel, and renders it as it always did", () => {
    const { panel: _dropped, ...old } = entry("OA-1");
    const line = JSON.stringify(old);
    expect(line).not.toContain("panel");
    const parsed = parseLedger(`${line}\n`);
    const text = renderResults("proj", parsed);
    expect(text).not.toContain("## Panel");
    expect(text).toContain("| OA-1 | app | agent (b) | b (live): green-pr |");
    expect(text).toBe(renderResults("proj", [{ ...parsed[0]!, panel: null }]));
    expect(text.endsWith("because OA-1\n")).toBe(true);
  });

  it("renders the panel after the judge's reasons: axis scores, contested cells, abstentions", () => {
    const text = renderResults("proj", [entry("OA-1", 1, ["b"], panel), entry("OA-2", 2)]);
    expect(text.indexOf("## Panel")).toBeGreaterThan(text.indexOf("## Why the judge chose"));
    expect(text).toContain("scores each arm 1–5 per axis");
    expect(text).not.toContain("### OA-2");
    const section = text.slice(text.indexOf("### OA-1"));
    expect(section).toContain("| Arm | Judge | correctness | scope | tests | maintainability | review |");
    const rows = section.split("\n").filter((line) => line.startsWith("| a") || line.startsWith("| b"));
    expect(rows).toEqual([
      "| a (human) | opus (claude claude-opus) | 3 ⚑ | 5 | 2 | 3 | — |",
      "| a (human) | gpt (codex gpt-5) | 4 ⚑ | 4 | 4 | 4 | — |",
      "| b | opus (claude claude-opus) | 5 ⚑ | 4 | 3 | 4 | — |",
      "| b | gpt (codex gpt-5) | 3 ⚑ | 4 | 2 | 4 | — |",
    ]);
    expect(section).toContain("- sonnet abstained: timed \\| out");
    expect(section).toContain("Contested (⚑) by ranking inversion between judge families, so read the diffs:");
    expect(section).toContain("- correctness: a (human) vs b (opus, gpt)");
  });

  it("records the spread rule and its one-arm contests, and names the rule in RESULTS.md (#818)", () => {
    const spread: PanelResult = { ...panel, rule: { kind: "spread", points: 2 }, contested: [{ axis: "tests", arms: ["b"], judges: ["opus", "gpt"] }] };
    const got = entry("OA-1", 1, ["b"], spread);
    expect(got.panel).toMatchObject({ rule: { kind: "spread", points: 2 }, contested: [{ axis: "tests", arms: ["b"], judges: ["opus", "gpt"] }] });
    expect(entry("OA-1", 1, ["b"], panel).panel).not.toHaveProperty("rule");
    const section = renderResults("proj", [got]).split("### OA-1")[1]!;
    expect(section).toContain("Contested (⚑) by a spread of 2+ points between judge families' mean scores, so read the diffs:");
    expect(section).toContain("- tests: b (opus, gpt)");
    expect(section).toContain("| a (human) | opus (claude claude-opus) | 3 | 5 | 2 | 3 | — |");
    expect(section).toContain("| b | opus (claude claude-opus) | 5 | 4 | 3 ⚑ | 4 | — |");
  });

  it("throws on a line it cannot read, rather than forgetting a paid-for ticket", () => {
    expect(() => parseLedger(`${JSON.stringify(entry("OA-1"))}\n{broken\n`)).toThrow();
  });

  it("renders totals and every ticket, newest first, with an escaped title", () => {
    const text = renderResults("proj", [entry("OA-1", 1, ["b"]), entry("OA-2", 2, ["a"]), entry("OA-3", 3, ["a", "b"]), { ...entry("OA-4", 4), judge: null }]);
    expect(text).toContain("# Backtest results: proj");
    expect(text).toContain("Judge, blind: agent 1, human 1, tie 1, not judged 1.");
    expect(text).toContain("Agent reached a green PR: 4/4 trials.");
    expect(text).toContain("Trial cost: $80.00.");
    expect(text).toContain("Median claim to hand-off: 15m. Median human open to merge: 2h 0m.");
    expect(text.indexOf("| OA-4 |")).toBeLessThan(text.indexOf("| OA-1 |"));
    expect(text).toContain("Title \\| OA-1");
    expect(text).toContain("because OA-2");
  });
});

describe("publishing", () => {
  it("commits the ledger and results to main, adds only new tickets, and does nothing when none are new", () => {
    const h = harness();
    const options = { projectId: "proj", home: h.home, worktree: h.worktree, git };
    expect(readRecorded("proj", h.home, git)).toEqual([]);
    expect(publishResults({ ...options, entries: [entry("OA-1")] }).added).toBe(1);
    const first = must(["-C", h.origin, "rev-parse", "main"]);
    expect(must(["-C", h.origin, "log", "-1", "--format=%s", "main"])).toBe("chore(backtest): results proj, 1 more ticket");
    expect(must(["-C", h.origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "main"]).split("\n").sort()).toEqual(["backtests/proj/RESULTS.md", "backtests/proj/ledger.jsonl"]);

    expect(publishResults({ ...options, entries: [entry("OA-1")] })).toEqual({ added: 0, sha: null });
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(first);

    expect(publishResults({ ...options, entries: [entry("OA-1"), entry("OA-2", 2)] }).added).toBe(1);
    expect(readRecorded("proj", h.home, git).map((e) => e.ticket)).toEqual(["OA-1", "OA-2"]);
  });

  it("retries on the fresh tip when a loop lands first, keeping what that loop pushed", () => {
    const h = harness();
    let landed = false;
    const result = publishResults({
      projectId: "proj", entries: [entry("OA-1")], home: h.home, worktree: h.worktree, git,
      beforePush: () => {
        if (landed) return;
        landed = true;
        writeFileSync(join(h.home, "journal.md"), "a loop\n");
        must(["-C", h.home, "add", "."]);
        must(["-C", h.home, "commit", "--quiet", "-m", "chore: journal"]);
        must(["-C", h.home, "push", "--quiet", "origin", "main"]);
      },
    });
    expect(result.added).toBe(1);
    expect(must(["-C", h.origin, "ls-tree", "-r", "--name-only", "main"]).split("\n")).toEqual(expect.arrayContaining(["journal.md", "backtests/proj/ledger.jsonl"]));
  });

  it("throws when the ledger cannot be fetched, rather than reading it as empty", () => {
    const h = harness();
    must(["-C", h.home, "remote", "set-url", "origin", join(h.root, "gone.git")]);
    expect(() => readRecorded("proj", h.home, git)).toThrow(/cannot read the backtest ledger/);
  });
});

describe("runNightly", () => {
  const config = (project: string): BacktestConfig => ({
    project, clerk: "clara", sample: { cap: 3, since: null, repos: null }, lineup: null, caps: { trialMinutes: 1, batchMinutes: 5 }, rates: null, sources: {},
    scoring: { testGlobs: [], testCommand: "", setup: null, review: false, judge: null },
  });
  const sampled = (tickets: BacktestTicket[]): BacktestSample => ({ tickets, skipped: [], notes: [], arms: { b: "live lineup", c: null } });
  function stubs(over: Partial<NightlyDeps> = {}) {
    const calls = { record: [] as string[], run: [] as string[], sample: [] as BacktestConfig[] };
    const deps: NightlyDeps = {
      projectId: "proj", readRecorded: () => [], day: () => "2026-10-30", log: () => {},
      record: (runDir) => { calls.record.push(runDir); return true; },
      sample: async (c) => { calls.sample.push(c); return sampled([ticket("OA-9", 9)]); },
      run: async (_c, runDir) => { calls.run.push(runDir); return { report: report([], []) }; },
      ...over,
    };
    return { calls, deps };
  }

  it("spends nothing when the ledger already holds every ticket", async () => {
    const { calls, deps } = stubs({ sample: async () => sampled([]) });
    expect(await runNightly(config(scratchDir("nightly-")), deps)).toBe(0);
    expect(calls.run).toEqual([]);
    expect(calls.record).toEqual([]);
  });

  it("hands the sampler what is recorded, runs in a dated dir and records the run", async () => {
    const project = scratchDir("nightly-");
    const { calls, deps } = stubs({ readRecorded: () => [entry("OA-1", 5)] });
    expect(await runNightly(config(project), deps)).toBe(0);
    expect(calls.sample[0]!.sample.recorded).toEqual({ tickets: ["OA-1"], prs: ["org/app#5"] });
    const dir = join(experimentsDir(config(project)), "nightly-2026-10-30");
    expect(calls.run).toEqual([dir]);
    expect(calls.record).toEqual([dir]);
  });

  it("does not record a stopped run, and says so in its status", async () => {
    const { calls, deps } = stubs({ run: async () => ({ report: report([], [], { finishedAt: null }) }) });
    expect(await runNightly(config(scratchDir("nightly-")), deps)).toBe(1);
    expect(calls.record).toEqual([]);
  });

  it("finishes a run a reboot cut short, in its own dir, before it samples anything new", async () => {
    const project = scratchDir("nightly-");
    const left = join(experimentsDir(config(project)), "nightly-2026-10-29");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "state.json"), "{}");
    // Written before scoring: finished trials, no scores yet.
    writeFileSync(join(left, "report.json"), JSON.stringify({ finishedAt: "2026-10-29T23:00:00Z" }));
    const order: string[] = [];
    const { deps } = stubs({
      run: async (_c, runDir) => { order.push(`run ${runDir}`); return { report: report([], []) }; },
      record: (runDir) => { order.push(`record ${runDir}`); return true; },
      readRecorded: () => { order.push("read"); return []; },
      sample: async () => sampled([]),
    });
    expect(await runNightly(config(project), deps)).toBe(0);
    expect(order).toEqual([`run ${left}`, `record ${left}`, "read"]);
  });

  it("resumes a run with the config it started with, which the batch's resume check demands", async () => {
    const project = scratchDir("nightly-");
    const left = join(experimentsDir(config(project)), "nightly-2026-10-29");
    mkdirSync(left, { recursive: true });
    const recorded = { tickets: ["OA-1"], prs: ["org/app#1"] };
    const started = { ...config(project), sample: { ...config(project).sample, recorded } };
    writeFileSync(join(left, "state.json"), JSON.stringify({ config: started }));
    let resumed: BacktestConfig | null = null;
    const { deps } = stubs({
      run: async (c) => { resumed = c; return { report: report([], []) }; },
      sample: async () => sampled([]),
    });
    await runNightly(config(project), deps);
    // A later night's ledger has moved on; the comparison must still be against what that run saw.
    expect(JSON.stringify(trialConfig(resumed!))).toBe(JSON.stringify(trialConfig(started)));
  });

  it("spends nothing new while an old run still cannot finish", async () => {
    const project = scratchDir("nightly-");
    const left = join(experimentsDir(config(project)), "nightly-2026-10-29");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "state.json"), "{}");
    const { calls, deps } = stubs({ run: async (_c, runDir) => { calls.run.push(runDir); return { report: report([], [], { scores: undefined }) }; } });
    expect(await runNightly(config(project), deps)).toBe(1);
    expect(calls.run).toEqual([left]);
    expect(calls.sample).toEqual([]);
    expect(calls.record).toEqual([]);
  });

  it("records a run left unrecorded on disk before it reads the ledger, so it is not paid for twice", async () => {
    const project = scratchDir("nightly-");
    const left = join(experimentsDir(config(project)), "nightly-2026-10-29");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "report.json"), JSON.stringify(report([], [])));
    writeFileSync(join(left, "state.json"), "{}");
    mkdirSync(join(experimentsDir(config(project)), "nightly-2026-10-28"));
    const order: string[] = [];
    const { deps } = stubs({
      record: (runDir) => { order.push(`record ${runDir}`); return true; },
      readRecorded: () => { order.push("read"); return []; },
      sample: async () => sampled([]),
    });
    expect(await runNightly(config(project), deps)).toBe(0);
    expect(order).toEqual([`record ${left}`, "read"]);
  });

  it("reports a failed record but still works the new tickets", async () => {
    const project = scratchDir("nightly-");
    const left = join(experimentsDir(config(project)), "nightly-2026-10-29");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "report.json"), JSON.stringify(report([], [])));
    writeFileSync(join(left, "state.json"), "{}");
    const { calls, deps } = stubs({ record: (runDir) => runDir !== left });
    expect(await runNightly(config(project), deps)).toBe(1);
    expect(calls.run.length).toBe(1);
  });

  it("stops when the ledger cannot be read, before it samples or spends", async () => {
    const { calls, deps } = stubs({ readRecorded: () => { throw new Error("no ledger"); } });
    await expect(runNightly(config(scratchDir("nightly-")), deps)).rejects.toThrow("no ledger");
    expect(calls.sample).toEqual([]);
    expect(calls.run).toEqual([]);
  });
});

describe("the CLI", () => {
  it("exits 64 on bad usage", () => {
    const run = spawnSync("bun", ["backtest-ledger.ts", "record"], { cwd: import.meta.dirname, encoding: "utf8" });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("usage:");
  });
});

describe("objective and judge scores in the ledger (#855)", () => {
  const graded = () => ledgerEntries(mixedSetReport(), MIXED_SET_CASES.map((oaKey, index) => ticket(oaKey, index + 1)));

  it("carries each case's grader and each arm's objective result and judge score, never a number made of both", () => {
    const entries = graded();
    expect(entries.map((e) => [e.ticket, e.grade])).toEqual([
      ["case-tests", { grader: "tests", noEvidence: false }],
      ["case-no-evidence", { grader: "judge-only", noEvidence: true }],
      ["case-judge-only", { grader: "judge-only", noEvidence: false }],
      ["case-check", { grader: "check", noEvidence: false }],
    ]);
    expect(entries.map((e) => e.agents.map((agent) => [agent.arm, agent.objective, agent.judge]))).toEqual([
      [["b", "pass", 4.44], ["c", "fail", 2]],
      [["b", null, 3], ["c", null, 2.5]],
      [["b", null, 4], ["c", null, 1]],
      [["b", "pending", 5], ["c", "pending", 2.5]],
    ]);
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); }
    };
    walk(entries);
    expect(keys.filter((key) => /blend|combin|overall|weighted/i.test(key))).toEqual([]);
  });

  it("renders the two scores in separate columns and names each case's grader", () => {
    const text = renderResults("proj", parseLedger(`${graded().map((e) => JSON.stringify(e)).join("\n")}\n`));
    expect(text).toContain("## Objective and judge scores");
    const lines = text.split("\n");
    expect(lines).toContain("| Arm | Objective | Judge |");
    expect(lines).toContain("| b (live) | 1/1 cases, 1 check pending | 4.11 over 4 cases |");
    expect(lines).toContain("| c (codex) | 0/1 cases, 1 check pending | 2.00 over 4 cases |");
    expect(lines).toContain("- **case-tests**: tests");
    expect(lines).toContain("- **case-no-evidence**: judge-only (no evidence)");
    expect(lines).toContain("- **case-judge-only**: judge-only");
    expect(lines).toContain("- **case-check**: check");
  });

  it("reads an entry written before #855 and renders it without the section", () => {
    const old = entry("OA-1");
    expect(old.grade).toBeUndefined();
    expect(old.agents[0]).not.toHaveProperty("objective");
    expect(old.agents[0]).not.toHaveProperty("judge");
    const parsed = parseLedger(`${JSON.stringify(old)}\n`);
    expect(renderResults("proj", parsed)).not.toContain("## Objective and judge scores");
    expect(mergeLedger(parsed, graded()).map((e) => e.ticket)).toEqual(["OA-1", ...MIXED_SET_CASES]);
  });
});

describe("judge accuracy in the ledger (#877)", () => {
  const cal = (axis: "correctness" | "scope" | "tests", preferred: string) =>
    ({ arms: ["b", "c"] as [string, string], axis, preferred, reason: "r", by: "op", at: "2026-11-19T00:00:00Z" });
  const calibrated = () => {
    const stamped = stampJudgeAccuracy(mixedSetReport(), [
      { id: "case-tests", calibration: [cal("correctness", "b"), cal("scope", "c")] },
      { id: "case-judge-only", calibration: [cal("correctness", "b")] },
    ]);
    // One verdict the panel contested, so the excluded count shows.
    const accuracy = stamped.judgeAccuracy!;
    const contested = { ...accuracy.checks[0]!, axis: "tests" as const, outcome: "contested" as const };
    return { ...stamped, judgeAccuracy: { ...accuracy, checks: [...accuracy.checks, contested], contested: accuracy.contested + 1 } };
  };
  const entries = () => ledgerEntries(calibrated(), MIXED_SET_CASES.map((oaKey, index) => ticket(oaKey, index + 1)));

  it("snapshots each case's checked verdicts, an empty list where the case has none, and no key off an accuracy", () => {
    const got = entries();
    expect(got.find((e) => e.ticket === "case-tests")?.calibration).toEqual([
      { axis: "correctness", arms: ["b", "c"], preferred: "b", panel: "b", outcome: "agree" },
      { axis: "scope", arms: ["b", "c"], preferred: "c", panel: "b", outcome: "disagree" },
      { axis: "tests", arms: ["b", "c"], preferred: "b", panel: "b", outcome: "contested" },
    ]);
    expect(got.find((e) => e.ticket === "case-check")?.calibration).toEqual([]);
    expect(ledgerEntries(mixedSetReport(), MIXED_SET_CASES.map((oaKey, index) => ticket(oaKey, index + 1)))[0]).not.toHaveProperty("calibration");
    expect(entry("OA-1")).not.toHaveProperty("calibration");
  });

  it("re-tallies the snapshots in a Judge accuracy section after the panel, and notes each case's counts", () => {
    const text = renderResults("proj", parseLedger(`${entries().map((e) => JSON.stringify(e)).join("\n")}\n`));
    expect(text.indexOf("## Judge accuracy")).toBeGreaterThan(text.indexOf("## Panel"));
    const lines = text.split("\n");
    expect(lines).toContain("Overall: 67% (2 of 3 verdicts).");
    expect(lines).toContain("- correctness: 100% (2 of 2 verdicts)");
    expect(lines).toContain("- scope: 0% (0 of 1 verdict)");
    expect(lines).toContain("1 verdict on an axis the panel contested is excluded.");
    const tests = text.split("### case-tests")[1]!.split("### ")[0]!;
    expect(tests).toContain("Calibration: 1 agree, 1 disagree, 1 contested");
    expect(text.split("### case-check")[1]!.split("### ")[0]!).not.toContain("Calibration:");
  });

  it("says no calibration yet when the snapshots hold no verdict", () => {
    const empty = ledgerEntries(stampJudgeAccuracy(mixedSetReport(), []), MIXED_SET_CASES.map((oaKey, index) => ticket(oaKey, index + 1)));
    const lines = renderResults("proj", empty).split("\n");
    expect(lines).toContain("## Judge accuracy");
    expect(lines).toContain("Overall: no calibration yet.");
    expect(lines.some((line) => line.startsWith("Calibration:"))).toBe(false);
  });

  it("renders a ledger written before #877 exactly as it did, with no section", () => {
    const old = parseLedger(`${ledgerEntries(mixedSetReport(), MIXED_SET_CASES.map((oaKey, index) => ticket(oaKey, index + 1))).map((e) => JSON.stringify(e)).join("\n")}\n`);
    const text = renderResults("proj", old);
    expect(text).not.toContain("Judge accuracy");
    expect(text).not.toContain("Calibration:");
    // The new snapshot is the only difference: strip it from a calibrated ledger and the two render alike.
    const stripped = entries().map(({ calibration: _calibration, ...rest }) => rest);
    expect(renderResults("proj", stripped)).toBe(text);
  });
});
