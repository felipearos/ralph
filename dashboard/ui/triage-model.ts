/**
 * The triage panel's derivations (#147).
 *
 * The panel answers three questions an operator has about the triager: what is
 * waiting in its intake, what has it decided lately, and how much has it
 * written. All three are already on the dashboard; what is left is picking the
 * honest shape, which is what lives here — `.tsx` has no tests, so every
 * decision this panel makes is made in this file.
 */
import { TRIAGE_BUCKETS, triagers, type Dashboard, type TriageBucket, type TriageUnitView } from "../contracts";

/** One intake bucket on the panel. */
export interface TriageBucketRow {
  bucket: TriageBucket;
  count: number;
  /**
   * The bucket the intake would hand over next: the first NON-EMPTY one in
   * `TRIAGE_BUCKETS` order, so a cleared intake has none. Marked because
   * without it every count reads like a queue, when only this one is work
   * anybody is about to do.
   *
   * This is the single source for both the badge and the tint. The panel used
   * to re-derive `leading && count > 0` for the badge, which is `bucketTone`'s
   * own predicate — two copies of "which bucket is being worked", one of them
   * in a `.tsx` no test compiles.
   */
  next: boolean;
}

/** One triager's own row: what it wrote, and the units it decided. */
export interface TriagerRow {
  loop: string;
  /** Null when its ledgers could not be read — unknown, not nothing written. */
  writesLastHour: number | null;
  /** Null when nothing configured a cap, or the runtime never read one. */
  maxWrites: number | null;
  units: TriageUnitView[];
}

export interface TriagePanelView {
  /** Null when the frontier could not be read: the intake is unknown, not empty. */
  buckets: TriageBucketRow[] | null;
  /** Ready tickets no loop can take for want of a difficulty label; null is unknown. */
  untriaged: number | null;
  /** One row per triager on the roster, in roster order. */
  triagers: TriagerRow[];
}

/**
 * The panel, or null when this project has no triager.
 *
 * Null rather than an empty panel: a project that staffs no triager has no
 * intake to show, and drawing one with a zero per bucket would read as a clear
 * backlog rather than as a question nobody is asking.
 */
export function triagePanel(data: Dashboard): TriagePanelView | null {
  const rows = triagers(data.loops);
  if (rows.length === 0) return null;
  const view = data.frontier?.view ?? null;
  const leading = view === null ? null : (TRIAGE_BUCKETS.find((bucket) => view.triage[bucket] > 0) ?? null);
  return {
    buckets:
      view === null
        ? null
        : TRIAGE_BUCKETS.map((bucket) => ({ bucket, count: view.triage[bucket], next: bucket === leading })),
    untriaged: view === null ? null : view.untriaged.length,
    triagers: rows.map((entry) => ({
      loop: entry.loop,
      writesLastHour: entry.triage?.writesLastHour ?? null,
      maxWrites: entry.triage?.maxWrites ?? null,
      units: entry.triage?.units ?? [],
    })),
  };
}

/** Every bucket's count added up, or null while the intake is unknown. */
export const triageWaiting = (panel: TriagePanelView): number | null =>
  panel.buckets === null ? null : panel.buckets.reduce((sum, row) => sum + row.count, 0);

/**
 * How a bucket's count reads: the leading bucket is what a triager takes next,
 * and anything behind it is backlog nobody is stuck on.
 *
 * A cleared intake has no `next` bucket at all, so nothing is tinted — an
 * intake with nothing in it is the good case, and colouring it would make a
 * cleared backlog look like an alert.
 */
export const bucketTone = (row: TriageBucketRow): "neutral" | "info" => (row.next ? "info" : "neutral");
