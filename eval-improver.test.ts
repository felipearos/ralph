import { describe, expect, it } from "vitest";

import type { TrialRow } from "./backtest-report";
import type { Improvement } from "./eval-analyst";
import type { RunGrades } from "./eval-grade";
import {
  DEFAULT_SUBSET, failedCases, improverInput, improverPrompt, INPUT_TEXT_CAP, INPUT_TOTAL_CAP, liveLineup, parseProposal, subsetCases, type ImproverRun,
} from "./eval-improver";
import type { EvalCase, OperatorCheck } from "./evals-set";

const CHECK: OperatorCheck = { command: "bun test CHECK_SENTINEL", base: "fail", reference: "pass", acceptedAt: "2026-11-19T00:00:00Z", acceptedBy: "felipe" };

function evalCase(id: string, tags: string[], status: EvalCase["status"] = "active"): EvalCase {
  return {
    v: 1, id, kind: "coder", repo: "acme/app",
    prs: [{ number: 1, url: "https://example.test/PRS_SENTINEL", createdAt: "", mergedAt: "", headRefName: "h", firstCommit: "f", headRefOid: "o" }],
    baseCommit: "BASE_SENTINEL", startedAt: "2026-11-01T00:00:00Z",
    ticket: { ref: `REF-${id}`, title: `Title of ${id}`, body: `Body of ${id}`, comments: [{ author: "x", createdAt: "", body: "COMMENT_SENTINEL" }], dropped: 0 },
    reference: "person", heldOut: ["tests/HELD_OUT_SENTINEL.test.ts"], tags, reason: "REASON_SENTINEL", notes: "NOTE_SENTINEL",
    check: { ...CHECK }, status, addedAt: "2026-11-01T00:00:00Z", addedBy: "ADDED_BY_SENTINEL",
  };
}

function row(ticket: string, arm: string, outcome: TrialRow["outcome"], extra: Partial<TrialRow> = {}): TrialRow {
  return {
    ticket, arm, lineup: "live", outcome, detail: "d", gates: [{ name: "ci", conclusion: "SUCCESS" }], weakening: [], reviewRounds: 1,
    reviewThreads: 0, wallSeconds: 10, tokens: null, cost: { usd: 9.99, source: "reported" }, artifacts: "/host/ARTIFACTS_SENTINEL", models: [], ...extra,
  };
}

const IMPROVEMENTS: Improvement[] = [
  { knob: "prompt", target: "coder.md", change: "Run the tests before pushing", arm: "b", evidence: ["c1"] },
  { knob: "model", target: "executor", change: "Use a cheaper executor", arm: "c", evidence: ["c2"] },
];

function run(): ImproverRun {
  return {
    id: "run-1",
    analysis: { status: "ok", model: "m", summary: "s", improvements: IMPROVEMENTS, dropped: [] },
    arms: [{ name: "b", lineup: "opus", overlay: "/home/someone/overlays/tight-coder" }, { name: "c", lineup: "cheap", overlay: null }],
    rows: [row("c1", "b", "failed"), row("c1", "c", "green-pr"), row("c2", "b", "green-pr"), row("c1", "b", "green-pr", { repeat: 2, detail: "REPEAT_SENTINEL" })],
    patches: [
      { ticket: "c1", arm: "b", diff: "diff --git a/x PATCH_B" },
      { ticket: "c1", arm: "a", diff: "REFERENCE_DIFF_SENTINEL" },
      { ticket: "c2", arm: "c", diff: "x".repeat(INPUT_TEXT_CAP + 50) },
    ],
    logs: [{ ticket: "c1", arm: "b", text: "LOG_B" }, { ticket: "c1", arm: "a", text: "REFERENCE_LOG_SENTINEL" }],
  };
}

const CASES = [evalCase("c1", ["auth"]), evalCase("c2", ["ui"]), evalCase("unrun", ["auth"])];
const INSTRUCTIONS = { judge: "You are a judge. JUDGE_NOW", analyst: "You are the analyst. ANALYST_NOW" };
const LINEUP = { executor: { runner: "claude", model: "claude-sonnet-5-5" }, "review.spec": { runner: "opencode", model: "flash" } };

