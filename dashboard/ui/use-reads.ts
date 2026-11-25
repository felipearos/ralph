/**
 * The React binding over the page's reads (#603): one `useSyncExternalStore`
 * per panel, one entry per URL however many panels read it.
 *
 * Every polled read goes through the Query layer (#727, #733, spec #722): the
 * dashboard snapshot (the shell's read, the floor's per-project reads and the
 * hover preload of a link, #739), the projects list and health, setup, sleep, bridge,
 * usage, Sentinel panel, notifications, history, agents, labels and intake.
 * It keeps a read's data for a while after its panel closes, so going back
 * shows it at once. Since #734 the one-shot reads, the loop controls (batched,
 * with their per-loop fallback) and the busy flags of the lineup catalogue and
 * the GitHub repos go through it too, and so do `useRead`, `useReads` and
 * `useReadBusy`: the read store is gone (#738), and the Query layer is the
 * page's only read layer.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type {
  AgentsView,
  BridgeStatusView,
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
import { isIntakeSurface, isRemote } from "./api";
import { bindLiveStream, type LiveReads, type LiveSource, type LiveStatus, type LiveStream } from "./live-stream";
import { bindLoopControl, createControlsFallback } from "./loop-control";
import { pageReads } from "./page-reads";
import type { Screen } from "./route-tree";
import { screenProject } from "./screen-project";
import {
  bindRead,
  bindReads,
  createQueryReads,
  LOADING,
  NO_READS,
  type QueryReads,
  type Read,
  type ReadStore,
  type ReadStoreDeps,
} from "./query-reads";
import { versionWaitSource } from "./version-wait";
import {
  agentGuideRead,
  agentsRead,
  bridgeStatusRead,
  controlsRead,
  dashboardRead,
  floorRead,
  githubReposRead,
  intakeMetricsRead,
  intakeRead,
  intakeSessionRead,
  javRead,
  labelsRead,
  lineupCatalogRead,
  lineupRead,
  modelUpdatesRead,
  loopControlRead,
  loopHistoryRead,
  loopNotificationsRead,
  notificationsRead,
  projectSetupRead,
  projectSleepRead,
  claudeAccountsRead,
  projectsHealthRead,
  projectsRead,
  type ReadTarget,
  sentinelRead,
  evalsRead,
  evalSetCaseRead,
  evalSetRead,
  evalSuggestionsRead,
  evalInboxRead,
  evalProposalsRead,
  sentinelRulesRead,
  settingsRead,
  promptsRead,
  verifierRead,
  setupDefaultsRead,
  SLOW_POLL_MS,
  streamUrl,
  usageRead,
  versionsUrl,
} from "./reads";

/** A read taken once when the view opens; `reload` reads it again (after a save, say). */
export interface OneShot<T> {
  read: Read<T>;
  reload: () => void;
}

/** Through the Query layer (#734); `reload` is the layer's refresh, so it re-reads at once. */
function useOneShot<T>(target: ReadTarget<T> | null): OneShot<T> {
  const { read, refresh } = useReadOn(useQueryStore(), target);
  return { read, reload: refresh };
}

export interface Polled<T> {
  read: Read<T>;
  refresh: () => void;
}

/** The server render has no store: every read is loading there. */
const loadingSnapshot = (): Read<never> => LOADING;
const idleSnapshot = (): boolean => false;
const emptySnapshot = (): readonly Read<never>[] => NO_READS;

let defaultQueryReads: QueryReads | null = null;

/**
 * The browser's fetch, clock and visibility, for the Query layer.
 * Called on first use, never at import, so importing this module never
 * touches `window`.
 */
