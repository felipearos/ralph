/**
 * The All projects page's other views, beside the lanes: the overview, the
 * attention inbox, a card per project, the project-by-role matrix, the ticket
 * pipeline and the phase timeline. Each draws a model from
 * `factory-views-model.ts`, so the views can only differ in layout, never in
 * what they say an agent is doing.
 */
import { ChevronRight, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import type { LoopRole, Phase, PullState } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AGENT_WORD, type AgentState, type ProjectRead } from "./factory-model";
import {
  age,
  type AgentLine,
  ATTENTION_GROUPS,
  type AttentionGroup,
  type AttentionItem,
  attention,
  type PipelineRow,
  pipeline,
  type ProjectSummary,
  projectSummaries,
  type Sample,
  STAGE_COLUMNS,
  type StageColumn,
  type TicketChip,
  type TicketAsk,
  ticketAsks,
  type Track,
  tracks,
} from "./factory-views-model";
import { InAppLink } from "./in-app-link";
import { Tip } from "./tip";

export const ROLE_TITLE: Record<LoopRole, string> = {
  coder: "Coders",
  triager: "Triager",
  "ci-doctor": "CI doctor",
  "pr-medic": "PR medic",
  clerk: "Clerk",
  verifier: "Verifier",
  sentinel: "Sentinel",
};

/** The order a ticket passes the roles, as the lanes draw them. */
const ROLE_ORDER: readonly LoopRole[] = ["triager", "coder", "pr-medic", "ci-doctor", "clerk", "verifier", "sentinel"];

/**
 * An agent's look. The blues are the work (vivid when moving, pale when parked
 * on CI); grey hatching is an agent with nothing to take; amber is a pause the
 * operator chose; red is a stop someone has to look at; a hollow grey square
 * is an agent that is not running at all.
 */
export const AGENT_LOOK: Record<AgentState, string> = {
  working: "bg-factory shadow-[0_0_10px_var(--factory)] motion-safe:animate-pulse",
  waiting: "bg-factory-wait/80",
  idle: "bg-[repeating-linear-gradient(135deg,var(--factory-idle)_0_1px,transparent_1px_3px)] ring-1 ring-inset ring-factory-idle/70",
  paused: "bg-status-warn/80",
  blocked: "bg-status-bad",
  down: "ring-1 ring-inset ring-muted-foreground/60",
};

export function AgentSquare({ state, className }: { state: AgentState; className?: string }) {
  return <span className={cn("block size-2.5 shrink-0 rounded-[1px] transition-colors duration-500", AGENT_LOOK[state], className)} />;
}

/** An agent, its square and its name, and with `detail` what it is on, linking to its loop page. */
function AgentChip({ agent, detail = true, project = false }: { agent: AgentLine; detail?: boolean; project?: boolean }) {
  const quiet = agent.state === "idle" || agent.state === "down";
  return (
    <Tip content={agent.lines.join("\n")} className="font-mono">
      <InAppLink href={agent.href} className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs hover:underline">
        <AgentSquare state={agent.state} />
        <span className={cn(quiet && "text-muted-foreground")}>{agent.loop}</span>
        {project && <span className="text-muted-foreground/70">{agent.project}</span>}
        {detail && !quiet && (
          <span className="truncate text-muted-foreground">
            {agent.issue !== null && `#${agent.issue} `}
            {agent.doing}
          </span>
        )}
      </InAppLink>
    </Tip>
  );
}

/** The quiet agents of a project on one line, by state: `▨ tria medi doc  □ rita`. */
function QuietAgents({ agents }: { agents: readonly AgentLine[] }) {
  if (agents.length === 0) return null;
  const states = [...new Set(agents.map((agent) => agent.state))];
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
      {states.map((state) => (
        <span key={state} className="inline-flex items-center gap-1.5" title={AGENT_WORD[state]}>
          <AgentSquare state={state} />
          {agents
            .filter((agent) => agent.state === state)
            .map((agent) => (
              <Tip key={agent.key} content={agent.lines.join("\n")} className="font-mono">
                <InAppLink href={agent.href} className="hover:text-foreground hover:underline">
                  {agent.loop}
                </InAppLink>
              </Tip>
            ))}
        </span>
      ))}
    </span>
  );
}

