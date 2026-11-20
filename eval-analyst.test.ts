import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestReport, TrialRow } from "./backtest-report";
import { analyse, analystPrompt, parseAnalysis, renderAnalysis } from "./eval-analyst";
import { scratchDir } from "./test-scratch";

const row = (ticket: string, arm: string, extra: Partial<TrialRow> = {}): TrialRow => ({
  ticket, arm, lineup: "live", outcome: "green-pr", detail: "COMPLETE", gates: [{ name: "ci", conclusion: "SUCCESS" }], weakening: [],
  reviewRounds: 1, reviewThreads: 1, wallSeconds: 600, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  cost: { usd: 1.5, source: "reported" }, artifacts: `${ticket}/${arm}`, models: [], ...extra,
});

function report(overlay: string | null): BacktestReport {
  return {
    id: "run-1", startedAt: "s", finishedAt: "f", stoppedBy: null, skipped: [], notes: [],
    arms: [{ name: "opus", lineup: "live", overlay: null }, { name: "short", lineup: "sonnet", overlay }],
    rows: [row("OA-1", "opus"), row("OA-1", "short", { outcome: "failed", detail: "failing checks" }), row("OA-2", "opus", { outcome: "not-run" })],
    scores: [{
      ticket: "OA-1", scoredAt: "t", baseline: [], arms: [],
      panel: {
        seed: "s", order: ["a", "opus", "short"], contested: [{ axis: "scope", arms: ["opus", "short"], judges: ["opus-judge", "gpt"] }],
        verdicts: [{ judge: { name: "gpt", runner: "codex", model: "g" }, status: "unavailable", reason: "timed out" }],
        aggregate: { status: "unavailable", seed: "s", order: [], reason: "x" },
      },
    }],
  };
}

describe("analystPrompt", () => {
  it("tells the analyst which arm ran what, including the overlay's prompt text, and every case that ran", () => {
    const overlay = scratchDir("analyst-overlay-");
    mkdirSync(join(overlay, "prompts"));
    writeFileSync(join(overlay, "coder.md"), "Keep diffs under 200 lines.\n");
    const prompt = analystPrompt(report(overlay));
    expect(prompt).toContain("## Arm short");
    expect(prompt).toContain("Runs: lineup sonnet, prompt overlay");
    expect(prompt).toContain("### Overlay replaces coder.md");
    expect(prompt).toContain("Keep diffs under 200 lines.");
    expect(prompt).toContain("- arm short: failed — failing checks");
    expect(prompt).toContain("- judge gpt abstained: timed out");
    expect(prompt).toContain("- contested: scope between opus and short");
    // A case none of whose trials ran says nothing about any arm.
    expect(prompt).not.toContain("## Case OA-2");
  });
});

describe("parseAnalysis", () => {
  it("keeps improvements with a knob, a change and a case of this run, and says why it dropped the rest", () => {
    const analysis = parseAnalysis(JSON.stringify({
      summary: "Sonnet with the short prompt failed where Opus passed.",
      improvements: [
        { knob: "prompt", target: "coder.md", change: "Ask for a test before the fix.", arm: "short", evidence: ["OA-1"] },
        { knob: "vibes", change: "be better", evidence: ["OA-1"] },
        { knob: "model", change: "Use Opus for the executor.", evidence: ["OA-99"] },
        { knob: "gate", change: "" , evidence: ["OA-1"] },
      ],
    }), "claude-opus-5-5", ["OA-1", "OA-2"]);
    expect(analysis).toEqual({
      status: "ok", model: "claude-opus-5-5", summary: "Sonnet with the short prompt failed where Opus passed.",
      improvements: [{ knob: "prompt", target: "coder.md", change: "Ask for a test before the fix.", arm: "short", evidence: ["OA-1"] }],
      dropped: ["improvement 2: knob vibes is not one of prompt, lineup, model, gate, review", "improvement 3: cites no case of this run", "improvement 4: no change"],
    });
  });

  it("is unavailable on an answer with no JSON or no improvements list", () => {
    expect(parseAnalysis("Looks fine to me.", "m", [])).toEqual({ status: "unavailable", model: "m", reason: "the analyst answered with no JSON object" });
    expect(parseAnalysis("{\"summary\": \"x\"}", "m", [])).toMatchObject({ status: "unavailable", reason: "the answer has no summary or no improvements list" });
  });
});

describe("analyse", () => {
  it("returns a failed call as unavailable, never a throw", async () => {
    expect(await analyse(report(null), "m", async () => { throw new Error("boom"); })).toEqual({ status: "unavailable", model: "m", reason: "the call threw: boom" });
  });
});

describe("renderAnalysis", () => {
  it("renders the summary, each improvement with its knob and evidence, and what was dropped", () => {
    expect(renderAnalysis({
      status: "ok", model: "m", summary: "Short\nprompt lost.",
      improvements: [{ knob: "prompt", target: "coder.md", change: "Ask for a test.", arm: "short", evidence: ["OA-1"] }], dropped: ["improvement 2: no change"],
    })).toEqual([
      "", "## Analyst", "", "Short prompt lost.", "",
      "- **prompt · coder.md** (arm short; OA-1): Ask for a test.",
      "", "Dropped from the answer: improvement 2: no change.",
      "", "The analyst (m) knew which arm ran what; the judges did not.",
    ]);
  });
});
