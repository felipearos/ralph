/**
 * Where a view that draws a full list takes it from (#67). The overview
 * (`GET /api/loops`) caps each loop's recent activity and leaves out the
 * frontier's tree and PRs; the views that draw those read them on their own
 * and, until that read lands, draw what the overview has. Pure, so the
 * fallbacks are pinned in node rather than in a `.tsx` no test compiles.
 */
import type { ActivityView, DashboardLoop, OverviewPresenceView } from "../contracts";
import type { Read } from "./query-reads";

/** The data a read holds now: its last answer through a failed poll, null while loading or with none. */
export function dataOf<T>(read: Read<T>): T | null {
  return read.state === "loading" ? null : read.data;
}

/** What a page drawing one full-list read shows: a skeleton, the failure, or the data. */
export type FullListView<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "data"; data: T };

/**
 * The three-way choice of the backlog, CI and Learnings pages: a skeleton
 * while the first read is out, the failure when it failed before it ever
 * answered, and otherwise the data — the last answer through a failed poll.
 */
export function fullListView<T>(read: Read<T>): FullListView<T> {
  if (read.state === "loading") return { kind: "loading" };
  if (read.state === "error" && read.data === null && read.answered !== true) return { kind: "error", message: read.message };
  return { kind: "data", data: read.data as T };
}

/**
 * The loop page's activity rows: the panel read's full list once it has one,
 * else the overview's capped rows, so the feed never draws empty while the
 * full read is on the wire or after it failed.
 */
export function recentRows(panel: Read<DashboardLoop>, capped: OverviewPresenceView): ActivityView[] {
  return dataOf(panel)?.presence?.recent ?? capped.recent;
}

/**
 * How many rows the observer keeps for the loop: the full list's length once
 * it has landed, else the overview's `recentTotal`, so the feed's footer does
 * not report the capped rows as everything there is.
 */
export function recentTotal(panel: Read<DashboardLoop>, capped: OverviewPresenceView): number {
  return dataOf(panel)?.presence?.recent.length ?? capped.recentTotal;
}
