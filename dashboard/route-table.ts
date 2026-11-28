/**
 * The one index of the remote dashboard's HTTP routes (spec #618, "Route table
 * module"): every path, the methods it answers, and what each one does —
 * a snapshot read, a projection of one, a relayed command, a local-only 403,
 * the withheld output stream, or a route only the hosted function serves.
 *
 * Today each surface keeps its own list, and they drift. This table is what
 * exists. The remote handler (`remote/handler.ts`) reads it, and so do the
 * bridge's collector and relay (#629), whose snapshot and command lists are
 * derived below, and the local server's inline GETs and projections
 * (`server.ts`, #630), and the design preview's command routes (`preview.ts`,
 * #631), whose GET coverage `preview.test.ts` pins against it.
 *
 * It sits beside `routes.ts` rather than extending it because `routes.ts` must
 * keep zero imports, and a row here names contract types and the command
 * parsers. It may import only `./contracts`, the parser leaf
 * `./command-requests` and the overview projection `./overview` (which itself
 * reaches only the contracts): the Vercel function bundles it and so will
 * the UI's browser bundle, so no `node:` module, no package and no CLI, filesystem or
 * process code may sit behind it. That is also why `/api/projects/health` is
 * spelled as a literal below instead of read from `routes.ts`; the test pins
 * that the two agree.
 */
import {
  type Dashboard,
  type DashboardLoop,
  type EvalPatchesView,
  type FrontierRead,
  type NotificationFeed,
  type NotificationsView,
  type Ownership,
  type ProjectsHealthView,
  type RelayedCommandKind,
  type SnapshotKey,
} from "./contracts";
import { COMMAND_PARSERS } from "./command-requests";
import { overviewOf } from "./overview";

export type RouteScope = "global" | "project" | "loop";
export type RouteMethod = "GET" | "POST" | "DELETE";

/**
 * A derived route's projection, called uniformly: the parsed source snapshot
 * and the request's loop and query. `found: false` is the `no loop '<name>'`
 * 404 of the panel and feed routes, unless it carries `why`: then that is the
 * 404's message. A `contentType` answers the body (a string) as that type
 * rather than as JSON — a relayed eval patch is a diff, not a document.
 */
export type ProjectionResult =
  | { found: true; body: unknown; contentType?: string }
  | { found: false; why?: string };

export type Projection = (
  source: unknown,
  input: { loop: string; search: URLSearchParams },
) => ProjectionResult;

/* ------------------------------------------------------------- projections */

export const ownershipOf = (dashboard: Dashboard): Ownership => dashboard.ownership;

export const frontierOf = (dashboard: Dashboard): FrontierRead | null => dashboard.frontier;

export const loopPanelOf = (dashboard: Dashboard, loop: string): DashboardLoop | undefined =>
  dashboard.loops.find((entry) => entry.loop === loop);

export const loopFeedOf = (notifications: NotificationsView, loop: string): NotificationFeed | undefined =>
  notifications.loops.find((entry) => entry.loop === loop);

export const healthWithout = (health: ProjectsHealthView, selected: string | null): ProjectsHealthView => ({
  selected,
  projects: health.projects.filter((entry) => entry.project !== selected),
});

const found = (body: unknown): { found: true; body: unknown } => ({ found: true, body });
const maybe = (body: unknown): { found: true; body: unknown } | { found: false } =>
  body === undefined ? { found: false } : found(body);

/**
 * One trial's patch out of the relayed `evals-patches` snapshot, as a diff.
 * The remote page has no other way to reach it, so each miss says why and
 * points at the local dashboard, which reads the patch off the host.
 */
