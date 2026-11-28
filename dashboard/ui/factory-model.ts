/**
 * The factory floor: every project's agents on one page, one square per
 * agent, in a lane per agent type, with each lane's work counted beside it.
 *
 * An agent is in one of six states, and the split is what an operator scans
 * for: WORKING is mid-iteration on a ticket; WAITING is mid-iteration but
 * parked on something outside it (CI, a merge); IDLE is alive with nothing to
 * take; PAUSED was paused by the operator; BLOCKED has stopped on a problem
 * someone has to look at; DOWN is not running at all.
 *
 * A lane's tasks are still read, cell by cell, so its counts say how much
 * work waits for those agents: QUEUED, WORKING, WAITING (stuck, on a person,
 * or held by a loop that is not moving) and SHIPPED (merged in the last day).
 *
 * Pure, so the lanes can be tested without a DOM or a server.
 */
import type { DashboardLoop, DashboardOverview, FrontierRead, FrontierTreeNode, LoopRole } from "../contracts";
import { since } from "./backlog-model";
import { issueHref } from "./issue-link";

export const CELL_STATES = ["queued", "working", "waiting", "shipped"] as const;
export type CellState = (typeof CELL_STATES)[number];

export interface Cell {
  /** Unique across the page: the project, the lane and the task. */
  key: string;
  project: string;
  number: number | null;
  title: string;
  state: CellState;
  /** Why it is in that state, for the hover text. */
  why: string;
  url: string | null;
}

export const AGENT_STATES = ["working", "waiting", "idle", "paused", "blocked", "down"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface AgentCell {
  /** Unique across the page: the project and the loop. */
  key: string;
  project: string;
  loop: string;
  state: AgentState;
  /** What it is doing, line by line, for the hover text. */
  lines: string[];
  /** The loop's own page. */
  href: string;
}

export interface Lane {
  role: LoopRole;
  agents: number;
  running: number;
  /** One per agent of this type, across every project. */
  agentCells: AgentCell[];
  /** The lane's tasks, for its counts. */
  cells: Cell[];
}

export interface Floor {
  lanes: Lane[];
  tasks: number;
  active: number;
  shipped: number;
  agents: number;
}

/**
 * One project's read: its overview, or null while it loads or when it failed,
 * and its full frontier (#67), which the overview leaves the tree and the PRs
 * out of: null until that read lands, drawn as a project with no frontier.
 */
export interface ProjectRead {
  id: string;
  dashboard: DashboardOverview | null;
  frontier: FrontierRead | null;
}

/** How far back a merge still counts as shipped on the floor. */
export const SHIPPED_WINDOW_MS = 24 * 3_600_000;

/**
 * The lanes in the order work flows through them: a ticket is triaged, then
 * coded into a PR, the PR is tended until it merges, and a red build after it
 * is the CI doctor's. The clerk's lane is last because its work leaves the
 * flow: it files Slack reports into Jira, which no other lane reads. The
 * verifier's comes after it because its work starts where every other lane's
 * ends: it follows a merged pull request into production.
 */
const ROLE_ORDER: readonly LoopRole[] = ["triager", "coder", "pr-medic", "ci-doctor", "clerk", "verifier", "sentinel"];

/**
 * A loop is working when its supervisor is alive AND it is mid-iteration. A
 * live loop between tickets still carries its last issue number, so the issue
 * alone would call every idle loop busy; `loopStatus` is what the sidebar's
 * running/idle reads.
 */
export const isRunning = (loop: DashboardLoop): boolean => loop.supervisor === "alive" && loop.loopStatus === "running";

/** The words for an agent's state, as the hover text and the legend say them. */
export const AGENT_WORD: Record<AgentState, string> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  paused: "paused",
  blocked: "blocked",
  down: "down",
};

/**
 * One agent's state. Down first: a dead supervisor's last record says nothing
 * about now. A wait inside an iteration is named by its event (`pr-wait`,
 * `ci-wait`), which is how the supervisor marks handing the clock to CI.
 */
