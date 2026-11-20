import type { ReactNode } from "react";
import { Outlet, createRootRoute, createRoute, createRouter, redirect, type RouterHistory } from "@tanstack/react-router";

/**
 * The pages the route tree mounts. Injected rather than imported so a test can
 * build the tree with the real paths in node, where app.tsx (its UI kit, its
 * CSS) does not load; router.tsx passes the real components.
 */
export interface RoutePages {
  /** The project chrome; it puts `<Outlet/>` where the page body goes. */
  App: () => ReactNode;
  Agents: () => ReactNode;
  Loop: () => ReactNode;
  /** The project's overview pages, one typed route each at `/p/$project/<id>`. */
  overview: Record<OverviewPageId, () => ReactNode>;
  Settings: () => ReactNode;
  States: () => ReactNode;
  /** The All projects floor, at the unscoped `/factory`. */
  Floor: () => ReactNode;
  /** What `/` and an unscoped old bookmark draw while the landing redirect moves into the remembered project. */
  Landing: () => ReactNode;
  /** The intake surface at `/p/$project/intake`, drawn without the project chrome. */
  Intake: () => ReactNode;
  /**
   * Starts the reads a page draws first, so a link hovered or focused before
   * it is followed opens on data rather than a skeleton. Optional: a tree
   * built without it loads its pages as before.
   */
  preload?: (screen: Screen, project: string | null) => void;
}

/**
 * The overview pages that have their own route, by the path segment each sits
 * at. A runtime list, not just a type, so `screenOf` can tell an overview
 * route from an unknown one by its id.
 */
const OVERVIEW_PAGE_IDS = ["notifications", "usage", "backlog", "ci", "learnings", "evals", "ownership", "reconciliation", "labels"] as const;
export type OverviewPageId = (typeof OVERVIEW_PAGE_IDS)[number];
const isOverviewPageId = (id: string): id is OverviewPageId => (OVERVIEW_PAGE_IDS as readonly string[]).includes(id);

/** The dashboard's routes, code-based: the paths stay the ones the hand-written router accepted before spec #723. */
export function buildRouteTree(pages: RoutePages) {
  const { preload } = pages;
  // What every route that draws a page loads: it reads the screen the way the
  // chrome will once committed, and only starts the reads. Never awaited,
  // never thrown: a failed prefetch must not block or blank the navigation.
  // Each route calls it through its own untyped arrow, since a loader with a
  // declared parameter would feed the route's params inference and erase the
  // ones its path gives it.
  const preloadPage = ({ route, params }: { route: { id: string }; params: object }): undefined => {
    if (!preload) return undefined;
    try {
      const read = params as Record<string, unknown>;
      const project = typeof read.project === "string" ? read.project : null;
      preload(screenOf({ routeId: route.id, params: read }), project);
    } catch {
      // The page loads without its head start; its own reads still run.
    }
    return undefined;
  };
  const root = createRootRoute({ component: pages.App });
  const project = createRoute({ getParentRoute: () => root, path: "/p/$project", component: Outlet });
  const agents = createRoute({ getParentRoute: () => project, path: "/", component: pages.Agents, loader: (context) => preloadPage(context) });
  const loop = createRoute({ getParentRoute: () => project, path: "/loops/$name", component: pages.Loop, loader: (context) => preloadPage(context) });
  // One literal route per page, written out rather than mapped, so each path
  // keeps its literal type and a `<Link to>` to it is checked.
  const notifications = createRoute({
    getParentRoute: () => project,
    path: "/notifications",
    component: pages.overview.notifications,
    loader: (context) => preloadPage(context),
  });
  const usage = createRoute({ getParentRoute: () => project, path: "/usage", component: pages.overview.usage, loader: (context) => preloadPage(context) });
  const backlog = createRoute({ getParentRoute: () => project, path: "/backlog", component: pages.overview.backlog, loader: (context) => preloadPage(context) });
  const ci = createRoute({ getParentRoute: () => project, path: "/ci", component: pages.overview.ci, loader: (context) => preloadPage(context) });
  const learnings = createRoute({
    getParentRoute: () => project,
    path: "/learnings",
    component: pages.overview.learnings,
    loader: (context) => preloadPage(context),
  });
  const evals = createRoute({ getParentRoute: () => project, path: "/evals", component: pages.overview.evals, loader: (context) => preloadPage(context) });
  const ownership = createRoute({
    getParentRoute: () => project,
    path: "/ownership",
    component: pages.overview.ownership,
    loader: (context) => preloadPage(context),
  });
  const reconciliation = createRoute({
    getParentRoute: () => project,
    path: "/reconciliation",
    component: pages.overview.reconciliation,
    loader: (context) => preloadPage(context),
  });
  const labels = createRoute({ getParentRoute: () => project, path: "/labels", component: pages.overview.labels, loader: (context) => preloadPage(context) });
  const settings = createRoute({ getParentRoute: () => project, path: "/settings", component: pages.Settings, loader: (context) => preloadPage(context) });
  const states = createRoute({ getParentRoute: () => project, path: "/states", component: pages.States, loader: (context) => preloadPage(context) });
  // The floor belongs to no project, so a project's floor address (an old
  // bookmark, `/p/x/factory`) moves up to the unscoped one. No component: the
  // redirect is thrown before anything under the project would draw, and
  // `replace` keeps Back from bouncing through it again.
  const projectFloor = createRoute({
    getParentRoute: () => project,
    path: "/factory",
    beforeLoad: () => {
      throw redirect({ to: "/factory", replace: true });
    },
  });
  // A splat, not a 404: an unknown page of a project rendered Agents before
  // the router, and an old bookmark must still open.
  const projectRest = createRoute({ getParentRoute: () => project, path: "$", component: pages.Agents, loader: (context) => preloadPage(context) });
  // A child of the root, not of the project route: the intake surface stands
  // alone, outside the project chrome. Its literal segment out-ranks the
  // project's splat, so `/p/x/intake` lands here and not on Agents.
  const intake = createRoute({ getParentRoute: () => root, path: "/p/$project/intake", component: pages.Intake, loader: (context) => preloadPage(context) });
  const floor = createRoute({ getParentRoute: () => root, path: "/factory", component: pages.Floor, loader: (context) => preloadPage(context) });
  // Unscoped addresses: `/` waits for the landing redirect into the remembered
  // project, and so does an unscoped old bookmark (`/usage`), via the splat.
  const landing = createRoute({ getParentRoute: () => root, path: "/", component: pages.Landing, loader: (context) => preloadPage(context) });
  const unscoped = createRoute({ getParentRoute: () => root, path: "$", component: pages.Landing, loader: (context) => preloadPage(context) });
  const projectPages = project.addChildren([
    agents,
    loop,
    notifications,
    usage,
    backlog,
    ci,
    learnings,
    evals,
    ownership,
    reconciliation,
    labels,
    settings,
    states,
    projectFloor,
    projectRest,
  ]);
  return root.addChildren([projectPages, intake, floor, landing, unscoped]);
}