export const evalPatchOf = (view: EvalPatchesView, search: URLSearchParams): ProjectionResult => {
  if (!view.enabled) {
    // A failed read on the machine is not an opt-out: say which it was.
    if (view.problem !== null && view.problem !== undefined) {
      return { found: false, why: `the machine could not read the relayed eval patches (${view.problem}); open the patch on the local dashboard` };
    }
    return { found: false, why: "this project does not relay eval patches; open the patch on the local dashboard" };
  }
  const run = search.get("run") ?? "";
  const ticket = search.get("case") ?? "";
  const arm = search.get("arm") ?? "";
  const trial = `${run}/${ticket}/${arm}`;
  const patch = view.patches.find((entry) => entry.run === run && entry.case === ticket && entry.arm === arm);
  if (patch === undefined) {
    return {
      found: false,
      why: `no relayed patch for trial ${trial}: it may have been left out of the relayed snapshot to keep it within its size budget; open it on the local dashboard`,
    };
  }
  // A cut patch says so where the reader looks, as a line `git apply` would not mistake for a hunk.
  const note = patch.truncated
    ? `${patch.text.endsWith("\n") ? "" : "\n"}# patch cut at the relay budget; open it on the local dashboard for the rest\n`
    : "";
  return { found: true, body: patch.text + note, contentType: "text/x-diff; charset=utf-8" };
};

export type ProjectionName =
  | "overview"
  | "ownership"
  | "frontier"
  | "loop-panel"
  | "loop-feed"
  | "health-without-selected"
  | "eval-patch";

/** The named projections a derived row can carry, each wrapped for a uniform call. */
export const PROJECTIONS: Record<ProjectionName, Projection> = {
  overview: (source) => found(overviewOf(source as Dashboard)),
  ownership: (source) => found(ownershipOf(source as Dashboard)),
  frontier: (source) => found(frontierOf(source as Dashboard)),
  "loop-panel": (source, { loop }) => maybe(loopPanelOf(source as Dashboard, loop)),
  "loop-feed": (source, { loop }) => maybe(loopFeedOf(source as NotificationsView, loop)),
  "health-without-selected": (source, { search }) =>
    found(healthWithout(source as ProjectsHealthView, search.get("selected"))),
  "eval-patch": (source, { search }) => evalPatchOf(source as EvalPatchesView, search),
};

/* -------------------------------------------------------------------- rows */

/** What the hosted function alone serves: none of these has a local twin to relay to. */
export type RemoteOnlyServes =
  | "bridge"
  | "versions"
  | "command-view"
  | "intake-metrics"
  | "intake-session"
  | "intake-login"
  | "intake-logout";

export type RouteAction =
  /** `key` may hold `<loop>`, standing for the request's loop (as `remote/collect.ts` spells it). */
  | { kind: "snapshot"; key: SnapshotKey }
  | { kind: "derived"; source: SnapshotKey; projection: ProjectionName }
  | { kind: "command"; command: RelayedCommandKind; parse: (body: unknown) => unknown }
  | { kind: "local-only"; label: string }
  | { kind: "output" }
  | { kind: "stream" }
  | { kind: "remote-only"; serves: RemoteOnlyServes };

export type RouteRow = RouteAction & {
  method: RouteMethod;
  /** The unscoped path; `<loop>` or `<id>` stands for one path segment. */
  path: string;
  scope: RouteScope;
  /** One of the intake page's routes, the only ones `surface: "intake"` serves. */
  intake: boolean;
  /** A command the remote dashboard relays to the machine. */
  relays: boolean;
  /** A route the remote dashboard answers with a 403. */
  localOnly: boolean;
  /**
   * Where a loop row's loop name comes from: its `<loop>` path segment, or the
   * `loop` query parameter (defaulting to `""`). Null on non-loop rows.
   */
  loopFrom: "path" | "query" | null;
  /**
   * The snapshot key the local bridge reads at this row's path and stores, or
   * null when the bridge reads nothing here. A snapshot row collects its own
   * key; a non-snapshot row collects only where it says so.
   */
  collects: SnapshotKey | null;
};

type Base = Pick<RouteRow, "method" | "path" | "scope">;

const row = (
  base: Base,
  action: RouteAction,
  extra: Partial<Pick<RouteRow, "intake" | "loopFrom" | "collects">> = {},
): RouteRow => ({
  ...base,
  ...action,
  intake: extra.intake ?? false,
  relays: action.kind === "command",
  localOnly: action.kind === "local-only",
  loopFrom: extra.loopFrom ?? (base.scope === "loop" ? "path" : null),
  collects: action.kind === "snapshot" ? action.key : (extra.collects ?? null),
});

