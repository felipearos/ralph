import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEvalsAdapter, EVALS_SET_CHECK_LOCK_WAIT_SECONDS, EVALS_SET_CHECK_RUN_SECONDS, EVALS_SET_WRITE_TIMEOUT_MS, EVALS_SUGGEST_FRESH_MS, EVALS_SUGGEST_TIMEOUT_MS,
  EVALS_PROPOSAL_OPEN_PR_TIMEOUT_MS, EVALS_SUGGEST_WAIT_MS, EVALS_SURFACE, parseEvalImproveOutput, parseEvalInboxOutput, parseEvalInboxWrite, parseEvalOpenPrOutput, parseEvalPatchesOutput, parseEvalProposalsOutput, parseEvalSetOutput, parseEvalsOutput, parseEvalSuggestionsOutput,
} from "./evals-adapter";
import { handleEvalsRoute } from "./evals-routes";
import type { Invocation } from "./executor";

const view = { version: 1, runs: [{ id: "eval-1", cases: [], dir: "eval-1" }], lineups: ["sonnet-coder"], clerks: ["clara", 7, "beta-intake"], clerkRepos: ["acme/app", null, "acme/web"], defaults: { panel: [{ name: "opus", runner: "claude", model: "o" }, { name: "x", runner: "gemini", model: "g" }], trialMinutes: 60, repeats: 1, noiseFloorArms: 4 }, history: { trialSeconds: 900, trialTokens: null, trials: 4 } };

const row = {
  id: "acme-app-12", repo: "acme/app", prs: [12], title: "Fix the login", tags: ["auth"], graders: ["held-out tests", "rubric", "gates"],
  status: "active", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe", lastRun: { run: "eval-1", startedAt: "2026-11-18T01:00:00Z" },
  reason: "a hard one", notes: "the answer is X", heldOut: ["test/login.test.ts"], check: "bun test",
  saturation: { saturated: true, passes: 3, window: 3, secret: "x" },
};
const NO_FLOOR = { state: "missing", floor: null, drift: null, staleShare: 0.2 };
const setPrint = (details: boolean) => JSON.stringify({ version: "abc123", details, cases: [row, { id: "broken" }] });
const written = (id: string) => ({ status: 0, stdout: JSON.stringify({ sha: "def456", case: { id, notes: "secret" } }), stderr: "" });

/** A fake exec for evals-set.ts, answering by its verb. */
function setAdapter(answers: Partial<Record<string, { status: number | null; stdout: string; stderr: string }>>) {
  const calls: Invocation[] = [];
  const evals = createEvalsAdapter({
    cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun",
    exec: async (invocation) => {
      calls.push(invocation);
      return answers[invocation.args[1]!] ?? { status: 1, stdout: "", stderr: "evals-set: not in this test" };
    },
  });
  return { evals, calls };
}

function adapter(answers: Partial<Record<string, { status: number | null; stdout: string; stderr: string }>>) {
  const calls: Invocation[] = [];
  const evals = createEvalsAdapter({
    cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun",
    exec: async (invocation) => {
      calls.push(invocation);
      return answers[invocation.args[1]!] ?? { status: 1, stdout: "", stderr: "experiments: Error: not in this test" };
    },
  });
  return { evals, calls };
}

describe("parseEvalsOutput", () => {
  it("keeps the runs and the Run screen's defaults, dropping a judge of a family the harness cannot run", () => {
    const parsed = parseEvalsOutput({ status: 0, stdout: JSON.stringify(view), stderr: "" });
    expect(parsed).toMatchObject({ problem: null, lineups: ["sonnet-coder"], history: { trialSeconds: 900, trialTokens: null, trials: 4 } });
    expect(parsed.runs.map((run) => run.id)).toEqual(["eval-1"]);
    expect(parsed.defaults).toEqual({ panel: [{ name: "opus", runner: "claude", model: "o" }], trialMinutes: 60, repeats: 1, noiseFloorArms: 4 });
  });
  it("copies a run's guardrail verdict field by field, and reads one missing or that does not parse as none (#871)", () => {
    const verdict = {
      baseline: "b", proposal: "c",
      goals: [
        { goal: "quality", pass: false, conditions: [{ id: "objective-up", pass: false, reason: "no floor", extra: "dropped" }], extra: 1 },
        { goal: "cost", pass: true, conditions: [{ id: "tokens-down", pass: true, reason: "tokens fell 20%" }] },
      ],
      extra: "dropped",
    };
    const guardrails = (value: unknown) => {
      const runs = [{ id: "eval-1", cases: [], dir: "eval-1", ...(value === undefined ? {} : { guardrails: value }) }];
      return parseEvalsOutput({ status: 0, stdout: JSON.stringify({ ...view, runs }), stderr: "" }).runs[0]!.guardrails;
    };
    expect(guardrails(verdict)).toEqual({
      baseline: "b", proposal: "c",
      goals: [
        { goal: "quality", pass: false, conditions: [{ id: "objective-up", pass: false, reason: "no floor" }] },
        { goal: "cost", pass: true, conditions: [{ id: "tokens-down", pass: true, reason: "tokens fell 20%" }] },
      ],
    });
    expect(guardrails(undefined)).toBeNull();
    expect(guardrails(null)).toBeNull();
    expect(guardrails("pass")).toBeNull();
    expect(guardrails({ ...verdict, proposal: 3 })).toBeNull();
    expect(guardrails({ ...verdict, goals: [{ ...verdict.goals[0], goal: "speed" }] })).toBeNull();
    // A goal with a condition that does not parse is no verdict, never a goal with fewer conditions.
    expect(guardrails({ ...verdict, goals: [{ goal: "cost", pass: true, conditions: [{ id: "tokens-down", pass: "yes", reason: "r" }] }] })).toBeNull();
  });
  it("copies a run's judge accuracy field by field, and reads one missing or that does not parse as none (#877)", () => {
    const tally = (agree: number, total: number, accuracy: number | null) => ({ agree, total, accuracy });
    const accuracy = {
      overall: { ...tally(3, 4, 0.75), extra: "dropped" },
      axes: { correctness: tally(2, 2, 1), scope: tally(1, 2, 0.5), tests: tally(0, 0, null), maintainability: tally(0, 0, null), review: tally(0, 0, null) },
      contested: 1,
      extra: "dropped",
    };
    const judgeAccuracy = (value: unknown) => {
      const runs = [{ id: "eval-1", cases: [], dir: "eval-1", ...(value === undefined ? {} : { judgeAccuracy: value }) }];
      return parseEvalsOutput({ status: 0, stdout: JSON.stringify({ ...view, runs }), stderr: "" }).runs[0]!.judgeAccuracy;
    };
    expect(judgeAccuracy(accuracy)).toEqual({ overall: tally(3, 4, 0.75), axes: accuracy.axes, contested: 1 });
    expect(judgeAccuracy(undefined)).toBeNull();
    expect(judgeAccuracy(null)).toBeNull();
    expect(judgeAccuracy({ ...accuracy, contested: -1 })).toBeNull();
    expect(judgeAccuracy({ ...accuracy, overall: tally(5, 4, 1.25) })).toBeNull();
    expect(judgeAccuracy({ ...accuracy, overall: { agree: 1, total: 2, accuracy: "50%" } })).toBeNull();
    // An axis missing or off is no accuracy, never a tally with fewer axes.
    const { review: _review, ...fourAxes } = accuracy.axes;
    expect(judgeAccuracy({ ...accuracy, axes: fourAxes })).toBeNull();
    expect(judgeAccuracy({ ...accuracy, axes: { ...accuracy.axes, tests: { agree: 0, total: "0", accuracy: null } } })).toBeNull();
  });
  it("defaults the noise floor's arms to the harness's three when an older harness never prints them (#859)", () => {
    const older = { ...view, defaults: { panel: [], trialMinutes: 60, repeats: 1 } };
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify(older), stderr: "" }).defaults.noiseFloorArms).toBe(3);
    expect(parseEvalsOutput({ status: 1, stdout: "", stderr: "" }).defaults.noiseFloorArms).toBe(3);
  });
  it("reads the roster's clerks as names only, and none when the print lists none", () => {
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify(view), stderr: "" }).clerks).toEqual(["clara", "beta-intake"]);
    const { clerks: _, ...withoutClerks } = view;
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify(withoutClerks), stderr: "" }).clerks).toEqual([]);
    expect(parseEvalsOutput({ status: 1, stdout: "", stderr: "" }).clerks).toEqual([]);
  });

  it("reads the clerk sample's app repos as strings only, and none when the print lists none (#827)", () => {
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify(view), stderr: "" }).clerkRepos).toEqual(["acme/app", "acme/web"]);
    const { clerkRepos: _, ...withoutRepos } = view;
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify(withoutRepos), stderr: "" }).clerkRepos).toEqual([]);
    expect(parseEvalsOutput({ status: 1, stdout: "", stderr: "" }).clerkRepos).toEqual([]);
  });
  it("is a view with a problem, never a throw, on a failed run or an unreadable print", () => {
    expect(parseEvalsOutput({ status: 1, stdout: "", stderr: "experiments: Error: no git\n" }).problem).toBe("no git");
    expect(parseEvalsOutput({ status: 0, stdout: "{\"version\": 2}", stderr: "" }).problem).toMatch(/unexpected shape/);
    expect(parseEvalsOutput({ status: null, stdout: "", stderr: "" }).problem).toBe("experiments.ts runs did not run without saying why");
  });
  it("carries the project's relayPatches opt-in, false unless the harness says exactly true", () => {
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify(view), stderr: "" }).relayPatches).toBe(false);
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify({ ...view, relayPatches: true }), stderr: "" }).relayPatches).toBe(true);
    expect(parseEvalsOutput({ status: 0, stdout: JSON.stringify({ ...view, relayPatches: "yes" }), stderr: "" }).relayPatches).toBe(false);
    expect(parseEvalsOutput({ status: 1, stdout: "", stderr: "" }).relayPatches).toBe(false);
  });
});

