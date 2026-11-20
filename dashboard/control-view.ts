/**
 * The read-only per-loop control view.
 *
 * It surfaces what the loop's records already know and nothing else: the
 * current hold or blocked reason, the recorded outcome of recent commands,
 * pending approvals with their question, deferrals with their attempts and the
 * remedy for a command the channel gave up on, and the degraded window of the
 * control channel.
 *
 * Two records are composed, each read through the runtime adapters:
 *
 *   - the durable loop state (`loop-state status --json`), already narrowed
 *     into the runtime snapshot the dashboard reads, for the blocked reason;
 *   - the control record (`controls status --json`), read through the
 *     control adapter's status read — the only operation this module asks
 *     for. It never sends.
 *
 * The honesty rules are the control channel's own. A degraded or unreadable
 * channel is shown as degraded and never as a hold or a stop: nothing here
 * invents either one from an absent record. A recorded hold survives a
 * degraded window, because that is exactly what the channel's verdict falls
 * back to. And a stop's confirmation is passed through as recorded, so an
 * `unreachable` stop is never shown as `confirmed`.
 */
import { aggregateDashboard } from "./aggregate";
import type { Clock, ControlView, ControlViewStatus, RuntimeLoop, RuntimeSnapshot } from "./contracts";
import {
  type ControlAdapter,
  type ControlStatusRead,
  type StopConfirmation,
} from "./control-adapter";

/** How many recorded commands a panel lists, newest first. */
export const RECENT_COMMAND_LIMIT = 10;

export type { ControlChannelState, ControlView, ControlViewStatus } from "./contracts";

/**
 * Read the loop's control record. Only the status read is reachable — the
 * adapter is narrowed to it by type — and the adapter's guarded executor makes
 * a throw an unreadable record, not a failed response.
 */
export function readControlStatus(adapter: Pick<ControlAdapter, "readControlStatus">): Promise<ControlStatusRead> {
  return adapter.readControlStatus();
}

function channelFor(control: ControlStatusRead): ControlView["channel"] {
  if (control.kind === "unreadable") {
    return { state: "unreachable", why: control.why, since: null, retryAt: null };
  }
  if (control.kind === "none") return { state: "no-record", why: null, since: null, retryAt: null };
  const degraded = control.record.degraded;
  if (degraded === null) return { state: "ok", why: null, since: null, retryAt: null };
  return { state: "degraded", why: degraded.why, since: degraded.at, retryAt: degraded.retryAt };
}

/**
 * The blocked reason, as the durable loop state records it: a blocked ending
 * the loop wrote, a supervisor parked in a control hold, or one parked on the
 * frontier with the detail `ralph.sh` recorded.
 */
function blockedFor(runtime: RuntimeLoop | null): ControlView["blocked"] {
  const state = runtime?.state ?? null;
  if (runtime === null || state === null) return null;
  if (state.stopReason?.kind === "blocked") {
    return { source: "stop", reason: state.stopReason.why, since: state.stopReason.at };
  }
  if (runtime.loopStatus !== "blocked") return null;
  const event = state.lastEvent;
  if (state.stage === "paused") {
    return { source: "hold", reason: event?.detail ?? "held by an operator control", since: event?.at ?? null };
  }
  return { source: "frontier", reason: event?.detail ?? "parked on the frontier", since: event?.at ?? null };
}

const STOP_STATUS: Record<StopConfirmation, ControlViewStatus> = {
  confirmed: "stopped",
  pending: "stop-pending",
  unreachable: "stop-unreachable",
};

