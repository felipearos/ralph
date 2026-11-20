// @vitest-environment node
/**
 * The degrade policy of the runtime reads #609 moved onto the CLI reader,
 * pinned through the injected executor. Each case scripts the one read it is
 * about — a failure, drift, or a recorded invocation to inspect — and every
 * other invocation falls through to the real process executor, which runs the
 * real CLI against the scratch fixture. So what is asserted is what an
 * operator sees: which failure blanks one field, and which fails the snapshot.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { COMMAND_SURFACE, RalphContractError, createRalphAdapter, narrowRoster } from "./adapter";
import { parseAgentConfig } from "./agents-adapter";
import type { ExecResult, Invocation } from "./control-adapter";
import { createProcessExecutor } from "./executor";
import {
  bunPath,
  cleanupFixtures,
  createFixture,
  createJournalRepo,
  scratchProject,
  writeLoopState,
  writeRunnerFailure,
  writeTimeline,
  type Fixture,
} from "./fixtures";
import { HARNESS_FILE } from "./learnings";
import { createRecordingExecutor, fallThrough, type Answer, type RecordingExecutor } from "./recording-executor";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives the ralph adapter, which spawns bun CLIs and git");

const CLI_DIR = join(__dirname, "..");
const PYTHON = "python3";

afterAll(cleanupFixtures);

const isScript = (script: string) => (i: Invocation): boolean => (i.args[0] ?? "").endsWith(script);
const isGitIn = (home: string, sub: readonly string[]) => (i: Invocation): boolean =>
  i.command === "git" && ["-C", home, ...sub].every((arg, index) => i.args[index] === arg);
const isGhIssues = (i: Invocation): boolean => i.command === "gh" && i.args[0] === "issue" && i.args[1] === "list";
const isUsage = (i: Invocation): boolean => i.command === PYTHON && (i.args[0] ?? "").endsWith("usage.py");

const down: ExecResult = { status: 1, stdout: "", stderr: "broken\n" };
const nope: ExecResult = { status: 0, stdout: "nope", stderr: "" };

/**
 * A recording executor answering only the given rules; anything else runs for
 * real, unrecorded, so `calls` holds the scripted reads alone.
 */
const scripted = (rules: [(i: Invocation) => boolean, Answer][]): RecordingExecutor => {
  const rec = createRecordingExecutor();
  for (const [match, answer] of rules) rec.on(match, answer);
  return fallThrough(rec, createProcessExecutor());
};

/** One loop worktree with a recorded run and session, registered under the fixture root. */
const withLoop = (label: string): { f: Fixture; ralph: string } => {
  const f = createFixture(label);
  const ralph = f.worktree("wt-ralph");
  writeLoopState(ralph, { loop: "ralph", run: "run-ralph", detail: "session sess-1" });
  f.registry([ralph]);
  return { f, ralph };
};

const adapterFor = (
  f: Fixture,
  rec: RecordingExecutor,
  over: { journalHome?: string; env?: Record<string, string> } = {},
) =>
  createRalphAdapter({
    cliDir: CLI_DIR,
    roots: [f.root],
    journalHome: over.journalHome ?? join(f.root, "no-harness"),
    pythonPath: PYTHON,
    exec: rec.exec,
    env: {
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      HOME: join(f.root, "home"),
      RALPH_JOURNAL_DIR: "",
      ...over.env,
    },
  });

describe("loop state is loud", () => {
  it("rejects the snapshot when the loop-state CLI cannot run", async () => {
    const { f } = withLoop("rt-loop-state");
    const rec = scripted([[isScript("loop-state.ts"), down]]);
    await expect(adapterFor(f, rec).read()).rejects.toThrow(/loop-state\.ts.*unavailable: broken/);
  });
});

