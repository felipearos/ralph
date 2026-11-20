import {
  happy,
  idle,
  love,
  mad,
  sad,
  scared,
  shy,
  sick,
  sleepy,
  smug,
  surprised,
  thinking,
  unsure,
  wink,
  type Expression,
} from "blobatar/expression";
import { Activity, CircleAlert, TriangleAlert } from "lucide-react";
import type { ControlView, DashboardLoop, PresenceView } from "../contracts";
import { ROLE_SUMMARIES, type LoopRole } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LabelText } from "./label";

/* ------------------------------------------------------------------ tone */

/*
 * Every status word the runtime can emit, folded to one of four tones. The
 * tone is what the eye reads first; the word itself is secondary.
 */
export type Tone = "good" | "warn" | "bad" | "info" | "done" | "neutral";

const TONES: Record<string, Tone> = {
  running: "good",
  // Blue, not green: an idle loop is fine but not working, and the two read
  // alike at a glance. It still counts as healthy in the summary.
  idle: "info",
  live: "good",
  alive: "good",
  blocked: "warn",
  stale: "warn",
  prunable: "warn",
  paused: "warn",
  waiting: "warn",
  failed: "bad",
  orphaned: "bad",
  dead: "bad",
  completed: "neutral",
  stopped: "neutral",
  // Stopped now: work is waiting in the worktree for Resume work or Release.
  interrupted: "warn",
  survived: "bad",
  unknown: "neutral",
  // Agent states and issue outcomes, as the observer paints them.
  degraded: "warn",
  active: "good",
  merged: "done",
  pr: "info",
  handoff: "info",
  // Claims and ownership.
  expired: "neutral",
  contested: "bad",
  // Start and restart answers.
  started: "good",
  "already-running": "neutral",
  halted: "warn",
  // Control view statuses.
  held: "warn",
  clear: "good",
  "stop-pending": "info",
  "stop-unreachable": "warn",
};

export const toneOf = (word: string): Tone => TONES[word] ?? "neutral";

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-status-info",
  done: "text-status-done",
  neutral: "text-muted-foreground",
};

const TONE_DOT: Record<Tone, string> = {
  good: "bg-status-good",
  warn: "bg-status-warn",
  bad: "bg-status-bad",
  info: "bg-status-info",
  done: "bg-status-done",
  neutral: "bg-muted-foreground",
};

/** Solid tints: mixed onto the card color so a busy background never shows through. */
export const TONE_TINT: Record<Tone, string> = {
  good: "border-status-good/30 bg-[color-mix(in_oklab,var(--status-good)_10%,var(--card))] text-status-good",
  warn: "border-status-warn/30 bg-[color-mix(in_oklab,var(--status-warn)_10%,var(--card))] text-status-warn",
  bad: "border-status-bad/30 bg-[color-mix(in_oklab,var(--status-bad)_10%,var(--card))] text-status-bad",
  info: "border-status-info/30 bg-[color-mix(in_oklab,var(--status-info)_10%,var(--card))] text-status-info",
  done: "border-status-done/30 bg-[color-mix(in_oklab,var(--status-done)_10%,var(--card))] text-status-done",
  neutral: "border-border bg-[color-mix(in_oklab,var(--muted)_40%,var(--card))] text-muted-foreground",
};

/** A face for every operational condition the dashboard can distinguish. */
export function expressionFor(entry: DashboardLoop, control?: ControlView | null): Expression {
  const standingFailure = entry.runnerFailure.state === "failed" && entry.runnerFailure.current;
  if (entry.stopReason?.kind === "failed" && !standingFailure) return mad;
  if (standingFailure) return sick;
  if (entry.loopStatus === "stale") return scared;
  if (entry.loopStatus === "interrupted") return surprised;
  if (entry.loopStatus === "orphaned" || entry.loopStatus === "unknown") return shy;
  if (control?.hold?.kind === "approval" || entry.stage === "gate") return surprised;
  if (control?.hold?.kind === "pause" || entry.stage === "paused") return sleepy;
  if (entry.loopStatus === "blocked") return unsure;
  if (entry.loopStatus === "failed") return sad;
  if (entry.loopStatus === "completed") return happy;

  const currentIssue = entry.presence?.issues.find((issue) => issue.issue === entry.issue);
  if (currentIssue?.state === "handoff") return wink;
  if (currentIssue?.state === "pr") return love;
  if (entry.stage === "starting" || entry.stage === "preflight") return smug;
  if (entry.loopStatus === "running") return thinking;
  return idle;
}

