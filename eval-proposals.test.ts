import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ArmConfig } from "./backtest";
import type { BacktestReport } from "./backtest-report";
import { DEFAULT_MAX_COST_RISE, DEFAULT_MIN_TOKEN_CUT, reportGuardrails, type GuardrailThresholds } from "./eval-guardrails";
import { addEntry, readInbox, removeEntry } from "./eval-inbox";
import type { NoiseStatus } from "./eval-noise-floor";
import {
  advanceProposals,
  fullSetPlan,
  proposalRuns,
  proposalStatus,
  proposalView,
  proposalViews,
  readProposals,
  readPromptVerdict,
  saturatedCaseIds,
  verdictPath,
  writePromptVerdict,
  type AdvanceDeps,
  type StoredPromptVerdict,
  type StoredProposal,
} from "./eval-proposals";
import { experimentsRoot, type EvalCaseView, type EvalRunSummary } from "./eval-runs";
import type { EvalCase } from "./evals-set";
import { guardrailReport, tokens, type GuardrailCase } from "./fixtures/evals/guardrail-arms";
import { scratchDir } from "./test-scratch";

const DEFAULTS: GuardrailThresholds = { maxCostRise: DEFAULT_MAX_COST_RISE, minTokenCut: DEFAULT_MIN_TOKEN_CUT };
const FRESH: NoiseStatus = {
  state: "fresh",
  floor: { version: "v", measuredAt: "2026-11-19T04:00:00Z", runId: "floor-run", spread: { objective: 0.25, judge: 0.5 } },
  drift: { added: 0, retired: 0, share: 0 },
  staleShare: 0.2,
};
const NOW = "2026-11-19T12:00:00.000Z";
const SOURCE_RUN = "run-1";
const PID = "prop-0123abcd";

/** Earns both goals; on a subset run (no floor) only objective-up fails, and it is dropped. */
const GOOD: GuardrailCase[] = [
  { id: "case-kept", live: { result: "pass" }, proposal: { result: "pass", judge: 5, tokens: tokens(800) } },
  { id: "case-won", live: { result: "fail" }, proposal: { result: "pass", tokens: tokens(800) } },
];
/** Loses a case the baseline passes. */
const REGRESSION: GuardrailCase[] = [
  { id: "case-lost", live: { result: "pass" }, proposal: { result: "fail" } },
  { id: "case-won", live: { result: "fail" }, proposal: { result: "pass" } },
];

function project(): string {
  const dir = scratchDir("ralph-proposals-");
  mkdirSync(experimentsRoot(dir), { recursive: true });
  return dir;
}

function proposalFile(root: string, pid = PID, over: Record<string, unknown> = {}): string {
  const dir = join(experimentsRoot(root), SOURCE_RUN, "proposals");
  mkdirSync(join(dir, pid, "overlay"), { recursive: true });
  writeFileSync(join(dir, pid, "overlay", "coder.md"), "OVERLAY_TEXT_SENTINEL");
  const path = join(dir, `${pid}.json`);
  writeFileSync(path, `${JSON.stringify({
    v: 1, id: pid, run: SOURCE_RUN, goal: "quality", kind: "prompt-overlay",
    content: { files: { "coder.md": "CONTENT_SENTINEL" } }, rationale: "c1 failed untested.",
    answers: [{ knob: "prompt", target: "coder.md", change: "Run the tests", arm: "b", evidence: ["c1"] }],
    model: "opus", createdAt: "2026-11-19T10:00:00.000Z", subset: ["case-kept", "case-won"], entry: "rec-subset", ...over,
  }, null, 2)}\n`);
  return path;
}

function stored(root: string, pid = PID): StoredProposal {
  const found = readProposals(root).proposals.find((entry) => entry.id === pid);
  expect(found).toBeDefined();
  return found!;
}

function arms(root: string, pid = PID): ArmConfig[] {
  return [
    { name: "current", lineup: "live", overlay: null },
    { name: "proposal", lineup: "live", overlay: join(experimentsRoot(root), SOURCE_RUN, "proposals", pid, "overlay") },
  ];
}

