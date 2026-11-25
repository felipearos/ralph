/**
 * The shell's GETs, named and declared in one place (#603).
 *
 * Each read is a URL and a poll interval, so the store can share one entry per
 * URL however many panels ask for it, and the tests can pin every URL without
 * a DOM. Pure: the caller hands in the project (and whether this is the remote
 * page), so nothing here touches `window` or `document`.
 */
import type {
  AgentsView,
  BridgeStatusView,
  ControlsView,
  ControlView,
  Dashboard,
  GithubReposView,
  GuideView,
  HistoryView,
  IntakeMetricsView,
  IntakeSessionView,
  IntakeView,
  JavView,
  LabelsView,
  NotificationFeed,
  NotificationsView,
  ProjectPromptsView,
  ProjectSettingsView,
  ProjectSetupView,
  ProjectSleepView,
  ClaudeAccountsView,
  ProjectsHealthView,
  ProjectsView,
  ProjectUsageReport,
  SentinelPanelView,
  SentinelView,
  VerifierView,
  SetupDefaultsView,
  EvalsView,
  EvalSetCaseDetail,
  EvalSetView,
  EvalSuggestionsView,
  EvalInboxView,
  EvalProposalsView,
} from "../contracts";
import type { HarnessCatalogView, LineupRead, ModelUpdatesView } from "../../lineup/contracts";
import { apiPath } from "./project-model";

export interface ReadTarget<T> {
  url: string;
  /** null = one-shot: read on first subscribe, again only on refresh. */
  intervalMs: number | null;
  /** Phantom: carries the response type to `useRead` without a cast at each call site. */
  readonly __type?: T;
}

/** The shell's poll interval, unchanged from `usePolled`. */
export const POLL_MS = 5000;

/**
 * The minute reads. Labels cost a `bun` per loop and a GitHub call, and change
 * only when an operator changes them; the intake page refreshes by the minute.
 * Five seconds would multiply that cost for nothing anyone would see.
 */
export const SLOW_POLL_MS = 60_000;

/**
 * The factory floor's interval: a glance over every project, so it need not
 * keep the shell's pace. For the current project it shares the shell's URL,
 * and the store's shortest interval wins, so that one stays at five seconds.
 */
export const FLOOR_POLL_MS = 15_000;

function polled<T>(url: string): ReadTarget<T> {
  return { url, intervalMs: POLL_MS };
}

function slow<T>(url: string): ReadTarget<T> {
  return { url, intervalMs: SLOW_POLL_MS };
}

/** Read once when a view opens, again only when it asks (after a save, or a Refresh button). */
function oneShot<T>(url: string): ReadTarget<T> {
  return { url, intervalMs: null };
}

/** Scoped the way `api()` scopes it: no project in the address bar means the bare path. */
function scoped(project: string | null, path: string): string {
  return project === null ? path : apiPath(project, path);
}

export function dashboardRead(project: string): ReadTarget<Dashboard> {
  return polled(apiPath(project, "/api/loops"));
}

/**
 * The project's change stream (#724): events naming a read key, never a body,
 * so `live-stream.ts` refreshes the read above instead of waiting for its poll.
 */
export function streamUrl(project: string): string {
  return apiPath(project, "/api/stream");
}

/** The remote page's stand-in for the stream (#731): a long poll answering when a snapshot key's version moves (`version-wait.ts`). */
export function versionsUrl(project: string): string {
  return apiPath(project, "/api/versions");
}

export function projectsRead(): ReadTarget<ProjectsView> {
  return polled("/api/projects");
}

export function projectsHealthRead(selected: string): ReadTarget<ProjectsHealthView> {
  return polled(`/api/projects/health?selected=${encodeURIComponent(selected)}`);
}

export function projectSetupRead(project: string): ReadTarget<ProjectSetupView> {
  return polled(apiPath(project, "/api/setup"));
}

/** Only the remote page has a bridge to ask about; locally there is nothing to read. */
export function bridgeStatusRead(project: string, remote: boolean): ReadTarget<BridgeStatusView> | null {
  return remote ? polled(apiPath(project, "/api/bridge")) : null;
}

