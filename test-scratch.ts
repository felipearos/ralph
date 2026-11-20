/**
 * A throwaway directory that removes itself when the test that asked for it
 * ends.
 *
 * `test-tmp.global.ts` already puts the whole run's temp output inside one root
 * it deletes, so this is the second half of #271 rather than the first: it
 * keeps a *single run* from making tens of thousands of directories while it is
 * still going, and it is what `test-mkdtemp.test.ts` asks of a test source that
 * wants scratch space — one call, cleanup included, nothing to forget.
 *
 * This is the thin layer that registers vitest's hooks; the removal itself is
 * `removeScratchDir` in `test-tmp.ts`, which stays vitest-free so non-test
 * helpers can use it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished } from "vitest";

import { removeScratchDir } from "./test-tmp";

/**
 * `mkdtemp` under the run's temp root, removed when the current test finishes
 * — passing, failing or throwing. `prefix` names the suite, as before.
 *
 * `onTestFinished` is vitest's per-test hook, so this has to be reached from
 * inside a running test; a directory a whole FILE shares wants
 * {@link fileScratchDir}.
 */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    discard(dir);
  });
  return dir;
}

/**
 * The same, for a directory a whole test FILE shares: removed in an `afterAll`,
 * which a test file (or a setup file, which runs in one) may register at module
 * scope where `onTestFinished` throws.
 */
export function fileScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => {
    discard(dir);
  });
  return dir;
}

/**
 * Remove `dir`, reporting rather than throwing if it still will not go.
 *
 * Deliberately swallowed: the directory sits inside the run root that
 * `test-tmp.global.ts` deletes, so what is left is a note rather than a leak,
 * and a test that passed must not go red over its own cleanup.
 */
function discard(dir: string): void {
  try {
    removeScratchDir(dir);
  } catch (error) {
    process.stderr.write(`\ntest-scratch: ${dir} outlived its test: ${String(error)}\n`);
  }
}