describe("parseEvalPatchesOutput", () => {
  it("fails closed: a failing or garbled CLI is disabled, with no patch text and a problem", () => {
    expect(parseEvalPatchesOutput({ status: 1, stdout: "", stderr: "experiments: Error: no git\n" })).toEqual({ enabled: false, patches: [], omitted: 0, problem: "no git" });
    const garbled = parseEvalPatchesOutput({ status: 0, stdout: "not json", stderr: "" });
    expect(garbled).toMatchObject({ enabled: false, patches: [], omitted: 0 });
    expect(garbled.problem).toMatch(/unexpected shape/);
    expect(parseEvalPatchesOutput({ status: 0, stdout: JSON.stringify({ version: 1, enabled: true, patches: {} }), stderr: "" }).enabled).toBe(false);
  });
  it("keeps only well-formed entries, and nothing when the project has not opted in", () => {
    const stdout = JSON.stringify({ version: 1, enabled: true, patches: [
      { run: "eval-1", case: "GH-3", arm: "opus", text: "diff\n", truncated: false },
      { run: "eval-1", case: "GH-3", arm: "x", text: 3, truncated: false },
      { run: "eval-1", case: "GH-4", arm: "opus", text: "d", truncated: "no" },
      { case: "GH-5", arm: "opus", text: "d", truncated: false },
      "eval-1/GH-6/opus",
    ], omitted: 2 });
    expect(parseEvalPatchesOutput({ status: 0, stdout, stderr: "" })).toEqual({ enabled: true, patches: [{ run: "eval-1", case: "GH-3", arm: "opus", text: "diff\n", truncated: false }], omitted: 2, problem: null });
    expect(parseEvalPatchesOutput({ status: 0, stdout: JSON.stringify({ version: 1, enabled: false, patches: [], omitted: 0 }), stderr: "" })).toEqual({ enabled: false, patches: [], omitted: 0, problem: null });
  });
});

describe("createEvalsAdapter", () => {
  it("runs the harness's experiments.ts in the project, the plan on stdin", async () => {
    const { evals, calls } = adapter({ start: { status: 0, stdout: "{\"version\":1,\"run\":{\"id\":\"eval-9\",\"dir\":\"/x\"}}", stderr: "" } });
    expect(await evals.start({ source: { kind: "pr", prs: [12] } })).toEqual({ ok: true, id: "eval-9" });
    expect(calls[0]).toMatchObject({ command: "/usr/bin/bun", args: ["/harness/experiments.ts", ...EVALS_SURFACE.start], cwd: "/srv/app", input: "{\"source\":{\"kind\":\"pr\",\"prs\":[12]}}" });
    expect(calls[0]!.env.RALPH_PROJECT).toBe("/srv/app");
  });
  it("answers the harness's own refusal", async () => {
    const { evals } = adapter({ start: { status: 1, stdout: "", stderr: "experiments: Error: backtest config: source.prs must list 1 to 10 PR numbers\n" } });
    expect(await evals.start({})).toEqual({ ok: false, why: "backtest config: source.prs must list 1 to 10 PR numbers" });
  });
});

describe("handleEvalsRoute", () => {
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });

  it("serves the runs view, and leaves every other path to the next route", async () => {
    const { evals } = adapter({ runs: { status: 0, stdout: JSON.stringify(view), stderr: "" } });
    const response = await handleEvalsRoute(request("GET", "/api/evals"), "/api/evals", evals);
    expect(response!.status).toBe(200);
    expect(((await response!.json()) as { runs: unknown[] }).runs).toHaveLength(1);
    expect(await handleEvalsRoute(request("GET", "/api/sleep"), "/api/sleep", evals)).toBeNull();
    expect((await handleEvalsRoute(request("POST", "/api/evals"), "/api/evals", evals))!.status).toBe(405);
  });

  it("starts a PR plan or a clerk plan and refuses any other shape, and stops a run by its id", async () => {
    const { evals, calls } = adapter({
      start: { status: 0, stdout: "{\"version\":1,\"run\":{\"id\":\"eval-9\"}}", stderr: "" },
      stop: { status: 0, stdout: "{\"version\":1,\"stopped\":true,\"why\":null}", stderr: "" },
    });
    const sample = { cap: 5, since: "2026-10-01T00:00:00Z" };
    for (const plan of [
      { clerk: "clara" },
      { source: { kind: "pr", prs: [12] }, clerk: "clara", sample },
      { source: { kind: "pr", prs: [12] }, sample },
      { clerk: "clara", sample: { cap: 0 } },
      { clerk: "clara", sample: { cap: 2.5 } },
      { clerk: "Clara", sample },
      { clerk: "clara_bot", sample },
      { clerk: "clara", sample: { cap: 5, since: 7 } },
      { source: { kind: "clerk" } },
      { source: { kind: "clerk" }, clerk: "clara", sample },
    ]) {
      const refused = await handleEvalsRoute(request("POST", "/api/evals/start", { plan }), "/api/evals/start", evals);
      expect(refused!.status, JSON.stringify(plan)).toBe(400);
    }
    expect(calls).toEqual([]);
    const started = await handleEvalsRoute(request("POST", "/api/evals/start", { plan: { source: { kind: "pr", prs: [12] } } }), "/api/evals/start", evals);
    expect(await started!.json()).toEqual({ ok: true, id: "eval-9" });
    const clerkPlan = { source: null, clerk: "beta-intake", sample, arms: [], repeats: 0, caps: { trialMinutes: 90 } };
    const clerkStarted = await handleEvalsRoute(request("POST", "/api/evals/start", { plan: clerkPlan }), "/api/evals/start", evals);
    expect(await clerkStarted!.json()).toEqual({ ok: true, id: "eval-9" });
    expect(JSON.parse(calls.at(-1)!.input!)).toEqual(clerkPlan);
    const stopped = await handleEvalsRoute(request("POST", "/api/evals/stop", { run: "eval-9" }), "/api/evals/stop", evals);
    expect(await stopped!.json()).toEqual({ stopped: true, why: null });
    expect(calls.at(-1)!.args).toEqual(["/harness/experiments.ts", "stop", "eval-9", "--json"]);
    expect((await handleEvalsRoute(request("POST", "/api/evals/stop", { run: "../x" }), "/api/evals/stop", evals))!.status).toBe(400);
  });

  it("serves a trial's patch as a diff, refusing anything but path segments", async () => {
    const { evals, calls } = adapter({ patch: { status: 0, stdout: "diff --git a/x b/x\n", stderr: "" } });
    const patch = await handleEvalsRoute(request("GET", "/api/evals/patch?run=eval-9&case=GH-34&arm=opus"), "/api/evals/patch", evals);
    expect(patch!.headers.get("content-type")).toBe("text/x-diff; charset=utf-8");
    expect(await patch!.text()).toBe("diff --git a/x b/x\n");
    expect(calls[0]!.args).toEqual(["/harness/experiments.ts", "patch", "eval-9", "GH-34", "opus"]);
    expect((await handleEvalsRoute(request("GET", "/api/evals/patch?run=..&case=GH-34&arm=opus"), "/api/evals/patch", evals))!.status).toBe(400);
  });

  it("serves the relayable patches, parsed, and a failing CLI as an empty disabled view", async () => {
    const stdout = JSON.stringify({ version: 1, enabled: true, patches: [{ run: "eval-9", case: "GH-34", arm: "opus", text: "diff\n", truncated: true }], omitted: 0 });
    const { evals, calls } = adapter({ patches: { status: 0, stdout, stderr: "" } });
    const response = await handleEvalsRoute(request("GET", "/api/evals/patches"), "/api/evals/patches", evals);
    expect(await response!.json()).toEqual({ enabled: true, patches: [{ run: "eval-9", case: "GH-34", arm: "opus", text: "diff\n", truncated: true }], omitted: 0, problem: null });
    expect(calls[0]!.args).toEqual(["/harness/experiments.ts", "patches", "--json"]);
    expect((await handleEvalsRoute(request("POST", "/api/evals/patches"), "/api/evals/patches", evals))!.status).toBe(405);
    const failing = adapter({});
    const closed = (await (await handleEvalsRoute(request("GET", "/api/evals/patches"), "/api/evals/patches", failing.evals))!.json()) as { enabled: boolean; patches: object; problem: string | null };
    expect(closed).toMatchObject({ enabled: false, patches: [], problem: "not in this test" });
  });
});