describe("claims degrade when unavailable", () => {
  it("leaves the GitHub claims unknown when gh issue list exits non-zero, and the snapshot resolves", async () => {
    const { f } = withLoop("rt-claims-down");
    const rec = scripted([[isGhIssues, down]]);
    const snapshot = await adapterFor(f, rec).read();
    expect(snapshot.claims?.github).toBeNull();
    expect(snapshot.loops[0]?.identity).toBe("ralph");
    expect(rec.calls.some((call) => isGhIssues(call.invocation))).toBe(true);
  });

  it("rejects the snapshot when gh issue list prints non-JSON", async () => {
    const { f } = withLoop("rt-claims-drift");
    const rec = scripted([[isGhIssues, nope]]);
    await expect(adapterFor(f, rec).read()).rejects.toThrow(RalphContractError);
  });
});

describe("presence degrades when unavailable", () => {
  it("leaves the loop's presence unknown when observe exits non-zero", async () => {
    const { f } = withLoop("rt-presence");
    const rec = scripted([[isScript("observe.ts"), down]]);
    const loop = (await adapterFor(f, rec).read()).loops[0];
    expect(loop?.identity).toBe("ralph");
    expect(loop?.presence).toBeNull();
  });
});

describe("runner failures", () => {
  it("reads a blank stdout with status 0 as a CLI that did not run", async () => {
    const { f } = withLoop("rt-runner-blank");
    const rec = scripted([[isScript("runner-failure.ts"), { status: 0, stdout: "  \n", stderr: "cannot read\n" }]]);
    const loop = (await adapterFor(f, rec).read()).loops[0];
    expect(loop?.identity).toBe("ralph");
    expect(loop?.runnerFailures).toBeNull();
    expect(rec.calls[0]?.invocation.args.slice(-2)).toEqual(["--run", "run-ralph"]);
  });

  it("rejects the snapshot when it prints non-JSON", async () => {
    const { f } = withLoop("rt-runner-drift");
    const rec = scripted([[isScript("runner-failure.ts"), nope]]);
    await expect(adapterFor(f, rec).read()).rejects.toThrow(/runner-failure contract drift/);
  });
});

describe("usage", () => {
  it("runs usage.py --json --no-record under the configured Python in the loop's worktree, and degrades a failure", async () => {
    const { f, ralph } = withLoop("rt-usage");
    const rec = scripted([[isUsage, down]]);
    const loop = (await adapterFor(f, rec).read()).loops[0];
    expect(loop?.usage).toBeNull();
    const usage = rec.calls.find((call) => isUsage(call.invocation))!.invocation;
    expect(usage.command).toBe(PYTHON);
    expect(usage.args).toEqual([join(CLI_DIR, "usage.py"), "--json", "--no-record"]);
    expect(usage.cwd).toBe(ralph);
  });

  // The contrast for the case above: the same read answering its shape is
  // known, so the null there is the exit status, not a missing transcript.
  it("carries the narrowed usage when usage.py answers", async () => {
    const { f } = withLoop("rt-usage-ok");
    const scope = { input: 1, output: 2, cache_5m: 0, cache_1h: 0, cache_read: 0, input_total: 1 };
    const valid = {
      session: "sess-1",
      run_id: "run-ralph",
      step: { number: 1, label: "step 1", usage: scope },
      iteration: { turns: 1, elapsed_seconds: null, elapsed: "—", usage: scope, models: { m: scope } },
      run: { steps: 1, usage: scope },
      context: { model: "m", tokens: 1, window: 100, percent: 1 },
    };
    const rec = scripted([[isUsage, { status: 0, stdout: JSON.stringify(valid), stderr: "" }]]);
    const usage = (await adapterFor(f, rec).read()).loops[0]?.usage;
    expect(usage).toMatchObject({ session: "sess-1", runId: "run-ralph", iteration: { turns: 1 } });
  });
});

