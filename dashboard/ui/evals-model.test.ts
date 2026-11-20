import { describe, expect, it } from "vitest";

import type { EvalArmTotalView, EvalCaseArmView, EvalCaseView, EvalNoiseStatusView, EvalRunView, EvalSetRowView, EvalSetView } from "../contracts";
import { proposalLabel, proposalOpensPr, proposalStatus, proposalVerdictSummary, suggestionConfirm, suggestionLine, accuracyAxisLines, judgeAccuracyHeadline, accuracyLabel, contestedExcludedLabel, armGapLabel, calibrationBody, calibrationCaseId, calibrationCountLabel, calibrationDefaults, calibrationVerdictLabel, goalVerdictLabel, guardrailConditionLabel, defaultNoiseFloorArms, floorRunLabel, gapLabel, noiseFloorForm, noiseFloorPlan, noiseStatusLabel, missingLine, suggestionAddForm, suggestionLabel, SUGGESTION_REASON_MAX, armLabel, armResolutionFor, caseHasGrade, graderLabel, judgeScoreLabel, judgeTotalLabel, objectiveLabel, objectiveTotalLabel, runHasGrades, buildCaseAdd, buildCaseCheck, buildCaseEdit, buildPlan, caseEditForm, caseLabel, defaultCaseRepo, lastRunLabel, saturationNote, parseTags, setVersionLabel, contestedFor, defaultForm, estimate, inboxCost, restoreForm, selectSetCases, setTagsOffered, firstTrialLabel, parsePrs, spreadLabel, modelsLabel, patchOpens, qualityCostPlot, rankingLabel, runConfigLabel, runStatus, sourceLabel, type RunForm } from "./evals-model";

const form = (over: Partial<RunForm> = {}): RunForm => ({ ...defaultForm(null), prs: "2731", ...over });

describe("parsePrs", () => {
  it("reads numbers with or without #, separated by commas or spaces, once each", () => {
    expect(parsePrs("2731, #2740 2731")).toEqual([2731, 2740]);
    expect(parsePrs("")).toBeNull();
    expect(parsePrs("2731, abc")).toBeNull();
    expect(parsePrs("0")).toBeNull();
  });
});

describe("buildPlan", () => {
  it("sends a PR source, the arms, the repeats, the trial cap and the panel", () => {
    expect(buildPlan(form({
      ticket: "OA-12",
      arms: [{ name: "live", lineup: "live", overlay: "" }, { name: "short", lineup: "live", overlay: " /srv/overlays/short " }],
      judges: [{ name: "", runner: "claude", model: "claude-opus-5-5" }, { name: "gpt", runner: "codex", model: "gpt-6-luna" }],
    }))).toEqual({
      ok: true,
      plan: {
        source: { kind: "pr", prs: [2731], ticket: "OA-12" },
        arms: [{ name: "live", lineup: "live" }, { name: "short", lineup: "live", overlay: "/srv/overlays/short" }],
        repeats: 2,
        caps: { trialMinutes: 90 },
        scoring: { judge: { panel: [{ runner: "claude", model: "claude-opus-5-5" }, { runner: "codex", model: "gpt-6-luna", name: "gpt" }] } },
      },
    });
  });

  it.each([
    [{ prs: "" }, "Name the merged PR numbers"],
    [{ ticket: "oa-12" }, "The ticket is #<number>"],
    [{ arms: [] }, "Add at least one arm"],
    [{ arms: [{ name: "a", lineup: "live", overlay: "" }] }, "not \"a\""],
    [{ arms: [{ name: "x", lineup: "live", overlay: "" }, { name: "x", lineup: "live", overlay: "" }] }, "Two arms are named x"],
    [{ arms: [{ name: "x", lineup: "live", overlay: "rel/dir" }] }, "absolute path"],
    [{ judges: [] }, "Add at least one judge"],
    [{ judges: [{ name: "", runner: "claude" as const, model: "m" }, { name: "", runner: "codex" as const, model: "m" }] }, "Two judges are named m"],
    [{ repo: "app" }, "owner/name"],
  ])("says what is wrong before sending: %#", (over, why) => {
    const built = buildPlan(form(over));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.why).toContain(why);
  });

  const shared = {
    arms: [{ name: "live", lineup: "live" }, { name: "candidate", lineup: "live" }],
    repeats: 2,
    caps: { trialMinutes: 90 },
    scoring: { judge: { panel: [{ runner: "claude", model: "claude-opus-5-5", name: "opus" }] } },
  };

  it("sends a clerk plan with no source key, its since as the day's UTC start (#827)", () => {
    expect(buildPlan(form({ source: "clerk", clerk: "clara", cap: 20, since: "2026-10-01", prs: "" }))).toEqual({
      ok: true,
      plan: { clerk: "clara", sample: { cap: 20, since: "2026-10-01T00:00:00Z" }, ...shared },
    });
    expect(buildPlan(form({ source: "clerk", clerk: "clara", prs: "nonsense", ticket: "bad", repo: "bad" }))).toEqual({
      ok: true,
      plan: { clerk: "clara", sample: { cap: 10 }, ...shared },
    });
  });

  it("sends the PR plan unchanged when clerk fields are set (#827)", () => {
    expect(buildPlan(form({ clerk: "clara", cap: 3, since: "2026-10-01" }))).toEqual({
      ok: true,
      plan: { source: { kind: "pr", prs: [2731] }, ...shared },
    });
  });

  it("sends a clerk plan's checkout of each app repo as sources, trimmed (#827)", () => {
    const checkouts = { "acme/app": " /srv/app ", "acme/web": "/srv/web", "acme/other": "/srv/other" };
    expect(buildPlan(form({ source: "clerk", clerk: "clara", checkouts }), ["acme/app", "acme/web"])).toEqual({
      ok: true,
      plan: { clerk: "clara", sample: { cap: 10 }, sources: { "acme/app": "/srv/app", "acme/web": "/srv/web" }, ...shared },
    });
    const none = buildPlan(form({ source: "clerk", clerk: "clara", checkouts }), []);
    expect(none.ok && "sources" in none.plan).toBe(false);
  });

  it.each([
    [{}, "acme/app"],
    [{ "acme/app": "/srv/app", "acme/web": "  " }, "acme/web"],
    [{ "acme/app": "srv/app", "acme/web": "/srv/web" }, "acme/app"],
  ])("refuses a clerk plan missing an absolute checkout, naming the repo: %#", (checkouts, repo) => {
    const built = buildPlan(form({ source: "clerk", clerk: "clara", checkouts }), ["acme/app", "acme/web"]);
    expect(built).toEqual({ ok: false, why: `Name an absolute path to a checkout of ${repo} on the machine.` });
  });

  it("sends the PR plan without sources whatever the checkouts (#827)", () => {
    expect(buildPlan(form({ checkouts: { "acme/app": "/srv/app" } }), ["acme/app"])).toEqual({
      ok: true,
      plan: { source: { kind: "pr", prs: [2731] }, ...shared },
    });
  });

  it.each([
    [{ clerk: "" }, "Choose the clerk"],
    [{ cap: 0 }, "from 1 to 50"],
    [{ cap: 51 }, "from 1 to 50"],
    [{ cap: 2.5 }, "from 1 to 50"],
    [{ since: "10/01/2026" }, "YYYY-MM-DD"],
    [{ since: "2026-02-30" }, "YYYY-MM-DD"],
    [{ arms: [] }, "Add at least one arm"],
    [{ judges: [] }, "Add at least one judge"],
  ])("refuses a clerk plan it cannot send: %#", (over, why) => {
    const built = buildPlan(form({ source: "clerk", clerk: "clara", ...over }));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.why).toContain(why);
  });
});

