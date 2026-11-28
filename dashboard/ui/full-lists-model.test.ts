/**
 * The full lists' fallbacks (#67): a view drawing a full list draws the
 * overview's capped rows until its own read lands, and keeps the last full
 * answer through a failed poll.
 */
import { describe, expect, it } from "vitest";

import type { ActivityView, DashboardLoop, OverviewPresenceView } from "../contracts";
import { dataOf, recentRows, recentTotal } from "./full-lists-model";

const row = (n: number): ActivityView => ({ at: `2026-11-28T00:00:0${n}Z` }) as unknown as ActivityView;
const capped = { recent: [row(8), row(9)], recentTotal: 10 } as unknown as OverviewPresenceView;
const panel = (recent: ActivityView[] | null): DashboardLoop =>
  ({ presence: recent === null ? null : { recent } }) as unknown as DashboardLoop;
const at = new Date(0);

describe("recentRows", () => {
  it("draws the overview's capped rows while the full panel loads", () => {
    expect(recentRows({ state: "loading" }, capped)).toBe(capped.recent);
  });

  it("draws the full panel's rows once it lands", () => {
    const full = [row(0), row(1), row(8), row(9)];
    expect(recentRows({ state: "ready", data: panel(full), at, snapshotAt: null }, capped)).toBe(full);
  });

  it("keeps the last full rows through a failed poll, and falls back when there are none", () => {
    const full = [row(0), row(9)];
    expect(recentRows({ state: "error", message: "HTTP 500", status: 500, data: panel(full) }, capped)).toBe(full);
    expect(recentRows({ state: "error", message: "HTTP 404", status: 404, data: null }, capped)).toBe(capped.recent);
  });

  it("falls back when the full panel has no presence", () => {
    expect(recentRows({ state: "ready", data: panel(null), at, snapshotAt: null }, capped)).toBe(capped.recent);
  });
});

describe("dataOf", () => {
  it("is null while loading and the data otherwise", () => {
    expect(dataOf({ state: "loading" })).toBeNull();
    expect(dataOf({ state: "error", message: "x", status: null, data: 3 })).toBe(3);
  });
});

describe("recentTotal", () => {
  it("is the overview's recentTotal until the full panel lands, then the full list's length", () => {
    expect(recentTotal({ state: "loading" }, capped)).toBe(10);
    expect(recentTotal({ state: "ready", data: panel([row(0), row(1), row(2)]), at, snapshotAt: null }, capped)).toBe(3);
    expect(recentTotal({ state: "error", message: "HTTP 404", status: 404, data: null }, capped)).toBe(10);
  });
});
