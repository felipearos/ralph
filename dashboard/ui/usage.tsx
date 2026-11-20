import { useState } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";

import type {
  AccountUsageView,
  LoopSpendView,
  MachineSpendView,
  ModelSpendView,
  PlanUsageView,
  ProjectUsageReport,
  TaskCostView,
  SpendWindows,
  TokenTotals,
  UsageBarProviderView,
  UsageBarView,
  UsageReport,
  UsageWindowView,
} from "../contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { compactTokens, usd } from "./usage-format";
import { providerBrand } from "./usagebar-brand";
import { totalTokens } from "./spend-model";
import { SpendPanel } from "./spend-panel";
import { ProviderMark, Segmented, Tile } from "./usage-parts";
import { page } from "./api";
import { usePreloadHref } from "./in-app-link";
import { issueHref, issueRef } from "./issue-link";

export { compactTokens, usd } from "./usage-format";

/* ------------------------------------------------------------- formatting */

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

const ago = (iso: string, nowMs: number): string => {
  const ms = nowMs - Date.parse(iso);
  return ms < 60_000 ? "just now" : `${span(ms)} ago`;
};

const fullTime = (iso: string): string => new Date(iso).toLocaleString();

function codexTokens(models: ModelSpendView[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const model of models) {
    if (!model.model.startsWith("codex/")) continue;
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) totals[field] += model.tokens[field];
  }
  return totals;
}

function CodexUsage({ models }: { models: ModelSpendView[] }) {
  const tokens = codexTokens(models);
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return (
    <section aria-label="Codex token usage" className="space-y-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Codex tokens</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total" value={compactTokens(total)} />
        <Tile label="Input (uncached)" value={compactTokens(tokens.input)} />
        <Tile label="Output" value={compactTokens(tokens.output)} />
        <Tile label="Cache read" value={compactTokens(tokens.cacheRead)} />
      </div>
      <p className="text-xs text-muted-foreground">
        {total === 0 ? "No Codex usage recorded for this loop yet." : "Across all stages in this loop’s logs. Cached input is counted once. Codex does not report a dollar cost."}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ plan */

type Tone = "good" | "warn" | "bad" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  neutral: "text-muted-foreground",
};

const TONE_FILL: Record<Tone, string> = {
  good: "bg-status-good",
  warn: "bg-status-warn",
  bad: "bg-status-bad",
  neutral: "bg-muted-foreground/50",
};

const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warn: TriangleAlert,
  bad: CircleAlert,
  neutral: Info,
};

function windowTone(window: UsageWindowView): Tone {
  if (window.lapsed) return "neutral";
  if (window.utilization >= 0.9) return "bad";
  if (window.utilization >= 0.75) return "warn";
  return "good";
}

const WINDOW_WORD: Record<Tone, string> = {
  good: "Within limit",
  warn: "Past 75%",
  bad: "Nearly used up",
  neutral: "Reset since this reading",
};

function Meter({ label, window, nowMs }: { label: string; window: UsageWindowView | null; nowMs: number }) {
  if (window === null) {
    return (
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-sm text-muted-foreground">no reading</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted" />
      </div>
    );
  }
  const percent = Math.round(window.utilization * 100);
  const tone = windowTone(window);
  const Icon = TONE_ICON[tone];
  const resetMs = window.resetsAt === null ? null : Date.parse(window.resetsAt) - nowMs;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className={cn("text-2xl font-semibold tracking-tight", window.lapsed && "text-muted-foreground")}>{percent}%</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} plan usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", TONE_FILL[tone])} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className={cn("inline-flex items-center gap-1", TONE_TEXT[tone])}>
          <Icon className="size-3.5" />
          {WINDOW_WORD[tone]}
        </span>
        {window.resetsAt !== null && resetMs !== null && (
          <span className="text-muted-foreground" title={fullTime(window.resetsAt)}>
            {resetMs > 0 ? `resets in ${span(resetMs)}` : `reset ${span(-resetMs)} ago`}
          </span>
        )}
      </div>
    </div>
  );
}