describe("defaultForm", () => {
  it("opens on PRs with the first clerk chosen, a cap of 10 and no since (#827)", () => {
    const view = { clerks: ["clara", "clerk-2"], lineups: [], defaults: { panel: [], repeats: 2, trialMinutes: 90 } } as unknown as Parameters<typeof defaultForm>[0];
    expect(defaultForm(view)).toMatchObject({ source: "pr", clerk: "clara", cap: 10, since: "" });
    expect(defaultForm(null)).toMatchObject({ source: "pr", clerk: "" });
  });
});

describe("inboxCost", () => {
  it("multiplies the median trial by the entry's trials, and says why when it cannot", () => {
    const history = { trialSeconds: 1200, trialTokens: 250_000, trials: 9 };
    expect(inboxCost(6, history)).toBe("up to 6 trials: about 1.5M tokens, about 2h 0m, from this project's median trial");
    expect(inboxCost(1, { ...history, trialTokens: null })).toBe("up to 1 trial: about 20m, from this project's median trial");
    expect(inboxCost(4, null)).toBe("up to 4 trials; no run yet to estimate usage from");
    expect(inboxCost(4, { trialSeconds: null, trialTokens: null, trials: 0 })).toBe("up to 4 trials; no run yet to estimate usage from");
    expect(inboxCost(null, history)).toBe("trials picked from the test set at start");
  });
});

describe("estimate", () => {
  it("counts a trial per arm and the repeats' worst case, timed from history when there is some", () => {
    const two = form();
    expect(estimate(two, null)).toMatchObject({ trials: 2, worst: 6 });
    expect(estimate(two, null).text).toContain("up to 3.0 h (9.0 h with repeats) at the 90-minute cap");
    const timed = estimate(two, { trialSeconds: 1200, trialTokens: 250_000, trials: 9 }).text;
    expect(timed).toContain("about 0.7 h (2.0 h with repeats), from this project's median trial; about 500k tokens");
    expect(timed).toContain("Then 1 judge call and one analyst call.");
    expect(estimate(two, null).text.startsWith("2 trials, up to 6 if the arms disagree: ")).toBe(true);
  });

  it("counts a clerk's tickets times the arms as a ceiling, and a judge call per ticket (#827)", () => {
    const clerk = form({ source: "clerk", clerk: "clara", cap: 10 });
    expect(estimate(clerk, null)).toMatchObject({ trials: 20, worst: 60 });
    const text = estimate(clerk, { trialSeconds: 1200, trialTokens: 250_000, trials: 9 }).text;
    expect(text).toContain("up to 20 trials (10 tickets × 2 arms), up to 60 if the arms disagree: about 6.7 h (20 h with repeats)");
    expect(text).toContain("about 5,000k tokens");
    expect(text).toContain("Then 10 judge calls and one analyst call.");
  });
});

const entry = (over: Partial<EvalCaseView> = {}): EvalCaseView => ({
  key: "GH-34", title: "Fix it", repo: "acme/app", prs: [12], reference: "person", arms: [], judges: [],
  ranking: [["opus"], ["a", "sonnet"]], contested: [{ axis: "scope", arms: ["opus", "sonnet"] }],
  contestedRule: "ranking inversion between judge families", grade: null, ...over,
});

describe("armResolutionFor", () => {
  it("finds an arm's record by own key only (#816)", () => {
    const record = { stages: [], overlayHash: "3f2a1b9c00" };
    expect(armResolutionFor({ resolved: { arms: { opus: record }, seed: null } }, "opus")).toBe(record);
    expect(armResolutionFor({ resolved: { arms: {}, seed: null } }, "constructor")).toBeUndefined();
    expect(armResolutionFor({ resolved: null }, "opus")).toBeUndefined();
  });
});

describe("labels", () => {
  it("names the reference by whose work it was, and the ranking best first", () => {
    expect(armLabel("a", entry())).toBe("reference (person)");
    expect(armLabel("a", entry({ reference: "loop" }))).toBe("reference (loop)");
    expect(armLabel("opus", entry())).toBe("opus");
    expect(rankingLabel(entry())).toBe("opus > reference (person) = sonnet");
    expect(rankingLabel(entry({ ranking: null }))).toBeNull();
    expect(contestedFor(entry(), "sonnet", "scope")).toBe(true);
    expect(contestedFor(entry(), "a", "scope")).toBe(false);
  });

  it("labels a repeated arm's axis as mean and range, and its first trial's verdict (#821)", () => {
    expect(spreadLabel({ mean: 11 / 3, min: 3, max: 4 })).toBe("3.7 (3–4)");
    expect(spreadLabel({ mean: 4, min: 4, max: 4 })).toBe("4");
    expect(spreadLabel(null)).toBe("—");
    // A snapshot pushed by a host from before #821 carries no axes.
    expect(spreadLabel(undefined)).toBe("—");
    expect(firstTrialLabel({ first: { outcome: "green-pr", rank: { position: 1, of: 3, tied: true } } })).toBe("green-pr, tied 1st of 3");
    expect(firstTrialLabel({ first: { outcome: "failed", rank: { position: 2, of: 2, tied: false } } })).toBe("failed, 2nd of 2");
    expect(firstTrialLabel({ first: { outcome: null, rank: null } })).toBe("—, not judged");
    expect(firstTrialLabel({} as never)).toBe("—, not judged");
  });

  it("says where a run is", () => {
    const run = { running: false, cases: [{}], problem: null, finishedAt: "t", stoppedBy: null, source: { kind: "pr", repo: "acme/app", prs: [12, 13], ticket: null } } as unknown as EvalRunView;
    expect(runStatus(run)).toEqual({ label: "Finished", tone: "ok" });
    expect(runStatus({ ...run, running: true, cases: [] })).toEqual({ label: "Starting", tone: "live" });
    expect(runStatus({ ...run, finishedAt: null })).toEqual({ label: "Stopped, resumable", tone: "warn" });
    expect(runStatus({ ...run, stoppedBy: "batch-cap" })).toEqual({ label: "Hit the batch cap", tone: "warn" });
    expect(sourceLabel(run)).toBe("acme/app #12, #13");
  });

  it("labels an arm's resolved models and the run's panel and seed (#816)", () => {
    expect(modelsLabel({
      stages: [
        { stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: "high" },
        { stage: "executor", runner: "codex", model: "gpt-5.5", effort: null },
      ],
      overlayHash: "3f2a1b9c0d4e5f60",
    })).toBe("coder claude-opus-5-5 (high) · executor codex gpt-5.5 · overlay 3f2a1b9c");
    expect(modelsLabel({ stages: [], overlayHash: null })).toBeNull();
    expect(modelsLabel(undefined)).toBeNull();

    const panel = [{ name: "opus", runner: "claude", model: "claude-opus-5-5" }, { name: "gpt", runner: "codex", model: "gpt-5.5" }];
    expect(runConfigLabel({ panel, resolved: { arms: {}, seed: "s-1" } })).toBe("Panel opus (claude-opus-5-5), gpt (codex gpt-5.5) · seed s-1");
    expect(runConfigLabel({ panel, resolved: null })).toBe("Panel opus (claude-opus-5-5), gpt (codex gpt-5.5)");
    expect(runConfigLabel({ panel: [], resolved: { arms: {}, seed: null } })).toBeNull();
    expect(runConfigLabel({ panel: [], resolved: null })).toBeNull();
  });
});

