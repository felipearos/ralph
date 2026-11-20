import { describe, expect, it } from "vitest";

import { forgiveBaseRed, readIterationUsage, renderBacktestReport, repeatSummaries, scoreTrial, type BacktestReport, type TrialRow } from "./backtest-report";
import type { ArmScore, ReviewScore, TicketScore } from "./backtest-score";
import type { SpeedEvent } from "./speed";
import type { TrialResult } from "./trial-sandbox";
import { MIXED_SET_CASES, mixedSetReport } from "./fixtures/evals/mixed-set";
import { noiseFloorReport } from "./fixtures/evals/noise-floor";
import { stampNoise, type NoiseFloor, type NoiseReads } from "./eval-noise-floor";
import { guardrailSettings, stampGuardrails } from "./eval-guardrails";
import { stampJudgeAccuracy } from "./eval-judge-accuracy";

const head = (sha: string, checks: { name: string; conclusion: string; baseRed?: unknown }[] | null = null) => ({ sha, seenAt: "2026-10-28T00:00:00Z", checks });

const github = (heads: ReturnType<typeof head>[], threads = 0) => ({
  version: 1,
  repo: "o/r",
  nextNumber: 3,
  nextId: 1,
  prs: [
    { number: 1, headRefOid: "old", heads: [head("old")], reviewThreads: [] },
    { number: 2, headRefOid: heads.at(-1)?.sha ?? "", heads, reviewThreads: Array.from({ length: threads }, (_, id) => ({ id })) },
  ],
  mergeAttempts: [],
});

const result = (overrides: Partial<TrialResult> = {}): TrialResult => ({
  outcome: { kind: "finished", exit: 0, sigil: "<ralph>DONE</ralph>" },
  failures: [],
  base: "base",
  finalHead: null,
  patch: "",
  logs: [],
  tracker: null,
  github: { prs: [], mergeAttempts: [] },
  models: [{ stage: "coder", model: "opus", runner: "claude" }],
  review: null,
  ...overrides,
});

const score = (trial: TrialResult, extra: { partialPatch?: string; rates?: { inputPerMTok: number; outputPerMTok: number } | null } = {}) =>
  scoreTrial({ ticket: "OAI-1", arm: "b", lineup: "live", result: trial, wallSeconds: 60, partialPatch: extra.partialPatch ?? "", artifacts: "trials/OAI-1-b", rates: extra.rates ?? null });

// A diff the diff guard flags: one assertion goes, nothing replaces it.
const WEAKENING = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,2 @@
 it("x", () => {
-  expect(value).toBe(1);
 });
