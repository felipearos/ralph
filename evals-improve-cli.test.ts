import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrialRow } from "./backtest-report";
import type { Improvement } from "./eval-analyst";
import { addEntry, readInbox } from "./eval-inbox";
import { promptHash } from "./eval-proposals";
import { EVAL_INSTRUCTION_FILES } from "./eval-instructions";
import { experimentsRoot } from "./eval-runs";
import { runEvalsImprove, type EvalsImproveDeps } from "./evals-improve";
import type { EvalCase } from "./evals-set";
import { scratchDir } from "./test-scratch";

const NOW = "2026-11-19T10:00:00.000Z";
const RUN = "run-1";
const PID = "prop-0123abcd";

function evalCase(id: string, tags: string[]): EvalCase {
  return {
    v: 1, id, kind: "coder", repo: "acme/app",
    prs: [{ number: 1, url: "https://example.test/PRS_SENTINEL", createdAt: "", mergedAt: "", headRefName: "h", firstCommit: "f", headRefOid: "o" }],
    baseCommit: "BASE_SENTINEL", startedAt: "2026-11-01T00:00:00Z",
    ticket: { ref: `REF-${id}`, title: `Title of ${id}`, body: `Body of ${id}`, comments: [{ author: "x", createdAt: "", body: "COMMENT_SENTINEL" }], dropped: 0 },
    reference: "person", heldOut: ["tests/HELD_OUT_SENTINEL.test.ts"], tags, reason: "REASON_SENTINEL", notes: "NOTE_SENTINEL",
    check: { command: "bun test CHECK_SENTINEL", base: "fail", reference: "pass", acceptedAt: NOW, acceptedBy: "felipe" },
    status: "active", addedAt: "2026-11-01T00:00:00Z", addedBy: "ADDED_BY_SENTINEL",
  };
}

const CASES = [evalCase("c1", ["auth"]), evalCase("c2", ["ui"]), evalCase("c3", ["billing"])];
const SENTINELS = ["PRS_SENTINEL", "BASE_SENTINEL", "COMMENT_SENTINEL", "HELD_OUT_SENTINEL", "REASON_SENTINEL", "NOTE_SENTINEL", "CHECK_SENTINEL", "ADDED_BY_SENTINEL", "REFERENCE_DIFF_SENTINEL"];

function row(ticket: string, arm: string, outcome: TrialRow["outcome"], extra: Partial<TrialRow> = {}): TrialRow {
  return {
    ticket, arm, lineup: "live", outcome, detail: "d", gates: [{ name: "ci", conclusion: "SUCCESS" }], weakening: [], reviewRounds: 1,
    reviewThreads: 0, wallSeconds: 10, tokens: null, cost: { usd: 1, source: "reported" }, artifacts: "x", models: [], ...extra,
  };
}

const IMPROVEMENTS: Improvement[] = [
  { knob: "prompt", target: "coder.md", change: "Run the tests before pushing", arm: "b", evidence: ["c2"] },
];

/** A finished run as the engine leaves it: c1 failed on b, c2 passed and was repeated, with a patch and a log. */
function seedRun(project: string, options: { analysis?: boolean; set?: boolean } = {}): string {
  const dir = join(experimentsRoot(project), RUN);
  mkdirSync(dir, { recursive: true });
  const rows = [row("c1", "b", "failed"), row("c2", "b", "green-pr"), row("c2", "b", "green-pr", { repeat: 2 }), row("c1", "a", "green-pr")];
  writeFileSync(join(dir, "report.json"), JSON.stringify({ rows, ...(options.set === false ? {} : { set: { version: "v1", selected: ["c1", "c2"] } }) }));
  if (options.analysis !== false) {
    writeFileSync(join(dir, "analysis.json"), JSON.stringify({ status: "ok", model: "m", summary: "s", improvements: IMPROVEMENTS, dropped: [] }));
  }
  writeFileSync(join(dir, "state.json"), JSON.stringify({ config: { arms: [{ name: "b", lineup: "live", overlay: null }], scoring: { analyst: { model: "analyst-model" } } } }));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ repeats: 1, scoring: { judge: null } }));
  mkdirSync(join(dir, "c1", "b", "logs"), { recursive: true });
  writeFileSync(join(dir, "c1", "b", "patch.diff"), "diff --git a/x PATCH_B");
  writeFileSync(join(dir, "c1", "b", "logs", "iteration.log"), "LOG_B");
  writeFileSync(join(dir, "c1", "b", "logs", "binary.bin"), Buffer.from([0, 1, 2]));
  const thread = { id: 1, headSha: "h1", path: "src/x.ts", line: 1, comments: [{ author: "reviewer", body: "![P2 Badge](x) **THREAD_TITLE_B**\n\nmore" }, { author: "coder", body: "Fixed in h2" }] };
  writeFileSync(join(dir, "c1", "b", "result.json"), JSON.stringify({ outcome: { kind: "failed" }, github: { prs: [{ number: 1, heads: [{ sha: "h1", findings: [{}] }], reviewThreads: [thread] }] } }));
  mkdirSync(join(dir, "c1", "a"), { recursive: true });
  writeFileSync(join(dir, "c1", "a", "patch.diff"), "REFERENCE_DIFF_SENTINEL");
  return dir;
}

