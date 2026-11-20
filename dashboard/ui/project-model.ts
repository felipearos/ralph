/**
 * Which project the shell is showing, and the project switcher's view.
 *
 * Pages live under `/p/:project/…` and API routes under `/api/p/:project/…`.
 * Pure: the shell hands in the location, the registered projects and the
 * other projects' health.
 */
import type { HealthProblemKind, LoopStatus, NeedsYouReason, ProjectHealth, ProjectHealthView, ProjectView } from "../contracts";

export interface ProjectLocation {
  /** The project named in the URL, or null for an unscoped path. */
  project: string | null;
  /** The page within the project: `/`, `/usage`, `/loops/rafa`, … */
  rest: string;
}

const SCOPED = /^\/p\/([^/]+)(\/.*)?$/;

export function parseLocation(pathname: string): ProjectLocation {
  const match = SCOPED.exec(pathname);
  if (match === null) return { project: null, rest: pathname };
  return { project: decodeURIComponent(match[1]!), rest: match[2] ?? "/" };
}

/**
 * Which surface the address the page loaded at belongs to. main.tsx reads it
 * once, before the first render, to pick the theme; what draws is the route
 * tree's call (route-tree.ts, and App's gate in app.tsx).
 */
export type ShellPage = { kind: "intake"; project: string } | { kind: "dashboard" } | { kind: "not-found"; project: string | null };

/**
 * The intake page at `/p/:project/intake`, else the loop dashboard. The open
 * intake deployment serves the intake page alone, so anywhere else there is
 * not found rather than a dashboard it has no data for.
 */
export function shellPage(pathname: string, intakeSurface: boolean): ShellPage {
  const { project, rest } = parseLocation(pathname);
  // As loose as the router's match (any case, a trailing slash), so every
  // address that draws the intake page also gets its theme.
  if (project !== null && /^\/intake\/?$/i.test(rest)) return { kind: "intake", project };
  return intakeSurface ? { kind: "not-found", project } : { kind: "dashboard" };
}

export const pagePath = (project: string, rest: string): string => `/p/${encodeURIComponent(project)}${rest}`;

/** `/api/x` as the project's `/api/p/:project/x`. */
export function apiPath(project: string, path: string): string {
  if (!path.startsWith("/api/")) return path;
  return `/api/p/${encodeURIComponent(project)}/${path.slice("/api/".length)}`;
}

/** Where `/` opens: the project used last while it is still registered, else the first. */
export function landingProject(projects: readonly ProjectView[], remembered: string | null): string | null {
  if (remembered !== null && projects.some((project) => project.id === remembered)) return remembered;
  return projects[0]?.id ?? null;
}

export type HealthTone = "good" | "warn" | "bad" | "info" | "neutral";

/** Another project's health dot and needs-you count, as the switcher draws them. */
export interface SwitcherHealth {
  tone: HealthTone;
  /** Loops waiting on the operator; the count is shown only when above zero. */
  needsYou: number;
  /** A sentence for the tooltip and screen readers. */
  label: string;
}

export interface SwitcherItem {
  id: string;
  label: string;
  detail: string | null;
  active: boolean;
  href: string;
  /**
   * Null for the selected project, whose full snapshot is on screen, and for
   * a project whose health has not been read yet.
   */
  health: SwitcherHealth | null;
}

export interface SwitcherView {
  current: { id: string; label: string; detail: string | null };
  items: SwitcherItem[];
  /** Loops needing the operator across every other project, for the closed switcher. */
  elsewhere: number;
  /** Always the last entry: opens the add-project dialog. */
  add: { label: string; disabled: boolean };
}

const HEALTH_TONE: Record<ProjectHealth, HealthTone> = {
  "needs-you": "bad",
  degraded: "warn",
  running: "good",
  idle: "info",
  unknown: "neutral",
};

const REASON_TEXT: Record<NeedsYouReason, string> = {
  approval: "awaits approval",
  blocked: "is blocked",
  errored: "stopped on an error",
};

const loopsText = (count: number): string => (count === 1 ? "1 loop" : `${count} loops`);

/** "1 needs you", "3 need you". */
export const needsYouText = (count: number): string => `${count} need${count === 1 ? "s" : ""} you`;

/** The loop statuses that make a project degraded, as the rail says them. */
const DEGRADED_TEXT: Partial<Record<LoopStatus, string>> = {
  stale: "has gone quiet",
  orphaned: "lost its checkout",
  unknown: "cannot be read",
};

