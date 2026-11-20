import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ArmConfig } from "./backtest";
import type { BacktestReport } from "./backtest-report";
import type { ArmScore, TicketScore } from "./backtest-score";
import type { OpenProposalPrInput } from "./eval-open-pr";
import { RALPH_HOME } from "./paths";
import { DEFAULT_MAX_COST_RISE, DEFAULT_MIN_TOKEN_CUT } from "./eval-guardrails";
import { addEntry, readInbox } from "./eval-inbox";
import { AXES, type Axis, type AxisScore, type PanelResult } from "./eval-panel";
import { readPromptVerdict, type AdvanceDeps, type StoredProposal } from "./eval-proposals";
import type { RejudgeInput, RejudgeResult } from "./eval-rejudge";
import { experimentsRoot, type EvalRunSummary } from "./eval-runs";
import { runEvalsProposals } from "./evals-proposals";
import type { CalibrationVerdict, EvalCase } from "./evals-set";
import { guardrailReport, tokens, type GuardrailCase } from "./fixtures/evals/guardrail-arms";
import { scratchDir } from "./test-scratch";

const NOW = "2026-11-19T12:00:00.000Z";
const SOURCE_RUN = "run-1";
const PID = "prop-0123abcd";

/** Promising on a subset run: only the noise-floor condition fails, and it is dropped. */
const GOOD: GuardrailCase[] = [
  { id: "case-kept", live: { result: "pass" }, proposal: { result: "pass", judge: 5, tokens: tokens(800) } },
  { id: "case-won", live: { result: "fail" }, proposal: { result: "pass", tokens: tokens(800) } },
];

function project(): string {
  const dir = scratchDir("ralph-proposals-cli-");
  mkdirSync(experimentsRoot(dir), { recursive: true });
  return dir;
}

function proposalFile(root: string): void {
  const dir = join(experimentsRoot(root), SOURCE_RUN, "proposals");
  mkdirSync(join(dir, PID, "overlay"), { recursive: true });
  writeFileSync(join(dir, PID, "overlay", "coder.md"), "OVERLAY_TEXT_SENTINEL");
  writeFileSync(join(dir, `${PID}.json`), `${JSON.stringify({
    v: 1, id: PID, run: SOURCE_RUN, goal: "quality", kind: "prompt-overlay",
    content: { files: { "coder.md": "CONTENT_SENTINEL" } }, rationale: "c1 failed untested.",
    answers: [{ knob: "prompt", target: "coder.md", change: "Run the tests", arm: "b", evidence: ["c1"] }],
    model: "opus", createdAt: "2026-11-19T10:00:00.000Z", subset: ["case-kept", "case-won"], entry: "rec-subset",
  }, null, 2)}\n`);
}

function arms(root: string): ArmConfig[] {
  return [
    { name: "current", lineup: "live", overlay: null },
    { name: "proposal", lineup: "live", overlay: join(experimentsRoot(root), SOURCE_RUN, "proposals", PID, "overlay") },
  ];
}

function subsetRun(root: string): EvalRunSummary {
  return {
    id: "sub", dir: "sub", kind: "eval", startedAt: "2026-11-19T11:00:00Z", finishedAt: "2026-11-19T11:30:00Z", running: false, stoppedBy: null,
    source: { kind: "set", version: "v1", tags: [], cases: ["case-kept", "case-won"], unrunnable: [] },
    arms: arms(root), panel: [], resolved: null, repeats: 1, cases: [], totals: [], repeated: [], analysis: null,
    noise: null, noiseFloor: null, guardrails: null, judgeAccuracy: null, problem: null,
  };
}

/** The full-set run (no case, no tag) carrying the proposal, with the goal's verdict. */
function fullRun(root: string, pass: boolean): EvalRunSummary {
  return {
    ...subsetRun(root), id: "full", dir: "full", startedAt: "2026-11-19T11:40:00Z", finishedAt: "2026-11-19T11:55:00Z",
    source: { kind: "set", version: "v1", tags: [], cases: [], unrunnable: [] },
    guardrails: { baseline: "current", proposal: "proposal", goals: [{ goal: "quality", pass, conditions: [] }] },
  };
}

