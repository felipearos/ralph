import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useGaze } from "@blobatar/react/gaze";
import {
  Activity,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  Clock,
  FolderPlus,
  LockOpen,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  TriangleAlert,
  Undo2,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import type {
  CheckoutReport,
  ControlResult,
  ControlView,
  DashboardLoop,
  RestartResult,
  ResumeWorkResult,
  StartResult,
  StopNowResult,
} from "../contracts";
import { PHASES as PHASE_NAMES, type Phase } from "../contracts";
import {
  type Action,
  type Answer,
  type ControlsState,
  controlsFor,
  controlsReducer,
  initialControls,
  reissueOf,
  requestFor,
  scoped,
} from "./control-model";
import { Badge } from "@/components/ui/badge";
import { Blobatar } from "@/components/ui/blobatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { IssueLink } from "./label";
import { LineupEditor } from "./lineup";
import { expiry } from "./records";
import { api } from "./api";
// Aliased: this file already has its own `CommandNotice`, the answered-command panel.
import { CommandNotice as CommandErrorNotice, useCommand } from "./command";
import { decodeAnswer, EMPTY_ANSWER, noticeText } from "./command-model";
import { RELAY_QUEUED } from "./remote-model";
import {
  type Tone,
  TONE_TEXT,
  expressionFor,
  StatusBadge,
  Absent,
  RepoLink,
  RoleBadge,
  ageOf,
} from "./shell-parts";

/* -------------------------------------------------------------- controls */

const ACTION_LABEL: Record<Action, string> = {
  start: "Start",
  restart: "Restart",
  "stop-now": "Stop now",
  "resume-work": "Resume work",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  approve: "Approve",
  deny: "Deny",
  "arm-gate": "Arm gate",
  "disarm-gate": "Disarm gate",
  retry: "Retry",
  abandon: "Abandon",
  release: "Release",
  "retry-phase": "Retry phase",
};

export const OUTCOME_TONE: Record<ControlResult["outcome"], Tone> = {
  applied: "good",
  replayed: "neutral",
  deferred: "info",
  refused: "bad",
  "needs-reconfirmation": "warn",
  "not-for-this-loop": "bad",
};

const OUTCOME_LABEL: Record<ControlResult["outcome"], string> = {
  applied: "sent",
  replayed: "was already applied",
  deferred: "deferred",
  refused: "refused",
  "needs-reconfirmation": "needs confirmation",
  "not-for-this-loop": "went to the wrong loop",
};

const TONE_PANEL: Record<Tone, string> = {
  good: "border-status-good/25 bg-status-good/[0.04]",
  warn: "border-status-warn/25 bg-status-warn/[0.04]",
  bad: "border-status-bad/25 bg-status-bad/[0.04]",
  info: "border-status-info/25 bg-status-info/[0.04]",
  done: "border-status-done/25 bg-status-done/[0.04]",
  neutral: "border-border bg-muted/20",
};

const TONE_ICON: Record<Tone, string> = {
  good: "bg-status-good/10 text-status-good",
  warn: "bg-status-warn/10 text-status-warn",
  bad: "bg-status-bad/10 text-status-bad",
  info: "bg-status-info/10 text-status-info",
  done: "bg-status-done/10 text-status-done",
  neutral: "bg-muted text-muted-foreground",
};

/** A small bordered tag beside a notice's title. */
function Chip({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className={cn("rounded-md border px-1.5 py-px text-[11px] text-muted-foreground", mono && "font-mono")}>
      {children}
    </span>
  );
}

/**
 * The gates armed before a named phase, each with its disarm, and the choice
 * to arm one more. A gate stays armed across iterations and restarts, so this
 * row is the one place an operator sees what the loop will stop and ask about.
 * Arming while no supervisor runs leaves the command for the next one.
 */
function Gates({
  gates,
  busy,
  onArm,
  onDisarm,
}: {
  gates: ControlView["gates"];
  busy: boolean;
  onArm: (phase: Phase) => void;
  onDisarm: (phase: Phase) => void;
}) {
  const unarmed = PHASE_NAMES.filter((phase) => !gates.some((gate) => gate.phase === phase));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{gates.length === 0 ? "No gates armed" : "Asks before"}</span>
      {gates.map((gate) => (
        <span
          key={gate.phase}
          className="inline-flex items-center gap-1 rounded-md border py-px pr-0.5 pl-1.5 font-mono text-[11px] text-muted-foreground"
          title={gate.why ?? `armed ${new Date(gate.since).toLocaleString()}`}
        >
          {gate.phase}
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            disabled={busy}
            aria-label={`Disarm the gate before ${gate.phase}`}
            onClick={() => onDisarm(gate.phase)}
          >
            <X className="size-3" />
          </Button>
        </span>
      ))}
      {unarmed.length > 0 && (
        // Always "" so the trigger shows the placeholder again after a pick:
        // the pick is an action (arm), not a remembered choice.
        <Select
          value=""
          disabled={busy}
          onValueChange={(value) => {
            const phase = unarmed.find((name) => name === value);
            if (phase !== undefined) onArm(phase);
          }}
        >
          <SelectTrigger size="sm" aria-label="Arm a gate before a phase">
            <SelectValue placeholder="Arm a gate before…" />
          </SelectTrigger>
          <SelectContent>
            {unarmed.map((phase) => (
              <SelectItem key={phase} value={phase}>
                {phase}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** An instant's age for a notice's title row. */
function Age({ iso }: { iso: string }) {
  return (
    <span className="text-muted-foreground tabular-nums" title={new Date(iso).toLocaleString()}>
      {ageOf(iso, Date.now())}
    </span>
  );
}

/**
 * A toned panel under the loop header: icon, a title row with tags, the
 * message, and actions to the right (below on a phone).
 */
function Notice({
  tone,
  icon: Icon,
  iconClassName,
  title,
  meta,
  hint,
  actions,
  onDismiss,
  children,
}: {
  tone: Tone;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        // A size container: the panel also sits in the narrow sidebar on a wide
        // screen, where a viewport breakpoint would lay it out side by side and
        // squeeze the message to one letter per line.
        "@container relative rounded-lg border p-4",
        onDismiss && "pr-12",
        TONE_PANEL[tone],
      )}
    >
      <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {/* Dropped in a narrow panel: the title already carries the tone, and the width goes to the message. */}
          <div className={cn("hidden size-8 shrink-0 items-center justify-center rounded-full @xs:flex", TONE_ICON[tone])}>
            <Icon className={cn("size-4", iconClassName)} />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className={cn("font-medium", TONE_TEXT[tone])}>{title}</span>
              {meta}
            </div>
            <div className="text-sm break-words whitespace-pre-wrap text-foreground">{children}</div>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 @xs:pl-11 @md:pl-0">{actions}</div>}
      </div>
      {onDismiss && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="absolute top-3 right-3 text-muted-foreground"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

type Icon = React.ComponentType<{ className?: string }>;

/**
 * How a command's answer is painted. A sent command that the loop has not
 * read back yet is info, not good: nothing has happened. For a stop, the
 * confirmation says more than `recorded` does.
 */
function resultLook(result: ControlResult): { tone: Tone; icon: Icon; state: string | null } {
  if (result.outcome === "applied" && result.stop) {
    switch (result.stop.confirmation) {
      case "confirmed":
        return { tone: "good", icon: CircleCheck, state: "confirmed by the loop" };
      case "pending":
        return { tone: "info", icon: Clock, state: "waiting for the loop to stop" };
      case "unreachable":
        return { tone: "warn", icon: TriangleAlert, state: "loop unreachable" };
    }
  }
  const icons: Record<ControlResult["outcome"], Icon> = {
    applied: result.recorded ? CircleCheck : Clock,
    replayed: CircleCheck,
    deferred: Clock,
    refused: Ban,
    "needs-reconfirmation": TriangleAlert,
    "not-for-this-loop": CircleX,
  };
  if (result.outcome === "applied") {
    return result.recorded
      ? { tone: "good", icon: icons.applied, state: "confirmed by the loop" }
      : { tone: "info", icon: icons.applied, state: "applies at the next poll" };
  }
  return { tone: OUTCOME_TONE[result.outcome], icon: icons[result.outcome], state: null };
}

const START_LOOK: Record<StartResult["outcome"], { tone: Tone; icon: Icon; label: string }> = {
  started: { tone: "good", icon: CircleCheck, label: "Start: started" },
  "already-running": { tone: "neutral", icon: CircleCheck, label: "Start: already running, nothing launched" },
  failed: { tone: "bad", icon: CircleAlert, label: "Start failed" },
  refused: { tone: "warn", icon: Ban, label: "Start refused, nothing was started" },
  "not-for-this-loop": { tone: "bad", icon: CircleX, label: "Start went to the wrong loop" },
};

const RESTART_LOOK: Record<RestartResult["outcome"], { tone: Tone; icon: Icon; label: string }> = {
  started: { tone: "good", icon: CircleCheck, label: "Restarted" },
  "already-running": { tone: "warn", icon: TriangleAlert, label: "Restart: a supervisor was already running" },
  failed: { tone: "bad", icon: CircleAlert, label: "Restart stopped the loop, but the start failed" },
  halted: { tone: "warn", icon: TriangleAlert, label: "Restart halted, nothing was started" },
  "not-for-this-loop": { tone: "bad", icon: CircleX, label: "Restart went to the wrong loop" },
};

const RESUME_LOOK: Record<ResumeWorkResult["outcome"], { tone: Tone; icon: Icon; label: string }> = {
  started: { tone: "good", icon: CircleCheck, label: "Resumed in the same worktree" },
  "already-running": { tone: "neutral", icon: CircleCheck, label: "Resume work: a supervisor was already running" },
  failed: { tone: "bad", icon: CircleAlert, label: "Resume work failed to start" },
  refused: { tone: "warn", icon: Ban, label: "Resume work refused, nothing was started" },
  "not-for-this-loop": { tone: "bad", icon: CircleX, label: "Resume work went to the wrong loop" },
};

/** How a Stop now's answer is painted: only a recorded interruption reads as done. */
function stopNowLook(result: StopNowResult): { tone: Tone; icon: Icon; label: string } {
  switch (result.outcome) {
    case "interrupted":
      return result.recorded
        ? { tone: "warn", icon: Zap, label: "Stopped now" }
        : { tone: "warn", icon: TriangleAlert, label: "Stopped now, but the loop's record does not say so" };
    case "refused":
      return { tone: "bad", icon: Ban, label: "Stop now refused, nothing was signalled" };
    case "survived":
      return { tone: "bad", icon: CircleAlert, label: "Stop now: the supervisor is still running" };
    case "needs-reconfirmation":
      return { tone: "warn", icon: TriangleAlert, label: "Stop now: the loop is held by another run" };
    case "not-for-this-loop":
      return { tone: "bad", icon: CircleX, label: "Stop now went to the wrong loop" };
  }
}

/** The checks Stop now ran before any signal, each passed or failed with its detail. */
export function SignalChecks({ checks }: { checks: StopNowResult["checks"] }) {
  return (
    <ul className="mt-2 space-y-0.5 text-xs">
      {checks.map((check) => (
        <li key={check.check} className="flex items-start gap-2">
          {check.ok ? (
            <Check className={cn("mt-px size-3.5 shrink-0", TONE_TEXT.good)} />
          ) : (
            <X className={cn("mt-px size-3.5 shrink-0", TONE_TEXT.bad)} />
          )}
          <span className="shrink-0 font-mono">{check.check}</span>
          <span className="min-w-0 break-words text-muted-foreground">{check.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What an interrupted iteration left in the worktree, from the checkout
 * report: the branch, uncommitted changes and commits no remote has. Read,
 * never repaired.
 */
export function InterruptedWork({ checkout }: { checkout: CheckoutReport }) {
  const lines = (items: string[]) => (
    <ul className="mt-1 font-mono text-muted-foreground">
      {items.slice(0, 5).map((line) => (
        <li key={line} className="truncate">
          {line}
        </li>
      ))}
      {items.length > 5 && <li>…and {items.length - 5} more</li>}
    </ul>
  );
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return (
    <div className="space-y-1.5 text-xs">
      <p>
        Branch <span className="font-mono">{checkout.branch ?? "unknown (detached, or git could not say)"}</span>
      </p>
      {!checkout.readable ? (
        <p className={TONE_TEXT.warn}>git status could not be read, so uncommitted changes are unknown.</p>
      ) : checkout.dirty ? (
        <div className={TONE_TEXT.warn}>
          <p>{plural(checkout.changes.length, "uncommitted change")}</p>
          {lines(checkout.changes)}
        </div>
      ) : (
        <p className="text-muted-foreground">No uncommitted changes.</p>
      )}
      {checkout.unpushed === null ? (
        <p className={TONE_TEXT.warn}>Whether any commits are unpushed could not be read.</p>
      ) : checkout.unpushed.length > 0 ? (
        <div className={TONE_TEXT.warn}>
          <p>{plural(checkout.unpushed.length, "unpushed commit")}</p>
          {lines(checkout.unpushed)}
        </div>
      ) : (
        <p className="text-muted-foreground">No unpushed commits.</p>
      )}
    </div>
  );
}

/**
 * What a restart would leave behind, from the checkout report. Reported, never
 * repaired: commits, claims and uncommitted work stay for the new supervisor.
 */
export function CheckoutWarnings({ checkout }: { checkout: CheckoutReport }) {
  const clean = checkout.readable && !checkout.dirty && !checkout.midTicket;
  return (
    <div className="space-y-1.5 text-xs">
      {!checkout.readable && (
        <p className={TONE_TEXT.warn}>git status could not be read, so the checkout's state is unknown.</p>
      )}
      {checkout.dirty && (
        <div className={TONE_TEXT.warn}>
          <p>
            {checkout.changes.length} uncommitted change{checkout.changes.length === 1 ? "" : "s"} in the worktree
          </p>
          <ul className="mt-1 font-mono text-muted-foreground">
            {checkout.changes.slice(0, 5).map((line) => (
              <li key={line} className="truncate">
                {line}
              </li>
            ))}
            {checkout.changes.length > 5 && <li>…and {checkout.changes.length - 5} more</li>}
          </ul>
        </div>
      )}
      {checkout.midTicket && (
        <p className={TONE_TEXT.warn}>
          Mid-ticket on {checkout.claims.map((claim) => `#${claim.issue}`).join(", ")}
          {checkout.branch && ` (branch ${checkout.branch})`}
        </p>
      )}
      {clean && <p className="text-muted-foreground">Clean checkout, no ticket claimed.</p>}
      <p className="text-muted-foreground">
        Restart never resets, checks out, cleans or stashes: commits, claims and uncommitted work stay in this worktree.
      </p>
    </div>
  );
}

/*
 * The controls' one read besides the command module: commands go through
 * `useCommand`, and the reducer stays pure, so this is the only fetch here.
 */

/** What the loop's worktree holds now: read for an armed restart and for an interrupted loop's recovery panel. */
async function readCheckout(loop: string): Promise<CheckoutReport> {
  const response = await fetch(api(`/api/loops/${encodeURIComponent(loop)}/checkout`), { cache: "no-store" });
  // Decoded by the command module, so a refused read says what a refused command does.
  const answer = await decodeAnswer<{ checkout: CheckoutReport }>(response);
  if (!answer.ok) throw new Error(noticeText(answer.error));
  if (answer.value === null) throw new Error(noticeText(EMPTY_ANSWER));
  return answer.value.checkout;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The buttons at the top of a loop page, and what the last one said back.
 * The rules below are `controlsFor`'s (`ui/control-model.ts`); this
 * component only draws what it returns.
 *
 * Which buttons show is decided from what the observer and the control view
 * say: a loop with no live supervisor can be started; a live one can be paused,
 * stopped or restarted to apply a lineup edit; a paused one resumed; one held
 * on a decision gate approved or denied. One that stopped `failed` can be
 * retried; an expired claim abandoned; and, once its supervisor is known to be gone,
 * the run's own claim released. A live one can also be stopped now, and one
 * stopped that way offers Resume work and Release over what it left in the
 * worktree. Stop, Stop now, restart, abandon and release arm first
 * and send their confirmation only from the second click. Every answer is the recorded
 * outcome, or the honest "sent, not yet applied" — the page never claims a
 * command has landed because the button was pressed.
 */
export function Controls({
  entry,
  status,
  onSent,
  initial,
  contextMenu = false,
  navigate,
  children,
}: {
  entry: DashboardLoop;
  status: ControlView | null;
  onSent: () => void;
  initial?: Partial<ControlsState>;
  contextMenu?: boolean;
  navigate?: (path: string) => void;
  // The loop's heading; the action buttons sit to its right.
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(controlsReducer, initial, initialControls);
  const { pending, armed, restartArmed, nowArmed, nowWhy, claimArmed, checkout, recovery, last, queued } = state;
  // Every Controls route is a relayed one, so `/api/control`'s lock is theirs.
  const command = useCommand("/api/control");
  const lock = { disabled: command.disabled, why: command.why };

  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuTrigger = useRef<HTMLDivElement>(null);
  const {
    hold,
    stopped,
    phases,
    scope,
    interrupted,
    ticket,
    canStart,
    canPause,
    canResume,
    canDecide,
    retryable,
    canStop,
    canRestart,
    canRetry,
    recoverable,
    unavailable,
    canGate,
    canCreateCheckout,
    canReissue,
    nothingApplies,
  } = controlsFor(entry, status, state.scope);
  // The sidebar and the agent cards are narrow: there a hold's decision buttons
  // must sit side by side without crowding the question they answer.
  const holdSize = contextMenu ? "xs" : "sm";

  const send = useCallback(
    async (action: Action, body: Record<string, unknown> = {}) => {
      dispatch({ type: "send", action, body });
      try {
        const [url, payload] = requestFor(entry, action, body);
        // The module follows a relay and reports it queued; it never throws.
        const answer = await command.send<Answer>(payload, { onQueued: () => dispatch({ type: "queued" }) }, url);
        // Every control route answers a result: an empty 2xx is no answer at all.
        if (answer.ok && answer.value === null) {
          dispatch({ type: "failed", error: { kind: "Malformed", message: "the route answered with no result", status: null } });
        } else if (answer.ok) {
          dispatch({ type: "answer", answer: answer.value! });
        } else {
          dispatch({ type: "failed", error: answer.error });
        }
      } finally {
        onSent();
      }
    },
    [entry, onSent, command.send],
  );

  // Arming a restart reads what it would leave in the worktree, so the warning
  // is on screen before the confirming click.
  const armRestart = useCallback(async () => {
    dispatch({ type: "arm-restart" });
    try {
      dispatch({ type: "checkout-read", report: await readCheckout(entry.loop) });
    } catch (error) {
      dispatch({ type: "checkout-failed", message: message(error) });
    }
  }, [entry.loop]);

  // An interrupted loop's page reads what it left in the worktree, once, so
  // the operator sees it before choosing Resume work or Release. A seed that
  // names `recovery` (even null, the gallery's "reading the worktree") is
  // shown as seeded, never fetched; captured once so the effect stays stable.
  const seeded = useRef(initial !== undefined && "recovery" in initial).current;
  useEffect(() => {
    if (!interrupted || seeded) return;
    let cancelled = false;
    dispatch({ type: "recovery-reading" });
    (async () => {
      try {
        const report = await readCheckout(entry.loop);
        if (!cancelled) dispatch({ type: "recovery-read", report });
      } catch (error) {
        if (!cancelled) dispatch({ type: "recovery-failed", message: message(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [interrupted, seeded, entry.loop]);

  const armNow = () => dispatch({ type: "arm-now" });

  // Remotely, a machine that cannot take commands turns every control off,
  // with the reason on hover; locally the lock never closes.
  const busy = pending !== null || lock.disabled;
  const lockTitle = lock.disabled ? (lock.why ?? undefined) : undefined;
  const label = (action: Action) => (pending?.action === action ? `${ACTION_LABEL[action]}…` : ACTION_LABEL[action]);
  const question = status?.pendingApprovals[0]?.question ?? hold?.why;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {contextMenu ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div ref={menuTrigger} className="w-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" tabIndex={0} aria-label={`${entry.loop} actions`}>
                {children}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent aria-label={`${entry.loop} actions`}>
              <ContextMenuLabel>{entry.loop}</ContextMenuLabel>
              <ContextMenuItem onSelect={() => navigate?.(`/loops/${encodeURIComponent(entry.loop)}`)}><Activity />View details</ContextMenuItem>
              <ContextMenuItem onSelect={() => setSettingsOpen(true)}><Settings />Settings</ContextMenuItem>
              <ContextMenuSeparator />
              {canStart && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("start")}><Play />Start</ContextMenuItem>}
              {canPause && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("pause")}><Pause />Pause</ContextMenuItem>}
              {canPause && phases && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("pause", scoped("phase"))}><Pause />Pause at next phase</ContextMenuItem>}
              {canResume && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("resume")}><Play />Resume</ContextMenuItem>}
              {canRetry && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("retry")}><RotateCw />Retry</ContextMenuItem>}
              {retryable && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("retry-phase")}><RotateCw />Retry {retryable}</ContextMenuItem>}
              {canDecide && <>
                <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void send("approve")}><Check />Approve</ContextMenuItem>
                <ContextMenuItem disabled={busy} title={lockTitle} variant="destructive" onSelect={() => void send("deny")}><X />Deny</ContextMenuItem>
              </>}
              {unavailable && <ContextMenuItem disabled>Controls unavailable; waiting for refresh</ContextMenuItem>}
              {canRestart && <ContextMenuItem disabled={busy} title={lockTitle} onSelect={() => void armRestart()}><RotateCcw />Restart…</ContextMenuItem>}
              {canStop && <ContextMenuItem disabled={busy} title={lockTitle} variant="destructive" onSelect={() => dispatch({ type: "arm-stop", scope: "iteration" })}><CircleStop />Stop…</ContextMenuItem>}
              {canStop && phases && <ContextMenuItem disabled={busy} title={lockTitle} variant="destructive" onSelect={() => dispatch({ type: "arm-stop", scope: "phase" })}><CircleStop />Stop at next phase…</ContextMenuItem>}
              {canStop && <ContextMenuItem disabled={busy} title={lockTitle} variant="destructive" onSelect={armNow}><Zap />Stop now…</ContextMenuItem>}
              {canCreateCheckout && (
                // The request itself belongs on the loop page, where its
                // answer has somewhere to be read, so this item says where it
                // goes rather than offering what the card cannot do. No
                // ellipsis: in this UI that marks a two-step confirm.
                <ContextMenuItem onSelect={() => navigate?.(`/loops/${encodeURIComponent(entry.loop)}`)}>
                  <FolderPlus />Create checkout on its page
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : children}
        <div className={cn("ml-auto flex flex-wrap items-center justify-end gap-2", contextMenu && !armed && "hidden")}>
          {!contextMenu && canStart && (
            <Button size="sm" disabled={busy} title={lockTitle} onClick={() => void send("start")}>
              <Play className="size-3.5 fill-current" />
              {label("start")}
            </Button>
          )}
          {!contextMenu && canResume && (
            <Button size="sm" disabled={busy} title={lockTitle} onClick={() => void send("resume")}>
              <Play className="size-3.5 fill-current" />
              {label("resume")}
            </Button>
          )}
          {!contextMenu && canRetry && (
            <Button size="sm" variant="outline" disabled={busy} title={lockTitle} onClick={() => void send("retry")}>
              <RotateCw className="size-3.5" />
              {label("retry")}
            </Button>
          )}
          {!contextMenu && phases && (canPause || canStop) && (
            <Select value={scope} disabled={busy} onValueChange={(value) => dispatch({ type: "choose-scope", scope: value === "phase" ? "phase" : "iteration" })}>
              <SelectTrigger size="sm" aria-label="Where Pause and Stop apply" title={lockTitle}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="iteration">At next iteration</SelectItem>
                <SelectItem value="phase">At next phase</SelectItem>
              </SelectContent>
            </Select>
          )}
          {!contextMenu && canPause && (
            <Button size="sm" variant="outline" disabled={busy} title={lockTitle} onClick={() => void send("pause", scoped(scope))}>
              <Pause className="size-3.5 fill-current" />
              {label("pause")}
            </Button>
          )}
          {!contextMenu && canRestart && !restartArmed && (
            <Button size="sm" variant="outline" disabled={busy} title={lockTitle} onClick={() => void armRestart()}>
              <RotateCcw className="size-3.5" />
              {label("restart")}
            </Button>
          )}
          {canStop &&
            (armed ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy} title={lockTitle}
                  onClick={() =>
                    void send("stop", { ...scoped(scope), stopKind: "blocked", why: "stopped from the dashboard", confirm: true })
                  }
                >
                  <CircleStop className="size-3.5" />
                  Confirm stop{scope === "phase" && " at next phase"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} title={lockTitle} onClick={() => dispatch({ type: "cancel-stop" })}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy} title={lockTitle}
                onClick={() => dispatch({ type: "arm-stop", scope: state.scope })}
              >
                <CircleStop className="size-3.5" />
                {label("stop")}
              </Button>
            ))}
          {!contextMenu && canStop && !nowArmed && (
            <Button size="sm" variant="outline" className={TONE_TEXT.bad} disabled={busy} title={lockTitle} onClick={armNow}>
              <Zap className="size-3.5" />
              {label("stop-now")}
            </Button>
          )}
          <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
            <SheetTrigger asChild>
              <Button size="sm" variant="outline" className={contextMenu ? "hidden" : undefined}>
                <Settings className="size-3.5" />
                Settings
              </Button>
            </SheetTrigger>
            <SheetContent
              className="w-full gap-0 overflow-y-auto sm:max-w-2xl"
              onCloseAutoFocus={contextMenu ? (event) => {
                event.preventDefault();
                menuTrigger.current?.focus();
              } : undefined}
            >
              <SheetHeader className="border-b pr-12">
                <SheetTitle className="flex items-center gap-2">
                  Settings
                  <Badge variant="outline" className="font-mono font-normal text-muted-foreground">
                    {entry.loop}
                  </Badge>
                </SheetTitle>
                <SheetDescription>
                  Which model runs each stage of this loop. A saved lineup applies when the supervisor next starts;
                  Restart applies it now.
                </SheetDescription>
              </SheetHeader>
              <div className="p-4">
                <LineupEditor loop={entry.loop} role={entry.role} />
              </div>
            </SheetContent>
          </Sheet>
          {nothingApplies && (
            <span className="text-sm text-muted-foreground">
              {entry.present ? "No action applies to this loop right now." : "No checkout to act on."}
            </span>
          )}
        </div>
      </div>

      {restartArmed && (
        <Notice
          tone="warn"
          icon={RotateCcw}
          title="Restart to apply"
          meta={entry.run && <Chip mono>{entry.run}</Chip>}
          hint="It halts without starting if the stop stays pending or unreachable, and can wait up to 2 minutes."
          actions={
            <>
              <Button size="sm" variant="ghost" disabled={busy} title={lockTitle} onClick={() => dispatch({ type: "cancel-restart" })}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy} title={lockTitle}
                onClick={() =>
                  void send("restart", {
                    stopKind: "blocked",
                    why: "restarted from the dashboard to apply the lineup",
                    confirm: true,
                  })
                }
              >
                <RotateCcw className="size-3.5" />
                Confirm restart
              </Button>
            </>
          }
        >
          <p className="mb-2">
            Stop the loop at its next iteration boundary, wait until the stop is confirmed and the supervisor has
            exited, then start it again with the current lineup.
          </p>
          {checkout === null ? (
            <p className="text-xs text-muted-foreground">Reading the checkout…</p>
          ) : "failed" in checkout ? (
            <p className={cn("text-xs", TONE_TEXT.warn)}>Checkout unknown: {checkout.failed}</p>
          ) : (
            <CheckoutWarnings checkout={checkout} />
          )}
        </Notice>
      )}

      {nowArmed && (
        <Notice
          tone="bad"
          icon={Zap}
          title="Stop now"
          meta={entry.run && <Chip mono>{entry.run}</Chip>}
          hint="Only the process group named by this checkout's supervisor.pid is signalled, and only once that pid is checked to be this checkout's ralph.sh. Every signal is recorded in .ralph/control/signals.jsonl."
          actions={
            <>
              <Button size="sm" variant="ghost" disabled={busy} title={lockTitle} onClick={() => dispatch({ type: "cancel-now" })}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy} title={lockTitle}
                onClick={() =>
                  void send("stop-now", { ...(nowWhy.trim() === "" ? {} : { why: nowWhy.trim() }), confirm: true })
                }
              >
                <Zap className="size-3.5" />
                Confirm stop now
              </Button>
            </>
          }
        >
          <p className="mb-2">
            End the iteration in progress now, without waiting for its boundary: SIGTERM to the loop's process group,
            then SIGKILL if it has not ended within 10 seconds. The ticket stays claimed, and its commits and
            uncommitted files stay in the worktree for Resume work or Release.
          </p>
          <Input
            aria-label="Why stop it now"
            placeholder="Why (kept with the stop and in the signal record)"
            value={nowWhy}
            maxLength={300}
            disabled={busy} title={lockTitle}
            onChange={(event) => dispatch({ type: "edit-why", text: event.target.value })}
          />
        </Notice>
      )}

      {queued && (
        <Notice tone="info" icon={Clock} title="Relayed">
          {RELAY_QUEUED}…
        </Notice>
      )}

      {pending?.action === "stop-now" && !queued && (
        <Notice tone="info" icon={Clock} title="Stopping now">
          Signalling the loop's process group and waiting for it to exit…
        </Notice>
      )}

      {!contextMenu && interrupted && (
        <Notice
          tone="warn"
          icon={Zap}
          title="Interrupted"
          meta={
            <>
              {stopped?.iteration != null && <Chip>iteration {stopped.iteration}</Chip>}
              {ticket !== null && (
                <Chip mono>
                  <IssueLink repoUrl={entry.repoUrl} issue={ticket} />{" "}
                  claimed
                </Chip>
              )}
              {stopped && <Age iso={stopped.at} />}
            </>
          }
          hint="Resume work starts the loop again in this worktree, on the same branch and claim; it never resets to the base branch. Release gives the ticket back and leaves the branch and commits as they are."
          actions={
            claimArmed?.action === "release" && claimArmed.issue === ticket ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy} title={lockTitle} onClick={() => dispatch({ type: "cancel-claim" })}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy} title={lockTitle}
                  onClick={() => void send("release", { issue: ticket, confirm: true })}
                >
                  <Undo2 className="size-3.5" />
                  Confirm release #{ticket}
                </Button>
              </>
            ) : (
              <>
                {ticket !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy} title={lockTitle}
                    onClick={() => dispatch({ type: "arm-claim", claim: { action: "release", issue: ticket } })}
                  >
                    <Undo2 className="size-3.5" />
                    {label("release")} #{ticket}…
                  </Button>
                )}
                <Button size="sm" disabled={busy} title={lockTitle} onClick={() => void send("resume-work")}>
                  <Play className="size-3.5 fill-current" />
                  {label("resume-work")}
                </Button>
              </>
            )
          }
        >
          <p>{stopped?.why ?? entry.stopReason?.why ?? "stopped now"}</p>
          <p className="mb-2 text-muted-foreground">The iteration was cut short; what it left is still in this worktree.</p>
          {recovery === null ? (
            <p className="text-xs text-muted-foreground">Reading the worktree…</p>
          ) : "failed" in recovery ? (
            <p className={cn("text-xs", TONE_TEXT.warn)}>The worktree could not be read: {recovery.failed}</p>
          ) : (
            <InterruptedWork checkout={recovery} />
          )}
        </Notice>
      )}

      {!contextMenu && recoverable.length > 0 && (
        <Notice
          tone="neutral"
          icon={LockOpen}
          title="Claims"
          hint="Abandon takes back a claim whose lease has expired. Release gives up this run's own claim so another loop can take the ticket."
        >
          <ul className="space-y-2">
            {recoverable.map(({ claim, action }) => {
              const confirming = claimArmed?.action === action && claimArmed.issue === claim.issue;
              return (
                <li key={`${action}-${claim.issue}`} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-mono">
                      <IssueLink repoUrl={entry.repoUrl} issue={claim.issue} />
                    </span>
                    {claim.title && <span className="min-w-0 truncate">{claim.title}</span>}
                    <Chip>{claim.status}</Chip>
                    <span className="text-xs text-muted-foreground">{expiry(claim)}</span>
                  </span>
                  {confirming ? (
                    <span className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" disabled={busy} title={lockTitle} onClick={() => dispatch({ type: "cancel-claim" })}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy} title={lockTitle}
                        onClick={() => void send(claimArmed.action, { issue: claimArmed.issue, confirm: true })}
                      >
                        {action === "abandon" ? <Unplug className="size-3.5" /> : <Undo2 className="size-3.5" />}
                        Confirm {action} #{claim.issue}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy} title={lockTitle}
                      onClick={() => dispatch({ type: "arm-claim", claim: { action, issue: claim.issue } })}
                    >
                      {action === "abandon" ? <Unplug className="size-3.5" /> : <Undo2 className="size-3.5" />}
                      {label(action)}…
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Notice>
      )}

      {pending?.action === "restart" && (
        <Notice tone="info" icon={Clock} title="Restarting">
          Waiting for the stop to be confirmed and the supervisor to exit…
        </Notice>
      )}

      {hold && (!contextMenu || canDecide) && (
        <Notice
          tone="warn"
          icon={hold.kind === "pause" ? Pause : TriangleAlert}
          iconClassName={hold.kind === "pause" ? "fill-current" : undefined}
          title={
            hold.kind === "pause"
              ? hold.phase
                ? `Held before ${hold.phase}`
                : "Paused"
              : "Awaiting a decision"
          }
          meta={
            <>
              {hold.kind === "approval" && hold.phase && <Chip mono>held before {hold.phase}</Chip>}
              {hold.gate && <Chip mono>{hold.gate} gate</Chip>}
              <Age iso={hold.since} />
            </>
          }
          hint={
            [
              canDecide ? "Approve lets the loop continue; Deny stops it as blocked." : null,
              retryable ? `Retry runs ${retryable} again in a fresh session, then goes on to ${hold.phase}.` : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          actions={
            retryable && !canDecide ? (
              <Button size={holdSize} variant="outline" disabled={busy} title={lockTitle} onClick={() => void send("retry-phase")}>
                <RotateCw className="size-3.5" />
                {pending?.action === "retry-phase" ? `Retry ${retryable}…` : `Retry ${retryable}`}
              </Button>
            ) : canDecide && (
              <>
                {/* A gate held at a phase boundary can also send the finished phase back. */}
                {retryable && (
                  <Button size={holdSize} variant="outline" disabled={busy} title={lockTitle} onClick={() => void send("retry-phase")}>
                    <RotateCw className="size-3.5" />
                    {pending?.action === "retry-phase" ? `Retry ${retryable}…` : `Retry ${retryable}`}
                  </Button>
                )}
                <Button size={holdSize} variant="outline" disabled={busy} title={lockTitle} onClick={() => void send("deny")}>
                  <X className="size-3.5" />
                  {label("deny")}
                </Button>
                <Button size={holdSize} disabled={busy} title={lockTitle} onClick={() => void send("approve")}>
                  <Check className="size-3.5" />
                  {label("approve")}
                </Button>
              </>
            )
          }
        >
          {hold.kind === "approval" ? question : hold.why}
        </Notice>
      )}

      {!contextMenu && status && canGate && (
        <Gates
          gates={status.gates}
          busy={busy}
          onArm={(phase) => void send("arm-gate", { phase })}
          onDisarm={(phase) => void send("disarm-gate", { phase })}
        />
      )}

      {!contextMenu && status && <ChannelNotices status={status} present={entry.present} />}

      {last && "failed" in last && (
        <Notice tone="bad" icon={CircleAlert} title="The command could not be sent" onDismiss={() => dispatch({ type: "dismiss" })}>
          <CommandErrorNotice error={last.failed} />
        </Notice>
      )}
      {last && "action" in last && last.action === "start" && (
        <Notice
          tone={START_LOOK[last.outcome].tone}
          icon={START_LOOK[last.outcome].icon}
          title={START_LOOK[last.outcome].label}
          meta={
            <>
              {last.pid !== null && <Chip mono>pid {last.pid}</Chip>}
              <Age iso={last.at} />
            </>
          }
          onDismiss={() => dispatch({ type: "dismiss" })}
        >
          {last.why}
        </Notice>
      )}
      {last && "action" in last && last.action === "restart-to-apply" && (
        <Notice
          tone={RESTART_LOOK[last.outcome].tone}
          icon={RESTART_LOOK[last.outcome].icon}
          title={RESTART_LOOK[last.outcome].label}
          meta={
            <>
              {last.halt && <Chip mono>{last.halt}</Chip>}
              <Chip>stop {last.confirmation ?? "not sent"}</Chip>
              {last.start?.pid != null && <Chip mono>pid {last.start.pid}</Chip>}
              <Age iso={last.at} />
            </>
          }
          onDismiss={() => dispatch({ type: "dismiss" })}
          hint={
            last.stop?.outcome === "needs-reconfirmation"
              ? `Nothing was stopped: the loop is now held by ${entry.run ?? "another run"}. Restart again to address that run.`
              : undefined
          }
        >
          <p>{last.why}</p>
          {last.checkout && (last.checkout.dirty || last.checkout.midTicket || !last.checkout.readable) && (
            <div className="mt-2">
              <CheckoutWarnings checkout={last.checkout} />
            </div>
          )}
        </Notice>
      )}
      {last && "action" in last && last.action === "stop-now" && (
        <Notice
          tone={stopNowLook(last).tone}
          icon={stopNowLook(last).icon}
          title={stopNowLook(last).label}
          meta={
            <>
              {last.target.pid !== null && <Chip mono>pid {last.target.pid}</Chip>}
              {last.target.group !== null && <Chip mono>group {last.target.group}</Chip>}
              {last.signals.map((signal) => (
                <Chip key={signal} mono>
                  {signal}
                </Chip>
              ))}
              {last.stop && <Chip>stop {last.stop.confirmation}</Chip>}
              <Age iso={last.at} />
            </>
          }
          hint={`Recorded in ${last.audit}.`}
          onDismiss={() => dispatch({ type: "dismiss" })}
        >
          <p>{last.why}</p>
          {last.checks.length > 0 && <SignalChecks checks={last.checks} />}
        </Notice>
      )}
      {last && "action" in last && last.action === "resume-work" && (
        <Notice
          tone={RESUME_LOOK[last.outcome].tone}
          icon={RESUME_LOOK[last.outcome].icon}
          title={RESUME_LOOK[last.outcome].label}
          meta={
            <>
              {last.pid !== null && <Chip mono>pid {last.pid}</Chip>}
              <Age iso={last.at} />
            </>
          }
          onDismiss={() => dispatch({ type: "dismiss" })}
        >
          {last.why}
        </Notice>
      )}
      {last &&
        "action" in last &&
        last.action !== "start" &&
        last.action !== "restart-to-apply" &&
        last.action !== "stop-now" &&
        last.action !== "resume-work" && (
        <CommandNotice
          result={last}
          currentRun={entry.run}
          busy={busy || !canReissue}
          onDismiss={() => dispatch({ type: "dismiss" })}
          onReissue={() => {
            // Re-issued against the run the loop holds now, from a fresh read,
            // and only when the operator asks. The destructive ones still arm
            // their confirmation (the reducer re-arms those; a plain command
            // is sent from here, since the reducer cannot send).
            const next = reissueOf(state.last);
            dispatch({ type: "reissue" });
            if (next?.kind === "send") void send(next.action);
          }}
        />
      )}
    </div>
  );
}

/** The answer to one of the channel's commands. */
function CommandNotice({
  result,
  currentRun,
  busy,
  onDismiss,
  onReissue,
}: {
  result: ControlResult;
  currentRun: string | null;
  busy: boolean;
  onDismiss: () => void;
  onReissue: () => void;
}) {
  const look = resultLook(result);
  return (
    <Notice
      tone={look.tone}
      icon={look.icon}
      title={`${ACTION_LABEL[result.action]} ${OUTCOME_LABEL[result.outcome]}`}
      meta={
        <>
          {look.state && <Chip>{look.state}</Chip>}
          {result.issue !== null && <Chip mono>#{result.issue}</Chip>}
          {result.stop && <Chip>{result.stop.kind} stop</Chip>}
          <Age iso={result.at} />
        </>
      }
      onDismiss={onDismiss}
      hint={
        result.outcome === "needs-reconfirmation"
          ? `Nothing was sent: the loop is now held by ${currentRun ?? "another run"}.`
          : result.action === "retry" && result.outcome === "applied" && result.recorded
            ? "Recorded; the attempt runs when the loop is started."
            : undefined
      }
      actions={
        result.outcome === "needs-reconfirmation" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onReissue}>
            Re-issue against {currentRun ?? "the current run"}
          </Button>
        )
      }
    >
      {result.why}
    </Notice>
  );
}

/**
 * What the control record says beyond a hold: a channel that is degraded or
 * could not be read, a stop not yet confirmed, and commands still deferred or
 * given up on. A degraded channel is never drawn as a hold or a stop.
 */
function ChannelNotices({ status, present }: { status: ControlView; present: boolean }) {
  const { channel, stop } = status;
  return (
    <>
      {present && channel.state === "degraded" && (
        <Notice
          tone="warn"
          icon={Unplug}
          title="Control channel degraded"
          meta={
            <>
              {channel.since && <Age iso={channel.since} />}
              {channel.retryAt && <Chip>retrying {new Date(channel.retryAt).toLocaleTimeString()}</Chip>}
            </>
          }
          hint="Commands sent now are deferred until the channel recovers."
        >
          {channel.why}
        </Notice>
      )}
      {present && channel.state === "unreachable" && (
        <Notice tone="warn" icon={Unplug} title="Control record unreadable">
          {channel.why ?? "The loop's control record could not be read, so holds and stops are unknown."}
        </Notice>
      )}
      {stop && stop.confirmation !== "confirmed" && (
        <Notice
          tone={stop.confirmation === "pending" ? "info" : "warn"}
          icon={stop.confirmation === "pending" ? Clock : TriangleAlert}
          title={stop.confirmation === "pending" ? "Stop pending" : "Stop unreachable"}
          meta={
            <>
              <Chip>{stop.kind} stop</Chip>
              <Age iso={stop.at} />
            </>
          }
          hint={
            stop.confirmation === "pending"
              ? "The loop stops at its next iteration boundary."
              : "The supervisor could not be reached to confirm it."
          }
        >
          {stop.why}
        </Notice>
      )}
      {status.deferrals.map((deferral) => (
        <Notice
          key={deferral.key}
          tone="info"
          icon={Clock}
          title={`${deferral.command} deferred`}
          meta={
            <>
              <Chip>attempt {deferral.attempts}</Chip>
              <Age iso={deferral.since} />
            </>
          }
        >
          Waiting for the loop to accept it.
        </Notice>
      ))}
      {status.givenUp.map((gone) => (
        <Notice
          key={gone.key}
          tone="bad"
          icon={Ban}
          title={`${gone.command} given up after ${gone.attempts} attempts`}
          meta={<Age iso={gone.at} />}
        >
          {gone.remedy}
        </Notice>
      ))}
    </>
  );
}

/** Where a branch lives on GitHub; the observer reports a detached HEAD as `detached <sha>`. */
function branchPath(branch: string): string {
  const detached = /^detached ([0-9a-f]+)$/.exec(branch);
  return detached ? `commit/${detached[1]}` : `tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

/** The top of a loop page: name, status and stage badges, subtitle, and the controls. */
export function LoopHeader({
  entry,
  status,
  onSent,
  initial,
}: {
  entry: DashboardLoop;
  status: ControlView | null;
  onSent: () => void;
  initial?: Partial<ControlsState>;
}) {
  const { ref: gazeRef } = useGaze({ travel: 3, lookAt: "pointer" });
  // A held loop is still "running" to the observer; the badge says what the operator needs to know.
  const hold = status?.hold?.kind;
  const shown =
    (entry.loopStatus === "running" || entry.loopStatus === "idle") && hold
      ? hold === "pause"
        ? "paused"
        : "waiting"
      : entry.loopStatus;
  return (
    <Controls entry={entry} status={status} onSent={onSent} initial={initial}>
      <div className="flex min-w-0 max-w-full items-center gap-4">
        <Blobatar
          name={entry.loop}
          className="size-20"
          blobatar={{ animate: "always", expression: expressionFor(entry, status) }}
          blobatarRef={gazeRef}
        />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{entry.loop}</h1>
            <RoleBadge role={entry.role} />
            <StatusBadge status={shown} />
            {entry.stage && entry.stage !== shown && (
              <Badge variant="outline" className="capitalize text-muted-foreground">
                {entry.stage}
              </Badge>
            )}
          </div>
          <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            {entry.issue === null && entry.branch === null ? (
              <Absent>no issue or branch</Absent>
            ) : (
              <>
                {entry.issue !== null && (
                  <span className="shrink-0">
                    <IssueLink repoUrl={entry.repoUrl} issue={entry.issue} />
                  </span>
                )}
                {entry.issueTitle && (
                  <span className="max-w-56 min-w-0 shrink truncate font-sans sm:max-w-sm" title={entry.issueTitle}>
                    {entry.issueTitle}
                  </span>
                )}
                {entry.issue !== null && entry.branch !== null && <span className="shrink-0">·</span>}
                {entry.branch !== null && (
                  <span className="-mb-1.5 max-w-72 min-w-0 truncate pb-1.5 sm:max-w-md" title={entry.branch}>
                    <RepoLink repoUrl={entry.repoUrl} path={branchPath(entry.branch)}>
                      {entry.branch}
                    </RepoLink>
                  </span>
                )}
              </>
            )}
          </p>
        </div>
      </div>
    </Controls>
  );
}
