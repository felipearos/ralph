/**
 * Where a project's journal and project learnings live (`journal.branch`).
 *
 * Two places, one answer per project:
 *
 * - the HARNESS repository's `main` — the default, and where every project
 *   published before this existed;
 * - a branch of the PROJECT's own repository, when its config names
 *   `journal.branch`. A client project's journal describes the client's
 *   tickets and code, and keeping it beside that code means the harness can be
 *   shown to someone without also showing every client's notes.
 *
 * The harness's own learnings file (`learnings/harness.md`) is about Ralph, not
 * about any project, so it always stays in the harness whatever this says.
 *
 * Writers (`publish-journal.ts`) and readers (`learnings-read.ts`, `observe.ts`,
 * `findings.ts`, `status.sh`, the dashboard) all resolve through here so a
 * project can never publish to one place while its readers look in another.
 */
import { RALPH_HOME } from "./paths";
import { loadProjectConfig } from "./project-config";

export interface JournalLocation {
  /** A checkout of the repository the entries live in. */
  home: string;
  /** The branch on that repository's `origin`. */
  branch: string;
  /** `origin/<branch>`: what every reader reads, never fetched by a reader. */
  ref: string;
  /** True when `home` is the project's own repository (`journal.branch` is set). */
  projectSide: boolean;
}

export function harnessLocation(env: Record<string, string | undefined> = process.env): JournalLocation {
  const home = env.RALPH_JOURNAL_HOME?.trim() || RALPH_HOME;
  return { home, branch: "main", ref: "origin/main", projectSide: false };
}

/**
 * The configured branch: the env `project-config.ts --export` wrote (empty
 * means the harness), else the config. A config that cannot be read falls back
 * to the harness, which is where a project without the key publishes anyway.
 * The config is consulted even when a caller exported only `RALPH_JOURNAL_DIR`
 * (the dashboard's hand-back does): guessing "harness" there would publish a
 * client's journal into the harness, the one thing the key exists to stop.
 */
export function journalBranch(root: string, env: Record<string, string | undefined> = process.env): string | null {
  const exported = env.RALPH_JOURNAL_BRANCH;
  if (exported !== undefined) return exported.trim() === "" ? null : exported.trim();
  try {
    return loadProjectConfig(root).journal.branch ?? null;
  } catch {
    return null;
  }
}

/** Where the project at `root` publishes its journal and project learnings. */
export function journalLocation(root: string, env: Record<string, string | undefined> = process.env): JournalLocation {
  const branch = journalBranch(root, env);
  if (branch === null) return harnessLocation(env);
  return { home: root, branch, ref: `origin/${branch}`, projectSide: true };
}

/** Where a learnings file of `scope` lives for the project at `root`. */
export function learningsLocation(
  scope: "project" | "harness",
  root: string,
  env: Record<string, string | undefined> = process.env,
): JournalLocation {
  return scope === "harness" ? harnessLocation(env) : journalLocation(root, env);
}
