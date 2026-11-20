/**
 * The other ways to read the factory floor: by project, by what needs the
 * operator, by where each ticket stands, and over time. The lanes in
 * `factory-model.ts` answer "how is each kind of agent doing"; these answer
 * "which project is moving, who is on what, and is anything waiting on me".
 *
 * Every view is built from the same per-project snapshots the lanes read, so
 * no view can disagree with another about an agent's state: they all go
 * through `agentState` and `agentCell`.
 *
 * Pure, so the views can be tested without a DOM or a server.
 */
import type { DashboardLoop, FrontierTreeNode, HumanReason, LoopRole, Phase, PullState } from "../contracts";
import { duration } from "./backlog-model";
import { parkLive, parkText, stuckReasonsByNumber } from "./blocked-model";
import {
  AGENT_STATES,
  type AgentCell,
  type AgentState,
  agentCell,
  CELL_STATES,
  type CellState,
  factoryFloor,
  type ProjectRead,
  SHIPPED_WINDOW_MS,
} from "./factory-model";
import { issueHref } from "./issue-link";

/** An agent with what it is doing spelled out, for the views that write it instead of hovering it. */
export interface AgentLine extends AgentCell {
  role: LoopRole;
  issue: number | null;
  /** The ticket's title, or the ci-doctor's case subject. */
  title: string | null;
  issueUrl: string | null;
  phase: Phase | null;
  /** A few words: the phase, "PR wait", "between tickets", why it stopped. */
  doing: string;
  /** When it last did anything, as the loop record says. */
  lastAt: string | null;
}

/** Busy agents first, then the ones that are up but quiet, then the dead. */
const AGENT_ORDER: Record<AgentState, number> = { blocked: 0, working: 1, waiting: 2, paused: 3, idle: 4, down: 5 };

/** The supervisor's wait events, as an operator would say them. */
const WAIT_WORD: Record<string, string> = { "pr-wait": "PR wait", "ci-wait": "CI wait", "merge-wait": "merge wait" };

function doing(loop: DashboardLoop, state: AgentState): string {
  if (state === "working") return loop.phase ?? "working";
  if (state === "waiting") {
    const name = loop.lastEvent?.name ?? "";
    return WAIT_WORD[name] ?? name.replace(/-wait$/, " wait");
  }
  if (state === "paused") return "paused";
  if (state === "blocked") return loop.stopReason?.why ?? loop.loopStatus;
  if (state === "idle") return loop.lastEvent?.name === "frontier-wait" ? "nothing to take" : "between tickets";
  if (loop.stopReason !== null) return loop.stopReason.kind;
  return loop.supervisor === "alive" ? loop.loopStatus : "not running";
}

export function agentLine(id: string, loop: DashboardLoop, nowMs: number): AgentLine {
  const cell = agentCell(id, loop, nowMs);
  // A live loop between tickets keeps its last issue number; only a busy one is on it.
  const busy = cell.state === "working" || cell.state === "waiting" || cell.state === "blocked";
  const issue = busy ? (loop.case?.issue ?? loop.issue) : null;
  const title = busy ? (loop.case?.subject ?? loop.issueTitle) : null;
  return {
    ...cell,
    role: loop.role,
    issue,
    title,
    issueUrl: issue === null ? null : issueHref(loop.repoUrl, issue),
    phase: cell.state === "working" ? loop.phase : null,
    doing: doing(loop, cell.state),
    lastAt: loop.lastEvent?.at ?? loop.heartbeat,
  };
}

export const byAgentOrder = (a: AgentLine, b: AgentLine): number =>
  AGENT_ORDER[a.state] - AGENT_ORDER[b.state] || a.loop.localeCompare(b.loop);

/** A short age for a chip: `4m`, `2h 5m`, `<1m`; null when unknown. */
export function age(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return nowMs - at < 60_000 ? "<1m" : duration(nowMs - at);
}

/* ---------------------------------------------------------------- projects */

