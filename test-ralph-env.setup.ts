/**
 * Vitest loads this before every test file. A live loop runs this suite as its
 * `test` gate, and its supervisor exports the harness's identity into that
 * process: `RALPH_PROJECT` (the loop's own worktree), `RALPH_RUN_ID`,
 * `RALPH_LOOP_NAME`, `RALPH_SESSION_ID` and the rest. A suite that starts
 * `ralph.sh` or another harness script with `process.env`, and doesn't override
 * every one of them, then acts on the live loop. That happened when ralph
 * first worked on itself: fixture iterations wrote thousands of lines into the
 * running loop's supervisor log, and left codex-thread and host-lease files in
 * its `.ralph/logs`. Remove the harness's variables here so every test starts
 * from a clean identity; a suite that needs one sets it explicitly.
 * `RALPH_TEST_*` is the suite's own configuration and stays.
 *
 * `RALPH_FINDINGS_RECORD` is then pointed into a per-file scratch directory, so
 * no `promoteFinding` in a suite, nor a child it spawns, reads or writes the
 * host's real `~/.ralph/findings.json`.
 */
import { join } from "node:path";

import { fileScratchDir } from "./test-scratch";

/** Whether `name` is a harness variable a test process must not inherit. */
export function isHarnessEnv(name: string): boolean {
  return name.startsWith("RALPH_") && !name.startsWith("RALPH_TEST_");
}

/** Strip every inherited harness variable from `env` (the process by default). */
export function stripHarnessEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) if (isHarnessEnv(name)) delete env[name];
}

stripHarnessEnv();
process.env.RALPH_FINDINGS_RECORD = join(fileScratchDir("ralph-test-findings-"), "findings.json");
// Set after the strip, which runs once at load, so it is what every test
// inherits. CI is the self-hosted runner that also hosts the live loops: a
// suite running the real `start.sh` must not create `ralph-loop-*` systemd
// units there, nor stop a live loop's. A test of the systemd path re-enables
// it explicitly, with fake `systemd-run` and `systemctl` on its PATH.
process.env.RALPH_LOOP_SCOPE = "off";