function cli(root: string, options: {
  details?: boolean; runs?: EvalRunSummary[]; reports?: Record<string, BacktestReport>; autoMerge?: boolean; openFails?: string;
  cases?: EvalCase[]; rejudge?: (input: RejudgeInput) => Promise<RejudgeResult>;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: OpenProposalPrInput[] = [];
  const rejudged: RejudgeInput[] = [];
  const advance: AdvanceDeps = {
    ...(options.cases === undefined ? {} : { cases: options.cases }),
    runs: () => options.runs ?? [],
    readReport: (dir) => options.reports?.[dir] ?? null,
    readPlan: () => ({
      version: 1, project: root, source: { kind: "set", tags: [], cases: ["case-kept", "case-won"] },
      arms: arms(root), scoring: { judge: null }, repeats: 1, caps: { trials: 10 },
    }),
    thresholds: { maxCostRise: DEFAULT_MAX_COST_RISE, minTokenCut: DEFAULT_MIN_TOKEN_CUT },
    addEntry,
    readInbox,
    check: () => {},
    now: () => NOW,
  };
  const run = (argv: string[]) => runEvalsProposals(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    advance: () => advance,
    details: () => options.details ?? false,
    openPr: async (input) => {
      opened.push(input);
      if (options.openFails !== undefined) throw new Error(options.openFails);
      return { kind: "opened", number: 901, url: "https://github.com/o/ralph/pull/901", branch: `evals/proposal-${input.proposal.id}`, files: ["coder.md"] };
    },
    config: () => (options.autoMerge === undefined ? {} : { evalsImprover: { autoMerge: options.autoMerge } }),
    rejudge: async (input) => {
      rejudged.push(input);
      if (options.rejudge === undefined) throw new Error("no re-judge in this test");
      return options.rejudge(input);
    },
    currentInstructions: (kind) => `CURRENT ${kind}`,
  });
  return { run, out, err, opened, rejudged };
}

