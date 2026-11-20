// @vitest-environment node
/**
 * The guide the Add-agent panel renders, against the real `adding-an-agent.md`.
 *
 * Every expectation about its content is READ FROM THE FILE at run time, never
 * written out here: a copy in this test would be the second copy of the guide
 * the ticket exists to avoid, and would pass while the panel showed something
 * the file no longer says. The last suite is that rule enforced on the
 * dashboard's own sources.
 *
 * It sits here rather than beside the model in `ui/`, which typechecks against
 * the browser's types alone (`dashboard/ui/tsconfig.json`): reading the guide
 * off disk is a node read.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { GuideValues } from "./contracts";
import { guideExamples, guideReplacements, parseGuide, substituteGuide } from "./ui/guide-model";

const HARNESS = join(__dirname, "..");
const GUIDE = readFileSync(join(HARNESS, "adding-an-agent.md"), "utf8");

const VALUES: GuideValues = {
  project: "proj",
  repo: "your-org/proj",
  baseBranch: "trunk",
  root: "/srv/proj",
  worktrees: "/srv/work/proj",
};

describe("parsing the guide", () => {
  const guide = parseGuide(GUIDE);

  it("finds the numbered steps, in the file's own order", () => {
    // The step headings as the file spells them, so a renumbered or renamed
    // step moves this expectation with it.
    const headings = [...GUIDE.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)].map((match) => ({
      number: Number(match[1]),
      title: match[2]!.trim(),
    }));
    expect(headings.length).toBeGreaterThanOrEqual(12);
    expect(guide.steps.map(({ number, title }) => ({ number, title }))).toEqual(headings);
    // Steps 1 to 12 are the checklist's, and the panel renders all of them.
    expect(guide.steps.filter((step) => step.number >= 1 && step.number <= 12)).toHaveLength(12);
    // Each carries its prose, not just its heading.
    for (const step of guide.steps) expect(step.body).not.toBe("");
  });

  it("finds the Checklist table with every row the file has", () => {
    const table = guide.checklist!;
    expect(table.headers).toEqual(["#", "Step", "Where", "Skipped →"]);
    // The file's own row count for that section, counted from the file.
    const section = GUIDE.split("## Checklist")[1]!.split("\n## ")[0]!;
    const rows = section.split("\n").filter((line) => line.startsWith("|")).length - 2;
    expect(table.rows).toHaveLength(rows);
    expect(table.rows.every((row) => row.length === table.headers.length)).toBe(true);
  });

  it("finds the Troubleshooting table and its Symptom/Cause/Fix columns", () => {
    const table = guide.troubleshooting!;
    expect(table.headers).toHaveLength(3);
    expect(table.headers[1]).toBe("Cause");
    expect(table.headers[2]).toBe("Fix");
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it("reads no table or heading out of a fenced code block", () => {
    const fenced = [
      "## Checklist",
      "",
      "| # | Step |",
      "|---|------|",
      "| 1 | Pick a name |",
      "",
      "## 1. Pick a name",
      "",
      "```json",
      '{ "loops": ["ralph"] }',
      "## 99. not a heading",
      "| not | a | table |",
      "```",
      "",
      "## Troubleshooting",
      "",
      "| Symptom | Cause | Fix |",
      "|---|---|---|",
      "| x | y | z |",
      "",
    ].join("\n");
    const parsed = parseGuide(fenced);
    expect(parsed.steps.map((step) => step.number)).toEqual([1]);
    expect(parsed.checklist!.rows).toEqual([["1", "Pick a name"]]);
    expect(parsed.troubleshooting!.rows).toEqual([["x", "y", "z"]]);
    // The fence's content stays in the step's body, where it belongs.
    expect(parsed.steps[0]!.body).toContain('"loops"');
  });
});

describe("the guide's own declaration of its examples", () => {
  it("reads them out of the opening note, so nothing here hardcodes them", () => {
    const examples = guideExamples(GUIDE)!;
    // Each value as the note states it, read from the note.
    const note = GUIDE.split("## Checklist")[0]!;
    expect(note).toContain(`repo \`${examples.repo}\``);
    expect(note).toContain(`base branch \`${examples.baseBranch}\``);
    expect(note).toContain(`main checkout \`${examples.root}\``);
    // The note gives one worktree; the examples carry the directory they sit under.
    expect(note).toContain(`\`${examples.worktrees}/`);
    expect(note).toContain(`Replace\n\`${examples.name}\` with the new name`);
    expect(examples.project).toBe(examples.repo.split("/").pop());
    expect(parseGuide(GUIDE).examples).toEqual(examples);
  });

  it("reads them out of the opening note alone, not out of a later step", () => {
    // The labels are ordinary words: a step that writes "the repo `x`" must not
    // become the needle every command in the panel is rewritten from.
    const decoy = [
      "# Adding a new agent (loop)",
      "",
      "The examples use Acme's values: repo `acme/real`, base branch `main`,",
      "main checkout `/srv/real`, loop worktrees under `/w/real/<name>-loop`.",
      "Replace",
      "`stand-in` with the new name throughout.",
      "",
      "## 1. Pick a name",
      "",
      "Push to the repo `decoy/wrong` from the main checkout `/tmp/wrong`.",
      "",
    ].join("\n");
    expect(guideExamples(decoy)).toMatchObject({ repo: "acme/real", root: "/srv/real", name: "stand-in" });
  });

  it("reads nothing out of a note that does not declare them", () => {
    expect(guideExamples("# Adding a new agent\n\nNo examples here.\n")).toBeNull();
    // And then the text passes through rather than being half-substituted.
    expect(substituteGuide("testo", null, VALUES, "nova")).toBe("testo");
  });
});

describe("substituting the project's values", () => {
  const examples = guideExamples(GUIDE);
  it("rewrites the guide's Loggd examples and its testo placeholder", () => {
    const substituted = substituteGuide(GUIDE, examples, VALUES, "nova");
    // One command, taken from the file and checked after substitution: the
    // labels step's `gh label create`, which carries both the repo and the name.
    const before = GUIDE.split("\n").find((line) => line.startsWith("gh label create testo-wip"))!;
    expect(before).toContain("felipearos/loggd");
    const after = substituted.split("\n").find((line) => line.startsWith("gh label create nova-wip"))!;
    expect(after).toContain("your-org/proj");
    expect(after).not.toContain("loggd");
    expect(after).toContain("Nova");

    // And the base branch, wherever the guide names origin/main.
    expect(GUIDE).toContain("git fetch origin && git checkout --detach origin/main");
    expect(substituted).toContain("git fetch origin && git checkout --detach origin/trunk");
    expect(substituted).not.toContain("testo");
    expect(substituted).not.toContain("loggd");
  });

  it("leaves the guide's own placeholder when nothing has been typed yet", () => {
    // Not the empty string: `-wip` and `/.ralph/loop-name` would read as real
    // commands an operator could copy.
    const substituted = substituteGuide(GUIDE, examples, VALUES, null);
    expect(substituted).toContain("<name>-wip");
    expect(substituted).not.toContain("testo");
  });

  it("substitutes in one pass, so a project whose own values hold a needle is not rewritten twice", () => {
    const own: GuideValues = { ...VALUES, project: "loggd", repo: "acme/loggd", root: "/home/x/loggd", worktrees: "/w/loggd" };
    const substituted = substituteGuide("repo felipearos/loggd under /home/faros/loggd", examples, own, "testo");
    expect(substituted).toBe("repo acme/loggd under /home/x/loggd");
  });

  it("passes the markdown through untouched when the project's values could not be read", () => {
    expect(substituteGuide(GUIDE, examples, null, "nova")).toBe(GUIDE);
  });

  it("names every substitution it makes, longest needle first where they overlap", () => {
    const order = guideReplacements(examples!, VALUES, "nova").map(({ from }) => from);
    expect(order.indexOf(examples!.repo)).toBeLessThan(order.indexOf(examples!.project));
    // The worktree directory is the longer path, and is replaced as a whole.
    expect(order.indexOf(examples!.worktrees)).toBeLessThan(order.indexOf(examples!.root));
    expect(examples!.worktrees.length).toBeGreaterThan(examples!.root.length);
  });
});

describe("the guide has no second copy in the dashboard", () => {
  /** Every dashboard source, by relative path. */
  const sources = (dir: string): { path: string; text: string }[] =>
    readdirSync(join(HARNESS, "dashboard", dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
      if (!/\.tsx?$/.test(entry.name)) return [];
      return [{ path, text: readFileSync(join(HARNESS, "dashboard", path), "utf8") }];
    });

  it("holds no cell of either table verbatim", () => {
    const guide = parseGuide(GUIDE);
    const columns = (table: { headers: string[]; rows: string[][] }, wanted: string[]): string[] =>
      wanted.flatMap((name) => {
        const at = table.headers.indexOf(name);
        return at === -1 ? [] : table.rows.map((row) => row[at] ?? "");
      });
    // The three columns that carry the guide's judgement — what breaks when a
    // step is skipped, why, and the fix. A copy of any of them in the
    // dashboard is a copy of the guide that would drift from it.
    const cellsOf = [
      ...columns(guide.checklist!, ["Skipped →"]),
      ...columns(guide.troubleshooting!, [guide.troubleshooting!.headers[0]!, "Cause", "Fix"]),
    ].filter((cell) => cell.length > 20);
    expect(cellsOf.length).toBeGreaterThan(5);

    const files = sources(".");
    expect(files.length).toBeGreaterThan(20);
    const copied: string[] = [];
    for (const cell of cellsOf) {
      for (const file of files) {
        // This test file itself holds none of them: it reads the table.
        if (file.text.includes(cell)) copied.push(`${file.path} holds "${cell}"`);
      }
    }
    expect(copied).toEqual([]);
  });
});
