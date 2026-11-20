/**
 * The Labels page's decisions: which labels the loops need, which of those the
 * repository is missing, and the repository's labels no loop needs. `.tsx` has
 * no tests, so what the page shows is pinned in `labels-model.test.ts`.
 */
import type { LabelsView, ProjectLabelView } from "../contracts";

export interface LabelsPage {
  /** Labels at least one roster loop needs, missing ones first, then by name. */
  needed: ProjectLabelView[];
  /** Labels the repository has and no loop needs, by name. */
  other: ProjectLabelView[];
  /** How many needed labels the repository is known not to have. */
  missing: number;
}

const byName = (a: ProjectLabelView, b: ProjectLabelView): number => a.name.localeCompare(b.name);

export function labelsPage(view: LabelsView): LabelsPage {
  const needed = view.labels.filter((label) => label.usedBy.length > 0);
  // Missing first: a missing claim label is a loop that cannot start.
  needed.sort((a, b) => Number(a.onRepo !== false) - Number(b.onRepo !== false) || byName(a, b));
  return {
    needed,
    other: view.labels.filter((label) => label.usedBy.length === 0).sort(byName),
    missing: needed.filter((label) => label.onRepo === false).length,
  };
}

/**
 * The swatch colour, or null for one that is not a six-digit hex: the value is
 * the repository's, and only a colour is ever put into a style.
 */
export function swatch(color: string | null): string | null {
  return color !== null && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;
}

/** The repository's issues and pull requests carrying the label. */
export function labelHref(repo: string | null, name: string): string | null {
  return repo === null ? null : `https://github.com/${repo}/issues?q=${encodeURIComponent(`label:"${name}"`)}`;
}

/** The command that creates a missing label, as the preflight's remedy spells it. */
export function createCommand(repo: string | null, name: string): string {
  const quoted = /^[A-Za-z0-9._:/-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
  return `gh label create ${quoted}${repo === null ? "" : ` --repo ${repo}`}`;
}