function run(id: string, runArms: ArmConfig[], cases: string[], over: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    id, dir: id, kind: "eval", startedAt: "2026-11-19T11:00:00Z", finishedAt: "2026-11-19T11:30:00Z", running: false, stoppedBy: null,
    source: { kind: "set", version: "v1", tags: [], cases, unrunnable: [] },
    arms: runArms, panel: [], resolved: null, repeats: 1, cases: [], totals: [], repeated: [], analysis: null,
    noise: null, noiseFloor: null, guardrails: null, judgeAccuracy: null, problem: null, ...over,
  };
}

function subsetPlan(root: string, pid = PID): Record<string, unknown> {
  return {
    version: 1, project: root, source: { kind: "set", tags: [], cases: ["case-kept", "case-won"] },
    arms: arms(root, pid), scoring: { judge: null }, repeats: 1, caps: { trials: 10 },
  };
}

function deps(root: string, runs: () => EvalRunSummary[], reports: Record<string, BacktestReport>, over: Partial<AdvanceDeps> = {}) {
  const checks: Record<string, unknown>[] = [];
  const advance: AdvanceDeps = {
    runs,
    readReport: (dir) => reports[dir] ?? null,
    readPlan: () => subsetPlan(root),
    thresholds: DEFAULTS,
    addEntry,
    readInbox,
    check: (_project, plan) => { checks.push(plan); },
    now: () => NOW,
    ...over,
  };
  return { advance, checks };
}

const statusOf = (root: string, runs: EvalRunSummary[], reports: Record<string, BacktestReport>, proposal = stored(root)) =>
  proposalStatus(proposal, runs, { readReport: (dir) => reports[dir] ?? null, thresholds: DEFAULTS, inbox: readInbox(root) });

async function seedSubsetEntry(root: string): Promise<string> {
  const entry = await addEntry(root, { plan: subsetPlan(root), recommendedBy: { kind: "agent", name: "improver" }, reason: "subset" }, NOW);
  proposalFile(root, PID, { entry: entry.id });
  return entry.id;
}