export interface ProjectSummary {
  id: string;
  /** False while the project's first read is pending or after it failed with nothing kept. */
  read: boolean;
  agents: AgentLine[];
  /** How many agents are in each state. */
  states: Record<AgentState, number>;
  /** The project's tickets by what is happening to them, as the lanes count them. */
  tickets: Record<CellState, number>;
  /** Working or waiting: mid-iteration. */
  busy: number;
  /** Any agent whose supervisor is up. A project with none is dormant and folds away. */
  live: boolean;
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

export function projectSummary(read: ProjectRead, nowMs: number): ProjectSummary {
  const { id, dashboard } = read;
  const agents = (dashboard?.loops ?? []).map((loop) => agentLine(id, loop, nowMs)).sort(byAgentOrder);
  const states = zero(AGENT_STATES);
  for (const agent of agents) states[agent.state] += 1;
  const tickets = zero(CELL_STATES);
  // The lanes already decide each ticket's state; one project's floor is its tickets.
  for (const lane of factoryFloor([read], nowMs).lanes) for (const cell of lane.cells) tickets[cell.state] += 1;
  return {
    id,
    read: dashboard !== null,
    agents,
    states,
    tickets,
    busy: states.working + states.waiting,
    live: agents.some((agent) => agent.state !== "down"),
  };
}

/**
 * Every project, the live ones first by how much is moving, then the dormant
 * ones. A project that has not been read yet counts as live, so a slow read
 * does not fold a busy project away for a poll.
 */
export function projectSummaries(reads: readonly ProjectRead[], nowMs: number): { live: ProjectSummary[]; dormant: ProjectSummary[] } {
  const all = reads.map((read) => projectSummary(read, nowMs));
  const rank = (project: ProjectSummary) => [
    project.states.blocked,
    project.busy,
    project.agents.length - project.states.down,
    project.tickets.queued,
  ];
  const order = (a: ProjectSummary, b: ProjectSummary) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let index = 0; index < ra.length; index += 1) if (ra[index] !== rb[index]) return rb[index]! - ra[index]!;
    return a.id.localeCompare(b.id);
  };
  return {
    live: all.filter((project) => project.live || !project.read).sort(order),
    dormant: all.filter((project) => !project.live && project.read).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/* ---------------------------------------------------------------- attention */

export const ATTENTION_GROUPS = ["needs-you", "moving", "waiting", "idle", "down"] as const;
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];

export interface AttentionItem {
  key: string;
  project: string;
  loop: string;
  state: AgentState;
  /** The ticket, when there is one. */
  issue: number | null;
  title: string;
  /** Why it is in its group, in a few words. */
  why: string;
  /** The loop page. */
  href: string;
  at: string | null;
}

const HUMAN_WHY: Record<HumanReason, string> = {
  "ready-for-human": "triaged for a person",
  "needs-info": "waits on its reporter",
  held: "held out of scope",
  untriaged: "untriaged, and no triager runs",
};

const walk = (nodes: readonly FrontierTreeNode[]): FrontierTreeNode[] =>
  nodes.flatMap((node) => [node, ...walk(node.children)]);

/**
 * Tickets that wait on the operator in one project, for one reason. They are
 * counted, not listed one per line: a project with thirty untriaged reports
 * is one thing to do (run a triager, or triage them), not thirty.
 */
export interface TicketAsk {
  key: string;
  project: string;
  why: string;
  tickets: { number: number; title: string; url: string | null; detail: string | null }[];
  /** The project's backlog, where these are worked. */
  href: string;
}

/** The order the reasons are listed in: the ones only a person can clear first. */
const ASK_ORDER = ["triaged for a person", "waits on its reporter", "stuck on a blocked label", "park ran out", "untriaged, and no triager runs"];

/**
 * Every ticket that waits on a person, grouped by project and reason. A held
 * ticket is the operator's own decision, already made, so it asks nothing;
 * nor does a stuck ticket under a live park, which a model-free probe watches
 * (#777). A spent park asks under its own reason, naming the condition that
 * never held.
 */
