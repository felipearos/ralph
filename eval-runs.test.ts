import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestReport, TrialRow } from "./backtest-report";
import { JIRA_TOKEN_ENV } from "./clerk/jira";
import { writeProjectConfig } from "./dashboard/fixtures";
import { clerkStartProblem, completePlan, experimentsRoot, listRuns, prose, readPatch, relayedPatches, runSummary, startRun, stopRun } from "./eval-runs";
import { selectSetCases, sourceLabel, estimate, defaultForm } from "./dashboard/ui/evals-model";
import type { GuardrailVerdict } from "./eval-guardrails";
import type { CalibratedCase } from "./eval-judge-accuracy";
import { floorStatus, measureFloor, NOISE_FLOOR_FILE, noiseReport } from "./eval-noise-floor";
import { selectCases } from "./eval-set-source";
import { parseCase, setView, type CaseStatus, type EvalCase } from "./evals-set";
import { mixedSetReport } from "./fixtures/evals/mixed-set";
import { scratchDir } from "./test-scratch";

const row = (ticket: string, arm: string, extra: Partial<TrialRow> = {}): TrialRow => ({
  ticket, arm, lineup: "live", outcome: "green-pr", detail: "DONE", gates: [{ name: "ci", conclusion: "SUCCESS" }], weakening: [],
  reviewRounds: 1, reviewThreads: 0, wallSeconds: 600, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
  cost: { usd: 2, source: "reported" }, artifacts: `${ticket}/${arm}`, models: [], ...extra,
});

const axes = (n: number) => ({ correctness: { score: n, evidence: "e" }, scope: { score: n, evidence: "e" }, tests: { score: n, evidence: "e" }, maintainability: { score: n, evidence: "e" }, review: { score: null, evidence: "e" } });

function fixtureRun(project: string, name = "eval-abc"): string {
  const dir = join(experimentsRoot(project), name);
  mkdirSync(join(dir, "GH-34", "opus"), { recursive: true });
  writeFileSync(join(dir, "GH-34", "opus", "patch.diff"), "diff --git a/x b/x\n+fix\n");
  const arms = [{ name: "opus", lineup: "live", overlay: null }, { name: "sonnet", lineup: "sonnet-coder", overlay: null }];
  const config = {
    project, clerk: "", sample: { cap: 1, since: null, repos: null }, source: { kind: "pr", repo: "acme/app", prs: [12], ticket: "#34" },
    lineup: null, arms, caps: { trialMinutes: 60, batchMinutes: 360 }, rates: null, sources: {},
    scoring: { testGlobs: [], testCommand: "x {file}", setup: null, review: true, judge: { model: "m", seed: null, panel: [{ name: "opus", runner: "claude", model: "o" }, { name: "gpt", runner: "codex", model: "g" }] } },
  };
  const ticket = {
    oaKey: "GH-34", intakeKey: null, movedAt: "t", repo: "acme/app", humanPrs: [{ number: 12, url: "u", createdAt: "t", mergedAt: "t", headRefName: "b", firstCommit: "f", headRefOid: "h" }],
    mergeBase: "mb", startedAt: "t", ticketRef: "#34", comments: { kept: 0, dropped: 0 }, frozen: { title: "Fix the button", body: "", comments: [] }, reference: "person",
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, id: "eval-20261112", startedAt: "2026-11-12T10:00:00Z", config, sample: { tickets: [ticket], skipped: [], notes: [], arms }, rows: {} }));
  const report: BacktestReport = {
    id: "eval-20261112", startedAt: "2026-11-12T10:00:00Z", finishedAt: "2026-11-12T12:00:00Z", arms, skipped: [], notes: [], stoppedBy: null,
    rows: [row("GH-34", "opus"), row("GH-34", "sonnet", { outcome: "failed", cost: { usd: null, source: "unknown" } }), row("GH-34", "sonnet", { repeat: 1 })],
    scores: [{
      ticket: "GH-34", scoredAt: "t", baseline: [],
      arms: [
        { arm: "a", heads: { first: null, final: null }, heldOut: null, gates: [{ name: "ci", conclusion: "SUCCESS" }], review: null, human: { openToMergeSeconds: 3600, rounds: 2 }, notes: [] },
        { arm: "opus", heads: { first: null, final: null }, heldOut: { status: "ok", files: [{ path: "a.test.ts", baseline: "fail", result: "pass" }] }, gates: null, review: { first: { status: "unavailable", head: null, reason: "x" }, final: { status: "ok", head: "h", counts: { P1: 0, P2: 1, P3: 0 }, findings: [], dir: "d", screenshots: [] } }, human: null, notes: [] },
      ],
      judge: { status: "ok", seed: "s", order: ["a", "opus", "sonnet"], ranking: [["opus"], ["a"], ["sonnet"]], winners: ["opus"], tie: false, reason: "r" },
      panel: {
        seed: "s", order: ["a", "opus", "sonnet"], contested: [{ axis: "scope", arms: ["opus", "sonnet"], judges: ["opus", "gpt"] }],
        verdicts: [
          { judge: { name: "opus", runner: "claude", model: "o" }, status: "ok", ranking: [["opus"]], reason: "Opus is right:\n```ts\nconst secret = clientCode();\n```", arms: { opus: { axes: axes(5), better: "adds a test" }, sonnet: { axes: axes(2), better: "short" } } },
          { judge: { name: "gpt", runner: "codex", model: "g" }, status: "unavailable", reason: "timed out" },
        ],
        aggregate: { status: "ok", seed: "s", order: [], ranking: [], winners: [], tie: false, reason: "" },
      },
    }],
    // Sonnet's repeat, judged on its own (#821): 4 on every scored axis, against the first trial's 2.
    repeatScores: [{
      ticket: "GH-34", scoredAt: "t", baseline: [], repeat: 1, arms: [],
      judge: { status: "ok", seed: "s/r1", order: ["a", "sonnet"], ranking: [["sonnet"], ["a"]], winners: ["sonnet"], tie: false, reason: "r" },
      panel: {
        seed: "s/r1", order: ["a", "sonnet"], contested: [],
        verdicts: [{ judge: { name: "opus", runner: "claude", model: "o" }, status: "ok", ranking: [["sonnet"]], reason: "r", arms: { sonnet: { axes: axes(4), better: "b" } } }],
        aggregate: { status: "ok", seed: "s/r1", order: [], ranking: [], winners: [], tie: false, reason: "" },
      },
    }],
    analysis: { status: "ok", model: "m", summary: "Opus won.", improvements: [{ knob: "lineup", target: "executor", change: "Keep Opus.", arm: "opus", evidence: ["GH-34"] }], dropped: [] },
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  return dir;
}

