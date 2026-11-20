import { useMemo, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleHelp,
  CircleX,
  FileText,
  Gauge,
  MessageSquare,
  Pencil,
  Search,
  Settings2,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import type { ActivityView } from "../contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { LabelText } from "./label";
import {
  FILTERS,
  applyFilter,
  durationOf,
  filterCounts,
  groupActivity,
  isError,
  type Filter,
  type Group,
  type Step,
} from "./activity-model";

/** Groups shown before "Show all"; the newest few of them start expanded. */
const VISIBLE_GROUPS = 8;
const EXPANDED_GROUPS = 3;
/** Steps shown inside an expanded group before "show earlier". */
const VISIBLE_STEPS = 12;
/** A step gets its own time when it arrived this long after the one above it. */
const GAP_MS = 2 * 60 * 1000;
/** Details longer than this can be clicked open. */
const EXPANDABLE = 110;

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  stages: "Stages",
  tools: "Tools",
  messages: "Messages",
  errors: "Errors",
};

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const fullTime = (iso: string): string => new Date(iso).toLocaleString();

function toolIcon(name: string): LucideIcon {
  const tool = name.toLowerCase();
  if (tool === "bash" || tool === "command_execution" || tool === "shell") return Terminal;
  if (tool === "grep" || tool === "glob" || tool === "search" || tool === "websearch") return Search;
  if (tool === "read" || tool === "webfetch") return FileText;
  if (tool === "edit" || tool === "write" || tool === "multiedit" || tool === "file_change" || tool === "patch") return Pencil;
  if (tool === "agent" || tool === "task") return Bot;
  if (tool === "reasoning") return Brain;
  return Wrench;
}

function LiveDot() {
  return (
    <span className="relative inline-flex size-2 shrink-0" title="The loop is on this step now">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-info opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-status-info" />
    </span>
  );
}

/* ------------------------------------------------------------------ steps */

function stepLook(step: Step): { icon: LucideIcon; iconClass: string; dim: boolean } {
  const parsed = step.parsed;
  switch (parsed.kind) {
    case "tool":
      return { icon: parsed.error ? X : toolIcon(parsed.name), iconClass: parsed.error ? "text-status-bad" : "text-muted-foreground", dim: false };
    case "result":
      return { icon: parsed.ok ? Check : X, iconClass: parsed.ok ? "text-status-good" : "text-status-bad", dim: false };
    case "text":
      return { icon: MessageSquare, iconClass: "text-foreground", dim: false };
    case "thinking":
      return { icon: Brain, iconClass: "text-muted-foreground", dim: false };
    case "rate": {
      const warn = parsed.status !== "allowed" && parsed.status !== "unknown";
      return { icon: Gauge, iconClass: warn ? "text-status-warn" : "text-muted-foreground", dim: !warn };
    }
    case "system":
      return { icon: Settings2, iconClass: "text-muted-foreground", dim: true };
    case "invalid":
      return { icon: CircleHelp, iconClass: "text-muted-foreground", dim: true };
    case "other":
      return { icon: Circle, iconClass: "text-muted-foreground", dim: false };
  }
}

const RATE_TEXT: Record<string, string> = {
  allowed: "Rate limit ok",
  allowed_warning: "Rate limit nearly reached",
  rejected: "Rate limited",
  overage: "Rate limited — running on overage",
};

/** The step's words: what is shown folded, and what the full text is. */
function StepBody({ step, open }: { step: Step; open: boolean }) {
  const parsed = step.parsed;
  const clamp = open ? "whitespace-pre-wrap break-words" : "truncate";
  switch (parsed.kind) {
    case "tool":
      return (
        <span className={cn("flex min-w-0 items-baseline gap-2", open && "flex-wrap")}>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 px-1.5 py-0 font-mono text-[11px] font-normal",
              parsed.error && "border-status-bad/40 text-status-bad",
            )}
          >
            {parsed.name}
            {parsed.error && " failed"}
          </Badge>
          {parsed.detail && (
            <span className={cn("min-w-0 font-mono text-xs", parsed.error ? "text-status-bad" : "text-muted-foreground", clamp)}>
              <LabelText text={parsed.detail} />
            </span>
          )}
        </span>
      );
    case "result":
      return (
        <span className={cn("min-w-0 font-mono text-xs", parsed.ok ? "text-muted-foreground" : "text-status-bad", clamp)}>
          {parsed.detail ? <LabelText text={parsed.detail} /> : parsed.ok ? "ok" : "error"}
        </span>
      );
    case "text":
      return (
        <span className={cn("min-w-0 text-sm text-foreground", clamp)}>
          <LabelText text={parsed.detail} />
        </span>
      );
    case "thinking":
      return <span className={cn("min-w-0 text-sm text-muted-foreground italic", clamp)}>{parsed.detail}</span>;
    case "rate":
      return (
        <span className={cn("text-xs", parsed.status === "allowed" || parsed.status === "unknown" ? "text-muted-foreground" : "text-status-warn")}>
          {RATE_TEXT[parsed.status] ?? `Rate limit ${parsed.status}`}
        </span>
      );
    case "system":
      return (
        <span className={cn("min-w-0 font-mono text-xs text-muted-foreground", clamp)}>
          {parsed.detail ? `system · ${parsed.detail}` : "system event"}
        </span>
      );
    case "invalid":
      return <span className="text-xs text-muted-foreground italic">Unreadable event</span>;
    case "other":
      return <span className={cn("min-w-0 font-mono text-xs", clamp)}>{parsed.detail}</span>;
  }
}