export function ticketAsks(reads: readonly ProjectRead[], nowMs: number): TicketAsk[] {
  const asks: TicketAsk[] = [];
  for (const { id, dashboard } of reads) {
    const view = dashboard?.frontier?.view;
    if (!dashboard || !view) continue;
    const repoUrl = dashboard.loops.find((loop) => loop.repoUrl !== null)?.repoUrl ?? null;
    const byWhy = new Map<string, TicketAsk>();
    const seen = new Set<number>();
    const add = (number: number, title: string, why: string, detail: string | null) => {
      if (seen.has(number)) return;
      seen.add(number);
      const ask = byWhy.get(why) ?? { key: `${id}:${why}`, project: id, why, tickets: [], href: `/p/${encodeURIComponent(id)}/backlog` };
      ask.tickets.push({ number, title, url: issueHref(repoUrl, number), detail });
      byWhy.set(why, ask);
    };
    for (const ticket of view.human) if (ticket.reason !== "held") add(ticket.number, ticket.title, HUMAN_WHY[ticket.reason], null);
    const reasons = stuckReasonsByNumber(view);
    for (const node of view.tree.flatMap((group) => walk(group.roots))) {
      if (node.stuck === null || node.state === "done") continue;
      const park = reasons.get(node.number)?.park ?? null;
      if (park === null) add(node.number, node.title, "stuck on a blocked label", node.stuck);
      else if (!parkLive(park, nowMs)) add(node.number, node.title, "park ran out", parkText(park, nowMs));
    }
    asks.push(
      ...[...byWhy.values()].sort((x, y) => ASK_ORDER.indexOf(x.why) - ASK_ORDER.indexOf(y.why)),
    );
  }
  for (const ask of asks) ask.tickets.sort((x, y) => x.number - y.number);
  return asks;
}

/**
 * Every agent on the floor, sorted by what the operator should do about it.
 * NEEDS YOU is a blocked agent; one that is merely down is not, since an
 * operator stop and a finished run read down too. The tickets that wait on a
 * person are `ticketAsks`, beside it.
 */
export function attention(reads: readonly ProjectRead[], nowMs: number): Record<AttentionGroup, AttentionItem[]> {
  const groups = Object.fromEntries(ATTENTION_GROUPS.map((group) => [group, [] as AttentionItem[]])) as Record<
    AttentionGroup,
    AttentionItem[]
  >;
  const GROUP_OF: Record<AgentState, AttentionGroup> = {
    blocked: "needs-you",
    working: "moving",
    waiting: "waiting",
    paused: "idle",
    idle: "idle",
    down: "down",
  };
  for (const { id, dashboard } of reads) {
    if (dashboard === null) continue;
    for (const loop of dashboard.loops) {
      const agent = agentLine(id, loop, nowMs);
      groups[GROUP_OF[agent.state]].push({
        key: agent.key,
        project: id,
        loop: agent.loop,
        state: agent.state,
        issue: agent.issue,
        title: agent.title ?? "",
        why: agent.doing,
        href: agent.href,
        at: agent.lastAt,
      });
    }
  }
  // Freshest activity first among the moving; everything else by project, then loop.
  const fresh = (a: AttentionItem, b: AttentionItem) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0);
  const named = (a: AttentionItem, b: AttentionItem) =>
    a.project.localeCompare(b.project) || a.loop.localeCompare(b.loop);
  for (const group of ATTENTION_GROUPS) groups[group].sort(group === "moving" || group === "waiting" ? fresh : named);
  return groups;
}

/* ---------------------------------------------------------------- pipeline */

export const STAGE_COLUMNS = ["queued", "coding", "review", "shipped"] as const;
export type StageColumn = (typeof STAGE_COLUMNS)[number];

export interface TicketChip {
  key: string;
  number: number;
  title: string;
  url: string | null;
  /** The agent on it, when one holds it. */
  agent: { loop: string; state: AgentState; href: string } | null;
  /** Its pull request, once there is one. */
  pr: { number: number; state: PullState; url: string | null } | null;
  /** Why a queued ticket is not moving: blocked, stuck, on a person. Null when it is simply next. */
  held: string | null;
}

export interface PipelineRow {
  id: string;
  columns: Record<StageColumn, TicketChip[]>;
  /** Agents not on any ticket in the row: the idle, the down, and the non-coder roles between cases. */
  bench: AgentLine[];
}

/**
 * Each project's tickets by the stage they stand at. A claimed ticket is in
 * CODING until it has an open pull request, then in REVIEW (the PR, its CI and
 * the merge) until the PR merges; a merge in the last day is SHIPPED. The
 * agent holding a ticket rides on its chip, so the row reads who is pushing
 * what, and an agent on no ticket sits on the bench.
 */
