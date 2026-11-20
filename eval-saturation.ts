/**
 * Saturated test-set cases (#860): a case every agent arm passed in each of
 * its last N set runs no longer tells the arms apart, so it only costs trial
 * time. It is flagged and suggested for retirement.
 *
 * This only FLAGS. Nothing here changes a case's stored status: retiring or
 * keeping it is the operator's call, and an operator's "Keep" (`keptAt`)
 * restarts the window, so only runs after it count towards saturation again.
 *
 * Pure: it reads run summaries it is given, never the disk, and spawns nothing.
 */
import type { EvalCaseView, EvalRunSummary } from "./eval-runs";

/** How many newest set runs a case must be a full pass in to be saturated. */
export const DEFAULT_SATURATION_RUNS = 3;

/** The project's `evalsSaturation` with the default filled: N, the set runs in a row a case must pass. */
export function saturationSettings(config: { evalsSaturation?: { runs?: number } }): { runs: number } {
  return { runs: config.evalsSaturation?.runs ?? DEFAULT_SATURATION_RUNS };
}

/** The human reference arm: it is what merged, so it is never graded. */
const REFERENCE_ARM = "a";

export interface CaseSaturation {
  saturated: boolean;
  /** Full passes among the newest counted runs (at most `window`), counted from the newest up to the first that was not one. */
  passes: number;
  /** N: the runs a case must pass in a row. */
  window: number;
}

/** Milliseconds since the epoch, or null for a timestamp that does not parse. */
function instant(at: string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether every agent arm passed the case in this run. A judge-only case
 * passes an arm the panel ranked at or above the reference; with no ranking,
 * or a ranking missing the arm or the reference, there is nothing to say it
 * passed, so it did not.
 */
function fullPass(view: EvalCaseView): boolean {
  const grader = view.grade?.grader;
  if (grader === undefined) return false;
  const agents = view.arms.filter((arm) => arm.arm !== REFERENCE_ARM);
  if (agents.length === 0) return false;
  if (grader === "judge-only") {
    const ranking = view.ranking;
    if (ranking === null) return false;
    const tier = (arm: string): number => ranking.findIndex((ids) => ids.includes(arm));
    const reference = tier(REFERENCE_ARM);
    if (reference < 0) return false;
    return agents.every((arm) => {
      const at = tier(arm.arm);
      return at >= 0 && at <= reference;
    });
  }
  return agents.every((arm) => arm.objective === "pass");
}

function checkWindow(window: number): void {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`saturation window must be a positive integer, got ${String(window)}`);
  }
}

/**
 * The case's saturation over the set runs given. A run counts when it is a
 * finished set run that graded the case and started after `keptAt`; the
 * newest `window` of those decide, newest first by `startedAt` whatever the
 * input order.
 */
export function caseSaturation(caseId: string, runs: readonly EvalRunSummary[], options: { window: number; keptAt?: string | null }): CaseSaturation {
  const { window } = options;
  checkWindow(window);
  // A malformed keptAt is ignored rather than hiding every run: the flag is
  // only a suggestion, and a missing one is the worse failure.
  const kept = instant(options.keptAt);
  const counted: { at: number; view: EvalCaseView }[] = [];
  for (const run of runs) {
    if (run.source.kind !== "set" || run.running) continue;
    const view = run.cases.find((c) => c.key === caseId && c.grade !== null);
    if (view === undefined) continue;
    const at = instant(run.startedAt);
    if (at === null) continue;
    if (kept !== null && at <= kept) continue;
    counted.push({ at, view });
  }
  counted.sort((x, y) => y.at - x.at);
  let passes = 0;
  for (const { view } of counted.slice(0, window)) {
    if (!fullPass(view)) break;
    passes += 1;
  }
  return { saturated: passes === window, passes, window };
}

/** Each case's saturation, keyed by its id, each with its own `keptAt`. */
export function saturationById(cases: readonly { id: string; keptAt?: string }[], runs: readonly EvalRunSummary[], window: number): Map<string, CaseSaturation> {
  checkWindow(window);
  const out = new Map<string, CaseSaturation>();
  for (const c of cases) out.set(c.id, caseSaturation(c.id, runs, { window, keptAt: c.keptAt ?? null }));
  return out;
}
