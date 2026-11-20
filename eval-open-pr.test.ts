import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { builtInInstructions } from "./eval-instructions";
import { openProposalPr, proposalMarker } from "./eval-open-pr";
import { promptHash, type ProposalState, type StoredPromptVerdict, type StoredProposal } from "./eval-proposals";
import type { EvalRunSummary } from "./eval-runs";
import { subprocessSuite } from "./test-timeouts";
import { scratchDir } from "./test-scratch";
import type { Gh } from "./verifier/deploys";
import type { Git } from "./verifier/revert";

subprocessSuite("git");

const HERE = dirname(fileURLToPath(import.meta.url));

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Trial",
  GIT_AUTHOR_EMAIL: "trial@example.invalid",
  GIT_COMMITTER_NAME: "Trial",
  GIT_COMMITTER_EMAIL: "trial@example.invalid",
};

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Every gh argv any test recorded: none may ever ask gh to merge. */
const allGhCalls: string[][] = [];
afterAll(() => {
  expect(allGhCalls.some((argv) => argv[0] === "pr" && argv[1] === "merge")).toBe(false);
});

interface Harness {
  root: string;
  clone: string;
  gitCalls: string[][];
  ghCalls: string[][];
  bodies: string[];
  git: Git;
  gh: Gh;
}

/** A bare origin on `main` holding prompts and models.json, a clone of it as the harness, and recording git and gh. */
/** What the seed commit holds: an overlay's recorded bases are these files' hashes. */
const SEED: Record<string, string> = { "prompt.md": "the prompt\n", "coder.md": "the coder\n", "prompts/x.md": "x\n", "ralph.sh": "#!/bin/sh\n" };