const OVERLAY_ANSWER = JSON.stringify({ kind: "prompt-overlay", content: { files: { "coder.md": "Run the tests." } }, rationale: "c1 failed untested.\nMore detail.", answers: [0] });

const MODELS = JSON.parse(readFileSync(join(import.meta.dirname, "models.json"), "utf8")) as Record<string, unknown>;

function fakeDeps(answer: string | { ok: false; reason: string }, over: Partial<EvalsImproveDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const models: string[] = [];
  const launches: { argv: string[]; log: string; unit: string }[] = [];
  const checks: Record<string, unknown>[] = [];
  const home = scratchDir("ralph-improve-home-");
  const deps: EvalsImproveDeps = {
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSet: () => ({ version: "v1", cases: CASES }),
    judge: ({ model }) => async (prompt) => {
      models.push(model);
      prompts.push(prompt);
      return typeof answer === "string" ? { ok: true, text: answer } : answer;
    },
    check: (_project, plan) => { checks.push(plan); },
    launcher: ({ argv, log, unit }) => { launches.push({ argv, log, unit }); return 4242; },
    bun: "bun",
    home,
    loadConfig: () => ({ default: MODELS.default }),
    projectConfig: () => ({}),
    proposalId: () => PID,
    nonce: () => "n0",
    readPrompt: () => null,
    addEntry,
    readInstructions: (kind) => (kind === "judge-prompt" ? "JUDGE_TEXT" : "ANALYST_TEXT"),
    saturated: () => undefined,
    ...over,
  };
  return { deps, out, err, prompts, models, launches, checks, home, json: () => JSON.parse(out.at(-1)!) as Record<string, any> };
}

const propose = (project: string, extra: string[] = []) => ["propose", "--run", RUN, "--goal", "quality", "--project", project, ...extra];

