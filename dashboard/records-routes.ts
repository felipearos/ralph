/**
 * The notification feed and the audit history over HTTP.
 *
 *   GET  /api/notifications              every loop's feed, and the newest alerts across them.
 *   GET  /api/loops/:name/notifications  one loop's feed.
 *   GET  /api/loops/:name/history        one loop's audit history.
 *   POST /api/notifications/read         `{ "loop", "through" }`: mark that loop's
 *                                        alerts up to `through` read.
 *
 * The reads resolve each loop to its checkout from the same runtime read the
 * panels use, and answer whatever the records hold: a loop with no checkout,
 * or a record that cannot be read, is a `problem` on its view, never an error.
 * The one write is the read mark, which records only what the operator has
 * seen. No projection logic lives here and no process is run.
 */
import type { Dashboard, HistoryView, MarkReadResult, NotificationFeed, NotificationsView } from "./contracts";
import { ControlRouteError, json, parseMarkRead, readBody } from "./command-requests";
import { targetFor } from "./control-routes";
import type { RecordsAdapter } from "./records-adapter";
import { historyView, mergeFeeds, notificationFeed } from "./records";

export const NOTIFICATIONS_PATH = "/api/notifications";
export const MARK_READ_PATH = "/api/notifications/read";
const LOOP_RECORD_PATH = /^\/api\/loops\/([^/]+)\/(notifications|history)$/;

/** The records of one loop's checkout. */
export type RecordsFactory = (worktree: string) => RecordsAdapter;

export interface RecordsRouteOptions {
  records: RecordsFactory;
  dashboard: () => Promise<Dashboard>;
  now: () => Date;
}

const NO_CHECKOUT = { kind: "no-checkout", detail: "no checkout is attributed to this loop, so it keeps no records" } as const;

export const isRecordsPath = (pathname: string): boolean =>
  pathname === NOTIFICATIONS_PATH || pathname === MARK_READ_PATH || LOOP_RECORD_PATH.test(pathname);

function feedFor(records: RecordsFactory, loop: string, worktree: string | null): NotificationFeed {
  if (worktree === null) return { loop, notifications: [], unread: 0, readThrough: null, problem: NO_CHECKOUT };
  return notificationFeed(loop, records(worktree).readFeed());
}

/** Answer a records route, or return null when the path is not one. */
export async function handleRecordsRoute(
  request: Request,
  pathname: string,
  options: RecordsRouteOptions,
): Promise<Response | null> {
  if (!isRecordsPath(pathname)) return null;

  if (pathname === MARK_READ_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    try {
      const { loop, through } = parseMarkRead(await readBody(request));
      const target = await targetFor(options.dashboard, loop);
      const marked = options.records(target.worktree).markRead(through);
      return json({
        loop: target.loop,
        readThrough: marked.readThrough,
        recorded: marked.why === null,
        why: marked.why,
      } satisfies MarkReadResult);
    } catch (error) {
      if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
      throw error;
    }
  }

  if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  const loops = (await options.dashboard()).loops;
  const generatedAt = options.now().toISOString();

  if (pathname === NOTIFICATIONS_PATH) {
    const feeds = loops.map((panel) => feedFor(options.records, panel.loop, panel.present ? panel.worktree : null));
    return json(mergeFeeds(feeds, generatedAt) satisfies NotificationsView);
  }

  const [, encoded, which] = LOOP_RECORD_PATH.exec(pathname)!;
  const name = decodeURIComponent(encoded!);
  const panel = loops.find((entry) => entry.loop === name);
  if (panel === undefined) return json({ error: `no loop '${name}'` }, 404);
  const worktree = panel.present ? panel.worktree : null;
  if (which === "notifications") return json(feedFor(options.records, panel.loop, worktree) satisfies NotificationFeed);
  return json(
    (worktree === null
      ? { loop: panel.loop, generatedAt, entries: [], problems: [{ source: "command", problem: NO_CHECKOUT }] }
      : historyView(panel.loop, options.records(worktree).readHistory(), generatedAt)) satisfies HistoryView,
  );
}