/** A router over the tree; `history` defaults to the browser's. */
export function createRouterFor(pages: RoutePages, history?: RouterHistory) {
  return createRouter({
    routeTree: buildRouteTree(pages),
    history,
    // `/p/x/` and `/p/x/loops/rafa/` resolved before the router; "preserve"
    // keeps them as typed rather than rewriting the address bar.
    trailingSlash: "preserve",
    // Back and Forward return to where the page was scrolled, as they did
    // before the router; left unset, the router scrolls every render to the top.
    scrollRestoration: true,
    // A `<Link>` hovered, focused or touched runs its page's loader, which
    // starts that page's reads before the click.
    defaultPreload: "intent",
    // The router keeps no preload cache of its own: every intent re-runs the
    // loader, and the Query layer's keep-alive alone decides whether a read
    // happens, so two caches never disagree about what is fresh.
    defaultPreloadStaleTime: 0,
  });
}

/**
 * The path the screen shows: the committed leaf match's, still encoded, so
 * parseLocation decodes it once. Before the first commit there is no match,
 * and the address bar is all there is.
 */
export function committedPath(state: { matches: readonly { pathname: string }[]; location: { href: string } }): string {
  return state.matches.at(-1)?.pathname ?? state.location.href.split(/[?#]/)[0]!;
}

/** The screen a committed match draws, as the chrome reads it for its title and sidebar. */
export type Screen =
  | { page: "agents" | OverviewPageId }
  | { page: "loop"; name: string }
  | { page: "settings" }
  | { page: "states" }
  | { page: "factory" }
  | { page: "landing" }
  | { page: "intake" };

const PROJECT_ROUTE_PREFIX = "/p/$project/";

/**
 * The screen of the committed leaf match, read from its route id so the chrome
 * and the body never disagree about the page (`/p/x/Usage` matches the usage
 * route case-insensitively; the address bar alone would not say so). The loop
 * name comes from the match's params, already decoded. An id this does not
 * know falls back to Agents under a project and to the landing otherwise: a
 * route added without a screen must still draw something, never throw.
 */
export function screenOf(match: { routeId: string; params: Record<string, unknown> } | undefined): Screen {
  if (!match) return { page: "landing" };
  const { routeId } = match;
  if (routeId === "/factory") return { page: "factory" };
  if (!routeId.startsWith(PROJECT_ROUTE_PREFIX)) return { page: "landing" };
  const page = routeId.slice(PROJECT_ROUTE_PREFIX.length);
  if (page === "loops/$name") {
    const name = match.params.name;
    return typeof name === "string" ? { page: "loop", name } : { page: "agents" };
  }
  if (page === "settings" || page === "states" || page === "intake") return { page };
  // The project's floor address only ever redirects; should it be committed, it is still the floor.
  if (page === "factory") return { page: "factory" };
  if (isOverviewPageId(page)) return { page };
  return { page: "agents" };
}