describe("evals-proposals list", () => {
  test("advances a promising subset proposal to its full-set run", async () => {
    const root = project();
    proposalFile(root);
    const { run, out } = cli(root, { runs: [subsetRun(root)], reports: { sub: guardrailReport(GOOD) } });
    expect(await run(["list", "--project", root])).toBe(0);
    const printed = JSON.parse(out[0]!);
    expect(printed).toMatchObject({ version: 1, details: false, problems: [] });
    expect(printed.proposals).toHaveLength(1);
    expect(printed.proposals[0]).toMatchObject({ id: PID, status: "full-run", runs: { subset: "sub", full: null } });
    expect(readInbox(root)).toHaveLength(1);
  });

  test("without details, rows carry no rationale, answers, content or overlay", async () => {
    const root = project();
    proposalFile(root);
    const { run, out } = cli(root);
    expect(await run(["list", "--project", root])).toBe(0);
    const row = JSON.parse(out[0]!).proposals[0];
    expect(row).toMatchObject({ id: PID, status: "proposed" });
    expect(row).not.toHaveProperty("rationale");
    expect(row).not.toHaveProperty("answers");
    expect(out[0]).not.toContain("content");
    expect(out[0]).not.toContain("CONTENT_SENTINEL");
    expect(out[0]).not.toContain("OVERLAY_TEXT_SENTINEL");
    expect(out[0]).not.toContain(join(PID, "overlay"));
  });

  test("with details, rows carry the rationale and answers, never the content", async () => {
    const root = project();
    proposalFile(root);
    const { run, out } = cli(root, { details: true });
    expect(await run(["list", "--project", root])).toBe(0);
    const printed = JSON.parse(out[0]!);
    expect(printed.details).toBe(true);
    expect(printed.proposals[0].rationale).toBe("c1 failed untested.");
    expect(printed.proposals[0].answers).toEqual([{ knob: "prompt", target: "coder.md", change: "Run the tests" }]);
    expect(out[0]).not.toContain("CONTENT_SENTINEL");
  });

  test("a malformed proposal file is a problem, not a failed list", async () => {
    const root = project();
    proposalFile(root);
    writeFileSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", "broken.json"), "{");
    const { run, out } = cli(root);
    expect(await run(["list", "--project", root])).toBe(0);
    const printed = JSON.parse(out[0]!);
    expect(printed.proposals.map((row: { id: string }) => row.id)).toEqual([PID]);
    expect(printed.problems).toHaveLength(1);
    expect(printed.problems[0]).toContain("broken.json");
  });

  test("an inbox that does not parse is a problem beside the rows, not a failed list", async () => {
    const root = project();
    proposalFile(root);
    writeFileSync(join(experimentsRoot(root), "inbox.json"), "{");
    const { run, out } = cli(root);
    expect(await run(["list", "--project", root])).toBe(0);
    const printed = JSON.parse(out[0]!);
    expect(printed.proposals.map((row: { id: string }) => row.id)).toEqual([PID]);
    expect(printed.problems.some((problem: string) => problem.startsWith("the inbox could not be read"))).toBe(true);
    // Named from the project, never the host path.
    expect(JSON.stringify(printed.problems)).not.toContain(root);
  });

  test.each([
    [[]],
    [["show"]],
    [["list", "--bogus", "x"]],
    [["list", "--project"]],
    [["list", "extra"]],
  ])("bad usage %j exits 64", async (argv) => {
    const { run, out, err } = cli(project());
    expect(await run(argv)).toBe(64);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^evals-proposals: /);
    expect(err.join("\n")).toContain("usage: evals-proposals.ts list");
  });
});

describe("evals-proposals open-pr", () => {
  test("a passed proposal opens one PR with its full-set run, and prints it", async () => {
    const root = project();
    proposalFile(root);
    const { run, out, opened } = cli(root, { runs: [subsetRun(root), fullRun(root, true)] });
    expect(await run(["open-pr", PID, "--project", root])).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.proposal.id).toBe(PID);
    expect(opened[0]!.run.id).toBe("full");
    expect(opened[0]!.state).toMatchObject({ status: "passed", runs: { full: "full" } });
    expect(JSON.parse(out[0]!)).toEqual({ version: 1, kind: "opened", number: 901, url: "https://github.com/o/ralph/pull/901", proposal: PID, autoMerge: false });
    // Opening never advances: no run is recommended.
    expect(readInbox(root)).toEqual([]);
  });

  test("a failed open names files from the project and the harness, never the host's paths", async () => {
    const root = project();
    proposalFile(root);
    const said = `no overlay directory at ${root}/.ralph/logs/experiments/x and ${RALPH_HOME}/coder.md in ${tmpdir()}/eval-proposal-pr-1`;
    const { run, err } = cli(root, { runs: [subsetRun(root), fullRun(root, true)], openFails: said });
    expect(await run(["open-pr", PID, "--project", root])).toBe(1);
    const printed = err.join("\n");
    expect(printed).toContain(".ralph/logs/experiments/x");
    expect(printed).toContain("<tmp>/eval-proposal-pr-1");
    expect(printed).not.toContain(root);
    expect(printed).not.toContain(RALPH_HOME);
  });

  test("autoMerge on is reported and changes nothing else", async () => {
    const root = project();
    proposalFile(root);
    const { run, out, opened } = cli(root, { runs: [subsetRun(root), fullRun(root, true)], autoMerge: true });
    expect(await run(["open-pr", PID, "--project", root])).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.run.id).toBe("full");
    expect(JSON.parse(out[0]!)).toMatchObject({ kind: "opened", proposal: PID, autoMerge: true });
  });

  test.each([
    ["failed", (root: string) => [subsetRun(root), fullRun(root, false)], "is failed"],
    ["subset-run", (root: string) => [{ ...subsetRun(root), running: true, finishedAt: null }], "is subset-run"],
    ["proposed", () => [], "is proposed"],
  ])("a %s proposal opens nothing and exits 1", async (_status, runs, said) => {
    const root = project();
    proposalFile(root);
    const { run, out, err, opened } = cli(root, { runs: runs(root) });
    expect(await run(["open-pr", PID, "--project", root])).toBe(1);
    expect(opened).toEqual([]);
    expect(out).toEqual([]);
    expect(err[0]).toContain(`proposal ${PID} ${said}: only a passed proposal opens a PR`);
  });

  test("an unknown id exits 1", async () => {
    const root = project();
    proposalFile(root);
    const { run, err, opened } = cli(root, { runs: [subsetRun(root), fullRun(root, true)] });
    expect(await run(["open-pr", "prop-ffffffff", "--project", root])).toBe(1);
    expect(opened).toEqual([]);
    expect(err[0]).toBe("evals-proposals: no proposal prop-ffffffff");
  });

  test.each([
    [["open-pr"]],
    [["open-pr", "a", "b"]],
    [["open-pr", PID, "--bogus", "x"]],
  ])("bad usage %j exits 64", async (argv) => {
    const { run, out, err, opened } = cli(project());
    expect(await run(argv)).toBe(64);
    expect(out).toEqual([]);
    expect(opened).toEqual([]);
    expect(err.join("\n")).toContain("open-pr <proposal-id>");
  });

  test("neither the CLI nor the PR opener ever passes gh a merge", () => {
    for (const file of ["evals-proposals.ts", "eval-open-pr.ts"]) {
      expect(readFileSync(join(import.meta.dirname, file), "utf8")).not.toMatch(/["']merge["']/);
    }
  });
});

