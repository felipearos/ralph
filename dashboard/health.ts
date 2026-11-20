/**
 * Project health: how the switcher sees the projects the operator is not
 * looking at.
 *
 * Only the selected project gets the full snapshot (`gh` issues, frontier,
 * claims, usage tails, timeline). Every other one is read locally: the
 * adapter's local read (`loop-state status --json` and the cached project
 * config) and `controls status --json` per roster worktree. Never `gh`, and at
 * most once per `HEALTH_TTL_MS` whatever polls it.
 *
 * `projectHealth` is the pure half; `readProjectHealth` gathers its inputs
 * through injected reads, and a project that cannot be read is `unknown` with
 * its reason, never a failed response.
 */
import type {
  HealthProblemKind,
  Liveness,
  LocalSnapshot,
  LoopStatus,
  NeedsYouReason,
  ProjectHealth,
  ProjectHealthView,
  Stage,
} from "./contracts";
import type { ControlStatusRead } from "./control-adapter";

/** How long one project's health is served before it is read again. */
export const HEALTH_TTL_MS = 30_000;

/** How many `controls status` reads run at once for one project. */
const CONTROL_READS_AT_ONCE = 4;

/** One roster loop's checkout, as the health read sees it. */
export interface HealthLoop {
  loop: string;
  loopStatus: LoopStatus;
  control: ControlStatusRead;
  supervisor: Liveness;
  stage: Stage | null;
  lastEvent: string | null;
}

/**
 * Why a loop waits on the operator, if it does. An approval hold asks a
 * question; a failed stop wants a look; a block wants unblocking. A pause the
 * operator placed is theirs already and waits on nothing new.
 */
export function needsYouFor(loop: HealthLoop): NeedsYouReason | null {
  const hold = loop.control.kind === "record" ? loop.control.record.hold : null;
  if (hold?.kind === "approval") return "approval";
  if (loop.loopStatus === "failed") return "errored";
  if (loop.loopStatus === "blocked" && hold?.kind !== "pause") return "blocked";
  return null;
}

/** A loop status that says the dashboard cannot vouch for the loop. */
const DEGRADED_STATUSES: readonly LoopStatus[] = ["stale", "orphaned", "unknown"];

/** Fold one project's loops into its health. Pure: the read time is an argument. */
export function projectHealth(project: string, loops: readonly HealthLoop[], readAt: string): ProjectHealthView {
  const needs = loops.flatMap((loop) => {
    const reason = needsYouFor(loop);
    return reason === null ? [] : [{ loop: loop.loop, reason }];
  });
  const running = loops.filter((loop) => loop.loopStatus === "running").length;
  const degraded = loops.some(
    (loop) => DEGRADED_STATUSES.includes(loop.loopStatus) || loop.control.kind === "unreadable",
  );
  const health: ProjectHealth =
    needs.length > 0 ? "needs-you" : degraded ? "degraded" : running > 0 ? "running" : "idle";
  const agents = loops.map(({ loop, loopStatus, supervisor, stage, lastEvent }) => ({ loop, loopStatus, supervisor, stage, lastEvent }));
  return { project, readAt, health, needsYou: needs.length, needs, loops: loops.length, running, agents, problem: null };
}

/**
 * Which kind of unreadable a failed local read is. The reason crosses a
 * process boundary as text (`project-config` exits with a message), so this
 * matches the phrases `project-config.ts` and the adapter's roster read write; anything it does not know is
 * `unreadable` and keeps its raw reason, never a wrong plain one.
 */
export function problemKindOf(problem: string): HealthProblemKind {
  // The adapter's roster read, which looks at the folder once the config read failed.
  if (/the project folder .* does not exist/.test(problem)) return "missing";
  // `loadProjectConfig`'s missing-file message, through the roster read's wrapper.
  if (/opts in to the harness|\.ralph\/config\.json \(ENOENT\)/.test(problem)) return "not-set-up";
  // `parseProjectConfig`: a file that is there but does not validate or parse.
  if (/config\.json is (invalid|not valid JSON)/.test(problem)) return "invalid-config";
  return "unreadable";
}

/** A project that could not be read: nothing is claimed about its loops. */
export function unknownHealth(
  project: string,
  readAt: string,
  problem: string,
  problemKind: HealthProblemKind = problemKindOf(problem),
): ProjectHealthView {
  return { project, readAt, health: "unknown", needsYou: 0, needs: [], loops: 0, running: 0, problem, problemKind };
}

/**
 * Read one project's health: its local snapshot, then the control record of
 * each roster loop's checkout. Checkouts git reports gone or prunable are
 * reconciliation, not loops, and are not read.
 */