describe("qualityCostPlot", () => {
  const total = (arm: string, over: Partial<EvalArmTotalView> = {}): EvalArmTotalView => ({
    arm, ran: 1, green: 1, judged: 1, wins: 0, costUsd: null, costPartial: false, tokens: null, medianWallSeconds: null, heldOut: null, objective: null, judge: null, ...over,
  });
  const scores = (correctness: number | null, scope: number | null) => ({ correctness, scope, tests: null, maintainability: null, review: null });
  const caseArm = (arm: string, axes: EvalCaseArmView["axes"]): EvalCaseArmView => ({
    arm, outcome: null, gates: null, heldOut: null, findings: null, rounds: null, wallSeconds: null, tokens: null, costUsd: null, axes, objective: null, judge: null,
  });
  // A plot needs something on the quality axis, so a run scores arm `a` once unless a test names its cases.
  const scoredOnce = (): EvalCaseView[] => [entry({ arms: [caseArm("a", [{ judge: "opus", scores: scores(4, null), better: "" }])] })];
  const run = (totals: EvalArmTotalView[], cases: EvalCaseView[] = scoredOnce(), over: Partial<EvalRunView> = {}): EvalRunView =>
    ({ running: false, totals, cases, ...over }) as unknown as EvalRunView;

  it("draws only a finished run with two or more arms", () => {
    expect(qualityCostPlot(run([total("a"), total("opus")], [], { running: true }))).toBeNull();
    expect(qualityCostPlot(run([total("a")]))).toBeNull();
  });

  it("plots dollars when every arm with a figure has them, keeping a partial cost's ≥", () => {
    const plot = qualityCostPlot(run([total("a", { costUsd: 1.5, costPartial: true, tokens: 10_000 }), total("opus", { costUsd: 3 })]));
    expect(plot).toMatchObject({ unit: "usd", xMax: 3, anyUnknownCost: false });
    expect(plot?.points.map((point) => [point.arm, point.cost, point.costPartial, point.costLabel])).toEqual([
      ["a", 1.5, true, "≥ $1.50"],
      ["opus", 3, false, "$3.00"],
    ]);
  });

  it("falls back to tokens when an arm has tokens but no dollars", () => {
    const plot = qualityCostPlot(run([total("a", { costUsd: 1.5, costPartial: true, tokens: 200_000 }), total("opus", { tokens: 1_500_000 })]));
    expect(plot).toMatchObject({ unit: "tokens", xMax: 1_500_000, anyUnknownCost: false });
    expect(plot?.points.map((point) => [point.cost, point.costPartial, point.costLabel])).toEqual([[200_000, false, "200k"], [1_500_000, false, "1.5M"]]);
  });

  it("keeps an arm with no cost unknown, never at zero", () => {
    const plot = qualityCostPlot(run([total("a", { costUsd: 2 }), total("opus")]));
    expect(plot).toMatchObject({ unit: "usd", xMax: 2, anyUnknownCost: true });
    expect(plot?.points[1]).toMatchObject({ cost: null, costLabel: "unknown" });
    expect(plot?.points[1]?.cost).not.toBe(0);
    expect(qualityCostPlot(run([total("a"), total("opus")]))).toMatchObject({ unit: "tokens", xMax: 1, anyKnownCost: false, anyUnknownCost: true });
  });

  it("skips a run whose arms no judge scored and no held-out test checked", () => {
    expect(qualityCostPlot(run([total("a", { costUsd: 1 }), total("opus", { costUsd: 2 })], []))).toBeNull();
  });

  it("averages every judge's non-null scores across cases, and reads held-out as a rate", () => {
    const cases = [
      entry({ arms: [caseArm("a", [{ judge: "opus", scores: scores(5, null), better: "" }, { judge: "gpt", scores: scores(3, 4), better: "" }]), caseArm("opus", [])] }),
      entry({ key: "GH-35", arms: [caseArm("a", [{ judge: "opus", scores: scores(null, 4), better: "" }])] }),
    ];
    const plot = qualityCostPlot(run([total("a", { heldOut: "3/4" }), total("opus", { heldOut: "0/0" })], cases));
    expect(plot?.points[0]).toMatchObject({ quality: 4, y: 0.75, heldOut: 0.75, heldOutY: 0.75, heldOutLabel: "3/4" });
    expect(plot?.points[1]).toMatchObject({ quality: null, y: null, heldOut: null, heldOutY: null, heldOutLabel: "0/0" });
  });
});

describe("patchOpens", () => {
  it("opens locally always and remotely only for a project that relays its patches", () => {
    expect(patchOpens(false, false)).toBe(true);
    expect(patchOpens(false, true)).toBe(true);
    expect(patchOpens(true, true)).toBe(true);
    expect(patchOpens(true, false)).toBe(false);
  });
});

const row = (over: Partial<EvalSetRowView> = {}): EvalSetRowView => ({
  id: "acme-app-12",
  repo: "acme/app",
  prs: [12],
  title: "Fix the thing",
  tags: ["ui"],
  graders: ["gates"],
  status: "active",
  addedAt: "2026-11-18T10:00:00Z",
  addedBy: "rafa",
  lastRun: null,
  saturation: null,
  calibrations: 0,
  ...over,
});