describe("readProposals", () => {
  test("reads proposals and reports a malformed file as a problem", () => {
    const root = project();
    proposalFile(root);
    writeFileSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", "broken.json"), "{");
    writeFileSync(join(experimentsRoot(root), SOURCE_RUN, "proposals", "odd.json"), JSON.stringify({ v: 1 }));
    const { proposals, problems } = readProposals(root);
    expect(proposals.map((entry) => entry.id)).toEqual([PID]);
    expect(proposals[0]!.full).toBeNull();
    expect(problems).toHaveLength(2);
  });

  test("a project with no experiments has none", () => {
    expect(readProposals(scratchDir("ralph-proposals-empty-"))).toEqual({ proposals: [], problems: [] });
  });
});

describe("proposalRuns", () => {
  test("matches the overlay or the improver lineup, and tells the subset run from the full one", () => {
    const root = project();
    const lineupArms: ArmConfig[] = [{ name: "current", lineup: "live", overlay: null }, { name: "proposal", lineup: `improver-${PID}`, overlay: null }];
    const runs = [
      run("sub-old", arms(root), ["case-kept"], { startedAt: "2026-11-19T09:00:00Z" }),
      run("sub-new", lineupArms, ["case-kept"], { startedAt: "2026-11-19T10:00:00Z" }),
      run("full", arms(root), []),
      run("tagged", arms(root), [], { source: { kind: "set", version: null, tags: ["ui"], cases: [], unrunnable: [] } }),
      run("other", arms(root, "prop-other"), []),
    ];
    const found = proposalRuns(PID, runs);
    expect(found.subset?.id).toBe("sub-new");
    expect(found.full?.id).toBe("full");
    expect(proposalRuns("prop-none", runs)).toEqual({ subset: null, full: null });
  });
});

describe("fullSetPlan", () => {
  test("keeps the arms, scoring and repeats over the whole set, nothing else", () => {
    const root = project();
    expect(fullSetPlan(subsetPlan(root))).toEqual({ source: { kind: "set", tags: [], cases: [] }, arms: arms(root), scoring: { judge: null }, repeats: 1 });
  });
});

describe("a proposal's lifecycle", () => {
  test("proposed → subset-run → promising → advanced → full-run → passed", async () => {
    const root = project();
    const subsetEntry = await seedSubsetEntry(root);
    const reports: Record<string, BacktestReport> = { sub: guardrailReport(GOOD) };
    expect(statusOf(root, [], reports)).toMatchObject({ status: "proposed", reason: null, runs: { subset: null, full: null } });

    // The operator started it: the entry left the inbox, and the run is going.
    const running = run("sub", arms(root), ["case-kept", "case-won"], { running: true, finishedAt: null });
    await removeEntry(root, subsetEntry);
    expect(statusOf(root, [running], reports)).toMatchObject({ status: "subset-run", reason: null, runs: { subset: "sub", full: null } });

    // Finished, promising: only objective-up (the floor) fails on the subset, and it is dropped.
    const done = run("sub", arms(root), ["case-kept", "case-won"]);
    const promising = statusOf(root, [done], reports);
    expect(promising).toMatchObject({ status: "subset-run", promising: true });
    // A promising subset settles nothing: no verdict until the full-set run's.
    expect(promising.verdict).toBeNull();

    const { advance, checks } = deps(root, () => [done], reports);
    const result = await advanceProposals(root, advance);
    expect(result).toEqual({ advanced: [PID], problems: [] });
    expect(checks).toHaveLength(1);
    const inbox = readInbox(root);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.plan).toEqual(fullSetPlan(subsetPlan(root)));
    expect(inbox[0]!.recommendedBy).toEqual({ kind: "agent", name: "improver" });
    expect(inbox[0]!.reason).toBe(`quality proposal ${PID}: full-set run, the subset run sub was promising`);
    expect(stored(root).full).toEqual({ entry: inbox[0]!.id, at: NOW, subsetRun: "sub" });
    expect(statusOf(root, [done], reports)).toMatchObject({ status: "full-run", promising: true, verdict: null, reason: "the subset run was promising" });

    const fullRunning = run("full", arms(root), [], { running: true, finishedAt: null, startedAt: "2026-11-19T12:00:00Z" });
    expect(statusOf(root, [done, fullRunning], reports)).toMatchObject({ status: "full-run", runs: { subset: "sub", full: "full" } });

    const guardrails = reportGuardrails(guardrailReport(GOOD), FRESH, DEFAULTS);
    const fullDone = run("full", arms(root), [], { startedAt: "2026-11-19T12:00:00Z", guardrails });
    const passed = statusOf(root, [done, fullDone], reports);
    expect(passed.status).toBe("passed");
    expect(passed.verdict?.pass).toBe(true);
    expect(passed.verdict?.conditions.map((condition) => condition.id)).toContain("objective-up");
  });

  test("a full run whose verdict fails is failed, with each condition's reason", () => {
    const root = project();
    proposalFile(root, PID, { full: { entry: "rec-full", at: NOW, subsetRun: "sub" } });
    const guardrails = reportGuardrails(guardrailReport(REGRESSION), FRESH, DEFAULTS);
    const result = statusOf(root, [run("sub", arms(root), ["case-kept"]), run("full", arms(root), [], { guardrails })], {});
    expect(result.status).toBe("failed");
    expect(result.verdict?.pass).toBe(false);
    const lost = result.verdict?.conditions.find((condition) => condition.id === "no-regressions");
    expect(lost).toMatchObject({ pass: false, reason: "1 case(s) the baseline passes are lost: case-lost" });
  });

  test("a finished full run with no verdict is failed and says why", () => {
    const root = project();
    proposalFile(root);
    expect(statusOf(root, [run("full", arms(root), [], { stoppedBy: "operator" })], {}).reason).toContain("operator");
    expect(statusOf(root, [run("full", arms(root), [])], {})).toMatchObject({ status: "failed", reason: "no guardrail verdict: no noise floor or no baseline pair" });
  });

  test("a run stopped before the end (killed, stopped by hand) is failed and says so", () => {
    const root = project();
    proposalFile(root);
    const stopped = { running: false, finishedAt: null, problem: "the run has no report: it stopped before its first trial finished, or is starting" };
    expect(statusOf(root, [run("sub", arms(root), ["case-kept"], stopped)], {})).toMatchObject({
      status: "failed", reason: `the subset run stopped before the end: ${stopped.problem}`,
    });
    expect(statusOf(root, [run("sub", arms(root), ["case-kept"]), run("full", arms(root), [], { ...stopped, problem: null, startedAt: "2026-11-19T12:00:00Z" })], { sub: guardrailReport(GOOD) })).toMatchObject({
      status: "failed", reason: "the full-set run stopped before the end",
    });
  });

  test("an unpromising subset run is failed, and advance recommends nothing", async () => {
    const root = project();
    proposalFile(root);
    const reports = { sub: guardrailReport(REGRESSION) };
    const done = run("sub", arms(root), ["case-lost", "case-won"]);
    const result = statusOf(root, [done], reports);
    expect(result).toMatchObject({ status: "failed", promising: false });
    expect(result.reason).toContain("the subset run was not promising: ");
    expect(result.reason).toContain("no-regressions");
    expect(result.verdict?.conditions.map((condition) => condition.id)).not.toContain("objective-up");

    const { advance, checks } = deps(root, () => [done], reports);
    expect(await advanceProposals(root, advance)).toEqual({ advanced: [], problems: [] });
    expect(checks).toHaveLength(0);
    expect(readInbox(root)).toEqual([]);
    expect(stored(root).full).toBeNull();
  });

  test("a subset run with no graded pair is not promising", () => {
    const root = project();
    proposalFile(root);
    const { set: _set, ...unset } = guardrailReport(GOOD);
    const result = statusOf(root, [run("sub", arms(root), ["case-kept"])], { sub: unset });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("no graded baseline/proposal pair");
  });

  test("a dismissed subset or full-set recommendation is said", () => {
    const root = project();
    proposalFile(root);
    expect(statusOf(root, [], {})).toMatchObject({ status: "proposed", reason: "its subset run (inbox entry rec-subset) was dismissed from the inbox" });
    proposalFile(root, PID, { full: { entry: "rec-full", at: NOW, subsetRun: "sub" } });
    const result = statusOf(root, [run("sub", arms(root), ["case-kept", "case-won"])], { sub: guardrailReport(GOOD) });
    expect(result).toMatchObject({ status: "full-run", reason: "its full-set run (inbox entry rec-full) was dismissed from the inbox" });
  });
});