const snapshot = (scope: RouteScope, path: string, key: SnapshotKey, loopFrom?: "path" | "query"): RouteRow =>
  row({ method: "GET", path, scope }, { kind: "snapshot", key }, loopFrom === undefined ? {} : { loopFrom });

const derived = (scope: RouteScope, path: string, source: SnapshotKey, projection: ProjectionName): RouteRow =>
  row({ method: "GET", path, scope }, { kind: "derived", source, projection });

const command = (path: string, kind: RelayedCommandKind): RouteRow =>
  row({ method: "POST", path, scope: "project" }, { kind: "command", command: kind, parse: COMMAND_PARSERS[kind] });

/** The label is what the 403 names: the method and the unscoped path. */
const localOnly = (scope: RouteScope, method: RouteMethod, path: string): RouteRow =>
  row({ method, path, scope }, { kind: "local-only", label: `${method} ${path}` });

const remoteOnly = (method: RouteMethod, path: string, serves: RemoteOnlyServes, intake = false): RouteRow =>
  row({ method, path, scope: "project" }, { kind: "remote-only", serves }, { intake });

/**
 * Every route, one row per (method, path); GET before POST or DELETE, the
 * order of a 405's `allow`.
 */
export const ROUTE_TABLE: readonly RouteRow[] = [
  // The relayed commands.
  command("/api/control", "control"),
  command("/api/start", "start"),
  command("/api/restart", "restart"),
  command("/api/stop-now", "stop-now"),
  command("/api/resume-work", "resume-work"),
  command("/api/agents/start", "agent-start"),
  command("/api/notifications/read", "mark-read"),
  // An eval run (#801): started and stopped from either page, since a run
  // only ever replays work on this host and publishes nothing.
  command("/api/evals/start", "eval-start"),
  command("/api/evals/stop", "eval-stop"),
  // Curating the test set (#856): a command request, so the remote page
  // relays it like a run's start (#802); each writes one commit to the
  // committed case files on this host.
  command("/api/evals/set/add", "eval-set-add"),
  command("/api/evals/set/edit", "eval-set-edit"),
  command("/api/evals/set/retire", "eval-set-retire"),
  command("/api/evals/set/check", "eval-set-check"),
  command("/api/evals/set/keep", "eval-set-keep"),
  command("/api/evals/inbox/add", "eval-inbox-add"),
  command("/api/evals/inbox/start", "eval-inbox-start"),
  command("/api/evals/inbox/dismiss", "eval-inbox-dismiss"),
  command("/api/evals/improve/propose", "eval-improve-propose"),
  command("/api/evals/set/calibrate", "eval-set-calibrate"),
  command("/api/evals/proposals/open-pr", "eval-proposal-open-pr"),

  // The project's snapshots and their projections, in the order the bridge
  // reads and pushes them: the dashboard and the loops' controls first, so a
  // push cut short by a lost lease has already sent what the overview draws.
  // The full dashboard is `/api/dashboard`, the one read the bridge collects
  // as `dashboard`; `/api/loops` is its overview (#67), capped so the page's
  // most frequent read stays small, and projected from the same snapshot.
  snapshot("project", "/api/dashboard", "dashboard"),
  derived("project", "/api/loops", "dashboard", "overview"),
  // The page's change stream (#724): invalidations only, a version per read
  // key and never a body, so the page re-reads through the rows above and a
  // dropped stream costs nothing but its polling interval.
  row({ method: "GET", path: "/api/stream", scope: "project" }, { kind: "stream" }),
  derived("project", "/api/ownership", "dashboard", "ownership"),
  derived("project", "/api/frontier", "dashboard", "frontier"),
  snapshot("project", "/api/controls", "controls"),

  // The panel the dashboard read names, or the loop's 404, locally and remotely.
  derived("loop", "/api/loops/<loop>", "dashboard", "loop-panel"),
  snapshot("loop", "/api/loops/<loop>/control", "control/<loop>"),
  snapshot("loop", "/api/loops/<loop>/checkout", "checkout/<loop>"),
  snapshot("loop", "/api/loops/<loop>/history", "history/<loop>"),
  // As `records-routes.ts`: the merged view carries each loop's own feed.
  derived("loop", "/api/loops/<loop>/notifications", "notifications", "loop-feed"),
  row({ method: "GET", path: "/api/loops/<loop>/output", scope: "loop" }, { kind: "output" }),

  snapshot("project", "/api/notifications", "notifications"),
  snapshot("project", "/api/usage", "usage"),
  snapshot("project", "/api/setup", "setup"),
  localOnly("project", "POST", "/api/setup"),
  snapshot("project", "/api/agents", "agents"),
  localOnly("project", "POST", "/api/agents"),
  // The one loop route whose loop is a query parameter, not a path segment.
  snapshot("loop", "/api/lineup", "lineup/<loop>", "query"),
  snapshot("project", "/api/roots", "roots"),
  snapshot("project", "/api/jav", "jav"),
  // The Settings overview is a read, so the bridge collects it and the remote
  // dashboard serves it (#689: reads may be relayed).
  snapshot("project", "/api/settings", "settings"),
  // The Settings Prompts section is a read as well, relayed under its own key
  // (#695): its renders cost a process per role, so they stay out of the
  // overview's body, and the remote page shows the same prompts the host does.
  snapshot("project", "/api/settings/prompts", "prompts"),
  // The Sentinel panel is a read too, so it is relayed (#685): the view carries
  // the rules and the issue store's titles and counts, never a draft's body or
  // the reporter's evidence.
  snapshot("project", "/api/sentinel", "sentinel"),
  // The Evals tab (#801): a summary of every run — scores, verdicts, the
  // analyst's notes — and never a diff, so any project's may be relayed.
  snapshot("project", "/api/evals", "evals"),
  // The trials' patches (#825), collected by the bridge like any read: the
  // local route puts no patch text in it unless the project set
  // `relayEvalPatches`, and the collector's scrubber runs on every byte either way.
  snapshot("project", "/api/evals/patches", "evals-patches"),
  // A trial's patch is the project's code: it reaches the remote page only
  // from the relayed snapshot of a project that opted in. The local server
  // serves this path itself (evals-routes.ts), before the table.
  derived("project", "/api/evals/patch", "evals-patches", "eval-patch"),
  // The Test set screen (#856): a summary of the committed cases. As #801's
  // remote rule, `evals-set.ts view` drops each case's reason and notes unless
  // the project set `relayEvalPatches`, and it never carries a reference
  // diff, held-out test paths, check text or a ticket body (#802).
  snapshot("project", "/api/evals/set", "evals-set"),
  // The Suggestions screen (#858): merged PRs ranked by how the loop struggled
  // on them. Each row carries the PR's title, link and the struggle reasons
  // only, never a diff or a ticket body, so it is safe to relay.
  snapshot("project", "/api/evals/suggestions", "evals-suggestions"),
  // The recommended-runs inbox (#872): each row carries the plan's source
  // kind and counts and the recommender's reason, never the plan, a diff or a
  // path, so every project's is relayed, opted into patches or not.
  snapshot("project", "/api/evals/inbox", "evals-inbox"),
  // The improver's proposals (#874): rows carry goal, kind, status, verdict
  // and reasons; the rationale and the analyst's improvements only when the
  // project set `relayEvalPatches`; never overlay content, a lineup or a diff.
  snapshot("project", "/api/evals/proposals", "evals-proposals"),
  remoteOnly("GET", "/api/bridge", "bridge"),
  // The remote page's version-wait (#731): the hosted function holds the
  // request until one of the page's read keys changes version, so the page
  // waits for a push instead of polling every read every 5 s. It reads the
  // version columns alone, so a wait costs no snapshot egress.
  remoteOnly("GET", "/api/versions", "versions"),

  // The intake page (felipearos/ralph#459): the tickets as a snapshot, the
  // metrics only to a session the metrics password opened. A project with no
  // clerk answers an unavailable view of a few hundred bytes, not an error.
  row({ method: "GET", path: "/api/intake", scope: "project" }, { kind: "snapshot", key: "intake" }, { intake: true }),
  // The bridge still collects the metrics: the hosted function serves that
  // stored key, but only behind the metrics password (remote/handler.ts).
  row(
    { method: "GET", path: "/api/intake/metrics", scope: "project" },
    { kind: "remote-only", serves: "intake-metrics" },
    { intake: true, collects: "intake-metrics" },
  ),
  remoteOnly("GET", "/api/intake/session", "intake-session", true),
  remoteOnly("POST", "/api/intake/login", "intake-login", true),
  remoteOnly("POST", "/api/intake/logout", "intake-logout", true),

  localOnly("project", "GET", "/api/setup/defaults"),
  localOnly("project", "GET", "/api/lineup/catalog"),
  // One test-set case's tags, reason and notes for the edit form (#856): the
  // notes are graded-only and may not leave the host on a project whose
  // relayed set is a summary, so this read is never collected or relayed.
  localOnly("project", "GET", "/api/evals/set/case"),
  // Which agents run an older Claude model (#851): read off this host's
  // `models.json` and its installed Claude Code binary, so it is not relayed.
  localOnly("project", "GET", "/api/lineup/updates"),
  // The Add-agent guide is read off the harness checkout, and a pending
  // agent's preflight runs in its worktree: both exist only on the machine,
  // so neither is in the snapshot and neither is relayed. The readiness
  // items themselves ride on `/api/agents` above, which IS a snapshot.
  localOnly("project", "GET", "/api/agents/guide"),
  localOnly("project", "GET", "/api/agents/preflight"),
  // The verifier's rules are read off the machine's base branch and its POST
  // opens a PR there, so neither is in the snapshot nor relayed
  // (agents-routes.ts VERIFIER_PATH).
  localOnly("project", "GET", "/api/agents/verifier"),
  localOnly("project", "POST", "/api/agents/verifier"),
  // The sentinel's rules form likewise: read off the machine's base branch,
  // and its POST opens a PR there (agents-routes.ts SENTINEL_PATH). Only the
  // panel's GET /api/sentinel is relayed.
  localOnly("project", "GET", "/api/agents/sentinel"),
  localOnly("project", "POST", "/api/agents/sentinel"),
  // Saving project settings opens a config PR from the machine's checkout
  // (agents-routes.ts SETTINGS_PROJECT_PATH); only the GET overview is relayed.
  localOnly("project", "POST", "/api/settings/project"),
  // Running a gate executes its command on this host, in the project's
  // checkout (agents-routes.ts SETTINGS_GATE_RUN_PATH), so neither starting
  // a run nor reading it is relayed; only the gates list, inside the GET
  // /api/settings snapshot, is.
  localOnly("project", "GET", "/api/settings/gates/run"),
  localOnly("project", "POST", "/api/settings/gates/run"),
  // The worktrees folder writes this host's project registry, and a path only
  // means something on this machine (agents-routes.ts SETTINGS_WORKTREES_PATH).
  localOnly("project", "POST", "/api/settings/worktrees"),
  // Clean up worktrees removes git registrations on this host, for paths only
  // this machine has (agents-routes.ts SETTINGS_WORKTREES_CLEANUP_PATH).
  localOnly("project", "POST", "/api/settings/worktrees/cleanup"),

  localOnly("project", "POST", "/api/setup/validate"),
  // The Tracker connector carries a Linear or Jira token: it stays on the
  // machine whose credential store it writes, and is never relayed.
  localOnly("project", "POST", "/api/setup/tracker/test"),
  localOnly("project", "POST", "/api/setup/tracker/save"),
  localOnly("project", "POST", "/api/agents/delete"),
  // Create checkout makes a worktree, which stays local like Add agent.
  localOnly("project", "POST", "/api/agents/checkout"),
  // Rerun setup runs the project's worktreeSetup commands on this host, in a
  // worktree only this machine has: never relayed.
  localOnly("project", "POST", "/api/agents/setup"),
  localOnly("project", "POST", "/api/doctor"),
  localOnly("project", "POST", "/api/lineup/preview"),
  localOnly("project", "POST", "/api/lineup/edit"),
  localOnly("project", "POST", "/api/lineup/save"),
  // The operator's answer writes this host's `models.json`, like a save.
  localOnly("project", "POST", "/api/lineup/updates/answer"),
  localOnly("project", "POST", "/api/jav/save"),
  // The project's sleep (project-sleep-routes.ts): read and set through the
  // harness's CLI on this machine. Neither is collected nor relayed in this
  // first version, so the remote page offers no Sleep project.
  localOnly("project", "GET", "/api/sleep"),
  localOnly("project", "POST", "/api/sleep"),
  // The host's Claude accounts (claude-accounts-routes.ts): the registry, the
  // logins and the override live on this machine, so neither is relayed.
  localOnly("project", "GET", "/api/claude-accounts"),
  localOnly("project", "POST", "/api/claude-accounts"),
  // Filing a learning as a ticket (learnings-file-routes.ts) publishes from
  // this machine's harness checkout and opens an issue with its `gh`: never
  // relayed, so the remote page offers no File ticket.
  localOnly("project", "POST", "/api/learnings/file"),

  // Read off the machine's GitHub CLI (agents-routes.ts LABELS_PATH), so it is
  // neither in the snapshot nor relayed.
  localOnly("project", "GET", "/api/labels"),
  // The unblocker chat (chat-routes.ts) runs claude sessions on the machine:
  // a session, its turns and its event stream exist only there, so none of
  // it is collected or relayed.
  localOnly("project", "POST", "/api/chat"),
  localOnly("project", "GET", "/api/chat/<id>"),
  localOnly("project", "DELETE", "/api/chat/<id>"),
  localOnly("project", "POST", "/api/chat/<id>/turn"),
  localOnly("project", "GET", "/api/chat/<id>/events"),
  localOnly("project", "POST", "/api/chat/<id>/mode"),
  localOnly("project", "POST", "/api/chat/<id>/stop-and-fix"),
  localOnly("project", "POST", "/api/chat/<id>/handback"),

  remoteOnly("GET", "/api/commands/<id>", "command-view"),

  // The routes served only at the top level, beside the project list.
  snapshot("global", "/api/projects", "_/projects"),
  localOnly("global", "POST", "/api/projects"),
  // The selected project is left out, as locally: the page polls its full snapshot.
  // The bridge reads the whole view once, with no `selected`, and stores it as
  // `_/health`; the projection leaves the selected project out per request.
  row(
    { method: "GET", path: "/api/projects/health", scope: "global" },
    { kind: "derived", source: "_/health", projection: "health-without-selected" },
    { collects: "_/health" },
  ),
  localOnly("global", "POST", "/api/projects/remove"),
  // The folder dialog would open on the machine, not in front of whoever is remote.
  localOnly("global", "POST", "/api/projects/pick-folder"),
  localOnly("global", "GET", "/api/github/repos"),
];