export function pipeline(reads: readonly ProjectRead[], nowMs: number): PipelineRow[] {
  const rows: PipelineRow[] = [];
  for (const { id, dashboard } of reads) {
    if (dashboard === null) continue;
    const view = dashboard.frontier?.view ?? null;
    const repoUrl = dashboard.loops.find((loop) => loop.repoUrl !== null)?.repoUrl ?? null;
    const pullUrl = (pr: number) => (repoUrl === null ? null : `${repoUrl}/pull/${pr}`);
    const loops = new Map(dashboard.loops.map((loop) => [loop.loop, loop]));
    const prs = dashboard.frontier?.prs ?? [];
    const openPr = new Map(prs.filter((pull) => pull.state !== "merged").map((pull) => [pull.issue, pull]));
    const columns = Object.fromEntries(STAGE_COLUMNS.map((column) => [column, [] as TicketChip[]])) as Record<StageColumn, TicketChip[]>;
    const seen = new Set<number>();
    const onTicket = new Set<string>();

    const holder = (loopName: string | null) => {
      const loop = loopName === null ? undefined : loops.get(loopName);
      if (loop === undefined) return null;
      const line = agentLine(id, loop, nowMs);
      return { loop: line.loop, state: line.state, href: line.href };
    };
    const chip = (number: number, title: string, agent: TicketChip["agent"], held: string | null): TicketChip => {
      const pull = openPr.get(number);
      return {
        key: `${id}:${number}`,
        number,
        title,
        url: issueHref(repoUrl, number),
        agent,
        pr: pull === undefined ? null : { number: pull.pr, state: pull.state, url: pullUrl(pull.pr) },
        held,
      };
    };

    const titles = new Map<number, string>();
    if (view !== null) {
      for (const ticket of view.inFlight) {
        const agent = holder(ticket.loop);
        if (agent !== null) onTicket.add(agent.loop);
        columns[openPr.has(ticket.number) ? "review" : "coding"].push(chip(ticket.number, ticket.title, agent, null));
        seen.add(ticket.number);
      }
      for (const node of view.tree.flatMap((group) => walk(group.roots))) {
        titles.set(node.number, node.title);
        if (node.state === "done" || node.state === "in-flight" || seen.has(node.number)) continue;
        seen.add(node.number);
        const held = node.stuck
          ? `stuck (${node.stuck})`
          : node.human
            ? HUMAN_WHY[node.human]
            : node.state === "blocked"
              ? "blocked behind another ticket"
              : node.state === "occupied"
                ? "waits behind a pick"
                : null;
        columns.queued.push(chip(node.number, node.title, null, held));
      }
    }
    // A non-coder working a ticket the tree does not hold (a PR it tends, a CI case) still rides a chip.
    for (const loop of dashboard.loops) {
      const line = agentLine(id, loop, nowMs);
      if (onTicket.has(line.loop) || line.issue === null || seen.has(line.issue)) continue;
      if (line.state !== "working" && line.state !== "waiting" && line.state !== "blocked") continue;
      onTicket.add(line.loop);
      seen.add(line.issue);
      columns[openPr.has(line.issue) ? "review" : "coding"].push(
        chip(line.issue, line.title ?? `#${line.issue}`, { loop: line.loop, state: line.state, href: line.href }, null),
      );
    }
    for (const pull of prs) {
      if (pull.state !== "merged" || pull.mergedAt === null) continue;
      if (nowMs - Date.parse(pull.mergedAt) > SHIPPED_WINDOW_MS || seen.has(pull.issue)) continue;
      seen.add(pull.issue);
      columns.shipped.push({
        key: `${id}:${pull.issue}`,
        number: pull.issue,
        title: titles.get(pull.issue) ?? `PR #${pull.pr}`,
        url: issueHref(repoUrl, pull.issue),
        agent: null,
        pr: { number: pull.pr, state: "merged", url: pullUrl(pull.pr) },
        held: null,
      });
    }
    // Next-up first in the queue; newest first among the shipped, as the PR numbers order them.
    columns.queued.sort((a, b) => Number(a.held !== null) - Number(b.held !== null) || a.number - b.number);
    columns.shipped.sort((a, b) => (b.pr?.number ?? 0) - (a.pr?.number ?? 0));
    for (const column of ["coding", "review"] as const) columns[column].sort((a, b) => a.number - b.number);

    const bench = dashboard.loops
      .filter((loop) => !onTicket.has(loop.loop))
      .map((loop) => agentLine(id, loop, nowMs))
      .sort(byAgentOrder);
    rows.push({ id, columns, bench });
  }
  const moving = (row: PipelineRow) => row.columns.coding.length + row.columns.review.length;
  const size = (row: PipelineRow) => STAGE_COLUMNS.reduce((sum, column) => sum + row.columns[column].length, 0);
  const alive = (row: PipelineRow) => row.bench.some((agent) => agent.state !== "down") || moving(row) > 0;
  return rows
    .filter((row) => size(row) > 0 || alive(row))
    .sort((a, b) => moving(b) - moving(a) || size(b) - size(a) || a.id.localeCompare(b.id));
}