const PROMPT_PID = "prop-feedbeef";
const CHECK_PID = "prop-c0ffee00";

/** An evaluation proposal beside the overlay one: a judge-prompt on c1 and c2, or a check on c1. */
function evaluationProposal(root: string, id: string, kind: string, content: unknown, subset: string[]): StoredProposal {
  const dir = join(experimentsRoot(root), SOURCE_RUN, "proposals");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const stored = {
    v: 1, id, run: SOURCE_RUN, goal: "quality", kind, content, rationale: "r", answers: [],
    model: "opus", createdAt: "2026-11-19T10:00:00.000Z", subset, entry: null,
  };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  return { ...stored, full: null, path } as StoredProposal;
}

function cal(axis: Axis, preferred: string): CalibrationVerdict {
  return { arms: ["live", "prop"], axis, preferred, reason: "because", by: "op", at: "2026-11-19T00:00:00Z" };
}

function setCase(id: string, extra: Partial<EvalCase> = {}): EvalCase {
  return { id, repo: "org/app", status: "active", prs: [{ number: 1 }], ...extra } as unknown as EvalCase;
}

// The operators prefer live on correctness and tests, prop on scope; c3 is calibrated but not in the proposal's subset.
const SET: EvalCase[] = [
  setCase("c1", { calibration: [cal("correctness", "live"), cal("tests", "live"), cal("scope", "prop")] }),
  setCase("c2"),
  setCase("c3", { calibration: [cal("correctness", "prop")] }),
];

function judged(arms: Record<string, number>): PanelResult {
  const order = Object.keys(arms);
  const axes = (score: number) => Object.fromEntries(AXES.map((axis) => [axis, { score, evidence: "e" }])) as Record<Axis, AxisScore>;
  return {
    seed: "s", order, contested: [],
    verdicts: [{
      judge: { name: "judge-claude", runner: "claude", model: "opus" }, status: "ok", ranking: [order], reason: "r",
      arms: Object.fromEntries(Object.entries(arms).map(([arm, score]) => [arm, { axes: axes(score), better: "" }])),
    }],
    aggregate: { status: "ok", seed: "s", order, ranking: [order], winners: order, tie: true, reason: "r" },
  };
}