function detailOf(step: Step): string {
  const parsed = step.parsed;
  return "detail" in parsed ? parsed.detail : "";
}

function StepRow({
  step,
  previousAt,
  live,
  open,
  onToggle,
}: {
  step: Step;
  previousAt: string | null;
  live: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const look = stepLook(step);
  const Icon = look.icon;
  const expandable = detailOf(step).length > EXPANDABLE || detailOf(step).includes("\n");
  const gap = previousAt !== null && Date.parse(step.firstAt) - Date.parse(previousAt) >= GAP_MS;
  const title =
    step.count > 1 ? `${step.count} times, ${fullTime(step.firstAt)} – ${fullTime(step.at)}` : fullTime(step.at);

  return (
    <li
      className={cn(
        "group/step flex items-start gap-2.5 rounded-md px-2 py-1 -mx-2",
        expandable && "cursor-pointer hover:bg-muted/40",
        look.dim && "opacity-60",
        isError(step.parsed) && "bg-status-bad/5",
      )}
      onClick={expandable ? onToggle : undefined}
      aria-expanded={expandable ? open : undefined}
      title={title}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {live ? <LiveDot /> : <Icon className={cn("size-3.5", look.iconClass)} />}
      </span>
      <span className="flex min-h-5 min-w-0 flex-1 items-center">
        <StepBody step={step} open={open} />
      </span>
      {step.count > 1 && (
        <Badge variant="secondary" className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px] font-normal tabular-nums">
          ×{step.count}
        </Badge>
      )}
      {gap && <span className="mt-0.5 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{clock(step.firstAt)}</span>}
      {expandable ? (
        <ChevronRight
          className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
    </li>
  );
}

/* ----------------------------------------------------------------- groups */

function GroupStateIcon({ group, live }: { group: Group; live: boolean }) {
  if (live) return <LiveDot />;
  switch (group.state) {
    case "completed":
      return group.degraded ? (
        <TriangleAlert className="size-4 text-status-warn" />
      ) : (
        <CircleCheck className="size-4 text-status-good" />
      );
    case "failed":
      return <CircleX className="size-4 text-status-bad" />;
    case "degraded":
      return <TriangleAlert className="size-4 text-status-warn" />;
    case "running":
    default:
      return <Circle className="size-4 text-muted-foreground" />;
  }
}

const STATE_TEXT: Record<Exclude<Group["state"], null>, { text: string; tone: string }> = {
  running: { text: "running", tone: "text-status-info" },
  completed: { text: "completed", tone: "text-status-good" },
  failed: { text: "failed", tone: "text-status-bad" },
  degraded: { text: "degraded", tone: "text-status-warn" },
};

function GroupBlock({
  group,
  live,
  open,
  onToggle,
  openSteps,
  onToggleStep,
  showSteps,
}: {
  group: Group;
  live: boolean;
  open: boolean;
  onToggle: () => void;
  openSteps: Set<string>;
  onToggleStep: (key: string) => void;
  showSteps: boolean;
}) {
  const [allSteps, setAllSteps] = useState(false);
  const hidden = allSteps ? 0 : Math.max(0, group.steps.length - VISIBLE_STEPS);
  const steps = group.steps.slice(hidden);
  // A stage whose start was seen but not its end has handed over to the next
  // stage; only the live, newest group is still running.
  const shown = group.state === "running" && !live ? null : group.state;
  const state = shown === null ? (live ? STATE_TEXT.running : null) : STATE_TEXT[shown];
  const facts = [
    group.endedAt !== group.startedAt ? durationOf(group.startedAt, group.endedAt) : null,
    group.steps.length > 0 ? `${group.steps.length} ${group.steps.length === 1 ? "step" : "steps"}` : null,
  ].filter(Boolean);
  const canOpen = showSteps && group.steps.length > 0;

  return (
    <li className="relative">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "-mx-2 flex h-auto w-[calc(100%+1rem)] items-center justify-start gap-2.5 rounded-md border-0 px-2 py-1.5 text-left font-normal tracking-normal whitespace-normal normal-case aria-expanded:bg-transparent",
          canOpen ? "hover:bg-muted/40 dark:hover:bg-muted/40" : "cursor-default hover:bg-transparent dark:hover:bg-transparent",
        )}
        onClick={canOpen ? onToggle : undefined}
        aria-expanded={canOpen ? open : undefined}
      >
        <span className="flex w-4 shrink-0 justify-center">
          <GroupStateIcon group={group} live={live && (!open || group.steps.length === 0)} />
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-sm font-medium">{group.stage}</span>
          {group.runner && (
            <Badge variant="outline" className="px-1.5 py-0 font-mono text-[11px] font-normal text-muted-foreground">
              {group.runner}
            </Badge>
          )}
          {state && <span className={cn("text-xs", state.tone)}>{state.text}</span>}
          {group.degraded && group.state === "completed" && <span className="text-xs text-status-warn">after degrading</span>}
          {facts.length > 0 && <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums" title={fullTime(group.startedAt)}>
          {clock(group.startedAt)}
        </span>
        {canOpen ? (
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
      </Button>

      {canOpen && open && (
        <div className="ml-[7px] border-l pl-4">
          {hidden > 0 && (
            <Button
              type="button"
              variant="link"
              className="h-auto border-0 px-0 py-1 font-normal tracking-normal text-muted-foreground no-underline normal-case hover:text-foreground hover:no-underline"
              onClick={() => setAllSteps(true)}
            >
              Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </Button>
          )}
          <ol className="space-y-0.5 py-1">
            {steps.map((step, index) => (
              <StepRow
                key={step.key}
                step={step}
                previousAt={index === 0 ? group.startedAt : steps[index - 1]!.at}
                live={live && index === steps.length - 1}
                open={openSteps.has(step.key)}
                onToggle={() => onToggleStep(step.key)}
              />
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------- feed */

function toggled(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * The loop's recent timeline, grouped by stage.
 *
 * `live` marks the newest step as the one the loop is on; it is only true
 * while the supervisor is alive and the loop is running.
 */
export function ActivityFeed({ recent, live }: { recent: ActivityView[]; live: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [showAll, setShowAll] = useState(false);
  // Toggles are stored against each group's default, so a group keeps the
  // state someone gave it while new rows keep arriving.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [openSteps, setOpenSteps] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupActivity(recent), [recent]);
  const counts = useMemo(() => filterCounts(groups), [groups]);
  const filtered = useMemo(() => applyFilter(groups, filter), [groups, filter]);

  if (recent.length === 0) return <p className="text-sm text-muted-foreground">No timeline events yet.</p>;

  const newest = groups.at(-1)?.key;
  const hidden = showAll ? 0 : Math.max(0, filtered.length - VISIBLE_GROUPS);
  const visible = filtered.slice(hidden);

  return (
    <div className="space-y-3">
      <Tabs value={filter} onValueChange={(next) => setFilter(next as Filter)}>
        <TabsList variant="line" className="h-auto flex-wrap justify-start gap-1.5 p-0" aria-label="Filter activity">
          {FILTERS.map((option) => (
            <TabsTrigger key={option} value={option} className="h-7 flex-none gap-1.5 px-2.5">
              {FILTER_LABEL[option]}
              <span
                className={cn(
                  "tabular-nums",
                  option === "errors" && counts.errors > 0 ? "text-status-bad" : "text-muted-foreground",
                )}
              >
                {counts[option]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nothing in the recent activity matches this filter.</p>
      ) : (
        <>
          {hidden > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setShowAll(true)}
            >
              Show all {filtered.length} stages ({hidden} older)
            </Button>
          )}
          <ol className="space-y-1">
            {visible.map((group, index) => {
              const defaultOpen = filter !== "all" || index >= visible.length - EXPANDED_GROUPS;
              const open = flipped.has(group.key) ? !defaultOpen : defaultOpen;
              return (
                <GroupBlock
                  key={group.key}
                  group={group}
                  live={live && group.key === newest}
                  open={open}
                  onToggle={() => setFlipped((set) => toggled(set, group.key))}
                  openSteps={openSteps}
                  onToggleStep={(key) => setOpenSteps((set) => toggled(set, key))}
                  showSteps={filter !== "stages"}
                />
              );
            })}
          </ol>
          {showAll && filtered.length > VISIBLE_GROUPS && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setShowAll(false)}
            >
              Show only the latest {VISIBLE_GROUPS}
            </Button>
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        The observer keeps the latest {recent.length >= 200 ? "200" : recent.length} events. Times are local.
      </p>
    </div>
  );
}
