import { Ban, CircleSlash, Scale, CircleCheck, CircleDot, CircleHelp, CircleX, Clock, Eye, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, Pause, UserRound, type LucideIcon } from "lucide-react";
import type { IntakeSignalState } from "./intake-signal-model";

const ICONS: Record<IntakeSignalState, { icon: LucideIcon; color: string }> = {
  reported: { icon: MessageSquare, color: "text-muted-foreground" },
  waiting: { icon: Clock, color: "text-amber-600 dark:text-amber-400" },
  confirmed: { icon: CircleCheck, color: "text-blue-600 dark:text-blue-400" },
  working: { icon: CircleDot, color: "text-emerald-600 dark:text-emerald-400" },
  blocked: { icon: Ban, color: "text-red-600 dark:text-red-400" },
  paused: { icon: Pause, color: "text-amber-600 dark:text-amber-400" },
  review: { icon: Eye, color: "text-blue-600 dark:text-blue-400" },
  "pr-open": { icon: GitPullRequest, color: "text-emerald-600 dark:text-emerald-400" },
  "pr-draft": { icon: GitPullRequestDraft, color: "text-muted-foreground" },
  merged: { icon: GitMerge, color: "text-purple-600 dark:text-purple-400" },
  "pr-closed": { icon: GitPullRequestClosed, color: "text-red-600 dark:text-red-400" },
  done: { icon: CircleCheck, color: "text-emerald-600 dark:text-emerald-400" },
  rejected: { icon: CircleX, color: "text-red-600 dark:text-red-400" },
  "wont-do": { icon: CircleSlash, color: "text-muted-foreground" },
  deciding: { icon: Scale, color: "text-amber-600 dark:text-amber-400" },
  handoff: { icon: UserRound, color: "text-blue-600 dark:text-blue-400" },
  unknown: { icon: CircleHelp, color: "text-muted-foreground" },
};

/** The issue and PR status glyphs used by Ralph's dashboard. */
export function IntakeSignalIcon({ state }: { state: IntakeSignalState }) {
  const { icon: Icon, color } = ICONS[state];
  return <Icon aria-hidden="true" data-state-icon={state} className={`size-3.5 shrink-0 ${color}`} />;
}