/**
 * The project's sleep, local only like its route: the remote page reads
 * nothing and offers no toggle. Slow: it changes when an operator flips it,
 * and the toggle refreshes it right after.
 */
export function projectSleepRead(project: string, remote: boolean): ReadTarget<ProjectSleepView> | null {
  return remote ? null : slow(apiPath(project, "/api/sleep"));
}

/** The host's Claude accounts and the project's choice of them; local only, like its route. */
export function claudeAccountsRead(project: string, remote: boolean): ReadTarget<ClaudeAccountsView> | null {
  return remote ? null : slow(apiPath(project, "/api/claude-accounts"));
}

export function usageRead(project: string | null): ReadTarget<ProjectUsageReport> {
  return polled(scoped(project, "/api/usage"));
}

/**
 * Every loop's control view in one read (#615): N loop cards share this one
 * URL in the store instead of polling N per-loop routes each tick.
 */
export function controlsRead(project: string | null): ReadTarget<ControlsView> {
  return polled(scoped(project, "/api/controls"));
}

export function loopControlRead(project: string | null, loop: string): ReadTarget<ControlView> {
  return polled(scoped(project, `/api/loops/${encodeURIComponent(loop)}/control`));
}

export function notificationsRead(project: string | null): ReadTarget<NotificationsView> {
  return polled(scoped(project, "/api/notifications"));
}

export function loopNotificationsRead(project: string | null, loop: string): ReadTarget<NotificationFeed> {
  return polled(scoped(project, `/api/loops/${encodeURIComponent(loop)}/notifications`));
}

export function loopHistoryRead(project: string | null, loop: string): ReadTarget<HistoryView> {
  return polled(scoped(project, `/api/loops/${encodeURIComponent(loop)}/history`));
}

export function agentsRead(project: string | null): ReadTarget<AgentsView> {
  return polled(scoped(project, "/api/agents"));
}

export function labelsRead(project: string | null): ReadTarget<LabelsView> {
  return slow(scoped(project, "/api/labels"));
}

export function intakeRead(project: string): ReadTarget<IntakeView> {
  return slow(apiPath(project, "/api/intake"));
}

export function intakeSessionRead(project: string): ReadTarget<IntakeSessionView> {
  return slow(apiPath(project, "/api/intake/session"));
}

/** The operator's numbers, only once the session is open: a closed one fetches nothing. */
export function intakeMetricsRead(project: string, open: boolean): ReadTarget<IntakeMetricsView> | null {
  return open ? slow(apiPath(project, "/api/intake/metrics")) : null;
}

/** The same URL as `dashboardRead`, so the floor and the shell share one store entry for the current project. */
export function floorRead(project: string): ReadTarget<Dashboard> {
  return { url: apiPath(project, "/api/loops"), intervalMs: FLOOR_POLL_MS };
}

/** `refresh` asks the harnesses again instead of the server's cached answer. */
export function lineupCatalogRead(project: string | null, refresh: boolean): ReadTarget<HarnessCatalogView> {
  return oneShot(scoped(project, `/api/lineup/catalog${refresh ? "?refresh=1" : ""}`));
}

/** Which agents run an older Claude model than their family's latest (#851). */
export function modelUpdatesRead(project: string | null): ReadTarget<ModelUpdatesView> {
  return oneShot(scoped(project, "/api/lineup/updates"));
}

export function lineupRead(project: string | null, loop: string, role?: string): ReadTarget<LineupRead> {
  const query = `loop=${encodeURIComponent(loop)}${role === undefined ? "" : `&role=${encodeURIComponent(role)}`}`;
  return oneShot(scoped(project, `/api/lineup?${query}`));
}

export function verifierRead(project: string | null): ReadTarget<VerifierView> {
  return oneShot(scoped(project, "/api/agents/verifier"));
}

/** The sentinel rules form's read (#685), local only like the verifier's: the proposal route is not relayed. */
export function sentinelRulesRead(project: string | null): ReadTarget<SentinelView> {
  return oneShot(scoped(project, "/api/agents/sentinel"));
}

