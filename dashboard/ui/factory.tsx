/**
 * Every project's agents on one page, read several ways. The overview and the
 * inbox say what needs the operator; the cards and the matrix say who is on
 * what, project by project; the pipeline says where each ticket stands; the
 * timeline says how the last hours went; the lanes are the original floor, a
 * square per agent in a lane per agent type.
 *
 * It reads each project's overview (`/api/p/:id/loops`) through the
 * Query read layer (`floorRead`, `useDashboards`), the same entry the project
 * pages poll, and beside it the project's full frontier (`/api/p/:id/frontier`,
 * `useFloorFrontiers`), whose tree and PRs that overview leaves out (#67), so
 * it adds no server route and no new process. A
 * project whose read fails keeps its last agents and is named in the header,
 * rather than vanishing and making the floor look quieter than it is.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { DashboardOverview, FrontierRead, ProjectView } from "../contracts";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AGENT_STATES,
  AGENT_WORD,
  type AgentCell,
  type AgentState,
  type CellState,
  CELL_STATES,
  factoryFloor,
  type ProjectRead,
} from "./factory-model";
import { remember, type Sample, sampleOf } from "./factory-views-model";
import { AGENT_LOOK, Inbox, Matrix, Overview, Pipeline, ProjectCards, ROLE_TITLE, Timeline } from "./factory-views";
import { InAppLink } from "./in-app-link";
import { FLOOR_POLL_MS } from "./reads";
import { Tip } from "./tip";
import { useDashboards, useFloorFrontiers } from "./use-reads";

/** How much of the timeline this browser keeps. */
const HISTORY_WINDOW_MS = 2 * 3_600_000;

/**
 * A longer silence than this is the page closed, not an agent still in its
 * phase. A poll waits for every project's read, and on a loaded host one
 * round can take a minute, so a few slow polls must not break a bar.
 */
const HISTORY_MAX_GAP_MS = 3 * 60_000;

const HISTORY_KEY = "ralph.factory.history";
const VIEW_KEY = "ralph.factory.view";

const VIEWS = [
  ["overview", "Overview"],
  ["inbox", "Inbox"],
  ["projects", "Projects"],
  ["matrix", "Matrix"],
  ["pipeline", "Pipeline"],
  ["timeline", "Timeline"],
  ["lanes", "Lanes"],
] as const;
type View = (typeof VIEWS)[number][0];

const TASK_WORD: Record<CellState, string> = {
  queued: "queued",
  working: "in work",
  waiting: "waiting",
  shipped: "shipped",
};

function useFloor(projects: readonly ProjectView[] | null): { reads: ProjectRead[]; failed: string[]; loaded: boolean } {
  const ids = (projects ?? []).map((project) => project.id);
  const { reads: snapshot } = useDashboards(ids);
  // The tree and the PRs the cells draw are the full frontier's (#67), read at the floor's pace beside the overview.
  const { reads: frontierReads } = useFloorFrontiers(ids);
  const key = ids.join("\n");
  // What the floor last drew per project, and whether it ever loaded. A
  // change to the project list rebinds every entry, and the Query layer
  // forgets an entry nobody has held for a minute (or never read), so without
  // these an added project could send the floor back to a skeleton: a blip
  // is not an empty floor.
  const seen = useRef<Map<string, DashboardOverview>>(new Map());
  const seenFrontier = useRef<Map<string, FrontierRead | null>>(new Map());
  const everLoaded = useRef(false);
  // Keyed on the store's snapshot, which keeps its identity until a read
  // changes: `Factory` and `useHistory` act on every new `reads`, and a fresh
  // array each render would set state and record a sample each render.
  return useMemo(() => {
    const list = key === "" ? [] : key.split("\n");
    // A failed read keeps the project's last cells (the store keeps the last
    // success's data, and `seen` covers a rebind).
    const reads = list.map((id, index): ProjectRead => {
      const read = snapshot[index];
      const data = read === undefined || read.state === "loading" ? null : read.data;
      if (data !== null) seen.current.set(id, data);
      const frontierRead = frontierReads[index];
      // A failed or rebound frontier read keeps the project's last one, as the overview does;
      // only an answer (a frontier, or a project with none) replaces it.
      if (frontierRead?.state === "ready" || (frontierRead?.state === "error" && frontierRead.data !== null)) {
        seenFrontier.current.set(id, frontierRead.data);
      }
      return { id, dashboard: data ?? seen.current.get(id) ?? null, frontier: seenFrontier.current.get(id) ?? null };
    });
    // No projects keeps the floor unloaded, as before the store.
    const settled = list.length > 0 && snapshot.length === list.length && snapshot.every((read) => read.state !== "loading");
    if (settled) everLoaded.current = true;
    return {
      reads,
      // A frontier read that failed before it ever answered leaves the coder lane empty: name the project.
      failed: list.filter(
        (id, index) =>
          snapshot[index]?.state === "error" || (frontierReads[index]?.state === "error" && !seenFrontier.current.has(id)),
      ),
      loaded: list.length > 0 && everLoaded.current,
    };
  }, [snapshot, frontierReads, key]);
}