function browserReadDeps(): ReadStoreDeps {
  return {
    fetch: (url, init) => window.fetch(url, init),
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    // A background tab stops polling and catches up when shown (#725).
    visibility: {
      hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
      onChange: (listener) => {
        if (typeof document === "undefined") return () => {};
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    },
  };
}

/** The page's one QueryClient behind it (spec #722); created on first use, not at import, so importing this module never touches `window`. */
function getDefaultQueryReads(): QueryReads {
  defaultQueryReads ??= createQueryReads(browserReadDeps());
  return defaultQueryReads;
}

/**
 * A test or gallery supplies its own store; null means the page's default one.
 * A link's hover preload (#739) runs in a route loader, outside React, so it
 * always reads into the page's default Query layer, never a supplied store.
 */
export const ReadStoreContext = createContext<ReadStore | null>(null);

/**
 * The store the polled reads go through: a supplied store when a test or
 * gallery gives one (so it still sees every read), else the page's Query
 * layer. One getter, so every panel and the change stream land on the same
 * entry for a URL.
 */
function useQueryStore(): () => ReadStore | QueryReads {
  const supplied = useContext(ReadStoreContext);
  return useMemo(() => (supplied === null ? getDefaultQueryReads : () => supplied), [supplied]);
}

export function useRead<T>(target: ReadTarget<T> | null): Polled<T> {
  return useReadOn(useQueryStore(), target);
}

/** A polled read, through the Query layer (or the supplied store). */
function usePolled<T>(target: ReadTarget<T> | null): Polled<T> {
  return useReadOn(useQueryStore(), target);
}

/** `useRead` over a given store getter; the getter must keep its identity across renders, or every render resubscribes. */
function useReadOn<T>(store: () => ReadStore, target: ReadTarget<T> | null): Polled<T> {
  // Primitives, not the target object: a fresh object each render must not resubscribe.
  const url = target?.url ?? null;
  const intervalMs = target?.intervalMs ?? null;
  const binding = useMemo(() => bindRead<T>(store, url, intervalMs), [store, url, intervalMs]);
  const read = useSyncExternalStore(binding.subscribe, binding.getSnapshot, loadingSnapshot);
  return { read, refresh: binding.refresh };
}

/**
 * Several targets read at once (the factory floor: one per project). Memoised
 * on a key of the URLs and intervals, not the array: callers build a fresh
 * array each render, and resubscribing each render would refetch every URL.
 */
export function useReads<T>(targets: readonly ReadTarget<T>[]): { reads: readonly Read<T>[]; refresh: () => void } {
  return useReadsOn(useQueryStore(), targets);
}

/** `useReads` over a given store getter; the getter must keep its identity across renders. */
function useReadsOn<T>(
  store: () => ReadStore,
  targets: readonly ReadTarget<T>[],
): { reads: readonly Read<T>[]; refresh: () => void } {
  const key = JSON.stringify(targets.map((target) => [target.url, target.intervalMs]));
  const binding = useMemo(
    () => {
      const parsed = JSON.parse(key) as [string, number | null][];
      return bindReads<T>(store, parsed.map(([url, intervalMs]) => ({ url, intervalMs })));
    },
    [store, key],
  );
  const reads = useSyncExternalStore(binding.subscribe, binding.getSnapshot, emptySnapshot);
  return { reads, refresh: binding.refresh };
}

/**
 * Whether the target's read is on the wire now (the first read, a poll or a
 * refresh), so a Refresh button can say so. Its own hook, not part of
 * `useRead`: the flag flips at every poll's start and end, and a reader that
 * does not draw it would re-render twice a poll for nothing.
 */
export function useReadBusy(target: ReadTarget<unknown> | null): boolean {
  return useReadBusyOn(useQueryStore(), target);
}

/**
 * `useReadBusy` over a given store getter: the flag must come from the layer
 * its read is on, or it would ask an entry nobody reads and never turn true.
 */
function useReadBusyOn(store: () => ReadStore, target: ReadTarget<unknown> | null): boolean {
  const url = target?.url ?? null;
  const intervalMs = target?.intervalMs ?? null;
  const binding = useMemo(() => bindRead<unknown>(store, url, intervalMs), [store, url, intervalMs]);
  return useSyncExternalStore(binding.subscribe, binding.getInFlight, idleSnapshot);
}

/** The project on screen, as `api()` reads it. */
function shellProject(): string | null {
  return screenProject();
}

/** The project's dashboard snapshot, through the Query layer (#727). */
export function useDashboard(project: string): Polled<Dashboard> {
  return useReadOn(useQueryStore(), dashboardRead(project));
}

/**
 * The factory floor's snapshot of every project, through the Query layer
 * like `useDashboard`: `floorRead` is `dashboardRead`'s URL, and both must
 * land on one entry or the current project would be read twice.
 */
export function useDashboards(projects: readonly string[]): { reads: readonly Read<Dashboard>[]; refresh: () => void } {
  return useReadsOn(useQueryStore(), projects.map(floorRead));
}

/**
 * Reads a page's polled reads ahead of a click on its link (#739), through the
 * page's Query layer, so the page opens on data and a link hovered again
 * inside the keep-alive window reads nothing new. Never throws: a prefetch is
 * a hint, and a failure in it must not break the page the pointer is on.
 */
export function preloadPageReads(screen: Screen, project: string | null): void {
  let urls: string[];
  try {
    // The open intake deployment serves intake and nothing else, and must not
    // fire a single dashboard read (#459): App's gate draws "not found" for
    // every other address, but a loader runs before App does.
    if (isIntakeSurface() && screen.page !== "intake") return;
    urls = pageReads(screen, project, isRemote()).map((target) => target.url);
  } catch {
    return;
  }
  for (const url of urls) {
    try {
      getDefaultQueryReads().prefetch(url);
    } catch {
      // One URL's failure must not stop the others.
    }
  }
}

/**
 * Which store URLs each stream key refreshes (#729). Built with the same
 * targets and project arguments as the hooks below, so every URL equals the
 * store key a mounted panel reads: `p` is what the per-loop hooks pass, the
 * shell's `project` what `useDashboard` and `useProjectsHealth` pass.
 */
function liveReads(project: string, p: string | null, loops: readonly string[]): LiveReads {
  const reads: Record<string, string | readonly string[]> = {
    dashboard: dashboardRead(project).url,
    controls: controlsRead(p).url,
    notifications: [notificationsRead(p).url, ...loops.map((loop) => loopNotificationsRead(p, loop).url)],
    agents: agentsRead(p).url,
    "_/health": projectsHealthRead(project).url,
  };
  for (const loop of loops) {
    reads[`control/${loop}`] = loopControlRead(p, loop).url;
    reads[`history/${loop}`] = loopHistoryRead(p, loop).url;
  }
  return reads;
}

/**
 * The project's change stream (#724), bound to the Query layer: a change
 * refreshes the reads its key names at once (the dashboard, controls,
 * notifications, history, agents and the other projects' health, #729), and
 * while the stream is healthy those reads poll only as a fallback. Bound in
 * an effect, not a memo, because it
 * opens a connection that must close when the project or the page goes. It
 * is open only while the tab is visible. A browser without EventSource (and
 * the server render) just polls. The remote page waits on `GET /api/versions`
 * instead (`version-wait.ts`, #731).
 */
export function useLiveStream(project: string, loops: readonly string[]): LiveStatus {
  // A key's refresh and livePoll must drive the layer its reads are on, and
  // since #734 every key's reads (the loop controls too) are on the Query layer.
  const queryStore = useQueryStore();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const p = shellProject();
  // A key of the values, not the array: the caller builds a fresh list each render.
  const readsKey = JSON.stringify([project, p, loops]);
  const reads = useMemo(() => {
    const [shell, screen, names] = JSON.parse(readsKey) as [string, string | null, string[]];
    return liveReads(shell, screen, names);
  }, [readsKey]);
  // The stream opens on `project` alone; the roster reaches it through these refs.
  const readsRef = useRef(reads);
  readsRef.current = reads;
  const liveRef = useRef<LiveStream | null>(null);
  useEffect(() => {
    const remote = isRemote();
    // The remote page long-polls the versions with fetch: it needs no EventSource.
    if (!remote && typeof EventSource === "undefined") {
      setStatus("fallback");
      return;
    }
    let live: LiveStream | null = null;
    let unsubscribe = (): void => {};
    // The local server speaks HTTP/1.1, where a browser allows six connections
    // per host across every tab: a stream held by each background tab would
    // starve the page's own fetches. So the stream is open only while the tab
    // is shown; hidden, the store polls nothing at all (#725).
    const open = (): void => {
      if (live !== null) return;
      // The hosted function relays no stream; it holds a versions read until a key moves (#731).
      const versionWait = (): LiveSource =>
        versionWaitSource({ url: versionsUrl(project), keys: () => Object.keys(readsRef.current) });
      const bound = bindLiveStream({
        store: queryStore(),
        url: streamUrl(project),
        reads: readsRef.current,
        slowMs: SLOW_POLL_MS,
        ...(remote ? { openSource: versionWait } : {}),
        // No refresh on open when the tab is shown again: the store already
        // re-reads every polling read on show (#725), and a second refresh
        // here would read the heaviest URL twice per return to the tab.
      });
      live = bound;
      liveRef.current = bound;
      setStatus(bound.status());
      unsubscribe = bound.subscribe(() => setStatus(bound.status()));
    };
    const shut = (): void => {
      unsubscribe();
      unsubscribe = () => {};
      live?.close();
      live = null;
      liveRef.current = null;
      // Unseen while hidden; never "fallback" merely because the tab is.
      setStatus("connecting");
    };
    const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";
    const onVisibility = (): void => {
      if (hidden()) shut();
      else open();
    };
    if (!hidden()) open();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      live?.close();
      live = null;
      liveRef.current = null;
    };
  }, [queryStore, project]);
  // A roster change re-keys the open stream; it never reopens it.
  useEffect(() => {
    liveRef.current?.setReads(reads);
  }, [reads]);
  return status;
}