describe("prose", () => {
  it("drops code blocks and long inline code, and bounds the length", () => {
    expect(prose("Fine.\n```ts\nconst key = 'x';\n```\nDone.")).toBe("Fine. [code] Done.");
    expect(prose("x".repeat(700))).toHaveLength(601);
  });
  it("drops every inline code span, however short", () => {
    expect(prose("Use `const key = 'x'` here.")).toBe("Use [code] here.");
    expect(prose("Call `foo()` then `obj.method`.")).toBe("Call [code] then [code] .");
    expect(prose("Escaped ``a`b`` too.")).toBe("Escaped [code] too.");
  });
  it("drops a span hard-wrapped across lines", () => {
    expect(prose("The fix wraps `const token =\n  readSecret(env)` in a guard, see `x`.")).toBe("The fix wraps [code] in a guard, see [code] .");
  });
  it("drops everything after an unpaired backtick rather than relaying code the pairing missed", () => {
    expect(prose("Don`t call `leakMe(apiKey)` here.")).toBe("Don [code]");
    expect(prose("````a```` then `foo` end")).not.toMatch(/foo|`/);
  });
  it("treats a slash or digits without a file as code, not evidence", () => {
    expect(prose("Ratio `total/count` and `api.internal.acme.com/v1/users` and `items.length/2`.")).toBe("Ratio [code] and [code] and [code] .");
    expect(prose("Id `12345678901`, file `app.ts`.")).toBe("Id [code] , file [code] .");
  });
  it("keeps a path or line span readable as evidence", () => {
    expect(prose("Fails at `src/app.ts:42`.")).toBe("Fails at src/app.ts:42.");
    expect(prose("See `dashboard/ui/App.tsx`.")).toBe("See dashboard/ui/App.tsx.");
    expect(prose("In `app.ts:42` and `./x/y.md` at `src/app.ts:10-20`.")).toBe("In app.ts:42 and ./x/y.md at src/app.ts:10-20.");
    expect(prose("line `42` and `L10-L20`")).toBe("line 42 and L10-L20");
    expect(prose("See src/app.ts:42 for the bug.")).toBe("See src/app.ts:42 for the bug.");
  });
  it("bounds a text full of short code spans", () => {
    const bounded = prose("Use `x` here. ".repeat(100));
    expect(bounded).toHaveLength(601);
    expect(bounded).not.toContain("`");
  });
});

describe("runSummary", () => {
  it("names the spread rule a panel ran under, and lists its one-arm entries (#818)", () => {
    const dir = fixtureRun(scratchDir("eval-runs-"));
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as BacktestReport;
    report.scores![0]!.panel = { ...report.scores![0]!.panel!, rule: { kind: "spread", points: 2 }, contested: [{ axis: "scope", arms: ["opus"], judges: ["opus", "gpt"] }] };
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    const [only] = runSummary(dir)!.cases;
    expect(only).toMatchObject({ contestedRule: "a spread of 2+ points between judge families' mean scores", contested: [{ axis: "scope", arms: ["opus"] }] });
  });

  it("summarises a finished run: cases, each arm's scores and axes, totals, repeats, analysis — no diff", () => {
    const project = scratchDir("eval-runs-");
    const summary = runSummary(fixtureRun(project))!;
    expect(summary).toMatchObject({
      id: "eval-20261112", dir: "eval-abc", kind: "eval", running: false, repeats: 2,
      source: { kind: "pr", repo: "acme/app", prs: [12], ticket: "#34" },
      panel: [{ name: "opus", runner: "claude" }, { name: "gpt", runner: "codex" }],
      repeated: [
        { case: "GH-34", arm: "opus", green: 1, ran: 1, judged: 1, axes: { correctness: { mean: 5, min: 5, max: 5 }, review: null }, first: { outcome: "green-pr", rank: { position: 1, of: 3, tied: false } } },
        // Both of sonnet's runs judged: the mean and spread of 2 and 4, beside its first trial's verdict.
        { case: "GH-34", arm: "sonnet", green: 1, ran: 2, judged: 2, axes: { correctness: { mean: 3, min: 2, max: 4 }, scope: { mean: 3, min: 2, max: 4 }, review: null }, first: { outcome: "failed", rank: { position: 3, of: 3, tied: false } } },
      ],
      analysis: { status: "ok", summary: "Opus won.", improvements: [{ knob: "lineup", change: "Keep Opus." }] },
    });
    const [only] = summary.cases;
    expect(only).toMatchObject({ key: "GH-34", title: "Fix the button", prs: [12], reference: "person", ranking: [["opus"], ["a"], ["sonnet"]], contested: [{ axis: "scope", arms: ["opus", "sonnet"] }] });
    // The fixture's panel carries no rule, as scores.json written before #818 did.
    expect(only!.contestedRule).toBe("ranking inversion between judge families");
    expect(only!.arms.map((arm) => `${arm.arm}:${arm.outcome}`)).toEqual(["a:null", "opus:green-pr", "sonnet:failed"]);
    expect(only!.arms[1]).toMatchObject({ heldOut: "1/1", findings: { P1: 0, P2: 1, P3: 0 }, tokens: 150, axes: [{ judge: "opus", better: "adds a test", scores: { correctness: 5, review: null } }] });
    expect(only!.arms[0]).toMatchObject({ rounds: 2, wallSeconds: 3600, gates: "1/1" });
    expect(only!.judges).toEqual([
      { name: "opus", runner: "claude", status: "ok", reason: "Opus is right: [code]" },
      { name: "gpt", runner: "codex", status: "unavailable", reason: "timed out" },
    ]);
    expect(summary.totals.find((total) => total.arm === "sonnet")).toMatchObject({ ran: 1, green: 0, costUsd: null, costPartial: true, judged: 1, wins: 0 });
    expect(JSON.stringify(summary)).not.toContain("clientCode");
    expect(JSON.stringify(summary)).not.toContain("+fix");
    // A report from before #816: nothing resolved, the config's panel.
    expect(summary.resolved).toBeNull();
  });

  it("takes each arm's resolved models, the seed and the recorded panel from a report that has them (#816)", () => {
    const dir = fixtureRun(scratchDir("eval-runs-"));
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as BacktestReport;
    const opus = { stages: [{ stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: "high" }], overlayHash: null };
    const short = { stages: [{ stage: "coder", runner: "codex", model: "gpt-5.5", effort: null }], overlayHash: "3f2a1b9c0d" };
    writeFileSync(join(dir, "report.json"), JSON.stringify({
      ...report,
      resolved: { arms: { opus, short, broken: "not an arm" }, panel: [{ name: "solo", runner: "claude", model: "claude-sonnet-5-5" }], seed: "s-1" },
    }));
    const summary = runSummary(dir)!;
    expect(summary.resolved).toEqual({ arms: { opus, short }, seed: "s-1" });
    expect(summary.panel).toEqual([{ name: "solo", runner: "claude", model: "claude-sonnet-5-5" }]);

    // A malformed field costs the page that field, not the run.
    writeFileSync(join(dir, "report.json"), JSON.stringify({ ...report, resolved: "garbage" }));
    const tolerant = runSummary(dir)!;
    expect(tolerant.resolved).toBeNull();
    expect(tolerant.panel).toMatchObject([{ name: "opus", runner: "claude" }, { name: "gpt", runner: "codex" }]);
  });
});

/**
 * A project whose roster holds a clerk: the shared fixture config, plus the
 * clerk block a rostered clerk requires (the clerk fixture's own).
 */
function writeClerkProjectConfig(root: string): void {
  writeProjectConfig(root, ["ralph", { name: "clara", role: "clerk" }]);
  const path = join(root, ".ralph", "config.json");
  const { clerk, appLabels } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "clerk", ".ralph", "config.json"), "utf8")) as { clerk: unknown; appLabels: unknown };
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), appLabels, clerk }));
}