describe("the journal", () => {
  const ENTRIES = [
    { name: "20260913T100000Z-101-aaaaaaaaaaaa.md", body: "# 2026-09-13 — #101: one\n\n**Outcome: merged.**\n" },
    { name: "20260913T110000Z-102-bbbbbbbbbbbb.md", body: "# 2026-09-13 — #102: two\n\n**Outcome: merged.**\n" },
  ];

  it("feeds cat-file --batch the entry paths on stdin, and an unsplittable batch leaves the journal unknown", async () => {
    const { f } = withLoop("rt-journal");
    const harness = createJournalRepo(f.root, "journal/test", ENTRIES);
    const isBatch = isGitIn(harness, ["cat-file", "--batch"]);
    const rec = scripted([[isBatch, { status: 0, stdout: "not a batch", stderr: "" }]]);
    const snapshot = await adapterFor(f, rec, { journalHome: harness, env: { RALPH_JOURNAL_DIR: "journal/test" } }).read();
    expect(snapshot.loops[0]?.identity).toBe("ralph");
    expect(snapshot.loops[0]?.journal).toBeNull();
    const batch = rec.calls.find((call) => isBatch(call.invocation))!.invocation;
    expect(batch.input).toBe(ENTRIES.map((entry) => `origin/main:journal/test/${entry.name}\n`).join(""));
  });
});

describe("the learnings", () => {
  it("leaves one file unknown when its git show fails, while the remote read keeps the learnings known", async () => {
    const { f } = withLoop("rt-learnings");
    const home = join(f.root, "harness-home");
    const isHarnessShow = (i: Invocation): boolean =>
      isGitIn(home, ["show"])(i) && i.args[3] === `origin/main:${HARNESS_FILE}`;
    const rec = scripted([
      [isGitIn(home, ["remote", "get-url", "origin"]), { status: 0, stdout: "https://github.com/acme/harness.git\n", stderr: "" }],
      [isHarnessShow, { status: 128, stdout: "", stderr: "fatal: path does not exist\n" }],
      [isGitIn(home, ["show"]), { status: 0, stdout: "", stderr: "" }],
    ]);
    const snapshot = await adapterFor(f, rec, { journalHome: home }).read();
    expect(snapshot.learnings).toBeDefined();
    expect(snapshot.learnings?.base).not.toBeNull();
    const harness = snapshot.learnings?.sources.find((source) => source.scope === "harness");
    expect(harness).toMatchObject({ file: HARNESS_FILE, present: false, entries: [], fixed: [] });
    expect(rec.calls.some((call) => isHarnessShow(call.invocation))).toBe(true);
  });
});

