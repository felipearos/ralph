import { defineConfig } from 'vitest/config';

import { hostTestWorkers } from './test-workers';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'journal/**', 'logs/**', '.claude/**'],
    // A pre-push hook runs with GIT_DIR set to the outer checkout; this strips
    // it (and its siblings) before every suite so fixtures stay hermetic. The
    // colour setup keeps a shell's FORCE_COLOR out of children's output.
    setupFiles: ['./test-git-env.setup.ts', './test-config-home.setup.ts', './test-color-env.setup.ts', './test-ralph-env.setup.ts'],
    // `test-tmp.global.ts` comes first: it points `TMPDIR` at one root for the
    // whole run and removes it on teardown, so the suite stops leaving a
    // directory per test file behind in the host's `/tmp` (#271).
    // Then the logs guard: a suite that drives a harness script without an
    // explicit scratch project writes into this checkout's own `.ralph/`, which
    // is the live loop's when ralph runs the suite as its gate. It snapshots the
    // tree and fails the run naming what changed (test-ralph-logs.ts).
    globalSetup: ['./test-tmp.global.ts', './test-ralph-logs.global.ts'],
    // Fewer workers on a loaded host, the Vitest default on an idle one (#187);
    // RALPH_TEST_MAX_WORKERS overrides it. Test timeouts stay at the default
    // here: suites that spawn processes raise their own, with a reason
    // (test-timeouts.ts).
    maxWorkers: hostTestWorkers(),
  },
});