/** The clerk fixture's `prRepos`: the app repos its sample draws from. */
const FIXTURE_PR_REPOS = ["example-org/acme-backoffice", "example-org/acme-pwa"];

/** A checkout path for each app repo a clerk's sample draws from. */
const appSources = (): Record<string, string> => Object.fromEntries(FIXTURE_PR_REPOS.map((repo) => [repo, "/srv/" + repo.split("/")[1]]));

describe("listRuns", () => {
  it("lists runs newest first, the lineups an arm can name, the default panel and past trials for the estimate", () => {
    const project = scratchDir("eval-runs-");
    const home = scratchDir("eval-home-");
    fixtureRun(project);
    mkdirSync(join(home, ".ralph", "lineups"), { recursive: true });
    writeFileSync(join(home, ".ralph", "lineups", "sonnet-coder.json"), "{}");
    const view = listRuns(project, home);
    expect(view.version).toBe(1);
    expect(view.runs.map((run) => run.dir)).toEqual(["eval-abc"]);
    expect(view.lineups).toEqual(["sonnet-coder"]);
    expect(view.defaults.panel[0]).toEqual({ name: "opus", runner: "claude", model: "claude-opus-5-5" });
    expect(view.defaults).toMatchObject({ trialMinutes: 90, repeats: 2, noiseFloorArms: 3 });
    expect(view.history).toEqual({ trialSeconds: 600, trialTokens: 150, trials: 3 });
  });
  it("is an empty list for a project that never ran one, and no clerks without a config", () => {
    const view = listRuns(scratchDir("eval-runs-"), scratchDir("eval-home-"));
    expect(view.runs).toEqual([]);
    expect(view.clerks).toEqual([]);
    expect(view.clerkRepos).toEqual([]);
  });
  it("offers the roster's clerks, in roster order, and none when the config does not parse", () => {
    const project = scratchDir("eval-runs-");
    writeClerkProjectConfig(project);
    expect(listRuns(project, scratchDir("eval-home-")).clerks).toEqual(["clara"]);
    // The clerk fixture's prRepos, each needing a checkout from the page.
    expect(listRuns(project, scratchDir("eval-home-")).clerkRepos).toEqual(FIXTURE_PR_REPOS);
    writeFileSync(join(project, ".ralph", "config.json"), "{ not json");
    expect(listRuns(project, scratchDir("eval-home-")).clerks).toEqual([]);
  });
});