/* ------------------------------------------------------------ bridge lists */

/** One read the local bridge makes and stores: `<loop>` in key and path stands for each loop. */
export interface SnapshotRoute {
  scope: RouteScope;
  key: SnapshotKey;
  path: string;
}

/**
 * Every snapshot the bridge collects, global rows first so the bridge's
 * dashboard-down probe (`SNAPSHOT_ROUTES[0]`) reads `_/projects`, which every
 * dashboard serves; the rest in table order, which is the order the bridge
 * reads and pushes them (`collect.test.ts` pins it).
 */
export const SNAPSHOT_ROUTES: readonly SnapshotRoute[] = (() => {
  const collected = ROUTE_TABLE.filter((entry) => entry.method === "GET" && entry.collects !== null);
  const ordered = [
    ...collected.filter((entry) => entry.scope === "global"),
    ...collected.filter((entry) => entry.scope !== "global"),
  ];
  return ordered.map((entry) => ({
    scope: entry.scope,
    key: entry.collects!,
    path: entry.loopFrom === "query" ? `${entry.path}?loop=<loop>` : entry.path,
  }));
})();

/** The path each relayed command is posted to on the machine, one per kind. */
export const RELAY_ROUTES: Readonly<Record<RelayedCommandKind, string>> = Object.fromEntries(
  ROUTE_TABLE.flatMap((entry) => (entry.kind === "command" ? [[entry.command, entry.path] as const] : [])),
) as Record<RelayedCommandKind, string>;

