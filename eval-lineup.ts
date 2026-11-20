/**
 * The models.json a lineup proposal stands for (#875): one pure function, so
 * the improver's trial lineup (`evals-improve.ts`) and the PR that ships a
 * passed proposal (`eval-open-pr.ts`) build it the same way.
 */
import type { LineupContent } from "./eval-improver";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One stage of a lineup proposal over the base: on the base's runner the
 * base's other fields (effort, fallback) still hold and only the model moves;
 * on another runner they belong to the old one, so the stage is runner and
 * model alone. A proposal naming no runner keeps the base's.
 */
function mergeStage(current: unknown, change: { model: string; runner?: string }): Record<string, unknown> {
  const prior = isRecord(current) ? current : {};
  const baseRunner = typeof prior.runner === "string" ? prior.runner : undefined;
  const runner = change.runner ?? baseRunner;
  if (runner === undefined) return { model: change.model };
  if (runner !== baseRunner) return { runner, model: change.model };
  return { ...prior, model: change.model };
}

/** `config` with the proposal's stages laid over its `default` block; everything else is kept as is. Not validated. */
export function proposedLineup(config: Record<string, unknown>, stages: LineupContent["stages"]): Record<string, unknown> {
  const base = isRecord(config.default) ? config.default : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [stage, change] of Object.entries(stages)) {
    // models.json nests a dotted stage: review.correctness lives at default.review.correctness.
    const [head, leaf] = stage.split(".") as [string, string | undefined];
    if (leaf === undefined) {
      merged[head] = mergeStage(base[head], change);
    } else {
      // From the map being built, not the base: a second stage of the same group must keep the first.
      const group: Record<string, unknown> = isRecord(merged[head]) ? { ...merged[head] } : {};
      group[leaf] = mergeStage(group[leaf], change);
      merged[head] = group;
    }
  }
  return { ...config, default: merged };
}
