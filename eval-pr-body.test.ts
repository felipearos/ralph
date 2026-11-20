import { describe, expect, it } from "vitest";

import { proposalCommitMessage, proposalPrBody, proposalPrTitle, qualityCostPoints } from "./eval-pr-body";
import type { ProposalState, StoredPromptVerdict, StoredProposal } from "./eval-proposals";
import type { EvalCaseArmView, EvalCaseView, EvalRunSummary } from "./eval-runs";

const scores = (correctness: number | null, scope: number | null) =>
  ({ correctness, scope, tests: null, maintainability: null, review: null });

const arm = (name: string, axes: EvalCaseArmView["axes"]): EvalCaseArmView => ({
  arm: name, outcome: "green", gates: null, heldOut: null, findings: null, rounds: null,
  wallSeconds: null, tokens: null, costUsd: null, axes, objective: null, judge: null,
});

const caseView = (key: string, arms: EvalCaseArmView[], contested: EvalCaseView["contested"]): EvalCaseView => ({
  key, title: key, repo: "o/r", prs: [], reference: null, arms, ranking: null, judges: [],
  contested, contestedRule: contested.length > 0 ? "judges disagree by 2 or more" : null, grade: null,
});

function fixtureRun(): EvalRunSummary {
  return {
    id: "run-full-1",
    dir: "/tmp/none",
    kind: "eval",
    startedAt: "2026-11-18T00:00:00Z",
    finishedAt: "2026-11-18T02:00:00Z",
    running: false,
    stoppedBy: null,
    source: { kind: "set", version: "abc1234", tags: [], cases: ["c1", "c2"], unrunnable: [] },
    arms: [{ name: "base", lineup: "live", overlay: null }, { name: "proposal", lineup: "live", overlay: "p1" }],
    panel: [{ name: "judge-a", runner: "claude", model: "opus-x" }, { name: "judge-b", runner: "codex", model: "gpt-y" }],
    resolved: null,
    repeats: 0,
    cases: [
      caseView("c1", [
        arm("base", [{ judge: "judge-a", scores: scores(3, 4), better: "" }, { judge: "judge-b", scores: scores(2, null), better: "" }]),
        arm("proposal", [{ judge: "judge-a", scores: scores(5, 4), better: "" }]),
      ], [{ axis: "correctness", arms: ["base", "proposal"] }]),
      caseView("case|pipe", [
        arm("base", [{ judge: "judge-a", scores: scores(3, null), better: "" }]),
        arm("proposal", [{ judge: "judge-a", scores: scores(4, 5), better: "" }]),
      ], []),
    ],
    totals: [
      { arm: "base", ran: 2, green: 2, judged: 2, wins: 0, costUsd: 1.5, costPartial: false, tokens: 100_000, medianWallSeconds: 60, heldOut: "1/2", objective: { passed: 1, graded: 2, pending: 0 }, judge: { mean: 3, cases: 2 } },
      { arm: "proposal", ran: 2, green: 2, judged: 2, wins: 2, costUsd: null, costPartial: false, tokens: null, medianWallSeconds: 60, heldOut: "2/2", objective: { passed: 2, graded: 2, pending: 1 }, judge: { mean: 4.5, cases: 2 } },
    ],
    repeated: [],
    analysis: null,
    noise: {
      state: "fresh",
      floor: { version: "abc0000", measuredAt: "2026-11-10T00:00:00Z", runId: "run-floor-9", spread: { objective: 0.1, judge: 0.25 } },
      drift: { added: 0, retired: 0, share: 0 },
      staleShare: 0.2,
      gaps: [],
    },
    noiseFloor: null,
    guardrails: {
      baseline: "base",
      proposal: "proposal",
      goals: [{ goal: "quality", pass: true, conditions: [
        { id: "objective-up", pass: true, reason: "objective rose 50% beyond the floor" },
        { id: "cost-cap", pass: true, reason: "cost unknown | accepted" },
      ] }],
    },
    judgeAccuracy: null,
    problem: null,
  };
}

const proposal = (kind: StoredProposal["kind"], content: unknown): StoredProposal => ({
  v: 1, id: "p1", run: "run-0", goal: "quality", kind, content,
  rationale: "Tighten the scope rule.", answers: [{ knob: "prompt", target: "coder.md", change: "say less" }],
  model: "opus", createdAt: "2026-11-17T00:00:00Z", subset: ["c1"], entry: "e1", full: null, path: "/tmp/p1.json",
});

const state: ProposalState = {
  status: "passed", verdict: null, reason: null, runs: { subset: "run-subset-1", full: "run-full-1" }, promising: true,
};

const MARKER = "<!-- ralph-eval-proposal:p1 -->";

