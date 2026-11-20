/**
 * How many Vitest workers a `bun run test` may start.
 *
 * Vitest defaults to one worker per core but one (15 on this 16-core host),
 * and most of this suite's workers spawn `bash`, `bun` and `git` children of
 * their own. On a host already carrying a load average of 40 (Buildkite E2E,
 * five loops, agent runs), 15 more workers only deepen the run queue: every
 * test gets a thinner slice of CPU, and subprocess tests cross their timeouts
 * (#187). So the cap follows the cores the host has free when the run starts:
 *
 * - idle host: the Vitest default, so an idle run is no slower than before;
 * - loaded host: the free cores, but never below a quarter of the cores, so a
 *   run on a saturated host still finishes in reasonable time.
 *
 * `RALPH_TEST_MAX_WORKERS` (a positive integer) overrides the computation, for
 * a loop's `test` gate or an operator who knows better; anything else in it is
 * ignored rather than failing the run.
 */
import { availableParallelism, loadavg } from "node:os";

export interface WorkerHost {
  /** Logical cores (`os.availableParallelism()`). */
  cpus: number;
  /** One-minute load average (`os.loadavg()[0]`); 0 where the OS has none. */
  load1: number;
  /** The raw `RALPH_TEST_MAX_WORKERS` value, if set. */
  override?: string | undefined;
}

/** The worker cap for a run on `host`. Always at least 1. */
export function maxTestWorkers({ cpus, load1, override }: WorkerHost): number {
  const forced = Number(override);
  if (override?.trim() && Number.isInteger(forced) && forced > 0) return forced;

  const cores = Number.isFinite(cpus) && cpus >= 1 ? Math.floor(cpus) : 1;
  const ceiling = Math.max(cores - 1, 1);
  const floor = Math.max(Math.floor(cores / 4), 1);
  const load = Number.isFinite(load1) && load1 > 0 ? load1 : 0;
  const free = Math.floor(cores - load);
  return Math.min(ceiling, Math.max(floor, free));
}

/** The worker cap for a run starting now, on this host, under `env`. */
export function hostTestWorkers(env: NodeJS.ProcessEnv = process.env): number {
  return maxTestWorkers({
    cpus: availableParallelism(),
    load1: loadavg()[0] ?? 0,
    override: env.RALPH_TEST_MAX_WORKERS,
  });
}