function AgentMark({ agent, showProject }: { agent: AgentCell; showProject: boolean }) {
  const label = agent.lines.join("\n");
  return (
    <Tip content={label} className="font-mono">
      <InAppLink
        href={agent.href}
        aria-label={label}
        className="flex w-14 flex-col items-center gap-1.5 rounded-sm py-1.5 hover:bg-muted"
      >
        <span className={cn("block size-3.5 rounded-[2px] transition-colors duration-500", AGENT_LOOK[agent.state])} />
        <span className="max-w-full truncate text-[9px] leading-none tracking-wider text-muted-foreground uppercase">
          {agent.loop}
        </span>
        {showProject && (
          <span className="max-w-full truncate text-[8px] leading-none tracking-wider text-muted-foreground/60 uppercase">
            {agent.project}
          </span>
        )}
      </InAppLink>
    </Tip>
  );
}

function LegendMark({ state }: { state: AgentState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("block size-2.5 rounded-[1px]", AGENT_LOOK[state].replace(/motion-safe:\S+/, ""))} />
      {AGENT_WORD[state]}
    </span>
  );
}

/** The original floor: a square per agent, in a lane per agent type, in the order work flows through them. */
function Lanes({ reads, nowMs }: { reads: readonly ProjectRead[]; nowMs: number }) {
  const floor = useMemo(() => factoryFloor(reads, nowMs), [reads, nowMs]);
  const many = reads.length > 1;
  const working = floor.lanes.flatMap((lane) => lane.agentCells).filter((agent) => agent.state === "working").length;

  return (
    <div className="space-y-4 font-mono">
      {floor.lanes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents on any project.</p>
      ) : (
        // One frame, a section per agent type split by rules, each as wide as
        // its share of the agents. On a narrow screen they stack.
        <div className="flex flex-col border md:flex-row">
          {floor.lanes.map((lane, index) => {
            const tasks = Object.fromEntries(
              CELL_STATES.map((state) => [state, lane.cells.filter((cell) => cell.state === state).length]),
            ) as Record<CellState, number>;
            const work = CELL_STATES.filter((state) => tasks[state] > 0)
              .map((state) => `${tasks[state]} ${TASK_WORD[state]}`)
              .join(" · ");
            return (
              <div
                key={lane.role}
                className={cn("min-w-0 space-y-3 p-4 md:min-w-[9rem]", index > 0 && "border-t md:border-t-0 md:border-l")}
                style={{ flex: `${Math.max(lane.agents, 1)} 1 0` }}
              >
                <div className="space-y-0.5 text-[10px] tracking-widest uppercase">
                  <p className="flex items-baseline gap-2">
                    <span className="text-foreground">{ROLE_TITLE[lane.role]}</span>
                    <Tip content={`${lane.running} of ${lane.agents} working`}>
                      <span className="text-muted-foreground tabular-nums">
                        {lane.running}/{lane.agents}
                      </span>
                    </Tip>
                  </p>
                  <Tip content={work === "" ? "no tasks" : `tasks: ${work}`}>
                    <p className="truncate text-muted-foreground tabular-nums">{work === "" ? "no tasks" : work}</p>
                  </Tip>
                </div>
                {lane.agentCells.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No agent of this type runs.</p>
                ) : (
                  <div className="flex flex-wrap gap-x-1 gap-y-2">
                    {lane.agentCells.map((agent) => (
                      <AgentMark key={agent.key} agent={agent} showProject={many} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] tracking-widest text-muted-foreground uppercase">
        <span className="flex flex-wrap gap-x-5 gap-y-1">
          {AGENT_STATES.map((state) => (
            <LegendMark key={state} state={state} />
          ))}
        </span>
        <span className="text-foreground tabular-nums">
          {floor.agents} agents · {working} working · {floor.tasks} tasks · {floor.shipped} shipped in 24h
        </span>
      </div>
    </div>
  );
}

function stored<T>(key: string, read: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : read(raw);
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A blocked or full store only loses what the page remembers across reloads.
  }
}

/**
 * The timeline's polls, kept in this browser so a reload does not start the
 * bars over. Nothing on the server records phase history, and the floor adds
 * no server route, so the page remembers what it saw itself. Each project's
 * read settles on its own (and the open project's at the shell's 5 s), so
 * the store changes several times per floor poll; a sample is kept at most
 * once per `FLOOR_POLL_MS`, as when the floor polled every project at once,
 * or the stored history would grow with the project count.
 */
function useHistory(reads: readonly ProjectRead[], loaded: boolean, nowMs: number): Sample[] {
  const [history, setHistory] = useState<Sample[]>(() =>
    stored(HISTORY_KEY, (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Sample[]) : [];
    }, []),
  );
  useEffect(() => {
    if (!loaded) return;
    setHistory((previous) => {
      const last = previous[previous.length - 1];
      if (last !== undefined && nowMs - last.at >= 0 && nowMs - last.at < FLOOR_POLL_MS) return previous;
      const next = remember(previous, sampleOf(reads, nowMs), HISTORY_WINDOW_MS);
      store(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [reads, loaded, nowMs]);
  return history;
}

const isView = (value: string): value is View => VIEWS.some(([id]) => id === value);

export function Factory({ projects }: { projects: readonly ProjectView[] | null }) {
  const { reads, failed, loaded } = useFloor(projects);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => setNowMs(Date.now()), [reads]);
  const history = useHistory(reads, loaded, nowMs);
  const [view, setView] = useState<View>(() => stored(VIEW_KEY, (raw) => (isView(raw) ? raw : "overview"), "overview"));
  const choose = (next: string) => {
    if (!isView(next)) return;
    setView(next);
    store(VIEW_KEY, next);
  };
  const agents = useMemo(() => reads.reduce((sum, read) => sum + (read.dashboard?.loops.length ?? 0), 0), [reads]);

  if (!loaded) return <Skeleton className="h-96" />;
  return (
    <section className="space-y-4">
      <Tabs value={view} onValueChange={choose} className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList variant="line" className="h-auto flex-wrap justify-start gap-1 p-0" aria-label="View the factory">
            {VIEWS.map(([id, title]) => (
              <TabsTrigger key={id} value={id} className="h-7 flex-none px-2.5">
                {title}
              </TabsTrigger>
            ))}
          </TabsList>
          <span className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
            {failed.length > 0 ? <span className="text-status-warn">could not read {failed.join(", ")} · </span> : null}
            {reads.length} project{reads.length === 1 ? "" : "s"} · {agents} agent{agents === 1 ? "" : "s"} · live
          </span>
        </div>
        <TabsContent value="overview">
          <Overview reads={reads} nowMs={nowMs} />
        </TabsContent>
        <TabsContent value="inbox">
          <Inbox reads={reads} nowMs={nowMs} />
        </TabsContent>
        <TabsContent value="projects">
          <ProjectCards reads={reads} nowMs={nowMs} />
        </TabsContent>
        <TabsContent value="matrix">
          <Matrix reads={reads} nowMs={nowMs} />
        </TabsContent>
        <TabsContent value="pipeline">
          <Pipeline reads={reads} nowMs={nowMs} />
        </TabsContent>
        <TabsContent value="timeline">
          <Timeline history={history} nowMs={nowMs} windowMs={HISTORY_WINDOW_MS} maxGapMs={HISTORY_MAX_GAP_MS} />
        </TabsContent>
        <TabsContent value="lanes">
          <Lanes reads={reads} nowMs={nowMs} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
