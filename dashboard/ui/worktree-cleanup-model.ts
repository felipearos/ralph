/**
 * The Settings page's Clean up worktrees control (#696), the pure parts:
 * which registrations it offers to prune, what its confirm button says, and
 * how the server's answer is painted.
 *
 * The candidates are what the Reconciliation page lists as prunable: a
 * registration whose directory is gone. The server re-checks every path it is
 * sent and skips what is no longer stale, so the list here is an offer, not
 * the decision.
 */
import type { CleanUpWorktreesResult, ProjectSettingsView } from "../contracts";
import type { Notice } from "./agents-model";

export interface CleanUpCandidate {
  path: string;
  branch: string | null;
}

/** The prunable registrations of a loaded view; none while it loads or when the worktrees could not be read. */
export function cleanUpCandidates(view: ProjectSettingsView | null): CleanUpCandidate[] {
  if (view === null || view.worktrees === null) return [];
  return view.worktrees
    .filter((worktree) => worktree.reconciliation === "prunable")
    .map((worktree) => ({ path: worktree.path, branch: worktree.branch }));
}

const registrations = (count: number): string => `${count} registration${count === 1 ? "" : "s"}`;

/** The armed, destructive button's label. */
export function cleanUpConfirmLabel(count: number): string {
  return `Prune ${registrations(count)}`;
}

/** Why the unarmed button is not offered: the command's own reason first, then an empty list. */
export function cleanUpWhy(commandWhy: string | null, candidates: number): string | null {
  if (commandWhy !== null) return commandWhy;
  return candidates === 0 ? "No stale registrations to clean up" : null;
}

export interface CleanUpOutcome {
  notice: Notice;
  pruned: CleanUpWorktreesResult["pruned"];
  skipped: CleanUpWorktreesResult["skipped"];
}

/**
 * The server's answer as a notice plus the two lists the panel draws under it.
 * `sent` is the paths the confirm click named. The server also lists every
 * orphaned registration, which was never offered here, and a sent path git no
 * longer lists is already out of the way; neither warns. Only a sent
 * registration that is still there does.
 */
export function cleanUpOutcome(result: CleanUpWorktreesResult, sent: readonly string[]): CleanUpOutcome {
  const { pruned, skipped } = result;
  if (result.outcome === "refused") {
    return { notice: { tone: "bad", title: "Clean-up refused, nothing was pruned", detail: result.why }, pruned, skipped };
  }
  const title =
    skipped.length === 0
      ? `Pruned ${registrations(pruned.length)}`
      : `Pruned ${registrations(pruned.length)}, skipped ${skipped.length}`;
  // A sent path that was skipped is not a failure, but it is a registration
  // still in the way, so it warns.
  const stillInTheWay = skipped.some((entry) => entry.registered && sent.includes(entry.path));
  return { notice: { tone: stillInTheWay ? "warn" : "good", title, detail: result.why }, pruned, skipped };
}