/** Every file under a directory, for "nothing started" checks. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}

describe("evals-improve propose", () => {
  it("stores an overlay proposal and queues its run, starting nothing", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const fake = fakeDeps(OVERLAY_ANSWER);
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
    expect(fake.json()).toMatchObject({ ok: true, proposal: PID, kind: "prompt-overlay", goal: "quality" });

    const stored = JSON.parse(readFileSync(join(runDir, "proposals", `${PID}.json`), "utf8"));
    expect(stored).toMatchObject({ v: 1, id: PID, run: RUN, goal: "quality", kind: "prompt-overlay", content: { files: { "coder.md": "Run the tests." } }, rationale: "c1 failed untested.\nMore detail.", model: "analyst-model", createdAt: NOW });
    const overlay = join(runDir, "proposals", PID, "overlay");
    expect(readFileSync(join(overlay, "coder.md"), "utf8")).toBe("Run the tests.");

    const inbox = readInbox(project);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.id).toBe(stored.entry);
    expect(fake.json().entry).toBe(stored.entry);
    expect(inbox[0]!.recommendedBy.kind).toBe("agent");
    expect(inbox[0]!.reason).toBe(`quality proposal ${PID} (prompt-overlay) on run ${RUN}: c1 failed untested.`);
    const plan = inbox[0]!.plan as { source: { kind: string; cases: string[] }; arms: { name: string; lineup: string; overlay: string | null }[]; repeats: number };
    expect(plan.arms).toEqual([{ name: "current", lineup: "live", overlay: null }, { name: "proposal", lineup: "live", overlay }]);
    expect(plan.source.kind).toBe("set");
    expect(plan.source.cases).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(plan.source.cases).toEqual(stored.subset);
    expect(plan.repeats).toBe(1);
    expect(fake.checks).toHaveLength(1);

    const prompt = fake.prompts[0]!;
    expect(prompt).toContain("PATCH_B");
    expect(prompt).toContain("THREAD_TITLE_B");
    expect(prompt).toContain("LOG_B");
    for (const sentinel of SENTINELS) expect(prompt).not.toContain(sentinel);
    expect(fake.launches).toEqual([]);
    expect(walk(experimentsRoot(project)).filter((path) => path.endsWith("eval.pid"))).toEqual([]);
  });

  it("writes a lineup proposal as a lineup file under the given home", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project);
    const answer = JSON.stringify({ kind: "lineup", content: { stages: { executor: { model: "claude-sonnet-5-5", runner: "claude" } } }, rationale: "cheaper", answers: [0] });
    const fake = fakeDeps(answer, { proposalId: () => "prop-feedbeef" });
    expect(await runEvalsImprove(propose(project, ["--model", "other-model"]), fake.deps)).toBe(0);
    expect(fake.models).toEqual(["other-model"]);
    const lineup = JSON.parse(readFileSync(join(fake.home, ".ralph", "lineups", "improver-prop-feedbeef.json"), "utf8"));
    expect(lineup.default.executor).toMatchObject({ model: "claude-sonnet-5-5", runner: "claude" });
    expect(lineup.default.orchestrator).toEqual((MODELS.default as Record<string, unknown>).orchestrator);
    const plan = readInbox(project)[0]!.plan as { arms: { lineup: string }[] };
    expect(plan.arms[1]).toEqual({ name: "proposal", lineup: "improver-prop-feedbeef", overlay: null });
  });

  it("nests a dotted review stage where models.json keeps it", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project);
    const answer = JSON.stringify({ kind: "lineup", content: { stages: { "review.correctness": { model: "claude-sonnet-5-5", runner: "claude" } } }, rationale: "cheaper", answers: [0] });
    const fake = fakeDeps(answer, { proposalId: () => "prop-0dd5eed5" });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
    const lineup = JSON.parse(readFileSync(join(fake.home, ".ralph", "lineups", "improver-prop-0dd5eed5.json"), "utf8"));
    const review = (MODELS.default as { review: Record<string, unknown> }).review;
    expect(lineup.default["review.correctness"]).toBeUndefined();
    expect(lineup.default.review.correctness).toMatchObject({ model: "claude-sonnet-5-5", runner: "claude" });
    expect(lineup.default.review.standards).toEqual(review.standards);
  });

  it("refuses a malformed answer and stores nothing", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const fake = fakeDeps("I would change the coder prompt.");
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("no JSON object");
    expect(existsSync(join(runDir, "proposals"))).toBe(false);
    expect(readInbox(project)).toEqual([]);
  });

  it("refuses an overlay that touches a file other than a prompt", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const fake = fakeDeps(JSON.stringify({ kind: "prompt-overlay", content: { files: { "README.md": "x" } }, rationale: "r", answers: [0] }));
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("README.md is not a prompt file");
    expect(existsSync(join(runDir, "proposals"))).toBe(false);
    expect(readInbox(project)).toEqual([]);
  });

  it("removes the overlay when the recommended run would not start", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const fake = fakeDeps(OVERLAY_ANSWER, { check: () => { throw new Error("eval plan: no such case"); } });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("eval plan: no such case");
    expect(existsSync(join(runDir, "proposals", PID))).toBe(false);
    expect(existsSync(join(runDir, "proposals", `${PID}.json`))).toBe(false);
    expect(readInbox(project)).toEqual([]);
  });

  it("refuses a run with no analysis before calling the model", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project, { analysis: false });
    const fake = fakeDeps(OVERLAY_ANSWER);
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("has no analysis");
    expect(fake.prompts).toEqual([]);
  });

  it("--detach launches the inline command once and calls no model", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const fake = fakeDeps(OVERLAY_ANSWER);
    expect(await runEvalsImprove(propose(project, ["--detach"]), fake.deps)).toBe(0);
    expect(fake.json()).toEqual({ ok: true, started: true, run: RUN, goal: "quality", log: "improver-n0.log" });
    expect(fake.launches).toHaveLength(1);
    const launched = fake.launches[0]!;
    expect(launched.argv).not.toContain("--detach");
    expect(launched.argv).toEqual(expect.arrayContaining(["propose", "--run", RUN, "--goal", "quality", "--project", project]));
    expect(launched.log).toBe(join(runDir, "improver-n0.log"));
    expect(launched.argv).toEqual(expect.arrayContaining(["--session", "n0"]));
    expect(launched.unit).toMatch(/^ralph-improver-[0-9a-f]{10}$/);
    expect(fake.prompts).toEqual([]);
    expect(readInbox(project)).toEqual([]);
  });

  it("two detached proposes on one run get their own unit and log", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project);
    let count = 0;
    const fake = fakeDeps(OVERLAY_ANSWER, { nonce: () => `n${(count += 1)}` });
    expect(await runEvalsImprove(propose(project, ["--detach"]), fake.deps)).toBe(0);
    expect(await runEvalsImprove(propose(project, ["--detach"]), fake.deps)).toBe(0);
    const [first, second] = fake.launches;
    expect(first!.unit).not.toBe(second!.unit);
    expect(first!.log).not.toBe(second!.log);
  });

  it("the model call logs beside the session's launcher log, never into it", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const paths: string[] = [];
    const fake = fakeDeps(OVERLAY_ANSWER);
    fake.deps.judge = ({ logPath }) => async () => { paths.push(logPath); return { ok: true, text: OVERLAY_ANSWER }; };
    expect(await runEvalsImprove(propose(project, ["--session", "abc123"]), fake.deps)).toBe(0);
    expect(paths).toEqual([join(runDir, "improver-abc123.model.log")]);
  });

  it("refuses a run that is not a test-set run, before the model and before a detach", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project, { set: false });
    const fake = fakeDeps(OVERLAY_ANSWER);
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(await runEvalsImprove(propose(project, ["--detach"]), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("needs a test-set run");
    expect(fake.prompts).toEqual([]);
    expect(fake.launches).toEqual([]);
    expect(existsSync(join(runDir, "proposals"))).toBe(false);
  });

  it("refuses an empty subset rather than queue a whole-set run, storing nothing", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const retired = CASES.map((c) => ({ ...c, status: "retired" as const }));
    const fake = fakeDeps(OVERLAY_ANSWER, { readSet: () => ({ version: "v1", cases: retired }) });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("no related case is active");
    expect(fake.checks).toEqual([]);
    expect(existsSync(join(runDir, "proposals"))).toBe(false);
    expect(readInbox(project)).toEqual([]);
  });

  it("keeps both of two review stages in one proposal", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project);
    const stages = { "review.standards": { model: "claude-sonnet-5-5", runner: "claude" }, "review.correctness": { model: "claude-sonnet-5-5" } };
    const fake = fakeDeps(JSON.stringify({ kind: "lineup", content: { stages }, rationale: "r", answers: [0] }), { proposalId: () => "prop-00000002" });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
    const lineup = JSON.parse(readFileSync(join(fake.home, ".ralph", "lineups", "improver-prop-00000002.json"), "utf8"));
    const review = (MODELS.default as { review: Record<string, Record<string, unknown>> }).review;
    expect(lineup.default.review.standards).toEqual({ runner: "claude", model: "claude-sonnet-5-5" });
    expect(lineup.default.review.correctness).toEqual({ ...review.correctness, model: "claude-sonnet-5-5" });
    expect(lineup.default.review.spec).toEqual(review.spec);
  });

  it("drops the old runner's fallback when a stage moves runner", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project);
    const answer = JSON.stringify({ kind: "lineup", content: { stages: { "review.spec": { runner: "claude", model: "opus" } } }, rationale: "r", answers: [0] });
    const fake = fakeDeps(answer, { proposalId: () => "prop-00000003" });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
    const lineup = JSON.parse(readFileSync(join(fake.home, ".ralph", "lineups", "improver-prop-00000003.json"), "utf8"));
    expect(lineup.default.review.spec).toEqual({ runner: "claude", model: "opus" });
    expect(fake.prompts[0]).toContain("review.spec");
  });

  it("shows the model the current prompt file and refuses an overlay that drops a placeholder", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const current = "Coder rules.\n{{PROJECT_GATES}}\n{{PROJECT_STYLE}}\nCURRENT_CODER_TEXT";
    const answer = JSON.stringify({ kind: "prompt-overlay", content: { files: { "coder.md": "Coder rules.\n{{PROJECT_GATES}}\nRun the tests." } }, rationale: "r", answers: [0] });
    const fake = fakeDeps(answer, { readPrompt: (path) => (path === "coder.md" ? current : null) });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.prompts[0]).toContain("CURRENT_CODER_TEXT");
    expect(fake.err.join("\n")).toContain("drops {{PROJECT_STYLE}}");
    expect(existsSync(join(runDir, "proposals"))).toBe(false);
    expect(readInbox(project)).toEqual([]);
  });

  it("records each overlay file's base as the trial's baseline read it (#875)", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const current = "Coder rules.\n{{PROJECT_GATES}}\n";
    const answer = JSON.stringify({ kind: "prompt-overlay", content: { files: { "coder.md": "Coder rules.\n{{PROJECT_GATES}}\nRun the tests.", "prompts/x.md": "x" } }, rationale: "r", answers: [0] });
    const fake = fakeDeps(answer, { readPrompt: (path) => (path === "coder.md" ? current : null) });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
    const dir = join(runDir, "proposals");
    const file = readdirSync(dir).find((name) => name.endsWith(".json"))!;
    const stored = JSON.parse(readFileSync(join(dir, file), "utf8")) as { bases?: Record<string, string | null> };
    expect(stored.bases).toEqual({ "coder.md": promptHash(current), "prompts/x.md": null });
  });

  describe("evaluation proposals (#878)", () => {
    const answerOf = (kind: string, content: unknown, answers?: number[]) => JSON.stringify({ kind, content, rationale: "r", ...(answers === undefined ? {} : { answers }) });
    const calibrated = (c: EvalCase): EvalCase => ({ ...c, calibration: [{ arms: ["b", "c"], axis: "correctness", preferred: "b", reason: "x", by: "felipe", at: NOW }] });

    it("refuses a case proposal holding an existing PR, storing nothing and queuing nothing", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("case", { repo: "Acme/App", prs: [1], reason: "auth" }), { addEntry: async () => { throw new Error("no inbox call expected"); } });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
      expect(fake.err.join("\n")).toContain("the improver's proposal was refused: would edit case c1");
      expect(existsSync(join(runDir, "proposals"))).toBe(false);
      expect(readInbox(project)).toEqual([]);
    });

    it("stores an accepted check proposal with no subset, no entry and no inbox call", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const { check: _check, ...open } = evalCase("c1", ["auth"]);
      let added = 0;
      const fake = fakeDeps(answerOf("check", { case: "c1", test: "tests/auth.test.ts" }), {
        readSet: () => ({ version: "v1", cases: [open, evalCase("c2", ["ui"])] }),
        addEntry: async () => { added += 1; throw new Error("no inbox call expected"); },
      });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
      expect(fake.json()).toEqual({ ok: true, proposal: PID, kind: "check", goal: "quality", entry: null, cases: 0 });
      const stored = JSON.parse(readFileSync(join(runDir, "proposals", `${PID}.json`), "utf8"));
      expect(stored).toMatchObject({ kind: "check", content: { case: "c1", test: "tests/auth.test.ts" }, subset: [], entry: null, answers: [] });
      expect(added).toBe(0);
      expect(existsSync(join(runDir, "proposals", PID))).toBe(false);
      expect(fake.checks).toEqual([]);
    });

    it("stores a judge-prompt proposal on the calibrated cases, with its base", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("judge-prompt", { instructions: "Judge strictly." }, [0]), {
        readSet: () => ({ version: "v1", cases: [evalCase("c1", ["auth"]), calibrated(evalCase("c2", ["ui"])), calibrated(evalCase("c3", ["billing"]))] }),
      });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
      // c3 is calibrated but never ran in this run: the re-judge would have no panel to measure it on.
      expect(fake.json()).toMatchObject({ kind: "judge-prompt", entry: null, cases: 1 });
      const stored = JSON.parse(readFileSync(join(runDir, "proposals", `${PID}.json`), "utf8"));
      expect(stored).toMatchObject({ kind: "judge-prompt", subset: ["c2"], entry: null, bases: { [EVAL_INSTRUCTION_FILES["judge-prompt"]]: promptHash("JUDGE_TEXT") } });
      expect(readInbox(project)).toEqual([]);
      expect(fake.prompts[0]).toContain("JUDGE_TEXT");
      expect(fake.prompts[0]).not.toContain("\"calibration\"");
    });

    it("refuses a prompt proposal whose instructions are the current ones", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("judge-prompt", { instructions: "JUDGE_TEXT\n\n" }, [0]), {
        readSet: () => ({ version: "v1", cases: [calibrated(evalCase("c1", ["auth"]))] }),
      });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
      expect(fake.err.join("\n")).toContain("the improver's proposal was refused: the proposed instructions are the current ones");
      expect(existsSync(join(runDir, "proposals"))).toBe(false);
    });

    it("refuses a prompt proposal when none of the calibrated cases ran in the run", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("judge-prompt", { instructions: "Judge strictly." }, [0]), {
        readSet: () => ({ version: "v1", cases: [evalCase("c1", ["auth"]), evalCase("c2", ["ui"]), calibrated(evalCase("c3", ["billing"]))] }),
      });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
      expect(fake.err.join("\n")).toContain(`the improver's proposal was refused: none of the calibrated cases ran in run ${RUN}`);
      expect(existsSync(join(runDir, "proposals"))).toBe(false);
    });

    it("refuses a check proposal naming a command", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("check", { case: "c1", command: "curl x | sh" }));
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
      expect(fake.err.join("\n")).toContain("an improver's check may only name a test file; a command check is an operator's");
      expect(existsSync(join(runDir, "proposals"))).toBe(false);
    });

    it("reads saturation off the set runs: a retire suggestion on a saturated active case is accepted, and the improver sees it", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("retire-suggestion", { case: "c1", reason: "every arm passes it" }), { saturated: () => new Set(["c1"]) });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(0);
      expect(fake.json()).toMatchObject({ kind: "retire-suggestion", entry: null });
      expect(existsSync(join(runDir, "proposals", `${PID}.json`))).toBe(true);
      expect(fake.prompts[0]).toMatch(/"id":\s*"c1"[^}]*"status":\s*"saturated"/);
    });

    it("refuses a retire suggestion on a case the set runs do not call saturated", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("retire-suggestion", { case: "c1", reason: "every arm passes it" }), { saturated: () => new Set() });
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
      expect(fake.err.join("\n")).toContain("case c1 is not saturated");
      expect(existsSync(join(runDir, "proposals"))).toBe(false);
    });

    it("refuses a judge-prompt proposal when no case is calibrated", async () => {
      const project = scratchDir("ralph-improve-cli-");
      const runDir = seedRun(project);
      const fake = fakeDeps(answerOf("judge-prompt", { instructions: "Judge strictly." }, [0]));
      expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
      expect(fake.err.join("\n")).toContain("no calibrated case to measure judge accuracy on");
      expect(existsSync(join(runDir, "proposals"))).toBe(false);
    });
  });

  it("removes the whole proposal when the inbox write fails", async () => {
    const project = scratchDir("ralph-improve-cli-");
    const runDir = seedRun(project);
    const fake = fakeDeps(OVERLAY_ANSWER, { addEntry: async () => { throw new Error("inbox locked"); } });
    expect(await runEvalsImprove(propose(project), fake.deps)).toBe(1);
    expect(fake.err.join("\n")).toContain("inbox locked");
    expect(existsSync(join(runDir, "proposals"))).toBe(false);
  });

  it("--detach still refuses a run with no analysis at once", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project, { analysis: false });
    const fake = fakeDeps(OVERLAY_ANSWER);
    expect(await runEvalsImprove(propose(project, ["--detach"]), fake.deps)).toBe(1);
    expect(fake.launches).toEqual([]);
  });

  it("is a usage error on a bad goal or run id", async () => {
    const project = scratchDir("ralph-improve-cli-");
    seedRun(project);
    const fake = fakeDeps(OVERLAY_ANSWER);
    expect(await runEvalsImprove(["propose", "--run", RUN, "--goal", "speed", "--project", project], fake.deps)).toBe(64);
    expect(await runEvalsImprove(["propose", "--run", "../etc", "--goal", "quality", "--project", project], fake.deps)).toBe(64);
    expect(await runEvalsImprove(["propose", "--goal", "quality", "--project", project], fake.deps)).toBe(64);
    expect(fake.prompts).toEqual([]);
  });
});
