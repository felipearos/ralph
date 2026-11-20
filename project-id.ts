/**
 * Which project a checkout belongs to, by id.
 *
 * Shared by the harness (a loop keys its lineup and Jav routing by it) and the
 * dashboard's project registry (which names projects by it), so the two agree
 * on what `loggd` means. Pure filesystem reads: no subprocess, no loop code.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** A project id: lowercase letters, digits, `.`, `_` and `-`, starting alphanumeric. */
export const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "") || "project";

/**
 * The project a checkout belongs to: its repo's main checkout, named by its
 * directory. A linked worktree's `.git` is a file naming its admin directory
 * under the main checkout's `.git/worktrees/`, so every worktree of a repo
 * resolves to the same project. Anything unreadable is its own project.
 */
export function projectIdFor(root: string): { id: string; path: string } {
  const path = resolve(root);
  let main = path;
  try {
    const dotGit = join(path, ".git");
    if (statSync(dotGit).isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (gitdir !== undefined) {
        const admin = resolve(path, gitdir);
        if (basename(dirname(admin)) === "worktrees" && basename(dirname(dirname(admin))) === ".git") {
          main = dirname(dirname(dirname(admin)));
        }
      }
    }
  } catch {
    // No .git to read: the directory stands for itself.
  }
  return { id: slug(basename(main)), path: main };
}

/**
 * The project's id as a loop keys its lineup and Jav routing by it:
 * `RALPH_PROJECT_ID` when the starter names it (the dashboard's registry id),
 * else `projectIdFor`'s default — so every worktree of `~/loggd` is `loggd`.
 */
export function currentProjectId(root: string, env: Record<string, string | undefined> = process.env): string {
  const named = env.RALPH_PROJECT_ID?.trim();
  if (named) {
    if (!PROJECT_ID.test(named)) {
      throw new Error(`RALPH_PROJECT_ID must be a project id (lowercase, a-z0-9 . _ -); got '${named}'`);
    }
    return named;
  }
  return projectIdFor(root).id;
}

/**
 * The project that owned the harness's lineup and routing before either was
 * keyed by project. The one-time migrations of `models.json` and `jav.json`
 * move the old top-level loop blocks under it.
 */
export const LEGACY_PROJECT = "loggd";
