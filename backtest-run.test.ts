// @vitest-environment node
/**
 * The backtest batch runner against a stub sandbox: scripted trial results, a
 * fake clock, and (for the lease) the real host lease store on a temp path.
 * Nothing here spawns a process, so no subprocessSuite.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { OPUS_ALONE_NOTE, type BacktestConfig, type BacktestSample, type BacktestTicket } from "./backtest";
import type { ArmResolution } from "./backtest-report";
import { LEASE_RETRY_MS, panelNotes, runBacktest, type ArmSpec, type BacktestRunDeps, type TrialHandle } from "./backtest-run";
import { acquire, parsePolicy, readStore, releaseRun, withStore, type LeaseRequest } from "./host-lease";
import { buildSetSample } from "./eval-set-source";
import { parseCase, type CaseStatus, type EvalCase } from "./evals-set";
import { scratchDir } from "./test-scratch";
import type { TrialResult } from "./trial-sandbox";

const T0 = Date.parse("2026-10-28T10:00:00Z");

/** A stored test set case (#854), through the real parser. */
const setCase = (pr: number, status: CaseStatus): EvalCase => parseCase({
  v: 1, id: `acme-app-${pr}`, kind: "coder", repo: "acme/app",
  prs: [{ number: pr, url: `https://example.invalid/${pr}`, createdAt: "2026-10-28T01:00:00Z", mergedAt: "2026-10-28T02:00:00Z", headRefName: "fix", firstCommit: "f1", headRefOid: "h1" }],
  baseCommit: `base-${pr}`, startedAt: "2026-10-28T01:00:00Z",
  ticket: { ref: `#${pr + 100}`, title: "Fix it", body: "It is broken", comments: [], dropped: 0 },
  reference: "person", heldOut: [], tags: ["ui"], reason: "a clean bugfix", notes: "", status, addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe",
});
const MINUTE = 60_000;

const config = (overrides: Partial<BacktestConfig> = {}): BacktestConfig => ({
  project: "/srv/project",
  clerk: "clara",
  sample: { cap: 2, since: null, repos: null },
  lineup: "opus-only",
  caps: { trialMinutes: 30, batchMinutes: 600 },
  rates: null,
  sources: {},
  scoring: { testGlobs: ["**/*.test.ts"], testCommand: "npx vitest run {file}", setup: null, review: true, judge: null },
  ...overrides,
});

const ticket = (oaKey: string): BacktestTicket => ({
  oaKey,
  intakeKey: null,
  movedAt: "2026-10-01T00:00:00Z",
  repo: "acme/app",
  humanPrs: [],
  mergeBase: "abc123",
  startedAt: "2026-10-02T00:00:00Z",
  ticketRef: oaKey,
  comments: { kept: 0, dropped: 0 },
  frozen: { title: `Fix ${oaKey}`, body: "the body", comments: [] },
});

const sample = (keys = ["OA-1", "OA-2"], c: string | null = "opus-only"): BacktestSample => ({
  tickets: keys.map(ticket),
  skipped: [{ oaKey: "OA-9", intakeKey: null, reason: "no merged PR" }],
  notes: ["a note"],
  arms: { b: "live lineup", c },
});

const greenResult = (logs: TrialResult["logs"] = []): TrialResult => ({
  outcome: { kind: "finished", exit: 0, sigil: "<promise>COMPLETE</promise>" },
  failures: [],
  base: "abc123",
  finalHead: "def456",
  patch: "diff --git a/x b/x\n",
  logs,
  tracker: null,
  github: { prs: [{ number: 1, headRefOid: "def456", heads: [{ sha: "def456", checks: [{ name: "ci", conclusion: "SUCCESS" }] }], reviewThreads: [] }] },
  models: [],
  review: null,
});

const rejectedLog = (resetsAt: number, path = "logs/iter-20261028T020000Z-41-1.events.jsonl"): TrialResult["logs"][number] => ({
  path,
  text: JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", isUsingOverage: false, resetsAt } }),
});
const quietLog = (path: string): TrialResult["logs"][number] => ({ path, text: JSON.stringify({ type: "result", subtype: "success" }) });

/** A run the supervisor ended without a sigil: the only kind a usage limit can have cut short. */
const limitedResult = (logs: TrialResult["logs"]): TrialResult => ({ ...greenResult(logs), outcome: { kind: "finished", exit: 1, sigil: null } });

interface Script {
  /** Minutes the trial would run for; over its timeout it is killed at the timeout. */
  minutes?: number;
  result?: (clock: number) => TrialResult;
  partial?: string;
  onStart?: () => void;
  onRun?: () => void | Promise<void>;
  keep?: (path: string) => void;
}

/** Deps over a fake clock; `scripts` is consumed one per started trial, in order. */
function stubDeps(runDir: string, scripts: Script[] = [], overrides: Partial<BacktestRunDeps> = {}) {
  const clock = { now: T0 };
  const started: string[] = [];
  const arms: ArmSpec[] = [];
  const disposed: string[] = [];
  const kept: string[] = [];
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  const lines: string[] = [];
  let next = 0;
  const deps: BacktestRunDeps = {
    runDir,
    startTrial: async (t: BacktestTicket, arm: ArmSpec): Promise<TrialHandle> => {
      const name = `${t.oaKey}/${arm.arm}`;
      started.push(name);
      arms.push(arm);
      const script = scripts[next++] ?? {};
      script.onStart?.();
      // Per handle: a rerun of the same trial is a new handle, kept before its own dispose.
      let gone = false;
      return {
        run: async ({ timeoutMs, signal }) => {
          timeouts.push(timeoutMs);
          await script.onRun?.();
          const wanted = (script.minutes ?? 5) * MINUTE;
          if (wanted > timeoutMs) {
            clock.now += timeoutMs;
            return { ...greenResult(), outcome: { kind: "timeout", exit: null, sigil: null }, finalHead: null, patch: "", github: null };
          }
          clock.now += wanted;
          if (signal.aborted) return { ...greenResult(), outcome: { kind: "aborted", exit: null, sigil: null } };
          return script.result?.(clock.now) ?? greenResult();
        },
        partialPatch: () => script.partial ?? "",
        keep: (path) => {
          if (gone) throw new Error(`${name}: kept after dispose`);
          kept.push(path);
          script.keep?.(path);
        },
        dispose: () => { gone = true; disposed.push(name); },
      };
    },
    lease: { acquire: async () => ({ ok: true }), release: async () => {} },
    now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.now += ms; },
    log: (line) => { lines.push(line); },
    ...overrides,
  };
  return { deps, clock, started, arms, disposed, kept, sleeps, timeouts, lines };
}