describe("startRun", () => {
  it("completes the page's plan from the project, writes it, and launches eval on it detached", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const launched: { command: string; argv: string[]; cwd: string; unit: string }[] = [];
    const started = startRun(project, { source: { kind: "pr", prs: [12], ticket: "#34" }, arms: [{ name: "opus" }, { name: "short", overlay: "/srv/short" }] }, {
      bun: "/usr/bin/bun", launcher: (args) => { launched.push(args); return 4242; },
    });
    const dir = join(experimentsRoot(project), started.id);
    expect(started.dir).toBe(dir);
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(plan).toMatchObject({ project, caps: { trialMinutes: 90, batchMinutes: 90 * 2 * 3 }, sources: { [String((plan.source as { repo: string }).repo)]: project } });
    expect(launched).toEqual([{ command: "/usr/bin/bun", argv: [expect.stringMatching(/experiments\.ts$/), "eval", join(dir, "plan.json"), "--run-dir", dir], cwd: project, log: join(dir, "eval.log"), unit: expect.stringMatching(/^ralph-eval-[0-9a-f]{10}$/) }]);
    expect(readFileSync(join(dir, "eval.pid"), "utf8")).toBe("4242\n");
    // The page lists it at once, from its plan, before its first state.
    expect(runSummary(dir)).toMatchObject({ kind: "eval", cases: [], arms: [{ name: "opus" }, { name: "short", overlay: "/srv/short" }] });
  });

  it("starts a clerk plan with a batch cap that fits every case of its sample", () => {
    const project = scratchDir("eval-start-");
    writeClerkProjectConfig(project);
    const launched: { argv: string[] }[] = [];
    // The clerk fixture names no prRepos, so its sample draws from the default app repos.
    const started = startRun(project, {
      clerk: "clara", sample: { cap: 5, since: "2026-10-01T00:00:00Z" }, arms: [{ name: "opus" }, { name: "sonnet" }],
      repeats: 1, caps: { trialMinutes: 60 }, scoring: { judge: false }, sources: appSources(),
    }, { bun: "/usr/bin/bun", env: { [JIRA_TOKEN_ENV]: "me@example.com:token" }, launcher: (args) => { launched.push(args); return 4343; } });
    const dir = join(experimentsRoot(project), started.id);
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(plan).toMatchObject({ clerk: "clara", sample: { cap: 5 }, caps: { trialMinutes: 60, batchMinutes: 60 * 2 * 5 * (1 + 1) }, sources: { "your-org/your-repo": project } });
    expect(plan).not.toHaveProperty("source");
    expect(launched.map((args) => args.argv[1])).toEqual(["eval"]);
    expect(runSummary(dir)).toMatchObject({ kind: "backtest", source: { kind: "clerk", clerk: "clara" } });
    // With no repeats named, the clerk default is none: one trial per case and arm.
    const { plan: unrepeated } = completePlan(project, { clerk: "clara", sample: { cap: 3 }, arms: [{ name: "opus" }], caps: { trialMinutes: 60 }, scoring: { judge: false } });
    expect(unrepeated.caps).toEqual({ trialMinutes: 60, batchMinutes: 60 * 3 });
    // The project's own worktree setup is not run in a clerk's app clones.
    expect(plan.scoring).not.toHaveProperty("setup");
  });

  it("refuses a clerk plan whose run would die before its first state, saying why, before launching anything", () => {
    const project = scratchDir("eval-start-");
    writeClerkProjectConfig(project);
    const launcher = () => { throw new Error("launched"); };
    const plan = { clerk: "clara", sample: { cap: 3 }, arms: [{ name: "opus" }], scoring: { judge: false } };
    const token = { [JIRA_TOKEN_ENV]: "me@example.com:token" };
    // The page maps only the project's own repo; the clerk's app repos have no checkout.
    expect(() => startRun(project, plan, { launcher, env: token })).toThrow(`tickets land in ${FIXTURE_PR_REPOS.join(", ")}`);
    // A GitHub-tracked clerk project reads the clerk's Jira, with a token the dashboard lacks.
    expect(() => startRun(project, { ...plan, sources: appSources() }, { launcher, env: {} })).toThrow(`the dashboard has no usable ${JIRA_TOKEN_ENV}`);
    expect(() => startRun(project, { ...plan, sources: appSources() }, { launcher, env: { [JIRA_TOKEN_ENV]: "no-colon" } })).toThrow("has no usable");
    // A relayed plan can name a loop that is not a clerk, or a repo the clerk never reads.
    expect(() => startRun(project, { ...plan, clerk: "ralph", sources: appSources() }, { launcher, env: token })).toThrow("ralph is not a clerk on the project's roster");
    expect(() => startRun(project, { ...plan, sample: { cap: 3, repos: ["acme/other"] }, sources: { "acme/other": "/srv/other" } }, { launcher, env: token })).toThrow("sample.repos names acme/other");
    // A PR plan is never the clerk check's business.
    expect(clerkStartProblem(project, completePlan(project, { source: { kind: "pr", prs: [1] }, arms: [{ name: "opus" }] }).config, {})).toBeNull();
  });

  it("refuses a plan that would not run, before launching anything", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const launcher = () => { throw new Error("launched"); };
    expect(() => startRun(project, { source: { kind: "pr", prs: [] }, arms: [{ name: "opus" }] }, { launcher })).toThrow("source.prs must list 1 to 10 PR numbers");
    expect(() => startRun(project, { source: { kind: "pr", prs: [1] }, arms: [{ name: "x", lineup: "no-such-lineup" }] }, { launcher })).toThrow("names lineup no-such-lineup");
    expect(() => completePlan(project, [])).toThrow("eval plan: must be an object");
  });
});

/** A valid case through the real parser, so a fixture can never drift from the stored shape. */
const evalCase = (pr: number, options: { tags?: string[]; status?: CaseStatus } = {}): EvalCase => parseCase({
  v: 1, id: `acme-app-${pr}`, kind: "coder", repo: "acme/app",
  prs: [{ number: pr, url: `https://example.invalid/${pr}`, createdAt: "2026-10-28T01:00:00Z", mergedAt: "2026-10-28T02:00:00Z", headRefName: "fix", firstCommit: "f1", headRefOid: "h1" }],
  baseCommit: `base-commit-${pr}`, startedAt: "2026-10-28T01:00:00Z",
  ticket: { ref: `#${pr - 1}`, title: `Fix thing ${pr}`, body: "SECRET-BODY it is broken", comments: [{ author: "ana", createdAt: "2026-10-27T00:00:00Z", body: "SECRET-COMMENT still broken" }], dropped: 0 },
  reference: "person", heldOut: ["src/secret-held-out.test.ts"], tags: options.tags ?? ["ui"], reason: "SECRET-REASON a clean bugfix", notes: "SECRET-NOTES the fix is in a.ts",
  check: { command: "SECRET-CHECK bun test", base: "fail", reference: "pass", acceptedAt: "2026-11-19T00:00:00Z", acceptedBy: "felipe" }, status: options.status ?? "active", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe",
});