describe("proposalPrBody", () => {
  const overlay = proposal("prompt-overlay", { files: { "coder.md": "x", "prompts/a.md": "y" } });
  const body = proposalPrBody({ proposal: overlay, state, run: fixtureRun(), marker: MARKER });

  it("starts with the marker and has every section in order", () => {
    expect(body.split("\n")[0]).toBe(MARKER);
    const headings = ["## Summary", "## Proven against", "## Scorecard", "## Guardrail verdict", "## Quality vs cost", "## Contested cases", "## The change"];
    const at = headings.map((heading) => body.indexOf(heading));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body.trimEnd().endsWith("a person reviews and merges or closes this PR.")).toBe(true);
  });

  it("names what the change was proven against", () => {
    expect(body).toContain("abc1234");
    expect(body).toContain("judge-a (claude, opus-x)");
    expect(body).toContain("judge-b (codex, gpt-y)");
    expect(body).toContain("measured by run run-floor-9 at 2026-11-10T00:00:00Z");
    expect(body).toContain("run-subset-1");
    expect(body).toContain("run-full-1");
  });

  it("renders the scorecard, verdict, contested cases and the change", () => {
    expect(body).toContain("| base | 1/2 | 3.00 (2 cases) | $1.50 | 1/2 |");
    expect(body).toContain("| proposal | 2/2 +1 pending | 4.50 (2 cases) | unknown | 2/2 |");
    expect(body).toContain("- pass — objective-up: objective rose 50% beyond the floor");
    expect(body).toContain("- pass — cost-cap: cost unknown | accepted");
    expect(body).toContain("- c1 (judges disagree by 2 or more)");
    expect(body).toContain("  - correctness: arms base vs proposal");
    expect(body).not.toContain("case|pipe (");
    expect(body).toContain("- `coder.md`");
    expect(body).toContain("- `prompts/a.md`");
    expect(body).toContain("- prompt / coder.md: say less");
  });

  it("renders a failed condition and a missing verdict or floor", () => {
    const run = fixtureRun();
    run.guardrails!.goals[0] = { goal: "quality", pass: false, conditions: [{ id: "judge-within-floor", pass: false, reason: "judge fell 0.4" }] };
    const failed = proposalPrBody({ proposal: overlay, state, run, marker: MARKER });
    expect(failed).toContain("FAIL: the quality guardrails");
    expect(failed).toContain("- FAIL — judge-within-floor: judge fell 0.4");
    const bare = { ...fixtureRun(), guardrails: null, noise: null, cases: [] };
    const none = proposalPrBody({ proposal: overlay, state, run: bare, marker: MARKER });
    expect(none).toContain("no guardrail verdict");
    expect(none).toContain("no noise floor recorded");
    expect(none).toContain("## Contested cases\n\nnone");
  });

  it("escapes pipes in table cells", () => {
    const run = fixtureRun();
    run.totals[0]!.arm = "ba|se";
    expect(proposalPrBody({ proposal: overlay, state, run, marker: MARKER })).toContain("| ba\\|se |");
  });

  it("lists a lineup's stages", () => {
    const lineup = proposal("lineup", { stages: { coder: { model: "sonnet-z", runner: "claude" } } });
    expect(proposalPrBody({ proposal: lineup, state, run: fixtureRun(), marker: MARKER })).toContain("- coder → sonnet-z (claude)");
  });
});

