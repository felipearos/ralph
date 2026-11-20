import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ArmConfig } from "./backtest";
import type { BacktestReport } from "./backtest-report";
import type { OpenProposalPrInput } from "./eval-open-pr";
import { RALPH_HOME } from "./paths";
import { DEFAULT_MAX_COST_RISE, DEFAULT_MIN_TOKEN_CUT } from "./eval-guardrails";
import { addEntry, readInbox } from "./eval-inbox";
import type { AdvanceDeps } from "./eval-proposals";
import { experimentsRoot, type EvalRunSummary } from "./eval-runs";
import { runEvalsProposals } from "./evals-proposals";
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

function cli(root: string, options: { details?: boolean; runs?: EvalRunSummary[]; reports?: Record<string, BacktestReport>; autoMerge?: boolean; openFails?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: OpenProposalPrInput[] = [];
  const advance: AdvanceDeps = {
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
  });
  return { run, out, err, opened };
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