function armScore(name: string, result: "pass" | "fail"): ArmScore {
  return {
    arm: name as ArmScore["arm"], heads: { first: null, final: null },
    heldOut: name === "a" ? null : { status: "ok", files: [{ path: "x.test.ts", baseline: "fail", result }] },
    gates: null, review: null, human: null, notes: [],
  };
}

function ticketScore(ticket: string, scores: Record<string, number>): TicketScore {
  return { ticket, scoredAt: NOW, baseline: [], arms: [armScore("a", "pass"), armScore("live", "pass"), armScore("prop", "fail")], panel: judged(scores) };
}

describe("evals-proposals rejudge", () => {
  test("a proposed prompt that raises accuracy with objectives unchanged passes, and list shows it passed", async () => {
    const root = project();
    const proposal = evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c1", "c2"]);
    const { run, out, rejudged } = cli(root, {
      cases: SET,
      rejudge: async () => {
        // Current: live wins every axis, agreeing on 2 of 3. Proposed: prop also wins scope, agreeing on 3 of 3.
        const proposed = ticketScore("c1", { live: 4, prop: 3 });
        const verdict = proposed.panel!.verdicts[0]!;
        if (verdict.status === "ok") verdict.arms.prop!.axes.scope.score = 5;
        return { current: [ticketScore("c1", { live: 4, prop: 3 })], proposed: [proposed] };
      },
    });
    expect(await run(["rejudge", PROMPT_PID, "--project", root])).toBe(0);
    // c2 has no calibration and c3 is outside the proposal's subset: only c1 is re-judged.
    expect(rejudged).toHaveLength(1);
    expect(rejudged[0]).toMatchObject({
      project: root, runId: SOURCE_RUN, cases: ["c1"], kind: "judge-prompt",
      instructions: { current: "CURRENT judge-prompt", proposed: "PROPOSED" },
    });
    const printed = JSON.parse(out[0]!);
    expect(printed).toMatchObject({ version: 1, proposal: PROMPT_PID, pass: true });
    expect(printed.conditions.map((c: { id: string }) => c.id)).toEqual(["calibrated", "same-verdicts", "accuracy-up", "objective-unchanged", "scores-alone"]);
    expect(readPromptVerdict(proposal)).toMatchObject({ v: 1, at: NOW, cases: ["c1"], pass: true });

    expect(await run(["list", "--project", root])).toBe(0);
    expect(JSON.parse(out[1]!).proposals[0]).toMatchObject({ id: PROMPT_PID, status: "passed" });
    // The list re-judges nothing.
    expect(rejudged).toHaveLength(1);
  });

  test("a proposed prompt that raises the mean score but lowers accuracy fails, and list shows it failed", async () => {
    const root = project();
    evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c1"]);
    const { run, out } = cli(root, {
      cases: SET,
      rejudge: async () => ({ current: [ticketScore("c1", { live: 4, prop: 3 })], proposed: [ticketScore("c1", { live: 4, prop: 5 })] }),
    });
    expect(await run(["rejudge", PROMPT_PID, "--project", root])).toBe(0);
    const printed = JSON.parse(out[0]!);
    expect(printed.pass).toBe(false);
    expect(printed.conditions.find((c: { id: string }) => c.id === "accuracy-up")).toMatchObject({ pass: false });
    expect(await run(["list", "--project", root])).toBe(0);
    expect(JSON.parse(out[1]!).proposals[0]).toMatchObject({ id: PROMPT_PID, status: "failed" });
  });

  test("an analyst prompt is never rescored: it fails as not measurable by judge accuracy", async () => {
    const root = project();
    const proposal = evaluationProposal(root, PROMPT_PID, "analyst-prompt", { instructions: "PROPOSED" }, ["c1"]);
    const { run, out, rejudged } = cli(root, { cases: SET, rejudge: async () => ({ current: [], proposed: [] }) });
    expect(await run(["rejudge", PROMPT_PID, "--project", root])).toBe(0);
    expect(rejudged).toEqual([]);
    const printed = JSON.parse(out[0]!);
    expect(printed).toMatchObject({ proposal: PROMPT_PID, pass: false, conditions: [{ id: "measurable", pass: false }] });
    expect(printed.conditions[0].reason).toContain("the analyst's instructions never reach the judges");
    expect(readPromptVerdict(proposal)).toMatchObject({ v: 1, pass: false, cases: ["c1"] });
    expect(await run(["list", "--project", root])).toBe(0);
    expect(JSON.parse(out[1]!).proposals[0]).toMatchObject({ id: PROMPT_PID, status: "failed" });
  });

  test("a held re-judge lock refuses a second re-judge, and a finished one releases it", async () => {
    const root = project();
    const proposal = evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c1"]);
    const lock = join(experimentsRoot(root), SOURCE_RUN, "proposals", PROMPT_PID, "rejudge.lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, "{}\n");
    const held = cli(root, { cases: SET, rejudge: async () => ({ current: [], proposed: [] }) });
    expect(await held.run(["rejudge", PROMPT_PID, "--project", root])).toBe(1);
    expect(held.rejudged).toEqual([]);
    expect(held.err[0]).toContain(`a re-judge of ${PROMPT_PID} is already running (remove ${lock} if it died)`);
    expect(readFileSync(lock, "utf8")).toBe("{}\n");
    rmSync(lock);
    const free = cli(root, { cases: SET, rejudge: async () => ({ current: [ticketScore("c1", { live: 4, prop: 3 })], proposed: [ticketScore("c1", { live: 4, prop: 5 })] }) });
    expect(await free.run(["rejudge", PROMPT_PID, "--project", root])).toBe(0);
    expect(readPromptVerdict(proposal)).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
  });

  test.each([
    ["prompt-overlay", (root: string) => { proposalFile(root); return PID; }, "is a prompt-overlay proposal"],
    ["check", (root: string) => evaluationProposal(root, CHECK_PID, "check", { case: "c2", test: "c2.test.ts" }, []).id, "is a check proposal"],
  ])("refuses a %s proposal", async (_kind, write, said) => {
    const root = project();
    const id = write(root);
    const { run, out, err, rejudged } = cli(root, { cases: SET, rejudge: async () => ({ current: [], proposed: [] }) });
    expect(await run(["rejudge", id, "--project", root])).toBe(1);
    expect(rejudged).toEqual([]);
    expect(out).toEqual([]);
    expect(err[0]).toContain(said);
  });

  test("refuses a prompt proposal that already has a verdict, and leaves it as it was", async () => {
    const root = project();
    const proposal = evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c1"]);
    const first = cli(root, { cases: SET, rejudge: async () => ({ current: [ticketScore("c1", { live: 4, prop: 3 })], proposed: [ticketScore("c1", { live: 4, prop: 5 })] }) });
    expect(await first.run(["rejudge", PROMPT_PID, "--project", root])).toBe(0);
    const before = readFileSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", PROMPT_PID, "verdict.json"), "utf8");
    const again = cli(root, { cases: SET, rejudge: async () => ({ current: [], proposed: [] }) });
    expect(await again.run(["rejudge", PROMPT_PID, "--project", root])).toBe(1);
    expect(again.rejudged).toEqual([]);
    expect(again.err[0]).toContain("already has a verdict");
    expect(readFileSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", PROMPT_PID, "verdict.json"), "utf8")).toBe(before);
    expect(readPromptVerdict(proposal)?.pass).toBe(false);
  });

  test("refuses when no case of the proposal's subset is calibrated now", async () => {
    const root = project();
    evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c2", "c9"]);
    const { run, err, rejudged } = cli(root, { cases: SET, rejudge: async () => ({ current: [], proposed: [] }) });
    expect(await run(["rejudge", PROMPT_PID, "--project", root])).toBe(1);
    expect(rejudged).toEqual([]);
    expect(err[0]).toContain("no calibrated case left to re-judge on");
  });

  test("an unknown id exits 1, and a missing id is bad usage", async () => {
    const root = project();
    const { run, err } = cli(root, { cases: SET });
    expect(await run(["rejudge", "prop-ffffffff", "--project", root])).toBe(1);
    expect(err[0]).toBe("evals-proposals: no proposal prop-ffffffff");
    expect(await run(["rejudge"])).toBe(64);
  });
});

describe("evals-proposals open-pr, prompt proposals", () => {
  test("a passed judge-prompt proposal opens with its source run and its verdict", async () => {
    const root = project();
    const proposal = evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c1"]);
    const judged = cli(root, {
      cases: SET,
      rejudge: async () => {
        const proposed = ticketScore("c1", { live: 4, prop: 3 });
        const verdict = proposed.panel!.verdicts[0]!;
        if (verdict.status === "ok") verdict.arms.prop!.axes.scope.score = 5;
        return { current: [ticketScore("c1", { live: 4, prop: 3 })], proposed: [proposed] };
      },
    });
    expect(await judged.run(["rejudge", PROMPT_PID, "--project", root])).toBe(0);
    const source = { ...subsetRun(root), id: SOURCE_RUN };
    const { run, out, opened } = cli(root, { cases: SET, runs: [subsetRun(root), source] });
    expect(await run(["open-pr", PROMPT_PID, "--project", root])).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.run.id).toBe(SOURCE_RUN);
    expect(opened[0]!.verdict).toEqual(readPromptVerdict(proposal));
    expect(opened[0]!.verdict?.pass).toBe(true);
    expect(JSON.parse(out[0]!)).toMatchObject({ kind: "opened", proposal: PROMPT_PID });
  });

  test("a passed prompt proposal whose source run is gone opens nothing", async () => {
    const root = project();
    const proposal = evaluationProposal(root, PROMPT_PID, "judge-prompt", { instructions: "PROPOSED" }, ["c1"]);
    mkdirSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", PROMPT_PID), { recursive: true });
    writeFileSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", PROMPT_PID, "verdict.json"),
      JSON.stringify({ v: 1, at: NOW, cases: ["c1"], pass: true, conditions: [], current: {}, proposed: {} }));
    expect(readPromptVerdict(proposal)?.pass).toBe(true);
    const { run, err, opened } = cli(root, { cases: SET, runs: [] });
    expect(await run(["open-pr", PROMPT_PID, "--project", root])).toBe(1);
    expect(opened).toEqual([]);
    expect(err[0]).toContain(`source run ${SOURCE_RUN} is not among the runs`);
  });
});

describe("evals-proposals list, test-set proposals", () => {
  test("a check suggestion is confirmed once the set's case has that check", async () => {
    const root = project();
    evaluationProposal(root, CHECK_PID, "check", { case: "c2", test: "c2.test.ts" }, []);
    const before = cli(root, { cases: SET });
    expect(await before.run(["list", "--project", root])).toBe(0);
    expect(JSON.parse(before.out[0]!).proposals[0]).toMatchObject({ id: CHECK_PID, status: "suggested" });
    const checked = SET.map((c) => (c.id === "c2" ? { ...c, check: { test: "c2.test.ts", base: "fail", reference: "pass", acceptedAt: NOW, acceptedBy: "op" } } as EvalCase : c));
    const after = cli(root, { cases: checked });
    expect(await after.run(["list", "--project", root])).toBe(0);
    expect(JSON.parse(after.out[0]!).proposals[0]).toMatchObject({ id: CHECK_PID, status: "confirmed" });
  });
});