const fixtureSet = () => ({
  version: "abc1234",
  cases: [evalCase(1, { tags: ["ui"] }), evalCase(2, { tags: ["db"] }), evalCase(3, { tags: ["ui"], status: "saturated" }), evalCase(4, { status: "retired" })],
});

describe("a test set's selection, page against harness (#854)", () => {
  // The page mirrors the harness's rule to show the trial count before a start; the two must never disagree.
  it.each([
    ["all", [], []],
    ["tags", ["ui"], []],
    ["tags", ["db", "ui"], []],
    ["subset", [], ["acme-app-2", "acme-app-3", "acme-app-4"]],
  ] as const)("selects the same cases in %s mode (%#)", (setMode, setTags, setCases) => {
    const set = fixtureSet();
    const page = selectSetCases(setView(set, [], false, floorStatus(null, [], 0.2), 3).cases, { setMode, setTags: [...setTags], setCases: [...setCases] }).map((c) => c.id);
    expect(page).toEqual(selectCases(set.cases, { tags: [...setTags], cases: [...setCases] }).map((c) => c.id));
    const form = { ...defaultForm(null), source: "set" as const, setMode, setTags: [...setTags], setCases: [...setCases] };
    expect(estimate(form, null, setView(set, [], false, floorStatus(null, [], 0.2), 3).cases).trials).toBe(page.length * form.arms.length);
  });
});

describe("runSummary of a test set run (#854)", () => {
  it("names the set's version and lists the selected cases it could not run", () => {
    const dir = join(experimentsRoot(scratchDir("eval-runs-")), "eval-set");
    mkdirSync(dir, { recursive: true });
    const arms = [{ name: "opus", lineup: "live", overlay: null }];
    const config = {
      project: "/srv/app", clerk: "", sample: { cap: 1, since: null, repos: null }, source: { kind: "set", tags: ["ui"], cases: [] },
      lineup: null, arms, caps: { trialMinutes: 60, batchMinutes: 360 }, rates: null, sources: {},
      scoring: { testGlobs: [], testCommand: "x {file}", setup: null, review: true, judge: null },
    };
    const skipped = [{ oaKey: "acme-app-2", intakeKey: null, reason: "no checkout of acme/app on this host" }];
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, id: "eval-set", startedAt: "2026-11-19T10:00:00Z", config, sample: { tickets: [], skipped, notes: [], arms, set: { version: "abc1234def", selected: ["acme-app-1", "acme-app-2"] } }, rows: {} }));
    const summary = runSummary(dir)!;
    expect(summary.kind).toBe("eval");
    expect(summary.source).toEqual({ kind: "set", version: "abc1234def", tags: ["ui"], cases: [], unrunnable: [{ id: "acme-app-2", reason: "no checkout of acme/app on this host" }] });
    expect(sourceLabel(summary)).toBe("Test set abc1234");
  });
});