`;

const resultEvent = (usage: Record<string, number>, cost?: number) => JSON.stringify({ type: "result", usage, ...(cost === undefined ? {} : { total_cost_usd: cost }) });

describe("scoreTrial", () => {
  it("scores a PR whose final head is all green as green-pr, with rounds and threads from the newest PR", () => {
    const row = score(result({
      finalHead: "c2",
      github: github([head("c1", [{ name: "ci", conclusion: "FAILURE" }]), head("c2", [{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", conclusion: "SKIPPED" }])], 2),
    }));
    expect(row.outcome).toBe("green-pr");
    expect(row.detail).toBe("<ralph>DONE</ralph>");
    expect(row.gates).toEqual([{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", conclusion: "SKIPPED" }]);
    expect(row.reviewRounds).toBe(1);
    expect(row.reviewThreads).toBe(2);
    expect(row.weakening).toEqual([]);
    expect(row.models).toEqual([{ stage: "coder", model: "opus", runner: "claude" }]);
  });

  it("records the base, the newest PR's first push and the final head, the first falling back to the final with no PR", () => {
    const pushed = score(result({ finalHead: "c2", github: github([head("c1"), head("c2")]) }));
    expect(pushed.heads).toEqual({ base: "base", first: "c1", final: "c2" });
    expect(score(result({ finalHead: "c9" })).heads).toEqual({ base: "base", first: "c9", final: "c9" });
    expect(score(result()).heads).toEqual({ base: "base", first: null, final: null });
  });

  it("scores a failing check as failed and names it", () => {
    const row = score(result({ finalHead: "c1", github: github([head("c1", [{ name: "ci", conclusion: "FAILURE" }])]) }));
    expect(row.outcome).toBe("failed");
    expect(row.detail).toContain("ci FAILURE");
    expect(row.reviewRounds).toBe(0);
  });

  it("scores a killed run as timed-out even when its pushed head was green", () => {
    const row = score(result({
      outcome: { kind: "timeout", exit: null, sigil: null },
      finalHead: "c1",
      github: github([head("c1", [{ name: "ci", conclusion: "SUCCESS" }])]),
    }));
    expect(row.outcome).toBe("timed-out");
    expect(row.gates).toEqual([{ name: "ci", conclusion: "SUCCESS" }]);
  });

  it("scores a preflight refusal as refused with the reasons in detail", () => {
    const row = score(result({
      outcome: { kind: "refused", exit: null, sigil: null },
      failures: [{ leak: "gh", why: "gh resolves to the real binary" }, { leak: "origin", why: "origin is a remote URL" }],
    }));
    expect(row.outcome).toBe("refused");
    expect(row.detail).toBe("gh: gh resolves to the real binary; origin: origin is a remote URL");
    expect(row.reviewRounds).toBeNull();
    expect(row.gates).toBeNull();
  });

  it("finds weakening in the patch, and in the partial patch of a run killed before it pushed", () => {
    expect(score(result({ patch: WEAKENING })).weakening).toEqual(["src/a.test.ts: deletes 1 assertion without replacing them."]);
    const killed = score(result({ outcome: { kind: "aborted", exit: null, sigil: null } }), { partialPatch: WEAKENING });
    expect(killed.outcome).toBe("timed-out");
    expect(killed.weakening).toHaveLength(1);
  });

  it("reads a malformed github state as no PR rather than throwing", () => {
    for (const state of [null, "garbage", { prs: "nope" }, { prs: [null, 3] }, { prs: [{ number: 1, heads: [{ sha: 5, checks: "x" }] }] }]) {
      const row = score(result({ finalHead: "c1", github: state }));
      expect(row.outcome).toBe("failed");
      expect(row.gates).toBeNull();
    }
    expect(score(result({ github: { prs: [] } })).reviewRounds).toBeNull();
  });

  it("costs reported, then estimated from tokens and rates, then unknown", () => {
    const events = { path: "logs/iter-1.events.jsonl", text: resultEvent({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 1.5) };
    expect(score(result({ logs: [events] })).cost).toEqual({ usd: 1.5, source: "reported" });

    const metered = { path: "logs/iter-1.events.jsonl", text: resultEvent({ input_tokens: 500_000, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 250_000, output_tokens: 1_000_000 }) };
    expect(score(result({ logs: [metered] }), { rates: { inputPerMTok: 3, outputPerMTok: 15 } }).cost).toEqual({ usd: 18, source: "estimated" });

    expect(score(result({ logs: [metered] })).cost).toEqual({ usd: null, source: "unknown" });
    expect(score(result(), { rates: { inputPerMTok: 3, outputPerMTok: 15 } }).cost).toEqual({ usd: null, source: "unknown" });
  });
});

describe("base-red gates (#579)", () => {
  it("scores a head green on base-red tests alone as green-pr, keeping the forgiven tests and naming them", () => {
    const row = score(result({
      finalHead: "c1",
      github: github([head("c1", [{ name: "trial/test", conclusion: "SUCCESS", baseRed: ["a.test.ts > x"] }, { name: "trial/lint", conclusion: "SUCCESS", baseRed: [1] }])]),
    }));
    expect(row.outcome).toBe("green-pr");
    expect(row.gates).toEqual([{ name: "trial/test", conclusion: "SUCCESS", baseRed: ["a.test.ts > x"] }, { name: "trial/lint", conclusion: "SUCCESS" }]);
    expect(row.detail).toBe("<ralph>DONE</ralph>; base-red forgiven: trial/test (1 test)");
  });

  const failed = score(result({
    finalHead: "c1",
    github: github([head("c1", [{ name: "trial/test", conclusion: "FAILURE" }, { name: "trial/lint", conclusion: "SUCCESS" }])]),
  }));

  it("turns a failed row green when every failing gate is re-judged passing on base-red tests, keeping the sigil", () => {
    expect(failed.detail).toBe("failing checks: trial/test FAILURE; <ralph>DONE</ralph>");
    const rejudged = [{ name: "trial/test", conclusion: "SUCCESS", baseRed: ["a.test.ts > x"] }, { name: "trial/lint", conclusion: "SUCCESS" }];
    const row = forgiveBaseRed(failed, rejudged);
    expect(row.outcome).toBe("green-pr");
    expect(row.gates).toEqual(rejudged);
    expect(row.detail).toBe("green apart from base-red tests: trial/test (1 test); <ralph>DONE</ralph>");
  });

  it("leaves the row failed on a new failure, or on a re-judged pass with no base-red tests (a flake)", () => {
    expect(forgiveBaseRed(failed, [{ name: "trial/test", conclusion: "FAILURE", baseRed: ["a.test.ts > x"] }])).toBe(failed);
    expect(forgiveBaseRed(failed, [{ name: "trial/test", conclusion: "SUCCESS" }])).toBe(failed);
    expect(forgiveBaseRed(failed, [{ name: "trial/test", conclusion: "SUCCESS", baseRed: [] }])).toBe(failed);
    expect(forgiveBaseRed(failed, [{ name: "trial/lint", conclusion: "SUCCESS", baseRed: ["x"] }])).toBe(failed);
    expect(forgiveBaseRed(failed, null)).toBe(failed);
  });

  it("leaves timed-out, refused and no-PR rows untouched", () => {
    const rejudged = [{ name: "trial/test", conclusion: "SUCCESS", baseRed: ["a.test.ts > x"] }];
    const timedOut = score(result({ outcome: { kind: "timeout", exit: null, sigil: null }, finalHead: "c1", github: github([head("c1", [{ name: "trial/test", conclusion: "FAILURE" }])]) }));
    const refused = score(result({ outcome: { kind: "refused", exit: null, sigil: null }, failures: [{ leak: "gh", why: "gh resolves to the real binary" }] }));
    const noPr = score(result());
    expect(noPr.detail).toContain("no PR opened");
    for (const row of [timedOut, refused, noPr]) expect(forgiveBaseRed(row, rejudged)).toBe(row);
  });
});

describe("scoreTrial's claim to hand-off", () => {
  const event = (kind: SpeedEvent["kind"], at: string): SpeedEvent => ({
    v: 1, at, kind, loop: "ralph", project: "p", ticket: "7", session: null, run: "r", iteration: 1,
  });

  it("reads it from the trial's own speed ledger", () => {
    const row = score(result({ speed: [event("claimed", "2026-10-28T00:00:00.000Z"), event("handed-off", "2026-10-28T00:01:30.000Z")] }));
    expect(row.handoffSeconds).toBe(90);
  });

  it("is null with no hand-off, and for a result saved before the ledger existed", () => {
    expect(score(result({ speed: [event("claimed", "2026-10-28T00:00:00.000Z")] })).handoffSeconds).toBeNull();
    expect(score(result()).handoffSeconds).toBeNull();
  });
});

describe("readIterationUsage", () => {
  it("sums result events and a delegate usage file, skipping non-JSON lines", () => {
    const usage = readIterationUsage([
      { path: "logs/iter-1.events.jsonl", text: ["not json", JSON.stringify({ type: "assistant", usage: { input_tokens: 999 } }), resultEvent({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, 0.25)].join("\n") },
      { path: "logs/delegate-1.usage", text: "DELEGATE_MODEL=opus\nDELEGATE_INPUT=1\nDELEGATE_OUTPUT=2\nDELEGATE_CACHE_READ=3\nDELEGATE_CACHE_WRITE=4\n" },
      { path: "logs/iter-1.log", text: resultEvent({ input_tokens: 1000 }, 9) },
    ]);
    expect(usage).toEqual({ tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 }, reportedUsd: 0.25 });
  });

  it("takes a delegate's tokens from its usage file only, but its cost from its events", () => {
    const usage = readIterationUsage([
      { path: "logs/delegate-1.log.jsonl", text: resultEvent({ input_tokens: 1, output_tokens: 2 }, 0.5) },
      { path: "logs/delegate-1.usage", text: "DELEGATE_INPUT=1\nDELEGATE_OUTPUT=2\nDELEGATE_CACHE_READ=0\nDELEGATE_CACHE_WRITE=0\n" },
    ]);
    expect(usage).toEqual({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, reportedUsd: 0.5 });
  });

  it("is null when nothing was metered", () => {
    expect(readIterationUsage([{ path: "logs/iter-1.events.jsonl", text: "nothing here" }])).toEqual({ tokens: null, reportedUsd: null });
  });
});

describe("renderBacktestReport", () => {
  it("renders one row per trial, the arm summaries, skips, notes and the closing caveat", () => {
    const green = score(result({ finalHead: "c1", github: github([head("c1", [{ name: "ci", conclusion: "SUCCESS" }])]), logs: [{ path: "a.jsonl", text: resultEvent({ input_tokens: 5, output_tokens: 7 }, 0.1) }] }));
    const failed = { ...score(result()), arm: "c" as const, lineup: "codex" };
    const report: BacktestReport = {
      id: "bt-1",
      startedAt: "2026-10-28T00:00:00Z",
      finishedAt: "2026-10-28T01:00:00Z",
      arms: { b: "live lineup", c: "codex" },
      rows: [green, failed],
      skipped: [{ oaKey: "OAI-9", reason: "no merged PR" }],
      notes: ["host was loaded"],
      stoppedBy: null,
    };
    const text = renderBacktestReport(report);
    const rows = text.split("\n").filter((line) => line.startsWith("| OAI-1 "));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("| green-pr | 1/1 |");
    expect(rows[0]).toContain("$0.1000 (reported)");
    expect(rows[1]).toContain("| failed | — |");
    expect(text).toContain("- Arm B: 1/1 green PRs; median wall time 60s; total cost $0.1000.");
    expect(text).toContain("- Arm C: 0/1 green PRs; median wall time 60s; total cost ≥ $0.0000 (1 unknown).");
    expect(text).toContain("- OAI-9: no merged PR");
    expect(text).toContain("- host was loaded");
    expect(text).toContain("upper bound");
    expect(text).toContain("shows direction, not significance");
    expect(text).toContain("Nothing was published");
  });

  it("leaves not-run trials out of the green ratio and the cost, and counts them apart", () => {
    const green = score(result({ finalHead: "c1", github: github([head("c1", [{ name: "ci", conclusion: "SUCCESS" }])]), logs: [{ path: "a.jsonl", text: resultEvent({ input_tokens: 5, output_tokens: 7 }, 0.1) }] }));
    const unmetered = score(result({ finalHead: "c1", github: github([head("c1", [{ name: "ci", conclusion: "SUCCESS" }])]) }));
    const notRun = { ...score(result()), outcome: "not-run" as const, detail: "batch cap reached", cost: { usd: null, source: "unknown" as const } };
    const report: BacktestReport = {
      id: "bt-2", startedAt: "2026-10-28T00:00:00Z", finishedAt: "2026-10-28T01:00:00Z", arms: { b: "live lineup", c: null },
      rows: [green, unmetered, notRun, notRun, notRun], skipped: [], notes: [], stoppedBy: "batch-cap",
    };
    expect(renderBacktestReport(report)).toContain("- Arm B: 2/2 green PRs (3 not run); median wall time 60s; total cost ≥ $0.1000 (1 unknown).");
  });

  it("sums each repeated case per arm: green runs, the panel's mean axis scores and spread, the first trial's verdict (#821)", () => {
    const green = score(result({ finalHead: "c1", github: github([head("c1", [{ name: "ci", conclusion: "SUCCESS" }])]) }));
    const failed = { ...score(result()), arm: "c" as const, lineup: "codex" };
    const axes = (n: number | null, review: number | null = null) => ({
      correctness: { score: n, evidence: "e" }, scope: { score: n, evidence: "e" }, tests: { score: n, evidence: "e" },
      maintainability: { score: n, evidence: "e" }, review: { score: review, evidence: "e" },
    });
    // Two judges on the first trial: B 4 and 5 (a trial mean of 4.5), C 2 by one, the other abstains on C.
    const panelScore = (repeat: number | undefined, b: [number, number] | null, c: number | null, ranking: string[][]): TicketScore => ({
      ticket: "OAI-1", scoredAt: "t", baseline: [], arms: [], ...(repeat === undefined ? {} : { repeat }),
      judge: { status: "ok", seed: "s", order: ["a", "b", "c"], ranking, winners: ranking[0]!, tie: ranking[0]!.length > 1, reason: "r" },
      panel: {
        seed: "s", order: ["a", "b", "c"], contested: [], aggregate: { status: "ok", seed: "s", order: [], ranking: [], winners: [], tie: false, reason: "" },
        verdicts: [
          { judge: { name: "opus", runner: "claude", model: "o" }, status: "ok", ranking: [], reason: "r",
            arms: { ...(b ? { b: { axes: axes(b[0], 3), better: "x" } } : {}), ...(c === null ? {} : { c: { axes: axes(c), better: "x" } }) } },
          { judge: { name: "gpt", runner: "codex", model: "g" }, status: "ok", ranking: [], reason: "r", arms: b ? { b: { axes: axes(b[1]), better: "x" } } : {} },
          { judge: { name: "late", runner: "codex", model: "g" }, status: "unavailable", reason: "timed out" },
        ],
      },
    });
    const report: BacktestReport = {
      id: "bt-r", startedAt: "s", finishedAt: "f", arms: { b: "live lineup", c: "codex" }, skipped: [], notes: [], stoppedBy: null,
      rows: [green, failed, { ...green, repeat: 1 }, { ...failed, repeat: 1, outcome: "green-pr" }, { ...green, repeat: 2, outcome: "not-run" }, { ...failed, repeat: 2 }],
      scores: [panelScore(undefined, [4, 5], 2, [["b", "a"], ["c"]])],
      // Repeat 1: B 3 by both, C 4. Repeat 2: B did not run, C left out of the panel (no diff).
      repeatScores: [panelScore(1, [3, 3], 4, [["c"], ["b"], ["a"]]), panelScore(2, null, null, [["a"]])],
    };
    const [b, c] = repeatSummaries(report);
    expect(b).toEqual({
      case: "OAI-1", arm: "b", ran: 2, green: 2, judged: 2,
      axes: { correctness: { mean: 3.75, min: 3, max: 4.5 }, scope: { mean: 3.75, min: 3, max: 4.5 }, tests: { mean: 3.75, min: 3, max: 4.5 }, maintainability: { mean: 3.75, min: 3, max: 4.5 }, review: { mean: 3, min: 3, max: 3 } },
      first: { outcome: "green-pr", rank: { position: 1, of: 3, tied: true } },
    });
    expect(c).toMatchObject({ arm: "c", ran: 3, green: 1, judged: 2, axes: { correctness: { mean: 3, min: 2, max: 4 }, review: null }, first: { outcome: "failed", rank: { position: 3, of: 3, tied: false } } });

    const text = renderBacktestReport(report);
    const section = text.split("## Repeats")[1]!;
    expect(section).toContain("| Case | Arm | Green | Judged | correctness | scope | tests | maintainability | review | First trial |");
    expect(section).toContain("| OAI-1 | B | 2/2 | 2 | 3.8 (3–4.5) | 3.8 (3–4.5) | 3.8 (3–4.5) | 3.8 (3–4.5) | 3 | green-pr, tied 1st of 3 |");
    expect(section).toContain("| OAI-1 | C | 1/3 | 2 | 3 (2–4) | 3 (2–4) | 3 (2–4) | 3 (2–4) | — | failed, 3rd of 3 |");
    expect(section).toContain("The verdict stays the first trial's.");
    // The arm summaries above still count each case's first trial only.
    expect(text).toContain("- Arm C: 0/1 green PRs");
  });

  describe("with scores", () => {
    const row = { ...score(result({ finalHead: "c1", github: github([head("c0"), head("c1", [{ name: "ci", conclusion: "SUCCESS" }])]) })) };
    const scores: TicketScore[] = [{
      ticket: "OAI-1",
      scoredAt: "2026-10-28T02:00:00Z",
      baseline: [{ path: "a.test.ts", result: "fail" }, { path: "b.test.ts", result: "pass" }],
      arms: [
        {
          arm: "a", heads: { first: "h1", final: "h2" }, heldOut: null,
          gates: [{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", conclusion: "FAILURE" }],
          review: {
            first: { status: "ok", head: "h1", counts: { P1: 1, P2: 0, P3: 2 }, dir: "OAI-1/a/review-first", screenshots: ["OAI-1/a/review-first/shot.png"],
              findings: [{ priority: "P1", path: "src/x.ts", line: 12, title: "drops | the\nerror", text: `The catch\n  swallows it. ${"x".repeat(400)}` }, { priority: "P3", path: "src/y.ts", line: null, title: "nit", text: "" }] },
            final: { status: "unavailable", head: "h2", reason: "reviewer down" },
          },
          human: { openToMergeSeconds: 3 * 3600 + 25 * 60, rounds: 2 }, notes: ["rounds: gh reviews for #5: 404"],
        },
        {
          arm: "b", heads: { first: "c0", final: "c1" },
          heldOut: { status: "ok", files: [{ path: "a.test.ts", baseline: "fail", result: "pass" }, { path: "b.test.ts", baseline: "pass", result: "pass" }] },
          gates: row.gates, review: null, human: null, notes: [],
        },
        { arm: "c", heads: { first: null, final: null }, heldOut: { status: "not-applicable", reason: "patch did not apply" }, gates: null, review: null, human: null, notes: [] },
      ],
    }];
    const report: BacktestReport = {
      id: "bt-3", startedAt: "2026-10-28T00:00:00Z", finishedAt: "2026-10-28T01:00:00Z", arms: { b: "live lineup", c: "codex" },
      rows: [row], skipped: [], notes: [], stoppedBy: null,
    };

    it("adds a scoring table, findings, notes and the held-out summary", () => {
      const text = renderBacktestReport({ ...report, scores });
      expect(text).toContain("## Scoring");
      expect(text).toContain("| Ticket | Arm | Held-out | Gates | Review first | Review final | Open-to-merge | Rounds |");
      expect(text).toContain("| OAI-1 | A (human) | source | 1/2 | P1 1 · P2 0 · P3 2 | unreviewed | 3h 25m | 2 |");
      expect(text).toContain("| OAI-1 | B | 2/2 pass, 1 already passing on baseline | 1/1 | — | — | — | 1 |");
      expect(text).toContain("| OAI-1 | C | n/a (did not apply) | — | — | — | — | — |");
      expect(text).toContain("- Arm B held-out: 1/1 evidence files pass");
      expect(text).toContain("- Arm C held-out: 0/0 evidence files pass");
      expect(text).toContain("### Findings");
      expect(text).toContain("- [P1] src/x.ts:12 — drops | the error");
      const continuation = text.split("\n")[text.split("\n").indexOf("- [P1] src/x.ts:12 — drops | the error") + 1]!;
      expect(continuation.startsWith("  The catch swallows it. xxx")).toBe(true);
      expect(continuation.endsWith("x…")).toBe(true);
      expect(continuation.length).toBe(2 + 300 + 1);
      expect(text).toContain("- [P3] src/y.ts — nit");
      expect(text).toContain("OAI-1/a/review-first/shot.png");
      expect(text).toContain("### Scoring notes");
      expect(text).toContain("- OAI-1 A (human): rounds: gh reviews for #5: 404");
    });

    it("counts base-red gates in the Gates cells and lists each ticket's red merge-base gates", () => {
      const forgivenRow = { ...row, gates: [{ name: "ci", conclusion: "SUCCESS", baseRed: ["a.test.ts > x"] }, { name: "lint", conclusion: "SUCCESS" }, { name: "e2e", conclusion: "FAILURE" }] };
      const failures = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
      const withBaseRed: TicketScore[] = [
        {
          ...scores[0]!,
          arms: scores[0]!.arms.map((arm) => (arm.arm === "b" ? { ...arm, gates: forgivenRow.gates } : arm)),
          baseRed: { version: 1, base: "b0", gates: { "trial/test": { conclusion: "FAILURE", failures }, "trial/lint": { conclusion: "FAILURE", failures: [] }, "trial/tsc": { conclusion: "SUCCESS", failures: [] } } },
        },
        { ...scores[0]!, ticket: "OAI-2", baseRed: { version: 1, base: "b1", gates: { "trial/test": { conclusion: "SUCCESS", failures: [] } } } },
        { ...scores[0]!, ticket: "OAI-3", baseRed: null },
      ];
      const lines = renderBacktestReport({ ...report, rows: [forgivenRow], scores: withBaseRed }).split("\n");
      expect(lines).toContain("| OAI-1 | b (live) | green-pr | 2/3 (1 base-red) | 0 | 1 | 60s | — | unknown |");
      expect(lines).toContain("| OAI-1 | B | 2/2 pass, 1 already passing on baseline | 2/3 (1 base-red) | — | — | — | 1 |");
      const at = lines.indexOf("### Base-red gates");
      expect(at).toBeGreaterThan(-1);
      expect(lines.slice(at + 2, at + 6)).toEqual([
        "- OAI-1: trial/test — 7 tests already failing on the merge base: t1; t2; t3; t4; t5; … and 2 more",
        "- OAI-1: trial/lint — failing on the merge base, no test named",
        "",
        "A gate whose only failures are base-red counts as passing for every arm, the human's included.",
      ]);
      expect(lines.join("\n")).not.toContain("OAI-2: trial");
      expect(renderBacktestReport({ ...report, scores })).not.toContain("base-red");
    });

    it("renders a report without scores as before", () => {
      const text = renderBacktestReport(report);
      expect(text).not.toContain("## Scoring");
      expect(text).toBe(renderBacktestReport({ ...report, scores: [] }));
    });

    it("renders each arm's resolved models, its overlay, the panel and the seed under the header (#816)", () => {
      const lines = renderBacktestReport({
        ...report,
        resolved: {
          arms: {
            b: { stages: [{ stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: "high" }, { stage: "executor", runner: "claude", model: "claude-sonnet-5-5", effort: null }], overlayHash: "3f2a|9" },
          },
          panel: [{ name: "opus", runner: "claude", model: "claude-opus-5-5" }, { name: "gpt", runner: "codex", model: "gpt-5.5" }],
          seed: "bt-1",
        },
      }).split("\n");
      const arms = lines.findIndex((line) => line.startsWith("Arms:") || line.startsWith("Arm B:"));
      expect(lines.slice(arms + 1, arms + 4)).toEqual([
        "Arm B: coder claude claude-opus-5-5 (high); executor claude claude-sonnet-5-5. Overlay sha256 3f2a\\|9.",
        "Arm C: models not recorded.",
        "Panel: opus (claude claude-opus-5-5), gpt (codex gpt-5.5). Seed bt-1.",
      ]);
      expect(lines.indexOf("| Ticket | Arm | Outcome | Gates | Weakening | Review rounds | Wall time | Tokens in / out | Cost |")).toBe(arms + 5);
      expect(renderBacktestReport({ ...report, resolved: { arms: {}, panel: [], seed: null } })).toContain("Panel: off.");
    });

    it("reads an arm named like an Object.prototype member by own key (#816)", () => {
      const text = renderBacktestReport({ ...report, arms: [{ name: "constructor", lineup: "live", overlay: null }], resolved: { arms: {}, panel: [], seed: null } });
      expect(text).toContain("Arm constructor: models not recorded.");
    });

    it("renders a report without a resolution as before (#816)", () => {
      const text = renderBacktestReport(report);
      expect(text).not.toContain("Panel:");
      expect(text).not.toContain("models not recorded");
    });
  });

  describe("summary and judge", () => {
    const base = score(result());
    const trial = (ticket: string, arm: "b" | "c", extra: Partial<TrialRow>): TrialRow => ({ ...base, ticket, arm, lineup: arm === "b" ? "live" : "codex", ...extra });
    const rows: TrialRow[] = [
      trial("OAI-1", "b", { outcome: "green-pr", gates: [{ name: "ci", conclusion: "SUCCESS" }], reviewRounds: 1, wallSeconds: 100, handoffSeconds: 90, cost: { usd: 0.1, source: "reported" } }),
      trial("OAI-1", "c", { outcome: "failed", gates: [{ name: "ci", conclusion: "FAILURE" }], reviewRounds: 2, wallSeconds: 200, handoffSeconds: 600, cost: { usd: null, source: "unknown" } }),
      trial("OAI-2", "b", { outcome: "green-pr", gates: [{ name: "ci", conclusion: "SUCCESS" }], reviewRounds: 0, wallSeconds: 300, handoffSeconds: 150, cost: { usd: 0.2, source: "reported" } }),
      trial("OAI-2", "c", { outcome: "failed", gates: null, reviewRounds: null, wallSeconds: 400, cost: { usd: 0.3, source: "estimated" } }),
      trial("OAI-3", "b", { outcome: "failed", gates: [{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", conclusion: "FAILURE" }], reviewRounds: 3, wallSeconds: 500, cost: { usd: 0.05, source: "reported" } }),
      // Never ran: its zero wall time and unknown cost must not reach the summary.
      trial("OAI-3", "c", { outcome: "not-run", detail: "batch cap reached", gates: null, reviewRounds: null, wallSeconds: 0, handoffSeconds: 1, cost: { usd: null, source: "unknown" } }),
    ];
    const ok = (P1: number, P2: number, P3: number): ReviewScore => ({ status: "ok", head: "h", counts: { P1, P2, P3 }, findings: [], dir: "d", screenshots: [] });
    const unavailable: ReviewScore = { status: "unavailable", head: "h", reason: "reviewer down" };
    const entry = (arm: ArmScore["arm"], extra: Partial<ArmScore>): ArmScore => ({
      arm, heads: { first: "h", final: "h" }, heldOut: arm === "a" ? null : { status: "none", reason: "no tests" }, gates: null, review: null, human: null, notes: [], ...extra,
    });
    const scores: TicketScore[] = [
      {
        ticket: "OAI-1", scoredAt: "2026-10-28T02:00:00Z", baseline: [],
        arms: [
          entry("a", { gates: [{ name: "ci", conclusion: "SUCCESS" }], review: { first: ok(0, 0, 0), final: ok(1, 0, 0) }, human: { openToMergeSeconds: 3600, rounds: 2 } }),
          entry("b", { heldOut: { status: "ok", files: [{ path: "x.test.ts", baseline: "fail", result: "pass" }, { path: "y.test.ts", baseline: "pass", result: "pass" }] }, review: { first: ok(0, 0, 0), final: ok(0, 1, 1) } }),
          entry("c", { heldOut: { status: "not-applicable", reason: "patch did not apply" }, review: { first: ok(0, 0, 0), final: ok(3, 0, 0) } }),
        ],
        judge: { status: "ok", seed: "s1", order: ["c", "a", "b"], ranking: [["b"], ["a", "c"]], winners: ["b"], tie: false, reason: "B fixes it\n  fully" },
      },
      {
        ticket: "OAI-2", scoredAt: "2026-10-28T02:00:00Z", baseline: [],
        arms: [
          entry("a", { gates: [{ name: "ci", conclusion: "FAILURE" }], review: { first: ok(0, 0, 0), final: ok(0, 0, 0) }, human: { openToMergeSeconds: 7200, rounds: 4 } }),
          entry("b", { heldOut: { status: "ok", files: [{ path: "x.test.ts", baseline: "fail", result: "fail" }] }, review: { first: ok(0, 0, 0), final: unavailable } }),
          entry("c", { heldOut: { status: "ok", files: [{ path: "x.test.ts", baseline: "fail", result: "pass" }] }, review: { first: ok(0, 0, 0), final: ok(1, 1, 1) } }),
        ],
        judge: { status: "ok", seed: "s1", order: ["a", "b", "c"], ranking: [["a", "c"], ["b"]], winners: ["a", "c"], tie: true, reason: "both | complete" },
      },
      {
        ticket: "OAI-3", scoredAt: "2026-10-28T02:00:00Z", baseline: [],
        arms: [
          entry("a", { review: { first: ok(0, 0, 0), final: ok(2, 0, 0) }, human: { openToMergeSeconds: 10800, rounds: null } }),
          entry("b", { review: { first: ok(0, 0, 0), final: ok(0, 0, 4) } }),
          entry("c", {}),
        ],
        judge: { status: "unavailable", seed: "s1", order: ["b", "a", "c"], reason: "judge timed out" },
      },
    ];
    const report: BacktestReport = {
      id: "bt-4", startedAt: "2026-10-28T00:00:00Z", finishedAt: "2026-10-28T03:00:00Z", arms: { b: "live lineup", c: "codex" },
      rows, skipped: [{ oaKey: "OAI-9", reason: "no merged PR" }], notes: [], stoppedBy: "batch-cap", scores,
    };

    it("compares the arms in one table, counting ties, unreviewed finals and skipping not-run trials", () => {
      const lines = renderBacktestReport(report).split("\n");
      const at = lines.indexOf("## Summary");
      expect(at).toBeGreaterThan(lines.findIndex((line) => line.startsWith("Tokens in counts")));
      expect(at).toBeLessThan(lines.indexOf("## Scoring"));
      expect(lines.slice(at + 2, at + 10)).toEqual([
        "| Arm | Gates | Held-out | Median findings | Judge wins | Median rounds | Median wall time | Median claim to hand-off | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| A (human) | 1/2 | — | 1 | 0 wins, 1 tie / 2 | 3 | 2h 0m | 2h 0m | — |",
        "| B | 2/3 | 1/2 | 3 (1 unreviewed) | 1 win, 0 ties / 2 | 1 | 300s | 120s | $0.3500 |",
        "| C | 0/1 | 1/1 | 3 | 0 wins, 1 tie / 2 | 2 | 300s | 600s | ≥ $0.3000 (1 unknown) |",
        "",
        "The human's wall time and claim to hand-off are its PR's open-to-merge time, a different clock from a trial's run time; "
          + "an agent arm's claim to hand-off is the trial's claim to its hand-off, the same clock the live loops' speed ledger uses.",
        "Judge: 2 of 3 tickets judged; 1 unavailable.",
      ]);
    });

    it("lists each ticket's verdict, keeping the skipped section and the closing caveat", () => {
      const text = renderBacktestReport(report);
      const lines = text.split("\n");
      const at = lines.indexOf("## Judge");
      expect(at).toBeGreaterThan(lines.indexOf("## Scoring"));
      expect(lines.slice(at + 2, at + 5)).toEqual([
        "- OAI-1: B > A (human) = C — B fixes it fully (shown as 1: C, 2: A, 3: B; seed s1)",
        "- OAI-2: A (human) = C > B — both | complete (shown as 1: A, 2: B, 3: C; seed s1)",
        "- OAI-3: not judged — judge timed out",
      ]);
      expect(lines.indexOf("## Skipped")).toBeGreaterThan(at);
      expect(text).toContain("## Skipped\n\n- OAI-9: no merged PR");
      expect(text).toContain("A sample this small shows direction, not significance.");
    });

    it("counts a ticket where the arm had no diff apart from its judged tickets", () => {
      const without = scores.map((entry) => (entry.ticket === "OAI-2"
        ? { ...entry, judge: { status: "ok" as const, seed: "s1", order: ["a", "b"] as ("a" | "b")[], ranking: [["a"], ["b"]] as ("a" | "b")[][], winners: ["a"] as "a"[], tie: false, reason: "a" } }
        : entry));
      const lines = renderBacktestReport({ ...report, scores: without }).split("\n");
      expect(lines.find((line) => line.startsWith("| C |"))).toContain("| 0 wins, 0 ties / 1 (1 without a diff) |");
    });

    it("renders the agent arms from rows alone when the report has no scores", () => {
      const lines = renderBacktestReport({ ...report, scores: undefined }).split("\n");
      const at = lines.indexOf("## Summary");
      expect(lines.slice(at + 4, at + 7)).toEqual([
        "| B | 2/3 | — | — | — | 1 | 300s | 120s | $0.3500 |",
        "| C | 0/1 | — | — | — | 2 | 300s | 600s | ≥ $0.3000 (1 unknown) |",
        "",
      ]);
      expect(lines).not.toContain("## Judge");
      expect(lines.some((line) => line.startsWith("Judge:") || line.startsWith("The human's wall time"))).toBe(false);
    });

    it("lists every judge's axis scores, what each arm did better, abstentions and contested axes (#801)", () => {
      const axes = (score: number, review: number | null = score) => ({
        correctness: { score, evidence: "e" }, scope: { score, evidence: "e" }, tests: { score, evidence: "e" },
        maintainability: { score, evidence: "e" }, review: { score: review, evidence: "e" },
      });
      const panel: TicketScore["panel"] = {
        seed: "s1", order: ["a", "b"],
        verdicts: [
          { judge: { name: "opus", runner: "claude", model: "o" }, status: "ok", ranking: [["b"], ["a"]], reason: "r",
            arms: { a: { axes: axes(3, null), better: "smaller | diff" }, b: { axes: axes(5), better: "adds a test" } } },
          { judge: { name: "gpt", runner: "codex", model: "g" }, status: "ok", ranking: [["a"], ["b"]], reason: "r",
            arms: { a: { axes: { ...axes(4, null), scope: { score: 5, evidence: "e" } }, better: "stays on scope" }, b: { axes: { ...axes(4), scope: { score: 2, evidence: "e" } }, better: "tests" } } },
          { judge: { name: "sonnet", runner: "claude", model: "s" }, status: "unavailable", reason: "timed out" },
        ],
        contested: [{ axis: "scope", arms: ["a", "b"], judges: ["opus", "gpt"] }],
        aggregate: { status: "ok", seed: "s1", order: ["a", "b"], ranking: [["a", "b"]], winners: ["a", "b"], tie: true, reason: "r" },
      };
      const text = renderBacktestReport({ ...report, scores: [{ ...scores[0]!, panel }] });
      expect(text).toContain([
        "### OAI-1",
        "",
        "| Arm | Judge | correctness | scope | tests | maintainability | review | Did better |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| A (human) | opus | 3 | 3 ⚑ | 3 | 3 | — | smaller \\| diff |",
        "| A (human) | gpt | 4 | 5 ⚑ | 4 | 4 | — | stays on scope |",
        "| B | opus | 5 | 5 ⚑ | 5 | 5 | 5 | adds a test |",
        "| B | gpt | 4 | 2 ⚑ | 4 | 4 | 4 | tests |",
        "",
        "- sonnet abstained: timed out",
        "",
        "Contested (⚑) by ranking inversion between judge families, so read the diffs:",
        "",
        "- scope: A (human) vs B (opus, gpt)",
      ].join("\n"));
    });

    it("names the spread rule and lists one arm per contested axis under it (#818)", () => {
      const axes = (score: number) => ({
        correctness: { score, evidence: "e" }, scope: { score, evidence: "e" }, tests: { score, evidence: "e" },
        maintainability: { score, evidence: "e" }, review: { score, evidence: "e" },
      });
      const panel: TicketScore["panel"] = {
        seed: "s1", order: ["a", "b"],
        verdicts: [
          { judge: { name: "opus", runner: "claude", model: "o" }, status: "ok", ranking: [["b"], ["a"]], reason: "r",
            arms: { a: { axes: axes(4), better: "x" }, b: { axes: { ...axes(5), tests: { score: 5, evidence: "e" } }, better: "y" } } },
          { judge: { name: "gpt", runner: "codex", model: "g" }, status: "ok", ranking: [["b"], ["a"]], reason: "r",
            arms: { a: { axes: axes(4), better: "x" }, b: { axes: { ...axes(5), tests: { score: 2, evidence: "e" } }, better: "y" } } },
        ],
        contested: [{ axis: "tests", arms: ["b"], judges: ["opus", "gpt"] }],
        rule: { kind: "spread", points: 2 },
        aggregate: { status: "ok", seed: "s1", order: ["a", "b"], ranking: [["b"], ["a"]], winners: ["b"], tie: false, reason: "r" },
      };
      const text = renderBacktestReport({ ...report, scores: [{ ...scores[0]!, panel }] });
      expect(text).toContain("| B | gpt | 5 | 5 | 2 ⚑ | 5 | 5 | y |");
      expect(text).toContain("| A (human) | gpt | 4 | 4 | 4 | 4 | 4 | x |");
      expect(text).toContain([
        "Contested (⚑) by a spread of 2+ points between judge families' mean scores, so read the diffs:",
        "",
        "- tests: B (opus, gpt)",
      ].join("\n"));
      // A spread run that flagged nothing still names its rule.
      expect(renderBacktestReport({ ...report, scores: [{ ...scores[0]!, panel: { ...panel, contested: [] } }] })).toContain("Nothing contested by a spread of 2+ points between judge families' mean scores.");
    });

    it("renders a row saved before the claim to hand-off existed as —", () => {
      const older = rows.map(({ handoffSeconds: _dropped, ...row }) => row);
      const lines = renderBacktestReport({ ...report, rows: older, scores: undefined }).split("\n");
      expect(lines.find((line) => line.startsWith("| B |"))).toBe("| B | 2/3 | — | — | — | 1 | 300s | — | $0.3500 |");
    });
  });
});

describe("objective and judge scores (#855)", () => {
  it("shows a test-set run's two scores side by side, per arm and per case, after the summary", () => {
    const text = renderBacktestReport(mixedSetReport());
    expect(text).toContain("## Objective and judge scores");
    expect(text.indexOf("## Objective and judge scores")).toBeGreaterThan(text.indexOf("## Summary"));
    expect(text).toContain("never combined");
    const lines = text.split("\n");
    expect(lines).toContain("| Arm | Objective | Judge |");
    expect(lines).toContain("| B | 1/1 cases, 1 check pending | 4.11 over 4 cases |");
    expect(lines).toContain("| C | 0/1 cases, 1 check pending | 2.00 over 4 cases |");
    expect(lines).toContain("| Case | Grader | B | C |");
    expect(lines).toContain("| case-tests | tests | pass · judge 4.44 | fail · judge 2.00 |");
    expect(lines).toContain("| case-no-evidence | judge-only (no evidence) | — · judge 3.00 | — · judge 2.50 |");
    expect(lines).toContain("| case-judge-only | judge-only | — · judge 4.00 | — · judge 1.00 |");
    expect(lines).toContain("| case-check | check | pending · judge 5.00 | pending · judge 2.50 |");
  });

  it("adds no such section to a run that is not a test-set run", () => {
    const { set: _set, ...report } = mixedSetReport();
    const text = renderBacktestReport(report);
    expect(text).toContain("## Summary");
    expect(text).not.toContain("## Objective and judge scores");
  });
});

describe("the noise floor in report.md (#859)", () => {
  const MEASURED = "2026-11-19T04:00:00Z";
  const floor = (spread: NoiseFloor["spread"], cases: readonly string[] = MIXED_SET_CASES): NoiseFloor => ({
    v: 1, version: "0123456789abcdef", measuredAt: MEASURED, runId: "floor-run", arms: ["live-1", "live-2", "live-3"], cases: [...cases], spread, perCase: [],
  });
  const reads = (floors: NoiseFloor[]): NoiseReads => ({
    floors: () => floors,
    staleShare: () => 0.2,
  });
  const stamped = (r: NoiseReads) => renderBacktestReport(stampNoise(mixedSetReport(), { project: "/nowhere" }, r).report);
  const after = (text: string, heading: string) => {
    expect(text.indexOf(heading)).toBeGreaterThan(text.indexOf("## Objective and judge scores"));
    expect(text.indexOf(heading)).toBeGreaterThan(text.indexOf("| case-check | check |"));
  };

  it("a floor run says it measured the floor, with each spread on its own", () => {
    const { report } = stampNoise(noiseFloorReport(), { project: "/nowhere", noiseFloor: { measuredAt: MEASURED } }, reads([]));
    const text = renderBacktestReport(report);
    after(text, "## Noise floor");
    const lines = text.split("\n");
    expect(lines).toContain("This run measured the noise floor of set floor-v over 3 identical arms: what they differ by is noise.");
    expect(lines).toContain("- Objective spread: 0.50 (pass-rate points)");
    expect(lines).toContain("- Judge spread: 0.66");
    expect(text).not.toContain("## Against the noise floor");
  });

  it("a later run against a fresh floor: within and beyond per axis, never combined", () => {
    const text = stamped(reads([floor({ objective: 1, judge: 0.5 })]));
    after(text, "## Against the noise floor");
    const lines = text.split("\n");
    expect(lines).toContain("Floor measured 2026-11-19T04:00:00Z on 0123456: objective ±1.00, judge ±0.50.");
    expect(lines).toContain("| Arm | vs | Objective gap | Judge gap |");
    expect(lines).toContain("| C | B | -1.00 within | -2.11 beyond |");
  });

  it("a later run against a stale floor labels every gap stale", () => {
    const old = [...MIXED_SET_CASES.slice(0, 2), "gone-1", "gone-2"];
    const text = stamped(reads([floor({ objective: 0, judge: 0 }, old)]));
    const lines = text.split("\n");
    expect(lines).toContain("Floor from 2026-11-19T04:00:00Z on 0123456 is stale for this run — this run ran 2 case(s) it never measured and left out 2 it did (100% of its cases, over 20%).");
    expect(lines).toContain("| C | B | -1.00 (floor stale) | -2.11 (floor stale) |");
    expect(text).not.toContain("beyond");
  });

  it("a later run with no floor says gaps are not judged", () => {
    const lines = stamped(reads([])).split("\n");
    expect(lines).toContain("No noise floor measured — gaps are not judged.");
    expect(lines).toContain("| C | B | -1.00 (no floor) | -2.11 (no floor) |");
  });

  it("a report with neither adds nothing", () => {
    const text = renderBacktestReport(mixedSetReport());
    expect(text).not.toContain("## Noise floor");
    expect(text).not.toContain("## Against the noise floor");
  });
});

describe("the guardrail verdict in report.md (#871)", () => {
  const reads: NoiseReads = { floors: () => [], staleShare: () => 0.2 };

  it("shows each goal's verdict with every condition and its reason, after the noise floor", () => {
    const report = stampGuardrails(stampNoise(mixedSetReport(), { project: "/nowhere" }, reads).report, guardrailSettings({}));
    expect(report.guardrails?.baseline).toBe("b");
    const text = renderBacktestReport(report);
    expect(text.indexOf("## Guardrails")).toBeGreaterThan(text.indexOf("## Against the noise floor"));
    const lines = text.split("\n");
    expect(lines).toContain("### Quality goal: fail");
    expect(lines).toContain("### Cost goal: fail");
    expect(lines).toContain("- fail — objective-up: no noise floor measured — remeasure the noise floor");
    expect(lines).toContain("- fail — judge-within-floor: no noise floor measured — remeasure the noise floor");
  });

  it("a report without a verdict adds nothing", () => {
    expect(renderBacktestReport(mixedSetReport())).not.toContain("## Guardrails");
  });
});

describe("judge accuracy in report.md (#877)", () => {
  const verdict = (axis: "correctness" | "scope", preferred: string) =>
    ({ arms: ["b", "c"] as [string, string], axis, preferred, reason: "r", by: "op", at: "2026-11-19T00:00:00Z" });

  it("shows the overall label, each axis with a total, and the contested verdicts excluded, after the guardrails", () => {
    const base = stampGuardrails(mixedSetReport(), guardrailSettings({}));
    const report = stampJudgeAccuracy(base, [{ id: "case-tests", calibration: [verdict("correctness", "b"), verdict("scope", "c")] }]);
    expect(report.judgeAccuracy?.overall.total).toBe(2);
    const withContested = { ...report, judgeAccuracy: { ...report.judgeAccuracy!, contested: 1 } };
    const text = renderBacktestReport(withContested);
    expect(text.indexOf("## Judge accuracy")).toBeGreaterThan(text.indexOf("## Guardrails"));
    const lines = text.split("\n");
    expect(lines).toContain("Overall: 50% (1 of 2 verdicts).");
    expect(lines).toContain("- correctness: 100% (1 of 1 verdict)");
    expect(lines).toContain("- scope: 0% (0 of 1 verdict)");
    expect(lines.some((line) => line.startsWith("- tests:"))).toBe(false);
    expect(lines).toContain("1 verdict on an axis the panel contested is excluded.");
  });

  it("says once that there is no calibration yet when no verdict counted, and lists no axis", () => {
    const report = stampJudgeAccuracy(mixedSetReport(), []);
    const lines = renderBacktestReport(report).split("\n");
    expect(lines).toContain("## Judge accuracy");
    expect(lines).toContain("Overall: no calibration yet.");
    expect(lines.filter((line) => line.includes("no calibration yet"))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("- correctness:"))).toBe(false);
    expect(lines.some((line) => line.includes("excluded"))).toBe(false);
  });

  it("says no verdict counted, not no calibration yet, when every verdict was on a contested axis", () => {
    const report = stampJudgeAccuracy(mixedSetReport(), []);
    const lines = renderBacktestReport({ ...report, judgeAccuracy: { ...report.judgeAccuracy!, contested: 2 } }).split("\n");
    expect(lines).toContain("Overall: no verdict counted.");
    expect(lines).toContain("2 verdicts on an axis the panel contested are excluded.");
    expect(lines.some((line) => line.includes("no calibration yet"))).toBe(false);
  });

  it("a report without an accuracy adds nothing", () => {
    expect(renderBacktestReport(mixedSetReport())).not.toContain("## Judge accuracy");
  });
});