/** Project one loop's control view. Pure: records and a clock in, a view out. */
export function projectControlView(
  loop: string,
  runtime: RuntimeLoop | null,
  control: ControlStatusRead,
  clock: Clock,
): ControlView {
  const record = control.kind === "record" ? control.record : null;
  const channel = channelFor(control);
  const blocked = blockedFor(runtime);

  const hold: ControlView["hold"] =
    record?.hold == null
      ? null
      : {
          kind: record.hold.kind,
          why: record.hold.why,
          since: record.hold.since,
          gate: record.hold.gate,
          ...(record.hold.phase === undefined ? {} : { phase: record.hold.phase }),
          ...(record.hold.after === undefined ? {} : { after: record.hold.after }),
        };
  const stop: ControlView["stop"] =
    record?.stop == null
      ? null
      : {
          kind: record.stop.kind,
          why: record.stop.why,
          at: record.stop.at,
          confirmation: record.stop.confirmation,
          iteration: record.stop.iteration,
          issue: record.stop.issue,
          ...(record.stop.phase === undefined ? {} : { phase: record.stop.phase }),
        };

  const status: ControlViewStatus =
    runtime === null
      ? "unknown"
      : stop !== null
        ? STOP_STATUS[stop.confirmation]
        : hold !== null
          ? "held"
          : blocked !== null
            ? "blocked"
            : channel.state === "degraded" || channel.state === "unreachable"
              ? "degraded"
              : "clear";

  return {
    loop,
    generatedAt: new Date(clock.nowMs).toISOString(),
    present: runtime !== null,
    worktree: runtime?.worktree ?? null,
    run: runtime?.state?.run ?? runtime?.presence?.run ?? record?.ralphRun ?? null,
    loopStatus: runtime?.loopStatus ?? "unknown",
    status,
    channel,
    hold,
    blocked,
    stop,
    // The record appends; the panel reads newest first.
    commands: (record?.applied ?? [])
      .slice(-RECENT_COMMAND_LIMIT)
      .reverse()
      .map(({ key, command, outcome, at, why }) => ({ key, command, outcome, at, why })),
    pendingApprovals:
      hold?.kind === "approval"
        ? [{ gate: hold.gate, question: record?.gateQuestion ?? hold.why, since: hold.since }]
        : [],
    gates: (record?.gates ?? []).map(({ phase, since, why }) => ({ phase, since, why })),
    deferrals: (record?.deferrals ?? []).map(({ key, command, since, attempts }) => ({
      key,
      command,
      since,
      attempts,
    })),
    givenUp: record?.givenUp ?? [],
  };
}

/**
 * The runtime loop the dashboard attributes to `loop`, given an aggregate the
 * caller already computed. The dashboard's own selection picks the worktree,
 * so the control panel and the loop panel can never describe two different
 * checkouts — and one aggregate serves every loop of a batched read.
 */
function attributedLoop(
  runtime: RuntimeSnapshot,
  panels: ReturnType<typeof aggregateDashboard>["loops"],
  loop: string,
): RuntimeLoop | null {
  const panel = panels.find((entry) => entry.loop === loop);
  return panel?.present === true
    ? (runtime.loops.find((candidate) => candidate.identity === loop && candidate.worktree === panel.worktree) ?? null)
    : null;
}

async function viewFor(
  loop: string,
  entry: RuntimeLoop | null,
  readStatus: (worktree: string) => Promise<ControlStatusRead>,
  clock: Clock,
): Promise<ControlView> {
  const control: ControlStatusRead =
    entry === null
      ? { kind: "unreadable", why: `no checkout is attributed to ${loop}` }
      : await readStatus(entry.worktree);
  return projectControlView(loop, entry, control, clock);
}

/**
 * Compose a roster loop's control view from the runtime snapshot, reading the
 * control record of the worktree the dashboard attributes to the loop. Null for
 * a name outside the roster; a roster loop with no checkout is `unknown` and
 * nothing is read for it.
 */
export async function composeControlView(
  runtime: RuntimeSnapshot,
  loop: string,
  readStatus: (worktree: string) => Promise<ControlStatusRead>,
  clock: Clock,
): Promise<ControlView | null> {
  if (!runtime.roster.some((entry) => entry.name === loop)) return null;
  const panels = aggregateDashboard(runtime, clock).loops;
  return viewFor(loop, attributedLoop(runtime, panels, loop), readStatus, clock);
}

/**
 * Every roster loop's control view from one runtime snapshot and one
 * aggregate, keyed by loop name. A page showing all loops reads this once
 * instead of one full runtime read per loop; each view is exactly what
 * `composeControlView` gives for that loop.
 */
export async function composeControlViews(
  runtime: RuntimeSnapshot,
  readStatus: (worktree: string) => Promise<ControlStatusRead>,
  clock: Clock,
): Promise<Record<string, ControlView>> {
  const panels = aggregateDashboard(runtime, clock).loops;
  const views = await Promise.all(
    runtime.roster.map(({ name }) => viewFor(name, attributedLoop(runtime, panels, name), readStatus, clock)),
  );
  return Object.fromEntries(views.map((view) => [view.loop, view]));
}