describe("parseTags", () => {
  it("splits on commas, trims, drops empties and repeats", () => {
    expect(parseTags(" ui, flaky ,, ui ,")).toEqual(["ui", "flaky"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("two words")).toEqual(["two words"]);
  });
});

describe("defaultCaseRepo", () => {
  it("is the first case's repo, else empty", () => {
    expect(defaultCaseRepo({ cases: [row({ repo: "acme/web" }), row()] })).toBe("acme/web");
    expect(defaultCaseRepo({ cases: [] })).toBe("");
    expect(defaultCaseRepo(null)).toBe("");
  });
});

describe("buildCaseAdd", () => {
  const add = { repo: " acme/app ", prs: "12, #13", reason: " hard one ", tags: "ui, ui", notes: "" };

  it("sends the repo, the PRs, the reason and the tags; notes only when given", () => {
    expect(buildCaseAdd(add)).toEqual({ ok: true, body: { repo: "acme/app", prs: [12, 13], reason: "hard one", tags: ["ui"] } });
    expect(buildCaseAdd({ ...add, tags: "", notes: " see logs " })).toEqual({ ok: true, body: { repo: "acme/app", prs: [12, 13], reason: "hard one", notes: "see logs" } });
  });

  it.each([
    [{ repo: "acme" }, "The repository is owner/name."],
    [{ repo: "" }, "The repository is owner/name."],
    [{ prs: "" }, "Name the merged PR numbers, e.g. 2731 or 2731, 2740."],
    [{ prs: "12, x" }, "Name the merged PR numbers, e.g. 2731 or 2731, 2740."],
    [{ reason: "  " }, "Say why this case belongs in the set."],
  ])("refuses %j", (over, why) => {
    expect(buildCaseAdd({ ...add, ...over })).toEqual({ ok: false, why });
  });
});

describe("caseEditForm", () => {
  it("opens on the tags as comma text and the notes, blank when unknown", () => {
    expect(caseEditForm({ tags: ["ui", "flaky"], notes: "n" })).toEqual({ tags: "ui, flaky", notes: "n" });
    expect(caseEditForm({ tags: [] })).toEqual({ tags: "", notes: "" });
  });
});

describe("buildCaseEdit", () => {
  const current = { id: "acme-app-12", tags: ["ui"], notes: "old" };

  it("sends only the fields that changed", () => {
    expect(buildCaseEdit(current, { tags: "ui, flaky", notes: "old" }, true)).toEqual({ ok: true, body: { case: "acme-app-12", tags: ["ui", "flaky"] } });
    expect(buildCaseEdit(current, { tags: "ui", notes: " new " }, true)).toEqual({ ok: true, body: { case: "acme-app-12", notes: "new" } });
    expect(buildCaseEdit(current, { tags: "", notes: "" }, true)).toEqual({ ok: true, body: { case: "acme-app-12", tags: [], notes: "" } });
  });

  it("is nothing changed when the form is as it opened", () => {
    expect(buildCaseEdit(current, { tags: " ui ,", notes: "old " }, true)).toEqual({ ok: false, why: "nothing changed" });
  });

  it("leaves unknown notes alone unless the operator typed some", () => {
    const remote = { id: "acme-app-12", tags: ["ui"] };
    expect(buildCaseEdit(remote, { tags: "ui", notes: "" }, false)).toEqual({ ok: false, why: "nothing changed" });
    expect(buildCaseEdit(remote, { tags: "flaky", notes: " " }, false)).toEqual({ ok: true, body: { case: "acme-app-12", tags: ["flaky"] } });
    expect(buildCaseEdit(remote, { tags: "ui", notes: "typed" }, false)).toEqual({ ok: true, body: { case: "acme-app-12", notes: "typed" } });
  });
});

describe("buildCaseCheck", () => {
  it("sends a test path or a command, trimmed", () => {
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: " src/feature.test.ts " })).toEqual({ ok: true, body: { case: "acme-app-12", test: "src/feature.test.ts" } });
    expect(buildCaseCheck("acme-app-12", { kind: "command", value: " bun test src/feature.test.ts\n" })).toEqual({ ok: true, body: { case: "acme-app-12", command: "bun test src/feature.test.ts" } });
  });

  it("refuses an empty value", () => {
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: "  " })).toEqual({ ok: false, why: "Name a test file." });
    expect(buildCaseCheck("acme-app-12", { kind: "command", value: "" })).toEqual({ ok: false, why: "Name a command." });
  });

  it("refuses a test path that is absolute or climbs with ..", () => {
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: "/etc/passwd" }).ok).toBe(false);
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: "src/../../x.test.ts" }).ok).toBe(false);
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: "..\\x.test.ts" }).ok).toBe(false);
    // A dotted name is not a .. segment, and a command may say whatever it runs.
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: "src/a..b.test.ts" }).ok).toBe(true);
    expect(buildCaseCheck("acme-app-12", { kind: "command", value: "cd .. && bun test" }).ok).toBe(true);
  });

  it("refuses a value starting with --", () => {
    expect(buildCaseCheck("acme-app-12", { kind: "test", value: " --help" })).toEqual({ ok: false, why: "The test path may not start with --." });
    expect(buildCaseCheck("acme-app-12", { kind: "command", value: "--version" })).toEqual({ ok: false, why: "The command may not start with --." });
  });
});

describe("caseLabel", () => {
  it("is the repo and its PRs", () => {
    expect(caseLabel(row({ prs: [12, 13] }))).toBe("acme/app#12, #13");
    expect(caseLabel(row())).toBe("acme/app#12");
  });
});

describe("lastRunLabel", () => {
  it("is the run and its day, or never", () => {
    expect(lastRunLabel(row())).toBe("never");
    expect(lastRunLabel(row({ lastRun: { run: "2026-11-18-ab", startedAt: "2026-11-18T22:10:00Z" } }))).toBe("2026-11-18-ab · 2026-11-18");
  });
});

describe("saturationNote", () => {
  it("explains a saturated case with its window", () => {
    expect(saturationNote(row({ saturation: { saturated: true, passes: 3, window: 3 } }))).toBe(
      "Saturated: every arm passed it in its last 3 set runs, so it no longer tells arms apart. Retire it, or keep it to clear this until 3 more runs.",
    );
  });

  it("is null when the case is not saturated, has no saturation read, or is retired", () => {
    expect(saturationNote(row({ saturation: { saturated: false, passes: 2, window: 3 } }))).toBeNull();
    expect(saturationNote(row({ saturation: null }))).toBeNull();
    expect(saturationNote(row({ status: "retired", saturation: { saturated: true, passes: 3, window: 3 } }))).toBeNull();
  });

  it("is null, not a throw, on a row from a snapshot older than #860 that has no saturation field", () => {
    const { saturation: _dropped, ...old } = row({ saturation: null });
    expect(saturationNote(old)).toBeNull();
  });
});

describe("setVersionLabel", () => {
  it("is the short sha, or that nothing is committed", () => {
    expect(setVersionLabel({ version: "0123456789abcdef" })).toBe("Set version 0123456");
    expect(setVersionLabel({ version: null })).toBe("No case committed yet");
  });
});

