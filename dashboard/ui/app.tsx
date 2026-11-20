import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Link as RouterLink, Outlet, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useGaze } from "@blobatar/react/gaze";
import {
  ArrowLeft,
  Ban,
  Bell,
  Bot,
  ChartColumn,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Copy,
  Database,
  GitMerge,
  GitPullRequestArrow,
  HeartPulse,
  FlaskConical,
  Lightbulb,
  ListTodo,
  RotateCcw,
  Route as RouteIcon,
  ShieldCheck,
  Siren,
  Tag,
  TriangleAlert,
  UserRound,
  Wrench,
  Settings as SettingsIcon,
  Zap,
} from "lucide-react";
import type {
  ControlView,
  Dashboard,
  DashboardLoop,
  IssueHistoryView,
  IssueState,
  PresenceView,
  ProjectHealthView,
  ProjectSetupView,
  ProjectView,
  StopKind,
} from "../contracts";
import { ROLE_PANELS, triagers } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Blobatar } from "@/components/ui/blobatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { StatesGallery } from "./states";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ActivityFeed } from "./activity";
import { AgentsAdmin, CreateAgentCheckout, DeleteAgentWorktree, RerunAgentSetup } from "./agents";
import { ProjectSettings } from "./settings";
import { LabelsPage } from "./labels";
import { Backlog } from "./backlog";
import { Factory } from "./factory";
import { TriagePanel } from "./triage";
import { stuckGroups } from "./blocked-model";
import { cardLead } from "./ci-health-model";
import { CiHealthPage } from "./ci-health";
import { FollowingPanel } from "./following";
import { SentinelPanel } from "./sentinel-panel";
import { LearningsPanel } from "./learnings";
import { EvalsPage } from "./evals";
import { JavSettings } from "./jav";
import { VerifierSettings } from "./verifier";
import { SentinelSettings } from "./sentinel";
import { ConfigOffNote } from "./agent-switch";
import { IssueLink, LabelText } from "./label";
import { PluginDoctor } from "./doctor";
import { AuditHistory, NotificationsOverview, NotificationsPanel } from "./feed";
import { LiveOutput } from "./output";
import { ChatSheet, TalkButton } from "./chat";
import { talkOnCard } from "./chat-model";
import { ClaimsList, JournalList, Ownership, RunnerFailure, TokenUsage, unattributedRows } from "./records";
import { LoopUsage, UsageOverview } from "./usage";
import { isIntakeSurface, isRemote, page } from "./api";
import { LocalOnlyNote, useCommandAvailability } from "./command";
import { BridgeBanner, BridgeContext } from "./remote";
import { snapshotStamp } from "./remote-model";
import type { LiveStatus } from "./live-stream";
import type { Read } from "./query-reads";
import { POLL_MS } from "./reads";
import {
  useBridgeStatus,
  useDashboard,
  useLiveStream,
  useLoopControl,
  useProjectSetup,
  useProjects,
  useProjectsHealth,
  useUsage,
} from "./use-reads";
import { landingProject, pagePath, parseLocation } from "./project-model";
import { ProjectRail } from "./project-rail";
import { usePreloadHref } from "./in-app-link";
import { IntakeNotFound, IntakePage } from "./intake";
import { committedPath, screenOf, type Screen } from "./route-tree";
import { setScreenProject } from "./screen-project";
import { ModelUpdatesPanel } from "./model-updates";
import { ProjectSleepBanner, ProjectSleepToggle } from "./project-sleep";
import { railView } from "./project-rail-model";
import { AddProjectDialog } from "./add-project";
import { SetupPanel } from "./setup";
import { setupStamp, type SetupStamp } from "./onboarding-model";
import { retryLine } from "./retry-model";
import { setTrackerLinks } from "./issue-link";
import {
  type Tone,
  toneOf,
  TONE_TEXT,
  TONE_TINT,
  expressionFor,
  Dot,
  StatusBadge,
  Absent,
  RepoLink,
  RoleBadge,
  Reading,
  ageOf,
} from "./shell-parts";
import { Controls, LoopHeader, OUTCOME_TONE } from "./controls";

/* ------------------------------------------------------------------ tone */

const ISSUE_LABEL: Record<IssueState, string> = {
  active: "Active",
  merged: "Merged",
  pr: "PR open",
  handoff: "Handed off",
  blocked: "Blocked",
  failed: "Failed",
};

// GitHub's glyphs where it has one: open issue, open PR, merged.
const ISSUE_ICON: Record<IssueState, React.ComponentType<{ className?: string }>> = {
  active: CircleDot,
  merged: GitMerge,
  pr: GitPullRequestArrow,
  handoff: UserRound,
  blocked: Ban,
  failed: CircleX,
};

function IssueIcon({ state }: { state: IssueState }) {
  const Icon = ISSUE_ICON[state];
  return <Icon className="size-3.5" />;
}

/**
 * An issue outcome's badge. A block that waits only on a person applying a
 * migration reads apart from any other block: the code is done, and clearing
 * it is a different job from triaging a ticket the loop could not finish.
 */
function IssueBadge({ issue }: { issue: IssueHistoryView }) {
  const migration = issue.state === "blocked" && issue.block === "migration";
  return (
    <Badge variant="outline" className={cn("gap-1.5", TONE_TINT[migration ? "info" : toneOf(issue.state)])}>
      {migration ? <Database className="size-3.5" /> : <IssueIcon state={issue.state} />}
      {migration ? "Needs migration" : ISSUE_LABEL[issue.state]}
    </Badge>
  );
}

const PHASES = ["Select + map", "Implement", "Review", "Verify + fix", "Finish"];

/* ------------------------------------------------------------ primitives */

/** A status word with its dot, inline. */
function Toned({ word }: { word: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 capitalize">
      <Dot tone={toneOf(word)} />
      {word}
    </span>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>
);

/** A quiet key/value pair for the facts grid. */
function Fact({
  label,
  children,
  mono = false,
  wrap = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className={cn("mt-0.5 text-sm", wrap ? "break-all" : "truncate", mono && "font-mono text-[13px]")}>
        {children}
      </div>
    </div>
  );
}

/**
 * The loop's stage, and inside an iteration the phase it is in. A loop paused
 * at a phase boundary names the phase it is held before; an iteration that
 * picked an interrupted ticket up from its ledger says so until it moves on.
 */
function StageText({
  stage,
  phase,
  resumedAt = null,
}: {
  stage: DashboardLoop["stage"];
  phase: DashboardLoop["phase"];
  resumedAt?: DashboardLoop["resumedAt"];
}) {
  if (!stage) return <Absent />;
  return (
    <span>
      <span className="capitalize">{stage}</span>
      {phase && (
        <span className="font-mono text-xs text-muted-foreground">
          {" · "}
          {stage === "paused" ? `held before ${phase}` : stage === "iteration" && resumedAt === phase ? `resuming at ${phase}` : phase}
        </span>
      )}
    </span>
  );
}

function Iteration({ entry }: { entry: DashboardLoop["iteration"] }) {
  if (!entry) return <Absent />;
  if (entry.max === null) return <span className="tabular-nums">{entry.index}</span>;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-sm tabular-nums">
        <span>
          {entry.index} <span className="text-muted-foreground">/ {entry.max}</span>
        </span>
        <span className="text-xs text-muted-foreground">{Math.round((entry.index / entry.max) * 100)}%</span>
      </div>
      <Progress value={(entry.index / entry.max) * 100} className="h-1.5" />
    </div>
  );
}

const STOP_ICON: Record<StopKind, React.ComponentType<{ className?: string }>> = {
  completed: CircleCheck,
  blocked: TriangleAlert,
  failed: CircleAlert,
  interrupted: Zap,
};

function StopReason({ reason }: { reason: NonNullable<DashboardLoop["stopReason"]> }) {
  const Icon = STOP_ICON[reason.kind];
  return (
    <Alert variant={reason.kind === "failed" ? "destructive" : "default"} className="bg-transparent">
      <Icon className={cn(reason.kind !== "failed" && TONE_TEXT[toneOf(reason.kind)])} />
      <AlertTitle className="capitalize">{reason.kind}</AlertTitle>
      <AlertDescription>
        <p>{reason.why}</p>
        <p className="text-xs tabular-nums">{new Date(reason.at).toLocaleString()}</p>
      </AlertDescription>
    </Alert>
  );
}

