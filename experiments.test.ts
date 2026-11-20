import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "./experiments";
import { SUBPROCESS_TEST_TIMEOUT_MS, subprocessSuite } from "./test-timeouts";

subprocessSuite("runs commands under bash and node in their own process groups");
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "ralph-ab-test-")); roots.push(root); return root; };

/** Half the suite's budget, so a predicate that never holds fails on the
 * assertion that names it rather than on the file's timeout. A test that waits
 * more than once passes its own, smaller, share of the budget. */
const PREDICATE_WAIT_MS = SUBPROCESS_TEST_TIMEOUT_MS / 2;
/** Poll until `ready()` holds; false once the bound expires. The only delay is
 * the poll's tick — the thing being waited for is a real event (a shell writing
 * a pid, a kill landing), whose timing a literal cannot predict under load. */
const until = async (ready: () => boolean, bound: number = PREDICATE_WAIT_MS): Promise<boolean> => {
  const deadline = Date.now() + bound;
  while (!ready()) {
    if (Date.now() > deadline) return false;
    await new Promise((resume) => setTimeout(resume, 5));
  }
  return true;
};
/** The process's state letter, or null when `/proc` has no entry for it: ENOENT
 * means it is gone, which is the answer, not an error. */
const procState = (pid: number): string | null => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null; }
  catch { return null; }
};
/** Dead enough: gone, or a zombie whose parent has not reaped it yet. */
const dead = (pid: number): boolean => { const state = procState(pid); return state === null || state === "Z"; };
/** The pid the fixture shell wrote, or 0 while it has not: `>` creates the file
 * before `echo` writes into it, and `Number("")` is 0, so the file existing is
 * not the predicate — a positive integer is. */
const childPid = (root: string): number => {
  try { return Number(readFileSync(join(root, "child.pid"), "utf8").trim()) || 0; } catch { return 0; }
};
/** A shell that outlives one child, so a kill that misses the group leaves the
 * `sleep` behind. Started without awaiting, killed through its abort signal.
 *
 * Its own timeout is three quarters of the suite's budget: later than any
 * predicate bound below, so it cannot be what ends a healthy run, and still
 * earlier than the per-test budget, so an abort that never lands ends inside
 * the test rather than as a bare "Test timed out". */
const orphanMaker = (root: string, abort: AbortSignal) =>
  runCommand(["bash", "-c", "sleep 30 & echo $! > child.pid; wait"], root, process.env,
    (SUBPROCESS_TEST_TIMEOUT_MS * 3) / 4, join(root, "command.log"), abort);
describe("runCommand", () => {
  it("redacts command logs and handles an unavailable command as a failed check", async () => {
    const root = scratch(); const log = join(root, "command.log");
    vi.stubEnv("OPENAI_API_KEY", "fixture-sensitive-api-value");
    await runCommand([process.execPath, "-e", "console.log(process.env.OPENAI_API_KEY)"], root, process.env, 5000, log);
    expect(readFileSync(log, "utf8")).not.toContain("fixture-sensitive-api-value");
    const result = await runCommand(["/no/such/program"], root, process.env, 1000, log);
    expect(result.exit).not.toBe(0); expect(readdirSync(root)).toContain("command.log");
  });

  it("kills a timed-out command's subprocesses as well as its shell", async () => {
    const root = scratch();
    const abort = new AbortController();
    // The abort signal is the trigger, not a wall clock. The old 1000 ms literal
    // raced the fixture itself: under load the shell had not always written
    // child.pid when the kill landed, and the read threw ENOENT (#353). The
    // budget passed to runCommand is a bound that must never fire first.
    const running = orphanMaker(root, abort.signal);
    expect(await until(() => childPid(root) > 0), "the fixture shell never wrote a child pid").toBe(true);
    const pid = childPid(root);
    abort.abort();
    const result = await running;

    // `kill()` is shared by the abort and timer paths and sets timedOut either
    // way, so this still asserts what the timeout path does.
    expect(result.timedOut).toBe(true);
    expect(await until(() => dead(pid)), `child ${pid} survived the kill (state ${procState(pid) ?? "gone"})`).toBe(true);
  });

  it("times a command out on its own clock, with no signal to drive it", async () => {
    // The two cases below drive the kill through an abort signal, so this is the
    // only unit-level cover for the timer branch and for `Math.max(1, timeoutMs)`.
    // It needs no fixture pid, so there is nothing here to race.
    const root = scratch();
    const result = await runCommand(["bash", "-c", "sleep 30"], root, process.env, 50, join(root, "command.log"));
    expect(result.timedOut).toBe(true);
    expect(result.exit).not.toBe(0);
  });

  it("does not resolve a timed-out command while its process group still runs", async () => {
    // Ten rounds, because the window this closes is a scheduling one: without
    // runCommand's wait, an immediate reading caught the orphan still in state
    // `R` in 4 of 25 loaded runs, so one round would under-report. With the
    // wait there is no window at all, so repeating costs ~10 ms and adds no
    // flake of its own.
    const survivors: string[] = [];
    const rounds = 10;
    for (let round = 0; round < rounds; round++) {
      const root = scratch();
      const abort = new AbortController();
      const running = orphanMaker(root, abort.signal);
      // A tenth of the single-round bound each, so ten rounds cannot between
      // them overrun the file's budget and turn a named assertion into a bare
      // "Test timed out" — the failure mode the literal above was removed for.
      expect(await until(() => childPid(root) > 0, PREDICATE_WAIT_MS / rounds), "the fixture shell never wrote a child pid").toBe(true);
      const pid = childPid(root);
      abort.abort();
      const result = await running;

      expect(result.timedOut).toBe(true);
      // One immediate reading per round, deliberately not a poll: runCommand
      // waits for the group itself, so a survivor is that wait regressing
      // rather than a slow host.
      if (!dead(pid)) survivors.push(`${pid} in state ${procState(pid) ?? "gone"} (round ${round})`);
    }
    expect(survivors, `a timed-out runCommand resolved over a live process group: ${survivors.join("; ")}`).toEqual([]);
  });
});