describe("improverInput", () => {
  it("leaves out every graded-only field, the reference diff and the run's costs", () => {
    const input = improverInput(run(), CASES, LINEUP, INSTRUCTIONS);
    const texts = [JSON.stringify(input), improverPrompt(input, "quality"), improverPrompt(input, "cost")];
    const forbidden = [
      "HELD_OUT_SENTINEL", "NOTE_SENTINEL", "CHECK_SENTINEL", "REASON_SENTINEL", "COMMENT_SENTINEL", "PRS_SENTINEL", "BASE_SENTINEL",
      "ADDED_BY_SENTINEL", "REFERENCE_DIFF_SENTINEL", "REFERENCE_LOG_SENTINEL", "ARTIFACTS_SENTINEL", "REPEAT_SENTINEL", "/home/someone", "9.99",
    ];
    for (const text of texts) for (const sentinel of forbidden) expect(text, sentinel).not.toContain(sentinel);
  });

  it("takes no report scores: a scores field on the run never reaches the input", () => {
    const withScores = { ...run(), scores: [{ ticket: "c1", heldOut: "SCORES_SENTINEL" }] } as ImproverRun;
    expect(JSON.stringify(improverInput(withScores, CASES, LINEUP, INSTRUCTIONS))).not.toContain("SCORES_SENTINEL");
  });

  it("carries the allowed material", () => {
    const input = improverInput(run(), CASES, LINEUP, INSTRUCTIONS);
    const json = JSON.stringify(input);
    expect(json).toContain("Run the tests before pushing");
    expect(json).toContain("PATCH_B");
    expect(json).toContain("LOG_B");
    expect(json).toContain("Title of c1");
    expect(input.arms).toEqual([{ name: "b", lineup: "opus", overlay: "tight-coder" }, { name: "c", lineup: "cheap", overlay: null }]);
    expect(input.cases.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(input.cases[0]).toEqual({ id: "c1", tags: ["auth"], status: "active", ticket: { ref: "REF-c1", title: "Title of c1", body: "Body of c1" } });
    expect(input.trials).toHaveLength(3);
    expect(input.trials[0]).toEqual({ ticket: "c1", arm: "b", outcome: "failed", gates: [{ name: "ci", conclusion: "SUCCESS" }], reviewRounds: 1, reviewThreads: 0 });
    const long = input.patches.find((patch) => patch.ticket === "c2")!.diff;
    expect(long.endsWith("\n… (truncated)")).toBe(true);
    expect(long.length).toBe(INPUT_TEXT_CAP + "\n… (truncated)".length);
  });

  it("leaves the reference arm's trials out", () => {
    const input = improverInput({ ...run(), rows: [...run().rows, row("c1", "a", "green-pr")] }, CASES, LINEUP, INSTRUCTIONS);
    expect(input.trials.map((trial) => trial.arm)).not.toContain("a");
    expect(input.trials).toHaveLength(3);
  });

  it("keeps a log's tail and caps the total, counting what it dropped", () => {
    const big = (index: number): string => `START_${index}${"y".repeat(INPUT_TEXT_CAP * 2)}END_${index}`;
    const logs = Array.from({ length: 40 }, (_, index) => ({ ticket: "c1", arm: "b", text: big(index) }));
    const input = improverInput({ ...run(), logs }, CASES, LINEUP, INSTRUCTIONS);
    expect(input.logs[0]!.text).toContain("END_0");
    expect(input.logs[0]!.text).not.toContain("START_0");
    expect(input.logs.length).toBeLessThan(40);
    expect(input.omitted).toEqual({ patches: 0, logs: 40 - input.logs.length, threads: 0 });
    expect(JSON.stringify(input).length).toBeLessThan(INPUT_TOTAL_CAP + 20_000);
  });

  it("carries review threads by title, priority and answer only", () => {
    const thread = { id: 1, round: 1, head: "HEAD_SENTINEL", priority: "P1" as const, path: "src/PATH_SENTINEL.ts", line: 3, title: "Missing null check", answer: "fix" as const, reply: "REPLY_SENTINEL" };
    const review = {
      pr: 1, rounds: [], roundCount: 1, heads: [], unreviewedHeads: [], cappedHeads: [], cap: 5, capReached: false, note: "",
      threads: [thread], answered: { fix: 1, rebuttal: 0, unanswered: 0 },
    };
    const input = improverInput({ ...run(), reviews: [{ ticket: "c1", arm: "b", review }, { ticket: "c1", arm: "a", review: { ...review, threads: [{ ...thread, title: "REFERENCE_THREAD" }] } }] }, CASES, LINEUP, INSTRUCTIONS);
    expect(input.threads).toEqual([{ ticket: "c1", arm: "b", threads: [{ title: "Missing null check", priority: "P1", answer: "fix" }] }]);
    const prompt = improverPrompt(input, "quality");
    expect(prompt).toContain("Missing null check");
    for (const sentinel of ["HEAD_SENTINEL", "PATH_SENTINEL", "REPLY_SENTINEL", "REFERENCE_THREAD"]) expect(prompt).not.toContain(sentinel);
  });

  it("carries the targeted prompt files whole and offers only the live lineup's stages", () => {
    const text = `${"z".repeat(INPUT_TEXT_CAP * 2)} {{PROJECT_GATES}}`;
    const input = improverInput({ ...run(), prompts: { "coder.md": text, "inspector.md": "not targeted" } }, CASES, LINEUP, INSTRUCTIONS);
    expect(input.prompts).toEqual({ "coder.md": text });
    const prompt = improverPrompt(input, "quality");
    expect(prompt).toContain("Stages: executor, review.spec.");
    expect(prompt).toContain("{{…}}");
  });

  it("liveLineup flattens the default block's review group", () => {
    const lineup = liveLineup({ default: { orchestrator: { runner: "claude", model: "o", effort: "high" }, review: { spec: { runner: "opencode", model: "f", fallback: ["x"] } } } });
    expect(lineup).toEqual({ orchestrator: { runner: "claude", model: "o", effort: "high" }, "review.spec": { runner: "opencode", model: "f" } });
  });

  it("refuses a run with no analysis", () => {
    expect(() => improverInput({ ...run(), analysis: { status: "unavailable", model: "m", reason: "timed out" } }, CASES, LINEUP, INSTRUCTIONS)).toThrow(/no analysis/);
  });

  it("the prompt names the goal and the answer shape", () => {
    const input = improverInput(run(), CASES, LINEUP, INSTRUCTIONS);
    expect(improverPrompt(input, "cost")).toContain("cheaper model");
    expect(improverPrompt(input, "quality")).toContain("Raise quality");
    expect(improverPrompt(input, "quality")).toContain("\"answers\"");
  });
});

describe("parseProposal", () => {
  const overlay = { kind: "prompt-overlay", content: { files: { "coder.md": "new coder", "prompts/triager.md": "t" } }, rationale: "tests first", answers: [0] };
  const lineup = { kind: "lineup", content: { stages: { executor: { model: "claude-haiku-5-5", runner: "claude" } } }, rationale: "cheaper", answers: [1, 1] };

  it("accepts an overlay", () => {
    const parsed = parseProposal(JSON.stringify(overlay), "quality", IMPROVEMENTS);
    expect(parsed).toEqual({ ok: true, proposal: { goal: "quality", kind: "prompt-overlay", content: overlay.content, rationale: "tests first", answers: [IMPROVEMENTS[0]] } });
  });

  it("accepts a lineup, deduplicating answers", () => {
    const parsed = parseProposal(JSON.stringify(lineup), "cost", IMPROVEMENTS);
    expect(parsed).toEqual({ ok: true, proposal: { goal: "cost", kind: "lineup", content: lineup.content, rationale: "cheaper", answers: [IMPROVEMENTS[1]] } });
  });

  it("reads a fenced block inside prose", () => {
    const parsed = parseProposal(`Here it is:\n\`\`\`json\n${JSON.stringify(overlay)}\n\`\`\`\nThanks.`, "quality", IMPROVEMENTS);
    expect(parsed.ok).toBe(true);
  });

  const refusals: [string, string, RegExp][] = [
    ["not JSON", "no idea", /no JSON object/],
    ["kind unknown", JSON.stringify({ ...overlay, kind: "gate" }), /kind gate is not/],
    ["rationale empty", JSON.stringify({ ...overlay, rationale: " " }), /no rationale/],
    ["answers empty", JSON.stringify({ ...overlay, answers: [] }), /answers no analyst improvement/],
    ["answers missing", JSON.stringify({ ...overlay, answers: undefined }), /answers no analyst improvement/],
    ["answer out of range", JSON.stringify({ ...overlay, answers: [2] }), /answer 2 is not an analyst improvement/],
    ["answer negative", JSON.stringify({ ...overlay, answers: [-1] }), /answer -1 is not/],
    ["files empty", JSON.stringify({ ...overlay, content: { files: {} } }), /replaces no file/],
    ["files missing", JSON.stringify({ ...overlay, content: {} }), /no files object/],
    ["file not text", JSON.stringify({ ...overlay, content: { files: { "coder.md": 3 } } }), /coder.md is not text/],
    ["not a prompt file", JSON.stringify({ ...overlay, content: { files: { "README.md": "x" } } }), /README\.md is not a prompt file/],
    ["ralph.sh", JSON.stringify({ ...overlay, content: { files: { "ralph.sh": "x" } } }), /ralph\.sh is not a prompt file/],
    ["dot-dot", JSON.stringify({ ...overlay, content: { files: { "prompts/../coder.md": "x" } } }), /leaves the harness/],
    ["dot-dot name", JSON.stringify({ ...overlay, content: { files: { "prompts/..md": "x" } } }), /leaves the harness/],
    ["absolute", JSON.stringify({ ...overlay, content: { files: { "/etc/coder.md": "x" } } }), /leaves the harness/],
    ["stages empty", JSON.stringify({ ...lineup, content: { stages: {} } }), /changes no stage/],
    ["stage unknown", JSON.stringify({ ...lineup, content: { stages: { wizard: { model: "m" } } } }), /stage wizard is not one of/],
    ["model empty", JSON.stringify({ ...lineup, content: { stages: { executor: { model: "" } } } }), /executor names no model/],
    ["model not a string", JSON.stringify({ ...lineup, content: { stages: { executor: { model: 4 } } } }), /executor names no model/],
    ["runner unknown", JSON.stringify({ ...lineup, content: { stages: { executor: { model: "m", runner: "gemini" } } } }), /runner gemini is not one of/],
  ];
  it("carries the current judge and analyst instructions and each case's status", () => {
    const input = improverInput(run(), [evalCase("c1", ["auth"], "saturated"), evalCase("c2", ["ui"])], LINEUP, INSTRUCTIONS);
    expect(input.instructions).toEqual(INSTRUCTIONS);
    expect(input.cases.map((c) => c.status)).toEqual(["saturated", "active"]);
    const prompt = improverPrompt(input, "quality");
    for (const kind of ["judge-prompt", "analyst-prompt", "case", "check", "retire-suggestion"]) expect(prompt).toContain(`"${kind}"`);
    expect(prompt).toContain("JUDGE_NOW");
    expect(prompt).toContain("may only ADD a case or a check");
    expect(prompt).toContain("A test file only, never a command");
    expect(prompt).toContain("An analyst-prompt cannot pass yet");
    expect(prompt).not.toContain("\"command\": \"<command>\"");
  });

  it("reports a case the set runs call saturated as saturated, never a retired one", () => {
    const cases = [evalCase("c1", ["auth"]), evalCase("c2", ["ui"]), evalCase("c3", ["billing"], "retired")];
    const input = improverInput({ ...run(), rows: [...run().rows, row("c3", "b", "green-pr")] }, cases, LINEUP, INSTRUCTIONS, new Set(["c1", "c3"]));
    expect(Object.fromEntries(input.cases.map((c) => [c.id, c.status]))).toEqual({ c1: "saturated", c2: "active", c3: "retired" });
    // Without the computed set, only the stored status shows.
    expect(improverInput(run(), cases, LINEUP, INSTRUCTIONS).cases.map((c) => c.status)).toEqual(["active", "active"]);
  });

  it("accepts each evaluation kind; a test-set kind needs no answers", () => {
    const accepted: [string, unknown, unknown][] = [
      ["judge-prompt", { instructions: "Judge strictly." }, [0]],
      ["analyst-prompt", { instructions: "Analyse." }, [1]],
      ["case", { repo: "acme/app", prs: [12], reason: "covers auth", tags: ["auth"] }, undefined],
      ["check", { case: "c1", test: "tests/auth.test.ts" }, []],
      ["check", { case: "c2", test: "tests/ui.test.ts" }, undefined],
      ["retire-suggestion", { case: "c1", reason: "every arm passes" }, [0]],
    ];
    for (const [kind, content, answers] of accepted) {
      const parsed = parseProposal(JSON.stringify({ kind, content, rationale: "r", answers }), "quality", IMPROVEMENTS);
      expect(parsed, kind).toEqual({ ok: true, proposal: { goal: "quality", kind, content, rationale: "r", answers: answers === undefined || (answers as number[]).length === 0 ? [] : [IMPROVEMENTS[(answers as number[])[0]!]] } });
    }
  });

  const evaluationRefusals: [string, string, RegExp][] = [
    ["case with notes", JSON.stringify({ kind: "case", content: { repo: "acme/app", prs: [12], reason: "r", notes: "the answer" }, rationale: "r" }), /may only add; it may not set notes/],
    ["judge-prompt without answers", JSON.stringify({ kind: "judge-prompt", content: { instructions: "x" }, rationale: "r" }), /answers no analyst improvement/],
    ["check with a bad index", JSON.stringify({ kind: "check", content: { case: "c1", test: "t.ts" }, rationale: "r", answers: [7] }), /answer 7 is not an analyst improvement/],
    ["check with a command", JSON.stringify({ kind: "check", content: { case: "c1", command: "x" }, rationale: "r" }), /an improver's check may only name a test file; a command check is an operator's/],
    ["check with both", JSON.stringify({ kind: "check", content: { case: "c1", command: "x", test: "t.ts" }, rationale: "r" }), /may only name a test file/],
  ];
  it.each(evaluationRefusals)("refuses: %s", (_, text, reason) => {
    const parsed = parseProposal(text, "quality", IMPROVEMENTS);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  it.each(refusals)("refuses: %s", (_, text, reason) => {
    const parsed = parseProposal(text, "quality", IMPROVEMENTS);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });
});

describe("subsetCases", () => {
  const set = [
    evalCase("e", ["auth"]), evalCase("b", ["auth", "db"]), evalCase("a", ["db"]), evalCase("r", ["auth"], "retired"),
    evalCase("u", ["ui"]), evalCase("f", ["other"]), evalCase("s", ["auth"], "saturated"),
  ];

  it("takes cited first, then failed, then tag-related cases in id order, never a retired one", () => {
    expect(subsetCases(set, ["b"], ["f"], DEFAULT_SUBSET)).toEqual(["b", "f", "a", "e", "s"]);
  });

  it("leaves failed cases out when told to", () => {
    expect(subsetCases(set, ["b"], ["f"], { size: 12, failed: false })).toEqual(["b", "a", "e", "s"]);
  });

  it("never chooses a retired case, even a cited or failed one", () => {
    expect(subsetCases(set, ["r"], ["r"], DEFAULT_SUBSET)).toEqual(["b", "e", "s"]);
  });

  it("caps at the size, never dropping a cited case for a failed one", () => {
    expect(subsetCases(set, ["b"], ["f"], { size: 2, failed: true })).toEqual(["b", "f"]);
    expect(subsetCases(set, ["b"], ["f", "u"], { size: 1, failed: true })).toEqual(["b"]);
  });
});

describe("failedCases", () => {
  const grades = (cases: [string, (string | null)[]][]): RunGrades => ({
    cases: cases.map(([id, objectives]) => ({
      case: id, grader: "tests", noEvidence: false,
      arms: objectives.map((objective, index) => ({ arm: `arm${index}`, objective: objective as "pass" | "fail" | "pending" | null, judge: null })),
    })),
    arms: [],
  });

  it("a fail grade fails the case; a pass grade overrides a failed row", () => {
    const rows = [row("x", "b", "green-pr"), row("y", "b", "failed")];
    expect(failedCases(rows, grades([["x", ["pass", "fail"]], ["y", ["pass"]]]))).toEqual(["x"]);
  });

  it("an ungraded or pending case falls back to its first trials; not-run and repeats never count", () => {
    const rows = [
      row("t", "b", "timed-out"), row("r", "b", "refused"), row("n", "b", "not-run"), row("g", "b", "green-pr"),
      row("p", "b", "failed"), row("rep", "b", "green-pr"), row("rep", "b", "failed", { repeat: 2 }),
    ];
    expect(failedCases(rows, grades([["p", ["pending", null]]]))).toEqual(["t", "r", "p"]);
    expect(failedCases(rows, null)).toEqual(["t", "r", "p"]);
  });
});