/** Every key anywhere in a JSON value, nested ones included. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

describe("runSummary grades a test set run (#855)", () => {
  function mixedSetRun(): string {
    const dir = join(experimentsRoot(scratchDir("eval-runs-")), "eval-mixed");
    mkdirSync(dir, { recursive: true });
    const report = mixedSetReport();
    const config = {
      project: "/srv/app", clerk: "", sample: { cap: 1, since: null, repos: null }, source: { kind: "set", tags: [], cases: [] },
      lineup: null, arms: report.arms, caps: { trialMinutes: 60, batchMinutes: 360 }, rates: null, sources: {},
      scoring: { testGlobs: [], testCommand: "x {file}", setup: null, review: true, judge: null },
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, id: report.id, startedAt: report.startedAt, config, sample: { tickets: [], skipped: [], notes: [], arms: report.arms, set: report.set }, rows: {} }));
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    return dir;
  }

  it("labels each case's grader and gives each arm its objective result and judge score apart", () => {
    const summary = runSummary(mixedSetRun())!;
    expect(summary.cases.map((entry) => [entry.key, entry.grade])).toEqual([
      ["case-tests", { grader: "tests", noEvidence: false }],
      ["case-no-evidence", { grader: "judge-only", noEvidence: true }],
      ["case-judge-only", { grader: "judge-only", noEvidence: false }],
      ["case-check", { grader: "check", noEvidence: false }],
    ]);
    const arms = (key: string) => summary.cases.find((entry) => entry.key === key)!.arms.map((arm) => [arm.arm, arm.objective, arm.judge]);
    // The reference arm `a` has no grade of its own.
    expect(arms("case-tests")).toEqual([["a", null, null], ["b", "pass", 4.44], ["c", "fail", 2]]);
    expect(arms("case-no-evidence")).toEqual([["a", null, null], ["b", null, 3], ["c", null, 2.5]]);
    expect(arms("case-judge-only")).toEqual([["a", null, null], ["b", null, 4], ["c", null, 1]]);
    expect(arms("case-check")).toEqual([["a", null, null], ["b", "pending", 5], ["c", "pending", 2.5]]);
  });

  it("totals each arm's objective tally and judge mean side by side, never blended", () => {
    const summary = runSummary(mixedSetRun())!;
    expect(summary.totals.map((total) => [total.arm, total.objective, total.judge])).toEqual([
      ["b", { passed: 1, graded: 1, pending: 1 }, { mean: 4.11, cases: 4 }],
      ["c", { passed: 0, graded: 1, pending: 1 }, { mean: 2, cases: 4 }],
    ]);
    expect(keysOf(JSON.parse(JSON.stringify(summary))).filter((key) => /blend|combin|overall|weighted/i.test(key))).toEqual([]);
  });

  it("grades nothing off a set run", () => {
    const summary = runSummary(fixtureRun(scratchDir("eval-runs-")))!;
    expect(summary.cases.map((entry) => entry.grade)).toEqual([null]);
    expect(summary.cases[0]!.arms.map((arm) => [arm.objective, arm.judge])).toEqual([[null, null], [null, null], [null, null]]);
    expect(summary.totals.map((total) => [total.objective, total.judge])).toEqual([[null, null], [null, null]]);
  });

  it("costs the page the grades, never the run, when the report is too malformed to grade", () => {
    const dir = mixedSetRun();
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as BacktestReport;
    (report.scores![0] as unknown as Record<string, unknown>).baseline = "not a list";
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    const summary = runSummary(dir)!;
    expect(summary.cases).toHaveLength(4);
    expect(summary.cases.every((entry) => entry.grade === null)).toBe(true);
    expect(summary.totals.map((total) => [total.objective, total.judge])).toEqual([[null, null], [null, null]]);
  });
});

describe("runSummary carries the noise floor (#859)", () => {
  const measuredAt = "2026-11-19T10:00:00Z";
  function setRun(stamp: (report: BacktestReport) => BacktestReport, noiseFloor?: { measuredAt: string }): string {
    const dir = join(experimentsRoot(scratchDir("eval-runs-")), "eval-noise");
    mkdirSync(dir, { recursive: true });
    const report = stamp(mixedSetReport());
    const config = {
      project: "/srv/app", clerk: "", sample: { cap: 1, since: null, repos: null }, source: { kind: "set", tags: [], cases: [] },
      lineup: null, arms: report.arms, caps: { trialMinutes: 60, batchMinutes: 360 }, rates: null, sources: {},
      scoring: { testGlobs: [], testCommand: "x {file}", setup: null, review: true, judge: null }, ...(noiseFloor ? { noiseFloor } : {}),
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, id: report.id, startedAt: report.startedAt, config, sample: { tickets: [], skipped: [], notes: [], arms: report.arms, set: report.set }, rows: {} }));
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    return dir;
  }

  it("passes a stamped run's gaps against the floor through, and is no floor run", () => {
    const stamped = (report: BacktestReport) => ({ ...report, noise: noiseReport(report, floorStatus(null, [], 0.2))! });
    const summary = runSummary(setRun(stamped))!;
    expect(summary.noise).toMatchObject({ state: "missing", floor: null, gaps: [{ arm: "c", vs: "b", objective: { verdict: "no-floor" } }] });
    expect(summary.noiseFloor).toBeNull();
  });

  it("has no noise on a run the floor never stamped", () => {
    const summary = runSummary(setRun((report) => report))!;
    expect(summary.noise).toBeNull();
    expect(summary.noiseFloor).toBeNull();
  });

  it("carries a stamped run's guardrail verdict, and none on a run it never stamped (#871)", () => {
    const guardrails: GuardrailVerdict = {
      baseline: "b", proposal: "c",
      goals: [
        { goal: "quality", pass: false, conditions: [{ id: "objective-up", pass: false, reason: "no floor" }] },
        { goal: "cost", pass: true, conditions: [{ id: "tokens-down", pass: true, reason: "tokens fell 20%" }] },
      ],
    };
    expect(runSummary(setRun((report) => ({ ...report, guardrails })))!.guardrails).toEqual(guardrails);
    expect(runSummary(setRun((report) => report))!.guardrails).toBeNull();
  });

  it("calls a floor run's floor stored, with its spread, once noise-floor.json is beside the report", () => {
    const dir = setRun((report) => ({ ...report, noiseFloor: { measuredAt } }), { measuredAt });
    const floor = measureFloor({ ...mixedSetReport(), noiseFloor: { measuredAt } }, measuredAt)!;
    writeFileSync(join(dir, NOISE_FLOOR_FILE), JSON.stringify(floor));
    expect(runSummary(dir)!.noiseFloor).toEqual({ measuredAt, stored: true, spread: floor.spread });
  });

  it("calls a floor run's floor unstored when noise-floor.json is missing or malformed", () => {
    const dir = setRun((report) => ({ ...report, noiseFloor: { measuredAt } }), { measuredAt });
    expect(runSummary(dir)!.noiseFloor).toEqual({ measuredAt, stored: false, spread: null });
    writeFileSync(join(dir, NOISE_FLOOR_FILE), "{ not json");
    expect(runSummary(dir)!.noiseFloor).toEqual({ measuredAt, stored: false, spread: null });
  });

  it("knows a starting floor run from its config before any report", () => {
    const dir = setRun((report) => report, { measuredAt });
    rmSync(join(dir, "report.json"));
    expect(runSummary(dir)!.noiseFloor).toEqual({ measuredAt, stored: false, spread: null });
  });
});

describe("completePlan on a set plan", () => {
  it("leaves the set source without a repo and caps the batch at the cases it selects", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const { plan, config } = completePlan(project, { source: { kind: "set" }, arms: [{ name: "opus" }, { name: "sonnet" }], caps: { trialMinutes: 60 } }, { readSet: fixtureSet });
    // The set's version is pinned into the plan, so the run directory follows the set.
    expect(plan.source).toEqual({ kind: "set", version: "abc1234" });
    expect(config.source).toEqual({ kind: "set", tags: [], cases: [], version: "abc1234" });
    // Three runnable cases (the retired one never runs), two repeats by default.
    expect(plan.caps).toEqual({ trialMinutes: 60, batchMinutes: 60 * 2 * 3 * (1 + 2) });
    // A tag filter shrinks the selection, and with it the cap.
    const { plan: tagged } = completePlan(project, { source: { kind: "set", tags: ["db"] }, arms: [{ name: "opus" }], caps: { trialMinutes: 60 } }, { readSet: fixtureSet });
    expect(tagged.caps).toEqual({ trialMinutes: 60, batchMinutes: 60 * 1 * 1 * 3 });
  });

  it("starts a fresh run once the set has changed, rather than resuming the old run's sample", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const plan = { source: { kind: "set" }, arms: [{ name: "opus" }] };
    const launcher = () => 4242;
    const before = startRun(project, plan, { launcher, bun: "/usr/bin/bun", readSet: fixtureSet });
    const after = startRun(project, plan, { launcher, bun: "/usr/bin/bun", readSet: () => ({ ...fixtureSet(), version: "def5678" }) });
    expect(after.dir).not.toBe(before.dir);
  });

  it("refuses a plan that selects no case before anything launches", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const launcher = () => { throw new Error("launched"); };
    expect(() => startRun(project, { source: { kind: "set", cases: ["acme-app-4"] }, arms: [{ name: "opus" }] }, { launcher, readSet: fixtureSet }))
      .toThrow("eval plan: the test set selects no case for this plan");
  });

  it("runs a noise floor over the whole set with no repeats by default (#859)", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const arms = [{ name: "live-1" }, { name: "live-2" }, { name: "live-3" }];
    const noiseFloor = { measuredAt: "2026-11-19T10:00:00Z" };
    const { plan, config } = completePlan(project, { source: { kind: "set", tags: [] }, arms, noiseFloor, caps: { trialMinutes: 60 } }, { readSet: fixtureSet });
    expect(plan.repeats).toBe(0);
    expect(plan.source).toEqual({ kind: "set", tags: [], version: "abc1234" });
    // Three runnable cases on three arms, and no repeat on top.
    expect(plan.caps).toEqual({ trialMinutes: 60, batchMinutes: 60 * 3 * 3 });
    expect(config.noiseFloor).toEqual(noiseFloor);
    expect(config.repeats).toBe(0);
    // A repeat count the plan names is the parser's to judge, not overwritten.
    expect(() => completePlan(project, { source: { kind: "set" }, arms, noiseFloor, repeats: 1 }, { readSet: fixtureSet })).toThrow(/runs no repeats/);
    for (const source of [{ kind: "set", tags: ["db"] }, { kind: "set", cases: ["acme-app-1"] }]) {
      expect(() => completePlan(project, { source, arms, noiseFloor }, { readSet: fixtureSet })).toThrow("eval plan: a noise floor runs the whole test set");
    }
  });

  it("refuses the start when the set cannot be read", () => {
    const project = scratchDir("eval-start-");
    writeProjectConfig(project);
    const readSet = () => { throw new Error("evals: the set is unreadable"); };
    expect(() => completePlan(project, { source: { kind: "set" }, arms: [{ name: "opus" }] }, { readSet })).toThrow("evals: the set is unreadable");
    const launcher = () => { throw new Error("launched"); };
    expect(() => startRun(project, { source: { kind: "set" }, arms: [{ name: "opus" }] }, { launcher, readSet })).toThrow("evals: the set is unreadable");
  });
});

describe("stopRun and readPatch", () => {
  it("says a run that is not running is not, and reads a trial's patch by its segments only", () => {
    const project = scratchDir("eval-runs-");
    fixtureRun(project);
    expect(stopRun(project, "eval-abc")).toEqual({ stopped: false, why: "the run is not running" });
    expect(readPatch(project, "eval-abc", "GH-34", "opus")).toBe("diff --git a/x b/x\n+fix\n");
    expect(readPatch(project, "eval-abc", "GH-34", "sonnet")).toBeNull();
    expect(() => readPatch(project, "../etc", "GH-34", "opus")).toThrow("is not a path segment");
    expect(() => stopRun(project, "../x")).toThrow("is not a run");
  });
});

/** The fixture project config with `relayEvalPatches` set, or left out. */
function relayConfig(project: string, relay: boolean | undefined): void {
  writeProjectConfig(project);
  const path = join(project, ".ralph", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (relay !== undefined) config.relayEvalPatches = relay;
  writeFileSync(path, JSON.stringify(config));
}

/** A second, older run beside the fixture's, its patch under `GH-7/opus`. */
function olderRun(project: string, patch: string): void {
  const dir = fixtureRun(project, "eval-old");
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, startedAt: "2026-11-01T10:00:00Z" }));
  rmSync(join(dir, "GH-34"), { recursive: true });
  mkdirSync(join(dir, "GH-7", "opus"), { recursive: true });
  writeFileSync(join(dir, "GH-7", "opus", "partial.patch"), patch);
}

