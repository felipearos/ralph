// @vitest-environment node
/**
 * The agents adapter's worktree setup (#694): the steps a new checkout runs,
 * spawned for real under `bash` in a scratch worktree, and the record it keeps
 * in that worktree's own `.ralph/logs`. Every run is awaited, so no test waits
 * on a sleep of its own.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { AGENT_SURFACE, createAgentsAdapter } from "./agents-adapter";
import type { WorktreeSetupStepConfig } from "./contracts";
import { createRecordingExecutor } from "./recording-executor";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs worktree setup steps under bash -c");

const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// Real paths, so `pwd` in a step reads the same string the test compares.
const tmp = (label: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `worktree-setup-${label}-`)));
  scratch.push(dir);
  return dir;
};

const setup = () => {
  const root = tmp("root");
  const worktree = tmp("worktree");
  // A linked worktree's `.git` is a file; the record is written only beside one.
  writeFileSync(join(worktree, ".git"), "gitdir: /nowhere\n");
  const recorder = createRecordingExecutor();
  const agents = createAgentsAdapter({ cliDir: root, root, project: "proj", workspaces: tmp("workspaces"), exec: recorder.exec });
  return { root, worktree, recorder, agents };
};

const step = (name: string, command: string, timeoutSeconds = 30): WorktreeSetupStepConfig => ({
  name,
  command,
  timeoutSeconds,
  installsDependencies: false,
});

const recordFile = (worktree: string): string => join(worktree, AGENT_SURFACE.worktreeSetupRecord);

describe("runWorktreeSetup", () => {
  it("runs every step in order in the worktree, with the main checkout named, and records them", async () => {
    const { root, worktree, recorder, agents } = setup();
    const record = await agents.runWorktreeSetup(worktree, [
      step("first", 'echo first >> order; pwd > where; echo "$RALPH_MAIN_CHECKOUT" > main'),
      step("second", "echo second >> order; echo done"),
    ]);

    expect(readFileSync(join(worktree, "order"), "utf8")).toBe("first\nsecond\n");
    expect(readFileSync(join(worktree, "where"), "utf8").trim()).toBe(worktree);
    expect(readFileSync(join(worktree, "main"), "utf8").trim()).toBe(root);
    expect(record.steps.map(({ name, state, exitCode }) => ({ name, state, exitCode }))).toEqual([
      { name: "first", state: "passed", exitCode: 0 },
      { name: "second", state: "passed", exitCode: 0 },
    ]);
    expect(record.steps[1]).toMatchObject({ output: "done", truncated: false, limitMs: 30_000, error: null });
    expect(Number.isNaN(Date.parse(record.ranAt))).toBe(false);
    // The steps spawn through gate-run, not the executor.
    expect(recorder.calls).toEqual([]);

    expect(JSON.parse(readFileSync(recordFile(worktree), "utf8"))).toEqual(record);
    expect(agents.readWorktreeSetup(worktree)).toEqual(record);
  });

  it("stops at the first failing step and records the rest skipped", async () => {
    const { worktree, agents } = setup();
    const record = await agents.runWorktreeSetup(worktree, [
      step("ok", "echo ok >> order"),
      step("broken", "echo nope; echo to-stderr >&2; exit 3"),
      step("later", "echo later >> order", 45),
    ]);

    expect(readFileSync(join(worktree, "order"), "utf8")).toBe("ok\n");
    expect(record.steps[1]).toMatchObject({ name: "broken", state: "failed", exitCode: 3, error: null });
    expect(record.steps[1]?.output).toContain("nope");
    expect(record.steps[1]?.output).toContain("to-stderr");
    expect(record.steps[2]).toEqual({
      name: "later",
      command: "echo later >> order",
      state: "skipped",
      durationMs: null,
      exitCode: null,
      output: "",
      truncated: false,
      limitMs: 45_000,
      error: null,
    });
    expect(agents.readWorktreeSetup(worktree)).toEqual(record);
  });

  it("times a step out past its limit, well before the command would end, and skips the rest", async () => {
    const { worktree, agents } = setup();
    const began = Date.now();
    const record = await agents.runWorktreeSetup(worktree, [step("slow", "sleep 30", 1), step("after", "echo after > after")]);

    expect(Date.now() - began).toBeLessThan(15_000);
    expect(record.steps.map((s) => s.state)).toEqual(["timeout", "skipped"]);
    expect(record.steps[0]).toMatchObject({ exitCode: null, limitMs: 1000 });
    expect(existsSync(join(worktree, "after"))).toBe(false);
    expect(agents.readWorktreeSetup(worktree)).toEqual(record);
  });

  it("writes nothing for no steps", async () => {
    const { worktree, agents } = setup();
    const record = await agents.runWorktreeSetup(worktree, []);
    expect(record.steps).toEqual([]);
    expect(Number.isNaN(Date.parse(record.ranAt))).toBe(false);
    expect(existsSync(join(worktree, ".ralph"))).toBe(false);
  });

  it("still answers the record when it cannot be written", async () => {
    const { worktree, agents } = setup();
    // A file where the logs directory goes: every write of the record fails.
    writeFileSync(join(worktree, ".ralph"), "not a directory");
    const record = await agents.runWorktreeSetup(worktree, [step("ok", "true")]);
    expect(record.steps.map((s) => s.state)).toEqual(["passed"]);
    expect(agents.readWorktreeSetup(worktree)).toBeNull();
  });
});

describe("runWorktreeSetup's fences", () => {
  it("refuses a second setup in the same worktree while the first runs, and releases both after", async () => {
    const { worktree, agents } = setup();
    const steps = [step("slow", "sleep 2; echo first >> order"), step("after", "echo after >> order")];
    const first = agents.runWorktreeSetup(worktree, steps);
    expect(agents.setupRunning(worktree)).toBe(true);
    // The path is resolved, so another spelling of it is the same worktree.
    expect(agents.setupRunning(`${worktree}/.`)).toBe(true);
    // The starting record, not a stale pass, while the first step runs.
    expect(agents.readWorktreeSetup(worktree)?.steps).toEqual([]);

    const second = await agents.runWorktreeSetup(worktree, steps);
    expect(second.steps.map((s) => s.state)).toEqual(["failed", "skipped"]);
    expect(second.steps[0]).toMatchObject({ error: "a setup is already running in this worktree", exitCode: null, durationMs: null, limitMs: 30_000 });
    expect(second.steps[1]?.error).toBeNull();

    const record = await first;
    expect(record.steps.map((s) => s.state)).toEqual(["passed", "passed"]);
    expect(readFileSync(join(worktree, "order"), "utf8")).toBe("first\nafter\n");
    // The refused call wrote nothing over the first's record.
    expect(agents.readWorktreeSetup(worktree)).toEqual(record);
    expect(agents.setupRunning(worktree)).toBe(false);

    const again = await agents.runWorktreeSetup(worktree, [step("quick", "true")]);
    expect(again.steps.map((s) => s.state)).toEqual(["passed"]);
    expect(agents.setupRunning(worktree)).toBe(false);
  });

  it("runs and writes nothing when the worktree directory does not exist", async () => {
    const { agents } = setup();
    const gone = join(tmp("parent"), "gone");
    const record = await agents.runWorktreeSetup(gone, [step("a", "true"), step("b", "true")]);
    expect(record.steps.map((s) => s.state)).toEqual(["failed", "skipped"]);
    expect(record.steps[0]?.error).toBe(`the worktree directory ${gone} does not exist`);
    expect(existsSync(gone)).toBe(false);
    expect(agents.worktreeExists(gone)).toBe(false);
    expect(agents.setupRunning(gone)).toBe(false);
  });

  it("never writes the record into a directory that is not a worktree", async () => {
    const { agents } = setup();
    const bare = tmp("bare");
    const record = await agents.runWorktreeSetup(bare, [step("a", "true")]);
    expect(record.steps.map((s) => s.state)).toEqual(["passed"]);
    expect(existsSync(join(bare, ".ralph"))).toBe(false);
    expect(agents.worktreeExists(bare)).toBe(true);
  });

  it("leaves no temp file beside the record", async () => {
    const { worktree, agents } = setup();
    await agents.runWorktreeSetup(worktree, [step("a", "true")]);
    expect(readdirSync(join(worktree, AGENT_SURFACE.logsDir))).toEqual(["worktree-setup.json"]);
  });
});

describe("readWorktreeSetup", () => {
  it("is null when the worktree has no record", () => {
    const { worktree, agents } = setup();
    expect(agents.readWorktreeSetup(worktree)).toBeNull();
  });

  it("is null when the record is not JSON or not a record", () => {
    const { worktree, agents } = setup();
    mkdirSync(join(worktree, AGENT_SURFACE.logsDir), { recursive: true });
    writeFileSync(recordFile(worktree), "{ not json");
    expect(agents.readWorktreeSetup(worktree)).toBeNull();
    writeFileSync(recordFile(worktree), JSON.stringify({ ranAt: "2026-11-04T00:00:00.000Z", steps: [{ name: "x", state: "exploded" }] }));
    expect(agents.readWorktreeSetup(worktree)).toBeNull();
    writeFileSync(recordFile(worktree), JSON.stringify({ steps: [] }));
    expect(agents.readWorktreeSetup(worktree)).toBeNull();
  });
});