describe("advanceProposals", () => {
  test("advancing twice recommends one full-set run", async () => {
    const root = project();
    proposalFile(root);
    const done = run("sub", arms(root), ["case-kept", "case-won"]);
    const { advance } = deps(root, () => [done], { sub: guardrailReport(GOOD) });
    expect((await advanceProposals(root, advance)).advanced).toEqual([PID]);
    expect(await advanceProposals(root, advance)).toEqual({ advanced: [], problems: [] });
    expect(readInbox(root)).toHaveLength(1);
  });

  test("two concurrent advances recommend one full-set run", async () => {
    const root = project();
    proposalFile(root);
    const done = run("sub", arms(root), ["case-kept", "case-won"]);
    const { advance } = deps(root, () => [done], { sub: guardrailReport(GOOD) });
    const [first, second] = await Promise.all([advanceProposals(root, advance), advanceProposals(root, advance)]);
    expect([...first.advanced, ...second.advanced]).toEqual([PID]);
    expect(readInbox(root)).toHaveLength(1);
  });

  test("an inbox entry already holding the full-set plan is adopted, not doubled", async () => {
    const root = project();
    proposalFile(root);
    const existing = await addEntry(root, { plan: fullSetPlan(subsetPlan(root)), recommendedBy: { kind: "person", name: "felipe" }, reason: "by hand" }, NOW);
    const done = run("sub", arms(root), ["case-kept", "case-won"]);
    const { advance, checks } = deps(root, () => [done], { sub: guardrailReport(GOOD) });
    expect((await advanceProposals(root, advance)).advanced).toEqual([PID]);
    expect(checks).toHaveLength(0);
    expect(readInbox(root)).toHaveLength(1);
    expect(stored(root).full?.entry).toBe(existing.id);
  });

  test("a refused check is a problem for that proposal and does not stop the others", async () => {
    const root = project();
    const other = "prop-other";
    proposalFile(root);
    proposalFile(root, other);
    const runs = [run("sub", arms(root), ["case-kept"]), run("sub-other", arms(root, other), ["case-kept"])];
    const { advance } = deps(root, () => runs, { sub: guardrailReport(GOOD), "sub-other": guardrailReport(GOOD) }, {
      readPlan: (dir) => subsetPlan(root, dir === "sub" ? PID : other),
      check: (_project, plan) => { if (JSON.stringify(plan).includes(other)) throw new Error("eval plan: refused"); },
    });
    const result = await advanceProposals(root, advance);
    expect(result.advanced).toEqual([PID]);
    expect(result.problems).toEqual([`proposal ${other}: eval plan: refused`]);
    expect(readInbox(root)).toHaveLength(1);
    expect(stored(root, other).full).toBeNull();
  });
});