describe("listRuns tallies a set run's judge accuracy (#877)", () => {
  const verdict = (id: string, preferred: string): CalibratedCase => ({
    id, calibration: [{ arms: ["b", "c"], axis: "correctness", preferred, reason: "r", by: "op", at: "2026-11-19T10:00:00Z" }],
  });
  function setProject(): string {
    const project = scratchDir("eval-runs-");
    const dir = join(experimentsRoot(project), "eval-set");
    mkdirSync(dir, { recursive: true });
    const report = mixedSetReport();
    const config = {
      project, clerk: "", sample: { cap: 1, since: null, repos: null }, source: { kind: "set", tags: [], cases: [] },
      lineup: null, arms: report.arms, caps: { trialMinutes: 60, batchMinutes: 360 }, rates: null, sources: {},
      scoring: { testGlobs: [], testCommand: "x {file}", setup: null, review: true, judge: null },
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, id: report.id, startedAt: report.startedAt, config, sample: { tickets: [], skipped: [], notes: [], arms: report.arms, set: report.set }, rows: {} }));
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    return project;
  }
  const accuracyOf = (project: string, readCalibration: (project: string) => CalibratedCase[] | null) =>
    listRuns(project, scratchDir("eval-home-"), { readCalibration }).runs.map((run) => [run.dir, run.judgeAccuracy]);

  it("tallies the panel against the set's verdicts, without the per-verdict checks", () => {
    const project = setProject();
    // The panel prefers b on both: the first verdict agrees, the second does not.
    const read = (asked: string) => (asked === project ? [verdict("case-tests", "b"), verdict("case-judge-only", "c")] : null);
    const [[, accuracy]] = accuracyOf(project, read) as [[string, Record<string, unknown> | null]];
    expect(accuracy).toMatchObject({ overall: { agree: 1, total: 2, accuracy: 0.5 }, contested: 0 });
    expect(accuracy).not.toHaveProperty("checks");
  });

  it("is a total of zero with no verdicts, and null when the set cannot be read", () => {
    const project = setProject();
    expect((accuracyOf(project, () => [{ id: "case-tests" }])[0]![1] as { overall: unknown }).overall).toEqual({ agree: 0, total: 0, accuracy: null });
    expect(accuracyOf(project, () => null)).toEqual([["eval-set", null]]);
    expect(accuracyOf(project, () => { throw new Error("git log failed"); })).toEqual([["eval-set", null]]);
  });

  it("is null on a noise-floor run, whose report carries none either", () => {
    const project = setProject();
    const path = join(experimentsRoot(project), "eval-set", "report.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), noiseFloor: { measuredAt: "2026-11-19T10:00:00Z" } }));
    expect(accuracyOf(project, () => [verdict("case-tests", "b")])).toEqual([["eval-set", null]]);
  });

  it("is null off a set run, and runSummary never fills it", () => {
    const project = scratchDir("eval-runs-");
    fixtureRun(project);
    expect(accuracyOf(project, () => [verdict("GH-34", "opus")])).toEqual([["eval-abc", null]]);
    expect(runSummary(join(experimentsRoot(setProject()), "eval-set"))!.judgeAccuracy).toBeNull();
  });
});