export async function readProjectHealth({
  project,
  local,
  controlStatus,
  now = () => Date.now(),
}: {
  project: string;
  local: () => Promise<LocalSnapshot>;
  controlStatus: (worktree: string) => Promise<ControlStatusRead>;
  now?: () => number;
}): Promise<ProjectHealthView> {
  let snapshot: LocalSnapshot;
  try {
    snapshot = await local();
  } catch (error) {
    return unknownHealth(project, new Date(now()).toISOString(), error instanceof Error ? error.message : String(error));
  }
  const targets = snapshot.loops.filter(
    (entry): entry is typeof entry & { identity: string } =>
      entry.identity !== null && entry.worktreeStatus !== "orphaned" && entry.worktreeStatus !== "prunable",
  );
  const loops: HealthLoop[] = [];
  for (let offset = 0; offset < targets.length; offset += CONTROL_READS_AT_ONCE) {
    const batch = targets.slice(offset, offset + CONTROL_READS_AT_ONCE);
    loops.push(
      ...(await Promise.all(
        batch.map(async (entry) => ({
          loop: entry.identity,
          loopStatus: entry.loopStatus,
          supervisor: entry.supervisor,
          stage: entry.state?.stage ?? null,
          lastEvent: entry.state?.lastEvent?.name ?? null,
          control: await controlStatus(entry.worktree).catch(
            (error: unknown): ControlStatusRead => ({
              kind: "unreadable",
              why: error instanceof Error ? error.message : String(error),
            }),
          ),
        })),
      )),
    );
  }
  return projectHealth(project, loops, new Date(now()).toISOString());
}

/** A cached read, and a way to hand it a fresher value read elsewhere. */
export type CachedRead<T> = (() => Promise<T>) & {
  /** Serve `value` as if just read: a fresh TTL from now. */
  prime(value: T): void;
};

/**
 * Serve one read for `ttlMs`: callers that arrive while it is fresh get the
 * same answer, and callers that arrive while it is in flight share it. A read
 * that throws is not kept, so the next caller asks again. `prime` (#729) lets
 * the change stream's own uncached read replace a stale answer, so the page's
 * refresh after the stream names the change sees it, not the old one for 30s.
 */
export function cachedRead<T>(read: () => Promise<T>, ttlMs: number, now: () => number = () => Date.now()): CachedRead<T> {
  let cached: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  let primed = 0;
  const served = () => {
    if (cached !== null && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    const primedAtStart = primed;
    inFlight ??= read()
      .then((value) => {
        // A prime while this read was out is newer than it: keep the prime.
        if (primed === primedAtStart) cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return Object.assign(served, {
    prime(value: T): void {
      primed += 1;
      cached = { at: now(), value };
    },
  });
}

/** The least time between two stream reads of one project's health (#729): the page's old poll. */
export const HEALTH_PRODUCER_MIN_MS = 5_000;

/**
 * One project's health two ways (#729): `health`, the 30s cached read the
 * switcher asks, and `producer`, the uncached read the change stream hashes.
 * The producer reads the local snapshot once and primes the cache with what it
 * found, so the page's refresh after the stream names the change is served
 * the new health. A local read that throws throws out of the producer — the
 * hub keeps its last hash — and primes nothing. Its value carries each
 * loop's `worktree`, the dirs whose files can move the health.
 */
export function liveHealth({
  project,
  local,
  controlStatus,
  ttlMs = HEALTH_TTL_MS,
  minIntervalMs = HEALTH_PRODUCER_MIN_MS,
  now = () => Date.now(),
}: {
  project: string;
  local: () => Promise<LocalSnapshot>;
  controlStatus: (worktree: string) => Promise<ControlStatusRead>;
  ttlMs?: number;
  minIntervalMs?: number;
  now?: () => number;
}): {
  health: CachedRead<ProjectHealthView>;
  producer: {
    compute: () => Promise<{ health: ProjectHealthView; loops: { worktree: string }[] }>;
    minIntervalMs: number;
  };
} {
  const health = cachedRead(() => readProjectHealth({ project, local, controlStatus, now }), ttlMs, now);
  return {
    health,
    producer: {
      // One read costs the loop-state CLI and a `controls status` per loop:
      // a busy project's health is re-read no oftener than the old poll did.
      minIntervalMs,
      compute: async () => {
        const snapshot = await local();
        const view = await readProjectHealth({ project, local: async () => snapshot, controlStatus, now });
        health.prime(view);
        return { health: view, loops: snapshot.loops.map((loop) => ({ worktree: loop.worktree })) };
      },
    },
  };
}