export function agentState(
  loop: Pick<DashboardLoop, "supervisor" | "stage" | "loopStatus"> & { lastEvent: { name: string } | null },
): AgentState {
  if (loop.supervisor !== "alive" || loop.stage === "stopped") return "down";
  if (["stale", "orphaned", "completed", "unknown"].includes(loop.loopStatus)) return "down";
  if (["blocked", "failed", "interrupted"].includes(loop.loopStatus)) return "blocked";
  if (loop.stage === "paused") return "paused";
  if (loop.loopStatus === "running") return loop.lastEvent?.name.endsWith("-wait") ? "waiting" : "working";
  return "idle";
}

export function agentCell(id: string, loop: DashboardLoop, nowMs: number): AgentCell {
  const state = agentState(loop);
  const lines = [`${loop.loop} · ${id}`, AGENT_WORD[state]];
  const busy = state === "working" || state === "waiting" || state === "blocked";
  if (busy && loop.issue !== null) lines.push(`#${loop.issue}${loop.issueTitle ? ` ${loop.issueTitle}` : ""}`);
  if (busy && loop.case !== null) lines.push(`case: ${loop.case.subject}`);
  if (state === "working" && loop.phase !== null) lines.push(`phase: ${loop.phase}`);
  if (loop.lastEvent !== null) {
    const age = since(loop.lastEvent.at, nowMs);
    const ago = age === null ? "" : ` (${age} ago)`;
    lines.push(`last: ${loop.lastEvent.detail ?? loop.lastEvent.name}${ago}`);
  }
  if ((state === "blocked" || state === "down") && loop.stopReason !== null) lines.push(loop.stopReason.why);
  return {
    key: `${id}:${loop.loop}`,
    project: id,
    loop: loop.loop,
    state,
    lines,
    href: `/p/${encodeURIComponent(id)}/loops/${encodeURIComponent(loop.loop)}`,
  };
}

const walk = (nodes: readonly FrontierTreeNode[]): FrontierTreeNode[] =>
  nodes.flatMap((node) => [node, ...walk(node.children)]);

const STATE_ORDER: Record<CellState, number> = { working: 0, waiting: 1, queued: 2, shipped: 3 };

function coderCells(id: string, dashboard: DashboardOverview, frontier: FrontierRead | null, repoUrl: string | null, nowMs: number): Cell[] {
  const view = frontier?.view;
  if (!view) return [];
  const issueUrl = (number: number) => issueHref(repoUrl, number);
  const working = new Set(dashboard.loops.filter(isRunning).map((loop) => loop.loop));
  const alive = new Set(dashboard.loops.filter((loop) => loop.supervisor === "alive").map((loop) => loop.loop));
  const holder = new Map(view.inFlight.map((ticket) => [ticket.number, ticket.loop]));
  const titles = new Map<number, string>();
  const cells = new Map<number, Cell>();
  const nodes = view.tree.flatMap((group) => walk(group.roots));
  for (const node of nodes) {
    titles.set(node.number, node.title);
    if (node.state === "done" || cells.has(node.number)) continue;
    const loop = holder.get(node.number) ?? null;
    let state: CellState = "queued";
    let why = node.state === "blocked" ? "blocked behind another ticket" : node.state === "occupied" ? "waits behind a pick" : "not started";
    if (node.state === "in-flight" && loop !== null && working.has(loop)) {
      state = "working";
      why = `${loop} is working it`;
    } else if (node.stuck) {
      state = "waiting";
      why = `stuck (${node.stuck})`;
    } else if (node.human) {
      state = "waiting";
      why = "waits on you";
    } else if (node.state === "in-flight") {
      state = "waiting";
      why =
        loop === null
          ? `claimed by ${node.detail ?? "someone"}`
          : alive.has(loop)
            ? `claimed by ${loop}, which is between iterations`
            : `claimed by ${loop}, whose loop is not running`;
    }
    cells.set(node.number, { key: `${id}:coder:${node.number}`, project: id, number: node.number, title: node.title, state, why, url: issueUrl(node.number) });
  }
  // Shipped is read from the merged PRs, not the tree: the tree keeps closed
  // tickets only while their spec is open, and a day's merges outlive that.
  for (const pull of frontier?.prs ?? []) {
    if (pull.state !== "merged" || pull.mergedAt === null) continue;
    if (nowMs - Date.parse(pull.mergedAt) > SHIPPED_WINDOW_MS || cells.has(pull.issue)) continue;
    cells.set(pull.issue, {
      key: `${id}:coder:${pull.issue}`,
      project: id,
      number: pull.issue,
      title: titles.get(pull.issue) ?? `PR #${pull.pr}`,
      state: "shipped",
      why: `merged in PR #${pull.pr}`,
      url: repoUrl === null ? null : `${repoUrl}/pull/${pull.pr}`,
    });
  }
  return [...cells.values()];
}