describe("relayed patches (#825)", () => {
  it("listRuns carries the project's flag, off when absent or unreadable", () => {
    const project = scratchDir("eval-relay-");
    expect(listRuns(project, scratchDir("eval-home-")).relayPatches).toBe(false);
    relayConfig(project, undefined);
    expect(listRuns(project, scratchDir("eval-home-")).relayPatches).toBe(false);
    relayConfig(project, false);
    expect(listRuns(project, scratchDir("eval-home-")).relayPatches).toBe(false);
    relayConfig(project, true);
    expect(listRuns(project, scratchDir("eval-home-")).relayPatches).toBe(true);
  });

  it("relays nothing while the flag is off, patch files or not", () => {
    const project = scratchDir("eval-relay-");
    fixtureRun(project);
    relayConfig(project, false);
    expect(relayedPatches(project)).toEqual({ version: 1, enabled: false, patches: [], omitted: 0 });
    relayConfig(project, undefined);
    expect(relayedPatches(project)).toEqual({ version: 1, enabled: false, patches: [], omitted: 0 });
  });

  it("relays every trial's patch named as the page reads it, newest run first, the partial one when unfinished", () => {
    const project = scratchDir("eval-relay-");
    fixtureRun(project);
    olderRun(project, "diff --git a/y b/y\n+half\n");
    relayConfig(project, true);
    const relayed = relayedPatches(project);
    expect(relayed).toEqual({
      version: 1, enabled: true, omitted: 0,
      patches: [
        { run: "eval-abc", case: "GH-34", arm: "opus", text: "diff --git a/x b/x\n+fix\n", truncated: false },
        { run: "eval-old", case: "GH-7", arm: "opus", text: "diff --git a/y b/y\n+half\n", truncated: false },
      ],
    });
    for (const patch of relayed.patches) {
      expect(readPatch(project, patch.run, patch.case, patch.arm)).toBe(patch.text);
    }
  });

  it("leaves out repeat trials, which the page never links", () => {
    const project = scratchDir("eval-relay-");
    const dir = fixtureRun(project);
    mkdirSync(join(dir, "GH-34", "opus-r1"), { recursive: true });
    writeFileSync(join(dir, "GH-34", "opus-r1", "patch.diff"), "diff --git a/r b/r\n+repeat\n");
    relayConfig(project, true);
    expect(relayedPatches(project).patches.map((patch) => patch.arm)).toEqual(["opus"]);
  });

  it("cuts a patch over the per-patch budget at a line boundary", () => {
    const project = scratchDir("eval-relay-");
    const dir = fixtureRun(project);
    writeFileSync(join(dir, "GH-34", "opus", "patch.diff"), "line one\nline two\nline three\n");
    relayConfig(project, true);
    expect(relayedPatches(project, { perPatch: 15 }).patches[0]).toMatchObject({ text: "line one\n", truncated: true });
    expect(relayedPatches(project, { perPatch: 29 }).patches[0]).toMatchObject({ text: "line one\nline two\nline three\n", truncated: false });
  });

  it("cuts a first line longer than the per-patch budget hard, rather than relaying nothing", () => {
    const project = scratchDir("eval-relay-");
    const dir = fixtureRun(project);
    writeFileSync(join(dir, "GH-34", "opus", "patch.diff"), "a-very-long-first-line\nsecond\n");
    relayConfig(project, true);
    expect(relayedPatches(project, { perPatch: 6 }).patches[0]).toMatchObject({ text: "a-very", truncated: true });
  });

  it("leaves out and counts the trials past the total budget, keeping the newest", () => {
    const project = scratchDir("eval-relay-");
    fixtureRun(project);
    olderRun(project, "diff --git a/y b/y\n+half\n");
    relayConfig(project, true);
    const relayed = relayedPatches(project, { total: 30 });
    expect(relayed.patches.map((patch) => `${patch.run}/${patch.case}/${patch.arm}`)).toEqual(["eval-abc/GH-34/opus"]);
    expect(relayed.omitted).toBe(1);
  });
});
