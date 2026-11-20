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
  type AdvanceDeps,
  type StoredProposal,
} from "./eval-proposals";
import { experimentsRoot, type EvalRunSummary } from "./eval-runs";
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
