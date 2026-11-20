/**
 * The sentinel issue store as a JSON view (felipearos/ralph#685, spec #678):
 * what the dashboard's sentinel panel draws. The dashboard never imports
 * ralph TypeScript, so this CLI's stdout is the whole contract.
 *
 *   bun sentinel/issues.ts --json
 *
 * It is a read: no lock, no write (`withStore` is the writer). A missing or
 * empty store is an empty view; an unreadable one is exit 1 with the reason on
 * stderr, so the panel can say why it is degraded instead of claiming the
 * sentinel saw nothing.
 *
 * The view is relayed to the remote dashboard, so it carries the draft's title
 * only: never the draft body and never the evidence, which hold stack frames,
 * breadcrumbs and whatever the error captured.
 *
 * A record that does not have the store's shape is skipped, never thrown on:
 * one hand-edited record must not blank the whole panel.
 */
import { projectRoot } from "../paths";
import { SENTINEL_MODES, type SentinelMode } from "../project-config";
import {
  cycleOf,
  emptyStore,
  filedOn,
  type IssueRecord,
  type IssueState,
  loadStore,
  type SentinelStore,
  storePathFromGit,
  ticketNumberOf,
  utcDay,
} from "./store";

// The view's own version, apart from the store file's SENTINEL_ISSUES_VERSION.
export const SENTINEL_ISSUES_VIEW_VERSION = 1 as const;

// Exported for the dashboard's parity fence: its contracts mirror these by hand.
export const SENTINEL_ISSUE_STATES = ["observed", "drafted", "filed", "failed"] as const;

// Fails to compile when store.ts's IssueState and the list above drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const statesMatch: Same<(typeof SENTINEL_ISSUE_STATES)[number], IssueState> = true;
void statesMatch;

export interface SentinelIssueRow {
  /** The store's key, `${reporter}:${id}`. */
  key: string;
  reporter: string;
  id: string;
  title: string;
  /** The reporter's link to the issue, when the candidate carries one. */
  permalink: string | null;
  state: IssueState;
  events: number;
  users: number;
  attempts: number;
  /** The tracker ref once filed. */
  ticket: string | null;
  ticketNumber: number | null;
  mode: SentinelMode;
  /** What was, or would have been, filed — the title only, never the body. */
  draftTitle: string | null;
  observedAt: string;
  updatedAt: string;
  cycle: number;
  /** The ref of the closed ticket the current cycle regressed after. */
  regressedAfter: string | null;
}

export interface SentinelIssuesView {
  version: typeof SENTINEL_ISSUES_VIEW_VERSION;
  issues: SentinelIssueRow[];
  today: { day: string; filed: number; alerted: boolean };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function issueRow(key: string, value: unknown): SentinelIssueRow | null {
  if (!isObject(value)) return null;
  const { reporter, id, state, mode, candidate } = value;
  if (typeof reporter !== "string" || typeof id !== "string") return null;
  if (!(SENTINEL_ISSUE_STATES as readonly unknown[]).includes(state)) return null;
  if (!(SENTINEL_MODES as readonly unknown[]).includes(mode)) return null;
  if (!isObject(candidate)) return null;
  const record = value as unknown as IssueRecord;
  const cycle = cycleOf(record);
  return {
    key,
    reporter,
    id,
    title: str(candidate.title),
    permalink: nonEmpty(candidate.permalink),
    state: state as IssueState,
    events: num(candidate.events),
    users: num(candidate.users),
    attempts: num(value.attempts),
    ticket: nonEmpty(value.ticket),
    ticketNumber: ticketNumberOf(record),
    mode: mode as SentinelMode,
    draftTitle: isObject(value.draft) ? nonEmpty(value.draft.title) : null,
    observedAt: str(value.observedAt),
    updatedAt: str(value.updatedAt),
    cycle: typeof cycle === "number" && Number.isFinite(cycle) ? cycle : 0,
    regressedAfter: nonEmpty(value.regressedAfter),
  };
}

/** Most recently changed first; the key breaks ties so the order is stable. */
function compareRows(a: SentinelIssueRow, b: SentinelIssueRow): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function sentinelIssuesView(store: SentinelStore, now: Date): SentinelIssuesView {
  const issues: SentinelIssueRow[] = [];
  for (const [key, value] of Object.entries(store.issues as Record<string, unknown>)) {
    const row = issueRow(key, value);
    if (row !== null) issues.push(row);
  }
  const day = utcDay(now);
  const ledger: unknown = store.days[day];
  return {
    version: SENTINEL_ISSUES_VIEW_VERSION,
    issues: issues.sort(compareRows),
    today: { day, filed: filedOn(store, day), alerted: isObject(ledger) && ledger.alerted === true },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "--json") {
    console.error("usage: bun sentinel/issues.ts --json");
    process.exitCode = 64;
  } else {
    const path = storePathFromGit(projectRoot());
    const loaded = loadStore(path);
    if (loaded.kind === "unreadable") {
      console.error(`sentinel-issues: the issue store at ${path} is unreadable (${loaded.why})`);
      process.exitCode = 1;
    } else {
      const store: SentinelStore = loaded.kind === "ok" ? loaded.store : emptyStore();
      console.log(JSON.stringify(sentinelIssuesView(store, new Date())));
    }
  }
}
