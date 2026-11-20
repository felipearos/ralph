/**
 * The verifier watch store as a JSON view (felipearos/ralph#569, spec #560):
 * what the dashboard's "Following" panel draws. The dashboard never imports
 * ralph TypeScript, so this CLI's stdout is the whole contract.
 *
 *   bun verifier/following.ts --json
 *
 * It is a read: no lock, no write. A missing or empty store is an empty view;
 * an unreadable one is exit 1 with the reason on stderr, so the panel can say
 * why it is degraded instead of claiming nothing is watched.
 *
 * `watch.verdict` is a `WatchVerdict` and `checkIn.result` a `CheckInResult`
 * (`./watches`, #565). The gate sets `result` when it hands a check-in over,
 * so a check-in counts as done only once `result.decision` is in: one that is
 * handed over but undecided is still the next check-in. Read here:
 *   - `watch.verdict` and `checkIn.result.decision` (`{verdict, reason, act, wouldHaveBeen?}`);
 *   - `checkIn.result.acceptance`, an `AcceptanceResult[]` from `./verdict`,
 *     which the acceptance check-ins (#566) will fill.
 * Anything that does not match is ignored, never thrown on: one odd record
 * must not blank the whole panel.
 */
import { projectRoot } from "../paths";
import { emptyStore, loadStore, storePathFromGit, type WatchStore } from "./watches";

export const FOLLOWING_VERSION = 1 as const;

// Exported for the dashboard's parity fence: its contracts mirror these by hand.
export const WOULD_BE_KINDS = ["ticket", "revert", "needs-human"] as const;
export const FOLLOWING_STATES = ["in-progress", "finished"] as const;
type WouldBeKind = (typeof WOULD_BE_KINDS)[number];

export interface FollowingVerdict {
  verdict: string;
  reason: string;
  act: boolean;
  wouldHaveBeen: string | null;
}

export interface FollowingWatch {
  pr: number;
  ticket: number;
  ticketRef: string;
  mode: string;
  round: number;
  mergedAt: string;
  deployedAt: string;
  deployUrl: string | null;
  openedAt: string;
  state: (typeof FOLLOWING_STATES)[number];
  /** The first check-in without a result; null once the watch is finished. */
  nextCheckIn: { offsetHours: number; dueAt: string } | null;
  checkInsDone: number;
  checkInsTotal: number;
  /** The terminal verdict. */
  verdict: FollowingVerdict | null;
  /** What observe mode held back; `at` is the check-in's offset, null for the terminal verdict. */
  wouldBe: { verdict: WouldBeKind; reason: string; at: number | null }[];
  notVerifiableLive: { criterion: string; detail: string | null }[];
}

export interface FollowingView {
  version: typeof FOLLOWING_VERSION;
  watches: FollowingWatch[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function readVerdict(value: unknown): FollowingVerdict | null {
  if (!isObject(value) || typeof value.verdict !== "string") return null;
  return {
    verdict: value.verdict,
    reason: str(value.reason),
    act: value.act === true,
    wouldHaveBeen: typeof value.wouldHaveBeen === "string" ? value.wouldHaveBeen : null,
  };
}

/** `decideVerdict`'s observe-mode shape: no action taken, and one the mode held back. */
function wouldBeKind(verdict: FollowingVerdict): WouldBeKind | null {
  if (verdict.act) return null;
  return (WOULD_BE_KINDS as readonly string[]).includes(verdict.wouldHaveBeen ?? "")
    ? (verdict.wouldHaveBeen as WouldBeKind)
    : null;
}

function followingWatch(record: Record<string, unknown> & { pr: number }): FollowingWatch {
  const checkIns = (Array.isArray(record.checkIns) ? record.checkIns : []).filter(isObject);
  const verdict = readVerdict(record.verdict);
  const finished = verdict !== null && verdict.verdict !== "pending";

  const wouldBe: FollowingWatch["wouldBe"] = [];
  const addWouldBe = (candidate: FollowingVerdict | null, at: number | null): void => {
    const kind = candidate === null ? null : wouldBeKind(candidate);
    if (candidate === null || kind === null) return;
    if (wouldBe.some((entry) => entry.verdict === kind && entry.reason === candidate.reason)) return;
    wouldBe.push({ verdict: kind, reason: candidate.reason, at });
  };

  const notVerifiableLive: FollowingWatch["notVerifiableLive"] = [];
  let next: FollowingWatch["nextCheckIn"] = null;
  let done = 0;
  for (const checkIn of checkIns) {
    const result = checkIn.result;
    if (result === null || result === undefined || (isObject(result) && !isObject(result.decision))) {
      if (next === null) next = { offsetHours: num(checkIn.offsetHours), dueAt: str(checkIn.dueAt) };
      continue;
    }
    done++;
    if (!isObject(result)) continue;
    addWouldBe(readVerdict(result.decision), num(checkIn.offsetHours));
    for (const acceptance of Array.isArray(result.acceptance) ? result.acceptance : []) {
      if (!isObject(acceptance) || acceptance.result !== "not-verifiable" || typeof acceptance.criterion !== "string") continue;
      if (notVerifiableLive.some((entry) => entry.criterion === acceptance.criterion)) continue;
      notVerifiableLive.push({
        criterion: acceptance.criterion,
        detail: typeof acceptance.detail === "string" ? acceptance.detail : null,
      });
    }
  }
  addWouldBe(verdict, null);

  return {
    pr: record.pr,
    ticket: num(record.ticket),
    ticketRef: str(record.ticketRef),
    mode: str(record.mode),
    round: num(record.round, 1),
    mergedAt: str(record.mergedAt),
    deployedAt: str(record.deployedAt),
    deployUrl: typeof record.deployUrl === "string" ? record.deployUrl : null,
    openedAt: str(record.openedAt),
    state: finished ? "finished" : "in-progress",
    nextCheckIn: finished ? null : next,
    checkInsDone: done,
    checkInsTotal: checkIns.length,
    verdict,
    wouldBe,
    notVerifiableLive,
  };
}

/** In-progress first, the soonest check-in on top; then finished, newest first. */
function compareWatches(a: FollowingWatch, b: FollowingWatch): number {
  if (a.state !== b.state) return a.state === "in-progress" ? -1 : 1;
  if (a.state === "in-progress") {
    // A watch with every check-in in but no verdict yet has nothing due: below the ones that do.
    const dueA = a.nextCheckIn?.dueAt ?? "\uffff";
    const dueB = b.nextCheckIn?.dueAt ?? "\uffff";
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  } else if (a.openedAt !== b.openedAt) {
    return a.openedAt > b.openedAt ? -1 : 1;
  }
  return a.pr - b.pr;
}

export function followingView(store: WatchStore): FollowingView {
  const watches: FollowingWatch[] = [];
  for (const record of Object.values(store.watches as Record<string, unknown>)) {
    if (!isObject(record) || typeof record.pr !== "number" || !Number.isFinite(record.pr)) continue;
    watches.push(followingWatch(record as Record<string, unknown> & { pr: number }));
  }
  return { version: FOLLOWING_VERSION, watches: watches.sort(compareWatches) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "--json") {
    console.error("usage: bun verifier/following.ts --json");
    process.exitCode = 64;
  } else {
    const path = storePathFromGit(projectRoot());
    const loaded = loadStore(path);
    if (loaded.kind === "unreadable") {
      console.error(`verifier-following: the watch store at ${path} is unreadable (${loaded.why})`);
      process.exitCode = 1;
    } else {
      const store: WatchStore = loaded.kind === "ok" ? loaded.store : emptyStore();
      console.log(JSON.stringify(followingView(store)));
    }
  }
}