describe("the test set (#856)", () => {
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  const route = (evals: ReturnType<typeof setAdapter>["evals"], method: string, path: string, body?: unknown) =>
    handleEvalsRoute(request(method, path, body), new URL(`http://x${path}`).pathname, evals);

  it("narrows the view field by field: undeclared fields and unknown graders dropped, reason and notes only with details", () => {
    const detailed = parseEvalSetOutput({ status: 0, stdout: setPrint(true), stderr: "" });
    expect(detailed).toEqual({
      version: "abc123", details: true, problem: null, noiseFloor: NO_FLOOR, calibrationSuggestions: [],
      cases: [{
        id: "acme-app-12", repo: "acme/app", prs: [12], title: "Fix the login", tags: ["auth"], graders: ["held-out tests", "gates"],
        status: "active", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe", lastRun: { run: "eval-1", startedAt: "2026-11-18T01:00:00Z" },
        saturation: { saturated: true, passes: 3, window: 3 }, calibrations: 0,
        reason: "a hard one", notes: "the answer is X",
      }],
    });
    const summary = parseEvalSetOutput({ status: 0, stdout: setPrint(false), stderr: "" });
    expect(summary.details).toBe(false);
    expect(Object.keys(summary.cases[0]!)).not.toContain("reason");
    expect(Object.keys(summary.cases[0]!)).not.toContain("notes");
  });

  it("carries the noise floor status field by field, and reads one that does not parse as no floor (#859)", () => {
    const print = (noiseFloor: unknown) => parseEvalSetOutput({ status: 0, stdout: JSON.stringify({ version: "abc123", details: false, cases: [], noiseFloor }), stderr: "" }).noiseFloor;
    const fresh = {
      state: "fresh", floor: { version: "v0", measuredAt: "2026-11-19T10:00:00Z", runId: "eval-floor", spread: { objective: 0.25, judge: null }, secret: "x" },
      drift: { added: 1, retired: 0, share: 0.1 }, staleShare: 0.2, extra: true,
    };
    expect(print(fresh)).toEqual({
      state: "fresh", floor: { version: "v0", measuredAt: "2026-11-19T10:00:00Z", runId: "eval-floor", spread: { objective: 0.25, judge: null } },
      drift: { added: 1, retired: 0, share: 0.1 }, staleShare: 0.2,
    });
    expect(print({ ...fresh, state: "stale" }).state).toBe("stale");
    expect(print({ state: "missing", floor: null, drift: null, staleShare: 0.3 })).toEqual({ ...NO_FLOOR, staleShare: 0.3 });
    for (const broken of [undefined, null, { ...fresh, state: "ripe" }, { ...fresh, floor: null }, { ...fresh, drift: { added: "1" } }, { ...fresh, staleShare: "0.2" }]) {
      expect(print(broken)).toEqual(NO_FLOOR);
    }
  });

  it("carries a row's saturation field by field, and reads one missing or that does not parse as null (#860)", () => {
    const saturationOf = (saturation: unknown) => {
      const { saturation: _, ...bare } = row;
      const printed = saturation === undefined ? bare : { ...bare, saturation };
      return parseEvalSetOutput({ status: 0, stdout: JSON.stringify({ version: "abc123", details: false, cases: [printed] }), stderr: "" }).cases[0]!.saturation;
    };
    expect(saturationOf({ saturated: false, passes: 1, window: 3 })).toEqual({ saturated: false, passes: 1, window: 3 });
    for (const broken of [undefined, null, "yes", { saturated: "true", passes: 3, window: 3 }, { saturated: true, passes: -1, window: 3 }, { saturated: true, passes: 3 }, { saturated: true, passes: 1.5, window: 3 }]) {
      expect(saturationOf(broken), JSON.stringify(broken)).toBeNull();
    }
  });

  describe("calibration verdicts (#876)", () => {
    const verdict = { arms: ["opus", "codex"], axis: "correctness", preferred: "codex", reason: "kept the migration", by: "felipe", at: "2026-11-19T10:00:00Z" };
    const printOf = (details: boolean, over: Record<string, unknown>, top: Record<string, unknown> = {}) =>
      parseEvalSetOutput({ status: 0, stdout: JSON.stringify({ version: "abc123", details, cases: [{ ...row, ...over }], ...top }), stderr: "" });

    it("carries the count always and the verdicts only with details, dropping a verdict that does not parse", () => {
      const broken = [
        { ...verdict, axis: "speed" }, { ...verdict, arms: ["opus"] }, { ...verdict, arms: ["opus", "opus"], preferred: "opus" },
        { ...verdict, preferred: "sonnet" }, { ...verdict, reason: "" }, { ...verdict, by: 3 }, "opus", null,
      ];
      const detailed = printOf(true, { calibrations: 2, calibration: [{ ...verdict, secret: "x" }, ...broken] }).cases[0]!;
      expect(detailed.calibrations).toBe(2);
      expect(detailed.calibration).toEqual([verdict]);
      expect(printOf(true, { calibrations: 0, calibration: "many" }).cases[0]).not.toHaveProperty("calibration");
      expect(printOf(true, { calibrations: 0 }).cases[0]).not.toHaveProperty("calibration");
    });

    it("keeps a summary-only view at counts, never reasons", () => {
      const summary = printOf(false, { calibrations: 2 }).cases[0]!;
      expect(summary.calibrations).toBe(2);
      expect(summary).not.toHaveProperty("calibration");
      // Even a harness that printed the verdicts on a summary view does not get them relayed.
      expect(printOf(false, { calibrations: 1, calibration: [verdict] }).cases[0]).not.toHaveProperty("calibration");
    });

    it("reads a count missing or that does not parse as 0", () => {
      for (const broken of [undefined, null, -1, 1.5, "2"]) {
        expect(printOf(false, { calibrations: broken }).cases[0]!.calibrations, JSON.stringify(broken)).toBe(0);
      }
    });

    it("narrows the suggestions entry by entry, and reads them missing (an older harness) as none", () => {
      const suggestion = { id: "acme-app-12", title: "Fix the login", contested: [{ axis: "correctness", arms: ["opus", "codex"], secret: "x" }], run: "eval-1", calibrations: 0, extra: true };
      const suggestions = [
        suggestion,
        { ...suggestion, id: "acme-app-13", contested: [{ axis: "speed", arms: ["opus"] }, { axis: "tests", arms: ["opus", "codex"] }] },
        { ...suggestion, id: 7 },
        { ...suggestion, calibrations: -1 },
        { ...suggestion, contested: [{ axis: "speed", arms: ["opus"] }] },
        { ...suggestion, contested: "correctness" },
        null,
      ];
      expect(printOf(false, {}, { calibrationSuggestions: suggestions }).calibrationSuggestions).toEqual([
        { id: "acme-app-12", title: "Fix the login", contested: [{ axis: "correctness", arms: ["opus", "codex"] }], run: "eval-1", calibrations: 0 },
        { id: "acme-app-13", title: "Fix the login", contested: [{ axis: "tests", arms: ["opus", "codex"] }], run: "eval-1", calibrations: 0 },
      ]);
      expect(printOf(false, {}).calibrationSuggestions).toEqual([]);
      expect(printOf(false, {}, { calibrationSuggestions: "none" }).calibrationSuggestions).toEqual([]);
    });

    const good = { case: "acme-app-12", arms: ["opus", "codex"], axis: "correctness", preferred: "codex", reason: "kept the migration" };

    it("runs calibrate with each field as its own argument, under the write timeout", async () => {
      const { evals, calls } = setAdapter({ calibrate: written("acme-app-12") });
      expect(await evals.setCalibrate({ ...good, arms: ["opus", "codex"], axis: "correctness" })).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
      expect(calls[0]).toMatchObject({
        args: [
          "/harness/evals-set.ts", "calibrate", "--case", "acme-app-12", "--arm", "opus", "--arm", "codex",
          "--axis", "correctness", "--prefer", "codex", "--reason", "kept the migration", "--by", "dashboard",
        ],
        timeoutMs: EVALS_SET_WRITE_TIMEOUT_MS,
      });
    });

    it("hands a good body to setCalibrate parsed, and the CLI's refusal back as the route's refusal", async () => {
      const { evals, calls } = setAdapter({ calibrate: written("acme-app-12") });
      const answered = await route(evals, "POST", "/api/evals/set/calibrate", { ...good, reason: "  kept the migration  ", id: "3f9c1e2a", via: "remote" });
      expect(answered!.status).toBe(200);
      expect(await answered!.json()).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
      expect(calls.at(-1)!.args.slice(1)).toEqual([
        "calibrate", "--case", "acme-app-12", "--arm", "opus", "--arm", "codex", "--axis", "correctness", "--prefer", "codex", "--reason", "kept the migration", "--by", "dashboard",
      ]);
      const refusing = setAdapter({ calibrate: { status: 1, stdout: "", stderr: "evals-set: no case x in the set\n" } });
      const refused = await route(refusing.evals, "POST", "/api/evals/set/calibrate", good);
      expect(refused!.status).toBe(200);
      expect(await refused!.json()).toEqual({ ok: false, why: "no case x in the set" });
      expect((await route(evals, "GET", "/api/evals/set/calibrate"))!.status).toBe(405);
    });

    it("400s a malformed body, naming the field, without calling the CLI", async () => {
      const { evals, calls } = setAdapter({ calibrate: written("acme-app-12") });
      for (const [body, field] of [
        [{ ...good, axis: "speed" }, "'axis'"],
        [{ ...good, preferred: "sonnet" }, "'preferred'"],
        [{ ...good, arms: ["opus"] }, "'arms'"],
        [{ ...good, reason: "" }, "'reason'"],
        [{ ...good, case: "../x" }, "'case'"],
      ] as const) {
        const answered = await route(evals, "POST", "/api/evals/set/calibrate", body);
        expect(answered!.status, JSON.stringify(body)).toBe(400);
        expect(((await answered!.json()) as { message: string }).message).toContain(field);
      }
      expect(calls).toEqual([]);
    });
  });

  it("is an empty view with a problem, never a throw, on a failed run or an unexpected print", () => {
    expect(parseEvalSetOutput({ status: 1, stdout: "", stderr: "evals-set: Error: no git\n" })).toEqual({ version: null, details: false, cases: [], noiseFloor: NO_FLOOR, calibrationSuggestions: [], problem: "no git" });
    expect(parseEvalSetOutput({ status: 0, stdout: "{\"version\":\"a\",\"cases\":[]}", stderr: "" }).problem).toMatch(/unexpected shape/);
    expect(parseEvalSetOutput({ status: 0, stdout: "not json", stderr: "" })).toMatchObject({ version: null, details: false, cases: [] });
    expect(parseEvalSetOutput({ status: null, stdout: "", stderr: "" }).problem).toBe("evals-set.ts view did not run without saying why");
  });

  it("runs evals-set.ts in the project with the default timeout for reads and a long one for writes", async () => {
    const { evals, calls } = setAdapter({ view: { status: 0, stdout: setPrint(false), stderr: "" }, retire: written("acme-app-12") });
    await evals.set();
    expect(calls[0]).toMatchObject({ command: "/usr/bin/bun", args: ["/harness/evals-set.ts", "view"], cwd: "/srv/app" });
    expect(calls[0]!.env.RALPH_PROJECT).toBe("/srv/app");
    expect(calls[0]!.timeoutMs).toBeUndefined();
    expect(await evals.setRetire("acme-app-12")).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
    expect(calls[1]).toMatchObject({ args: ["/harness/evals-set.ts", "retire", "acme-app-12"], timeoutMs: EVALS_SET_WRITE_TIMEOUT_MS });
    const kept = setAdapter({ keep: written("acme-app-12") });
    expect(await kept.evals.setKeep("acme-app-12")).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
    expect(kept.calls[0]).toMatchObject({ args: ["/harness/evals-set.ts", "keep", "acme-app-12"], timeoutMs: EVALS_SET_WRITE_TIMEOUT_MS });
    // The write and its lock wait fit inside server.ts's 255 s idleTimeout: a write that outlives the request still commits.
    expect(calls[1]!.env.RALPH_EVALS_SET_LOCK_WAIT).toBe("120");
    expect(EVALS_SET_WRITE_TIMEOUT_MS).toBeLessThan(255_000);
  });

  it("adds with each value as its own argument, and edits tags, no tags or notes", async () => {
    const { evals, calls } = setAdapter({ add: written("acme-app-12"), edit: written("acme-app-12") });
    expect(await evals.setAdd({ repo: "acme/app", prs: [12, 14], reason: "a hard one; rm -rf", tags: ["auth", "ui"], notes: "n" }))
      .toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
    expect(calls[0]!.args).toEqual([
      "/harness/evals-set.ts", "add", "--repo", "acme/app", "--pr", "12", "--pr", "14", "--reason", "a hard one; rm -rf",
      "--tag", "auth", "--tag", "ui", "--notes", "n", "--by", "dashboard",
    ]);
    expect(calls[0]!.timeoutMs).toBe(EVALS_SET_WRITE_TIMEOUT_MS);
    await evals.setEdit({ case: "acme-app-12", tags: ["a"] });
    await evals.setEdit({ case: "acme-app-12", tags: [], notes: "" });
    await evals.setEdit({ case: "acme-app-12", notes: "later" });
    expect(calls.slice(1).map((call) => call.args.slice(1))).toEqual([
      ["edit", "acme-app-12", "--tag", "a"],
      ["edit", "acme-app-12", "--no-tags", "--notes", ""],
      ["edit", "acme-app-12", "--notes", "later"],
    ]);
    expect(calls.slice(1).every((call) => call.timeoutMs === EVALS_SET_WRITE_TIMEOUT_MS)).toBe(true);
  });

  it("refuses text the CLI would read as a flag, without calling it", async () => {
    const { evals, calls } = setAdapter({});
    expect(await evals.setAdd({ repo: "acme/app", prs: [1], reason: "r", notes: "--repo x" })).toEqual({ ok: false, why: "the notes may not start with --" });
    expect(await evals.setEdit({ case: "a-1", tags: ["--no-tags"] })).toEqual({ ok: false, why: "a tag may not start with --" });
    expect(await evals.setAdd({ repo: "acme/app", prs: [1], reason: "--x" })).toEqual({ ok: false, why: "the reason may not start with --" });
    expect(calls).toEqual([]);
  });

  it("answers the CLI's refusal verbatim, past a usage block, and an unexpected print as a refusal", async () => {
    const unmerged = "eval: acme/app#12 is not merged; only a merged PR makes a case";
    const { evals } = setAdapter({
      add: { status: 1, stdout: "", stderr: `evals-set: Error: ${unmerged}\n` },
      edit: { status: 64, stdout: "", stderr: "evals-set: edit needs --tag, --no-tags or --notes\nusage: evals-set.ts list\n       evals-set.ts view [--project <path>]\n" },
      retire: { status: 0, stdout: "{}", stderr: "" },
    });
    expect(await evals.setAdd({ repo: "acme/app", prs: [12], reason: "r" })).toEqual({ ok: false, why: unmerged });
    expect(await evals.setEdit({ case: "a-1", notes: "x" })).toEqual({ ok: false, why: "edit needs --tag, --no-tags or --notes" });
    expect((await evals.setRetire("a-1")) as { why: string }).toMatchObject({ ok: false, why: expect.stringMatching(/unexpected shape/) });
    const duplicate = setAdapter({ add: { status: 1, stdout: "", stderr: "evals-set: acme/app#12 is already in case acme-app-12\n" } });
    expect(await duplicate.evals.setAdd({ repo: "acme/app", prs: [12], reason: "r" })).toEqual({ ok: false, why: "acme/app#12 is already in case acme-app-12" });
  });

  it("serves the set, a case's curation, and 404s an unknown case", async () => {
    const show = JSON.stringify({ version: "abc", case: { ...row, tags: ["auth"], heldOut: ["x"], ticket: { body: "b" } } });
    const { evals, calls } = setAdapter({ view: { status: 0, stdout: setPrint(true), stderr: "" }, show: { status: 0, stdout: show, stderr: "" } });
    const set = await route(evals, "GET", "/api/evals/set");
    expect(set!.status).toBe(200);
    expect(((await set!.json()) as { cases: unknown[] }).cases).toHaveLength(1);
    const found = await route(evals, "GET", "/api/evals/set/case?id=acme-app-12");
    expect(await found!.json()).toEqual({ id: "acme-app-12", tags: ["auth"], reason: "a hard one", notes: "the answer is X" });
    expect(calls.at(-1)!.args).toEqual(["/harness/evals-set.ts", "show", "acme-app-12"]);
    const missing = setAdapter({ show: { status: 1, stdout: "", stderr: "evals-set: no case acme-app-9 in acme\n" } });
    const absent = await route(missing.evals, "GET", "/api/evals/set/case?id=acme-app-9");
    expect(absent!.status).toBe(404);
    expect(await absent!.json()).toEqual({ error: "NoCase", message: "no case acme-app-9 in acme" });
    for (const path of ["/api/evals/set/case", "/api/evals/set/case?id=..%2Fx", "/api/evals/set/case?id=--project"]) {
      expect((await route(evals, "GET", path))!.status, path).toBe(400);
    }
    expect((await route(evals, "POST", "/api/evals/set"))!.status).toBe(405);
    expect((await route(evals, "POST", "/api/evals/set/case?id=a"))!.status).toBe(405);
  });

  it("writes through add, edit, retire and keep, 200 on a refusal too, and 400s a bad body without calling the CLI", async () => {
    const { evals, calls } = setAdapter({
      add: { status: 1, stdout: "", stderr: "evals-set: acme/app#12 is already in case acme-app-12\n" },
      edit: written("acme-app-12"), retire: written("acme-app-12"), keep: written("acme-app-12"),
    });
    for (const [path, body] of [
      ["/api/evals/set/add", { repo: "acme", prs: [12], reason: "r" }],
      ["/api/evals/set/add", { repo: "acme/app", prs: [], reason: "r" }],
      ["/api/evals/set/edit", { case: "acme-app-12" }],
      ["/api/evals/set/retire", { case: "../x" }],
      ["/api/evals/set/keep", { case: "../x" }],
      ["/api/evals/set/keep", {}],
    ] as const) {
      expect((await route(evals, "POST", path, body))!.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(calls).toEqual([]);
    const added = await route(evals, "POST", "/api/evals/set/add", { repo: "acme/app", prs: [12], reason: "r" });
    expect(added!.status).toBe(200);
    expect(await added!.json()).toEqual({ ok: false, why: "acme/app#12 is already in case acme-app-12" });
    const edited = await route(evals, "POST", "/api/evals/set/edit", { case: "acme-app-12", tags: [] });
    expect(await edited!.json()).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
    expect(calls.at(-1)!.args.slice(1)).toEqual(["edit", "acme-app-12", "--no-tags"]);
    const retired = await route(evals, "POST", "/api/evals/set/retire", { case: "acme-app-12" });
    expect(await retired!.json()).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
    const kept = await route(evals, "POST", "/api/evals/set/keep", { case: "acme-app-12" });
    expect(await kept!.json()).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
    expect(calls.at(-1)!.args.slice(1)).toEqual(["keep", "acme-app-12"]);
    for (const path of ["/api/evals/set/add", "/api/evals/set/edit", "/api/evals/set/retire", "/api/evals/set/keep"]) {
      expect((await route(evals, "GET", path))!.status, path).toBe(405);
    }
  });

  describe("attaching a check (#857)", () => {
    const accepted = { status: 0, stdout: JSON.stringify({ sha: "def456", case: "acme-app-12", base: "fail", reference: "pass" }), stderr: "" };
    const passesOnBase = "refused: the check passes on the base (abc1234); it must fail there";
    const refusedPrint = {
      status: 1,
      stdout: JSON.stringify({ sha: null, case: "acme-app-12", base: { result: "pass" }, reference: { result: "pass" } }),
      stderr: `cloning acme/app\nevals-set: ${passesOnBase}\n`,
    };

    it("runs check with the test or the command as its own argument, each run capped, under the write timeout", async () => {
      const { evals, calls } = setAdapter({ check: accepted });
      expect(await evals.setCheck({ case: "acme-app-12", test: "src/a.test.ts" })).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
      expect(await evals.setCheck({ case: "acme-app-12", command: "bun x vitest run a; rm -rf" })).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
      expect(calls.map((call) => call.args.slice(1))).toEqual([
        ["check", "--case", "acme-app-12", "--test", "src/a.test.ts", "--timeout", "45", "--by", "dashboard"],
        ["check", "--case", "acme-app-12", "--command", "bun x vitest run a; rm -rf", "--timeout", "45", "--by", "dashboard"],
      ]);
      expect(calls.every((call) => call.timeoutMs === EVALS_SET_WRITE_TIMEOUT_MS)).toBe(true);
      // Two trees, each a capped setup and a capped check, plus the lock wait, leave room for the clone and the commit.
      expect((4 * EVALS_SET_CHECK_RUN_SECONDS + EVALS_SET_CHECK_LOCK_WAIT_SECONDS) * 1000).toBeLessThanOrEqual(EVALS_SET_WRITE_TIMEOUT_MS - 30_000);
      expect(calls.every((call) => call.env.RALPH_EVALS_SET_LOCK_WAIT === String(EVALS_SET_CHECK_LOCK_WAIT_SECONDS))).toBe(true);
    });

    it("answers the CLI's refusal reason, and refuses flag-like text without calling it", async () => {
      const { evals, calls } = setAdapter({ check: refusedPrint });
      expect(await evals.setCheck({ case: "acme-app-12", test: "src/a.test.ts" })).toEqual({ ok: false, why: passesOnBase });
      expect(await evals.setCheck({ case: "acme-app-12", test: "--x" })).toEqual({ ok: false, why: "the test path may not start with --" });
      expect(await evals.setCheck({ case: "acme-app-12", command: "--x" })).toEqual({ ok: false, why: "the command may not start with --" });
      expect(calls).toHaveLength(1);
    });

    it("400s a bad body without calling the CLI, 200s a refusal, and never echoes the check back", async () => {
      const { evals, calls } = setAdapter({ check: refusedPrint });
      for (const body of [
        { case: "acme-app-12" },
        { case: "acme-app-12", test: "a.test.ts", command: "make" },
        { case: "acme-app-12", test: "/etc/a.test.ts" },
        { case: "acme-app-12", test: "../a.test.ts" },
        { case: "acme-app-12", command: "--x" },
        { test: "a.test.ts" },
      ]) {
        expect((await route(evals, "POST", "/api/evals/set/check", body))!.status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toEqual([]);
      const refused = await route(evals, "POST", "/api/evals/set/check", { case: "acme-app-12", test: "src/a.test.ts" });
      expect(refused!.status).toBe(200);
      expect(await refused!.json()).toEqual({ ok: false, why: passesOnBase });
      const ok = setAdapter({ check: accepted });
      const attached = await route(ok.evals, "POST", "/api/evals/set/check", { case: "acme-app-12", command: "make check" });
      expect(await attached!.json()).toEqual({ ok: true, id: "acme-app-12", sha: "def456" });
      expect((await route(evals, "GET", "/api/evals/set/check"))!.status).toBe(405);
    });
  });
});

describe("the test set's suggestions (#858)", () => {
  const suggestion = {
    repo: "acme/app", pr: 12, title: "Fix the login", url: "https://github.com/acme/app/pull/12", mergedAt: "2026-11-18T00:00:00Z",
    tickets: [7, "8"], score: 5,
    reasons: [{ signal: "parked", text: "parked twice" }, { signal: "newSignal", text: "a signal this page does not know" }, { signal: "blocked" }],
    // What a harness bug might over-share: the adapter copies only declared fields.
    diff: "diff --git a/x b/x", ticketBody: "the ticket body",
  };
  const print = JSON.stringify({
    version: "abc123",
    suggestions: [suggestion, { repo: "acme/app", pr: 13, title: "No url", mergedAt: "2026-11-18T00:00:00Z" }, { title: "no pr" }, "nope"],
    missing: [{ source: "speed", why: "no ledger yet" }, { source: "parks" }],
  });

  it("narrows each suggestion field by field, dropping a row without pr, title or url and keeping an unknown signal's text", () => {
    expect(parseEvalSuggestionsOutput({ status: 0, stdout: print, stderr: "" })).toEqual({
      version: "abc123", problem: null,
      suggestions: [{
        repo: "acme/app", pr: 12, title: "Fix the login", url: "https://github.com/acme/app/pull/12", mergedAt: "2026-11-18T00:00:00Z",
        tickets: [7], score: 5,
        reasons: [{ signal: "parked", text: "parked twice" }, { signal: "newSignal", text: "a signal this page does not know" }],
      }],
      missing: [{ source: "speed", why: "no ledger yet" }],
    });
  });

  it("is an empty view with a problem, never a throw, on a refusal or an unexpected print", () => {
    expect(parseEvalSuggestionsOutput({ status: 1, stdout: "", stderr: "evals-set: Error: no git\n" })).toEqual({ version: null, suggestions: [], missing: [], problem: "no git" });
    expect(parseEvalSuggestionsOutput({ status: 0, stdout: "{\"version\":\"a\"}", stderr: "" }).problem).toMatch(/unexpected shape/);
    expect(parseEvalSuggestionsOutput({ status: 0, stdout: "not json", stderr: "" })).toMatchObject({ version: null, suggestions: [], missing: [] });
    expect(parseEvalSuggestionsOutput({ status: null, stdout: "", stderr: "" }).problem).toBe("evals-set.ts suggest did not run without saying why");
  });

  it("runs evals-set.ts suggest in the project under its long timeout, and serves it on GET only", async () => {
    const { evals, calls } = setAdapter({ suggest: { status: 0, stdout: print, stderr: "" } });
    const served = await handleEvalsRoute(new Request("http://127.0.0.1/api/evals/suggestions"), "/api/evals/suggestions", evals);
    expect(served!.status).toBe(200);
    const body = (await served!.json()) as { suggestions: { pr: number }[] };
    expect(body.suggestions.map((row) => row.pr)).toEqual([12]);
    expect(JSON.stringify(body)).not.toMatch(/diff --git|ticket body/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "/usr/bin/bun", args: ["/harness/evals-set.ts", "suggest"], cwd: "/srv/app", timeoutMs: EVALS_SUGGEST_TIMEOUT_MS });
    expect(calls[0]!.env.RALPH_PROJECT).toBe("/srv/app");
    // It reads gh and the tracker, yet still fits inside server.ts's 255 s idleTimeout.
    expect(EVALS_SUGGEST_TIMEOUT_MS).toBeLessThan(255_000);
    const posted = await handleEvalsRoute(new Request("http://127.0.0.1/api/evals/suggestions", { method: "POST" }), "/api/evals/suggestions", evals);
    expect(posted!.status).toBe(405);
  });

  // A clock and an exec the test drives: each suggest run waits until the test answers it.
  function cachedAdapter() {
    let clock = 1_000_000;
    const runs: ((answer: { status: number | null; stdout: string; stderr: string }) => void)[] = [];
    const evals = createEvalsAdapter({
      cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun", now: () => clock,
      exec: (invocation) => invocation.args[1] === "suggest"
        ? new Promise((resolve) => { runs.push(resolve); })
        : Promise.resolve(invocation.args[1] === "add" ? written("acme-app-12") : { status: 1, stdout: "", stderr: "evals-set: not in this test" }),
    });
    return { evals, runs, tick: (ms: number) => { clock += ms; } };
  }
  const answer = { status: 0, stdout: print, stderr: "" };

  afterEach(() => { vi.useRealTimers(); });

  it("serves its last answer without a second run while it is fresh, and starts one run behind a stale answer", async () => {
    const { evals, runs, tick } = cachedAdapter();
    const first = evals.suggestions();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!(answer);
    expect((await first).suggestions.map((row) => row.pr)).toEqual([12]);
    expect((await evals.suggestions()).suggestions.map((row) => row.pr)).toEqual([12]);
    expect(runs).toHaveLength(1);
    tick(EVALS_SUGGEST_FRESH_MS);
    // Stale: the old answer comes back at once, and only one run starts however often it is read.
    expect((await evals.suggestions()).suggestions.map((row) => row.pr)).toEqual([12]);
    expect((await evals.suggestions()).suggestions.map((row) => row.pr)).toEqual([12]);
    expect(runs).toHaveLength(2);
  });

  it("answers pending rather than holding the bridge when the first run is slow, then serves the run once it lands", async () => {
    vi.useFakeTimers();
    const { evals, runs } = cachedAdapter();
    const first = evals.suggestions();
    await vi.advanceTimersByTimeAsync(EVALS_SUGGEST_WAIT_MS);
    expect(await first).toEqual({ version: null, suggestions: [], missing: [], problem: null, pending: true });
    // Still running: a second read joins it rather than starting another.
    const second = evals.suggestions();
    expect(runs).toHaveLength(1);
    runs[0]!(answer);
    expect((await second).suggestions.map((row) => row.pr)).toEqual([12]);
  });

  it("does not let a run that started before an add bring the added PR back", async () => {
    const { evals, runs, tick } = cachedAdapter();
    const first = evals.suggestions();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!(answer);
    await first;
    tick(EVALS_SUGGEST_FRESH_MS);
    await evals.suggestions();
    expect(runs).toHaveLength(2);
    expect(await evals.setAdd({ repo: "acme/app", prs: [12], reason: "parked twice" })).toMatchObject({ ok: true });
    // The run read the set before the add: its answer still lists #12.
    runs[1]!(answer);
    // Once it lands it is served stale, never as fresh: the next read starts a run that sees the add.
    await vi.waitFor(async () => {
      expect((await evals.suggestions()).suggestions).toEqual([]);
      expect(runs).toHaveLength(3);
    });
  });

  it("keeps the last good list when a refresh fails, saying why it is not fresh", async () => {
    const { evals, runs, tick } = cachedAdapter();
    const first = evals.suggestions();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!(answer);
    await first;
    tick(EVALS_SUGGEST_FRESH_MS);
    await evals.suggestions();
    runs[1]!({ status: 1, stdout: "", stderr: "evals-set: Error: gh timed out\n" });
    await vi.waitFor(async () => expect((await evals.suggestions()).problem).toBe("Not refreshed: gh timed out"));
    expect((await evals.suggestions()).suggestions.map((row) => row.pr)).toEqual([12]);
  });

  it("drops a PR from the served suggestions as soon as it is added, and refreshes behind", async () => {
    const { evals, runs } = cachedAdapter();
    const first = evals.suggestions();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!(answer);
    await first;
    expect(await evals.setAdd({ repo: "ACME/app", prs: [12], reason: "parked twice" })).toMatchObject({ ok: true });
    expect((await evals.suggestions()).suggestions).toEqual([]);
    expect(runs).toHaveLength(2);
  });
});

describe("the recommended-runs inbox (#872)", () => {
  const inboxRow = {
    id: "rec-1a2b3c4d", source: "pr", arms: ["opus", "sonnet"], repeats: 2, trials: 8,
    recommendedBy: { kind: "agent", name: "rafa", email: "x@y" }, reason: "the auth cases regressed", addedAt: "2026-11-19T00:00:00Z",
  };
  const narrowed = {
    id: "rec-1a2b3c4d", source: "pr", arms: ["opus", "sonnet"], repeats: 2, trials: 8,
    recommendedBy: { kind: "agent", name: "rafa" }, reason: "the auth cases regressed", addedAt: "2026-11-19T00:00:00Z",
  };
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const route = (evals: ReturnType<typeof setAdapter>["evals"], method: string, path: string, body?: unknown) =>
    handleEvalsRoute(
      new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }),
      path, evals,
    );
  /** A fake exec for evals-inbox.ts, answering by its verb. */
  function inboxAdapter(answers: Partial<Record<string, { status: number | null; stdout: string; stderr: string }>>) {
    const calls: Invocation[] = [];
    const evals = createEvalsAdapter({
      cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun",
      exec: async (invocation) => {
        calls.push(invocation);
        return answers[invocation.args[1]!] ?? { status: 1, stdout: "", stderr: "evals-inbox: not in this test" };
      },
    });
    return { evals, calls };
  }

  it("copies each row field by field: a plan, a diff or a path the CLI printed beside it never comes out", () => {
    const printed = { ...inboxRow, plan: { source: { kind: "pr", prs: [12] } }, diff: "--- a", path: "/srv/app/.ralph/x" };
    const view = parseEvalInboxOutput(ok({ version: 1, entries: [printed] }));
    expect(view).toEqual({ entries: [narrowed], problem: null });
    expect(JSON.stringify(view)).not.toMatch(/plan|diff|\/srv/);
    // Trials are null when the harness picks the cases at start.
    expect(parseEvalInboxOutput(ok({ version: 1, entries: [{ ...inboxRow, trials: null }] })).entries[0]!.trials).toBeNull();
  });

  it("drops a malformed row and reads an unexpected print or a failed run as a problem, never a throw", () => {
    for (const broken of [
      null, "rec-1", { ...inboxRow, id: 3 }, { ...inboxRow, arms: [1] }, { ...inboxRow, repeats: -1 }, { ...inboxRow, trials: "8" },
      { ...inboxRow, recommendedBy: { kind: "robot", name: "x" } }, { ...inboxRow, recommendedBy: null }, { ...inboxRow, reason: undefined },
    ]) {
      expect(parseEvalInboxOutput(ok({ version: 1, entries: [broken, inboxRow] })).entries, JSON.stringify(broken)).toEqual([narrowed]);
    }
    expect(parseEvalInboxOutput(ok({ version: 2, entries: [] })).problem).toMatch(/unexpected shape/);
    expect(parseEvalInboxOutput({ status: 0, stdout: "not json", stderr: "" })).toMatchObject({ entries: [], problem: expect.stringMatching(/unexpected shape/) });
    expect(parseEvalInboxOutput({ status: 1, stdout: "", stderr: "evals-inbox: the inbox at x is not JSON\n" })).toEqual({ entries: [], problem: "the inbox at x is not JSON" });
    expect(parseEvalInboxOutput({ status: null, stdout: "", stderr: "" }).problem).toBe("evals-inbox.ts list did not run without saying why");
  });

  it("reads each write's print, and a refusal as its reason with the prefix stripped", () => {
    expect(parseEvalInboxWrite(ok({ version: 1, entry: { ...inboxRow, plan: {} } }), "add")).toEqual({ ok: true, entry: narrowed });
    expect(parseEvalInboxWrite(ok({ version: 1, run: { id: "eval-9" }, removed: "rec-1a2b3c4d" }), "start")).toEqual({ ok: true, run: "eval-9", removed: "rec-1a2b3c4d" });
    expect(parseEvalInboxWrite(ok({ version: 1, removed: "rec-1a2b3c4d" }), "dismiss")).toEqual({ ok: true, removed: "rec-1a2b3c4d" });
    expect(parseEvalInboxWrite(ok({ version: 1, removed: "rec-1a2b3c4d" }), "start")).toMatchObject({ ok: false, why: expect.stringMatching(/start printed an unexpected shape/) });
    expect(parseEvalInboxWrite(ok({ version: 1, entry: { id: "rec-1" } }), "add")).toMatchObject({ ok: false });
    expect(parseEvalInboxWrite({ status: 1, stdout: "", stderr: "evals-inbox: no inbox entry rec-9\n" }, "dismiss")).toEqual({ ok: false, why: "no inbox entry rec-9" });
  });

  it("lists, adds with the plan on stdin and a default reason, starts and dismisses through evals-inbox.ts", async () => {
    const { evals, calls } = inboxAdapter({
      list: ok({ version: 1, entries: [inboxRow] }),
      add: ok({ version: 1, entry: inboxRow }),
      start: ok({ version: 1, run: { id: "eval-9" }, removed: "rec-1a2b3c4d" }),
      dismiss: ok({ version: 1, removed: "rec-1a2b3c4d" }),
    });
    expect(await evals.inbox()).toEqual({ entries: [narrowed], problem: null });
    expect(calls[0]).toMatchObject({ command: "/usr/bin/bun", args: ["/harness/evals-inbox.ts", "list"], cwd: "/srv/app", env: { RALPH_PROJECT: "/srv/app" } });
    const plan = { source: { kind: "pr", prs: [12] }, arms: ["opus"] };
    expect(await evals.inboxAdd({ plan })).toEqual({ ok: true, entry: narrowed });
    expect(calls[1]).toMatchObject({ args: ["/harness/evals-inbox.ts", "add", "--reason", "Added from the Run screen"], input: JSON.stringify(plan) });
    await evals.inboxAdd({ plan, reason: "worth a look" });
    expect(calls[2]!.args.slice(1)).toEqual(["add", "--reason", "worth a look"]);
    expect(await evals.inboxStart("rec-1a2b3c4d")).toEqual({ ok: true, run: "eval-9", removed: "rec-1a2b3c4d" });
    expect(calls[3]!.args.slice(1)).toEqual(["start", "rec-1a2b3c4d"]);
    expect(await evals.inboxDismiss("rec-1a2b3c4d")).toEqual({ ok: true, removed: "rec-1a2b3c4d" });
    expect(calls[4]!.args.slice(1)).toEqual(["dismiss", "rec-1a2b3c4d"]);
  });

  it("serves the routes, 200 on a refusal too, and 400s a bad body without calling the CLI", async () => {
    const { evals, calls } = inboxAdapter({
      list: ok({ version: 1, entries: [inboxRow] }),
      start: { status: 1, stdout: "", stderr: "evals-inbox: no lineup opus\n" },
      dismiss: ok({ version: 1, removed: "rec-1a2b3c4d" }),
    });
    expect(await (await route(evals, "GET", "/api/evals/inbox"))!.json()).toEqual({ entries: [narrowed], problem: null });
    for (const [path, body] of [
      ["/api/evals/inbox/add", {}],
      ["/api/evals/inbox/add", { plan: { source: { kind: "branch" } } }],
      ["/api/evals/inbox/add", { plan: { source: { kind: "pr", prs: [1] } }, reason: "x".repeat(501) }],
      ["/api/evals/inbox/start", { id: "rec-1a2b3c4d" }],
      ["/api/evals/inbox/dismiss", { entry: "../x" }],
    ] as const) {
      expect((await route(evals, "POST", path, body))!.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(calls).toHaveLength(1);
    const started = await route(evals, "POST", "/api/evals/inbox/start", { entry: "rec-1a2b3c4d" });
    expect(started!.status).toBe(200);
    expect(await started!.json()).toEqual({ ok: false, why: "no lineup opus" });
    expect(await (await route(evals, "POST", "/api/evals/inbox/dismiss", { entry: "rec-1a2b3c4d" }))!.json()).toEqual({ ok: true, removed: "rec-1a2b3c4d" });
    for (const path of ["/api/evals/inbox/add", "/api/evals/inbox/start", "/api/evals/inbox/dismiss"]) {
      expect((await route(evals, "GET", path))!.status, path).toBe(405);
    }
    expect((await route(evals, "POST", "/api/evals/inbox"))!.status).toBe(405);
  });
});

describe("the improver's propose (#873)", () => {
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const route = (evals: ReturnType<typeof setAdapter>["evals"], method: string, path: string, body?: unknown) =>
    handleEvalsRoute(
      new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }),
      path, evals,
    );
  /** A fake exec for evals-improve.ts, answering every call the same. */
  function improveAdapter(answer: { status: number | null; stdout: string; stderr: string }) {
    const calls: Invocation[] = [];
    const evals = createEvalsAdapter({
      cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun",
      exec: async (invocation) => { calls.push(invocation); return answer; },
    });
    return { evals, calls };
  }

  it("copies a started print field by field, and reads anything else as a refusal", () => {
    expect(parseEvalImproveOutput(ok({ ok: true, started: true, run: "eval-9", goal: "cost", log: "/srv/app/.ralph/x.log" })))
      .toEqual({ ok: true, started: true, run: "eval-9", goal: "cost" });
    for (const printed of [
      { ok: true, started: false, run: "eval-9", goal: "cost" }, { ok: true, started: true, run: 9, goal: "cost" },
      { ok: true, started: true, run: "eval-9", goal: "speed" }, { ok: true, proposal: "p-1" }, null,
    ]) {
      expect(parseEvalImproveOutput(ok(printed)), JSON.stringify(printed)).toMatchObject({ ok: false, why: expect.stringMatching(/propose printed an unexpected shape/) });
    }
    expect(parseEvalImproveOutput({ status: 0, stdout: "not json", stderr: "" })).toMatchObject({ ok: false });
  });

  it("answers a refusal without the evals-improve prefix, past a usage line", () => {
    expect(parseEvalImproveOutput({ status: 1, stdout: "", stderr: "evals-improve: run eval-9 has no analysis\n" }))
      .toEqual({ ok: false, why: "run eval-9 has no analysis" });
    expect(parseEvalImproveOutput({ status: 64, stdout: "", stderr: "evals-improve: propose needs --run <id>\nusage: evals-improve.ts propose --run <id>\n" }))
      .toEqual({ ok: false, why: "propose needs --run <id>" });
    expect(parseEvalImproveOutput({ status: null, stdout: "", stderr: "" })).toEqual({ ok: false, why: "evals-improve.ts propose did not run without saying why" });
  });

  it("runs evals-improve.ts propose detached in the project", async () => {
    const { evals, calls } = improveAdapter(ok({ ok: true, started: true, run: "eval-9", goal: "quality" }));
    expect(await evals.improvePropose({ run: "eval-9", goal: "quality" })).toEqual({ ok: true, started: true, run: "eval-9", goal: "quality" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/bun", args: ["/harness/evals-improve.ts", "propose", "--run", "eval-9", "--goal", "quality", "--detach"],
      cwd: "/srv/app", env: { RALPH_PROJECT: "/srv/app" },
    });
  });

  it("serves the route, 200 on a refusal too, and 400s a bad body without calling the CLI", async () => {
    const { evals, calls } = improveAdapter({ status: 1, stdout: "", stderr: "evals-improve: run eval-9 has no report\n" });
    for (const body of [{}, { run: "eval-9" }, { run: "eval-9", goal: "speed" }, { run: "../x", goal: "cost" }, { id: "eval-9", goal: "cost" }]) {
      expect((await route(evals, "POST", "/api/evals/improve/propose", body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const refused = await route(evals, "POST", "/api/evals/improve/propose", { run: "eval-9", goal: "cost" });
    expect(refused!.status).toBe(200);
    expect(await refused!.json()).toEqual({ ok: false, why: "run eval-9 has no report" });
    expect(calls[0]!.args.slice(1)).toEqual(["propose", "--run", "eval-9", "--goal", "cost", "--detach"]);
    expect((await route(evals, "GET", "/api/evals/improve/propose"))!.status).toBe(405);
  });
});

describe("the improver's proposals (#874)", () => {
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const verdict = { pass: false, conditions: [{ id: "solve-rate", pass: false, reason: "2/4, not over 2/4", extra: "x" }] };
  const proposalRow = {
    id: "prop-1", run: "eval-1", goal: "cost", kind: "lineup", status: "failed", verdict,
    reason: "the full set did not hold", createdAt: "2026-11-19T00:00:00Z", runs: { subset: "eval-2", full: "eval-3" },
    rationale: "sonnet solves the easy cases", answers: [{ knob: "lineup", target: "coder", change: "sonnet", arm: "lean", evidence: ["14"] }],
  };
  const narrowed = {
    id: "prop-1", run: "eval-1", goal: "cost", kind: "lineup", status: "failed",
    verdict: { pass: false, conditions: [{ id: "solve-rate", pass: false, reason: "2/4, not over 2/4" }] },
    reason: "the full set did not hold", createdAt: "2026-11-19T00:00:00Z", runs: { subset: "eval-2", full: "eval-3" },
    rationale: "sonnet solves the easy cases", answers: [{ knob: "lineup", target: "coder", change: "sonnet" }],
  };
  /** A fake exec for evals-proposals.ts, answering every call the same. */
  function proposalsAdapter(answer: { status: number | null; stdout: string; stderr: string }) {
    const calls: Invocation[] = [];
    const evals = createEvalsAdapter({
      cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun",
      exec: async (invocation) => { calls.push(invocation); return answer; },
    });
    return { evals, calls };
  }

  it("copies each row field by field: content, an overlay, files, a diff or a plan the CLI printed beside it never comes out", () => {
    const printed = {
      ...proposalRow, content: { "coder.md": "Always rebase" }, overlay: "/srv/app/.git/ralph-experiments/overlay", files: ["coder.md"],
      diff: "diff --git a/coder.md b/coder.md", plan: { arms: ["lean"] },
    };
    const view = parseEvalProposalsOutput(ok({ version: 1, details: true, proposals: [printed], problems: ["proposal x is not JSON", 3] }));
    expect(view).toEqual({ details: true, proposals: [narrowed], problems: ["proposal x is not JSON"], problem: null });
    expect(JSON.stringify(view)).not.toMatch(/diff --git|overlay|rebase/);
    const fresh = { ...proposalRow, status: "proposed", verdict: null, reason: null, runs: { subset: null, full: null } };
    expect(parseEvalProposalsOutput(ok({ version: 1, details: true, proposals: [fresh], problems: [] })).proposals[0]).toMatchObject({ verdict: null, reason: null, runs: { subset: null, full: null } });
  });

  it("drops rationale and answers on a summary-only print, even one that over-shares", () => {
    const view = parseEvalProposalsOutput(ok({ version: 1, details: false, proposals: [proposalRow], problems: [] }));
    expect(view.details).toBe(false);
    expect(view.proposals[0]).not.toHaveProperty("rationale");
    expect(view.proposals[0]).not.toHaveProperty("answers");
    // Details present but no rationale printed: nothing invented.
    const bare = { ...proposalRow, rationale: undefined, answers: undefined };
    expect(Object.keys(parseEvalProposalsOutput(ok({ version: 1, details: true, proposals: [bare], problems: [] })).proposals[0]!)).not.toContain("rationale");
  });

  it("drops a row whose required field is off, and reads a print it cannot parse as a problem", () => {
    for (const broken of [
      null, "prop-1", { ...proposalRow, id: 3 }, { ...proposalRow, goal: "speed" }, { ...proposalRow, kind: "patch" }, { ...proposalRow, status: "done" },
      { ...proposalRow, verdict: { pass: true, conditions: [{ id: "x" }] } }, { ...proposalRow, verdict: undefined }, { ...proposalRow, reason: 4 },
      { ...proposalRow, runs: { subset: 1, full: null } }, { ...proposalRow, runs: null }, { ...proposalRow, createdAt: undefined },
    ]) {
      expect(parseEvalProposalsOutput(ok({ version: 1, details: true, proposals: [broken, proposalRow], problems: [] })).proposals, JSON.stringify(broken)).toEqual([narrowed]);
    }
    expect(parseEvalProposalsOutput(ok({ version: 2, proposals: [] })).problem).toMatch(/unexpected shape/);
    expect(parseEvalProposalsOutput({ status: 0, stdout: "not json", stderr: "" })).toEqual({
      details: false, proposals: [], problems: [], problem: expect.stringMatching(/evals-proposals.ts list printed an unexpected shape: not json/),
    });
    expect(parseEvalProposalsOutput({ status: 1, stdout: "", stderr: "evals-proposals: Error: no experiments here\n" })).toEqual({ details: false, proposals: [], problems: [], problem: "no experiments here" });
    expect(parseEvalProposalsOutput({ status: null, stdout: "", stderr: "" }).problem).toBe("evals-proposals.ts list did not run without saying why");
  });

  it("serves GET /api/evals/proposals through evals-proposals.ts list for the project, and 405s a POST", async () => {
    const { evals, calls } = proposalsAdapter(ok({ version: 1, details: true, proposals: [proposalRow], problems: [] }));
    const response = await handleEvalsRoute(new Request("http://127.0.0.1/api/evals/proposals"), "/api/evals/proposals", evals);
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ details: true, proposals: [narrowed], problems: [], problem: null });
    expect(calls[0]).toMatchObject({ command: "/usr/bin/bun", args: ["/harness/evals-proposals.ts", "list", "--project", "/srv/app"], cwd: "/srv/app", env: { RALPH_PROJECT: "/srv/app" } });
    const posted = await handleEvalsRoute(new Request("http://127.0.0.1/api/evals/proposals", { method: "POST", body: "{}" }), "/api/evals/proposals", evals);
    expect(posted!.status).toBe(405);
    expect(calls).toHaveLength(1);
  });
});

describe("opening a passed proposal's PR (#875)", () => {
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const printed = (kind: "opened" | "exists") => ({ version: 1, kind, number: 912, url: "https://github.com/acme/ralph/pull/912", proposal: "prop-1a2b3c4d", autoMerge: false });
  const answer = (kind: "opened" | "exists") => ({ ok: true, kind, number: 912, url: "https://github.com/acme/ralph/pull/912", proposal: "prop-1a2b3c4d", autoMerge: false });
  const route = (evals: ReturnType<typeof setAdapter>["evals"], method: string, path: string, body?: unknown) =>
    handleEvalsRoute(
      new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }),
      path, evals,
    );
  /** A fake exec for evals-proposals.ts, answering every call the same. */
  function openPrAdapter(answered: { status: number | null; stdout: string; stderr: string }) {
    const calls: Invocation[] = [];
    const evals = createEvalsAdapter({
      cliDir: "/harness", root: "/srv/app", bunPath: "/usr/bin/bun",
      exec: async (invocation) => { calls.push(invocation); return answered; },
    });
    return { evals, calls };
  }

  it("runs evals-proposals.ts open-pr for the project under the long timeout, and answers an opened PR", async () => {
    const { evals, calls } = openPrAdapter(ok({ ...printed("opened"), branch: "ralph/proposal-prop-1a2b3c4d" }));
    expect(await evals.openProposalPr({ proposal: "prop-1a2b3c4d" })).toEqual(answer("opened"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/bun", args: ["/harness/evals-proposals.ts", "open-pr", "prop-1a2b3c4d", "--project", "/srv/app"],
      cwd: "/srv/app", env: { RALPH_PROJECT: "/srv/app" }, timeoutMs: EVALS_PROPOSAL_OPEN_PR_TIMEOUT_MS,
    });
  });

  it("answers a PR already open as exists", async () => {
    const { evals } = openPrAdapter(ok({ ...printed("exists"), autoMerge: true }));
    expect(await evals.openProposalPr({ proposal: "prop-1a2b3c4d" })).toEqual({ ...answer("exists"), autoMerge: true });
  });

  it("answers a refusal on exit 1 with the CLI's reason, without its prefix, past a usage line", async () => {
    const { evals } = openPrAdapter({ status: 1, stdout: "", stderr: "evals-proposals: proposal prop-1a2b3c4d is failed: only a passed proposal opens a PR\n" });
    expect(await evals.openProposalPr({ proposal: "prop-1a2b3c4d" })).toEqual({ ok: false, why: "proposal prop-1a2b3c4d is failed: only a passed proposal opens a PR" });
    expect(parseEvalOpenPrOutput({ status: 64, stdout: "", stderr: "evals-proposals: open-pr needs a proposal id\nusage: evals-proposals.ts list\n" }))
      .toEqual({ ok: false, why: "open-pr needs a proposal id" });
    expect(parseEvalOpenPrOutput({ status: null, stdout: "", stderr: "" })).toEqual({ ok: false, why: "evals-proposals.ts open-pr did not run without saying why" });
  });

  it("reads a print it cannot parse as a refusal", () => {
    for (const bad of [
      { ...printed("opened"), version: 2 }, { ...printed("opened"), kind: "merged" }, { ...printed("opened"), number: "912" }, { ...printed("opened"), number: 0 },
      { ...printed("opened"), url: null }, { ...printed("opened"), proposal: 3 }, { ...printed("opened"), autoMerge: "no" }, null,
    ]) {
      expect(parseEvalOpenPrOutput(ok(bad)), JSON.stringify(bad)).toMatchObject({ ok: false, why: expect.stringMatching(/open-pr printed an unexpected shape/) });
    }
    expect(parseEvalOpenPrOutput({ status: 0, stdout: "not json", stderr: "" })).toMatchObject({ ok: false });
  });

  it("serves the route, 200 on a refusal too, and 400s a bad body without calling the CLI", async () => {
    const { evals, calls } = openPrAdapter({ status: 1, stdout: "", stderr: "evals-proposals: no proposal prop-00000000\n" });
    for (const body of [{}, { proposal: "" }, { proposal: "../x" }, { proposal: "--project" }, { proposal: "prop-1" }, { id: "prop-1a2b3c4d" }, { proposal: 3 }]) {
      expect((await route(evals, "POST", "/api/evals/proposals/open-pr", body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const refused = await route(evals, "POST", "/api/evals/proposals/open-pr", { proposal: "prop-00000000", id: "3f9c1e2a", via: "remote" });
    expect(refused!.status).toBe(200);
    expect(await refused!.json()).toEqual({ ok: false, why: "no proposal prop-00000000" });
    expect(calls[0]!.args.slice(1)).toEqual(["open-pr", "prop-00000000", "--project", "/srv/app"]);
    expect((await route(evals, "GET", "/api/evals/proposals/open-pr"))!.status).toBe(405);
  });
});