const runDirIn = (): { parent: string; runDir: string } => {
  const parent = scratchDir("backtest-run-");
  return { parent, runDir: join(parent, "run") };
};

const stateRows = (runDir: string): string[] =>
  Object.keys((JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as { rows: Record<string, unknown> }).rows);

describe("panelNotes", () => {
  it("adds the Opus-alone note once, and a rescore with a Codex model drops a batch's stale one (#817)", () => {
    const scoring = { ...config().scoring, judge: { model: "claude-opus-5-5", seed: null, defaultPanel: true as const } };
    const defaulted = config({ scoring });
    expect(panelNotes(["kept"], defaulted, null)).toEqual(["kept", OPUS_ALONE_NOTE]);
    expect(panelNotes(["kept", OPUS_ALONE_NOTE], defaulted, null)).toEqual(["kept", OPUS_ALONE_NOTE]);
    expect(panelNotes(["kept", OPUS_ALONE_NOTE], defaulted, "gpt-x")).toEqual(["kept"]);
  });
});

describe("runBacktest", () => {
  it("runs both arms of each ticket alternating the order, and writes the report", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    const report = await runBacktest(sample(), config(), stub.deps);
    expect(stub.started).toEqual(["OA-1/b", "OA-1/c", "OA-2/c", "OA-2/b"]);
    expect(stub.disposed).toEqual(stub.started);
    expect(report.rows.map((row) => `${row.ticket}/${row.arm}/${row.outcome}`)).toEqual(["OA-1/b/green-pr", "OA-1/c/green-pr", "OA-2/c/green-pr", "OA-2/b/green-pr"]);
    expect(report.rows.find((row) => row.arm === "c")?.lineup).toBe("opus-only");
    expect(report.skipped).toEqual([{ oaKey: "OA-9", reason: "no merged PR" }]);
    expect(report.notes).toEqual(["a note"]);
    expect(report.stoppedBy).toBeNull();
    expect(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"))).toEqual(report);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("# Backtest ");
    expect(stateRows(runDir)).toEqual(["OA-1/b", "OA-1/c", "OA-2/c", "OA-2/b"]);
    const ticketJson = JSON.parse(readFileSync(join(runDir, "OA-1", "b", "ticket.json"), "utf8")) as Record<string, unknown>;
    expect(ticketJson).toMatchObject({ mergeBase: "abc123", startedAt: "2026-10-02T00:00:00Z", ticketRef: "OA-1", frozen: { title: "Fix OA-1" } });
    expect(readFileSync(join(runDir, "OA-1", "b", "patch.diff"), "utf8")).toBe("diff --git a/x b/x\n");
  });

  it("runs only arm B when the config names no lineup", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    await runBacktest({ ...sample(), arms: { b: "live lineup", c: null } }, config({ lineup: null }), stub.deps);
    expect(stub.started).toEqual(["OA-1/b", "OA-2/b"]);
  });

  it("runs a test set from its sampler through the engine: the version and selection reach the report, the unrunnable case its reasons (#854)", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    const setConfig = config({ lineup: null, source: { kind: "set", tags: [], cases: [] }, repeats: 0, sources: { "acme/app": "/srv/app" } });
    const sampled = await buildSetSample(setConfig, {
      readSet: () => ({ version: "abc1234", cases: [setCase(1, "active"), setCase(2, "saturated"), setCase(3, "retired")] }),
      unrunnable: async (c) => (c.id === "acme-app-2" ? "base commit base-2 is not in /srv/app" : null),
    });
    const report = await runBacktest(sampled, setConfig, stub.deps);
    // The retired case is never selected, the unrunnable one never started.
    expect(stub.started).toEqual(["acme-app-1/b"]);
    expect(report.set).toEqual({ version: "abc1234", selected: ["acme-app-1", "acme-app-2"] });
    expect(report.skipped).toEqual([{ oaKey: "acme-app-2", reason: "base commit base-2 is not in /srv/app" }]);
    expect(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"))).toMatchObject({ set: report.set });
    const markdown = readFileSync(join(runDir, "report.md"), "utf8");
    expect(markdown).toContain("Test set abc1234: 2 cases selected.");
    expect(markdown).toContain("## Unrunnable");
    expect(markdown).toContain("acme-app-2: base commit base-2 is not in /srv/app");
    // A sample without a set writes no set.
    const plain = await runBacktest(sample(), config(), stubDeps(runDirIn().runDir).deps);
    expect(plain.set).toBeUndefined();
  });

  it("runs every named arm, rotating which goes first per ticket, with each arm's lineup and overlay (#801)", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    const arms = [
      { name: "opus", lineup: "live", overlay: null },
      { name: "sonnet", lineup: "sonnet-coder", overlay: null },
      { name: "short", lineup: "live", overlay: "/srv/overlays/short" },
    ];
    const report = await runBacktest({ ...sample(["OA-1", "OA-2", "OA-3"]), arms }, config({ lineup: null, arms }), stub.deps);
    expect(stub.started).toEqual([
      "OA-1/opus", "OA-1/sonnet", "OA-1/short",
      "OA-2/sonnet", "OA-2/short", "OA-2/opus",
      "OA-3/short", "OA-3/opus", "OA-3/sonnet",
    ]);
    expect(stub.arms.find((arm) => arm.arm === "short")).toEqual({ arm: "short", lineup: "live", overlay: "/srv/overlays/short" });
    expect(report.rows.find((row) => row.arm === "sonnet")?.lineup).toBe("sonnet-coder");
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("Arms: opus (live lineup); sonnet (lineup sonnet-coder); short (live lineup, prompt overlay /srv/overlays/short).");
  });

  it("records each arm's resolved models from its first trial, the panel and the seed: a named lineup and live differ (#816)", async () => {
    const { runDir } = runDirIn();
    const arms = [
      { name: "opus", lineup: "live", overlay: null },
      { name: "sonnet", lineup: "sonnet-coder", overlay: null },
      { name: "short", lineup: "live", overlay: "/srv/overlays/short" },
    ];
    const resolution = (arm: ArmSpec, built: number): ArmResolution => ({
      stages: [{ stage: "coder", runner: "claude", model: arm.lineup === "live" ? "claude-opus-5-5" : "claude-sonnet-5-5", effort: built === 0 ? "high" : "low" }],
      overlayHash: arm.overlay ? "3f2a" : null,
    });
    const built: Record<string, number> = {};
    const stub = stubDeps(runDir);
    const startTrial = stub.deps.startTrial;
    const panel = [{ name: "opus", runner: "claude" as const, model: "claude-opus-5-5" }, { name: "gpt", runner: "codex" as const, model: "gpt-5.5" }];
    const scoring = { ...config().scoring, judge: { model: "claude-opus-5-5", seed: "s-1", panel } };
    const report = await runBacktest({ ...sample(["OA-1", "OA-2"]), arms }, config({ lineup: null, arms, scoring }), {
      ...stub.deps,
      // A later build reporting another effort must not replace the first one's record.
      startTrial: async (t, arm) => {
        const n = built[arm.arm] ?? 0;
        built[arm.arm] = n + 1;
        return { ...(await startTrial(t, arm)), resolved: resolution(arm, n) };
      },
    });
    const expected = {
      arms: {
        opus: { stages: [{ stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: "high" }], overlayHash: null },
        sonnet: { stages: [{ stage: "coder", runner: "claude", model: "claude-sonnet-5-5", effort: "high" }], overlayHash: null },
        short: { stages: [{ stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: "high" }], overlayHash: "3f2a" },
      },
      panel: [{ name: "opus", runner: "claude", model: "claude-opus-5-5" }, { name: "gpt", runner: "codex", model: "gpt-5.5" }],
      seed: "s-1",
    };
    expect(report.resolved).toEqual(expected);
    expect(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")).resolved).toEqual(expected);
    const md = readFileSync(join(runDir, "report.md"), "utf8");
    expect(md).toContain("Arm opus: coder claude claude-opus-5-5 (high).");
    expect(md).toContain("Arm sonnet: coder claude claude-sonnet-5-5 (high).");
    expect(md).toContain("Arm short: coder claude claude-opus-5-5 (high). Overlay sha256 3f2a.");
    expect(md).toContain("Panel: opus (claude claude-opus-5-5), gpt (codex gpt-5.5). Seed s-1.");
  });

  it("keeps the first resolution on a resume, and seeds a default panel by the run id (#816)", async () => {
    const { runDir } = runDirIn();
    const scoring = { ...config().scoring, judge: { model: "claude-opus-5-5", seed: null } };
    const first = stubDeps(runDir, [{}, {}, {}, { onStart: () => { throw new Error("clone failed"); } }]);
    const startFirst = first.deps.startTrial;
    const was: ArmResolution = { stages: [{ stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: null }], overlayHash: null };
    await runBacktest(sample(), config({ scoring }), { ...first.deps, startTrial: async (t, arm) => ({ ...(await startFirst(t, arm)), ...(arm.arm === "b" ? { resolved: was } : {}) }) });
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as { id: string; resolved: Record<string, ArmResolution> };
    expect(state.resolved).toEqual({ b: was });

    const rerun = stubDeps(runDir);
    const startRerun = rerun.deps.startTrial;
    const now: ArmResolution = { stages: [{ stage: "coder", runner: "codex", model: "gpt-5.5", effort: "high" }], overlayHash: null };
    const report = await runBacktest(sample(), config({ scoring }), { ...rerun.deps, startTrial: async (t, arm) => ({ ...(await startRerun(t, arm)), resolved: now }) });
    expect(rerun.started).toEqual(["OA-2/b"]);
    expect(report.resolved).toEqual({ arms: { b: was }, panel: [{ name: "claude-opus-5-5", runner: "claude", model: "claude-opus-5-5" }], seed: state.id });
  });

  it("judges a config that names no judge with Opus and the Codex model, and notes Opus alone when there is none (#817)", async () => {
    const scoring = { ...config().scoring, judge: { model: "claude-opus-5-5", seed: null, defaultPanel: true as const } };
    const both = await runBacktest(sample(), config({ scoring }), { ...stubDeps(runDirIn().runDir).deps, codexModel: "gpt-x" });
    expect(both.resolved?.panel).toEqual([{ name: "opus", runner: "claude", model: "claude-opus-5-5" }, { name: "gpt", runner: "codex", model: "gpt-x" }]);
    expect(both.notes.some((note) => note.includes("Opus alone"))).toBe(false);

    const { runDir } = runDirIn();
    const alone = await runBacktest(sample(), config({ scoring }), { ...stubDeps(runDir).deps, codexModel: null });
    expect(alone.resolved?.panel).toEqual([{ name: "opus", runner: "claude", model: "claude-opus-5-5" }]);
    expect(alone.notes.filter((note) => note.includes("Opus alone"))).toHaveLength(1);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("Opus alone");
  });

  it("records the panel and seed but no arms when the starter reports nothing, and no panel when the judge is off (#816)", async () => {
    const { runDir } = runDirIn();
    const report = await runBacktest(sample(), config(), stubDeps(runDir).deps);
    expect(report.resolved).toEqual({ arms: {}, panel: [], seed: null });
    const md = readFileSync(join(runDir, "report.md"), "utf8");
    expect(md).toContain("Arm B: models not recorded.");
    expect(md).toContain("Panel: off.");
    expect((JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as Record<string, unknown>).resolved).toBeUndefined();
  });

  it("repeats only the cases whose arms disagree, k more times per arm, and keeps them out of the state's first trials (#801)", async () => {
    const { runDir } = runDirIn();
    const red = (): TrialResult => ({ ...greenResult(), outcome: { kind: "finished", exit: 0, sigil: "<ralph>RETRY_LATER</ralph>" },
      github: { prs: [{ number: 1, headRefOid: "def456", heads: [{ sha: "def456", checks: [{ name: "ci", conclusion: "FAILURE" }] }], reviewThreads: [] }] } });
    // OA-1: b green, c red — they disagree. OA-2: both green. Repeats: OA-1 twice more per arm.
    const stub = stubDeps(runDir, [{}, { result: red }, {}, {}, {}, { result: red }, {}, {}]);
    const arms = [{ name: "b", lineup: "live", overlay: null }, { name: "c", lineup: "opus-only", overlay: null }];
    const report = await runBacktest({ ...sample(), arms }, config({ lineup: null, arms, repeats: 2 }), stub.deps);
    expect(stub.started).toEqual(["OA-1/b", "OA-1/c", "OA-2/c", "OA-2/b", "OA-1/b", "OA-1/c", "OA-1/b", "OA-1/c"]);
    expect(report.rows.filter((row) => row.repeat !== undefined).map((row) => `${row.ticket}/${row.arm}/r${row.repeat}/${row.outcome}`))
      .toEqual(["OA-1/b/r1/green-pr", "OA-1/c/r1/failed", "OA-1/b/r2/green-pr", "OA-1/c/r2/green-pr"]);
    expect(stateRows(runDir)).toContain("OA-1/c/r2");
    expect(existsSync(join(runDir, "OA-1", "c-r2", "result.json"))).toBe(true);
    const md = readFileSync(join(runDir, "report.md"), "utf8");
    // Unscored here: green runs per arm, nothing judged yet, and the first trial's outcome.
    expect(md).toContain("| OA-1 | B | 3/3 | 0 | — | — | — | — | — | green-pr, not judged |");
    expect(md).toContain("| OA-1 | C | 1/3 | 0 | — | — | — | — | — | failed, not judged |");
    // The summary counts each case once: 2 of 2 for b, 1 of 2 for c.
    expect(md).toContain("- Arm B: 2/2 green PRs");
    expect(md).toContain("- Arm C: 1/2 green PRs");

    // A rerun resumes: nothing runs again.
    const again = stubDeps(runDir);
    await runBacktest({ ...sample(), arms }, config({ lineup: null, arms, repeats: 2 }), again.deps);
    expect(again.started).toEqual([]);
  });

  it("repeats a case the caller names, such as one the panel contested, even when its arms agreed", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    await runBacktest(sample(["OA-1"], null), config({ lineup: null, repeats: 1 }), stub.deps, { repeatCases: ["OA-1"] });
    expect(stub.started).toEqual(["OA-1/b", "OA-1/b"]);
  });

  it("repeats nothing with repeats 0, the default of a clerk backtest", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [{}, { result: () => ({ ...greenResult(), github: null, finalHead: null }) }]);
    await runBacktest(sample(["OA-1"]), config(), stub.deps, { repeatCases: ["OA-1"] });
    expect(stub.started).toEqual(["OA-1/b", "OA-1/c"]);
  });

  it("waits for a full Claude window to reset before a trial, outside the batch cap, and runs on no reading (#801)", async () => {
    const { runDir } = runDirIn();
    const readings = [
      { usedPercent: 95, window: "Session", resetsAt: new Date(T0 + 40 * MINUTE).toISOString() },
      { usedPercent: 95, window: "Session", resetsAt: new Date(T0 + 40 * MINUTE).toISOString() },
      { usedPercent: 12, window: "Session", resetsAt: null },
      null,
    ];
    const stub = stubDeps(runDir, [], { usage: () => readings.shift() ?? null });
    // A 30-minute batch: the 41 minutes waited are the provider's, so the trial still runs.
    const report = await runBacktest(sample(["OA-1", "OA-2"], null), config({ lineup: null, caps: { trialMinutes: 10, batchMinutes: 30 } }), stub.deps);
    expect(stub.sleeps).toEqual([15 * MINUTE, 15 * MINUTE]);
    expect(report.rows.map((row) => row.outcome)).toEqual(["green-pr", "green-pr"]);
    expect(stub.lines.some((line) => line.includes("Claude Session window 95% used, at or over the 90% limit"))).toBe(true);
  });

  it("runs the trial anyway after six hours of a reading that never drops, and on a sleep that fails", async () => {
    const { runDir } = runDirIn();
    // A stale reading whose reset is long past: the guard would reread every minute without end.
    const stale = { usedPercent: 99, window: "Weekly", resetsAt: new Date(T0 - 60 * MINUTE).toISOString() };
    const stub = stubDeps(runDir, [], { usage: () => stale });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stub.deps);
    expect(stub.started).toEqual(["OA-1/b"]);
    expect(stub.sleeps.reduce((a, b) => a + b, 0)).toBe(6 * 60 * MINUTE);
    expect(stub.lines.some((line) => line.includes("after 6 hours of waiting; running anyway"))).toBe(true);

    const broken = stubDeps(runDirIn().runDir, [], { usage: () => stale, sleep: async () => { throw new Error("no timers"); } });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), broken.deps);
    expect(broken.started).toEqual(["OA-1/b"]);
  });

  it("waits on Codex's window when an arm's lineup runs on Codex, and on Claude's too (#822)", async () => {
    const { runDir } = runDirIn();
    const codex = [
      { usedPercent: 93, window: "Weekly", resetsAt: new Date(T0 + 10 * MINUTE).toISOString() },
      { usedPercent: 20, window: "Weekly", resetsAt: null },
    ];
    const asked: string[] = [];
    const stub = stubDeps(runDir, [], {
      armRunners: ["claude", "codex"],
      usage: (runner) => {
        asked.push(runner);
        return runner === "codex" ? (codex.shift() ?? null) : { usedPercent: 40, window: "Session", resetsAt: null };
      },
    });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stub.deps);
    expect(stub.sleeps).toEqual([11 * MINUTE]);
    expect(stub.started).toEqual(["OA-1/b"]);
    expect(asked.slice(0, 4)).toEqual(["claude", "codex", "claude", "codex"]);
    expect(stub.lines.some((line) => line.includes("Codex Weekly window 93% used, at or over the 90% limit"))).toBe(true);
  });

  it("waits on Codex's window when a judge runs on Codex, and keeps the six-hour bound (#822)", async () => {
    const { runDir } = runDirIn();
    const panel = [{ name: "opus", runner: "claude" as const, model: "claude-opus-5-5" }, { name: "gpt", runner: "codex" as const, model: "gpt-x" }];
    const scoring = { ...config().scoring, judge: { model: "claude-opus-5-5", seed: null, panel } };
    const stuck = { usedPercent: 100, window: "Session", resetsAt: null };
    const stub = stubDeps(runDir, [], { usage: (runner) => (runner === "codex" ? stuck : null) });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null, scoring }), stub.deps);
    expect(stub.started).toEqual(["OA-1/b"]);
    expect(stub.sleeps.reduce((a, b) => a + b, 0)).toBe(6 * 60 * MINUTE);
    expect(stub.lines.some((line) => line.includes("the Codex Session window still reads 100% after 6 hours of waiting; running anyway"))).toBe(true);
  });

  it("ignores Codex's reading when only Claude runs, and runs when Codex cannot be read (#822)", async () => {
    const { runDir } = runDirIn();
    const asked: string[] = [];
    const full = { usedPercent: 100, window: "Weekly", resetsAt: null };
    const claudeOnly = stubDeps(runDir, [], { armRunners: ["claude"], usage: (runner) => { asked.push(runner); return runner === "codex" ? full : null; } });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), claudeOnly.deps);
    expect(asked).toEqual(["claude"]);
    expect(claudeOnly.sleeps).toEqual([]);
    expect(claudeOnly.started).toEqual(["OA-1/b"]);

    // An unreadable Codex guards nothing, and a missing reading runs the trial as before the guard.
    const unread = stubDeps(runDirIn().runDir, [], {
      armRunners: ["codex"],
      usage: (runner) => { if (runner === "codex") throw new Error("codexbar: codex failed"); return null; },
    });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), unread.deps);
    expect(unread.sleeps).toEqual([]);
    expect(unread.started).toEqual(["OA-1/b"]);
    expect(unread.lines.some((line) => line.includes("Codex usage not read (codexbar: codex failed)"))).toBe(true);
  });

  it("does not guard when the config turns the guard off", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [], { usage: () => ({ usedPercent: 100, window: "Weekly", resetsAt: null }) });
    await runBacktest(sample(["OA-1"], null), config({ lineup: null, usageGuard: null }), stub.deps);
    expect(stub.sleeps).toEqual([]);
    expect(stub.started).toEqual(["OA-1/b"]);
  });

  it("holds the real host lease around each trial and releases it after", async () => {
    const { runDir } = runDirIn();
    const store = join(scratchDir("backtest-lease-"), "ralph-host-lease.json");
    const policy = { ...parsePolicy({}), perTicket: 100, asksPerTicket: 100, loopCooldownSeconds: 0, spacingSeconds: 0, idleReads: 1 };
    let run = "";
    let n = 0;
    const holders: (string | null)[] = [];
    const stub = stubDeps(runDir, Array.from({ length: 4 }, () => ({ onRun: () => { holders.push(readStore(store).holder?.run ?? null); } })));
    const lease: BacktestRunDeps["lease"] = {
      acquire: async (t) => {
        run = `backtest-${t.oaKey}-${n++}`;
        const number = Number(t.oaKey.replace(/^\D+-/, ""));
        const request: LeaseRequest = {
          ticket: number, command: "a backtest trial of the ticket", criterion: "a backtest compares two lineups",
          whyNotCi: "a trial is an agent run, not a CI job", fenceEvidence: "the trial clones and runs gates locally",
        };
        const result = await acquire(request, number, {
          path: store, party: { run, loop: "backtest", pid: process.pid, host: "box" }, policy,
          now: () => stub.clock.now, sleep: async () => {}, alive: () => true, ci: () => ({ busy: false, detail: "idle" }), log: () => {},
        });
        return result.outcome === "granted" ? { ok: true } : { ok: false, why: result.detail };
      },
      release: async () => { await withStore(store, (s) => releaseRun(s, run, stub.clock.now)); },
    };
    await runBacktest(sample(), config(), { ...stub.deps, lease });
    expect(holders).toEqual(["backtest-OA-1-0", "backtest-OA-1-1", "backtest-OA-2-2", "backtest-OA-2-3"]);
    expect(readStore(store).holder).toBeNull();
  });

  it("asks again for a lease not granted, every five minutes, and runs the same trial once granted", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    let asks = 0;
    const lease: BacktestRunDeps["lease"] = {
      acquire: async () => (++asks <= 2 ? { ok: false, why: "refused: the queue is full" } : { ok: true }),
      release: async () => {},
    };
    const report = await runBacktest(sample(["OA-1"], null), config({ lineup: null }), { ...stub.deps, lease });
    expect(stub.sleeps).toEqual([LEASE_RETRY_MS, LEASE_RETRY_MS]);
    expect(stub.started).toEqual(["OA-1/b"]);
    expect(report.rows).toMatchObject([{ ticket: "OA-1", outcome: "green-pr" }]);
    expect(stateRows(runDir)).toEqual(["OA-1/b"]);
  });

  it("reports a trial whose lease never came by the batch cap as not run, unsaved, and runs it on a rerun", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    const never: BacktestRunDeps["lease"] = { acquire: async () => ({ ok: false, why: "queue-timeout: waited" }), release: async () => {} };
    const capped = config({ lineup: null, caps: { trialMinutes: 10, batchMinutes: 12 } });
    const report = await runBacktest(sample(["OA-1"], null), capped, { ...stub.deps, lease: never });
    expect(stub.started).toEqual([]);
    expect(stub.sleeps).toEqual([LEASE_RETRY_MS, LEASE_RETRY_MS, LEASE_RETRY_MS]);
    expect(report.rows).toMatchObject([{ outcome: "not-run", detail: "batch cap reached (host lease: queue-timeout: waited)" }]);
    expect(report.stoppedBy).toBe("batch-cap");
    expect(stateRows(runDir)).toEqual([]);
    expect(JSON.parse(readFileSync(join(runDir, "OA-1", "b", "result.json"), "utf8"))).toMatchObject({ detail: "host lease: queue-timeout: waited" });

    const rerun = stubDeps(runDir);
    const again = await runBacktest(sample(["OA-1"], null), capped, rerun.deps);
    expect(rerun.started).toEqual(["OA-1/b"]);
    expect(again.rows).toMatchObject([{ outcome: "green-pr" }]);
  });

  it("reports a trial that cannot be built as not run, unsaved, goes on, and retries it on a rerun", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    const startTrial = stub.deps.startTrial;
    let calls = 0;
    const report = await runBacktest(sample(), config(), {
      ...stub.deps,
      startTrial: async (t, arm) => { if (calls++ === 0) throw new Error("clone failed"); return startTrial(t, arm); },
    });
    expect(report.rows.map((row) => row.outcome)).toEqual(["not-run", "green-pr", "green-pr", "green-pr"]);
    expect(report.rows[0]!.detail).toBe("could not build the trial: clone failed");
    expect(report.stoppedBy).toBeNull();
    expect(stateRows(runDir)).toEqual(["OA-1/c", "OA-2/c", "OA-2/b"]);

    const rerun = stubDeps(runDir);
    await runBacktest(sample(), config(), rerun.deps);
    expect(rerun.started).toEqual(["OA-1/b"]);
  });

  it("refuses a case whose base does not build before any arm runs, goes on, and checks it again on a rerun (#820)", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    const checked: string[] = [];
    let leases = 0;
    const report = await runBacktest(sample(), config(), {
      ...stub.deps,
      lease: { acquire: async () => { leases++; return { ok: true }; }, release: async () => {} },
      checkBase: async (t) => {
        checked.push(t.oaKey);
        return t.oaKey === "OA-1" ? { ok: false, reason: "setup failed:\nnpm ERR! missing script: ci" } : { ok: true };
      },
    });
    // Built once per case, and the failing case costs no trial and no second lease.
    expect(checked).toEqual(["OA-1", "OA-2"]);
    expect(stub.started).toEqual(["OA-2/c", "OA-2/b"]);
    expect(leases).toBe(3);
    expect(report.rows.map((row) => `${row.ticket}/${row.arm} ${row.outcome}`)).toEqual([
      "OA-1/b not-run", "OA-1/c not-run", "OA-2/c green-pr", "OA-2/b green-pr",
    ]);
    for (const row of report.rows.slice(0, 2)) expect(row.detail).toBe("the base does not build, so no arm ran: setup failed:\nnpm ERR! missing script: ci");
    expect(report.stoppedBy).toBeNull();
    expect(stateRows(runDir)).toEqual(["OA-2/c", "OA-2/b"]);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("- OA-1 (b, c): the base does not build, so no arm ran: setup failed: npm ERR! missing script: ci");

    const rerun = stubDeps(runDir);
    const rechecked: string[] = [];
    await runBacktest(sample(), config(), { ...rerun.deps, checkBase: async (t) => { rechecked.push(t.oaKey); return { ok: true }; } });
    expect(rechecked).toEqual(["OA-1"]);
    expect(rerun.started).toEqual(["OA-1/b", "OA-1/c"]);
  });

  it("treats a base check that throws as a base that does not build, and a stopped one as no verdict (#820)", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    let calls = 0;
    const report = await runBacktest(sample(), config(), {
      ...stub.deps,
      checkBase: async () => {
        calls++;
        if (calls === 1) throw new Error("clone exploded");
        if (calls === 2) return { ok: false, reason: "the base build was stopped", aborted: true };
        return { ok: true };
      },
    });
    expect(report.rows.map((row) => `${row.ticket}/${row.arm} ${row.outcome}`)).toEqual([
      "OA-1/b not-run", "OA-1/c not-run", "OA-2/c not-run", "OA-2/b green-pr",
    ]);
    expect(report.rows[0]!.detail).toBe("the base does not build, so no arm ran: clone exploded");
    // The stopped build is not cached: the case's next arm builds its base again.
    expect(report.rows[2]!.detail).toBe("the base build was stopped");
    expect(calls).toBe(3);
    expect(stub.started).toEqual(["OA-2/b"]);
  });

  it("starts no trial when the lease wait used up the batch", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir);
    let released = 0;
    const lease: BacktestRunDeps["lease"] = {
      acquire: async () => { stub.clock.now += 50 * MINUTE; return { ok: true }; },
      release: async () => { released++; },
    };
    const report = await runBacktest(sample(["OA-1"], null), config({ lineup: null, caps: { trialMinutes: 30, batchMinutes: 40 } }), { ...stub.deps, lease });
    expect(stub.timeouts).toEqual([]);
    expect(stub.disposed).toEqual(["OA-1/b"]);
    expect(released).toBe(1);
    expect(report.rows).toMatchObject([{ outcome: "not-run", detail: "batch cap reached" }]);
    expect(report.stoppedBy).toBe("batch-cap");
    expect(stateRows(runDir)).toEqual([]);
  });

  it("builds no trial after a Ctrl-C during the lease wait", async () => {
    const { runDir } = runDirIn();
    const operator = new AbortController();
    const stub = stubDeps(runDir, [], { signal: operator.signal });
    let released = 0;
    let sawAbort = false;
    const lease: BacktestRunDeps["lease"] = {
      acquire: async (_t, _arm, signal) => { operator.abort(); sawAbort = signal.aborted; return { ok: true }; },
      release: async () => { released++; },
    };
    const report = await runBacktest(sample(), config(), { ...stub.deps, lease });
    expect(sawAbort).toBe(true);
    expect(stub.started).toEqual([]);
    expect(released).toBe(1);
    expect(report.rows).toEqual([]);
    expect(report.finishedAt).toBeNull();
    expect(stateRows(runDir)).toEqual([]);
  });

  it("times out a trial over its cap and keeps its partial patch", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [{ minutes: 45, partial: "diff --git a/half b/half\n" }]);
    const report = await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stub.deps);
    expect(stub.timeouts).toEqual([30 * MINUTE]);
    expect(report.rows[0]).toMatchObject({ outcome: "timed-out", wallSeconds: 1800 });
    expect(readFileSync(join(runDir, "OA-1", "b", "partial.patch"), "utf8")).toBe("diff --git a/half b/half\n");
  });

  it("stops at the batch cap: the trials left are not-run and absent from the state", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [{ minutes: 20 }, { minutes: 20 }]);
    const report = await runBacktest(sample(), config({ caps: { trialMinutes: 30, batchMinutes: 40 } }), stub.deps);
    expect(stub.started).toEqual(["OA-1/b", "OA-1/c"]);
    expect(stub.timeouts).toEqual([30 * MINUTE, 20 * MINUTE]);
    expect(report.rows.map((row) => row.outcome)).toEqual(["green-pr", "green-pr", "not-run", "not-run"]);
    expect(report.rows[2]!.detail).toBe("batch cap reached");
    expect(report.stoppedBy).toBe("batch-cap");
    expect(stateRows(runDir)).toEqual(["OA-1/b", "OA-1/c"]);
  });

  it("pauses on a usage limit, excludes the pause from the batch cap and reruns the same trial", async () => {
    const { runDir } = runDirIn();
    let resetsAt = 0;
    let rejectedAt = 0;
    const stub = stubDeps(runDir, [
      { result: (now) => { rejectedAt = now; resetsAt = now / 1000 + 3600; return limitedResult([rejectedLog(resetsAt)]); } },
      { minutes: 7 },
    ]);
    const report = await runBacktest(sample(["OA-1"], null), config({ lineup: null, caps: { trialMinutes: 30, batchMinutes: 30 } }), stub.deps);
    expect(stub.sleeps).toEqual([(resetsAt + 120) * 1000 - rejectedAt]);
    expect(stub.started).toEqual(["OA-1/b", "OA-1/b"]);
    // The pause lasted over an hour of a 30-minute batch, yet the rerun got the 25 minutes left.
    expect(stub.timeouts).toEqual([30 * MINUTE, 25 * MINUTE]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ outcome: "green-pr", wallSeconds: 420 });
    expect(existsSync(join(runDir, "OA-1", "b", "usage-limited-1", "logs"))).toBe(true);
  });

  it("reports a trial not run, never failed, after three usage pauses, and a rerun runs it (#822)", async () => {
    const { runDir } = runDirIn();
    let resetsAt = 0;
    const limited = { minutes: 4, result: (now: number) => { resetsAt = now / 1000 + 60; return limitedResult([rejectedLog(resetsAt)]); } };
    const stub = stubDeps(runDir, [limited, limited, limited, limited]);
    const report = await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stub.deps);
    expect(stub.sleeps).toHaveLength(3);
    expect(stub.started).toHaveLength(4);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      outcome: "not-run",
      detail: `usage limit: the five_hour window still rejected it after 3 pauses; resets ${new Date((resetsAt + 120) * 1000).toISOString()}`,
    });
    // A limited attempt is never scored, so none is bundled; each one's files are kept for inspection.
    expect(stub.kept).toEqual([]);
    expect(existsSync(join(runDir, "OA-1", "b", "usage-limited-4", "logs"))).toBe(true);
    expect(stateRows(runDir)).toEqual([]);

    const rerun = stubDeps(runDir);
    const resumed = await runBacktest(sample(["OA-1"], null), config({ lineup: null }), rerun.deps);
    expect(rerun.started).toEqual(["OA-1/b"]);
    expect(resumed.rows[0]).toMatchObject({ outcome: "green-pr" });
    expect(stateRows(runDir)).toEqual(["OA-1/b"]);
  });

  it("does not pause for a rejection ralph.sh already waited out: a run with a sigil, or one only an older events file shows", async () => {
    const { runDir } = runDirIn();
    const older = (now: number) => rejectedLog(now / 1000 + 3600, "logs/iter-20261028T020000Z-41-1.events.jsonl");
    const newer = quietLog("logs/iter-20261028T030000Z-41-2.events.jsonl");
    const stub = stubDeps(runDir, [
      { result: (now) => greenResult([older(now), newer]) },
      // Listed newest first: the order of the logs must not decide which is newest.
      { result: (now) => limitedResult([newer, older(now)]) },
    ]);
    const report = await runBacktest(sample(), config(), stub.deps);
    expect(stub.sleeps).toEqual([]);
    expect(stub.started).toEqual(["OA-1/b", "OA-1/c", "OA-2/c", "OA-2/b"]);
    expect(report.rows[0]).toMatchObject({ outcome: "green-pr" });
  });

  it("pauses for a run without a sigil whose newest events file ends in a rejection", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [
      { result: (now) => limitedResult([rejectedLog(now / 1000 + 600, "logs/iter-20261028T030000Z-41-2.events.jsonl"), quietLog("logs/iter-20261028T020000Z-41-1.events.jsonl")]) },
    ]);
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stub.deps);
    expect(stub.sleeps).toHaveLength(1);
    expect(stub.started).toEqual(["OA-1/b", "OA-1/b"]);
  });

  it("resumes after an operator kill: only the unfinished trials run again", async () => {
    const { runDir } = runDirIn();
    const operator = new AbortController();
    const first = stubDeps(runDir, [{}, {}, { onStart: () => operator.abort() }], { signal: operator.signal });
    const partial = await runBacktest(sample(), config(), first.deps);
    expect(first.started).toEqual(["OA-1/b", "OA-1/c", "OA-2/c"]);
    expect(partial.rows).toHaveLength(2);
    expect(partial.finishedAt).toBeNull();
    expect(stateRows(runDir)).toEqual(["OA-1/b", "OA-1/c"]);

    // The ledger moved on; the resume replays the batch it started regardless.
    const second = stubDeps(runDir);
    const report = await runBacktest(sample(["OA-7"]), config(), second.deps);
    expect(second.started).toEqual(["OA-2/c", "OA-2/b"]);
    expect(report.rows.map((row) => `${row.ticket}/${row.arm}`)).toEqual(["OA-1/b", "OA-1/c", "OA-2/c", "OA-2/b"]);
    expect(second.lines.some((line) => line.startsWith("resumed "))).toBe(true);
  });

  it("refuses a run directory that belongs to another config before any trial", async () => {
    const { runDir } = runDirIn();
    await runBacktest(sample(["OA-1"]), config(), stubDeps(runDir).deps);
    const stub = stubDeps(runDir);
    await expect(runBacktest(sample(["OA-1"]), config({ lineup: "codex" }), stub.deps)).rejects.toThrow(/different config/);
    expect(stub.started).toEqual([]);
  });

  it("keeps each finished trial's commits as <seg>/<arm>/arm.bundle, and records a trial whose keep throws", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [{}, { keep: () => { throw new Error("bundle refused"); } }]);
    const report = await runBacktest(sample(["OA-1"]), config(), stub.deps);
    expect(stub.kept).toEqual([join(runDir, "OA-1", "b", "arm.bundle"), join(runDir, "OA-1", "c", "arm.bundle")]);
    expect(report.rows.map((row) => `${row.arm}/${row.outcome}`)).toEqual(["b/green-pr", "c/green-pr"]);
    expect(report.rows[0]!.heads).toEqual({ base: "abc123", first: "def456", final: "def456" });
    expect(stateRows(runDir)).toEqual(["OA-1/b", "OA-1/c"]);
    expect(stub.lines.some((line) => line.includes("OA-1/c: could not keep the arm's commits: bundle refused"))).toBe(true);
  });

  it("keeps nothing for a trial that threw", async () => {
    const { runDir } = runDirIn();
    const stub = stubDeps(runDir, [{ onRun: () => { throw new Error("boom"); } }]);
    const report = await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stub.deps);
    expect(report.rows[0]).toMatchObject({ outcome: "failed", heads: { base: null, first: null, final: null } });
    expect(stub.kept).toEqual([]);
  });

  it("resumes a batch whose stored config has no scoring block, or a different one", async () => {
    const { runDir } = runDirIn();
    await runBacktest(sample(["OA-1"], null), config({ lineup: null }), stubDeps(runDir).deps);
    const statePath = join(runDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { config: Record<string, unknown> };
    delete state.config.scoring;
    writeFileSync(statePath, JSON.stringify(state));
    const old = stubDeps(runDir);
    await expect(runBacktest(sample(["OA-1"], null), config({ lineup: null }), old.deps)).resolves.toMatchObject({ rows: [{ ticket: "OA-1" }] });
    expect(old.started).toEqual([]);
    const scoring = { testGlobs: ["src/**"], testCommand: "bun test {file}", setup: "bun install", review: false, judge: null };
    const changed = stubDeps(runDir);
    await expect(runBacktest(sample(["OA-1"], null), config({ lineup: null, scoring }), changed.deps)).resolves.toMatchObject({ rows: [{ ticket: "OA-1" }] });
    expect(changed.started).toEqual([]);
  });

  it("writes nothing outside its run directory", async () => {
    const { parent, runDir } = runDirIn();
    mkdirSync(join(parent, "neighbour"));
    writeFileSync(join(parent, "neighbour", "keep.txt"), "untouched");
    const list = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .map((entry) => relative(parent, join(entry.parentPath, entry.name)))
        .filter((path) => path !== "run" && !path.startsWith(`run/`))
        .sort();
    const before = list(parent);
    const stub = stubDeps(runDir, [{ partial: "x", result: () => greenResult([{ path: "../../escape.log", text: "no" }]) }]);
    await runBacktest(sample([".."]), config(), stub.deps);
    expect(list(parent)).toEqual(before);
    expect(Object.keys(stub.deps).sort()).toEqual(["lease", "log", "now", "runDir", "sleep", "startTrial"]);
  });
});