/** The (method, path) pairs the remote dashboard refuses with a 403. */
export const LOCAL_ONLY_ROUTES: readonly { method: RouteMethod; path: string }[] = ROUTE_TABLE.filter(
  (entry) => entry.localOnly,
).map((entry) => ({ method: entry.method, path: entry.path }));

/* ---------------------------------------------------------------- matching */

export interface RouteParams {
  loop?: string;
  id?: string;
}

export interface RouteMatch {
  /** Every method on the matched path, in table order. */
  rows: RouteRow[];
  params: RouteParams;
}

const PLACEHOLDER = /<(loop|id)>/g;

interface PathPattern {
  path: string;
  pattern: RegExp;
  names: ("loop" | "id")[];
  rows: RouteRow[];
}

/** One pattern per path, each placeholder one non-empty segment. */
const PATTERNS: PathPattern[] = (() => {
  const byPath = new Map<string, PathPattern>();
  for (const entry of ROUTE_TABLE) {
    let pattern = byPath.get(entry.path);
    if (pattern === undefined) {
      const names = [...entry.path.matchAll(PLACEHOLDER)].map((match) => match[1] as "loop" | "id");
      const source = entry.path
        .split(PLACEHOLDER)
        .map((part, index) => (index % 2 === 1 ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      pattern = { path: entry.path, pattern: new RegExp(`^${source}$`), names, rows: [] };
      byPath.set(entry.path, pattern);
    }
    pattern.rows.push(entry);
  }
  return [...byPath.values()];
})();

const inScope = (row: RouteRow, scope: "global" | "project"): boolean =>
  scope === "global" ? row.scope === "global" : row.scope !== "global";

/**
 * The rows an unscoped path names at the top level (`global`) or under a
 * project (`project`, which serves the loop rows too), with its placeholders
 * decoded; null when nothing there serves it. `keep` narrows the rows BEFORE
 * any segment is decoded, so a surface that serves a few rows (the intake
 * deployment, the unconfigured function's bridge) answers a malformed escape
 * on a path it does not serve with its 404, not the decoder's 500.
 */
export function matchRoute(
  unscopedPath: string,
  scope: "global" | "project",
  keep: (row: RouteRow) => boolean = () => true,
): RouteMatch | null {
  for (const candidate of PATTERNS) {
    const match = candidate.pattern.exec(unscopedPath);
    if (match === null) continue;
    const rows = candidate.rows.filter((entry) => inScope(entry, scope) && keep(entry));
    if (rows.length === 0) continue;
    const params: RouteParams = {};
    candidate.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]!);
    });
    return { rows, params };
  }
  return null;
}

/** Whether one method on one path relays or stays local: plain data for the UI's writes. */
export function routeFlags(method: RouteMethod, unscopedPath: string): { relays: boolean; localOnly: boolean } | null {
  for (const scope of ["global", "project"] as const) {
    const entry = matchRoute(unscopedPath, scope)?.rows.find((candidate) => candidate.method === method);
    if (entry !== undefined) return { relays: entry.relays, localOnly: entry.localOnly };
  }
  return null;
}

/** The loop a row addresses, from where its `loopFrom` says; `""` when it names none. */
export function loopOf(row: RouteRow, params: RouteParams, search: URLSearchParams): string {
  if (row.loopFrom === "query") return search.get("loop") ?? "";
  if (row.loopFrom === "path") return params.loop ?? "";
  return "";
}

/** A snapshot row's stored key, with `<loop>` resolved for this request. */
export function snapshotKeyOf(
  row: RouteRow & { kind: "snapshot" },
  params: RouteParams,
  search: URLSearchParams,
): SnapshotKey {
  // A replacer function, so a `$&` or `$$` in a loop name lands in the key as it is.
  const loop = loopOf(row, params, search);
  return row.key.replace("<loop>", () => loop) as SnapshotKey;
}
