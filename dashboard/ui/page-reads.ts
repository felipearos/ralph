/**
 * Which polled reads a page draws on its first render (#739), so a link's
 * hover or focus can read them ahead of the click and the page opens on data.
 * Pure: no React, no `window`, so the map is pinned in node.
 *
 * Built with the same factories and arguments as the hooks in `use-reads.ts`,
 * so every URL is the Query entry a mounted panel reads; since #734 every
 * read is on that layer, one-shot reads and the batched loop controls
 * included. Never a URL that depends on another read's data (a loop's own
 * per-loop fallback, the setup defaults): a prefetch has no data to read it
 * from. Nothing behind a click either (a sheet, a dialog, a tab).
 */
import type { Screen } from "./route-tree";
import {
  agentsRead,
  bridgeStatusRead,
  controlsRead,
  dashboardRead,
  frontierRead,
  fullDashboardRead,
  intakeRead,
  labelsRead,
  loopHistoryRead,
  loopNotificationsRead,
  loopPanelRead,
  notificationsRead,
  projectSetupRead,
  projectSleepRead,
  projectsHealthRead,
  projectsRead,
  promptsRead,
  type ReadTarget,
  sentinelRead,
  evalsRead,
  evalSetRead,
  settingsRead,
  usageRead,
} from "./reads";

/** The project chrome's reads: the shell draws them around every project page but intake. */
function chromeReads(project: string, remote: boolean): (ReadTarget<unknown> | null)[] {
  return [
    dashboardRead(project),
    projectSetupRead(project),
    projectsHealthRead(project),
    bridgeStatusRead(project, remote),
    projectSleepRead(project, remote),
    projectsRead(),
    // The sidebar's loop rows, and the loop page's controls, read this batch.
    controlsRead(project),
  ];
}

/** What the page's body reads on top of the chrome. */
function bodyReads(screen: Screen, project: string, remote: boolean): ReadTarget<unknown>[] {
  switch (screen.page) {
    case "agents":
      return [agentsRead(project), sentinelRead(project)];
    case "loop":
      return [
        usageRead(project),
        loopNotificationsRead(project, screen.name),
        loopHistoryRead(project, screen.name),
        // The activity feed's full rows (#67): the overview caps them.
        loopPanelRead(project, screen.name),
      ];
    case "backlog":
      // The tree and the PRs the overview leaves out (#67).
      return [frontierRead(project)];
    case "ci":
    case "learnings":
      // The CI health and the learnings the overview leaves out (#67).
      return [fullDashboardRead(project)];
    case "notifications":
      return [notificationsRead(project)];
    case "usage":
      return [usageRead(project)];
    case "evals":
      return [evalsRead(project), evalSetRead(project)];
    case "settings":
      return [settingsRead(project), promptsRead(project)];
    case "labels":
      // The remote does not relay the labels read; its page draws "local only".
      return remote ? [] : [labelsRead(project)];
    default:
      return [];
  }
}

/** The polled reads `screen` draws first for `project`, deduped by URL; [] when a project page has no project to name. */
export function pageReads(screen: Screen, project: string | null, remote: boolean): ReadTarget<unknown>[] {
  let targets: (ReadTarget<unknown> | null)[];
  if (screen.page === "factory" || screen.page === "landing") targets = [projectsRead()];
  else if (project === null) targets = [];
  // Intake is drawn without the project chrome.
  else if (screen.page === "intake") targets = [intakeRead(project)];
  else targets = [...chromeReads(project, remote), ...bodyReads(screen, project, remote)];
  const byUrl = new Map<string, ReadTarget<unknown>>();
  for (const target of targets) {
    if (target !== null && !byUrl.has(target.url)) byUrl.set(target.url, target);
  }
  return [...byUrl.values()];
}