// What the scripted adapter suites stand in for: the real CLIs behind the
// run-scoped reads and the frontier census, reached through the adapter, so a
// CLI that stopped filtering by run or began writing to GitHub is caught here.
describe("the real CLIs behind the scripted suites", () => {
  const boundary = (stage: string, state: "started" | "completed", at: string) => ({
    stage,
    state,
    invocation: `${stage}-1`,
    runner: "claude",
    model: "opus",
    at,
  });

  it("timeline --json --run reads the loop's own run, past a newer file from another run", async () => {
    const { f, ralph } = withLoop("rt-real-timeline");
    writeTimeline(ralph, {
      run: "run-ralph",
      boundaries: [
        boundary("mapper", "started", "2026-09-13T11:00:00.000Z"),
        boundary("mapper", "completed", "2026-09-13T11:05:00.000Z"),
      ],
    });
    writeTimeline(ralph, {
      run: "run-before",
      iteration: 9,
      boundaries: [boundary("executor", "started", "2026-09-13T11:50:00.000Z")],
    });

    const timeline = (await adapterFor(f, scripted([])).read()).loops[0]?.timeline;
    expect(timeline).toEqual({
      exists: true,
      path: join(ralph, ".ralph", "logs", "iter-run-ralph-3.events.jsonl"),
      activities: [
        { stage: "mapper", label: "stage started · claude", at: "2026-09-13T11:00:00.000Z", iteration: 3, run: "run-ralph" },
        { stage: "mapper", label: "stage completed · claude", at: "2026-09-13T11:05:00.000Z", iteration: 3, run: "run-ralph" },
      ],
    });
  });

  it("runner-failure status --json --run settles only the loop's run, from its own ledger despite a redirect", async () => {
    const { f, ralph } = withLoop("rt-real-failures");
    writeRunnerFailure(ralph, { run: "run-before", kind: "timeout", at: "2026-09-13T10:00:00.000Z" });
    writeRunnerFailure(ralph, { kind: "api-error", at: "2026-09-13T11:30:00.000Z" });
    // The adapter drops the caller's redirect, so the CLI falls back to the
    // worktree's ledger under RALPH_PROJECT.
    const adapter = adapterFor(f, scripted([]), { env: { RALPH_RUNNER_FAILURE_LOG: join(f.root, "elsewhere.jsonl") } });

    const failures = (await adapter.read()).loops[0]?.runnerFailures;
    expect(failures?.settled.map((row) => [row.run, row.kind])).toEqual([["run-ralph", "api-error"]]);
  });

  it("the frontier census and every other gh call the snapshot makes are reads", async () => {
    const { f } = withLoop("rt-real-census");
    const snapshot = await adapterFor(f, scripted([])).read();
    expect(snapshot.frontier).toMatchObject({ view: { ready: [], tree: [] }, problem: null });
    // The census is the open issues with their blockers (one GraphQL query),
    // the closed issue list and the PR list; beside it, the adapter's claim
    // read and its two PR-status lists. Concurrent, so order is not contractual.
    const calls = f.githubCalls();
    const census = calls.filter((call) => !call.startsWith(COMMAND_SURFACE.github.args.join(" ")));
    expect(census.map((call) => (call.startsWith("api graphql ") ? "api graphql" : call)).sort()).toEqual([
      "api graphql",
      "issue list --state closed --limit 1000 --json number,title,body",
      "pr list --state open --limit 200 --json number,closingIssuesReferences,body",
      COMMAND_SURFACE.pullsOpen.args.join(" "),
      COMMAND_SURFACE.pullsMerged.args.join(" "),
    ].sort());
    expect(calls.filter((call) => call === COMMAND_SURFACE.github.args.join(" "))).toHaveLength(1);
    for (const call of calls) {
      expect(call).toMatch(/^((issue|pr) list|api graphql) /);
      expect(call).not.toMatch(/\b(edit|create|close|comment|mutation)\b|--add-label|--remove-label|--add-assignee/);
    }
  });
});

// The real `project-config --json` against a roster that spells roles, fed to
// both of the dashboard's readers of it: the contract the scripted adapter
// suites stand in for, kept here where the real CLIs already run.
describe("the roster through the real project-config", () => {
  it("reads every loop's name and role from a roster that spells roles, through the real project-config --json", () => {
    const root = scratchProject("adapter-roles", ["ralph", { name: "tria", role: "triager" }, { name: "doc", role: "ci-doctor" }]);
    const run = spawnSync(bunPath(), [join(CLI_DIR, "project-config.ts"), "--json"], {
      encoding: "utf8",
      env: { ...process.env, RALPH_PROJECT: root },
    });
    expect(run.status).toBe(0);
    expect(narrowRoster(JSON.parse(run.stdout))).toEqual([
      { name: "ralph", role: "coder" },
      { name: "tria", role: "triager" },
      { name: "doc", role: "ci-doctor" },
    ]);
    const agents = parseAgentConfig({ status: run.status, stdout: run.stdout, stderr: run.stderr });
    expect(agents).toMatchObject({
      ok: true,
      value: {
        loops: ["ralph", "tria", "doc"],
        roster: [
          { name: "ralph", role: "coder" },
          { name: "tria", role: "triager" },
          { name: "doc", role: "ci-doctor" },
        ],
      },
    });
  });
});