/** The triager's queue is counts, not tickets: one unnamed cell per ticket in each bucket. */
function triagerCells(id: string, dashboard: DashboardOverview): Cell[] {
  const triage = dashboard.frontier?.view?.triage;
  if (!triage) return [];
  return Object.entries(triage).flatMap(([bucket, count]) =>
    Array.from({ length: count }, (_, index) => ({
      key: `${id}:triager:${bucket}:${index}`,
      project: id,
      number: null,
      title: `${bucket} queue`,
      state: "queued" as const,
      why: `waiting in the ${bucket} queue`,
      url: null,
    })),
  );
}

/** What each running loop holds right now, in its own lane. */
function heldCells(id: string, loops: readonly DashboardLoop[], repoUrl: string | null): Cell[] {
  return loops.flatMap((loop): Cell[] => {
    if (loop.role === "coder" || !isRunning(loop)) return [];
    if (loop.case !== null) {
      return [{
        key: `${id}:${loop.role}:case:${loop.case.key}`,
        project: id,
        number: loop.case.issue,
        title: loop.case.subject,
        state: "working",
        why: `${loop.loop} is on this ${loop.case.kind} case`,
        url: loop.case.issue === null ? null : issueHref(repoUrl, loop.case.issue),
      }];
    }
    if (loop.issue === null) return [];
    return [{
      key: `${id}:${loop.role}:${loop.issue}`,
      project: id,
      number: loop.issue,
      title: loop.issueTitle ?? `#${loop.issue}`,
      state: "working",
      why: `${loop.loop} is working it`,
      url: issueHref(repoUrl, loop.issue),
    }];
  });
}

/**
 * Every project's cells, laned by agent type. A lane shows when any project
 * runs an agent of that type or has work for one. Within a lane the cells of
 * all projects share one grid, each project's in issue order, so a cell stays
 * where it is while its state changes under it.
 */
export function factoryFloor(projects: readonly ProjectRead[], nowMs: number): Floor {
  const lanes = new Map<LoopRole, Lane>(
    ROLE_ORDER.map((role) => [role, { role, agents: 0, running: 0, agentCells: [], cells: [] }]),
  );
  for (const { id, dashboard, frontier } of projects) {
    if (dashboard === null) continue;
    const repoUrl = dashboard.loops.find((loop) => loop.repoUrl !== null)?.repoUrl ?? null;
    for (const loop of dashboard.loops) {
      const lane = lanes.get(loop.role)!;
      lane.agents += 1;
      lane.agentCells.push(agentCell(id, loop, nowMs));
      if (isRunning(loop)) lane.running += 1;
    }
    const byNumber = (a: Cell, b: Cell) =>
      (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || STATE_ORDER[a.state] - STATE_ORDER[b.state];
    lanes.get("coder")!.cells.push(...coderCells(id, dashboard, frontier, repoUrl, nowMs).sort(byNumber));
    const held = heldCells(id, dashboard.loops, repoUrl);
    const triager = lanes.get("triager")!;
    triager.cells.push(...held.filter((cell) => cell.key.startsWith(`${id}:triager:`)), ...triagerCells(id, dashboard));
    for (const role of ["ci-doctor", "pr-medic"] as const) {
      lanes.get(role)!.cells.push(...held.filter((cell) => cell.key.startsWith(`${id}:${role}:`)));
    }
  }
  const shown = [...lanes.values()].filter((lane) => lane.agents > 0 || lane.cells.length > 0);
  const cells = shown.flatMap((lane) => lane.cells);
  return {
    lanes: shown,
    tasks: cells.length,
    active: cells.filter((cell) => cell.state === "working").length,
    shipped: cells.filter((cell) => cell.state === "shipped").length,
    agents: shown.reduce((sum, lane) => sum + lane.agents, 0),
  };
}
