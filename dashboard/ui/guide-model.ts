/**
 * The "adding a new agent" guide, as the Add-agent panel renders it.
 *
 * `adding-an-agent.md` in the harness checkout is the single source of the
 * steps, the checklist and the troubleshooting table: the server sends its
 * bytes and this module parses them, so the dashboard holds no second copy of
 * any of it (`guide-model.test.ts` pins that by scanning the dashboard's own
 * sources for the tables' cells).
 *
 * Pure functions of the markdown and the project's values, like every other
 * `*-model.ts` here: the page only paints what these return.
 */
import type { GuideValues } from "../contracts";

export interface GuideTable {
  headers: string[];
  rows: string[][];
}

/** One numbered step of the guide: `## 4. Create the worktree`, and its prose. */
export interface GuideStep {
  number: number;
  title: string;
  /** The step's markdown, from under its heading to the next one. */
  body: string;
}

export interface Guide {
  /** The values the guide's own opening note says its examples use. */
  examples: GuideExamples | null;
  checklist: GuideTable | null;
  steps: GuideStep[];
  troubleshooting: GuideTable | null;
}

/** `| a | b |` split into its cells, with the outer pipes dropped. */
const cells = (line: string): string[] =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** A table's separator row — `|---|---|`, in any of its spellings. */
const isSeparator = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line.trim()) && line.includes("-");

const isRow = (line: string): boolean => line.trimStart().startsWith("|");

/**
 * The markdown's lines, with everything inside a fenced block marked.
 *
 * The guide's steps hold fenced JSON and shell, and both contain lines that
 * would otherwise read as a heading or a table row — `"loops": [...]` does
 * not, but a commented `## ` inside a fence would, and the JSON blocks are
 * full of `|` in their shell neighbours. A parser that ignores fences finds
 * tables inside code.
 */
const scan = (markdown: string): { text: string; fenced: boolean }[] => {
  let fence: string | null = null;
  return markdown.split("\n").map((text) => {
    const opening = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fence === null && opening !== null) {
      fence = opening[1]!;
      return { text, fenced: true };
    }
    if (fence !== null && opening !== null && opening[1]!.startsWith(fence[0]!) && opening[1]!.length >= fence.length) {
      fence = null;
      return { text, fenced: true };
    }
    return { text, fenced: fence !== null };
  });
};