/** "rafa has gone quiet, testo cannot be read", else the controls, the one other cause. */
function degradedText(view: ProjectHealthView): string {
  // A bridge that predates the agents list cannot say which loop.
  if (view.agents === undefined) return "A loop is stale or unknown, or its controls cannot be read";
  const loops = view.agents.flatMap((agent) => {
    const text = DEGRADED_TEXT[agent.loopStatus];
    return text === undefined ? [] : [`${agent.loop} ${text}`];
  });
  return loops.length > 0 ? loops.join(", ") : "A loop's pause and stop controls cannot be read";
}

/**
 * `.ralph/config.json`'s first validation problem, from the message
 * `parseProjectConfig` writes (`… is invalid:\n  - a\n  - b`).
 */
function configProblemText(problem: string | null): string {
  if (problem === null || /not valid JSON/.test(problem)) return "Its .ralph/config.json is not valid JSON";
  const listed = problem
    .split("\n")
    .map((line) => /^\s*- (.+)$/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined);
  if (listed.length === 0) return "Its .ralph/config.json does not validate";
  const more = listed.length > 1 ? ` (and ${listed.length - 1} more)` : "";
  return `Its .ralph/config.json does not validate: ${listed[0]}${more}`;
}

/** An unreadable project, by why: plain words where the reason is known, the raw one otherwise. */
function unknownText(kind: HealthProblemKind | undefined, problem: string | null): string {
  switch (kind) {
    case "not-set-up":
      return "Not a Ralph project yet: it has no .ralph/config.json";
    case "missing":
      return "Its folder is gone from this machine; restore it, or remove the project in Settings";
    case "invalid-config":
      return configProblemText(problem);
    case "unreadable":
    case undefined:
      return `Could not be read${problem === null ? "" : `: ${problem}`}`;
  }
}

/** The tone of an unreadable project: a folder that is gone or a config that broke wants a look. */
const UNKNOWN_TONE: Record<HealthProblemKind, HealthTone> = {
  "not-set-up": "neutral",
  missing: "warn",
  "invalid-config": "warn",
  unreadable: "neutral",
};

/** One project's health as a dot, a count and a sentence. */
export function switcherHealth(view: ProjectHealthView): SwitcherHealth {
  const label = ((): string => {
    switch (view.health) {
      case "needs-you":
        return `${needsYouText(view.needsYou)}: ${view.needs
          .map((need) => `${need.loop} ${REASON_TEXT[need.reason]}`)
          .join(", ")}`;
      case "degraded":
        return degradedText(view);
      case "running":
        return `${view.running} of ${loopsText(view.loops)} running`;
      case "idle":
        return view.loops === 0 ? "No loop has a checkout" : `${loopsText(view.loops)}, none running`;
      case "unknown":
        return unknownText(view.problemKind, view.problem);
    }
  })();
  const tone =
    view.health === "unknown" && view.problemKind !== undefined ? UNKNOWN_TONE[view.problemKind] : HEALTH_TONE[view.health];
  return { tone, needsYou: view.needsYou, label };
}

/**
 * The switcher for `selected`, viewed from page `rest`. Switching keeps an
 * overview page; a loop page goes to the other project's agents, since that
 * loop may not exist there. `health` is every other project's, from `GET
 * /api/projects/health`; the selected project's own is never shown here,
 * since its full snapshot is the page itself.
 */
export function switcherView(
  projects: readonly ProjectView[] | null,
  selected: string,
  rest: string,
  health: readonly ProjectHealthView[] | null = null,
): SwitcherView {
  // A loop page and the All projects floor have no twin in the other project: land on its agents.
  const target = rest.startsWith("/loops/") || rest === "/factory" ? "/" : rest;
  const found = projects?.find((project) => project.id === selected);
  const healthOf = (id: string): ProjectHealthView | null =>
    id === selected ? null : (health?.find((view) => view.project === id) ?? null);
  const items = (projects ?? []).map((project) => {
    const read = healthOf(project.id);
    return {
      id: project.id,
      label: project.id,
      detail: project.path,
      active: project.id === selected,
      href: pagePath(project.id, target),
      health: read === null ? null : switcherHealth(read),
    };
  });
  return {
    current: { id: selected, label: selected, detail: found?.path ?? null },
    items,
    elsewhere: items.reduce((sum, item) => sum + (item.health?.needsYou ?? 0), 0),
    add: { label: "Add project", disabled: false },
  };
}
