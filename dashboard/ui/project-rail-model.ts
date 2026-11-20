/**
 * The project rail: every project as a small lettered tile down the left edge
 * of the sidebar, with its health dot and a square per agent, and the All
 * projects floor at the top. It replaces the project switcher's dropdown, so
 * switching, and seeing trouble elsewhere, is one glance and one click.
 *
 * A tile's letters are drawn in a soft hue taken from the project's name, the
 * way a label colours its text: the hue tells projects apart, the lightness
 * and chroma are the same for all, so no project shouts louder than another.
 *
 * Pure: the shell hands in the projects, the other projects' health and the
 * selected project's own loops.
 */
import type { DashboardLoop, HealthAgentView, ProjectHealthView, ProjectView } from "../contracts";
import { type AgentState, agentState } from "./factory-model";
import { type HealthTone, switcherView, switcherHealth } from "./project-model";

/** How many agent squares a tile draws before it says "+n". */
export const RAIL_AGENTS = 6;

export interface RailTile {
  id: string;
  /** Two or three letters, unique across the rail. */
  mark: string;
  /** 0–359, from the name, for the letters' colour. */
  hue: number;
  href: string;
  active: boolean;
  /** Null while the project's health has not been read. */
  tone: HealthTone | null;
  /** One per agent, busiest first, at most `RAIL_AGENTS`. */
  agents: AgentState[];
  /** Agents past the ones drawn. */
  more: number;
  /** Hover text, line by line. */
  lines: string[];
}

export interface RailView {
  /** Projects with an agent up, or not read yet, in the registry's order. */
  live: RailTile[];
  /** Projects whose every agent is down, or that have none: dimmed below a rule. */
  dormant: RailTile[];
}

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** The name's words, without the ones that are only digits (`demo-hackathon-2026`). */
const words = (id: string): string[] => id.split(/[^a-z0-9]+/i).filter((word) => /[a-z]/i.test(word));

/** `software-factory` → `SF`; `loggd` → `LG`, its first letter and first consonant after. */
function shortMark(id: string): string {
  const parts = words(id);
  if (parts.length === 0) return id.slice(0, 2).toUpperCase();
  if (parts.length === 1) {
    const [word] = parts as [string];
    const next = Array.from(word.slice(1)).find((char) => /[a-z]/i.test(char) && !VOWELS.has(char.toLowerCase())) ?? word[1] ?? "";
    return (word[0]! + next).toUpperCase();
  }
  return (parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
}

/** One letter more, from the last word: `acme-pwa` → `APW`, `acme-intake-pruebas` → `APR`. */
function longMark(id: string): string {
  const parts = words(id);
  if (parts.length < 2) return (parts[0] ?? id).slice(0, 3).toUpperCase();
  const last = parts.at(-1)!;
  return (parts[0]![0]! + last.slice(0, 2)).toUpperCase();
}

/**
 * Every project's letters, unique across the rail. Two letters where they are
 * unique, three where two would collide, and a digit as the last resort, so
 * no two tiles ever read the same.
 */
export function projectMarks(ids: readonly string[]): Map<string, string> {
  const short = ids.map(shortMark);
  // Collisions are judged on the two-letter marks alone: every project that shares one goes to three.
  const shared = new Set(short.filter((mark, index) => short.indexOf(mark) !== index));
  const marks = new Map(ids.map((id, index) => [id, shared.has(short[index]!) ? longMark(id) : short[index]!]));
  const seen = new Map<string, number>();
  for (const id of ids) {
    const mark = marks.get(id)!;
    const count = (seen.get(mark) ?? 0) + 1;
    seen.set(mark, count);
    if (count > 1) marks.set(id, `${mark.slice(0, 2)}${count}`);
  }
  return marks;
}

/** A stable hue for a name: the same project is the same colour on every page and every machine. */
export function projectHue(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 360;
}

const ORDER: Record<AgentState, number> = { blocked: 0, working: 1, waiting: 2, paused: 3, idle: 4, down: 5 };

const fromHealth = (agent: HealthAgentView): AgentState =>
  agentState({
    supervisor: agent.supervisor,
    stage: agent.stage,
    loopStatus: agent.loopStatus,
    lastEvent: agent.lastEvent === null ? null : { name: agent.lastEvent },
  });

const STATE_WORD: Record<AgentState, string> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  paused: "paused",
  blocked: "blocked",
  down: "down",
};

/** "2 working · 1 waiting · 3 idle". */
function census(states: readonly AgentState[]): string {
  if (states.length === 0) return "no agents";
  const counts = new Map<AgentState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => ORDER[a] - ORDER[b])
    .map(([state, count]) => `${count} ${STATE_WORD[state]}`)
    .join(" · ");
}

/** The selected project's tone, from its own loops: the health read skips it, since its page is on screen. */
function ownTone(states: readonly AgentState[]): HealthTone {
  if (states.includes("blocked")) return "bad";
  if (states.includes("working") || states.includes("waiting")) return "good";
  return states.every((state) => state === "down") ? "neutral" : "info";
}

/**
 * The rail for `selected`, viewed from page `rest`. A tile opens the same
 * page in its project, as the switcher did. On the floor (`onFloor`) no
 * project tile is active: the floor's own tile is.
 */
export function railView({
  projects,
  selected,
  rest,
  health,
  selectedLoops,
  onFloor,
}: {
  projects: readonly ProjectView[] | null;
  selected: string;
  rest: string;
  health: readonly ProjectHealthView[] | null;
  /** The selected project's loops, from the snapshot the page polls; null while it loads. */
  selectedLoops: readonly DashboardLoop[] | null;
  onFloor: boolean;
}): RailView {
  const switcher = switcherView(projects, selected, rest, health);
  const marks = projectMarks(switcher.items.map((item) => item.id));
  const live: RailTile[] = [];
  const dormant: RailTile[] = [];
  for (const item of switcher.items) {
    const read = health?.find((view) => view.project === item.id) ?? null;
    const states: AgentState[] | null =
      item.id === selected
        ? (selectedLoops?.map((loop) => agentState(loop)) ?? null)
        : (read?.agents?.map(fromHealth) ?? null);
    const sorted = [...(states ?? [])].sort((a, b) => ORDER[a] - ORDER[b]);
    const tone = item.id === selected ? (states === null ? null : ownTone(states)) : (item.health?.tone ?? null);
    const healthLine = item.id === selected ? null : read === null ? null : switcherHealth(read).label;
    const tile: RailTile = {
      id: item.id,
      mark: marks.get(item.id)!,
      hue: projectHue(item.id),
      href: item.href,
      active: item.active && !onFloor,
      tone,
      agents: sorted.slice(0, RAIL_AGENTS),
      more: Math.max(sorted.length - RAIL_AGENTS, 0),
      lines: [item.id, ...(states === null ? [] : [census(states)]), ...(healthLine === null ? [] : [healthLine])],
    };
    // Dormant only on a read that says so: a project not read yet is not folded away.
    // A folder that never opted in has no loops to wake, so it sits with the dormant ones.
    const notSetUp = item.id !== selected && read?.problemKind === "not-set-up";
    const asleep = notSetUp || (states !== null && states.every((state) => state === "down") && tone !== "bad");
    (asleep && !tile.active ? dormant : live).push(tile);
  }
  return { live, dormant };
}