export function javRead(project: string | null): ReadTarget<JavView> {
  return oneShot(scoped(project, "/api/jav"));
}

/** The Settings page's overview (#689); a snapshot row, so the remote page reads it too. */
export function settingsRead(project: string | null): ReadTarget<ProjectSettingsView> {
  return oneShot(scoped(project, "/api/settings"));
}

/**
 * The Settings page's Prompts section (#695); a relayed snapshot, so the
 * remote page reads it too. Read once: prompts change by a merged PR, rarely.
 */
export function promptsRead(project: string | null): ReadTarget<ProjectPromptsView> {
  return oneShot(scoped(project, "/api/settings/prompts"));
}

/**
 * The Sentinel panel's read (#685): a relayed snapshot, so the remote page
 * reads it too. Polled slowly: the store changes as the sentinel observes,
 * drafts and files, which is minutes, not seconds.
 */
export function sentinelRead(project: string | null): ReadTarget<SentinelPanelView> {
  // Slow: it is asked on every project's overview and runs a CLI or two on
  // the loops' host each time, while the store changes at the gate's pace.
  return slow(scoped(project, "/api/sentinel"));
}

/**
 * The Evals tab's runs (#801): a relayed snapshot, so the remote page reads
 * it too. Polled slowly: a run moves trial by trial, which is many minutes.
 */
export function evalsRead(project: string | null): ReadTarget<EvalsView> {
  return slow(scoped(project, "/api/evals"));
}

/** The Evals tab's Test set screen (#856): a relayed snapshot, like the runs. */
export function evalSetRead(project: string | null): ReadTarget<EvalSetView> {
  return slow(scoped(project, "/api/evals/set"));
}

/** The Evals tab's Suggestions screen (#858): merged PRs ranked as case candidates, a relayed snapshot like the set. */
export function evalSuggestionsRead(project: string | null): ReadTarget<EvalSuggestionsView> {
  return slow(scoped(project, "/api/evals/suggestions"));
}

/** The Evals tab's Inbox screen (#872): recommended runs waiting for the operator, a relayed snapshot like the set. */
export function evalInboxRead(project: string | null): ReadTarget<EvalInboxView> {
  return slow(scoped(project, "/api/evals/inbox"));
}

/** The Evals tab's Proposals screen (#874): the improver's proposals and where each stands, a relayed snapshot like the inbox. */
export function evalProposalsRead(project: string | null): ReadTarget<EvalProposalsView> {
  return slow(scoped(project, "/api/evals/proposals"));
}

/** One case's tags, reason and notes for the edit form; served by the local page only, read once when the form opens. */
export function evalSetCaseRead(project: string | null, id: string): ReadTarget<EvalSetCaseDetail> {
  return oneShot(scoped(project, `/api/evals/set/case?id=${encodeURIComponent(id)}`));
}

/** A trial's patch, opened in its own tab; served by the local page only. */
export function evalPatchUrl(project: string | null, run: string, ticket: string, arm: string): string {
  return scoped(project, `/api/evals/patch?run=${encodeURIComponent(run)}&case=${encodeURIComponent(ticket)}&arm=${encodeURIComponent(arm)}`);
}

/**
 * The Settings gate run's URL (#690). Not a `ReadTarget`: the page polls it
 * only while a run is in flight, and only on the local page, where it is served.
 */
export function gateRunUrl(project: string | null): string {
  return scoped(project, "/api/settings/gates/run");
}

export function agentGuideRead(project: string | null): ReadTarget<GuideView> {
  return oneShot(scoped(project, "/api/agents/guide"));
}

export function setupDefaultsRead(project: string | null): ReadTarget<SetupDefaultsView> {
  return oneShot(scoped(project, "/api/setup/defaults"));
}

/** Unscoped: the repos are the operator's on GitHub, not a project's, and add-project reads the bare path. */
export function githubReposRead(): ReadTarget<GithubReposView> {
  return oneShot("/api/github/repos");
}