export const useProjects = (): Polled<ProjectsView> => usePolled(projectsRead());
export const useProjectsHealth = (selected: string): Polled<ProjectsHealthView> => usePolled(projectsHealthRead(selected));
export const useProjectSetup = (project: string): Polled<ProjectSetupView> => usePolled(projectSetupRead(project));
/** Local only: the remote page has no sleep route, so it reads nothing. */
export const useProjectSleep = (project: string): Polled<ProjectSleepView> => usePolled(projectSleepRead(project, isRemote()));
/** Local only: the accounts live on this machine, so the remote page reads nothing. */
export const useClaudeAccounts = (project: string): Polled<ClaudeAccountsView> => usePolled(claudeAccountsRead(project, isRemote()));
export const useBridgeStatus = (project: string): Polled<BridgeStatusView> => usePolled(bridgeStatusRead(project, isRemote()));
export const useUsage = (): Polled<ProjectUsageReport> => usePolled(usageRead(shellProject()));
/** The Sentinel panel's snapshot (#685); relayed, so the remote page polls it too. */
export const useSentinelPanel = (): Polled<SentinelPanelView> => usePolled(sentinelRead(shellProject()));
/** The Evals tab's runs (#801); relayed, so the remote page polls it too. */
export const useEvals = (): Polled<EvalsView> => usePolled(evalsRead(shellProject()));
/** The Evals tab's Test set (#856); relayed, so the remote page polls it too. */
export const useEvalSet = (): Polled<EvalSetView> => usePolled(evalSetRead(shellProject()));
/** The Evals tab's Suggestions (#858); relayed, so the remote page polls it too. */
export const useEvalSuggestions = (): Polled<EvalSuggestionsView> => usePolled(evalSuggestionsRead(shellProject()));
/** The Evals tab's Inbox (#872); relayed, so the remote page polls it too. */
export const useEvalInbox = (): Polled<EvalInboxView> => usePolled(evalInboxRead(shellProject()));
/** The Evals tab's Proposals (#874); relayed, so the remote page polls it too. */
export const useEvalProposals = (): Polled<EvalProposalsView> => usePolled(evalProposalsRead(shellProject()));
/** The edit form's case detail: local only, so the caller passes null on the remote page and while no form is open. */
export const useEvalSetCase = (id: string | null): OneShot<EvalSetCaseDetail> =>
  useOneShot(id === null ? null : evalSetCaseRead(shellProject(), id));