/* ------------------------------------------------------------ primitives */

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && (
        <span
          className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", TONE_DOT[tone])}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

/** The one badge that carries the loop's headline state. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = toneOf(status);
  return (
    <Badge variant="outline" className={cn("gap-1.5 px-2.5 py-1 text-xs capitalize", TONE_TINT[tone], className)}>
      <Dot tone={tone} pulse={status === "running"} />
      {status}
    </Badge>
  );
}
export const Absent = ({ children = "—" }: { children?: string }) => (
  <span className="text-muted-foreground">{children}</span>
);

/** An issue or PR number as a link into the loop's GitHub repo, or plain text when the repo is unknown. */
export function RepoLink({ repoUrl, path, children }: { repoUrl: string | null; path: string; children: React.ReactNode }) {
  if (repoUrl === null) return <>{children}</>;
  return (
    <a href={`${repoUrl}/${path}`} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

/**
 * The role the roster gives a loop. It sits beside the status badge because
 * the two answer the reader's first question together: what this loop is, and
 * what it is doing. A role also decides which panels below are shown at all.
 */
export function RoleBadge({ role, className }: { role: LoopRole; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("cursor-help px-2.5 py-1 text-xs text-muted-foreground", className)}>
          {role}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{ROLE_SUMMARIES[role]}</TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------- observer */

/**
 * The observer's headline reading: what the loop is doing now, or the last
 * thing it was seen doing, or why it stopped. Mirrors the boxed "NOW / LAST
 * SEEN / STOPPED" frame in `observe.ts`.
 */
function reading(presence: PresenceView): { label: string; tone: Tone; text: string; stage: string | null } {
  const live = presence.status === "running" && presence.supervisor === "alive";
  if (presence.failureReason) return { label: "Stopped", tone: "bad", text: presence.failureReason, stage: null };
  if (!presence.step) return { label: live ? "Now" : "Last seen", tone: live ? "info" : "warn", text: "waiting for activity", stage: null };
  return { label: live ? "Now" : "Last seen", tone: live ? "info" : "warn", text: presence.step.action, stage: presence.step.stage };
}

export function Reading({
  presence,
  compact = false,
  showPhase = true,
}: {
  presence: PresenceView;
  compact?: boolean;
  /** False for a role whose iteration does not run in phases; its phase reads 1/1 and means nothing. */
  showPhase?: boolean;
}) {
  const now = reading(presence);
  const Icon = now.tone === "bad" ? CircleAlert : now.tone === "info" ? Activity : TriangleAlert;
  return (
    <Alert variant={now.tone === "bad" ? "destructive" : "default"} className={cn(compact && "px-3 py-2")}>
      <Icon className={TONE_TEXT[now.tone]} />
      <AlertTitle className="line-clamp-none">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={TONE_TEXT[now.tone]}>
            {now.label}
          </Badge>
          {showPhase && (
            <span className="text-xs font-normal text-muted-foreground">
              Phase {presence.phase.index}/{presence.phase.total} · {presence.phase.label}
            </span>
          )}
          {presence.warning && (
            <Badge variant="outline" className={TONE_TEXT.warn}>
              {presence.warning}
            </Badge>
          )}
        </div>
      </AlertTitle>
      <AlertDescription className="text-foreground">
        <div className={cn("flex w-full min-w-0 items-baseline gap-2", compact ? "overflow-hidden" : "flex-wrap")}>
          {now.stage && <span className="shrink-0 font-mono text-xs text-status-info">{now.stage}</span>}
          <span className={cn("min-w-0 truncate", now.tone === "bad" && TONE_TEXT.bad)}>
            <LabelText text={now.text} compact={compact} />
          </span>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/* ------------------------------------------------------------------ time */

export function ageOf(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

