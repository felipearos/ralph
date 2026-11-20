/**
 * Per-suite time budgets for tests that spawn real processes.
 *
 * Vitest's 5 s default suits a test that stays in-process. A suite that runs
 * `bash ralph.sh`, `bun some-cli.ts` or `git` against a fixture pays for
 * process start-up, module loading and disk on every test, and on a loaded
 * host (a load average of 40 on 16 cores: Buildkite E2E, five loops and agent
 * runs) that cost stretches past 5 s while the test is still healthy. A full
 * `bun run test` then failed with 20–33 `Test timed out in 5000ms` errors, each
 * in a test that passed when run alone (#187), which made the pre-push hook and
 * a loop's `test` gate flake.
 *
 * The default is not raised globally: an in-process test that takes seconds is
 * itself a bug worth a timeout. Instead each suite that spawns calls
 * {@link subprocessSuite} once, at the top of the file, naming what it spawns,
 * and gets a budget sized for a loaded host. The budget is still finite, so a
 * test that genuinely hangs (a child that never exits, a promise that never
 * settles) still fails; `test-timeouts.test.ts` proves it through a real
 * Vitest run.
 */
import { vi } from "vitest";

/**
 * Per-test and per-hook budget for a subprocess suite.
 *
 * The slowest healthy test measured on a loaded host (load 43–74 on 16 cores)
 * took about 18 s; the tests that timed out at 5 s took 5–13 s. 30 s leaves
 * room for that without letting a hang sit for minutes. A test that is slower
 * by design keeps its own, larger, per-test timeout.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

/**
 * Give every test and hook in the calling file the subprocess budget.
 *
 * Call it at module level, before any `describe`/`it`: Vitest reads the
 * timeout when a test is collected, and resets it after the file. `why` names
 * what the suite spawns; it is required so the reason for the raised budget
 * sits where the budget is declared. `timeoutMs` exists for the hang proof and
 * for a suite that needs a documented, different budget.
 */
export function subprocessSuite(why: string, timeoutMs: number = SUBPROCESS_TEST_TIMEOUT_MS): void {
  if (!why.trim()) throw new Error("subprocessSuite: name what the suite spawns");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`subprocessSuite: timeout must be a finite positive number, got ${timeoutMs}`);
  }
  vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });
}