/** The page's memory of which projects' batched control route is missing (#615): it lasts the session. */
const controlsFallback = createControlsFallback();

/**
 * One loop's control view, picked from the project's batched read so every
 * card shares one request a tick; per loop once that route is found missing.
 * Through the Query layer (#734), where the change stream refreshes it.
 */
export function useLoopControl(loop: string): Polled<ControlView> {
  const supplied = useContext(ReadStoreContext);
  const project = shellProject();
  const binding = useMemo(
    () => bindLoopControl(() => supplied ?? getDefaultQueryReads(), project, loop, controlsFallback),
    [supplied, project, loop],
  );
  const read = useSyncExternalStore(binding.subscribe, binding.getSnapshot, loadingSnapshot);
  return { read, refresh: binding.refresh };
}
export const useNotifications = (): Polled<NotificationsView> => usePolled(notificationsRead(shellProject()));
export const useLoopNotifications = (loop: string): Polled<NotificationFeed> => usePolled(loopNotificationsRead(shellProject(), loop));
export const useLoopHistory = (loop: string): Polled<HistoryView> => usePolled(loopHistoryRead(shellProject(), loop));
/** Carries the busy flag for the roster PR step's Refresh, which spins while a read is out. */
export function useAgents(): Polled<AgentsView> & { busy: boolean } {
  const target = agentsRead(shellProject());
  const store = useQueryStore();
  return { ...useReadOn(store, target), busy: useReadBusyOn(store, target) };
}
/** The labels page draws a busy Refresh button, so this read alone carries the flag. */
export function useLabels(): Polled<LabelsView> & { busy: boolean } {
  const target = labelsRead(shellProject());
  const store = useQueryStore();
  return { ...useReadOn(store, target), busy: useReadBusyOn(store, target) };
}
export const useIntake = (project: string): Polled<IntakeView> => usePolled(intakeRead(project));
export const useIntakeSession = (project: string): Polled<IntakeSessionView> => usePolled(intakeSessionRead(project));
export const useIntakeMetrics = (project: string, open: boolean): Polled<IntakeMetricsView> =>
  usePolled(intakeMetricsRead(project, open));

