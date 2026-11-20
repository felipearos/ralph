/**
 * Vitest's `globalSetup`: fail the run when a suite wrote into this checkout's
 * own `.ralph/` tree.
 *
 * See `test-ralph-logs.ts` for why that matters. This file runs in vitest's
 * main process, once, *before* `test-ralph-env.setup.ts` scrubs the harness
 * environment out of the workers — which is the only place the running loop's
 * `RALPH_RUN_ID` and `RALPH_SESSION_ID` are still readable, and those are what
 * tell a live supervisor's own writes apart from the run's. `RALPH_LOOP_NAME`
 * is read here too: an operator command with no run is addressed by loop name.
 *
 * `RALPH_TEST_LOGS_GUARD_ROOT` points the guard at another checkout; the
 * guard's own test uses it to watch a scratch tree instead of this one.
 */
import {
  describeChanges,
  guardedRoots,
  liveLoopPaths,
  liveOperatorCommands,
  offences,
  snapshotRoots,
  type Snapshot,
} from "./test-ralph-logs";

const repo = process.env.RALPH_TEST_LOGS_GUARD_ROOT?.trim() || import.meta.dirname;
const roots = guardedRoots(repo, (root) => {
  const supervisor = liveLoopPaths(process.env);
  const operator = liveOperatorCommands(root, process.env);
  return (path) => supervisor(path) || operator(path);
});

let before: Map<string, Snapshot> = new Map();

export function setup(): void {
  before = snapshotRoots(roots);
}

export function teardown(): void {
  const offending = offences(before, roots);
  if (offending.size === 0) return;
  const report = [...offending].map(([root, changes]) => describeChanges(root, changes)).join("\n\n");
  // Not thrown: vitest catches a teardown error, prints it as "error during
  // close" and still exits 0, which would make this guard decorative. The exit
  // code set here is the last word, and the suite that polluted the checkout is
  // usually green, so the report goes out below its results.
  process.stderr.write(`\n${report}\n`);
  process.exitCode = 1;
}