/** The reconciler's retry schedule for an errored loop, shown beside any stop reason. */
function RetryState({ retry }: { retry: NonNullable<DashboardLoop["retry"]> }) {
  const line = retryLine(retry);
  if (line === null) return null;
  return (
    <Alert className="bg-transparent">
      <RotateCcw className={TONE_TEXT.warn} />
      <AlertTitle>Retrying</AlertTitle>
      <AlertDescription>
        <p>attempt {line.attempt} · for {line.cause}</p>
        <p className="text-xs tabular-nums">
          {line.next.kind === "spent"
            ? "retries spent — press Start once the cause is fixed"
            : `next attempt ${new Date(line.next.at).toLocaleString()}`}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function StateProblem({ problem }: { problem: NonNullable<DashboardLoop["stateProblem"]> }) {
  return (
    <Alert className="bg-transparent">
      <CircleSlash className={TONE_TEXT.warn} />
      <AlertTitle>State record {problem}</AlertTitle>
      <AlertDescription>
        Status is derived from live presence only until the loop writes a readable record.
      </AlertDescription>
    </Alert>
  );
}

/* -------------------------------------------------------------- observer */

function WorkflowRail({ phase }: { phase: PresenceView["phase"] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {PHASES.map((label, index) => {
        const number = index + 1;
        const done = number < phase.index;
        const current = number === phase.index;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5",
                done ? TONE_TEXT.good : current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-4 items-center justify-center rounded-full border text-[10px] tabular-nums",
                  done && "border-status-good/50 bg-status-good/15",
                  current && "border-status-info bg-status-info/15 text-status-info",
                  !done && !current && "border-border",
                )}
              >
                {done ? "✓" : number}
              </span>
              {label}
            </span>
            {index < PHASES.length - 1 && <span className="h-px w-4 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}


/* ------------------------------------------------------------------ time */

/** An instant as its age, with the absolute time as the hover title. */
function When({ iso, nowMs }: { iso: string; nowMs: number }) {
  return (
    <span className="tabular-nums" title={new Date(iso).toLocaleString()}>
      {ageOf(iso, nowMs)}
    </span>
  );
}

/* --------------------------------------------------------------- routing */

/**
 * The overview's pages, each one entry in the sidebar. The first is the
 * project's own root. `to` is the page's route id, which the sidebar link is
 * typed against: a page the route tree does not have fails the typecheck.
 */
const PAGES = [
  { id: "agents", title: "Agents", path: "/", to: "/p/$project/", icon: Bot },
  { id: "notifications", title: "Notifications", path: "/notifications", to: "/p/$project/notifications", icon: Bell },
  { id: "usage", title: "Usage", path: "/usage", to: "/p/$project/usage", icon: ChartColumn },
  { id: "backlog", title: "Backlog", path: "/backlog", to: "/p/$project/backlog", icon: ListTodo },
  { id: "ci", title: "CI health", path: "/ci", to: "/p/$project/ci", icon: HeartPulse },
  { id: "learnings", title: "Learnings", path: "/learnings", to: "/p/$project/learnings", icon: Lightbulb },
  { id: "evals", title: "Evals", path: "/evals", to: "/p/$project/evals", icon: FlaskConical },
  { id: "ownership", title: "Ownership", path: "/ownership", to: "/p/$project/ownership", icon: UserRound },
  { id: "reconciliation", title: "Reconciliation", path: "/reconciliation", to: "/p/$project/reconciliation", icon: Wrench },
  { id: "labels", title: "Labels", path: "/labels", to: "/p/$project/labels", icon: Tag },
] as const;

type Page = (typeof PAGES)[number]["id"];

/**
 * The project's settings: what changes the project itself rather than reads
 * it, such as removing it. Not one of PAGES, so it sits at the sidebar's foot,
 * away from the pages an operator reads every day.
 */
const SETTINGS_PAGE = { title: "Settings", path: "/settings", to: "/p/$project/settings", icon: SettingsIcon } as const;

/** What a project tile's menu in the rail offers: every page, then the settings. */
const RAIL_PAGES = [...PAGES, SETTINGS_PAGE];

/**
 * The All projects floor's address. It sits above every project, so it is not
 * one of a project's PAGES: the sidebar draws it over the project switcher.
 */
const FACTORY_PATH = "/factory";

/** The project rail's width: the sidebar's collapsed width, and its whole width on the floor. */
const RAIL_WIDTH = "3.5rem";

/**
 * The committed leaf match's screen, the project it names (router-decoded),
 * and the page path below that project. The committed leaf, not
 * `state.location`: the router moves `location` as soon as a navigation starts
 * but commits the matches the Outlet draws later, so the chrome (project,
 * title, sidebar) read from `location` would run ahead of the page body under
 * it, and the old page would mount under the new project. Before the first
 * commit there are no matches, which reads as the landing.
 */
function useScreen(): { screen: Screen; project: string | null; rest: string } {
  // The match object itself is selected, not a value derived from it: the
  // store hands back the same object until the match changes, so a derived
  // object here would re-render on every router state update.
  const leaf = useRouterState({ select: (state) => state.matches.at(-1) });
  // The match's path is still encoded (`a%20b`), which is what parseLocation decodes.
  const path = useRouterState({ select: committedPath });
  return useMemo(() => {
    const project = (leaf?.params as Record<string, unknown> | undefined)?.project;
    return { screen: screenOf(leaf), project: typeof project === "string" ? project : null, rest: parseLocation(path).rest };
  }, [leaf, path]);
}

/** Navigates in place to a full path, and to the top of the new page. */
function useGo(): (path: string, options?: { replace?: boolean }) => void {
  const router = useRouter();
  return useCallback(
    (path: string, { replace = false }: { replace?: boolean } = {}) => {
      if (replace) router.history.replace(path);
      else router.history.push(path);
      window.scrollTo(0, 0);
    },
    [router],
  );
}

/**
 * Scrolls to the top on a plain click of a router link, as `go` does; a
 * modified click opens a new tab and leaves this page where it is.
 */
function scrollTopOnPlainClick(event: React.MouseEvent): void {
  if (!isPlainClick(event)) return;
  window.scrollTo(0, 0);
}

/** A left click with no modifier: the one a link handles in place rather than leaving to the browser. */
function isPlainClick(event: React.MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

/** An in-app link to a page of the current project: plain anchor semantics, no full reload. */
function Link({
  to,
  href,
  navigate,
  children,
  onPointerEnter,
  onFocus,
  ...props
}: Omit<React.ComponentProps<"a">, "onClick"> & {
  to: string;
  navigate: (path: string) => void;
}) {
  const preloadHref = usePreloadHref();
  // `href` is for an address the current URL cannot scope: a project page
  // linked from the All projects floor, whose URL names no project.
  const target = href ?? page(to);
  return (
    <a
      {...props}
      href={target}
      // Read the page ahead of the click, as a router link does (#739). A
      // wrapper's own handlers run first: the sidebar's tooltip trigger opens
      // on focus through them.
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        preloadHref(target);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        preloadHref(target);
      }}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/* --------------------------------------------------------------- polling */

/**
 * A read as the shared read layer holds it (#603, the Query layer since #738): the poll rules (reschedule only
 * after a read settles, keep data across an error or a refresh) live in
 * query-reads.ts now. `snapshotAt` is the push time a remote snapshot carries
 * (`x-ralph-snapshot-at`); null locally.
 */
type Feed<T> = Read<T>;

/**
 * When the feed was last read, or why it could not be. A project that is not
 * set up shows where its setup stands instead: its reads fail by design until
 * the config lands, which is not an outage.
 *
 * On the remote dashboard "Updated" is when the machine pushed the snapshot,
 * not when the page fetched it, and a snapshot over a minute old says so.
 */
function FeedStamp<T>({ feed, setup = null }: { feed: Feed<T>; setup?: SetupStamp | null }) {
  const stamp = feed.state === "ready" ? snapshotStamp(feed.at, feed.snapshotAt ?? null, Date.now()) : null;
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
      {setup !== null && feed.state !== "ready" ? (
        <>
          <Dot tone="info" />
          <span title={setup.detail}>{setup.label}</span>
        </>
      ) : feed.state === "error" ? (
        <>
          <Dot tone="bad" />
          <span className="text-status-bad">Unavailable: {feed.message}</span>
        </>
      ) : stamp !== null ? (
        <>
          <Dot tone={stamp.stale ? "warn" : "good"} pulse={!stamp.stale} />
          <span className={stamp.stale ? TONE_TEXT.warn : undefined} data-stale={stamp.stale || undefined}>
            Updated {stamp.at.toLocaleTimeString()}
            {stamp.stale && " · stale"}
          </span>
        </>
      ) : (
        <>
          <Dot tone="neutral" />
          <span>Loading…</span>
        </>
      )}
    </div>
  );
}

/**
 * Beside the stamp, only when the page is not hearing changes as they happen:
 * a live stream needs no word, and "Updated" already says how fresh it is.
 */
function LiveNote({ status }: { status: LiveStatus }) {
  if (status !== "fallback") return null;
  return (
    <span
      className="text-xs text-muted-foreground"
      title={`Live updates are off: the page fell back to reading the dashboard every ${POLL_MS / 1000} seconds.`}
    >
      Live updates off · polling
    </span>
  );
}

/**
 * Narrow a feed to a part of its data. A part the data does not have reads as
 * a 404, the way the per-loop endpoint answers a loop the roster does not list.
 */
function feedOf<T, U>(feed: Feed<T>, pick: (data: T) => U | null): Feed<U> {
  if (feed.state === "loading") return feed;
  const data = feed.data === null ? null : pick(feed.data);
  if (feed.state === "ready") {
    return data === null ? { state: "error", message: "HTTP 404", status: 404, data: null } : { ...feed, data };
  }
  return { ...feed, data };
}

/* -------------------------------------------------------------- overview */

function LoopCard({ entry }: { entry: DashboardLoop }) {
  const { ref: gazeRef } = useGaze({ travel: 3, lookAt: "pointer" });
  const panels = ROLE_PANELS[entry.role];
  const currentClaims = entry.claims.filter((claim) => claim.status !== "expired");
  const expiredClaims = entry.claims.filter((claim) => claim.status === "expired");
  // A doctor leads with the case it holds where a coder leads with its ticket
  // (felipearos/ralph#160); `cardLead` owns that choice, since this file is a
  // `.tsx` no test compiles.
  const headline = [cardLead(entry), entry.branch].filter(Boolean);
  // The chat's sheet sits beside the card's link, not in it: a portal's
  // clicks still bubble through the React tree, and would navigate away.
  const [talking, setTalking] = useState(false);
  const talk = talkOnCard(entry);
  const { project } = useProjectPage();

  return (
    <>
    <RouterLink
      to="/p/$project/loops/$name"
      params={{ project, name: entry.loop }}
      onClick={scrollTopOnPlainClick}
      className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div
        className={cn(
          "rounded-xl border border-border bg-card transition-colors group-hover:border-foreground/30",
          !entry.present && "opacity-70",
        )}
      >
        <Card className="relative z-10 gap-5 border-0 bg-transparent py-5 shadow-none">
          <CardHeader className="grid-cols-[auto_1fr_auto] px-5">
            <Blobatar
              name={entry.loop}
              className="row-span-2 size-16 self-center"
              blobatar={{ animate: "always", expression: expressionFor(entry) }}
              blobatarRef={gazeRef}
            />
            <CardTitle className="text-lg tracking-tight">{entry.loop}</CardTitle>
            <CardDescription className="truncate font-mono text-xs">
              {headline.length > 0 ? headline.join(" · ") : <Absent>no issue or branch</Absent>}
            </CardDescription>
            <CardAction className="flex items-center gap-2">
              <RoleBadge role={entry.role} />
              <StatusBadge status={entry.loopStatus} />
            </CardAction>
          </CardHeader>

          <CardContent className="space-y-5 px-5">
            {/* A sentinel or verifier its config switched off says so first (#789): it still runs, and does nothing. */}
            <ConfigOffNote role={entry.role} />
            {!entry.present ? (
              <p className="text-sm text-muted-foreground">
                No checkout is attributed to this loop, so nothing about it is known.
              </p>
            ) : (
              <>
                <div>
                  <div className="mb-1.5">
                    <Label>Iteration</Label>
                  </div>
                  <Iteration entry={entry.iteration} />
                </div>

                {entry.presence && <Reading presence={entry.presence} compact showPhase={panels.phases} />}

                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Fact label="Stage">
                    <StageText stage={entry.stage} phase={panels.phases ? entry.phase : null} resumedAt={entry.resumedAt} />
                  </Fact>
                  <Fact label="Supervisor">
                    <Toned word={entry.supervisor} />
                  </Fact>
                  <Fact label="Worktree">
                    <Toned word={entry.worktreeStatus} />
                  </Fact>
                  <Fact label="Run" mono>
                    {entry.run ? <span title={entry.run}>{entry.run}</span> : <Absent />}
                  </Fact>
                </div>

                {entry.claims.length > 0 && (
                  <div>
                    <div className="mb-1.5">
                      <Label>Claims</Label>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {currentClaims.map((claim) => (
                        <Badge
                          key={claim.issue}
                          variant="outline"
                          className={cn("font-mono", TONE_TINT[claim.status === "active" ? "good" : "warn"])}
                          title={claim.title ?? undefined}
                        >
                          #{claim.issue} {claim.status}
                        </Badge>
                      ))}
                      {expiredClaims.length > 0 && (
                        <Badge
                          variant="outline"
                          className={cn("font-mono", TONE_TINT.neutral)}
                          title={`Expired claims: ${expiredClaims.map((claim) => `#${claim.issue}`).join(", ")}`}
                        >
                          {expiredClaims.length} expired
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {entry.runnerFailure.current && (
                  <RunnerFailure failure={entry.runnerFailure} repoUrl={entry.repoUrl} compact />
                )}
                {entry.stateProblem && <StateProblem problem={entry.stateProblem} />}
                {entry.stopReason && <StopReason reason={entry.stopReason} />}
                {entry.retry && <RetryState retry={entry.retry} />}
                {talk && <TalkButton onClick={() => setTalking(true)} />}
              </>
            )}
          </CardContent>

          {entry.worktree && (
            <CardFooter className="border-t px-5 [.border-t]:pt-4">
              <span className="truncate font-mono text-xs text-muted-foreground" title={entry.worktree}>
                {entry.worktree}
              </span>
            </CardFooter>
          )}
        </Card>
      </div>
    </RouterLink>
    {(talk || talking) && <ChatSheet loop={entry.loop} live={entry.supervisor === "alive"} open={talking} onOpenChange={setTalking} />}
    </>
  );
}

function LoadingCard() {
  return (
    <Card className="gap-5 py-5 shadow-none">
      <CardHeader className="px-5">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-3.5 w-40" />
        <CardAction>
          <Skeleton className="h-6 w-20 rounded-full" />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5 px-5">
        <Skeleton className="h-9 w-full" />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-9" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", value > 0 && TONE_TEXT[tone])}>
        {value}
      </span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

function Summary({ data }: { data: Dashboard }) {
  const { loops } = data;
  const count = (tone: Tone) => loops.filter((entry) => toneOf(entry.loopStatus) === tone).length;
  // Tickets whose code is done and wait on a person: the one kind of stuck an
  // operator can clear from here without triage.
  const migrations = data.frontier?.view ? stuckGroups(data.frontier.view, new Date(data.generatedAt).getTime()).migration.length : 0;
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
      <Stat label="healthy" value={count("good") + count("info")} tone="good" />
      <Stat label="attention" value={count("warn")} tone="warn" />
      <Stat label="failing" value={count("bad")} tone="bad" />
      <Stat label="unknown" value={loops.filter((entry) => entry.loopStatus === "unknown").length} />
      {data.ownership.contested.length > 0 && (
        <Stat label="contested tickets" value={data.ownership.contested.length} tone="bad" />
      )}
      {data.frontier?.view && (
        <Stat
          label="ready tickets"
          value={data.frontier.view.ready.reduce((sum, group) => sum + group.tickets.length, 0)}
          tone="info"
        />
      )}
      {migrations > 0 && <Stat label="need a migration" value={migrations} tone="info" />}
      {/* Only when there are any: UNTRIAGED is empty on a project that
          configures no Jav labels, so a permanent `0 untriaged` would be a
          stat about a feature nobody turned on. `info`, not `warn`: the report
          lists these whether or not routing is ENABLED, and with Jav off a
          coder takes them like any other ticket, so nothing is stuck. */}
      {data.frontier?.view && data.frontier.view.untriaged.length > 0 && (
        <Stat label="untriaged" value={data.frontier.view.untriaged.length} tone="info" />
      )}
    </div>
  );
}

function Reconciliation({ data }: { data: Dashboard }) {
  const rows: { kind: string; path: string; detail?: string }[] = [
    ...data.reconciliation.orphaned.map((path) => ({ kind: "orphaned", path })),
    ...data.reconciliation.prunable.map((path) => ({ kind: "prunable", path })),
    ...unattributedRows(data.unattributed),
  ];
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to reconcile: every checkout and record belongs to a loop.</p>;
  }
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Reconciliation</h2>
        <p className="text-sm text-muted-foreground">
          Checkouts Git still lists that are gone or prunable, and loop records no roster loop owns. They are not
          loops.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32">State</TableHead>
              <TableHead>Path</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.kind + row.path}>
                <TableCell className={TONE_TEXT[toneOf(row.kind)]}>
                  <Toned word={row.kind} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.path}
                  {row.detail && <span className="ml-2 font-sans">({row.detail})</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function AgentCard({ entry, navigate, onSent }: { entry: DashboardLoop; navigate: (path: string) => void; onSent: () => void }) {
  const control = useLoopControl(entry.loop);
  const refreshControl = control.refresh;
  const refresh = useCallback(() => {
    refreshControl();
    onSent();
  }, [refreshControl, onSent]);
  return (
    <Controls entry={entry} status={control.read.state === "ready" ? control.read.data : null} onSent={refresh} contextMenu navigate={navigate}>
      <LoopCard entry={entry} />
    </Controls>
  );
}

/** The dashboard's routing sheet, opened from the top bar. */
function RoutingSheet({ data }: { data: Dashboard | null }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <RouteIcon className="size-3.5" />
          Routing
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Jav: difficulty routing</SheetTitle>
          <SheetDescription>
            Send each difficulty label to the loops that should take it, e.g. hard tickets to the loops on a frontier
            model.
          </SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <JavSettings
            intake={{
              untriaged: data?.frontier?.view?.untriaged.length ?? null,
              triagers: triagers(data?.loops ?? []).map((entry) => entry.loop),
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The verifier's rules sheet, opened from the top bar. Only offered when a loop
 * holds the verifier role (a project without one has nothing to configure),
 * and only locally.
 */
function VerifierSheet({ data }: { data: Dashboard | null }) {
  // The remote dashboard serves no verifier route: the sheet would open on a 404.
  if (isRemote() || !(data?.loops ?? []).some((entry) => entry.role === "verifier")) return null;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <ShieldCheck className="size-3.5" />
          Verifier
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Verifier: rules</SheetTitle>
          <SheetDescription>How the verifier judges a merge in production, and what it may do about one.</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <VerifierSettings />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The sentinel's rules sheet, beside the verifier's: offered only when a loop
 * holds the sentinel role, and only locally.
 */
function SentinelSheet({ data }: { data: Dashboard | null }) {
  // The remote dashboard serves no sentinel rules route: the sheet would open on a 404.
  if (isRemote() || !(data?.loops ?? []).some((entry) => entry.role === "sentinel")) return null;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <Siren className="size-3.5" />
          Sentinel
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Sentinel: rules</SheetTitle>
          <SheetDescription>Which production errors the sentinel turns into tickets, and how many a day.</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <SentinelSettings />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function UsagePage({ repoUrls, navigate }: { repoUrls: Record<string, string | null>; navigate: (path: string) => void }) {
  const usage = useUsage().read;
  if (usage.state === "loading") return <Skeleton className="h-64" />;
  // A failed refresh keeps showing the last report it read.
  const report = usage.data;
  if (report !== null) return <UsageOverview report={report} repoUrls={repoUrls} navigate={navigate} />;
  if (usage.state !== "error") return null;
  return (
    <Alert variant="destructive" className="bg-transparent">
      <CircleAlert />
      <AlertTitle>Usage could not be read</AlertTitle>
      <AlertDescription>
        <p>{usage.message}</p>
      </AlertDescription>
    </Alert>
  );
}

/** One overview page, reading the dashboard feed the app polls for the sidebar too. */
function Overview({
  page,
  feed,
  setup,
  refresh,
  refreshSetup,
  navigate,
}: {
  page: Page;
  feed: Feed<Dashboard>;
  /** The project's setup status; a project that is not ready shows setup in place of agents. */
  setup: Feed<ProjectSetupView>;
  refresh: () => void;
  refreshSetup: () => void;
  navigate: (path: string) => void;
}) {
  const data = feed.state === "loading" ? null : feed.data;
  const repoUrls = Object.fromEntries((data?.loops ?? []).map((entry) => [entry.loop, entry.repoUrl]));

  switch (page) {
    case "agents":
      if (setup.state === "ready" && setup.data.status !== "ready") {
        return <SetupPanel setup={setup.data} onSubmitted={refreshSetup} />;
      }
      return (
        <>
          <AgentsAdmin onChanged={refresh} />
          <ModelUpdatesPanel />
          {data && <Summary data={data} />}
          {data && <TriagePanel data={data} repoUrls={repoUrls} />}
          {data && <FollowingPanel data={data} repoUrls={repoUrls} />}
          <SentinelPanel repoUrls={repoUrls} />
          <Separator />
          <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3" aria-live="polite">
            {data
              ? data.loops.map((entry) => <AgentCard key={entry.loop} entry={entry} navigate={navigate} onSent={refresh} />)
              : [0, 1, 2].map((index) => <LoadingCard key={index} />)}
          </div>
        </>
      );
    case "notifications":
      return <NotificationsOverview repoUrls={repoUrls} navigate={navigate} />;
    case "usage":
      return <UsagePage repoUrls={repoUrls} navigate={navigate} />;
    case "backlog":
      return data ? (
        <Backlog frontier={data.frontier} repoUrls={repoUrls} nowMs={new Date(data.generatedAt).getTime()} loops={data.loops} />
      ) : (
        <Skeleton className="h-64" />
      );
    case "ci":
      return data ? <CiHealthPage data={data} repoUrls={repoUrls} /> : <Skeleton className="h-64" />;
    case "learnings":
      return data ? <LearningsPanel data={data} /> : <Skeleton className="h-64" />;
    case "evals":
      return <EvalsPage />;
    case "ownership":
      return data ? <Ownership ownership={data.ownership} repoUrls={repoUrls} /> : <Skeleton className="h-64" />;
    case "reconciliation":
      return data ? <Reconciliation data={data} /> : <Skeleton className="h-64" />;
    case "labels":
      return <LabelsPage />;
  }
}

/* ---------------------------------------------------------------- detail */

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-4 py-5 shadow-none", className)}>
      <CardHeader className="px-5">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}

function RawRecord({ value, className }: { value: unknown; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Card className={cn("gap-4 py-5 shadow-none", className)}>
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Raw record</CardTitle>
        <CardAction className="flex gap-1.5">
          <Button variant="ghost" size="xs" onClick={copy} aria-label="Copy raw record">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
            {expanded ? "Collapse" : "Expand"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-5">
        <div className="relative">
          <pre
            className={cn(
              "overflow-x-auto rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-muted-foreground",
              !expanded && "max-h-40 overflow-y-hidden",
            )}
          >
            {text}
          </pre>
          {!expanded && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setExpanded(true)}
              className="absolute inset-x-px bottom-px flex h-14 items-end justify-center rounded-md border-0 bg-gradient-to-t from-card to-transparent px-0 pb-2 font-normal tracking-normal text-muted-foreground normal-case hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
            >
              Show full record
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The control view's status word and the commands the loop recorded, newest first. */
function ControlRecord({ status, nowMs }: { status: ControlView | null; nowMs: number }) {
  if (status === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Toned word={status.status} />
        <span className="text-xs text-muted-foreground">channel {status.channel.state}</span>
      </div>
      {status.blocked && (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs break-words text-muted-foreground">
          Blocked ({status.blocked.source}): {status.blocked.reason}
        </p>
      )}
      {status.commands.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commands recorded for this run.</p>
      ) : (
        <ul className="divide-y">
          {status.commands.map((command) => (
            <li key={command.key} className="space-y-0.5 py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-3 text-sm">
                <span className="font-mono text-xs">{command.command}</span>
                <span className={cn("text-xs", TONE_TEXT[OUTCOME_TONE[command.outcome]])}>{command.outcome}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  <When iso={command.at} nowMs={nowMs} />
                </span>
              </div>
              {command.why && <p className="truncate text-xs text-muted-foreground">{command.why}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoopDetail({
  name,
  dashboard,
  onSent,
  navigate,
}: {
  name: string;
  dashboard: Feed<Dashboard>;
  onSent: () => void;
  navigate: (path: string) => void;
}) {
  // A control action re-reads both feeds right away.
  const loopControl = useLoopControl(name);
  const refreshControl = loopControl.refresh;
  const refresh = useCallback(() => {
    refreshControl();
    onSent();
  }, [refreshControl, onSent]);
  // The loop's panel is its row of the dashboard feed the app already polls.
  const feed = feedOf(dashboard, (data) => data.loops.find((entry) => entry.loop === name) ?? null);
  const control = loopControl.read;
  const entry = feed.state === "loading" ? null : feed.data;
  // One read of the role's rules for the whole page, as `LoopCard` does.
  const panels = entry === null ? null : ROLE_PANELS[entry.role];
  const controlStatus = control.state === "loading" ? null : control.data;
  const nowMs = feed.state === "ready" ? feed.at.getTime() : Date.now();
  const usage = useUsage().read;
  const usageData = usage.state === "loading" ? null : usage.data;

  useEffect(() => {
    document.title = `${name} · Ralph dashboard`;
    return () => {
      document.title = "Ralph dashboard";
    };
  }, [name]);

  const back = (
    <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" asChild>
      <Link to="/" navigate={navigate}>
        <ArrowLeft />
        All loops
      </Link>
    </Button>
  );

  if (feed.state === "error" && feed.status === 404) {
    return (
      <>
        {back}
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>No loop named “{name}”</AlertTitle>
          <AlertDescription>The roster does not list it. Check the overview for the loops that exist.</AlertDescription>
        </Alert>
      </>
    );
  }

  return (
    <>
      {!entry ? (
        <div className="space-y-6">
          <Skeleton className="h-9 w-40" />
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-48" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <header>
            <LoopHeader entry={entry} status={controlStatus} onSent={refresh} />
          </header>

          {/* Create checkout lives in this alert, not in the Worktree section
              below, because every section under it is gated on `present`. */}
          {!entry.present && (
            <Alert className="bg-transparent">
              <CircleSlash className={TONE_TEXT.neutral} />
              <AlertTitle>No checkout is attributed to this loop</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  It is on the roster, but no registered worktree carries its record or name. Nothing about it is
                  known.
                </p>
                <CreateAgentCheckout loop={entry.loop} onCreated={refresh} />
              </AlertDescription>
            </Alert>
          )}
          {entry.stateProblem && <StateProblem problem={entry.stateProblem} />}
          {entry.stopReason && <StopReason reason={entry.stopReason} />}
          {entry.retry && <RetryState retry={entry.retry} />}
          {entry.runnerFailure.state === "failed" && (
            <RunnerFailure failure={entry.runnerFailure} repoUrl={entry.repoUrl} />
          )}

          {entry.present && !entry.presence && (
            <Alert className="bg-transparent">
              <CircleSlash className={TONE_TEXT.warn} />
              <AlertTitle>Agents unknown</AlertTitle>
              <AlertDescription>
                {entry.presenceProblem === "unattributed"
                  ? "The observer read this worktree but did not attribute it to this loop, so its agents are not shown."
                  : "The observer could not read this worktree, so only the durable record is shown."}
              </AlertDescription>
            </Alert>
          )}

          {entry.present && <PluginDoctor loop={entry.loop} />}

          {entry.present && entry.presence && (
            <Card className="gap-4 py-5 shadow-none">
              <CardContent className="space-y-4 px-5">
                <Reading presence={entry.presence} showPhase={panels!.phases} />
                {panels!.phases && <WorkflowRail phase={entry.presence.phase} />}
              </CardContent>
            </Card>
          )}

          {entry.present && <LiveOutput loop={entry.loop} />}

          {entry.present && entry.presence && (
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
              <Section title="Issues" className="md:col-span-2">
                {entry.presence.issues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No issue history yet.</p>
                ) : (
                  <div className="-mx-5 overflow-x-auto border-t">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="pl-5">Issue</TableHead>
                          <TableHead>State</TableHead>
                          {panels!.pr && <TableHead>PR</TableHead>}
                          <TableHead className="w-full">Title</TableHead>
                          <TableHead className="pr-5 text-right">When</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {entry.presence.issues.map((issue) => (
                          <TableRow key={issue.issue} className={cn(issue.state === "active" && "bg-muted/20")}>
                            <TableCell className="pl-5 font-mono text-xs">
                              <IssueLink repoUrl={entry.repoUrl} issue={issue.issue} />
                            </TableCell>
                            <TableCell>
                              <IssueBadge issue={issue} />
                            </TableCell>
                            {panels!.pr && (
                              <TableCell className="font-mono text-xs whitespace-nowrap">
                                {issue.pr !== null ? (
                                  <>
                                    <RepoLink repoUrl={entry.repoUrl} path={`pull/${issue.pr}`}>
                                      #{issue.pr}
                                    </RepoLink>
                                    {issue.draft && <span className="ml-1.5 text-muted-foreground">draft</span>}
                                  </>
                                ) : (
                                  <Absent />
                                )}
                              </TableCell>
                            )}
                            <TableCell className="max-w-0 truncate" title={issue.title ?? undefined}>
                              {issue.state === "active" ? (
                                <span className="text-muted-foreground">
                                  {issue.title ??
                                    (panels!.phases ? (
                                      `phase ${entry.presence!.phase.index}: ${entry.presence!.phase.label}`
                                    ) : (
                                      <Absent>active</Absent>
                                    ))}
                                </span>
                              ) : (
                                <>
                                  {issue.title ?? <Absent>recorded outcome</Absent>}
                                  {issue.detail && (
                                    <span className="ml-2 font-mono text-xs text-muted-foreground">{issue.detail}</span>
                                  )}
                                </>
                              )}
                            </TableCell>
                            <TableCell className="pr-5 text-right text-xs whitespace-nowrap text-muted-foreground">
                              <When iso={issue.at} nowMs={nowMs} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Section>

              <Section title="Agents" className="md:col-span-2">
                {entry.actors.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No stage activity yet.</p>
                ) : (
                  <ul className="divide-y">
                    {entry.actors.map((item) => (
                      <li key={item.stage + (item.invocation ?? "")} className="space-y-1 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                          <span className="font-mono text-xs text-status-info">{item.stage}</span>
                          <span className={cn("inline-flex items-center gap-1.5 capitalize", TONE_TEXT[toneOf(item.state)])}>
                            <Dot tone={toneOf(item.state)} pulse={item.state === "running"} />
                            {item.state === "unknown" ? "untracked" : item.state}
                          </span>
                          {(item.runner || item.model) && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {[item.runner, item.model].filter(Boolean).join(" · ")}
                            </span>
                          )}
                          {(item.activityAt ?? item.startedAt) && (
                            <span className="ml-auto text-xs text-muted-foreground">
                              <When iso={(item.activityAt ?? item.startedAt)!} nowMs={nowMs} />
                            </span>
                          )}
                        </div>
                        <p className="line-clamp-2 text-sm break-words text-muted-foreground">
                          <LabelText text={item.lastAction ?? "waiting for activity"} />
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Recent activity" className="md:col-span-2">
                <ActivityFeed
                  recent={entry.presence.recent}
                  live={entry.presence.status === "running" && entry.presence.supervisor === "alive"}
                />
              </Section>
            </div>
          )}

          {entry.present && !entry.presence && entry.timeline !== null && (
            <Section title="Recent timeline">
              {/* The run's timeline arrives newest first; the feed reads oldest first. */}
              <ActivityFeed recent={[...entry.timeline].reverse()} live={false} />
            </Section>
          )}

          {entry.present && (
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
              <Section title="Claims">
                <ClaimsList claims={entry.claims} repoUrl={entry.repoUrl} />
              </Section>
              <Section title="Tokens">
                <TokenUsage usage={entry.usage} />
              </Section>
              <Section title="Journal">
                <JournalList journal={entry.journal} repoUrl={entry.repoUrl} />
              </Section>
              <Section title="Control record">
                <ControlRecord status={controlStatus} nowMs={nowMs} />
              </Section>
            </div>
          )}

          {entry.present && (
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
              <NotificationsPanel loop={entry.loop} repoUrl={entry.repoUrl} />
              <AuditHistory loop={entry.loop} />
            </div>
          )}

          {entry.present && usageData && <LoopUsage report={usageData} loop={entry.loop} repoUrl={entry.repoUrl} />}

          {entry.present && (
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
              <Section title="Progress">
                <div className="space-y-5">
                  <div>
                    <div className="mb-1.5">
                      <Label>Iteration</Label>
                    </div>
                    <Iteration entry={entry.iteration} />
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Fact label="Stage">
                      <StageText stage={entry.stage} phase={entry.phase} resumedAt={entry.resumedAt} />
                    </Fact>
                    <Fact label="Heartbeat">
                      {entry.heartbeat ? <When iso={entry.heartbeat} nowMs={nowMs} /> : <Absent />}
                    </Fact>
                    <Fact label="Last event" mono>
                      {entry.lastEvent ? entry.lastEvent.name : <Absent />}
                    </Fact>
                    <Fact label="Event at">
                      {entry.lastEvent ? <When iso={entry.lastEvent.at} nowMs={nowMs} /> : <Absent />}
                    </Fact>
                    <Fact label="Runner failure">
                      {entry.runnerFailure.state === "failed" ? (
                        entry.runnerFailure.current ? (
                          <span className={TONE_TEXT.bad}>{entry.runnerFailure.reason?.kind ?? "failed"}</span>
                        ) : (
                          <span className="text-muted-foreground">
                            {entry.runnerFailure.reason?.kind ?? "failed"}, recovered
                          </span>
                        )
                      ) : entry.runnerFailure.state === "none" ? (
                        "none recorded"
                      ) : (
                        <Absent>unknown</Absent>
                      )}
                    </Fact>
                  </div>
                  {entry.lastEvent?.detail && (
                    <p className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs break-words text-muted-foreground">
                      {entry.lastEvent.detail}
                    </p>
                  )}
                </div>
              </Section>

              {entry.worktree !== null && (
                <Section title="Worktree">
                  <div className="space-y-4">
                    <RerunAgentSetup loop={entry.loop} live={entry.supervisor !== "dead"} onDone={refresh} />
                    <DeleteAgentWorktree loop={entry.loop} live={entry.supervisor !== "dead"} onDeleted={refresh} />
                  </div>
                </Section>
              )}

              <Section title="Identity">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Fact label="Run" mono wrap>
                    {entry.run ?? <Absent />}
                  </Fact>
                  <Fact label="Issue" mono>
                    {entry.issue !== null ? `#${entry.issue}` : <Absent />}
                  </Fact>
                  <Fact label="Branch" mono wrap>
                    {entry.branch ?? <Absent />}
                  </Fact>
                  <Fact label="Supervisor">
                    <Toned word={entry.supervisor} />
                  </Fact>
                  <Fact label="Worktree status">
                    <Toned word={entry.worktreeStatus} />
                  </Fact>
                  <Fact label="State record">
                    {entry.stateProblem ? <Toned word={entry.stateProblem} /> : <Toned word="live" />}
                  </Fact>
                  <div className="col-span-2">
                    <Fact label="Worktree path" mono wrap>
                      {entry.worktree ?? <Absent />}
                    </Fact>
                  </div>
                </div>
              </Section>

              <Section title="Live presence">
                {entry.presence ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Fact label="Status">
                      <Toned word={entry.presence.status} />
                    </Fact>
                    <Fact label="Supervisor">
                      <Toned word={entry.presence.supervisor} />
                    </Fact>
                    <Fact label="Run" mono wrap>
                      {entry.presence.run ?? <Absent />}
                    </Fact>
                    <Fact label="Iteration">
                      {entry.presence.iteration ? (
                        <span className="tabular-nums">
                          {entry.presence.iteration.index}
                          {entry.presence.iteration.max !== null && (
                            <span className="text-muted-foreground"> / {entry.presence.iteration.max}</span>
                          )}
                        </span>
                      ) : (
                        <Absent />
                      )}
                    </Fact>
                    <Fact label="Issue" mono>
                      {entry.presence.issue !== null ? `#${entry.presence.issue}` : <Absent />}
                    </Fact>
                    <Fact label="Observed">
                      <When iso={entry.presence.observedAt} nowMs={nowMs} />
                    </Fact>
                    <div className="col-span-2">
                      <Fact label="Branch" mono wrap>
                        {entry.presence.branch ?? <Absent />}
                      </Fact>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The observer returned nothing for this worktree, so only the durable record is shown.
                  </p>
                )}
              </Section>

              <RawRecord value={entry} className="md:col-span-2" />
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- app */

/** A sidebar link: navigates in place and closes the mobile sheet. */
function NavLink({
  to,
  navigate,
  children,
  ...props
}: React.ComponentProps<"a"> & { to: string; navigate: (path: string) => void }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Link
      {...props}
      to={to}
      navigate={(path) => {
        navigate(path);
        if (isMobile) setOpenMobile(false);
      }}
    >
      {children}
    </Link>
  );
}

/**
 * A sidebar page link, typed against the route tree: a router link that
 * closes the mobile sheet like NavLink. Agents' `/p/$project/` keeps the
 * address the hand-written link wrote, trailing slash included.
 */
function PageNavLink({
  to,
  project,
  children,
  ...props
}: Omit<React.ComponentProps<"a">, "href" | "onClick"> & {
  to: (typeof PAGES)[number]["to"] | typeof SETTINGS_PAGE.to;
  project: string;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <RouterLink
      {...props}
      to={to}
      params={{ project }}
      // Exact: the router's default is a prefix match, and every page of the
      // project sits under `/p/$project`, so the Agents link would claim to be
      // the current page everywhere (aria-current) beside the real one.
      activeOptions={{ exact: true }}
      onClick={(event) => {
        scrollTopOnPlainClick(event);
        if (isMobile) setOpenMobile(false);
      }}
    >
      {children}
    </RouterLink>
  );
}

/**
 * A loop in the sidebar: a link to its page, and on right-click the same
 * actions menu its card has on the Agents page. The control read is the
 * card's own, shared through the Query layer, so the sidebar adds no poll.
 */
function SidebarLoop({
  entry,
  project,
  active,
  navigate,
  onSent,
}: {
  entry: DashboardLoop;
  project: string;
  active: boolean;
  navigate: (path: string) => void;
  onSent: () => void;
}) {
  const control = useLoopControl(entry.loop);
  const refreshControl = control.refresh;
  const refresh = useCallback(() => {
    refreshControl();
    onSent();
  }, [refreshControl, onSent]);
  // The one state the sidebar animates: a live loop held for an approval wants you.
  const hold = control.read.state === "ready" ? control.read.data.hold : null;
  const awaiting = entry.supervisor === "alive" && hold?.kind === "approval";
  return (
    <SidebarMenuItem>
      <Controls entry={entry} status={control.read.state === "ready" ? control.read.data : null} onSent={refresh} contextMenu navigate={navigate}>
        <SidebarMenuButton
          asChild
          isActive={active}
          tooltip={[entry.loop, loopWorkTooltip(entry), entry.loopStatus].filter(Boolean).join(" · ")}
        >
          <NavLink
            to={`/loops/${encodeURIComponent(entry.loop)}`}
            href={pagePath(project, `/loops/${encodeURIComponent(entry.loop)}`)}
            navigate={navigate}
          >
            {/* The same face the loop's card wears, still here: the sidebar's only motion is the dot of a loop that wants you. */}
            <span className="relative size-6 shrink-0">
              <Blobatar name={entry.loop} className="size-6" blobatar={{ expression: expressionFor(entry, control.read.state === "ready" ? control.read.data : null) }} />
              <span className="absolute -right-0.5 -bottom-0.5 flex origin-bottom-right scale-75 rounded-full bg-sidebar p-[2px]">
                <Dot tone={awaiting ? "warn" : toneOf(entry.loopStatus)} pulse={awaiting} />
              </span>
            </span>
            <span className="shrink-0">{entry.loop}</span>
            {loopWorkLabel(entry) && (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {loopWorkLabel(entry)}
              </span>
            )}
          </NavLink>
        </SidebarMenuButton>
        <SidebarMenuBadge className="font-normal text-muted-foreground">{entry.loopStatus}</SidebarMenuBadge>
      </Controls>
    </SidebarMenuItem>
  );
}

function AppSidebar({
  screen,
  feed,
  navigate,
  project,
  projects,
  health,
  setup,
  rest,
  go,
  onSent,
}: {
  screen: Screen;
  feed: Feed<Dashboard>;
  /** Refreshes the feed after a loop action from the sidebar. */
  onSent: () => void;
  navigate: (path: string) => void;
  project: string;
  projects: readonly ProjectView[] | null;
  health: readonly ProjectHealthView[] | null;
  /** Where the project's setup stands; null when it is ready or not known. */
  setup: SetupStamp | null;
  rest: string;
  go: (path: string) => void;
}) {
  const data = feed.state === "loading" ? null : feed.data;
  const badges: Partial<Record<Page, number>> = data
    ? {
        agents: data.loops.length,
        ownership: data.ownership.contested.length || undefined,
        reconciliation:
          data.reconciliation.orphaned.length +
            data.reconciliation.prunable.length +
            unattributedRows(data.unattributed).length || undefined,
      }
    : {};
  const onFloor = screen.page === "factory";
  const rail = railView({ projects, selected: project, rest, health, selectedLoops: data?.loops ?? null, onFloor });
  const path = projects?.find((entry) => entry.id === project)?.path ?? null;
  // shadcn's nested-sidebar layout: the project rail is a fixed column, the
  // project's own pages sit beside it, and collapsing the sidebar leaves the rail.
  return (
    <Sidebar collapsible="icon" className="overflow-hidden">
      <div className="flex size-full">
        <div className="w-(--sidebar-width-icon) shrink-0 border-r border-sidebar-border group-data-[collapsible=icon]:border-r-0">
          <ProjectRail view={rail} onFloor={onFloor} floorPath={FACTORY_PATH} go={go} pages={RAIL_PAGES} />
        </div>
        {/* On the floor no project is open, so the project's pages and loops step aside and the rail stands alone. */}
        <div className={cn("flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden", onFloor && "hidden")}>
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild size="lg">
                  <NavLink to="/" href={pagePath(project, "/")} navigate={navigate}>
                    <div className="grid min-w-0 flex-1 text-left leading-tight">
                      <span className="truncate font-semibold">{project}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{path ?? "Ralph · project"}</span>
                    </div>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Dashboard</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {PAGES.map((page) => (
                    <SidebarMenuItem key={page.id}>
                      <SidebarMenuButton asChild isActive={screen.page === page.id} tooltip={page.title}>
                        <PageNavLink to={page.to} project={project}>
                          <page.icon />
                          <span>{page.title}</span>
                        </PageNavLink>
                      </SidebarMenuButton>
                      {badges[page.id] !== undefined && <SidebarMenuBadge>{badges[page.id]}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Loops</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {data
                    ? data.loops.map((entry) => (
                        <SidebarLoop
                          key={entry.loop}
                          entry={entry}
                          project={project}
                          active={screen.page === "loop" && screen.name === entry.loop}
                          navigate={navigate}
                          onSent={onSent}
                        />
                      ))
                    : setup !== null
                      ? (
                          <SidebarMenuItem>
                            <p className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                              {setup.label}. {setup.detail}
                            </p>
                          </SidebarMenuItem>
                        )
                      : [0, 1, 2].map((index) => (
                        <SidebarMenuItem key={index}>
                          <SidebarMenuSkeleton showIcon />
                        </SidebarMenuItem>
                      ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={screen.page === "settings"} tooltip={SETTINGS_PAGE.title}>
                  <PageNavLink to={SETTINGS_PAGE.to} project={project}>
                    <SETTINGS_PAGE.icon />
                    <span>{SETTINGS_PAGE.title}</span>
                  </PageNavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </div>
      </div>
      <SidebarRail />
    </Sidebar>
  );
}

/** The PR the loop opened for its current issue, from its issue history; null before one exists. */
function currentPr(entry: DashboardLoop): number | null {
  if (entry.issue === null) return null;
  return entry.presence?.issues.find((issue) => issue.issue === entry.issue)?.pr ?? null;
}

/** What the sidebar shows beside a loop's name: its issue, and its PR once opened. */
function loopWorkLabel(entry: DashboardLoop): string | null {
  if (entry.issue === null) return null;
  const pr = currentPr(entry);
  return pr === null ? `#${entry.issue}` : `#${entry.issue} · PR #${pr}`;
}

function loopWorkTooltip(entry: DashboardLoop): string | null {
  const label = loopWorkLabel(entry);
  if (label === null) return null;
  return entry.issueTitle ? `${label} ${entry.issueTitle}` : label;
}

/** The header's title for a screen the project chrome draws (never the landing or intake, which draw no chrome). */
function titleOf(screen: Screen): string {
  if (screen.page === "loop") return screen.name;
  if (screen.page === "states") return "States";
  if (screen.page === "factory") return "All projects";
  if (screen.page === "settings") return SETTINGS_PAGE.title;
  return PAGES.find((page) => page.id === screen.page)?.title ?? "Agents";
}

const LAST_PROJECT_KEY = "ralph.dashboard.lastProject";

/** The project used last, remembered in this browser; storage may be unavailable. */
function rememberedProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function rememberProject(project: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, project);
  } catch {
    // Not remembered: `/` opens the first project instead.
  }
}

/**
 * The root route's component, a gate that calls no read hook: the intake
 * surface and the open intake deployment must not fire a single dashboard read
 * (felipearos/ralph#459), so which of the three it is gets decided here,
 * before any component that reads mounts.
 */
export function App() {
  const { screen, project } = useScreen();
  // The intake page stands alone: no chrome, no project reads, and it records
  // no screen project, since nothing of the dashboard's acts under it.
  if (screen.page === "intake") return <Outlet />;
  // The open intake deployment serves intake and nothing else; every other address is not found there.
  if (isIntakeSurface()) return <IntakeNotFound project={project} />;
  return <DashboardApp />;
}

/** The loop dashboard: the landing, the All projects floor, or a project's chrome around its page. */
function DashboardApp() {
  const { screen, project, rest } = useScreen();
  const go = useGo();
  // Recorded in the render body, before any child renders: children's reads
  // and the handlers on screen run after this render, so they act on the
  // project shown, not one the address bar has already moved to. The floor's
  // address names no project, so it records null and its reads stay unscoped.
  setScreenProject(project);
  const projects = useProjects().read;
  const list = projects.state === "loading" ? null : (projects.data?.projects ?? null);
  // The landing draws its own body (LandingPage): no chrome, no project reads.
  if (screen.page === "landing") return <Outlet />;
  // The floor keeps the sidebar of the project used last, so the way back into a project is one click.
  const chrome = screen.page === "factory" ? (list !== null ? landingProject(list, rememberedProject()) : null) : project;
  if (chrome === null) return <NoProjectYet projects={projects} go={go} />;
  // Keyed by project: switching remounts every page, so nothing on screen
  // belongs to the project that was shown before. One element for the floor
  // and a project's pages, so moving between the floor and the project whose
  // sidebar it keeps does not remount the chrome.
  return <ProjectApp key={chrome} project={chrome} screen={screen} rest={rest} projects={list} go={go} />;
}

/**
 * `/` and an unscoped old bookmark (`/usage`): opens the project used last,
 * else the first, keeping the page (`/usage` lands on `/p/<last>/usage`).
 */
export function LandingPage(): React.ReactNode {
  const { rest } = useScreen();
  const go = useGo();
  const projects = useProjects().read;
  const list = projects.state === "loading" ? null : (projects.data?.projects ?? null);
  useEffect(() => {
    if (list === null) return;
    const landing = landingProject(list, rememberedProject());
    if (landing !== null) go(pagePath(landing, rest), { replace: true });
  }, [rest, list, go]);
  return <NoProjectYet projects={projects} go={go} />;
}

/** While there is no project to open: none registered yet, the list unreadable, or still loading. */
function NoProjectYet({
  projects,
  go,
}: {
  projects: ReturnType<typeof useProjects>["read"];
  go: (path: string, options?: { replace?: boolean }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const addLock = useCommandAvailability("/api/projects");
  const list = projects.state === "loading" ? null : (projects.data?.projects ?? null);
  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 px-6">
      {list !== null && list.length === 0 ? (
        <>
          <Alert>
            <AlertTitle>No project is registered</AlertTitle>
            <AlertDescription>
              Add one from a local checkout or from GitHub, or start the dashboard from a project checkout.
            </AlertDescription>
          </Alert>
          <Button disabled={addLock.disabled} onClick={() => setAdding(true)}>
            Add project
          </Button>
          <LocalOnlyNote route="/api/projects" className="text-center" />
          <AddProjectDialog
            open={adding}
            onOpenChange={setAdding}
            onAdded={(result) => {
              setAdding(false);
              go(pagePath(result.project.id, "/"));
            }}
          />
        </>
      ) : projects.state === "error" && list === null ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load the projects</AlertTitle>
          <AlertDescription>{projects.message}</AlertDescription>
        </Alert>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </div>
  );
}

function ProjectApp({
  project,
  screen,
  rest,
  projects,
  go,
}: {
  project: string;
  screen: Screen;
  /** The page path below the project, which the rail keeps when switching project. */
  rest: string;
  projects: readonly ProjectView[] | null;
  go: (path: string, options?: { replace?: boolean }) => void;
}) {
  useEffect(() => rememberProject(project), [project]);
  const navigate = useCallback((to: string) => go(pagePath(project, to)), [go, project]);
  // One poll of the dashboard feeds the sidebar, the overview pages and the loop page.
  // The store's `refresh` is stable per project, so it can be passed down as before.
  const { read: feed, refresh } = useDashboard(project);
  // Changes pushed by the server refresh that same read at once (#724), and
  // the controls, notifications, history, agents and other projects' health
  // reads (#729); the roster names the per-loop keys. A failed poll keeps its
  // last data, so the per-loop reads stay live through one.
  const roster = feed.state === "loading" ? null : feed.data;
  const liveStatus = useLiveStream(project, roster === null ? [] : roster.loops.map((loop) => loop.loop));
  // Every view below names tickets the way this project's tracker does.
  if (feed.state === "ready") setTrackerLinks(feed.data.tracker);
  const { read: setup, refresh: refreshSetup } = useProjectSetup(project);
  const stamp = setupStamp(setup.state === "loading" ? null : setup.data);
  // Every other project, read locally for the switcher. The server reads each
  // at most every 30 seconds however often this asks; while the stream is
  // live it is refreshed when another project's hub reports a change (`_/health`).
  const others = useProjectsHealth(project).read;
  const health = others.state === "loading" ? null : (others.data?.projects ?? null);
  // Remote only: whether the machine is there, for the banner and the control lock.
  const bridge = useBridgeStatus(project).read;
  const bridgeStatus = bridge.state === "loading" ? null : bridge.data;
  const page: ProjectPage = { project, feed, setup, refresh, refreshSetup, navigate, projects };

  return (
    <BridgeContext.Provider value={bridgeStatus}>
      {/* Wide enough for the project rail beside the pages; collapsed, and on the floor, only the rail shows. */}
      <SidebarProvider
        style={
          {
            "--sidebar-width": screen.page === "factory" ? RAIL_WIDTH : "19.5rem",
            "--sidebar-width-icon": RAIL_WIDTH,
          } as React.CSSProperties
        }
      >
        <AppSidebar
          screen={screen}
          feed={feed}
          navigate={navigate}
          project={project}
          projects={projects}
          health={health}
          setup={stamp}
          rest={rest}
          go={go}
          onSent={refresh}
        />
        <SidebarInset>
          <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
            {/* The floor's sidebar is the rail alone, which collapsing would not change. */}
            {screen.page !== "factory" && (
              <>
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
              </>
            )}
            <h1 className="truncate text-sm font-medium">{titleOf(screen)}</h1>
            {/* The stamp and routing are one project's; the floor reads every project and says so itself. */}
            {screen.page !== "factory" && (
              <div className="ml-auto flex items-center gap-3">
                <div className="hidden items-center gap-2 sm:flex">
                  <FeedStamp feed={feed} setup={stamp} />
                  <LiveNote status={liveStatus} />
                </div>
                {/* Project-wide, like the sheets beside it: it pauses every agent of the project. */}
                <ProjectSleepToggle project={project} />
                <VerifierSheet data={feed.state === "loading" ? null : feed.data} />
                <SentinelSheet data={feed.state === "loading" ? null : feed.data} />
                <RoutingSheet data={feed.state === "loading" ? null : feed.data} />
              </div>
            )}
          </header>
          {/* Shown on every page of the project, the floor included: a sleeping project explains its idle agents. */}
          <ProjectSleepBanner project={project} />
          {isRemote() && (
            <BridgeBanner
              status={bridgeStatus}
              error={bridge.state === "error" ? bridge.message : null}
              snapshotAt={feed.state === "ready" ? (feed.snapshotAt ?? null) : null}
            />
          )}
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-8 sm:px-8">
            {/* The page body is the matched route's (router.tsx); it reads what it needs from this context. */}
            <ProjectPageContext.Provider value={page}>
              <Outlet />
            </ProjectPageContext.Provider>

            <footer className="mt-auto pt-4 text-xs text-muted-foreground">
              Refreshes every {POLL_MS / 1000} seconds. Loop controls leave a command in the loop's inbox, applied at
              its next iteration boundary; the outcome shown is what the loop recorded.
            </footer>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </BridgeContext.Provider>
  );
}

/* ----------------------------------------------------------------- pages */

/** What a page body needs from the project chrome around it. */
interface ProjectPage {
  project: string;
  feed: Feed<Dashboard>;
  setup: Feed<ProjectSetupView>;
  refresh: () => void;
  refreshSetup: () => void;
  navigate: (path: string) => void;
  projects: readonly ProjectView[] | null;
}

const ProjectPageContext = createContext<ProjectPage | null>(null);

function useProjectPage(): ProjectPage {
  const page = useContext(ProjectPageContext);
  // Only ProjectApp renders an Outlet, so a page outside it is a wiring bug.
  if (page === null) throw new Error("a dashboard page rendered outside ProjectApp");
  return page;
}

/** `/p/$project/`: the project's agents. */
export function AgentsPage(): React.ReactNode {
  return <ProjectOverview page="agents" />;
}

/** One overview page under its own route, from what the project chrome polls. */
function ProjectOverview({ page }: { page: Page }): React.ReactNode {
  const { feed, setup, refresh, refreshSetup, navigate } = useProjectPage();
  return <Overview page={page} feed={feed} setup={setup} refresh={refresh} refreshSetup={refreshSetup} navigate={navigate} />;
}

/** `/p/$project/notifications` */
export function NotificationsOverviewPage(): React.ReactNode {
  return <ProjectOverview page="notifications" />;
}

/** `/p/$project/usage` */
export function UsageOverviewPage(): React.ReactNode {
  return <ProjectOverview page="usage" />;
}

/** `/p/$project/backlog` */
export function BacklogOverviewPage(): React.ReactNode {
  return <ProjectOverview page="backlog" />;
}

/** `/p/$project/ci` */
export function CiOverviewPage(): React.ReactNode {
  return <ProjectOverview page="ci" />;
}

/** `/p/$project/learnings` */
export function LearningsOverviewPage(): React.ReactNode {
  return <ProjectOverview page="learnings" />;
}

/** `/p/$project/evals` (#801) */
export function EvalsOverviewPage(): React.ReactNode {
  return <ProjectOverview page="evals" />;
}

/** `/p/$project/ownership` */
export function OwnershipOverviewPage(): React.ReactNode {
  return <ProjectOverview page="ownership" />;
}

/** `/p/$project/reconciliation` */
export function ReconciliationOverviewPage(): React.ReactNode {
  return <ProjectOverview page="reconciliation" />;
}

/** `/p/$project/labels` */
export function LabelsOverviewPage(): React.ReactNode {
  return <ProjectOverview page="labels" />;
}

/** `/p/$project/loops/$name`: one loop, named by the route's (decoded) param. */
export function LoopPage(): React.ReactNode {
  const { feed, refresh, navigate } = useProjectPage();
  const { name } = useParams({ from: "/p/$project/loops/$name" });
  return <LoopDetail name={name} dashboard={feed} onSent={refresh} navigate={navigate} />;
}

/** `/p/$project/settings` */
export function SettingsPage(): React.ReactNode {
  const { project } = useProjectPage();
  return <ProjectSettings project={project} />;
}

/** `/p/$project/states` */
export function StatesPage(): React.ReactNode {
  return <StatesGallery />;
}

/** `/factory`: every project, drawn in the chrome of the project used last. */
export function FloorPage(): React.ReactNode {
  const { projects } = useProjectPage();
  return <Factory projects={projects} />;
}

/** `/p/$project/intake`: the intake surface, outside the project chrome (App draws none around it). */
export function IntakeRoutePage(): React.ReactNode {
  const { project } = useParams({ from: "/p/$project/intake" });
  return <IntakePage project={project} />;
}
