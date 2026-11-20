// @vitest-environment node
/**
 * Lifecycle dispatch in front of the real `start.sh`, control channel and
 * liveness check.
 *
 * Following `start.test.ts`: the real `start.sh` and `project.sh` are copied
 * into a scratch harness beside a fake `nohup` and a fake `ralph.sh`. The fake
 * supervisor does the one thing restart depends on — it runs the real
 * `controls.ts poll --supervised` between "iterations" and exits on a stop
 * that dispatch left in its inbox, exactly as `dispatch-channel.test.ts`
 * drives it. Liveness comes from the real
 * `loop-state.ts status --json`, which matches the fake supervisor by argv and
 * cwd in `/proc`. So "restart waited for a confirmed stop and a gone
 * supervisor before starting" is asserted through the implementations that own
 * each of those facts.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createProcessExecutor, createRalphControlAdapter } from "./control-adapter";
import { bunPath, removeScratchDir, waitForExit, writeProjectConfig } from "./fixtures";
import { createRalphLifecycleAdapter } from "./lifecycle-adapter";
import { restartToApply, start, type LifecycleDeps } from "./lifecycle";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("starts and stops real loop processes");

const REPO_ROOT = dirname(__dirname);
const BUN = process.env.RALPH_TEST_BUN ?? bunPath();
const scratchRoots: string[] = [];

afterAll(async () => {
  // Test cleanup only: the fake supervisors are this suite's own children.
  const signalled: number[] = [];
  for (const root of scratchRoots) {
    const events = join(root, "project", "events.log");
    if (!existsSync(events)) continue;
    for (const line of readFileSync(events, "utf8").split("\n")) {
      const pid = Number(/^start run-(\d+)/.exec(line)?.[1]);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
          signalled.push(pid);
        } catch {}
      }
    }
  }
  // A supervisor handling its SIGTERM still writes into its root; removing
  // the root under it failed teardown with ENOTEMPTY on a loaded host (#187).
  await waitForExit(signalled);
  scratchRoots.splice(0).forEach((dir) => removeScratchDir(dir));
});

interface Loop {
  root: string;
  deps: LifecycleDeps;
  events: () => string[];
  gitCalls: () => string[];
}

function scratchLoop(label: string): Loop {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `ralph-lifecycle-channel-${label}-`)));
  scratchRoots.push(scratch);
  const root = join(scratch, "project");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  const common = join(scratch, "gitcommon");
  for (const dir of [root, home, bin, common, join(root, ".ralph", "logs")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeProjectConfig(root);
  for (const file of ["start.sh", "project.sh"]) cpSync(join(REPO_ROOT, file), join(home, file));
  chmodSync(join(home, "start.sh"), 0o755);

  const events = join(root, "events.log");
  const gitLog = join(scratch, "git.calls");
  writeFileSync(events, "");

  const script = (path: string, lines: string[]): void => {
    writeFileSync(path, [...lines, ""].join("\n"));
    chmodSync(path, 0o755);
  };

  script(join(bin, "nohup"), ["#!/usr/bin/env bash", 'exec "$@"']);

  // Read-only git: the worktree registry is empty (loop-state falls back to
  // the worktree it was asked about), status reports recovery work, and every
  // call is logged so the suite can prove none of them repaired anything.
  script(join(bin, "git"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}`,
    'case "$1" in',
    `  rev-parse) case "$*" in *--git-common-dir*) printf '%s\\n' ${JSON.stringify(common)} ;; esac ;;`,
    "  symbolic-ref) printf '%s\\n' 'ralph/13-lifecycle' ;;",
    "  status) printf '%s\\n' '?? recovery-notes.md' ;;",
    "esac",
    "exit 0",
  ]);


  // The fake supervisor: a fresh run per process, its own durable records,
  // and the real control checkpoint between iterations.
  script(join(home, "ralph.sh"), [
    "#!/usr/bin/env bash",
    'run="run-$$"',
    'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
    `printf '{"version":1,"run":"%s","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/13-lifecycle","stage":"iteration","iteration":{"index":1,"max":50},"heartbeat":"%s","lastEvent":null,"stopReason":null}' "$run" "$$" "$PWD" "$now" > .ralph/logs/state.json`,
    // Announced only once its records exist, so a restart never reads an
    // identity the supervisor has not written yet.
    `printf 'start %s\\n' "$run" >> ${JSON.stringify(events)}`,
    "for _ in $(seq 1 400); do",
    `  RALPH_RUN_ID="$run" ${JSON.stringify(BUN)} ${JSON.stringify(join(REPO_ROOT, "controls.ts"))} poll --supervised >/dev/null 2>&1`,
    '  if [ "$?" -eq 20 ]; then',
    `    printf 'exit %s\\n' "$run" >> ${JSON.stringify(events)}`,
    "    exit 0",
    "  fi",
    "  sleep 0.1",
    "done",
  ]);

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_LOOP_NAME: "ralph",
  };

  const exec = createProcessExecutor();
  const lifecycle = createRalphLifecycleAdapter({
    cliDir: REPO_ROOT,
    root,
    bunPath: BUN,
    env,
    startScript: join(home, "start.sh"),
    exec,
  });
  const control = createRalphControlAdapter({ cliDir: REPO_ROOT, root, bunPath: BUN, env, exec });

  return {
    root,
    deps: {
      control,
      lifecycle,
      loop: "ralph",
      waitTimeoutMs: 30_000,
      pollIntervalMs: 100,
    },
    events: () => readFileSync(events, "utf8").split("\n").filter((line) => line !== ""),
    gitCalls: () => (existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter(Boolean) : []),
  };
}

/** Wait for the fake supervisor to be up and to have written its records. */
function waitForStart(loop: Loop, count: number): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (loop.events().filter((line) => line.startsWith("start ")).length >= count) return;
    execFileSync("sleep", ["0.05"]);
  }
  throw new Error("the fake supervisor never started");
}