const isQuiet = (agent: AgentLine) => agent.state === "idle" || agent.state === "down";

/** The projects with nothing running, folded to one line that opens. */
function Dormant({ projects, children }: { projects: readonly ProjectSummary[]; children?: ReactNode }) {
  if (projects.length === 0) return null;
  const agents = projects.reduce((sum, project) => sum + project.agents.length, 0);
  return (
    <Collapsible className="group/dormant">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-3 text-muted-foreground">
          <ChevronRight className="transition-transform group-data-[state=open]/dormant:rotate-90" />
          {projects.length} project{projects.length === 1 ? "" : "s"} not running · {agents} agent{agents === 1 ? "" : "s"} down
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {children ?? (
          <ul className="space-y-1 font-mono text-xs text-muted-foreground">
            {projects.map((project) => (
              <li key={project.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <InAppLink href={`/p/${encodeURIComponent(project.id)}`} className="text-foreground hover:underline">
                  {project.id}
                </InAppLink>
                <span>{project.agents.length === 0 ? "no agents" : `${project.agents.length} down`}</span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/* ---------------------------------------------------------------- overview */

function Kpi({ label, value, note, className }: { label: string; value: number; note?: string; className?: string }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <CardDescription className="font-mono text-[10px] tracking-widest uppercase">{label}</CardDescription>
        <CardTitle className={cn("text-2xl tabular-nums", className)}>
          {value}
          {note && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{note}</span>}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function NeedsYou({ items, asks, nowMs }: { items: readonly AttentionItem[]; asks: readonly TicketAsk[]; nowMs: number }) {
  if (items.length === 0 && asks.length === 0) return null;
  const tickets = asks.reduce((sum, ask) => sum + ask.tickets.length, 0);
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>
        Needs you · {[items.length > 0 && `${items.length} agent${items.length === 1 ? "" : "s"}`, tickets > 0 && `${tickets} ticket${tickets === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
      </AlertTitle>
      <AlertDescription>
        <ul className="w-full divide-y divide-destructive/15">
          {items.map((item) => (
            <AttentionLine key={item.key} item={item} nowMs={nowMs} />
          ))}
          {asks.map((ask) => (
            <AskLine key={ask.key} ask={ask} />
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** One project's tickets that wait on a person for one reason, counted, opening to the list. */
function AskLine({ ask }: { ask: TicketAsk }) {
  return (
    <li>
      <Collapsible className="group/ask">
        <div className="grid grid-cols-[auto_9rem_4rem_minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-xs">
          <AgentSquare state="blocked" />
          <span className="truncate font-mono text-muted-foreground">{ask.project}</span>
          <Badge variant="destructive" className="tabular-nums">
            {ask.tickets.length} ticket{ask.tickets.length === 1 ? "" : "s"}
          </Badge>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 text-left text-foreground hover:underline">
            <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/ask:rotate-90" />
            <span className="truncate">{ask.why}</span>
          </CollapsibleTrigger>
          <Button asChild variant="outline" size="xs">
            <InAppLink href={ask.href}>backlog</InAppLink>
          </Button>
        </div>
        <CollapsibleContent>
          <ul className="space-y-0.5 pb-2 pl-[calc(0.625rem+0.75rem)] text-xs">
            {ask.tickets.map((ticket) => (
              <li key={ticket.number} className="truncate">
                {ticket.url ? (
                  <a href={ticket.url} target="_blank" rel="noreferrer" className="font-mono hover:underline">
                    #{ticket.number}
                  </a>
                ) : (
                  <span className="font-mono">#{ticket.number}</span>
                )}{" "}
                <span className="text-foreground">{ticket.title}</span>
                {ticket.detail && <span className="text-muted-foreground"> · {ticket.detail}</span>}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** A project in one dense row: the busy agents written out, the quiet ones folded into a line. */
function ProjectRow({ project }: { project: ProjectSummary }) {
  const busy = project.agents.filter((agent) => !isQuiet(agent));
  const quiet = project.agents.filter(isQuiet);
  const { tickets } = project;
  return (
    <TableRow>
      <TableCell className="w-48 align-top">
        <InAppLink href={`/p/${encodeURIComponent(project.id)}`} className="font-mono text-xs hover:underline">
          {project.id}
        </InAppLink>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {project.read ? `${tickets.queued} queued · ${tickets.shipped} shipped 24h` : "reading…"}
        </p>
      </TableCell>
      <TableCell className="whitespace-normal">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {busy.map((agent) => (
            <AgentChip key={agent.key} agent={agent} />
          ))}
          <QuietAgents agents={quiet} />
          {project.read && project.agents.length === 0 && <span className="text-xs text-muted-foreground">no agents</span>}
        </div>
      </TableCell>
      <TableCell className="w-16 text-right align-top">
        <Tip content={`${project.busy} of ${project.agents.length} mid-iteration`}>
          <Badge variant="secondary" className="tabular-nums">
            {project.busy}/{project.agents.length}
          </Badge>
        </Tip>
      </TableCell>
    </TableRow>
  );
}

export function Overview({ reads, nowMs }: { reads: readonly ProjectRead[]; nowMs: number }) {
  const { live, dormant } = projectSummaries(reads, nowMs);
  const groups = attention(reads, nowMs);
  const all = [...live, ...dormant];
  const sum = (pick: (project: ProjectSummary) => number) => all.reduce((total, project) => total + pick(project), 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="working" value={groups.moving.length} className="text-factory" />
        <Kpi label="waiting on CI" value={groups.waiting.length} />
        <Kpi label="idle" value={groups.idle.length} />
        <Kpi label="queued" value={sum((project) => project.tickets.queued)} />
        <Kpi label="shipped 24h" value={sum((project) => project.tickets.shipped)} className="text-status-good" />
      </div>
      <NeedsYou items={groups["needs-you"]} asks={ticketAsks(reads, nowMs)} nowMs={nowMs} />
      {live.length === 0 ? (
        <Empty>No project has an agent running.</Empty>
      ) : (
        <Table>
          <TableBody>
            {live.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </TableBody>
        </Table>
      )}
      <Dormant projects={dormant} />
    </div>
  );
}

/* ---------------------------------------------------------------- inbox */

const GROUP_TITLE: Record<AttentionGroup, string> = {
  "needs-you": "Needs you",
  moving: "Moving",
  waiting: "Waiting on CI or merge",
  idle: "Idle",
  down: "Down",
};

const GROUP_STATE: Record<AttentionGroup, AgentState> = {
  "needs-you": "blocked",
  moving: "working",
  waiting: "waiting",
  idle: "idle",
  down: "down",
};

function AttentionLine({ item, nowMs }: { item: AttentionItem; nowMs: number }) {
  const when = age(item.at, nowMs);
  return (
    <li className="grid grid-cols-[auto_9rem_4rem_minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-xs">
      <AgentSquare state={item.state} />
      <span className="truncate font-mono text-muted-foreground">{item.project}</span>
      <span className="font-mono text-foreground">{item.loop}</span>
      <span className="truncate text-foreground">
        {item.issue !== null && <span className="font-mono">#{item.issue} </span>}
        {item.title && <span>{item.title} · </span>}
        <span className="text-muted-foreground">{item.why}</span>
      </span>
      <span className="flex items-center gap-2">
        {when && <span className="font-mono text-muted-foreground tabular-nums">{when}</span>}
        <Button asChild variant="outline" size="xs">
          <InAppLink href={item.href}>open</InAppLink>
        </Button>
      </span>
    </li>
  );
}

export function Inbox({ reads, nowMs }: { reads: readonly ProjectRead[]; nowMs: number }) {
  const groups = attention(reads, nowMs);
  const asks = ticketAsks(reads, nowMs);
  const folded: readonly AttentionGroup[] = ["idle", "down"];
  return (
    <div className="space-y-5">
      {ATTENTION_GROUPS.filter((group) => !folded.includes(group)).map((group) => {
        const count = groups[group].length + (group === "needs-you" ? asks.length : 0);
        return (
          <section key={group} className="space-y-1">
            <h3
              className={cn(
                "flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground uppercase",
                group === "needs-you" && count > 0 && "text-destructive",
              )}
            >
              <AgentSquare state={GROUP_STATE[group]} />
              {GROUP_TITLE[group]} · {count}
            </h3>
            {count === 0 ? (
              <p className="py-1.5 text-xs text-muted-foreground">
                {group === "needs-you" ? "Nothing is waiting on you." : "None."}
              </p>
            ) : (
              <ul className="divide-y">
                {groups[group].map((item) => (
                  <AttentionLine key={item.key} item={item} nowMs={nowMs} />
                ))}
                {group === "needs-you" && asks.map((ask) => <AskLine key={ask.key} ask={ask} />)}
              </ul>
            )}
          </section>
        );
      })}
      {folded.map((group) =>
        groups[group].length === 0 ? null : (
          <Collapsible key={group} className="group/fold">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs" className="-ml-3 text-muted-foreground">
                <ChevronRight className="transition-transform group-data-[state=open]/fold:rotate-90" />
                {GROUP_TITLE[group]} · {groups[group].length} across{" "}
                {new Set(groups[group].map((item) => item.project)).size} projects
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y">
                {groups[group].map((item) => (
                  <AttentionLine key={item.key} item={item} nowMs={nowMs} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ),
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- cards */

/** The project's tickets as one bar: what is moving, waiting, queued and shipped. */
function TicketBar({ project }: { project: ProjectSummary }) {
  const { tickets } = project;
  const total = tickets.working + tickets.waiting + tickets.queued + tickets.shipped;
  if (total === 0) return <p className="text-[11px] text-muted-foreground">no tickets</p>;
  const parts = [
    ["working", tickets.working, "bg-factory"],
    ["waiting", tickets.waiting, "bg-factory-wait"],
    ["queued", tickets.queued, "bg-muted-foreground/40"],
    ["shipped 24h", tickets.shipped, "bg-status-good"],
  ] as const;
  return (
    <div className="w-full space-y-1.5">
      <div className="flex h-1 w-full overflow-hidden bg-muted">
        {parts.map(([label, count, color]) =>
          count === 0 ? null : <span key={label} className={color} style={{ width: `${(count / total) * 100}%` }} />,
        )}
      </div>
      <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase tabular-nums">
        {parts
          .filter(([, count]) => count > 0)
          .map(([label, count]) => `${count} ${label}`)
          .join(" · ")}
      </p>
    </div>
  );
}

function ProjectCard({ project, nowMs }: { project: ProjectSummary; nowMs: number }) {
  const busy = project.agents.filter((agent) => !isQuiet(agent));
  const quiet = project.agents.filter(isQuiet);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="font-mono text-sm">
          <InAppLink href={`/p/${encodeURIComponent(project.id)}`} className="hover:underline">
            {project.id}
          </InAppLink>
        </CardTitle>
        <CardAction>
          <Badge variant="secondary" className="tabular-nums">
            {project.busy} / {project.agents.length} busy
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {busy.map((agent) => (
          <div key={agent.key} className="grid grid-cols-[auto_3rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <AgentSquare state={agent.state} />
            <InAppLink href={agent.href} className="font-mono hover:underline">
              {agent.loop}
            </InAppLink>
            <Tip content={agent.lines.join("\n")} className="font-mono">
              {agent.issueUrl ? (
                <a href={agent.issueUrl} target="_blank" rel="noreferrer" className="truncate hover:underline">
                  #{agent.issue} {agent.title}
                </a>
              ) : (
                <span className="truncate">{agent.title ?? agent.doing}</span>
              )}
            </Tip>
            <Badge variant="outline" className="font-mono normal-case tracking-normal text-muted-foreground">
              {agent.doing}
              {age(agent.lastAt, nowMs) && ` · ${age(agent.lastAt, nowMs)}`}
            </Badge>
          </div>
        ))}
        {quiet.length > 0 && <QuietAgents agents={quiet} />}
        {project.read && project.agents.length === 0 && <p className="text-xs text-muted-foreground">No agents.</p>}
      </CardContent>
      <CardFooter>
        <TicketBar project={project} />
      </CardFooter>
    </Card>
  );
}

export function ProjectCards({ reads, nowMs }: { reads: readonly ProjectRead[]; nowMs: number }) {
  const { live, dormant } = projectSummaries(reads, nowMs);
  return (
    <div className="space-y-4">
      {live.length === 0 ? (
        <Empty>No project has an agent running.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {live.map((project) => (
            <ProjectCard key={project.id} project={project} nowMs={nowMs} />
          ))}
        </div>
      )}
      <Dormant projects={dormant} />
    </div>
  );
}

/* ---------------------------------------------------------------- matrix */

function MatrixRows({ projects, roles }: { projects: readonly ProjectSummary[]; roles: readonly LoopRole[] }) {
  return projects.map((project) => (
    <TableRow key={project.id}>
      <TableCell>
        <InAppLink href={`/p/${encodeURIComponent(project.id)}`} className="font-mono text-xs hover:underline">
          {project.id}
        </InAppLink>
      </TableCell>
      {roles.map((role) => {
        const agents = project.agents.filter((agent) => agent.role === role);
        return (
          <TableCell key={role} className="whitespace-normal">
            {agents.length === 0 ? (
              <span className="text-muted-foreground/50">—</span>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {agents.map((agent) => (
                  <AgentChip key={agent.key} agent={agent} detail={false} />
                ))}
              </div>
            )}
          </TableCell>
        );
      })}
    </TableRow>
  ));
}

export function Matrix({ reads, nowMs }: { reads: readonly ProjectRead[]; nowMs: number }) {
  const { live, dormant } = projectSummaries(reads, nowMs);
  const present = new Set([...live, ...dormant].flatMap((project) => project.agents.map((agent) => agent.role)));
  const roles = ROLE_ORDER.filter((role) => present.has(role));
  if (roles.length === 0) return <Empty>No agents on any project.</Empty>;
  const header = (
    <TableHeader>
      <TableRow>
        <TableHead className="font-mono text-[10px] tracking-widest uppercase">Project</TableHead>
        {roles.map((role) => (
          <TableHead key={role} className="font-mono text-[10px] tracking-widest uppercase">
            {ROLE_TITLE[role]}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
  return (
    <div className="space-y-4">
      <Table>
        {header}
        <TableBody>
          <MatrixRows projects={live} roles={roles} />
        </TableBody>
      </Table>
      <Dormant projects={dormant}>
        <Table>
          {header}
          <TableBody>
            <MatrixRows projects={dormant} roles={roles} />
          </TableBody>
        </Table>
      </Dormant>
    </div>
  );
}

/* ---------------------------------------------------------------- pipeline */

const COLUMN_TITLE: Record<StageColumn, string> = {
  queued: "Queued",
  coding: "Coding",
  review: "PR · CI",
  shipped: "Shipped 24h",
};

const PR_LOOK: Record<PullState, string> = {
  merged: "text-status-done",
  queued: "text-status-info",
  green: "text-status-good",
  testing: "text-status-warn",
  failing: "text-status-bad",
  open: "text-muted-foreground",
};

/** How many chips a column shows before it says "+n". */
const COLUMN_LIMIT = 6;

function Chip({ chip }: { chip: TicketChip }) {
  const lines = [
    `#${chip.number} ${chip.title}`,
    chip.agent ? `${chip.agent.loop} · ${AGENT_WORD[chip.agent.state]}` : null,
    chip.pr ? `PR #${chip.pr.number} · ${chip.pr.state}` : null,
    chip.held,
  ].filter((line): line is string => line !== null);
  return (
    <Tip content={lines.join("\n")} className="font-mono">
      <span
        className={cn(
          "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[11px]",
          chip.agent && chip.agent.state !== "down" ? "border-factory/70" : "border-border",
          chip.pr?.state === "merged" && "border-status-good/40 text-status-good",
          chip.held !== null && "border-dashed text-muted-foreground",
        )}
      >
        {chip.url ? (
          <a href={chip.url} target="_blank" rel="noreferrer" className="hover:underline">
            #{chip.number}
          </a>
        ) : (
          `#${chip.number}`
        )}
        {chip.pr && chip.pr.state !== "merged" && <span className={PR_LOOK[chip.pr.state]}>●</span>}
        {chip.agent && (
          <InAppLink
            href={chip.agent.href}
            className={cn(
              "px-1 text-[10px] leading-4",
              chip.agent.state === "working"
                ? "bg-factory text-white"
                : chip.agent.state === "waiting"
                  ? "bg-factory-wait text-black"
                  : chip.agent.state === "blocked"
                    ? "bg-status-bad text-white"
                    : "bg-muted text-muted-foreground",
            )}
          >
            {chip.agent.loop}
          </InAppLink>
        )}
      </span>
    </Tip>
  );
}

function PipelineCell({ chips }: { chips: readonly TicketChip[] }) {
  if (chips.length === 0) return <span className="text-xs text-muted-foreground/50">—</span>;
  const shown = chips.slice(0, COLUMN_LIMIT);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((chip) => (
        <Chip key={chip.key} chip={chip} />
      ))}
      {chips.length > shown.length && (
        <Tip content={chips.slice(COLUMN_LIMIT).map((chip) => `#${chip.number} ${chip.title}`).join("\n")} className="font-mono">
          <span className="self-center font-mono text-[11px] text-muted-foreground">+{chips.length - shown.length}</span>
        </Tip>
      )}
    </div>
  );
}

export function Pipeline({ reads, nowMs }: { reads: readonly ProjectRead[]; nowMs: number }) {
  const rows: PipelineRow[] = pipeline(reads, nowMs);
  if (rows.length === 0) return <Empty>No project has tickets or a running agent.</Empty>;
  return (
    <div className="space-y-3">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-44 font-mono text-[10px] tracking-widest uppercase">Project</TableHead>
            {STAGE_COLUMNS.map((column) => (
              <TableHead key={column} className="font-mono text-[10px] tracking-widest uppercase">
                {COLUMN_TITLE[column]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const awake = row.bench.filter((agent) => agent.state !== "down");
            const down = row.bench.length - awake.length;
            return (
              <TableRow key={row.id}>
                <TableCell className="align-top whitespace-normal">
                  <InAppLink href={`/p/${encodeURIComponent(row.id)}`} className="font-mono text-xs hover:underline">
                    {row.id}
                  </InAppLink>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    {awake.map((agent) => (
                      <AgentChip key={agent.key} agent={agent} detail={false} />
                    ))}
                    {down > 0 && <span className="font-mono text-[11px] text-muted-foreground/70">+{down} down</span>}
                  </div>
                </TableCell>
                {STAGE_COLUMNS.map((column) => (
                  <TableCell key={column} className="align-top whitespace-normal">
                    <PipelineCell chips={row.columns[column]} />
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        the agent on a ticket rides its chip · a dashed chip is held back · ● is the PR&apos;s checks · the agents under a
        project are on no ticket
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- timeline */

const PHASE_LOOK: Record<Phase, string> = {
  select: "bg-status-info/80",
  implement: "bg-factory",
  verify: "bg-factory/70",
  review: "bg-status-done/80",
  finish: "bg-status-good/70",
};

const STATE_SEGMENT: Partial<Record<AgentState, string>> = {
  waiting: "bg-factory-wait",
  blocked: "bg-status-bad",
  paused: "bg-status-warn/80",
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function TrackBar({ track, fromMs, toMs }: { track: Track; fromMs: number; toMs: number }) {
  const span = Math.max(toMs - fromMs, 1);
  return (
    <div className="relative h-5 bg-muted/60">
      {track.segments.map((segment) => {
        const left = ((Math.max(segment.from, fromMs) - fromMs) / span) * 100;
        // A segment seen by one poll still gets a sliver, so a short phase is not invisible.
        const width = Math.max(((segment.to - Math.max(segment.from, fromMs)) / span) * 100, 0.4);
        const label = segment.state === "working" ? (segment.phase ?? "working") : AGENT_WORD[segment.state];
        const look = segment.state === "working" ? (segment.phase ? PHASE_LOOK[segment.phase] : "bg-factory") : STATE_SEGMENT[segment.state];
        return (
          <Tip
            key={segment.from}
            content={[
              `${track.loop} · ${track.project}`,
              `${label}${segment.issue !== null ? ` · #${segment.issue}` : ""}`,
              `${clock(segment.from)} – ${clock(segment.to)}`,
            ].join("\n")}
            className="font-mono"
          >
            <span
              className={cn("absolute inset-y-0 overflow-hidden px-1 font-mono text-[10px] leading-5 whitespace-nowrap text-white", look)}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              {label}
              {segment.issue !== null && ` #${segment.issue}`}
            </span>
          </Tip>
        );
      })}
    </div>
  );
}

export function Timeline({
  history,
  nowMs,
  windowMs,
  maxGapMs,
}: {
  history: readonly Sample[];
  nowMs: number;
  windowMs: number;
  maxGapMs: number;
}) {
  const all = tracks(history, nowMs, maxGapMs);
  const firstMs = history[0]?.at ?? nowMs;
  // The axis spans what the page has seen, up to the window: a fresh page is not a long empty bar.
  const fromMs = Math.max(nowMs - windowMs, Math.min(firstMs, nowMs - 10 * 60_000));
  const ticks = Array.from({ length: 5 }, (_, index) => fromMs + ((nowMs - fromMs) * index) / 4);
  const legend: [string, string][] = [
    ...Object.entries(PHASE_LOOK),
    ["waiting", STATE_SEGMENT.waiting!],
    ["blocked", STATE_SEGMENT.blocked!],
    ["paused", STATE_SEGMENT.paused!],
  ];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Watching since {clock(firstMs)}. A bar is an agent mid-iteration, coloured by its phase, as this page saw it on
        each poll; this browser keeps the last {Math.round(windowMs / 3_600_000)} h.
      </p>
      {all.length === 0 ? (
        <Empty>No agent has been mid-iteration since the page started watching.</Empty>
      ) : (
        <div className="grid grid-cols-[11rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
          {all.map((track) => (
            <div key={track.key} className="contents">
              <InAppLink href={track.href} className="truncate font-mono text-xs hover:underline">
                {track.loop} <span className="text-muted-foreground">{track.project}</span>
              </InAppLink>
              <TrackBar track={track} fromMs={fromMs} toMs={nowMs} />
            </div>
          ))}
          <span />
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground tabular-nums">
            {ticks.map((tick, index) => (
              <span key={tick}>{index === ticks.length - 1 ? "now" : clock(tick)}</span>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {legend.map(([label, look]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className={cn("block size-2.5", look)} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