describe("the test set source (#854)", () => {
  const entry = (id: string, tags: string[], status: EvalSetRowView["status"] = "active"): EvalSetRowView =>
    ({ id, title: `Case ${id}`, tags, status, repo: "acme/app", prs: [1], graders: ["gates"], addedAt: "2026-11-01T00:00:00Z", addedBy: "felipe", lastRun: null, saturation: null, calibrations: 0 });
  const cases = [entry("c1", ["ui"]), entry("c2", ["db"], "saturated"), entry("c3", ["ui", "db"], "retired"), entry("c4", ["api"])];
  const setView = (over: Partial<EvalSetView> = {}): EvalSetView => ({ version: "abcdef0123", details: false, cases, noiseFloor: { state: "missing", floor: null, drift: null, staleShare: 0.2 }, calibrationSuggestions: [], problem: null, ...over });
  const setForm = (over: Partial<RunForm> = {}): RunForm => form({ source: "set", prs: "", ...over });
  const ids = (over: Partial<RunForm>) => selectSetCases(cases, setForm(over)).map((c) => c.id);
  const sharedOf = (built: ReturnType<typeof buildPlan>) => {
    if (!built.ok) throw new Error(built.why);
    const { source: _source, ...rest } = built.plan;
    return rest;
  };

  it("selects every case but a retired one in mode all, ignoring leftover tags and picks; a saturated case still runs", () => {
    expect(ids({ setMode: "all", setTags: ["api"], setCases: ["c4"] })).toEqual(["c1", "c2", "c4"]);
  });

  it("passes a case on any of its tags in mode tags, never a retired one", () => {
    expect(ids({ setMode: "tags", setTags: ["db", "api"], setCases: ["c1"] })).toEqual(["c2", "c4"]);
    expect(ids({ setMode: "tags", setTags: [] })).toEqual([]);
  });

  it("keeps only offered, non-retired ids in mode subset", () => {
    expect(ids({ setMode: "subset", setCases: ["c3", "c4", "gone", "c2"], setTags: ["ui"] })).toEqual(["c2", "c4"]);
  });

  it("offers the tags of non-retired cases only", () => {
    expect(setTagsOffered([entry("x", ["z"], "retired"), entry("y", ["b", "a"]), entry("w", ["a"], "saturated")])).toEqual(["a", "b"]);
  });

  it("sends a set plan with only the mode's own list", () => {
    const all = buildPlan(setForm({ setMode: "all", setTags: ["ui"], setCases: ["c1"] }), [], setView());
    expect(all).toMatchObject({ ok: true, plan: { source: { kind: "set" } } });
    if (all.ok) expect(all.plan.source).toEqual({ kind: "set" });
    expect(buildPlan(setForm({ setMode: "tags", setTags: ["ui"] }), [], setView())).toMatchObject({ ok: true, plan: { source: { kind: "set", tags: ["ui"] } } });
    const subset = buildPlan(setForm({ setMode: "subset", setCases: ["c4", "c3", "gone"] }), [], setView());
    if (subset.ok) expect(subset.plan.source).toEqual({ kind: "set", cases: ["c4"] });
    else throw new Error(subset.why);
    expect(Object.keys(subset.plan)).not.toContain("clerk");
    expect(sharedOf(subset)).toEqual(sharedOf(buildPlan(form(), [])));
  });

  it.each([
    [{}, null, "has not loaded"],
    [{}, { problem: "bad yaml" }, "bad yaml"],
    [{ setMode: "tags" as const, setTags: [] }, {}, "at least one tag"],
    [{ setMode: "subset" as const, setCases: [] }, {}, "at least one case"],
    [{ setMode: "subset" as const, setCases: ["c3", "gone"] }, {}, "no case to run"],
    [{ setMode: "all" as const }, { cases: [entry("r", [], "retired")] }, "no case to run"],
    [{ arms: [] }, {}, "Add at least one arm"],
  ])("refuses a set plan it cannot send: %#", (over, view, why) => {
    const built = buildPlan(setForm(over), [], view === null ? null : setView(view));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.why).toContain(why);
  });

  it("estimates exactly the selected cases times the arms", () => {
    const tags = setForm({ setMode: "tags", setTags: ["ui", "api"] });
    expect(estimate(tags, null, cases)).toMatchObject({ trials: 4, worst: 12 });
    expect(estimate(tags, null, cases).text.startsWith("4 trials (2 cases × 2 arms), up to 12 if the arms disagree: ")).toBe(true);
    const all = estimate(setForm(), { trialSeconds: 1200, trialTokens: 250_000, trials: 9 }, cases);
    expect(all.trials).toBe(selectSetCases(cases, setForm()).length * 2);
    expect(all.text).toContain("6 trials (3 cases × 2 arms)");
    expect(all.text).toContain("about 1,500k tokens");
  });
});

describe("restoreForm", () => {
  const fallback = defaultForm(null);

  it("keeps the fallback for garbage", () => {
    for (const stored of [null, undefined, 3, "x", [], [fallback]]) expect(restoreForm(stored, fallback)).toEqual(fallback);
  });

  it("merges a partial stored form over the fallback", () => {
    expect(restoreForm({ source: "set", setMode: "subset", setCases: ["c1"], prs: "12" }, fallback)).toEqual({ ...fallback, source: "set", setMode: "subset", setCases: ["c1"], prs: "12" });
  });

  it("keeps the fallback's field where the stored one has the wrong type", () => {
    const stored = {
      source: "jira",
      setMode: "some",
      setTags: ["ui", 3],
      setCases: "c1",
      cap: "10",
      repeats: Number.NaN,
      checkouts: { "acme/app": 3 },
      arms: [{ name: "live", lineup: "live" }],
      judges: [{ name: "", runner: "gemini", model: "x" }],
      trialMinutes: 45,
    };
    expect(restoreForm(stored, fallback)).toEqual({ ...fallback, trialMinutes: 45 });
    expect(restoreForm({ arms: [] }, fallback).arms).toEqual(fallback.arms);
  });
});

