/**
 * Where the harness is, and where the project it is working on is.
 *
 * The harness is one shared checkout (`RALPH_HOME`, e.g. `~/ralph`) that runs
 * against any project worktree. Harness files — scripts, prompts, the lineup,
 * the signal patterns — are found beside this file. Everything a loop leaves
 * behind — logs, state, ledgers, briefs, its identity — belongs to the project
 * worktree, under `.ralph/`, so three loops running the SAME harness from three
 * worktrees never share a file.
 *
 * The project is `RALPH_PROJECT` when set (every harness entry script exports
 * it), otherwise the git toplevel of the working directory, otherwise the
 * working directory itself.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const physical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The harness checkout: the directory holding this file. */
export const RALPH_HOME = physical(dirname(fileURLToPath(import.meta.url)));

/** Per-worktree harness state, relative to the project root. */
export const STATE_RELATIVE_DIR = ".ralph";
export const LOGS_RELATIVE_DIR = ".ralph/logs";
export const LOOP_NAME_RELATIVE_PATH = ".ralph/loop-name";
export const CONFIG_RELATIVE_PATH = ".ralph/config.json";

/** A harness file, by its path inside the harness checkout. */
export const harnessPath = (...parts: string[]): string => join(RALPH_HOME, ...parts);

/**
 * The project worktree this process works on.
 *
 * Never derived from this file's location: that is the harness, and the
 * harness is not a project.
 */
export function projectRoot(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.RALPH_PROJECT?.trim();
  if (override) return physical(override);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (top !== "") return physical(top);
  } catch {
    // Not a git worktree (or no git): the directory itself is the answer.
  }
  return physical(cwd);
}
