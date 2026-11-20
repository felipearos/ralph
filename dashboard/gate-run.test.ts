// @vitest-environment node
/**
 * The Settings page's gate runner (#690), driven against real `bash` gates in
 * a scratch directory. Each run's `done` promise is awaited, so no test waits
 * on a sleep.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createGateRunner, stripAnsi, type GateRunStarted } from "./gate-run";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs gate commands under bash -c");

const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "gate-run-"));
  scratch.push(dir);
  return dir;
};

const started = (result: ReturnType<ReturnType<typeof createGateRunner>["start"]>): GateRunStarted => {
  if (!result.started) throw new Error(`expected a start, got a refusal: ${result.reason}`);
  return result;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `pid` is gone within `withinMs`. A killed child whose parent died
 * with it is reaped by init on its own schedule, and until then `kill(pid, 0)`
 * still finds the zombie; a child that was never killed stays alive past the
 * bound and still fails.
 */
const goneWithin = async (pid: number, withinMs: number): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

describe("createGateRunner", () => {
  it("reports a passing gate with its exit code, duration and output", async () => {
    const runner = createGateRunner();
    const run = started(runner.start("p", tmp(), { name: "hello", command: "echo hello; exit 0" }));
    expect(run.view.state).toBe("running");
    expect(run.view.durationMs).toBeNull();
    expect(run.view.exitCode).toBeNull();
    const view = await run.done;
    expect(view.state).toBe("passed");
    expect(view.exitCode).toBe(0);
    expect(view.output).toContain("hello");
    expect(typeof view.durationMs).toBe("number");
    expect(view.error).toBeNull();
    expect(view.truncated).toBe(false);
  });

  it("reports a failing gate with its exit code and stderr", async () => {
    const runner = createGateRunner();
    const view = await started(runner.start("p", tmp(), { name: "fail", command: "echo boom >&2; exit 3" })).done;
    expect(view.state).toBe("failed");
    expect(view.exitCode).toBe(3);
    expect(view.output).toContain("boom");
  });

  it("runs the command in the given cwd", async () => {
    const dir = tmp();
    const view = await started(createGateRunner().start("p", dir, { name: "pwd", command: "pwd" })).done;
    expect(view.output.trim()).toBe(dir);
  });

  it("times a gate out past its limit and kills the whole process group", async () => {
    const dir = tmp();
    const pidFile = join(dir, "bg.pid");
    const runner = createGateRunner({ limitMs: 300 });
    const begin = Date.now();
    const view = await started(
      runner.start("p", dir, { name: "slow", command: `sleep 30 & echo $! > ${pidFile}; wait` }),
    ).done;
    expect(Date.now() - begin).toBeLessThan(15_000);
    expect(view.state).toBe("timeout");
    expect(view.exitCode).toBeNull();
    expect(view.limitMs).toBe(300);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect(await goneWithin(pid, 5_000)).toBe(true);
  });

  it("refuses a second start for the same key while one runs, and frees the slot after", async () => {
    const dir = tmp();
    // A generous limit: the runs below must pass on a loaded host, and the
    // first one is held open by a release file rather than by its timing.
    const runner = createGateRunner({ limitMs: 60_000 });
    const release = join(dir, "release");
    const first = started(
      runner.start("p", dir, { name: "test", command: `while [ ! -e ${release} ]; do sleep 0.05; done` }),
    );
    const marker = join(dir, "second-ran");
    const refused = runner.start("p", dir, { name: "lint", command: `touch ${marker}` });
    expect(refused.started).toBe(false);
    if (refused.started) throw new Error("unreachable");
    expect(refused.running.gate).toBe("test");
    expect(refused.running.startedAt).toBe(first.view.startedAt);
    expect(refused.reason).toContain("gate 'test' is already running for this project");
    expect(refused.reason).toContain(first.view.startedAt);
    expect(runner.current("p")?.gate).toBe("test");
    expect(runner.current("p")?.state).toBe("running");

    // A different project is not blocked.
    const other = await started(runner.start("q", dir, { name: "other", command: "echo other" })).done;
    expect(other.state).toBe("passed");

    writeFileSync(release, "");
    expect((await first.done).state).toBe("passed");
    expect(existsSync(marker)).toBe(false);
    const next = await started(runner.start("p", dir, { name: "lint", command: `touch ${marker}; echo ok` })).done;
    expect(next.state).toBe("passed");
    expect(next.output).toContain("ok");
  });

  it("settles a gate whose leftover process left the group and holds the pipes open", async () => {
    // `setsid` puts the sleeper outside the gate's group, so no group kill
    // reaches it and `close` never comes; the run must settle anyway.
    const runner = createGateRunner({ limitMs: 60_000, killGraceMs: 200 });
    const begin = Date.now();
    const view = await started(runner.start("p", tmp(), { name: "leak", command: "setsid sleep 30 & echo up" })).done;
    expect(Date.now() - begin).toBeLessThan(15_000);
    expect(view.state).toBe("passed");
    expect(view.output).toContain("up");
    expect(runner.current("p")?.state).toBe("passed");
  });

  it("times out a gate whose escaped process holds the pipes open", async () => {
    const runner = createGateRunner({ limitMs: 300, killGraceMs: 200 });
    const begin = Date.now();
    const view = await started(runner.start("p", tmp(), { name: "stuck", command: "setsid sleep 30 & sleep 30" })).done;
    expect(Date.now() - begin).toBeLessThan(15_000);
    expect(view.state).toBe("timeout");
  });

  it("keeps a partial stdout line apart from interleaved stderr", async () => {
    const view = await started(
      createGateRunner().start("p", tmp(), { name: "mix", command: "printf 'half'; sleep 0.1; echo err >&2; sleep 0.1; echo ' done'" }),
    ).done;
    expect(view.output.split("\n").sort()).toEqual(["err", "half done"]);
  });

  it("keeps only the last lines of the output and says it truncated", async () => {
    const view = await started(createGateRunner({ tailLines: 5 }).start("p", tmp(), { name: "seq", command: "seq 1 100" }))
      .done;
    expect(view.output.split("\n")).toEqual(["96", "97", "98", "99", "100"]);
    expect(view.truncated).toBe(true);
  });

  it("strips ANSI colour escapes from the tail", async () => {
    const view = await started(
      createGateRunner().start("p", tmp(), { name: "colour", command: `printf '\\033[31mred\\033[0m done\\n'` }),
    ).done;
    expect(view.output).toBe("red done");
    expect(stripAnsi("\x1b[1;32mok\x1b[0m")).toBe("ok");
  });

  it("reports a spawn failure as failed and frees the slot", async () => {
    const runner = createGateRunner();
    const view = await started(runner.start("p", join(tmp(), "missing"), { name: "gone", command: "echo hi" })).done;
    expect(view.state).toBe("failed");
    expect(view.exitCode).toBeNull();
    expect(view.error).toContain("could not start gate 'gone'");
    // Said once, in `error`: the page draws both, so the tail does not repeat it.
    expect(view.output).toBe("");
    const next = await started(runner.start("p", tmp(), { name: "ok", command: "true" })).done;
    expect(next.state).toBe("passed");
  });

  it("returns the last finished run from current(), and null for an unknown key", async () => {
    const runner = createGateRunner();
    expect(runner.current("p")).toBeNull();
    await started(runner.start("p", tmp(), { name: "a", command: "echo a" })).done;
    const last = await started(runner.start("p", tmp(), { name: "b", command: "exit 1" })).done;
    expect(runner.current("p")).toEqual(last);
    expect(runner.current("p")?.gate).toBe("b");
    expect(runner.current("q")).toBeNull();
  });
});
