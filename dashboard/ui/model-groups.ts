import type { RunnerCatalogView } from "../../lineup/contracts";

export interface ModelChoice { id: string; label?: string }
export interface ModelGroup { label: string; choices: ModelChoice[] }

function claudeVersion(id: string): { family: string; version: number } | null {
  const current = /^claude-([a-z]+)-(\d+)(?:[.-](\d{1,2})(?:-|$))?/.exec(id);
  if (current) return { family: current[1]!, version: Number(current[2]) * 100 + Number(current[3] ?? 0) };
  const older = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)/.exec(id);
  return older ? { family: older[3]!, version: Number(older[1]) * 100 + Number(older[2] ?? 0) } : null;
}

/** Group the offered choices, preserving every value and its catalogue order. */
export function groupModels(
  choices: ModelChoice[], runner: string, catalog?: RunnerCatalogView,
  aliases: Record<string, string> = {},
): ModelGroup[] {
  const latest = new Map<string, number>();
  for (const model of catalog?.models ?? choices) {
    const parsed = claudeVersion(model.id);
    if (parsed) latest.set(parsed.family, Math.max(latest.get(parsed.family) ?? 0, parsed.version));
  }
  const targets = { ...aliases, ...catalog?.aliases };
  const groups = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    let label = "Other models";
    if (runner === "opencode") {
      const provider = choice.id.split("/")[0];
      label = provider === "opencode-go" ? "OpenCode Go" : provider === "opencode" ? "OpenCode" : provider || label;
    } else if (runner === "claude") {
      const parsed = claudeVersion(targets[choice.id] ?? choice.id);
      if (parsed && latest.has(parsed.family)) {
        label = parsed.version >= latest.get(parsed.family)! ? "New models" : "Older models";
      }
    } else if (runner === "codex") {
      const model = catalog?.models.find(model => model.id === choice.id);
      if (model) label = model.upgradeTo ? "Older models" : "New models";
    }
    const items = groups.get(label) ?? [];
    items.push(choice);
    groups.set(label, items);
  }
  const order = runner === "opencode" ? ["OpenCode Go", "OpenCode"] : ["New models", "Older models", "Other models"];
  const rank = (label: string) => order.includes(label) ? order.indexOf(label) : order.length;
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([label, choices]) => ({ label, choices }));
}

/**
 * The name a model is shown by in the lineup table: the harness's own label
 * ("Opus 5.5"), an alias as the model it points at today, OpenCode's id
 * without its provider, else the id itself — so an id the catalogue does not
 * know is still shown exactly as the file holds it.
 */
export function modelName(id: string, runner: string, catalog?: RunnerCatalogView, aliases: Record<string, string> = {}): string {
  const labelled = (modelId: string) => {
    const label = catalog?.models.find(model => model.id === modelId)?.label;
    return label !== undefined && !label.startsWith("alias for") ? label : null;
  };
  const own = labelled(id);
  if (own !== null) return own;
  if (runner === "opencode" && id.includes("/")) return id.slice(id.indexOf("/") + 1);
  const target = { ...aliases, ...catalog?.aliases }[id];
  if (runner === "claude" && target !== undefined) return `${labelled(target) ?? target} (${id})`;
  return id;
}
