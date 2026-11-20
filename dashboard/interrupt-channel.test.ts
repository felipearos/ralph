// @vitest-environment node
/**
 * Stop now and Resume work, end to end, against the real implementations of
 * every fact they depend on.
 *
 * As `lifecycle-channel.test.ts` does, the real `start.sh` and `project.sh`
 * are copied into a scratch harness beside a fake `nohup` and a fake
 * `ralph.sh`. The fake supervisor writes its durable records and then holds a
 * "turn" open — a child process it waits on — the way a model holding a turn
 * keeps the next iteration boundary out of reach. Stop now then runs through
 * the real signal adapter (its `/proc` checks and the process-group signal),
 * the real `flock`, and the real `controls.ts interrupted`; Resume work runs
 * the real `start.sh` again, and the real `loop-state.ts` reads liveness.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createProcessExecutor, createRalphControlAdapter } from "./control-adapter";
import { bunPath, removeScratchDir, writeProjectConfig } from "./fixtures";
import { createInterruptAdapter, SIGNAL_SURFACE } from "./interrupt-adapter";
import { stopNow, type InterruptDeps } from "./interrupt";
import { createRalphLifecycleAdapter } from "./lifecycle-adapter";
import { resumeWork, start, type LifecycleDeps } from "./lifecycle";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("interrupts real loop processes through the adapter");

const REPO_ROOT = dirname(__dirname);
const BUN = process.env.RALPH_TEST_BUN ?? bunPath();
const scratchRoots: string[] = [];
const groups: number[] = [];

afterAll(() => {
  // Test cleanup only: whatever a failed assertion left of this suite's own supervisors.
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
  }
  // SIGKILL is not synchronous; a dying supervisor can still land a file (#187).
  scratchRoots.splice(0).forEach((dir) => removeScratchDir(dir));
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Loop {
  root: string;
  common: string;
  lifecycle: LifecycleDeps;
  interrupt: InterruptDeps;
  events: () => string[];
}

function scratchLoop(label: string, options: { straggler?: boolean } = {}): Loop {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `ralph-interrupt-channel-${label}-`)));
  scratchRoots.push(scratch);
  const root = join(scratch, "project");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  const common = join(scratch, "gitcommon");
  for (const dir of [root, home, bin, common, join(root, ".ralph", "logs")]) mkdirSync(dir, { recursive: true });
  writeProjectConfig(root);
  for (const file of ["start.sh", "project.sh"]) cpSync(join(REPO_ROOT, file), join(home, file));
  chmodSync(join(home, "start.sh"), 0o755);
  const events = join(root, "events.log");
  writeFileSync(events, "");

  const script = (path: string, lines: string[]): void => {
    writeFileSync(path, [...lines, ""].join("\n"));
    chmodSync(path, 0o755);
  };
  script(join(bin, "nohup"), ["#!/usr/bin/env bash", 'exec "$@"']);
  script(join(bin, "git"), [
    "#!/bin/sh",
    'case "$1" in',
    `  rev-parse) case "$*" in *--git-common-dir*) printf '%s\\n' ${JSON.stringify(common)} ;; esac ;;`,
    "  symbolic-ref) printf '%s\\n' 'ralph/49-stop-now' ;;",
    "  status) printf '%s\\n' ' M half-done.ts' ;;",
    "  log) printf '%s\\n' 'abc1234 feat: the half that was committed' ;;",
    "esac",
    "exit 0",
  ]);
  // The fake supervisor: its records, the ticket it claims, then a turn held
  // open on a child — the one thing an orderly stop cannot get past.
  script(join(home, "ralph.sh"), [
    "#!/usr/bin/env bash",
    'run="run-$$"',
    'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
    'later="$(date -u -d "+10 minutes" +%Y-%m-%dT%H:%M:%S.000Z)"',
    `printf '{"version":1,"run":"%s","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/49-stop-now","stage":"iteration","iteration":{"index":3,"max":50},"heartbeat":"%s","lastEvent":null,"stopReason":null}' "$run" "$$" "$PWD" "$now" > .ralph/logs/state.json`,
    `printf '{"version":1,"leases":{"49":{"version":1,"issue":49,"run":"%s","owner":"ralph@test","loop":"ralph","pid":%s,"host":"test","worktree":"%s","branch":"ralph/49-stop-now","claim":"ralph-wip","logs":".ralph/logs","usageLedger":"","claimedAt":"%s","heartbeatAt":"%s","expiresAt":"%s","attempt":1,"history":[]}}}' "$run" "$$" "$PWD" "$now" "$now" "$later" > ${JSON.stringify(join(common, "ralph-claim-leases.json"))}`,
    // A child the iteration left behind that ignores SIGTERM: a hung test runner, a dev server.
    ...(options.straggler ? [`bash -c 'trap "" TERM; exec sleep 300' &`, `printf 'straggler %s\\n' "$!" >> ${JSON.stringify(events)}`] : []),
    "sleep 300 &",
    `printf 'start %s resume=%s turn=%s\\n' "$run" "\${RALPH_RESUME_WORK:-}" "$!" >> ${JSON.stringify(events)}`,
    "wait",
    `printf 'exit %s\\n' "$run" >> ${JSON.stringify(events)}`,
  ]);

  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH ?? ""}`, RALPH_LOOP_NAME: "ralph" };
  const exec = createProcessExecutor();
  const control = createRalphControlAdapter({ cliDir: REPO_ROOT, root, bunPath: BUN, env, exec });
  return {
    root,
    common,
    lifecycle: {
      control,
      lifecycle: createRalphLifecycleAdapter({ cliDir: REPO_ROOT, root, bunPath: BUN, env, startScript: join(home, "start.sh"), exec }),
      loop: "ralph",
    },
    interrupt: { interrupt: createInterruptAdapter({ root }), control, loop: "ralph", termGraceMs: 5_000, pollIntervalMs: 50 },
    events: () => readFileSync(events, "utf8").split("\n").filter((line) => line !== ""),
  };
}

function waitForStart(loop: Loop, count: number): { run: string; turn: number } {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const started = loop.events().filter((line) => line.startsWith("start "));
    if (started.length >= count) {
      const [, run, , turn] = /^start (\S+) resume=(\S*) turn=(\d+)$/.exec(started[count - 1]!)!;
      return { run: run!, turn: Number(turn) };
    }
    execFileSync("sleep", ["0.05"]);
  }
  throw new Error("the fake supervisor never started");
}

describe("stop now, through the real start.sh, signal and control record", () => {
  it("ends a loop mid-turn, records it interrupted with the iteration and ticket, keeps the claim, and resumes it in place", async () => {
    const loop = scratchLoop("stop-now");
    const started = await start(loop.lifecycle, { loop: "ralph" });
    expect(started.outcome, started.why).toBe("started");
    const { run, turn } = waitForStart(loop, 1);
    const supervisor = Number(readFileSync(join(loop.root, SIGNAL_SURFACE.pidFile), "utf8"));
    groups.push(supervisor);

    const result = await stopNow(loop.interrupt, { loop: "ralph", id: "now-1", why: "held a turn open for an hour" });

    expect(result.outcome, result.why).toBe("interrupted");
    expect(result.checks.map((check) => check.ok)).toEqual([true, true, true, true, true]);
    expect(result.target.pid).toBe(supervisor);
    expect(result.signals).toEqual(["SIGTERM"]);
    expect(result.run).toBe(run);
    expect(result).toMatchObject({ recorded: true, stop: { kind: "interrupted", confirmation: "confirmed", iteration: 3, issue: 49 } });
    // The supervisor and the turn it was waiting on are both gone, promptly.
    expect(alive(supervisor)).toBe(false);
    expect(alive(turn)).toBe(false);

    // The loop's own records say how it ended.
    const state = JSON.parse(readFileSync(join(loop.root, ".ralph/logs/state.json"), "utf8"));
    expect(state).toMatchObject({ run, stage: "stopped", stopReason: { kind: "interrupted", why: "held a turn open for an hour" } });
    const controls = JSON.parse(readFileSync(join(loop.root, ".ralph/logs/controls.json"), "utf8"));
    expect(controls.stop).toMatchObject({ kind: "interrupted", confirmation: "confirmed", key: "now-1", iteration: 3, issue: 49 });
    // The claim is kept.
    expect(Object.keys(JSON.parse(readFileSync(join(loop.common, "ralph-claim-leases.json"), "utf8")).leases)).toEqual(["49"]);
    // Every signal is on file: the intent before the signal, then the outcome.
    const audit = readFileSync(join(loop.root, SIGNAL_SURFACE.audit.path), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((entry) => [entry.event, entry.signal])).toEqual([
      ["signal", "SIGTERM"],
      ["outcome", "SIGTERM"],
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ id: "now-1", reason: "held a turn open for an hour", target: { pid: supervisor } });
      expect(entry.checks).toHaveLength(5);
    }

    // A second Stop now finds nothing to signal, and says why.
    const again = await stopNow(loop.interrupt, { loop: "ralph", id: "now-2" });
    expect(again.outcome).toBe("refused");
    expect(again.signals).toEqual([]);

    // Resume work: same worktree, HEAD kept, the lock free again.
    const resumed = await resumeWork(loop.lifecycle, { loop: "ralph" });
    expect(resumed.outcome, resumed.why).toBe("started");
    expect(resumed.checkout).toMatchObject({ branch: "ralph/49-stop-now", dirty: true, unpushed: ["abc1234 feat: the half that was committed"] });
    const second = waitForStart(loop, 2);
    groups.push(Number(readFileSync(join(loop.root, SIGNAL_SURFACE.pidFile), "utf8")));
    expect(loop.events().find((line) => line.startsWith(`start ${second.run} `))).toContain("resume=1");

    // And Stop now takes that one down too.
    const last = await stopNow(loop.interrupt, { loop: "ralph", id: "now-3" });
    expect(last.outcome, last.why).toBe("interrupted");
    expect(existsSync(join(loop.root, SIGNAL_SURFACE.audit.path))).toBe(true);
  }, 60_000);

  it("kills a child of the iteration that ignores SIGTERM, once the supervisor has gone", async () => {
    const loop = scratchLoop("straggler", { straggler: true });
    loop.interrupt.termGraceMs = 1_000;
    const started = await start(loop.lifecycle, { loop: "ralph" });
    expect(started.outcome, started.why).toBe("started");
    waitForStart(loop, 1);
    groups.push(Number(readFileSync(join(loop.root, SIGNAL_SURFACE.pidFile), "utf8")));
    const straggler = Number(loop.events().find((line) => line.startsWith("straggler "))!.split(" ")[1]);
    expect(alive(straggler)).toBe(true);

    const result = await stopNow(loop.interrupt, { loop: "ralph", id: "now-1" });

    expect(result.outcome, result.why).toBe("interrupted");
    expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.recorded).toBe(true);
    expect(result.why).not.toContain("still has members");
    expect(alive(straggler)).toBe(false);
  }, 60_000);
});
