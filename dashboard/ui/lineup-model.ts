/**
 * The lineup table's view logic, kept out of `lineup.tsx` so it is tested on
 * its own: stage groups, display words, and which cells an edit changed.
 */

/** Effort levels in words; a level this list does not know shows as the harness spells it. */
const EFFORT_NAMES: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
export const effortName = (effort: string): string => (effort === "" ? "Default" : (EFFORT_NAMES[effort] ?? effort));

/** "2.1.318 (Claude Code)" or "codex-cli 0.165.0" as just the version; null when none can be read. */
export const harnessVersion = (version: string | null): string | null => /\d+(?:\.\d+)+/.exec(version ?? "")?.[0] ?? null;

const GROUP_NAMES: Record<string, string> = { "": "Iteration", review: "Pre-PR review" };

/** Stages grouped by their dotted prefix, in schema order; an unknown prefix is its own group. */
export function stageGroups(stages: readonly string[]): { label: string; stages: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const stage of stages) {
    const prefix = stage.includes(".") ? stage.slice(0, stage.indexOf(".")) : "";
    groups.set(prefix, [...(groups.get(prefix) ?? []), stage]);
  }
  return [...groups].map(([prefix, members]) => ({ label: GROUP_NAMES[prefix] ?? prefix, stages: members }));
}

/** A stage's harness, model, effort and fallbacks as the form shows them for one config. */
export interface StageValues {
  runner: string;
  model: string;
  effort: string;
  fallback: string[];
  fallbackEfforts: Record<string, string>;
}

export interface ChangedFields {
  runner: boolean;
  model: boolean;
  effort: boolean;
  fallback: boolean;
}

/**
 * Which cells of one stage differ from the file. A field the row does not
 * show (an effort the harness takes none of, a fallback chain off Claude
 * Code) is not counted on its own: its change rides on the harness cell that
 * caused it, so the save bar's count always equals the blue cells.
 */
export function changedFields(
  now: StageValues,
  was: StageValues,
  shown: { effort: boolean; fallback: boolean },
): ChangedFields {
  return {
    runner: now.runner !== was.runner,
    model: now.model !== was.model,
    effort: shown.effort && now.effort !== was.effort,
    fallback:
      shown.fallback &&
      (JSON.stringify(now.fallback) !== JSON.stringify(was.fallback) ||
        JSON.stringify(now.fallbackEfforts) !== JSON.stringify(was.fallbackEfforts)),
  };
}

export const changedCount = (changed: ChangedFields): number =>
  Number(changed.runner) + Number(changed.model) + Number(changed.effort) + Number(changed.fallback);