describe("a test set run's two scores (#855)", () => {
  it("labels the objective tally: passed of graded, the pending checks, a dash with neither", () => {
    expect(objectiveTotalLabel({ passed: 1, graded: 1, pending: 1 })).toBe("1/1 · 1 check pending");
    expect(objectiveTotalLabel({ passed: 0, graded: 2, pending: 0 })).toBe("0/2");
    expect(objectiveTotalLabel({ passed: 0, graded: 0, pending: 2 })).toBe("2 checks pending");
    expect(objectiveTotalLabel({ passed: 0, graded: 0, pending: 0 })).toBe("—");
    expect(objectiveTotalLabel(null)).toBe("—");
    expect(objectiveTotalLabel(undefined)).toBe("—");
  });
  it("labels the judge mean over its cases, a dash with none", () => {
    expect(judgeTotalLabel({ mean: 4.11, cases: 4 })).toBe("4.11 over 4 cases");
    expect(judgeTotalLabel({ mean: 2, cases: 1 })).toBe("2.00 over 1 case");
    expect(judgeTotalLabel({ mean: null, cases: 0 })).toBe("—");
    expect(judgeTotalLabel(null)).toBe("—");
  });
  it("labels the grader, saying when a judge-only case's tests prove nothing", () => {
    expect(graderLabel({ grader: "tests", noEvidence: false })).toBe("tests");
    expect(graderLabel({ grader: "check", noEvidence: false })).toBe("check");
    expect(graderLabel({ grader: "judge-only", noEvidence: false })).toBe("judge-only");
    expect(graderLabel({ grader: "judge-only", noEvidence: true })).toBe("judge-only · no evidence");
    expect(graderLabel({ grader: "check", noEvidence: true })).toBe("check · no evidence");
    expect(graderLabel(null)).toBeNull();
  });
  it("labels one arm's two values apart, a dash where absent", () => {
    expect([objectiveLabel("pass"), objectiveLabel("pending"), objectiveLabel(null), objectiveLabel(undefined)]).toEqual(["pass", "pending", "—", "—"]);
    expect([judgeScoreLabel(4.44), judgeScoreLabel(null), judgeScoreLabel(undefined)]).toEqual(["4.44", "—", "—"]);
  });
  it("adds the columns only when a total or the case carries a grade, a pre-#855 snapshot included", () => {
    const total = { objective: null, judge: null } as unknown as EvalArmTotalView;
    expect(runHasGrades({ totals: [total] })).toBe(false);
    expect(runHasGrades({ totals: [{ ...total, judge: { mean: null, cases: 0 } }] })).toBe(true);
    expect(runHasGrades({ totals: [{} as EvalArmTotalView] })).toBe(false);
    expect(caseHasGrade({ grade: { grader: "tests", noEvidence: false } })).toBe(true);
    expect(caseHasGrade({ grade: null })).toBe(false);
    expect(caseHasGrade({} as Pick<EvalCaseView, "grade">)).toBe(false);
  });
});

describe("suggestionAddForm", () => {
  it("prefills the repo, the PR and a reason drafted from the reasons' texts", () => {
    expect(suggestionAddForm({
      repo: "acme/app",
      pr: 2731,
      reasons: [{ signal: "blocked", text: " Blocked twice before merge " }, { signal: "empty", text: "" }, { signal: "reverted", text: "Reverted once" }],
    })).toEqual({ repo: "acme/app", prs: "2731", reason: "Blocked twice before merge; Reverted once" });
  });

  it("trims a long draft to the cap with an ellipsis, and drafts nothing from no reasons", () => {
    const long = suggestionAddForm({ repo: "acme/app", pr: 1, reasons: [{ signal: "parked", text: "x".repeat(500) }] });
    expect(long.reason).toHaveLength(SUGGESTION_REASON_MAX);
    expect(long.reason?.endsWith("…")).toBe(true);
    expect(suggestionAddForm({ repo: "acme/app", pr: 1, reasons: [] }).reason).toBe("");
  });
});

describe("missingLine", () => {
  it("names each unread source and why, or nothing when all were read", () => {
    expect(missingLine([])).toBeNull();
    expect(missingLine([{ source: "tracker", why: "gh rate limited" }, { source: "journal", why: "no journal branch" }]))
      .toBe("Not read: tracker — gh rate limited; journal — no journal branch");
  });
});

describe("suggestionLabel", () => {
  it("is the repository and the PR", () => {
    expect(suggestionLabel({ repo: "acme/app", pr: 2731 })).toBe("acme/app#2731");
  });
});

