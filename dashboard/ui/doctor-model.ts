import type { DoctorHistoryEntry, DoctorStepView, DoctorView } from "../contracts";

/**
 * Fold one answer into what the panel shows.
 *
 * A diagnosis is the whole picture and replaces it. A repair or Fix all
 * answers for its one plugin, so it replaces that plugin's checks and leaves
 * every other plugin's as they were; the steps and the history are the
 * newest answer's either way.
 */
export function mergeDoctorView(previous: DoctorView | null, next: DoctorView, scope: string | null): DoctorView {
  if (previous === null || scope === null || next.problem !== null) return next;
  const replaced = new Map(next.plugins.map((plugin) => [plugin.plugin, plugin]));
  const plugins = previous.plugins.map((plugin) => replaced.get(plugin.plugin) ?? plugin);
  for (const plugin of next.plugins) {
    if (!previous.plugins.some((row) => row.plugin === plugin.plugin)) plugins.push(plugin);
  }
  return { ...next, plugins };
}

export type Tone = "good" | "bad" | "warn" | "neutral";

export const STEP_TONE: Record<DoctorStepView["result"], Tone> = {
  repaired: "good",
  failed: "bad",
  "not-repairable": "warn",
};

export interface HistoryRow {
  key: string;
  at: string;
  /** What was done: a diagnosis, a repair on a check, or a Fix all. */
  what: string;
  result: string;
  tone: Tone;
  why: string;
}

const RESULT_TONE: Record<string, Tone> = {
  healthy: "good",
  repaired: "good",
  failing: "warn",
  stopped: "warn",
  "not-repairable": "warn",
  failed: "bad",
};

/** One plugin's recorded diagnoses and repairs, newest first. */
export function historyRows(history: DoctorHistoryEntry[], plugin: string): HistoryRow[] {
  return history
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.plugin === plugin)
    .reverse()
    .map(({ entry, index }) => ({
      key: `${entry.at}-${index}`,
      at: entry.at,
      what:
        entry.kind === "repair"
          ? `${entry.via === "fix-all" ? "fix all · " : ""}${entry.check ?? "?"} → ${entry.action ?? "?"}`
          : entry.kind === "fix-all"
            ? "fix all"
            : "diagnosis",
      result: entry.result,
      tone: RESULT_TONE[entry.result] ?? "neutral",
      why: entry.why,
    }));
}
