/**
 * The overview projection behind `GET /api/loops` (#67): the full `Dashboard`
 * cut to what the overview draws (see `DashboardOverview` in contracts.ts).
 *
 * Pure, and it builds new objects rather than deleting keys: the adapter may
 * hand the same dashboard to the next request, including `GET /api/dashboard`,
 * which must still see every field. The dropped fields are destructured out,
 * so they are gone from the JSON body and not only from the type. It imports
 * only `./contracts`: the route table, which the Vercel function and the UI
 * bundle, calls it.
 */
import {
  OVERVIEW_RECENT_ROWS,
  type Dashboard,
  type DashboardLoop,
  type DashboardOverview,
  type FrontierOverviewRead,
  type FrontierRead,
  type OverviewLoop,
  type OverviewPresenceView,
  type PresenceView,
} from "./contracts";

/** `recent` is oldest-first, so the newest rows are its tail, kept in order. */
export const overviewPresenceOf = (presence: PresenceView): OverviewPresenceView => ({
  ...presence,
  recent: presence.recent.slice(-OVERVIEW_RECENT_ROWS),
  recentTotal: presence.recent.length,
});

// `== null` rather than `=== null` here and below: the remote dashboard
// projects a pushed snapshot it parsed as untyped JSON, and a field a partial
// body leaves out must read as unknown, not fail the request with a 500.
export const overviewLoopOf = (loop: DashboardLoop): OverviewLoop => ({
  ...loop,
  presence: loop.presence == null ? null : overviewPresenceOf(loop.presence),
});

export const frontierOverviewOf = (frontier: FrontierRead): FrontierOverviewRead => {
  const { prs: _prs, view, ...rest } = frontier;
  if (view == null) return { ...rest, view: null };
  const { tree: _tree, ...buckets } = view;
  return { ...rest, view: buckets };
};

export function overviewOf(dashboard: Dashboard): DashboardOverview {
  const { learnings: _learnings, ciHealth: _ciHealth, loops, frontier, ...rest } = dashboard;
  return {
    ...rest,
    loops: loops.map(overviewLoopOf),
    frontier: frontier == null ? null : frontierOverviewOf(frontier),
  };
}