function planStatus(plan: PlanUsageView): { tone: Tone; text: string } {
  if (plan.status === "rejected") return { tone: "bad", text: plan.usingOverage ? "Limit reached · on overage" : "Rate limited" };
  if (plan.status === "allowed_warning") return { tone: "warn", text: "Nearing a limit" };
  if (plan.status === "allowed") return { tone: "good", text: plan.usingOverage ? "Within limits · on overage" : "Within limits" };
  return { tone: "neutral", text: plan.status };
}

const WINDOW_NAME: Record<string, string> = { five_hour: "5-hour", seven_day: "7-day" };

function PlanCard({
  plan,
  nowMs,
  across = "loop",
}: {
  plan: (PlanUsageView & { project?: string }) | null;
  nowMs: number;
  /** Whose logs the reading was looked for in. */
  across?: "loop" | "project";
}) {
  if (plan === null) {
    return (
      <Card className="gap-3 py-5 shadow-none">
        <CardHeader className="px-5">
          <CardTitle className="text-sm">Claude plan</CardTitle>
          <CardDescription>No rate-limit reading in any {across}'s logs yet. Claude reports one as a loop runs.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const status = planStatus(plan);
  const Icon = TONE_ICON[status.tone];
  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">Claude plan</CardTitle>
          <Badge variant="outline" className={cn("gap-1", TONE_TEXT[status.tone])}>
            <Icon />
            {status.text}
          </Badge>
        </div>
        <CardDescription>
          <span title={fullTime(plan.at)}>Reported {ago(plan.at, nowMs)}</span> by <span className="font-mono">{plan.loop}</span>
          {plan.project !== undefined && (
            <>
              {" "}
              in <span className="font-mono">{plan.project}</span>
            </>
          )}
          {plan.limitingWindow && WINDOW_NAME[plan.limitingWindow] && (
            <> · the {WINDOW_NAME[plan.limitingWindow]} window is the one that binds</>
          )}
          {plan.windowsAt !== null && plan.windowsAt !== plan.at && (
            <> · figures from {ago(plan.windowsAt, nowMs)}</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 px-5 sm:grid-cols-2">
        <Meter label="5-hour window" window={plan.fiveHour} nowMs={nowMs} />
        <Meter label="7-day window" window={plan.sevenDay} nowMs={nowMs} />
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- tables */

function IssueCell({ task, repoUrl }: { task: TaskCostView; repoUrl: string | null }) {
  if (task.issue === null) {
    return (
      <span className="text-muted-foreground" title="No ledger label names the issue these runs worked on">
        No issue
      </span>
    );
  }
  const href = issueHref(repoUrl, task.issue);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono underline-offset-4 hover:underline"
    >
      {issueRef(task.issue)}
    </a>
  ) : (
    <span className="font-mono">{issueRef(task.issue)}</span>
  );
}

const TASKS_SHOWN = 8;

function TaskTable({
  tasks,
  repoUrls,
  showLoop,
  nowMs,
}: {
  tasks: TaskCostView[];
  repoUrls: Record<string, string | null>;
  showLoop: boolean;
  nowMs: number;
}) {
  const [all, setAll] = useState(false);
  if (tasks.length === 0) return <p className="text-sm text-muted-foreground">No task has reported a cost yet.</p>;
  const shown = all ? tasks : tasks.slice(0, TASKS_SHOWN);
  return (
    <div className="space-y-2">
      <div className="-mx-5 overflow-x-auto border-t">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Task</TableHead>
              {showLoop && <TableHead>Loop</TableHead>}
              <TableHead className="text-right">Reported cost</TableHead>
              <TableHead>Where it went</TableHead>
              <TableHead className="text-right">Unpriced tokens</TableHead>
              <TableHead className="text-right">Iterations</TableHead>
              <TableHead className="pr-5 text-right">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((task) => (
              <TableRow key={`${task.loop}:${task.issue ?? "none"}`}>
                <TableCell className="pl-5">
                  <IssueCell task={task} repoUrl={repoUrls[task.loop] ?? null} />
                </TableCell>
                {showLoop && <TableCell className="font-mono text-xs">{task.loop}</TableCell>}
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    {task.unreported && (
                      <Badge
                        variant="outline"
                        className="px-1.5 py-0 text-[10px] font-normal text-status-info"
                        title="An iteration of this task has not reported its cost yet: it is still running, or ended without a final report."
                      >
                        pending
                      </Badge>
                    )}
                    <span className="font-medium tabular-nums">{usd(task.costUsd)}</span>
                  </div>
                </TableCell>
                <TableCell className="max-w-72">
                  {task.stages.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={task.stages.map((stage) => `${stage.stage} ${usd(stage.costUsd)}`).join("\n")}
                    >
                      {task.stages.slice(0, 3).map((stage, index) => (
                        <span key={stage.stage}>
                          {index > 0 && " · "}
                          <span className="font-mono">{stage.stage}</span> <span className="tabular-nums">{usd(stage.costUsd)}</span>
                        </span>
                      ))}
                      {task.stages.length > 3 && ` · +${task.stages.length - 3}`}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {task.unpricedTokens === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span
                      title={task.models
                        .filter((model) => model.costUsd === null)
                        .map((model) => `${model.model}: ${totalTokens(model).toLocaleString()} tokens`)
                        .join("\n")}
                    >
                      {compactTokens(task.unpricedTokens)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{task.iterations}</TableCell>
                <TableCell className="pr-5 text-right text-xs text-muted-foreground" title={fullTime(task.lastAt)}>
                  {ago(task.lastAt, nowMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {tasks.length > TASKS_SHOWN && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setAll(!all)}>
          {all ? `Show the latest ${TASKS_SHOWN}` : `Show all ${tasks.length} tasks`}
        </Button>
      )}
    </div>
  );
}

function ModelTable({ models }: { models: ModelSpendView[] }) {
  if (models.length === 0) return <p className="text-sm text-muted-foreground">No model usage recorded.</p>;
  return (
    <div className="-mx-5 overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Model</TableHead>
            <TableHead className="text-right">Reported cost</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Cache read</TableHead>
            <TableHead className="pr-5 text-right">Cache write</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => (
            <TableRow key={model.model}>
              <TableCell className="pl-5 font-mono text-xs">{model.model}</TableCell>
              <TableCell className="text-right tabular-nums">
                {model.costUsd === null ? (
                  <span className="text-xs text-muted-foreground" title="This harness reports tokens but no cost">
                    not reported
                  </span>
                ) : (
                  usd(model.costUsd)
                )}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">{compactTokens(model.tokens.input)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{compactTokens(model.tokens.output)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{compactTokens(model.tokens.cacheRead)}</TableCell>
              <TableCell className="pr-5 text-right text-xs tabular-nums">{compactTokens(model.tokens.cacheWrite)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LoopSpendTable({ loops, navigate }: { loops: LoopSpendView[]; navigate: (path: string) => void }) {
  const sorted = [...loops].sort((left, right) => right.last7d - left.last7d || right.costUsd - left.costUsd);
  const preloadHref = usePreloadHref();
  return (
    <div className="-mx-5 overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Loop</TableHead>
            <TableHead className="text-right">Last 7 days</TableHead>
            <TableHead className="text-right">All logs</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Codex tokens</TableHead>
            <TableHead className="pr-5 text-right">Unpriced tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((loop) => (
            <TableRow key={loop.loop}>
              <TableCell className="pl-5">
                <a
                  href={page(`/loops/${encodeURIComponent(loop.loop)}`)}
                  className="font-mono text-xs underline-offset-4 hover:underline"
                  onPointerEnter={() => preloadHref(page(`/loops/${encodeURIComponent(loop.loop)}`))}
                  onFocus={() => preloadHref(page(`/loops/${encodeURIComponent(loop.loop)}`))}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(`/loops/${encodeURIComponent(loop.loop)}`);
                  }}
                >
                  {loop.loop}
                </a>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{usd(loop.last7d)}</TableCell>
              <TableCell className="text-right tabular-nums">{usd(loop.costUsd)}</TableCell>
              <TableCell className="text-right tabular-nums">{loop.runs}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {compactTokens(loop.models.filter(model => model.model.startsWith("codex/")).reduce((sum, model) => sum + totalTokens(model), 0))}
              </TableCell>
              <TableCell className="pr-5 text-right text-xs tabular-nums">
                {loop.unpricedTokens === 0 ? <span className="text-muted-foreground">—</span> : compactTokens(loop.unpricedTokens)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}

const COST_NOTE =
  "Costs are reported by the runners. Tokens without a reported cost, including Codex tokens, are shown as unpriced.";

/* --------------------------------------------------------------- exports */

/**
 * The account's limits, shared by every project's loops: read across every
 * registered project's logs, and labelled so, so that a quiet project never
 * reads as a healthy plan.
 */
function AccountPlan({ account, nowMs, codexElsewhere }: { account: AccountUsageView; nowMs: number; codexElsewhere: boolean }) {
  return (
    <section className="space-y-3" aria-labelledby="account-plan-heading">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="account-plan-heading" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Plan limits
        </h3>
        <Badge variant="secondary">all projects</Badge>
        <span className="text-xs text-muted-foreground">
          Every project's loops share these limits. Read from {account.projects.join(", ") || "no project"}.
        </span>
      </div>
      {account.unread.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-status-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            Not read: {account.unread.map((entry) => `${entry.project} (${entry.why})`).join("; ")}. The reading may be
            older than the newest one.
          </span>
        </p>
      )}
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)] items-start gap-4",
          !codexElsewhere && "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
        )}
      >
        <PlanCard plan={account.plan} nowMs={nowMs} across="project" />
        {!codexElsewhere && (
          <Card className="gap-3 py-5 shadow-none">
            <CardHeader className="px-5">
              <CardTitle className="text-sm">Codex plan</CardTitle>
              <CardDescription>
                No limit reading: the harness records Codex tokens, not Codex plan limits. This project's Codex tokens
                are under its loops below.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- usagebar */

/** UsageBar's countdown: `2d 4h`, `3h 20m`, `14m`, `under 1m`. */
function countdown(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "under 1m";
}

type UsageBarWindow = UsageBarProviderView["windows"][number];

function resetText(window: UsageBarWindow, nowMs: number): string {
  if (window.resetsAt !== null) {
    const ms = Date.parse(window.resetsAt) - nowMs;
    return ms <= 0 ? "Resets now" : `Resets in ${countdown(ms)}`;
  }
  return window.resetDescription === null ? "" : `Resets ${window.resetDescription}`;
}

/**
 * UsageBar's pace summary is `<verdict> | Expected N% used | <eta>`: the
 * verdict goes under the percentage, the ETA under the reset, the middle is
 * dropped, as UsageBar lays it out.
 */
function paceParts(summary: string | null): { left: string; right: string } {
  if (summary === null) return { left: "", right: "" };
  const parts = summary.replace(/^Pace:\s*/, "").split(/\s+[|·]\s+/);
  const eta = parts.length > 1 ? parts[parts.length - 1]! : "";
  return { left: parts[0] ?? "", right: eta.charAt(0).toUpperCase() + eta.slice(1) };
}

/** A UsageBar window in the plan meter's terms, so both use the page's one tone scale. */
const asPlanWindow = (window: UsageBarWindow, nowMs: number): UsageWindowView => ({
  utilization: Math.min(100, Math.max(0, window.usedPercent)) / 100,
  resetsAt: window.resetsAt,
  lapsed: window.resetsAt !== null && Date.parse(window.resetsAt) <= nowMs,
});

function UsageBarWindowRow({ window, nowMs, stale }: { window: UsageBarWindow; nowMs: number; stale: boolean }) {
  // A carried-forward reading is greyed, as UsageBar greys stale bars.
  const tone = stale ? "neutral" : windowTone(asPlanWindow(window, nowMs));
  const percent = Math.min(100, Math.max(0, window.usedPercent));
  const pace = paceParts(window.pace);
  const reset = resetText(window, nowMs);
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{window.label}</div>
      <div
        role="meter"
        aria-label={`${window.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", TONE_FILL[tone])} style={{ width: `${percent}%` }} />
      </div>
      <div className="flex justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex flex-col">
          <span className="tabular-nums">{Math.round(percent)}% used</span>
          {pace.left !== "" && <span>{pace.left}</span>}
        </div>
        <div className="flex flex-col items-end text-right">
          {reset !== "" && <span title={window.resetsAt === null ? undefined : fullTime(window.resetsAt)}>{reset}</span>}
          {pace.right !== "" && <span>{pace.right}</span>}
        </div>
      </div>
    </div>
  );
}

function UsageBarCard({ provider, nowMs }: { provider: UsageBarProviderView; nowMs: number }) {
  const brand = providerBrand(provider.provider);
  // The card's headline is its tightest window, toned like that window's bar.
  const worst = provider.windows.reduce<UsageBarWindow | null>(
    (max, window) => (max === null || window.usedPercent > max.usedPercent ? window : max),
    null,
  );
  const worstTone = worst === null ? null : provider.stale ? "neutral" : windowTone(asPlanWindow(worst, nowMs));
  // "Claude Max" → "Max": the title already names the provider.
  let plan = provider.plan === null ? null : provider.plan.charAt(0).toUpperCase() + provider.plan.slice(1);
  if (plan !== null && plan.toLowerCase().startsWith(`${brand.name.toLowerCase()} `)) plan = plan.slice(brand.name.length + 1);
  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ProviderMark provider={provider.provider} />
          {brand.name}
          {plan !== null && <Badge variant="secondary">{plan}</Badge>}
          {provider.stale && <Badge variant="secondary">stale</Badge>}
        </CardTitle>
        {(provider.account !== null || provider.updatedAt !== null) && (
          <CardDescription className="truncate">
            {provider.account}
            {provider.account !== null && provider.updatedAt !== null && " · "}
            {provider.updatedAt !== null && <span title={fullTime(provider.updatedAt)}>updated {ago(provider.updatedAt, nowMs)}</span>}
          </CardDescription>
        )}
        {worst !== null && worstTone !== null && (
          <CardAction className={cn("text-2xl font-semibold tracking-tight tabular-nums", TONE_TEXT[worstTone])}>
            {Math.round(Math.min(100, worst.usedPercent))}%
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        {provider.error !== null && (
          <p className="flex items-start gap-1.5 text-xs text-status-warn">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span className="break-words">
              {provider.error}
              {provider.stale && " Showing the last reading."}
            </span>
          </p>
        )}
        {provider.error === null && provider.windows.length === 0 && (
          <p className="text-xs text-muted-foreground">No limit windows reported.</p>
        )}
        {provider.windows.map((window, index) => (
          // Labels repeat when an extra limit shares a standard window's name.
          <UsageBarWindowRow key={`${index}:${window.label}`} window={window} nowMs={nowMs} stale={provider.stale} />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * The machine's UsageBar reading: every provider enabled in UsageBar, with
 * the limit windows its tray shows. It is the host's, not a project's, so it
 * reads the same on every project's page.
 */
function UsageBarSection({ view, nowMs }: { view: UsageBarView; nowMs: number }) {
  return (
    <section className="space-y-3" aria-labelledby="usagebar-heading">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="usagebar-heading" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          UsageBar
        </h3>
        <Badge variant="secondary">this machine</Badge>
        <span className="text-xs text-muted-foreground">
          {view.state === "read" ? (
            <>
              Every provider enabled in UsageBar, read from <span className="font-mono">codexbar</span>{" "}
              <span title={fullTime(view.readAt)}>{ago(view.readAt, nowMs)}</span>.
            </>
          ) : view.state === "reading" ? (
            <>
              Reading the providers' limits with <span className="font-mono">codexbar</span>; they appear on the next
              refresh.
            </>
          ) : (
            <>Not available: {view.why}. Install UsageBar and enable providers to see their limits here.</>
          )}
        </span>
      </div>
      {view.state === "read" && view.providers.length === 0 && (
        <p className="text-sm text-muted-foreground">UsageBar has no provider enabled.</p>
      )}
      {view.state === "read" && view.providers.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {view.providers.map((provider) => (
            <UsageBarCard key={provider.provider} provider={provider} nowMs={nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- spend */

function SpendTiles({ spend, hint, wide }: { spend: SpendWindows; hint?: string; wide: boolean }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3", wide && "lg:col-span-2 lg:grid-cols-4")}>
      <Tile label="Last 5 hours" value={usd(spend.last5h)} />
      <Tile label="Last 24 hours" value={usd(spend.last24h)} />
      <Tile label="Last 7 days" value={usd(spend.last7d)} />
      <Tile label="All logs" value={usd(spend.total)} {...(hint === undefined ? {} : { hint })} />
    </div>
  );
}

function ProjectSpendTable({ account }: { account: AccountUsageView }) {
  const sorted = [...account.projectSpend].sort(
    (left, right) => right.spend.last7d - left.spend.last7d || right.spend.total - left.spend.total,
  );
  if (sorted.length === 0) return <p className="text-sm text-muted-foreground">No project's logs could be read.</p>;
  return (
    <div className="-mx-5 overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Project</TableHead>
            <TableHead className="text-right">Last 5 hours</TableHead>
            <TableHead className="text-right">Last 24 hours</TableHead>
            <TableHead className="text-right">Last 7 days</TableHead>
            <TableHead className="pr-5 text-right">All logs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map(({ project, spend }) => (
            <TableRow key={project}>
              <TableCell className="pl-5 font-mono text-xs">{project}</TableCell>
              <TableCell className="text-right tabular-nums">{usd(spend.last5h)}</TableCell>
              <TableCell className="text-right tabular-nums">{usd(spend.last24h)}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{usd(spend.last7d)}</TableCell>
              <TableCell className="pr-5 text-right tabular-nums">{usd(spend.total)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export type SpendScope = "project" | "all" | "machine";

function ScopeSwitch({
  scope,
  onScope,
  projects,
  machine,
}: {
  scope: SpendScope;
  onScope: (scope: SpendScope) => void;
  /** Whether the server reads every project, so All projects means something. */
  projects: boolean;
  /** Whether the server has a UsageBar cost reader. */
  machine: boolean;
}) {
  const options: { value: SpendScope; label: string; title?: string }[] = [{ value: "project", label: "This project" }];
  if (projects) options.push({ value: "all", label: "All projects" });
  if (machine) {
    options.push({
      value: "machine",
      label: "This machine",
      title: "Every Claude and Codex session on this host, as UsageBar's cost view reads it",
    });
  }
  return <Segmented label="Spend scope" options={options} value={scope} onChange={onScope} />;
}

/**
 * The machine scope: UsageBar's own cost view, every session on this host at
 * list prices. Its first read scans every session log and takes minutes, so
 * until it lands the panel says so rather than showing an empty chart.
 */
function MachineSpend({ view, generatedAt, nowMs }: { view: MachineSpendView; generatedAt: string; nowMs: number }) {
  if (view.state === "read") {
    return (
      <SpendPanel
        daily={view.daily}
        generatedAt={generatedAt}
        scopeLabel={`this machine · read ${ago(view.readAt, nowMs)}`}
        caption="Estimated cost"
        captionNote="* If billed at full API rates, as UsageBar prices it."
        estimate
      />
    );
  }
  return (
    <Card className="gap-3 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Spend</CardTitle>
        <CardDescription>
          {view.state === "reading" ? (
            <>
              Reading this machine's spend with <span className="font-mono">codexbar cost</span>. It scans every session
              log, which takes a couple of minutes; this panel fills in on its own when it's done.
            </>
          ) : (
            <span className="inline-flex items-start gap-1.5 text-status-warn">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              This machine's spend could not be read: {view.why}
            </span>
          )}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

/**
 * The overview's usage section: the machine's UsageBar reading and the
 * account's plan limits, then spend — this project's loops, or every
 * project's, as the operator picks.
 */
export function UsageOverview({
  report,
  repoUrls,
  navigate,
}: {
  report: ProjectUsageReport;
  repoUrls: Record<string, string | null>;
  navigate: (path: string) => void;
}) {
  const nowMs = Date.parse(report.generatedAt);
  const [scope, setScope] = useState<SpendScope>("project");
  const account = report.account;
  const all = scope === "all" && account !== undefined;
  const machineSpend = report.machineSpend;
  const machine = scope === "machine" && machineSpend !== undefined;
  const codexElsewhere =
    report.usagebar?.state === "read" &&
    report.usagebar.providers.some((provider) => provider.provider === "codex" && provider.windows.length > 0);
  return (
    <section className="space-y-4" aria-labelledby="usage-heading">
      <div>
        <h2 id="usage-heading" className="text-sm font-medium">
          Usage
        </h2>
        <p className="text-sm text-muted-foreground">{COST_NOTE}</p>
      </div>

      {report.usagebar !== undefined && <UsageBarSection view={report.usagebar} nowMs={nowMs} />}

      {account !== undefined && <AccountPlan account={account} nowMs={nowMs} codexElsewhere={codexElsewhere} />}

      {(account !== undefined || machineSpend !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {machine ? "Every session on this machine" : all ? "Every project's loops" : "This project's loops"}
          </h3>
          <ScopeSwitch scope={scope} onScope={setScope} projects={account !== undefined} machine={machineSpend !== undefined} />
        </div>
      )}

      {machine ? (
        <MachineSpend view={machineSpend} generatedAt={report.generatedAt} nowMs={nowMs} />
      ) : (
        <SpendPanel
          daily={all ? account.daily : (report.daily ?? [])}
          generatedAt={report.generatedAt}
          scopeLabel={all ? "all projects" : "this project"}
        />
      )}

      {machine ? null : all ? (
        <>
          <SpendTiles
            spend={account.spend}
            wide
            hint={`${account.projectSpend.length} project${account.projectSpend.length === 1 ? "" : "s"}`}
          />
          <Panel title="By project" description="Each project's reported cost, from its own loops' logs.">
            <ProjectSpendTable account={account} />
          </Panel>
        </>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {account === undefined && <PlanCard plan={report.plan} nowMs={nowMs} />}
            <SpendTiles
              spend={report.spend}
              wide={account !== undefined}
              hint={`${report.sources.results} runs in ${report.sources.files} files`}
            />
          </div>

          <Panel title="Cost per task" description="Each task is one issue in one loop, attributed from the usage ledger's step labels.">
            <TaskTable tasks={report.tasks} repoUrls={repoUrls} showLoop nowMs={nowMs} />
          </Panel>

          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4">
            <Panel title="By loop">
              <LoopSpendTable loops={report.loops} navigate={navigate} />
            </Panel>
            <Panel title="By model" description="Last 7 days.">
              <ModelTable models={report.models} />
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}

/** One loop's usage: its spend and what each of its tasks cost. */
export function LoopUsage({ report, loop, repoUrl }: { report: UsageReport; loop: string; repoUrl: string | null }) {
  const nowMs = Date.parse(report.generatedAt);
  const spend = report.loops.find((entry) => entry.loop === loop);
  const tasks = report.tasks.filter((task) => task.loop === loop);
  return (
    <Card className="gap-4 py-5 shadow-none md:col-span-2">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Usage</CardTitle>
        <CardDescription>{COST_NOTE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Last 7 days" value={usd(spend?.last7d ?? 0)} />
          <Tile label="All logs" value={usd(spend?.costUsd ?? 0)} />
          <Tile label="Runs with a cost" value={String(spend?.runs ?? 0)} />
          <Tile label="Unpriced tokens" value={compactTokens(spend?.unpricedTokens ?? 0)} />
        </div>
        <CodexUsage models={spend?.models ?? []} />
        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Cost per task</h3>
          <TaskTable tasks={tasks} repoUrls={{ [loop]: repoUrl }} showLoop={false} nowMs={nowMs} />
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">By model</h3>
          <ModelTable models={spend?.models ?? []} />
        </div>
      </CardContent>
    </Card>
  );
}