/**
 * Asking the harnesses is local only: the remote page reads nothing. It
 * carries the busy flag because a Refresh re-read keeps the old catalogue on
 * screen, and the lineup editor's button spins while the harnesses answer.
 */
export function useLineupCatalog(refresh: boolean): OneShot<HarnessCatalogView> & { busy: boolean } {
  const target = isRemote() ? null : lineupCatalogRead(shellProject(), refresh);
  const store = useQueryStore();
  return { ...useOneShot(target), busy: useReadBusyOn(store, target) };
}
export const useLineup = (loop: string, role?: string): OneShot<LineupRead> => useOneShot(lineupRead(shellProject(), loop, role));
/** Local only, like the catalogue: it reads this host's models.json and Claude Code binary. */
export const useModelUpdates = (): OneShot<ModelUpdatesView> =>
  useOneShot(isRemote() ? null : modelUpdatesRead(shellProject()));
export const useVerifier = (): OneShot<VerifierView> => useOneShot(verifierRead(shellProject()));
export const useSentinel = (): OneShot<SentinelView> => useOneShot(sentinelRulesRead(shellProject()));
export const useJav = (): OneShot<JavView> => useOneShot(javRead(shellProject()));
/** Scoped to the project the Settings page is open on, which the page is handed. */
export const useProjectSettings = (project: string): OneShot<ProjectSettingsView> => useOneShot(settingsRead(project));
/** The Prompts section's read, scoped like the overview's to the page's project. */
export const useProjectPrompts = (project: string): OneShot<ProjectPromptsView> => useOneShot(promptsRead(project));
export const useAgentGuide = (): OneShot<GuideView> => useOneShot(agentGuideRead(shellProject()));
/** The defaults come from the checkout the PR is opened from; the remote page has neither. */
export const useSetupDefaults = (): OneShot<SetupDefaultsView> =>
  useOneShot(isRemote() ? null : setupDefaultsRead(shellProject()));
/** Listed only while the GitHub picker is open; `busy` so a retry after a failure shows it is asking. */
export function useGithubRepos(enabled: boolean): OneShot<GithubReposView> & { busy: boolean } {
  const target = enabled ? githubReposRead() : null;
  const store = useQueryStore();
  return { ...useOneShot(target), busy: useReadBusyOn(store, target) };
}