describe("proposalPrBody for a judge-prompt proposal", () => {
  const tally = (agree: number, total: number) => ({ agree, total, accuracy: total === 0 ? null : agree / total });
  const axes = (scope: number) => ({ correctness: tally(1, 1), scope: tally(scope, 1), tests: tally(0, 1), maintainability: tally(0, 0), review: tally(0, 0) });
  const verdict: StoredPromptVerdict = {
    v: 1, at: "2026-11-19T12:00:00Z", cases: ["c1", "c|2"], pass: true,
    conditions: [
      { id: "accuracy-up", pass: true, reason: "accuracy rose from 1 of 3 to 2 of 3" },
      { id: "scores-alone", pass: true, reason: "the mean score is reported, never a condition" },
    ],
    current: { accuracy: tally(1, 3), axes: axes(0), objectives: {}, meanScore: 3.25, cases: 2, checked: [] },
    proposed: { accuracy: tally(2, 3), axes: axes(1), objectives: {}, meanScore: 3.5, cases: 2, checked: [] },
  };
  const judge = proposal("judge-prompt", { instructions: "Judge with ```care```." });
  const promptState: ProposalState = { status: "passed", verdict: { pass: true, conditions: verdict.conditions }, reason: null, runs: { subset: null, full: null }, promising: null };
  const body = proposalPrBody({ proposal: judge, state: promptState, run: { ...fixtureRun(), id: "run-0" }, verdict, marker: MARKER });

  it("shows the accuracy evidence in place of the scorecard and guardrails", () => {
    expect(body.split("\n")[0]).toBe(MARKER);
    for (const heading of ["## Summary", "## Proven against", "## Accuracy evidence", "## The change"]) expect(body).toContain(heading);
    for (const heading of ["## Scorecard", "## Guardrail verdict", "## Quality vs cost", "## Contested cases"]) expect(body).not.toContain(heading);
    expect(body).toContain("- Source run: run-0");
    expect(body).toContain("Re-judged at 2026-11-19T12:00:00Z on 2 calibrated cases: c1, c|2.");
    expect(body).toContain("| overall | 33% (1 of 3 verdicts) | 67% (2 of 3 verdicts) |");
    expect(body).toContain("| scope | 0% (0 of 1 verdict) | 100% (1 of 1 verdict) |");
    expect(body).toContain("| review | no calibration yet | no calibration yet |");
    expect(body).toContain("Mean score: 3.25 → 3.50");
    expect(body).toContain("raising scores alone never passes");
    expect(body).toContain("- pass — accuracy-up: accuracy rose from 1 of 3 to 2 of 3");
  });

  it("names the file and shows the instructions in a fence they cannot close", () => {
    expect(body).toContain("Replaces `eval-prompts/judge.md` whole with:");
    expect(body).toContain("````markdown\nJudge with ```care```.\n````");
  });

  it("titles it under evals", () => {
    expect(proposalPrTitle(judge)).toBe("evals: judge prompt from proposal p1 (#878)");
    expect(proposalPrTitle(proposal("analyst-prompt", { instructions: "x" }))).toBe("evals: analyst prompt from proposal p1 (#878)");
  });
});

describe("proposalPrTitle and proposalCommitMessage", () => {
  it("titles an overlay under prompts and a lineup under models", () => {
    const title = proposalPrTitle(proposal("prompt-overlay", { files: { "coder.md": "x", "prompt.md": "y" } }));
    expect(title).toBe("prompts: apply eval proposal p1 to coder.md, prompt.md (#803)");
    const lineup = proposalPrTitle(proposal("lineup", { stages: { coder: { model: "m1" }, inspector: { model: "m2" } } }));
    expect(lineup).toBe("models: apply eval proposal p1 lineup: coder → m1, inspector → m2 (#803)");
  });

  it("truncates a long file list under 100 chars", () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`prompts/long-file-name-${i}.md`, "x"]));
    const title = proposalPrTitle(proposal("prompt-overlay", { files }));
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toContain("…");
    expect(title.endsWith("(#803)")).toBe(true);
  });

  it("explains why in the commit body", () => {
    const message = proposalCommitMessage(proposal("prompt-overlay", { files: { "coder.md": "x" } }), fixtureRun());
    const [subject, blank, ...rest] = message.split("\n");
    expect(subject!.startsWith("prompts:")).toBe(true);
    expect(subject!.endsWith("(#803)")).toBe(true);
    expect(blank).toBe("");
    expect(rest.join("\n")).toContain("Tighten the scope rule.");
    expect(rest.join("\n")).toContain("full-set run run-full-1 passed the quality guardrails");
  });
});

describe("qualityCostPoints", () => {
  it("means every panel score and keeps an unknown cost null", () => {
    const plot = qualityCostPoints(fixtureRun())!;
    // A dollar-less arm with no tokens either has no figure, so dollars still hold.
    expect(plot.unit).toBe("usd");
    const [base, prop] = plot.points;
    // base: 3, 4, 2 (c1) and 3 (case|pipe) → 12 / 4.
    expect(base!.quality).toBe(3);
    // proposal: 5, 4, 4, 5 → 18 / 4.
    expect(prop!.quality).toBe(4.5);
    expect(base!.heldOut).toBe(0.5);
    expect(prop!.cost).toBeNull();
    expect(prop!.costLabel).toBe("unknown");
    expect(base!.costLabel).toBe("$1.50");
  });

  it("falls back to tokens when an arm with a figure lacks dollars", () => {
    const run = fixtureRun();
    run.totals[1] = { ...run.totals[1]!, tokens: 250_000 };
    const plot = qualityCostPoints(run)!;
    expect(plot.unit).toBe("tokens");
    expect(plot.points.map((point) => point.cost)).toEqual([100_000, 250_000]);
    expect(plot.points[1]!.costLabel).toBe("250k");
  });

  it("is null for a running run or a single arm", () => {
    expect(qualityCostPoints({ ...fixtureRun(), running: true })).toBeNull();
    const run = fixtureRun();
    expect(qualityCostPoints({ ...run, totals: run.totals.slice(0, 1) })).toBeNull();
  });
});