function harness(listed: unknown[] = [], options: { createFails?: boolean; afterCreateFail?: unknown[] } = {}): Harness {
  let created = false;
  const root = scratchDir("eval-open-pr-");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "harness");
  sh(root, "init", "--bare", "--initial-branch=main", origin);
  sh(root, "init", "--initial-branch=main", seed);
  writeFileSync(join(seed, "prompt.md"), "the prompt\n");
  writeFileSync(join(seed, "coder.md"), "the coder\n");
  mkdirSync(join(seed, "prompts"));
  writeFileSync(join(seed, "prompts", "x.md"), "x\n");
  writeFileSync(join(seed, "models.json"), readFileSync(join(HERE, "models.json"), "utf8"));
  writeFileSync(join(seed, "ralph.sh"), "#!/bin/sh\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "seed");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "origin", "main");
  sh(root, "clone", origin, clone);

  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  const bodies: string[] = [];
  const git: Git = (args, cwd) => {
    gitCalls.push(args);
    return new Promise((resolve) => {
      execFile("git", args, { cwd, env }, (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
      });
    });
  };
  const gh: Gh = async (args) => {
    ghCalls.push(args);
    allGhCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return { ok: true, stdout: JSON.stringify(created ? options.afterCreateFail ?? [] : listed), stderr: "" };
    if (args[0] === "pr" && args[1] === "create" && options.createFails === true) {
      created = true;
      return { ok: false, stdout: "", stderr: "a pull request for branch \"evals/proposal-p1\" already exists" };
    }
    if (args[0] === "pr" && args[1] === "create") {
      // Read now: the body file is removed once gh returns.
      bodies.push(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"));
      return { ok: true, stdout: "https://github.com/o/ralph/pull/42\n", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { root, clone, gitCalls, ghCalls, bodies, git, gh };
}

function fixtureRun(): EvalRunSummary {
  return {
    id: "run-full-1",
    dir: "/tmp/none",
    kind: "eval",
    startedAt: "2026-11-18T00:00:00Z",
    finishedAt: "2026-11-18T02:00:00Z",
    running: false,
    stoppedBy: null,
    source: { kind: "set", version: "abc1234", tags: [], cases: ["c1"], unrunnable: [] },
    arms: [{ name: "base", lineup: "live", overlay: null }, { name: "proposal", lineup: "live", overlay: "p1" }],
    panel: [{ name: "judge-a", runner: "claude", model: "opus-x" }],
    resolved: null,
    repeats: 0,
    cases: [],
    totals: [],
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
      goals: [{ goal: "quality", pass: true, conditions: [{ id: "objective-up", pass: true, reason: "objective rose beyond the floor" }] }],
    },
    judgeAccuracy: null,
    problem: null,
  };
}

/** A stored proposal under `<root>/proposals/`, its overlay files (if any) written where the improver keeps them. */
function proposal(root: string, kind: StoredProposal["kind"], content: unknown, overlay: Record<string, string> = {}, bases?: Record<string, string | null>): StoredProposal {
  const dir = join(root, "run", "proposals");
  for (const [path, text] of Object.entries(overlay)) {
    const target = join(dir, "p1", "overlay", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return {
    v: 1, id: "p1", run: "run-0", goal: "quality", kind, content,
    rationale: "Tighten the scope rule.", answers: [{ knob: "prompt", target: "coder.md", change: "say less" }],
    model: "opus", createdAt: "2026-11-17T00:00:00Z", subset: ["c1"], entry: "e1", full: null, path: join(dir, "p1.json"),
    // By default the overlay was made against the seed, as the trial's baseline read it.
    ...(kind === "prompt-overlay"
      ? { bases: bases ?? Object.fromEntries(Object.keys(overlay).map((path) => [path, SEED[path] === undefined ? null : promptHash(SEED[path]!)])) }
      : {}),
  };
}

const passed: ProposalState = {
  status: "passed", verdict: null, reason: null, runs: { subset: "run-subset-1", full: "run-full-1" }, promising: true,
};

const BRANCH = "evals/proposal-p1";

const tally = (agree: number, total: number) => ({ agree, total, accuracy: total === 0 ? null : agree / total });
const evidence = (agree: number) => ({
  accuracy: tally(agree, 3),
  axes: { correctness: tally(agree > 1 ? 1 : agree, 1), scope: tally(agree > 2 ? 1 : 0, 1), tests: tally(1, 1), maintainability: tally(0, 0), review: tally(0, 0) },
  objectives: {}, meanScore: 3.5, cases: 1, checked: [],
});
const VERDICT: StoredPromptVerdict = {
  v: 1, at: "2026-11-19T12:00:00Z", cases: ["c1"], pass: true,
  conditions: [{ id: "accuracy-up", pass: true, reason: "accuracy rose" }],
  current: evidence(2), proposed: evidence(3),
};

/** A judge-prompt proposal from run-0, measured against the built-in judge instructions the seed falls back to. */
function judgePrompt(root: string): StoredProposal {
  return {
    ...proposal(root, "judge-prompt", { instructions: "Judge the arms, citing the diff." }),
    bases: { "eval-prompts/judge.md": promptHash(builtInInstructions("judge-prompt")) },
  };
}

/** A prompt proposal has no subset or full run: its state is its verdict. */
const promptPassed: ProposalState = { status: "passed", verdict: { pass: true, conditions: VERDICT.conditions }, reason: null, runs: { subset: null, full: null }, promising: null };

const sourceRun = (): EvalRunSummary => ({ ...fixtureRun(), id: "run-0" });

const deps = (h: Harness) => ({ git: h.git, gh: h.gh, harnessRoot: h.clone, baseBranch: "main", tmpRoot: h.root });

const pushed = (h: Harness): string => sh(h.clone, "ls-remote", "origin", `refs/heads/${BRANCH}`).trim();

describe("openProposalPr", () => {
  it("opens one PR whose branch changes only the overlay's prompt files", async () => {
    const h = harness();
    const files = { "coder.md": "the coder, tighter\n", "prompts/x.md": "x, tighter\n" };
    const stored = proposal(h.root, "prompt-overlay", { files }, files);
    const opened = await openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() });

    expect(opened).toEqual({ kind: "opened", number: 42, url: "https://github.com/o/ralph/pull/42", branch: BRANCH, files: ["coder.md", "prompts/x.md"] });
    expect(h.ghCalls.filter((argv) => argv[1] === "create")).toHaveLength(1);
    sh(h.clone, "fetch", "origin");
    expect(sh(h.clone, "diff", "--name-only", "origin/main", `origin/${BRANCH}`).trim().split("\n")).toEqual(["coder.md", "prompts/x.md"]);
    expect(sh(h.clone, "show", `origin/${BRANCH}:coder.md`)).toBe("the coder, tighter\n");

    const body = h.bodies[0]!;
    expect(body.split("\n")[0]).toBe(proposalMarker("p1"));
    for (const heading of ["## Summary", "## Proven against", "## Scorecard", "## Guardrail verdict", "## Quality vs cost", "## Contested cases", "## The change"]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain("Test set version: abc1234");
    expect(body).toContain("judge-a (claude, opus-x)");
    expect(body).toContain("measured by run run-floor-9");
    // The scratch worktree is gone.
    expect(sh(h.clone, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("opens a lineup PR that changes only models.json, and only the stage it names", async () => {
    const h = harness();
    const stored = proposal(h.root, "lineup", { stages: { orchestrator: { model: "claude-opus-5-5" } } });
    const opened = await openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() });

    expect(opened.kind).toBe("opened");
    sh(h.clone, "fetch", "origin");
    expect(sh(h.clone, "diff", "--name-only", "origin/main", `origin/${BRANCH}`).trim()).toBe("models.json");
    const before = JSON.parse(sh(h.clone, "show", "origin/main:models.json")) as { default: Record<string, Record<string, unknown>> };
    const after = JSON.parse(sh(h.clone, "show", `origin/${BRANCH}:models.json`)) as { default: Record<string, Record<string, unknown>> };
    expect(after.default.orchestrator).toEqual({ ...before.default.orchestrator, model: "claude-opus-5-5" });
    expect({ ...after.default, orchestrator: null }).toEqual({ ...before.default, orchestrator: null });
  });

  it("refuses a proposal that did not pass, without touching git or gh", async () => {
    const h = harness();
    const stored = proposal(h.root, "prompt-overlay", { files: { "coder.md": "y\n" } }, { "coder.md": "y\n" });
    const failed: ProposalState = { ...passed, status: "failed" };
    await expect(openProposalPr(deps(h), { proposal: stored, state: failed, run: fixtureRun() })).rejects.toThrow(/failed, not passed/);
    // A passed state whose full run is not the one given is refused too.
    await expect(openProposalPr(deps(h), { proposal: stored, state: passed, run: { ...fixtureRun(), id: "run-other" } })).rejects.toThrow(/full-set run/);
    expect(h.ghCalls).toEqual([]);
    expect(h.gitCalls).toEqual([]);
  });

  it("returns the open PR already there, pushing and creating nothing", async () => {
    const h = harness([{ number: 7, state: "OPEN", url: "https://github.com/o/ralph/pull/7" }]);
    const stored = proposal(h.root, "prompt-overlay", { files: { "coder.md": "y\n" } }, { "coder.md": "y\n" });
    const found = await openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() });
    expect(found).toEqual({ kind: "exists", number: 7, url: "https://github.com/o/ralph/pull/7" });
    expect(h.ghCalls.filter((argv) => argv[1] === "create")).toEqual([]);
    expect(h.gitCalls).toEqual([]);
    expect(pushed(h)).toBe("");
  });

  it("refuses when a person already merged or closed the proposal's PR", async () => {
    const h = harness([{ number: 8, state: "CLOSED", url: "https://github.com/o/ralph/pull/8" }]);
    const stored = proposal(h.root, "prompt-overlay", { files: { "coder.md": "y\n" } }, { "coder.md": "y\n" });
    await expect(openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() })).rejects.toThrow(/#8/);
    expect(h.gitCalls).toEqual([]);
  });

  it("pushes nothing for an overlay naming a file that is not a prompt", async () => {
    const h = harness();
    const stored = proposal(h.root, "prompt-overlay", { files: { "ralph.sh": "echo owned\n" } }, { "ralph.sh": "echo owned\n" });
    await expect(openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() })).rejects.toThrow(/not a prompt file/);
    expect(pushed(h)).toBe("");
    expect(h.gitCalls.some((argv) => argv[0] === "push")).toBe(false);
    expect(h.ghCalls.filter((argv) => argv[1] === "create")).toEqual([]);
    expect(sh(h.clone, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("refuses a change origin already holds", async () => {
    const h = harness();
    const stored = proposal(h.root, "prompt-overlay", { files: { "coder.md": "the coder\n" } }, { "coder.md": "the coder\n" });
    await expect(openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() })).rejects.toThrow(/already holds this change/);
    expect(pushed(h)).toBe("");
  });

  it("refuses an overlay whose base on main moved since the proposal, so it never reverts a later edit", async () => {
    const h = harness();
    const files = { "coder.md": "the coder, tighter\n" };
    const stored = proposal(h.root, "prompt-overlay", { files }, files, { "coder.md": promptHash("the coder, as it was\n") });
    await expect(openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() })).rejects.toThrow(/changed coder\.md since proposal p1/);
    expect(pushed(h)).toBe("");
    expect(h.ghCalls.filter((argv) => argv[1] === "create")).toEqual([]);
  });

  it("refuses an overlay written before bases were recorded when main touched its files since it was made", async () => {
    const h = harness();
    const files = { "coder.md": "the coder, tighter\n" };
    const { bases: _dropped, ...older } = proposal(h.root, "prompt-overlay", { files }, files);
    // The seed commit is newer than this createdAt, so it counts as a move.
    await expect(openProposalPr(deps(h), { proposal: older, state: passed, run: fixtureRun() })).rejects.toThrow(/changed coder\.md/);
    const fresh = { ...older, createdAt: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await openProposalPr(deps(h), { proposal: fresh, state: passed, run: fixtureRun() })).kind).toBe("opened");
  });

  it("answers the PR a concurrent open created when its own create loses the race", async () => {
    const h = harness([], { createFails: true, afterCreateFail: [{ number: 9, state: "OPEN", url: "https://github.com/o/ralph/pull/9" }] });
    const files = { "coder.md": "the coder, tighter\n" };
    const stored = proposal(h.root, "prompt-overlay", { files }, files);
    expect(await openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() })).toEqual({ kind: "exists", number: 9, url: "https://github.com/o/ralph/pull/9" });
  });

  it("opens a passed judge-prompt proposal as a PR that changes only eval-prompts/judge.md", async () => {
    const h = harness();
    const stored = judgePrompt(h.root);
    const opened = await openProposalPr(deps(h), { proposal: stored, state: promptPassed, run: sourceRun(), verdict: VERDICT });

    expect(opened).toMatchObject({ kind: "opened", branch: BRANCH, files: ["eval-prompts/judge.md"] });
    sh(h.clone, "fetch", "origin");
    expect(sh(h.clone, "diff", "--name-only", "origin/main", `origin/${BRANCH}`).trim()).toBe("eval-prompts/judge.md");
    expect(sh(h.clone, "show", `origin/${BRANCH}:eval-prompts/judge.md`)).toBe("Judge the arms, citing the diff.\n");
    const body = h.bodies[0]!;
    expect(body).toContain("## Accuracy evidence");
    expect(body).not.toContain("## Scorecard");
    expect(sh(h.clone, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("refuses a judge-prompt proposal whose instructions on main moved since it was measured", async () => {
    const h = harness();
    const stored = judgePrompt(h.root);
    // Someone else edits the judge instructions on origin after the proposal was made.
    const other = join(h.root, "other");
    sh(h.root, "clone", join(h.root, "origin.git"), other);
    mkdirSync(join(other, "eval-prompts"));
    writeFileSync(join(other, "eval-prompts", "judge.md"), "A later edit.\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-m", "edit judge");
    sh(other, "push", "origin", "main");
    await expect(openProposalPr(deps(h), { proposal: stored, state: promptPassed, run: sourceRun(), verdict: VERDICT }))
      .rejects.toThrow(/changed eval-prompts\/judge\.md since proposal p1/);
    expect(pushed(h)).toBe("");
    expect(h.ghCalls.filter((argv) => argv[1] === "create")).toEqual([]);
  });

  it("refuses a judge-prompt proposal whose verdict failed, or that has none, without touching git", async () => {
    const h = harness();
    const stored = judgePrompt(h.root);
    await expect(openProposalPr(deps(h), { proposal: stored, state: promptPassed, run: sourceRun(), verdict: { ...VERDICT, pass: false } }))
      .rejects.toThrow(/verdict did not pass/);
    await expect(openProposalPr(deps(h), { proposal: stored, state: promptPassed, run: sourceRun() })).rejects.toThrow(/no stored verdict/);
    await expect(openProposalPr(deps(h), { proposal: stored, state: promptPassed, run: fixtureRun(), verdict: VERDICT })).rejects.toThrow(/source run/);
    expect(h.gitCalls).toEqual([]);
    expect(h.ghCalls).toEqual([]);
  });

  it("never opens a PR for a check proposal: the operator confirms it on the Test set screen", async () => {
    const h = harness();
    const stored = proposal(h.root, "check", { case: "c1", command: "true" });
    await expect(openProposalPr(deps(h), { proposal: stored, state: passed, run: fixtureRun() }))
      .rejects.toThrow("a check proposal is a suggestion the operator confirms on the Test set screen; it never opens a PR");
    expect(h.gitCalls).toEqual([]);
    expect(h.ghCalls).toEqual([]);
  });

  it("never names a merge to gh in its source", () => {
    const source = readFileSync(join(HERE, "eval-open-pr.ts"), "utf8");
    expect(source).not.toMatch(/["']merge["']/);
  });
});
