/**
 * The Settings page's read-only overview of one project (#689): its checkout,
 * its config and every worktree with who, if anyone, is using it.
 *
 * Every read degrades into the view rather than throwing: the page exists to
 * show an operator what is wrong, so a config that fails validation or a
 * worktree list git cannot produce is something to draw, not an error.
 */
import type { AgentsDeps } from "./agents";
import { samePath, type CheckoutsSnapshot, type WorktreeEntry } from "./agents-adapter";
import type { ProjectSettingsView, SettingsWorktreeView } from "./contracts";

/**
 * Classify one worktree.
 *
 * Reconciliation comes first because the Reconciliation page offers to clean
 * up exactly what it lists: calling one of those in-use here would contradict
 * the page that tells an operator it is safe to remove. Then ownership, decided
 * the way the dashboard attributes a loop (`identify` in adapter.ts): the loop
 * its record names, else its `loop-name`. A main checkout with no `loop-name`
 * whose record says `ralph` is ralph's (ralph.sh falls back to the roster's
 * first loop), and a name off the roster is unowned — `unattributed`, as that
 * page lists it, when the worktree holds a record. Last, liveness, with the
 * same caution as `runningIn` in `agents.ts`: a supervisor that is alive or
 * cannot be seen, loop-state's report missing included, may be running, so
 * it counts as in use; only a dead one is idle.
 *
 * `roster` is null when the config could not be read. There is then no roster
 * to check a name against, so a named worktree is judged by liveness alone
 * (claiming it unowned would invite deleting a live loop's checkout over a
 * config typo), while one with no name is still unowned.
 */
export function classifyWorktree(
  entry: WorktreeEntry,
  loopName: string | null,
  roster: readonly string[] | null,
  checkouts: CheckoutsSnapshot,
): SettingsWorktreeView {
  const report = checkouts.loops.find((candidate) => samePath(candidate.worktree, entry.path));
  const loop = report?.owner ?? loopName;
  const view = { path: entry.path, branch: entry.branch, main: entry.main, loop };
  const listed = (paths: readonly string[]): boolean => paths.some((path) => samePath(path, entry.path));
  if (listed(checkouts.orphaned)) return { ...view, use: "unowned", reconciliation: "orphaned" };
  if (listed(checkouts.prunable)) return { ...view, use: "unowned", reconciliation: "prunable" };
  if (loop === null || (roster !== null && !roster.includes(loop))) {
    const unattributed = roster !== null && report?.recorded === true;
    return { ...view, use: "unowned", reconciliation: unattributed ? "unattributed" : null };
  }
  return { ...view, use: report?.liveness === "dead" ? "idle" : "in-use", reconciliation: null };
}

/** Build the Settings overview of `project`; never throws for a failed read. */
export async function projectSettings(
  deps: AgentsDeps,
  project: { id: string; path: string; addedAt: string | null },
): Promise<ProjectSettingsView> {
  const { agents } = deps;
  const [config, listed, checkouts] = await Promise.all([agents.readConfig(), agents.listWorktrees(), agents.checkouts()]);

  let worktrees: SettingsWorktreeView[] | null = null;
  let worktreesProblem: string | null = null;
  if (!listed.ok) {
    worktreesProblem = `cannot list the project's worktrees: ${listed.why}`;
  } else if (!checkouts.ok) {
    // Without loop-state no worktree's use can be told, and a list of
    // unknowns would read as a verdict; say why instead.
    worktreesProblem = `cannot read the loops' state: ${checkouts.why}`;
  } else {
    const roster = config.ok ? config.value.loops : null;
    worktrees = listed.value.map((entry) => classifyWorktree(entry, agents.readLoopName(entry.path), roster, checkouts.value));
  }

  return {
    project: project.id,
    checkout: { path: project.path, addedAt: project.addedAt },
    worktreesDir: agents.worktreesDir(),
    worktreesDefault: !agents.worktreesDirSet(),
    defaultWorktreesDir: agents.defaultWorktreesDir(),
    config: config.ok
      ? {
          repo: config.value.repo,
          owner: config.value.owner,
          baseBranch: config.value.baseBranch,
          displayName: config.value.displayName,
          gates: config.value.gates,
          requiredChecks: config.value.requiredChecks,
          refuseFiles: config.value.refuseFiles,
          worktreeSetup: config.value.worktreeSetup,
        }
      : null,
    problems: config.ok ? [] : (config.problems ?? [config.why]),
    worktrees,
    worktreesProblem,
  };
}
