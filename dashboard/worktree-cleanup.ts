/**
 * Settings' "Clean up worktrees" (#696): drop the stale worktree
 * registrations the Reconciliation page lists as prunable.
 *
 * A registration whose directory is gone still holds its path and its branch,
 * so `git worktree add` at that path — Add agent, Create checkout — fails until
 * someone removes it by hand. The cleanup removes them one path at a time with
 * plain `git worktree remove`, never `git worktree prune`: prune drops every
 * stale entry at once and cannot leave one out, and each skip below — a loop
 * still running there, a locked entry, a path the operator did not confirm —
 * has to be honoured. Everything is re-judged at the moment of the call: the
 * requested paths are only the list the operator saw when they armed it.
 */
import type { AgentsDeps } from "./agents";
import { samePath } from "./agents-adapter";
import type { CleanUpWorktreesResult } from "./contracts";

type Entry = { path: string; branch: string | null };

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * Remove the requested registrations that are still prunable, not orphaned
 * and with no loop running in them; report every other one sent, and every
 * orphaned registration, as skipped with
 * its reason. A failed read refuses with nothing removed; it never throws.
 */
export async function cleanUpWorktrees(deps: AgentsDeps, request: { paths: readonly string[] }): Promise<CleanUpWorktreesResult> {
  const { agents } = deps;
  const project = agents.project;
  const refused = (why: string): CleanUpWorktreesResult => ({ project, outcome: "refused", pruned: [], skipped: [], why });

  const [listed, checkouts, supervisors] = await Promise.all([agents.listWorktrees(), agents.checkouts(), agents.supervisors()]);
  if (!listed.ok) return refused(`cannot list the project's worktrees (${listed.why}), so nothing was removed`);
  if (!checkouts.ok) return refused(`cannot read the loops' state (${checkouts.why}), so nothing was removed`);
  if (!supervisors.ok) return refused(`cannot tell whether a loop runs in the worktrees (${supervisors.why}), so nothing was removed`);

  const within = (paths: readonly string[], path: string): boolean => paths.some((candidate) => samePath(candidate, path));
  // A liveness that is not "dead" — alive, or one that cannot be told — is a
  // loop that may still write there; removing its registration under it is
  // how a live checkout loses its branch.
  const running = (path: string): boolean =>
    supervisors.value.some((entry) => samePath(entry.worktree, path) && entry.liveness !== "dead") ||
    checkouts.value.loops.some((report) => samePath(report.worktree, path) && report.liveness !== "dead");

  const pruned: Entry[] = [];
  const skipped: CleanUpWorktreesResult["skipped"] = [];
  const skip = ({ path, branch }: Entry, reason: string, registered = true): void => {
    skipped.push({ path, branch, reason, registered });
  };

  // Only what was sent is judged, plus every orphaned registration: the
  // cleanup cannot clear one, and the operator who came to clean up should
  // learn it needs a hand. A live worktree nobody asked about is not listed:
  // "skipped" next to every running loop would bury the one that matters.
  for (const entry of listed.value) {
    if (entry.main) continue;
    const target = { path: entry.path, branch: entry.branch };
    const sent = within(request.paths, entry.path);
    if (within(checkouts.value.orphaned, entry.path)) {
      skip(target, "its directory is missing but git does not offer to prune it (locked or retained); it is left for a hand");
    } else if (!sent) {
      continue;
    } else if (running(entry.path)) {
      skip(target, "a loop runs in it");
    } else if (!within(checkouts.value.prunable, entry.path)) {
      // Not "its directory exists": loop-state leaves some entries (a bare
      // one) out of both lists, so all that is known is git's own verdict.
      skip(target, "git does not report it as prunable, so it is not stale");
    } else {
      const removed = await agents.removeWorktree(entry.path);
      if (removed.ok) pruned.push(target);
      else skip(target, `git worktree remove refused: ${removed.why}`);
    }
  }
  const unregistered = request.paths.filter((path) => !listed.value.some((entry) => samePath(entry.path, path)));
  for (const path of new Set(unregistered)) skip({ path, branch: null }, "it is no longer registered", false);

  const done = pruned.length === 0 ? "nothing to prune" : `pruned ${plural(pruned.length, "stale registration", "stale registrations")}`;
  const why = skipped.length === 0 ? done : `${done}; skipped ${skipped.length}`;
  return { project, outcome: "done", pruned, skipped, why };
}