/** The first table after `heading`, or null when that section has none. */
const tableUnder = (lines: { text: string; fenced: boolean }[], heading: string): GuideTable | null => {
  const start = lines.findIndex((line) => !line.fenced && line.text.trim() === heading);
  if (start === -1) return null;
  for (let at = start + 1; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (!line.fenced && /^##\s/.test(line.text)) return null;
    if (line.fenced || !isRow(line.text)) continue;
    const header = cells(line.text);
    const next = lines[at + 1];
    if (next === undefined || next.fenced || !isSeparator(next.text)) continue;
    const rows: string[][] = [];
    for (let row = at + 2; row < lines.length; row += 1) {
      const candidate = lines[row]!;
      if (candidate.fenced || !isRow(candidate.text)) break;
      rows.push(cells(candidate.text));
    }
    return { headers: header, rows };
  }
  return null;
};

const STEP_HEADING = /^##\s+(\d+)\.\s+(.+?)\s*$/;

/**
 * Parse the guide into the three things the panel shows. Anything it cannot
 * find is absent rather than an error: the panel then shows the markdown it
 * did get, which is still the guide.
 */
export function parseGuide(markdown: string): Guide {
  const lines = scan(markdown);
  const steps: GuideStep[] = [];
  let open: { step: GuideStep; body: string[] } | null = null;
  const close = (): void => {
    if (open !== null) steps.push({ ...open.step, body: open.body.join("\n").trim() });
    open = null;
  };
  for (const line of lines) {
    if (!line.fenced) {
      const heading = STEP_HEADING.exec(line.text);
      if (heading !== null) {
        close();
        open = { step: { number: Number(heading[1]), title: heading[2]!, body: "" }, body: [] };
        continue;
      }
      // Any other `## ` heading ends the step it followed.
      if (/^##\s/.test(line.text)) {
        close();
        continue;
      }
    }
    if (open !== null) open.body.push(line.text);
  }
  close();
  return {
    examples: guideExamples(markdown),
    checklist: tableUnder(lines, "## Checklist"),
    steps,
    troubleshooting: tableUnder(lines, "## Troubleshooting"),
  };
}

/**
 * The values the guide says its own examples use.
 *
 * Read out of the guide's opening note rather than written down here, for two
 * reasons. The note IS the declaration — "The examples use Loggd's values:
 * repo …, base branch …, main checkout …, loop worktrees under …. Replace
 * `testo` with the new name throughout" — so parsing it keeps the file the
 * single source of the substitution as much as of the steps. And the
 * dashboard may not name the operator's workspace manager at all (the
 * harness's own `plugin-boundary.test.ts`), which a hardcoded example worktree
 * path would.
 */
export interface GuideExamples {
  repo: string;
  baseBranch: string;
  /** The example project's main checkout. */
  root: string;
  /** The directory the example project's loop worktrees sit under. */
  worktrees: string;
  /** The example project's id: its repo's name. */
  project: string;
  /** The placeholder the note says to replace with the new agent's name. */
  name: string;
}

/** The note's values, in the order it states them; null when it cannot be read. */
export function guideExamples(markdown: string): GuideExamples | null {
  // The NOTE, not the whole file: the labels below are ordinary words, and a
  // later step writing "the repo `x`" would otherwise silently become the
  // needle every command in the panel is rewritten from. The note is what
  // precedes the first `## ` heading; each value wraps across lines inside it,
  // so the match is against that block rather than one line of it.
  const note = markdown.split("\n## ")[0] ?? markdown;
  const value = (label: string): string | null => new RegExp(`${label}\\s*\`([^\`]+)\``).exec(note)?.[1] ?? null;
  const repo = value("repo");
  const baseBranch = value("base branch");
  const root = value("main checkout");
  const worktree = value("loop worktrees under");
  const name = /Replace\s*`([^`]+)` with the new name/.exec(note)?.[1] ?? null;
  if (repo === null || baseBranch === null || root === null || worktree === null || name === null) return null;
  const project = repo.split("/").pop() ?? repo;
  // The note gives one worktree, `…/<project>/<name>-loop`; the directory they
  // sit under is that path without its last segment.
  const worktrees = worktree.split("/").slice(0, -1).join("/");
  return { repo, baseBranch, root, worktrees, project, name };
}

const capitalise = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/**
 * What the guide's examples are rewritten to, longest needle first.
 *
 * `null` for the agent's name leaves the guide's own placeholder, which reads
 * as a placeholder: substituting an empty string would silently produce
 * `-wip` and a path ending in `/-loop`.
 */
export function guideReplacements(
  examples: GuideExamples,
  values: GuideValues,
  name: string | null,
): { from: string; to: string }[] {
  const agent = name ?? "<name>";
  return [
    { from: examples.repo, to: values.repo },
    { from: examples.worktrees, to: values.worktrees },
    { from: examples.root, to: values.root },
    { from: `origin/${examples.baseBranch}`, to: `origin/${values.baseBranch}` },
    { from: examples.project, to: values.project },
    // The example's display name, which the project's values do not carry
    // separately, so its id stands in for it.
    { from: capitalise(examples.project), to: values.project },
    { from: examples.name, to: agent },
    { from: capitalise(examples.name), to: capitalise(agent) },
  ].filter(({ from }) => from !== "");
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrite the guide's examples for this project, in ONE pass.
 *
 * One pass and not a chain of replaces: a project whose own paths or id
 * contained one of the needles would otherwise have its substituted text
 * substituted again — the example repo rewritten to `acme/loggd`, and then the
 * `loggd` inside that name rewritten a second time.
 *
 * With no values or no readable examples the text passes through: a guide
 * showing its own examples is still the guide, and a half-substituted command
 * is worse than an honest one.
 */
export function substituteGuide(
  text: string,
  examples: GuideExamples | null,
  values: GuideValues | null,
  name: string | null,
): string {
  if (values === null || examples === null) return text;
  const replacements = guideReplacements(examples, values, name);
  // Longest first, so a needle that contains another is matched whole.
  const needles = [...replacements].sort((a, b) => b.from.length - a.from.length);
  const pattern = new RegExp(needles.map(({ from }) => escape(from)).join("|"), "g");
  return text.replace(pattern, (match) => replacements.find(({ from }) => from === match)?.to ?? match);
}