describe("the noise floor (#859)", () => {
  const entry = (id: string, status: EvalSetRowView["status"] = "active"): EvalSetRowView =>
    ({ id, title: `Case ${id}`, tags: [], status, repo: "acme/app", prs: [1], graders: ["gates"], addedAt: "2026-11-01T00:00:00Z", addedBy: "felipe", lastRun: null, saturation: null, calibrations: 0 });
  const missing: EvalNoiseStatusView = { state: "missing", floor: null, drift: null, staleShare: 0.2 };
  const setView = (over: Partial<EvalSetView> = {}): EvalSetView =>
    ({ version: "abcdef0123", details: false, cases: [entry("c1"), entry("c2", "saturated"), entry("c3", "retired")], noiseFloor: missing, calibrationSuggestions: [], problem: null, ...over });
  const floor = { version: "0123456789abcdef", measuredAt: "2026-11-18T09:30:00Z", runId: "r1", spread: { objective: 0.25, judge: 0.1 } };

  it("plans the whole set over N identical live arms, no repeats, stamped with when it is measured", () => {
    expect(noiseFloorPlan(null, setView(), 3, "2026-11-19T10:00:00Z")).toEqual({
      ok: true,
      plan: {
        source: { kind: "set" },
        arms: [{ name: "live-1", lineup: "live" }, { name: "live-2", lineup: "live" }, { name: "live-3", lineup: "live" }],
        repeats: 0,
        caps: { trialMinutes: 90 },
        scoring: { judge: { panel: [{ runner: "claude", model: "claude-opus-5-5", name: "opus" }] } },
        noiseFloor: { measuredAt: "2026-11-19T10:00:00Z" },
      },
    });
  });

  it("refuses an arm count outside 2..6 and a set with no runnable case", () => {
    for (const n of [1, 7, 2.5, Number.NaN]) {
      const built = noiseFloorPlan(null, setView(), n, "2026-11-19T10:00:00Z");
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.why).toContain("2 to 6 identical arms");
    }
    expect(noiseFloorPlan(null, setView({ cases: [entry("c3", "retired")] }), 3, "2026-11-19T10:00:00Z").ok).toBe(false);
    expect(noiseFloorPlan(null, null, 3, "2026-11-19T10:00:00Z").ok).toBe(false);
  });

  it("estimates the whole set times N arms with no repeats, and opens on the project's arm count", () => {
    const cost = estimate(noiseFloorForm(null, 4), null, setView().cases);
    expect(cost.trials).toBe(8);
    expect(cost.worst).toBe(8);
    expect(cost.text).toContain("8 trials (2 cases × 4 arms)");
    expect(defaultNoiseFloorArms(null)).toBe(3);
    expect(defaultNoiseFloorArms({ defaults: { panel: [], trialMinutes: 90, repeats: 2, noiseFloorArms: 5 } })).toBe(5);
  });

  it("says whether the floor is fresh, stale or missing", () => {
    expect(noiseStatusLabel({ state: "fresh", floor, drift: { added: 0, retired: 0, share: 0 }, staleShare: 0.2 }))
      .toBe("Measured 2026-11-18 on 0123456: objective ±0.25, judge ±0.10");
    expect(noiseStatusLabel({ state: "stale", floor, drift: { added: 2, retired: 1, share: 0.3 }, staleShare: 0.2 }))
      .toBe("Stale: 2 added, 1 retired since it was measured (30% of its cases, over 20%)");
    expect(noiseStatusLabel(missing)).toBe("Not measured yet: gaps between arms are not judged");
    expect(noiseStatusLabel({ state: "stale", floor, drift: { added: 0, retired: 3, share: 0.3 }, staleShare: 0.2 }, true))
      .toBe("Stale for this run: it ran 0 case(s) the floor never measured and left out 3 it did (30% of its cases, over 20%)");
    // A snapshot from a host before #859 carries no status.
    expect(noiseStatusLabel(undefined)).toBe("Not measured yet: gaps between arms are not judged");
  });

  it("labels each axis's gap, never beyond against a stale or missing floor", () => {
    expect(gapLabel({ gap: 0.25, verdict: "beyond" })).toBe("+0.25 beyond");
    expect(gapLabel({ gap: -0.1, verdict: "within" })).toBe("-0.10 within");
    expect(gapLabel({ gap: 0.4, verdict: "stale" })).toBe("+0.40 (floor stale)");
    expect(gapLabel({ gap: 0.4, verdict: "no-floor" })).toBe("+0.40 (no floor)");
    expect(gapLabel({ gap: null, verdict: null })).toBe("—");
    expect(armGapLabel({ arm: "candidate", vs: "live", objective: { gap: 0.25, verdict: "beyond" }, judge: { gap: -0.1, verdict: "within" } }))
      .toBe("candidate vs live: objective +0.25 beyond · judge -0.10 within");
  });

  it("labels a guardrail goal and each condition with its reason (#871)", () => {
    expect(goalVerdictLabel({ goal: "quality", pass: true, conditions: [] })).toBe("Quality goal: pass");
    expect(goalVerdictLabel({ goal: "cost", pass: false, conditions: [] })).toBe("Cost goal: fail");
    expect(guardrailConditionLabel({ id: "objective-up", pass: false, reason: "noise floor stale — remeasure the noise floor" }))
      .toBe("fail · objective-up: noise floor stale — remeasure the noise floor");
    expect(guardrailConditionLabel({ id: "no-regressions", pass: true, reason: "no case the baseline passes is lost" }))
      .toBe("pass · no-regressions: no case the baseline passes is lost");
  });

  it("labels judge accuracy: none counted says so, else a share of the verdicts (#877)", () => {
    expect(accuracyLabel({ agree: 0, total: 0, accuracy: null })).toBe("no calibration yet");
    expect(accuracyLabel({ agree: 3, total: 4, accuracy: 0.75 })).toBe("75% (3 of 4 verdicts)");
    expect(accuracyLabel({ agree: 1, total: 1, accuracy: 1 })).toBe("100% (1 of 1 verdict)");
    expect(accuracyLabel({ agree: 0, total: 1, accuracy: 0 })).toBe("0% (0 of 1 verdict)");
    const none = { agree: 0, total: 0, accuracy: null };
    const accuracy = {
      overall: { agree: 3, total: 4, accuracy: 0.75 },
      axes: { correctness: { agree: 2, total: 3, accuracy: 0.67 }, scope: none, tests: { agree: 1, total: 1, accuracy: 1 }, maintainability: none, review: none },
      contested: 0,
    };
    expect(accuracyAxisLines(accuracy)).toEqual(["correctness: 67% (2 of 3 verdicts)", "tests: 100% (1 of 1 verdict)"]);
    expect(judgeAccuracyHeadline(accuracy)).toBe("75% (3 of 4 verdicts)");
    expect(judgeAccuracyHeadline({ ...accuracy, overall: none })).toBe("no calibration yet");
    expect(judgeAccuracyHeadline({ ...accuracy, overall: none, contested: 2 })).toBe("no verdict counted");
    expect(contestedExcludedLabel(0)).toBeNull();
    expect(contestedExcludedLabel(1)).toBe("1 verdict on contested axes excluded");
    expect(contestedExcludedLabel(2)).toBe("2 verdicts on contested axes excluded");
  });

  it("says what a floor run stored: its spread, still running, or stopped short", () => {
    expect(floorRunLabel({ measuredAt: "2026-11-19T10:00:00Z", stored: true, spread: { objective: 0.25, judge: null } }, false)).toBe("objective ±0.25, judge —");
    expect(floorRunLabel({ measuredAt: "2026-11-19T10:00:00Z", stored: false, spread: null }, true)).toBe("running");
    expect(floorRunLabel({ measuredAt: "2026-11-19T10:00:00Z", stored: false, spread: null }, false)).toBe("no floor stored: the run stopped before the end or was not scored (a rescore of a finished run stores it)");
  });
});

describe("calibration (#876)", () => {
  const setRun = { source: { kind: "set", version: null, tags: [], cases: [], unrunnable: [] } } as Pick<EvalRunView, "source">;
  const prRun = { source: { kind: "pr", repo: "acme/app", prs: [12, 13], ticket: null } } as Pick<EvalRunView, "source">;
  const caseArm = (arm: string) => ({ arm }) as EvalCaseArmView;

  it("uses a set run's case key directly", () => {
    expect(calibrationCaseId(setRun, entry({ key: "acme-app-12" }), [])).toBe("acme-app-12");
  });

  it("matches any other run's case by repo, case-insensitive, and its PRs in any order", () => {
    const rows = [row({ id: "other", prs: [12] }), row({ id: "acme-app-12-13", repo: "Acme/App", prs: [13, 12] })];
    expect(calibrationCaseId(prRun, entry({ repo: "acme/app", prs: [12, 13] }), rows)).toBe("acme-app-12-13");
  });

  it("has no case id when the set holds no such case", () => {
    expect(calibrationCaseId(prRun, entry({ repo: "acme/app", prs: [12, 14] }), [row({ prs: [12] })])).toBeNull();
    expect(calibrationCaseId(prRun, entry({ repo: "acme/web", prs: [12] }), [row({ prs: [12] })])).toBeNull();
  });

  it("opens on the first contested pair, else the first axis and the first two arms", () => {
    const arms = [caseArm("a"), caseArm("opus"), caseArm("sonnet")];
    expect(calibrationDefaults(entry({ arms }))).toEqual({ axis: "scope", armA: "opus", armB: "sonnet", preferred: "opus", reason: "" });
    expect(calibrationDefaults(entry({ arms, contested: [] }))).toEqual({ axis: "correctness", armA: "a", armB: "opus", preferred: "a", reason: "" });
    // Under the spread rule a contested entry names one arm: the form still opens on its axis.
    expect(calibrationDefaults(entry({ arms, contested: [{ axis: "tests", arms: ["sonnet"] }] }))).toEqual({ axis: "tests", armA: "sonnet", armB: "a", preferred: "sonnet", reason: "" });
  });

  it("sends the case, the pair, the axis, the preferred arm and the trimmed reason", () => {
    expect(calibrationBody("acme-app-12", { axis: "scope", armA: "opus", armB: "sonnet", preferred: "sonnet", reason: " smaller diff " })).toEqual({
      ok: true,
      body: { case: "acme-app-12", arms: ["opus", "sonnet"], axis: "scope", preferred: "sonnet", reason: "smaller diff" },
    });
  });

  it.each([
    [{ reason: "  " }, "Say why"],
    [{ armB: "opus" }, "two different arms"],
    [{ preferred: "a" }, "which of the two"],
  ])("refuses an incomplete form %o", (over, why) => {
    const built = calibrationBody("acme-app-12", { axis: "scope", armA: "opus", armB: "sonnet", preferred: "opus", reason: "why", ...over });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.why).toContain(why);
  });

  it("labels a count and a verdict, the preferred arm first", () => {
    expect(calibrationCountLabel(0)).toBeNull();
    expect(calibrationCountLabel(1)).toBe("1 verdict");
    expect(calibrationCountLabel(2)).toBe("2 verdicts");
    expect(calibrationVerdictLabel({ arms: ["opus", "sonnet"], preferred: "sonnet" })).toBe("sonnet over opus");
  });
});