describe("start through the real start.sh", () => {
  it("starts once and answers a second start as an already-running no-op", async () => {
    const loop = scratchLoop("start");
    const first = await start(loop.deps, { loop: "ralph" });
    expect(first.outcome, first.why).toBe("started");
    expect(first.pid).toBeGreaterThan(0);

    const second = await start(loop.deps, { loop: "ralph" });
    expect(second.outcome, second.why).toBe("already-running");
    expect(second.why).toContain("already running");

    waitForStart(loop, 1);
    expect(loop.events().filter((line) => line.startsWith("start "))).toHaveLength(1);
  }, 30_000);
});

describe("restart-to-apply through the real control channel", () => {
  it("waits for the old supervisor's confirmed stop and exit before starting a new one", async () => {
    const loop = scratchLoop("restart");
    const recovery = join(loop.root, "recovery-notes.md");
    writeFileSync(recovery, "half-finished ticket\n");

    const first = await start(loop.deps, { loop: "ralph" });
    expect(first.outcome, first.why).toBe("started");
    waitForStart(loop, 1);

    const result = await restartToApply(loop.deps, { loop: "ralph", why: "apply lineup edit", id: "restart-1" });
    expect(result.outcome, `${result.halt ?? ""} ${result.why}`).toBe("started");
    expect(result.confirmation).toBe("confirmed");
    expect(result.stop?.stop?.kind).toBe("blocked");
    expect(result.checkout).toMatchObject({ dirty: true, changes: ["?? recovery-notes.md"] });

    waitForStart(loop, 2);
    const [firstStart, firstExit, secondStart] = loop.events();
    expect(firstStart).toMatch(/^start run-\d+$/);
    // The old supervisor exited on the stop before the new one started.
    expect(firstExit).toBe(firstStart!.replace("start", "exit"));
    expect(secondStart).toMatch(/^start run-\d+$/);
    expect(secondStart).not.toBe(firstStart);

    const record = JSON.parse(readFileSync(join(loop.root, ".ralph", "logs", "controls.json"), "utf8"));
    expect(record.applied).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "restart-1", command: "stop", outcome: "applied" })]),
    );

    // Recovery work stays where it was; nothing repaired the checkout.
    expect(readFileSync(recovery, "utf8")).toBe("half-finished ticket\n");
    for (const call of loop.gitCalls()) {
      expect(call).not.toMatch(/^(reset|checkout|clean|stash|restore|switch|worktree remove|worktree prune)\b/);
    }
  }, 60_000);

  it("refuses to start while an old stop is unconfirmed and no supervisor exists", async () => {
    const loop = scratchLoop("restart-unreachable");
    writeFileSync(
      join(loop.root, ".ralph", "logs", "controls.json"),
      JSON.stringify({
        version: 1,
        ralphRun: "run-gone",
        loop: "ralph",
        ownerChangedAt: null,
        applied: [{ key: "old", command: "stop", at: "T", outcome: "applied", why: "stopping" }],
        hold: null,
        stop: { kind: "blocked", why: "nobody home", at: "T", key: "old", confirmation: "unreachable" },
        retries: [],
        abandoned: [],
        released: [],
        deferrals: [],
        degraded: null,
        lastPolledAt: null,
      }),
    );
    appendFileSync(join(loop.root, ".ralph", "logs", "state.json"), "");

    const result = await restartToApply(loop.deps, { loop: "ralph", id: "restart-2" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-unreachable" });
    expect(loop.events()).toHaveLength(0);
  }, 30_000);
});
