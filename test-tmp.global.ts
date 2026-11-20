/**
 * Vitest's `globalSetup`: give the whole run one temp root, census it, and
 * remove it.
 *
 * See `test-tmp.ts` for why (#271). This runs in vitest's main process, once,
 * before any worker exists — which is what makes the `TMPDIR` assignment reach
 * every worker and every child a test spawns.
 */
import {
  createRunRoot,
  leakReport,
  leftovers,
  reapStaleRoots,
  realTmpRoot,
  removeRunRoot,
  runRootName,
  runStamp,
} from "./test-tmp";

/**
 * The census cap, overridable only so `test-tmp.global.test.ts` can drive a
 * child run over it without making two hundred directories.
 */
function cap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.RALPH_TEST_TMP_LEAK_CAP?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** How old a run root must be before it counts as an abandoned one. */
const STALE_MS = 2 * 60 * 60 * 1000;

let realTmp = "";
let runRoot = "";

export function setup(): void {
  realTmp = realTmpRoot(process.env);
  // A killed run leaves its root behind, since teardown never happens. Reap the
  // corpses first, so an aborted run costs one root until the next run and not
  // for good.
  reapStaleRoots(realTmp, Date.now(), STALE_MS);
  runRoot = createRunRoot(realTmp, runRootName(runStamp(new Date()), process.pid));
  // The redirect itself. Everything downstream — `os.tmpdir()` in a worker,
  // `mktemp -d` in a bash script a test drives — resolves here.
  process.env.TMPDIR = runRoot;
}

export function teardown(): void {
  if (!runRoot) return;
  const left = leftovers(runRoot);
  // `RALPH_TEST_TMP_CENSUS=1` prints the count on a passing run too, which is
  // how `LEAK_CAP` was set and how it should be re-set if the suite grows.
  if (process.env.RALPH_TEST_TMP_CENSUS) process.stderr.write(`\ntest-tmp: census ${left.length}\n`);
  try {
    removeRunRoot(runRoot, realTmp);
  } catch (error) {
    fail(`could not remove the run's temp root ${runRoot}: ${String(error)}`);
    return;
  }
  const report = leakReport(left, cap(process.env));
  if (report) fail(report);
}

/**
 * Report and fail, without throwing: vitest catches a teardown error, prints it
 * as "error during close" and still exits 0, which would make this decorative.
 * The exit code set here is the last word. `test-ralph-logs.global.ts` does the
 * same, for the same reason.
 */
function fail(message: string): void {
  process.stderr.write(`\ntest-tmp: ${message}\n`);
  process.exitCode = 1;
}