/* ---------------------------------------------------------------- timeline */

/**
 * What the timeline remembers of one poll: only the agents doing something,
 * since an idle or dead agent draws no bar. Keys are `project:loop`.
 */
export interface Sample {
  at: number;
  agents: Record<string, { state: AgentState; phase: Phase | null; issue: number | null }>;
}

/** The states a track draws; the rest are gaps. */
const TRACKED: ReadonlySet<AgentState> = new Set(["working", "waiting", "blocked", "paused"]);

export function sampleOf(reads: readonly ProjectRead[], nowMs: number): Sample {
  const agents: Sample["agents"] = {};
  for (const { id, dashboard } of reads) {
    for (const loop of dashboard?.loops ?? []) {
      const line = agentLine(id, loop, nowMs);
      if (TRACKED.has(line.state)) agents[line.key] = { state: line.state, phase: line.phase, issue: line.issue };
    }
  }
  return { at: nowMs, agents };
}

/** The samples inside the window, oldest first, with a new one appended. */
export function remember(history: readonly Sample[], sample: Sample, windowMs: number): Sample[] {
  return [...history.filter((entry) => entry.at >= sample.at - windowMs && entry.at < sample.at), sample];
}

export interface Segment {
  from: number;
  to: number;
  state: AgentState;
  phase: Phase | null;
  issue: number | null;
}

export interface Track {
  key: string;
  project: string;
  loop: string;
  href: string;
  segments: Segment[];
}

/**
 * The agents' bars, from the polls the page has kept. A bar runs from the poll
 * that first saw a state to the poll that saw it change; a gap between polls
 * longer than `maxGapMs` (the page was closed, the machine slept) ends it
 * there rather than drawing a guess across the hole.
 */
export function tracks(history: readonly Sample[], nowMs: number, maxGapMs: number): Track[] {
  const byKey = new Map<string, Segment[]>();
  const open = new Map<string, Segment>();
  const close = (key: string, to: number) => {
    const segment = open.get(key);
    if (segment === undefined) return;
    segment.to = Math.min(to, segment.to + maxGapMs);
    open.delete(key);
  };
  for (const sample of history) {
    for (const key of open.keys()) {
      const segment = open.get(key)!;
      const now = sample.agents[key];
      const same = now !== undefined && now.state === segment.state && now.phase === segment.phase && now.issue === segment.issue;
      if (!same || sample.at - segment.to > maxGapMs) close(key, sample.at);
    }
    for (const [key, now] of Object.entries(sample.agents)) {
      const segment = open.get(key);
      if (segment !== undefined) {
        segment.to = sample.at;
        continue;
      }
      const fresh: Segment = { from: sample.at, to: sample.at, ...now };
      open.set(key, fresh);
      byKey.set(key, [...(byKey.get(key) ?? []), fresh]);
    }
  }
  for (const key of open.keys()) close(key, nowMs);
  return [...byKey.entries()]
    .map(([key, segments]) => {
      const [project, loop] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
      return { key, project, loop, href: `/p/${encodeURIComponent(project)}/loops/${encodeURIComponent(loop)}`, segments };
    })
    .sort((a, b) => a.project.localeCompare(b.project) || a.loop.localeCompare(b.loop));
}