describe("proposalView", () => {
  test("shows rationale and answers only with details, and never the content or overlay", () => {
    const root = project();
    const path = proposalFile(root);
    const proposal = stored(root);
    const state = statusOf(root, [], {});
    const brief = proposalView(proposal, state, false);
    expect(brief).not.toHaveProperty("rationale");
    expect(brief).not.toHaveProperty("answers");
    const full = proposalView(proposal, state, true);
    expect(full.rationale).toBe("c1 failed untested.");
    expect(full.answers).toEqual([{ knob: "prompt", target: "coder.md", change: "Run the tests" }]);
    for (const view of [brief, full]) {
      const text = JSON.stringify(view);
      expect(text).not.toContain("CONTENT_SENTINEL");
      expect(text).not.toContain("OVERLAY_TEXT_SENTINEL");
      expect(text).not.toContain(join(PID, "overlay"));
      expect(text).not.toContain("content");
    }
    expect(readFileSync(path, "utf8")).toContain("CONTENT_SENTINEL");
  });

  test("lists newest first", () => {
    const root = project();
    proposalFile(root, "prop-a", { createdAt: "2026-11-19T09:00:00.000Z" });
    proposalFile(root, "prop-b", { createdAt: "2026-11-19T11:00:00.000Z" });
    const rows = readProposals(root).proposals.map((proposal) => proposalView(proposal, statusOf(root, [], {}, proposal), false));
    expect(proposalViews(rows).map((row) => row.id)).toEqual(["prop-b", "prop-a"]);
  });
});