describe("proposalOpensPr", () => {
  it("offers Open PR on a passed proposal only (#875)", () => {
    expect(proposalOpensPr({ status: "passed", kind: "prompt-overlay" })).toBe(true);
    for (const status of ["proposed", "subset-run", "full-run", "failed", "suggested", "confirmed"] as const) {
      expect(proposalOpensPr({ status, kind: "prompt-overlay" })).toBe(false);
    }
  });

  it("offers it on a passed lineup or prompt, never on a test-set kind (#878)", () => {
    for (const kind of ["lineup", "judge-prompt", "analyst-prompt"] as const) expect(proposalOpensPr({ status: "passed", kind })).toBe(true);
    for (const kind of ["case", "check", "retire-suggestion"] as const) {
      for (const status of ["passed", "suggested", "confirmed"] as const) expect(proposalOpensPr({ status, kind })).toBe(false);
    }
  });
});

describe("proposalStatus", () => {
  it("labels each step shortly and colours only the outcomes", () => {
    expect(proposalStatus("proposed")).toEqual({ label: "Subset run waiting in the Inbox", tone: "neutral" });
    expect(proposalStatus("subset-run")).toEqual({ label: "Subset run", tone: "neutral" });
    expect(proposalStatus("full-run")).toEqual({ label: "Full-set run", tone: "neutral" });
    expect(proposalStatus("passed")).toEqual({ label: "Passed", tone: "good" });
    expect(proposalStatus("failed")).toEqual({ label: "Failed", tone: "bad" });
    expect(proposalStatus("suggested")).toEqual({ label: "Suggested — confirm on Test set", tone: "neutral" });
    expect(proposalStatus("confirmed")).toEqual({ label: "Confirmed in the set", tone: "good" });
  });

  it("says a fresh judge or analyst prompt awaits its re-judge, not a subset run (#878)", () => {
    expect(proposalStatus("proposed", "judge-prompt").label).toBe("Awaiting its re-judge");
    expect(proposalStatus("proposed", "analyst-prompt").label).toBe("Awaiting its re-judge");
    expect(proposalStatus("proposed", "lineup").label).toBe("Subset run waiting in the Inbox");
    expect(proposalStatus("passed", "judge-prompt")).toEqual({ label: "Passed", tone: "good" });
  });
});

describe("proposalLabel", () => {
  it("names the goal and the kind", () => {
    expect(proposalLabel({ goal: "quality", kind: "prompt-overlay" })).toBe("Quality · Prompt overlay");
    expect(proposalLabel({ goal: "cost", kind: "lineup" })).toBe("Cost · Lineup");
    expect(proposalLabel({ goal: "quality", kind: "judge-prompt" })).toBe("Quality · Judge prompt");
    expect(proposalLabel({ goal: "quality", kind: "analyst-prompt" })).toBe("Quality · Analyst prompt");
    expect(proposalLabel({ goal: "quality", kind: "case" })).toBe("Quality · New case");
    expect(proposalLabel({ goal: "quality", kind: "check" })).toBe("Quality · New check");
    expect(proposalLabel({ goal: "quality", kind: "retire-suggestion" })).toBe("Quality · Retire suggestion");
  });
});

describe("suggestionConfirm", () => {
  it("sends each suggestion through the set's existing command, and nothing without one (#878)", () => {
    expect(suggestionConfirm({ kind: "case", repo: "acme/app", prs: [7], reason: "flaky", tags: [] }))
      .toMatchObject({ path: "/api/evals/set/add", body: { repo: "acme/app", prs: [7], reason: "flaky" } });
    expect(suggestionConfirm({ kind: "case", repo: "acme/app", prs: [7], reason: "flaky", tags: ["ui"] })!.body).toEqual({ repo: "acme/app", prs: [7], reason: "flaky", tags: ["ui"] });
    expect(suggestionConfirm({ kind: "check", case: "c1", test: "a.test.ts" })).toMatchObject({ path: "/api/evals/set/check", body: { case: "c1", test: "a.test.ts" } });
    // A test file only: even a suggestion that slipped a command in sends none.
    const smuggled = { kind: "check", case: "c1", test: "a.test.ts", command: "rm -rf ~" } as unknown as Parameters<typeof suggestionConfirm>[0];
    expect(suggestionConfirm(smuggled)!.body).toEqual({ case: "c1", test: "a.test.ts" });
    expect(suggestionConfirm({ kind: "retire-suggestion", case: "c1", reason: "saturated" })).toMatchObject({ path: "/api/evals/set/retire", body: { case: "c1" } });
    expect(suggestionConfirm(undefined)).toBeNull();
  });
});

describe("suggestionLine", () => {
  it("says what confirming a test-set suggestion does, or why there is nothing to confirm (#878)", () => {
    expect(suggestionLine({ kind: "case", target: "add case acme/app#7", suggestion: { kind: "case", repo: "acme/app", prs: [7, 8], reason: "flaky", tags: ["ui"] } }))
      .toBe("add case acme/app#7, #8 [ui] — flaky");
    expect(suggestionLine({ kind: "check", suggestion: { kind: "check", case: "c1", test: "app.test.ts" } })).toBe("add check to c1: test app.test.ts");
    expect(suggestionLine({ kind: "retire-suggestion", suggestion: { kind: "retire-suggestion", case: "c1", reason: "saturated" } })).toBe("retire c1 — saturated");
    expect(suggestionLine({ kind: "retire-suggestion", target: "retire c1" })).toBe("retire c1");
    expect(suggestionLine({ kind: "check" })).toBe("new check (no details on this project)");
  });
});

describe("proposalVerdictSummary", () => {
  it("is null until a run settled the proposal", () => {
    expect(proposalVerdictSummary(null)).toBeNull();
  });

  it("counts the failed conditions and lists each with its reason", () => {
    expect(proposalVerdictSummary({ pass: false, conditions: [
      { id: "objective", pass: true, reason: "+0.10 beyond" },
      { id: "cost", pass: false, reason: "costs 30% more" },
    ] })).toEqual({
      headline: "fail · 1 of 2 conditions failed",
      conditions: [
        { pass: true, label: "pass · objective: +0.10 beyond" },
        { pass: false, label: "fail · cost: costs 30% more" },
      ],
    });
    expect(proposalVerdictSummary({ pass: true, conditions: [{ id: "objective", pass: true, reason: "ok" }] })!.headline).toBe("pass · 1 condition");
  });
});