describe("evaluation proposals (#878)", () => {
  function evalCase(id: string, over: Partial<EvalCase> = {}): EvalCase {
    return {
      v: 1, id, kind: "coder", repo: "acme/app",
      prs: [{ number: 1, url: "u", createdAt: "", mergedAt: "", headRefName: "h", firstCommit: "f", headRefOid: "o" }],
      baseCommit: "b", startedAt: "2026-11-01T00:00:00Z", ticket: { ref: "r", title: "t", body: "b", comments: [], dropped: 0 },
      reference: "person", heldOut: [], tags: [], reason: "r", notes: "", status: "active", addedAt: "2026-11-01T00:00:00Z", addedBy: "x", ...over,
    };
  }
  const CHECK = { test: "CHECK_TEST_SENTINEL.test.ts", base: "fail", reference: "pass", acceptedAt: NOW, acceptedBy: "felipe" } as const;
  const checkProposal = { kind: "check", content: { case: "c1", test: "CHECK_TEST_SENTINEL.test.ts" }, subset: [], entry: null, answers: [] };
  const judgeProposal = { kind: "judge-prompt", content: { instructions: "Judge strictly." }, subset: ["c1"], entry: null };
  const status = (root: string, cases?: readonly EvalCase[]) =>
    proposalStatus(stored(root), [], { readReport: () => null, thresholds: DEFAULTS, inbox: [], ...(cases === undefined ? {} : { cases }) });
  const verdict = (pass: boolean): StoredPromptVerdict => ({
    v: 1, at: NOW, cases: ["c1"], pass,
    conditions: [{ id: "accuracy-up", pass, reason: "judge accuracy 0.5 → 0.75" }],
    current: { accuracy: { agree: 1, total: 2, accuracy: 0.5 }, axes: {}, objectives: {}, meanScore: null, cases: 1, checked: [] },
    proposed: { accuracy: { agree: 1, total: 2, accuracy: 0.75 }, axes: {}, objectives: {}, meanScore: null, cases: 1, checked: [] },
  } as unknown as StoredPromptVerdict);

  test("readProposals accepts each kind and refuses a bad evaluation content", () => {
    const root = project();
    proposalFile(root, "prop-check", checkProposal);
    proposalFile(root, "prop-judge", judgeProposal);
    proposalFile(root, "prop-bad", { kind: "case", content: { repo: "acme/app", prs: [2], reason: "r", notes: "x" } });
    const { proposals, problems } = readProposals(root);
    expect(proposals.map((proposal) => proposal.kind).sort()).toEqual(["check", "judge-prompt"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/prop-bad\.json: content: .*may not set notes/);
  });

  test("a judge-prompt is proposed until its verdict, then passed or failed", () => {
    const root = project();
    proposalFile(root, PID, judgeProposal);
    expect(status(root)).toMatchObject({ status: "proposed", reason: "awaiting its re-judge on the calibrated cases", verdict: null });
    writePromptVerdict(stored(root), verdict(true));
    expect(verdictPath(stored(root))).toBe(join(experimentsRoot(root), SOURCE_RUN, "proposals", PID, "verdict.json"));
    expect(status(root)).toMatchObject({ status: "passed", verdict: { pass: true, conditions: [{ id: "accuracy-up", pass: true }] } });
    writePromptVerdict(stored(root), verdict(false));
    expect(status(root)).toMatchObject({ status: "failed", verdict: { pass: false } });
    // The verdict sits in the pid directory: never read as a proposal.
    expect(readProposals(root)).toMatchObject({ problems: [] });
  });

  test("a malformed verdict file reads as none", () => {
    const root = project();
    proposalFile(root, PID, judgeProposal);
    writeFileSync(verdictPath(stored(root)), "{ not json");
    expect(readPromptVerdict(stored(root))).toBeNull();
    writeFileSync(verdictPath(stored(root)), JSON.stringify({ v: 1, pass: "yes" }));
    expect(readPromptVerdict(stored(root))).toBeNull();
    expect(status(root).status).toBe("proposed");
  });

  test("a check is suggested, confirmed once the case has a check, failed once the case is retired", () => {
    const root = project();
    proposalFile(root, PID, checkProposal);
    expect(status(root).status).toBe("suggested");
    expect(status(root, [evalCase("c1")]).status).toBe("suggested");
    expect(status(root, [evalCase("c1", { check: { ...CHECK } })]).status).toBe("confirmed");
    expect(status(root, [evalCase("c1", { status: "retired" })])).toMatchObject({ status: "failed", reason: "case c1 is already retired" });
  });

  test("a check is confirmed only by its own test: another check on the case fails it", () => {
    const root = project();
    proposalFile(root, PID, checkProposal);
    expect(status(root, [evalCase("c1", { check: { ...CHECK, test: "other.test.ts" } })]))
      .toMatchObject({ status: "failed", reason: "would replace case c1's check; a proposal may only add" });
    const { test: _test, ...rest } = CHECK;
    expect(status(root, [evalCase("c1", { check: { ...rest, command: "bun test" } })]).status).toBe("failed");
  });

  test("a stored check proposal naming a command reads as a problem", () => {
    const root = project();
    proposalFile(root, PID, { ...checkProposal, content: { case: "c1", command: "rm -rf ~" } });
    const { proposals, problems } = readProposals(root);
    expect(proposals).toEqual([]);
    expect(problems[0]).toMatch(/an improver's check may only name a test file/);
  });

  test("a retire suggestion reads the saturation the set runs compute, not only a stored status", () => {
    const root = project();
    proposalFile(root, "prop-retire", { kind: "retire-suggestion", content: { case: "c1", reason: "r" }, subset: [], entry: null });
    const view = (objective: "pass" | "fail"): EvalCaseView => ({
      key: "c1", title: "c1", repo: "acme/app", prs: [], reference: "person",
      arms: ["a", "b"].map((arm) => ({ arm, outcome: null, gates: null, heldOut: null, findings: null, rounds: null, wallSeconds: null, tokens: null, costUsd: null, axes: [], objective: arm === "a" ? null : objective, judge: null })),
      ranking: null, judges: [], contested: [], contestedRule: null, grade: { grader: "tests", noEvidence: false },
    });
    const setRun = (day: number, objective: "pass" | "fail") => run(`set-${day}`, [], ["c1"], { startedAt: `2026-11-0${day}T10:00:00Z`, cases: [view(objective)] });
    const passed = [setRun(1, "pass"), setRun(2, "pass"), setRun(3, "pass")];
    const of = (cases: readonly EvalCase[], runs: EvalRunSummary[]) =>
      proposalStatus(stored(root, "prop-retire"), [], { readReport: () => null, thresholds: DEFAULTS, inbox: [], cases, saturated: saturatedCaseIds(cases, runs, 3) });
    // Active, every arm passed its last three set runs: saturated, so the suggestion stands.
    expect(of([evalCase("c1")], passed).status).toBe("suggested");
    expect(saturatedCaseIds([evalCase("c1"), evalCase("c2", { status: "saturated" }), evalCase("c3", { status: "retired" })], passed, 3)).toEqual(new Set(["c1", "c2"]));
    // Kept after those runs: the window restarts, so it is not saturated.
    expect(of([evalCase("c1", { keptAt: "2026-11-05T00:00:00Z" })], passed)).toMatchObject({ status: "failed", reason: "case c1 is not saturated" });
    // A run it failed is not saturated either.
    expect(of([evalCase("c1")], [...passed, setRun(4, "fail")])).toMatchObject({ status: "failed", reason: "case c1 is not saturated" });
  });

  test("a case and a retire suggestion are confirmed when the set shows them done", () => {
    const root = project();
    proposalFile(root, "prop-case", { kind: "case", content: { repo: "Acme/App", prs: [7], reason: "r" }, subset: [], entry: null });
    proposalFile(root, "prop-retire", { kind: "retire-suggestion", content: { case: "c1", reason: "r" }, subset: [], entry: null });
    const of = (pid: string, cases: readonly EvalCase[]) =>
      proposalStatus(stored(root, pid), [], { readReport: () => null, thresholds: DEFAULTS, inbox: [], cases });
    expect(of("prop-case", [evalCase("c1")]).status).toBe("suggested");
    const added = evalCase("acme-app-7", { prs: [{ ...evalCase("x").prs[0]!, number: 7 }] });
    expect(of("prop-case", [evalCase("c1"), added]).status).toBe("confirmed");
    expect(of("prop-retire", [evalCase("c1", { status: "saturated" })]).status).toBe("suggested");
    expect(of("prop-retire", [evalCase("c1")])).toMatchObject({ status: "failed", reason: "case c1 is not saturated" });
    expect(of("prop-retire", [evalCase("c1", { status: "retired" })]).status).toBe("confirmed");
  });

  test("advanceProposals ignores test-set and prompt proposals, even beside a promising run carrying them", async () => {
    const root = project();
    proposalFile(root, "prop-check", checkProposal);
    proposalFile(root, "prop-judge", judgeProposal);
    const done = [run("sub-check", arms(root, "prop-check"), ["case-kept", "case-won"]), run("sub-judge", arms(root, "prop-judge"), ["case-kept", "case-won"])];
    const { advance, checks } = deps(root, () => done, { "sub-check": guardrailReport(GOOD), "sub-judge": guardrailReport(GOOD) });
    expect(await advanceProposals(root, advance)).toEqual({ advanced: [], problems: [] });
    expect(checks).toEqual([]);
    expect(readInbox(root)).toEqual([]);
  });

  test("a summary-only view carries neither a test-set target nor a suggestion, not even the check's test", () => {
    const root = project();
    proposalFile(root, PID, checkProposal);
    const brief = proposalView(stored(root), status(root), false);
    expect(brief).not.toHaveProperty("target");
    expect(brief).not.toHaveProperty("suggestion");
    expect(JSON.stringify(brief)).not.toContain("CHECK_TEST_SENTINEL");
  });

  test("with details, a test-set view carries its target and what the operator confirms it with", () => {
    const root = project();
    proposalFile(root, PID, checkProposal);
    proposalFile(root, "prop-case", { kind: "case", content: { repo: "acme/app", prs: [7, 8], reason: "flaky area", tags: ["ui"] }, subset: [], entry: null });
    proposalFile(root, "prop-retire", { kind: "retire-suggestion", content: { case: "c1", reason: "saturated" }, subset: [], entry: null });
    proposalFile(root, "prop-judge", judgeProposal);
    const view = (pid: string) => proposalView(stored(root, pid), status(root), true);
    expect(view(PID)).toMatchObject({ target: "add check to c1", suggestion: { kind: "check", case: "c1", test: "CHECK_TEST_SENTINEL.test.ts" } });
    expect(view(PID).suggestion).not.toHaveProperty("command");
    expect(view("prop-case")).toMatchObject({ target: "add case acme/app#7, #8", suggestion: { kind: "case", repo: "acme/app", prs: [7, 8], reason: "flaky area", tags: ["ui"] } });
    expect(view("prop-retire").suggestion).toEqual({ kind: "retire-suggestion", case: "c1", reason: "saturated" });
    // A prompt proposal is no test-set suggestion.
    expect(view("prop-judge")).not.toHaveProperty("suggestion");
  });
});
