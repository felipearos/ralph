/**
 * The remote dashboard's page rules (spec #165 §8): the bridge banner, the
 * snapshot stamp, the control lock and a relayed command's answer.
 *
 * Pure: the components hand in the bridge's status, the clock and a way to
 * read a command; nothing here touches the DOM. None of it runs on the local
 * dashboard, whose page has no `ralph-remote` flag (`isRemote` in `api.ts`).
 */
import type { BridgeStatusView, RelayAccepted, RelayedCommandView } from "../contracts";

/** What a local-only affordance says on the remote page. */
export const LOCAL_ONLY = "Local dashboard only";

/** What the page says while a relayed command waits for the machine. */
export const RELAY_QUEUED = "Sent to the machine, waiting for it to apply";

/** A snapshot older than this is labelled stale. */
export const STALE_AFTER_MS = 60_000;

/** How often a queued command is read back. */
export const RELAY_POLL_MS = 1_000;

/**
 * How long past a command's expiry the page keeps asking. A row the bridge
 * claimed and then lost stays claimed, so the poll needs an end.
 */
const RELAY_GRACE_MS = 120_000;

export type BannerTone = "good" | "info" | "warn" | "bad";

export interface BannerLine {
  tone: BannerTone;
  text: string;
}

const clock = (at: Date): string => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The banner's lines, most important first. Offline says everything: the rest
 * describes a machine that is not there. Live, the first line is the
 * machine's state and any further line is a caveat on the controls.
 *
 * `snapshotAt` is the dashboard snapshot's push time, for the idle line.
 */
export function bridgeBanner(
  view: BridgeStatusView,
  { nowMs, snapshotAt, time = clock }: { nowMs: number; snapshotAt: Date | null; time?: (at: Date) => string },
): BannerLine[] {
  if (!view.live) {
    const since = view.lastSeenAt === null ? ": it has never connected" : ` since ${time(new Date(view.lastSeenAt))}`;
    return [{ tone: "bad", text: `Machine offline${since}. Everything below is the last known state.` }];
  }
  const lines: BannerLine[] = [];
  if (view.local === "dashboard-down") {
    lines.push({ tone: "bad", text: "Machine up, local dashboard down" });
  } else if (view.local === "redactor-degraded") {
    lines.push({ tone: "warn", text: "Machine up, but its redactor is failing, so nothing new is relayed" });
  } else if (view.snapshots === "hot") {
    const seconds = view.lastSeenAt === null ? 0 : Math.max(0, Math.round((nowMs - Date.parse(view.lastSeenAt)) / 1000));
    lines.push({ tone: "good", text: `Live, machine seen ${seconds} s ago` });
  } else {
    const asOf = snapshotAt === null ? "." : `; showing its state as of ${time(snapshotAt)}.`;
    lines.push({ tone: "info", text: `Connected. Refreshing from the machine${asOf}` });
  }

  const { bridge, app } = view.schema;
  if (bridge !== app) {
    lines.push({
      tone: "warn",
      text:
        bridge < app
          ? `The machine runs an older ralph (schema ${bridge}, app ${app}); deploy ~/ralph`
          : `The machine runs a newer ralph (schema ${bridge}, app ${app}); redeploy the remote dashboard`,
    });
  }
  if (view.wake === "poll-only") lines.push({ tone: "warn", text: "Commands may take up to 30 s" });
  // Disabled for a reason none of the lines above gives: the kill switch.
  if (view.controls === "disabled" && view.local === "ok" && bridge === app) {
    lines.push({ tone: "warn", text: `Controls off: ${view.why ?? "remote control is disabled"}` });
  }
  return lines;
}

/**
 * Whether the loop controls and Mark read are off, and the tooltip saying
 * why. Locally never; remotely until the bridge is known to allow them.
 */
export function controlLock(remote: boolean, view: BridgeStatusView | null): { disabled: boolean; why: string | null } {
  if (!remote) return { disabled: false, why: null };
  if (view === null) return { disabled: true, why: "Checking whether the machine is there…" };
  if (view.controls === "enabled") return { disabled: false, why: null };
  return { disabled: true, why: view.why ?? "Controls are disabled" };
}

/** The push time a remote snapshot response carries; null locally. */
export function snapshotAtOf(headers: Headers): Date | null {
  const value = headers.get("x-ralph-snapshot-at");
  if (value === null) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * What "Updated" names: the snapshot's push time when the response said one,
 * else the fetch time. Only a snapshot can be stale; a local read is current.
 */
export function snapshotStamp(fetchedAt: Date, snapshotAt: Date | null, nowMs: number): { at: Date; stale: boolean } {
  if (snapshotAt === null) return { at: fetchedAt, stale: false };
  return { at: snapshotAt, stale: nowMs - snapshotAt.getTime() > STALE_AFTER_MS };
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const TERMINAL = new Set<RelayedCommandView["state"]>(["done", "refused", "expired", "failed"]);

/**
 * A finished command as the response the local route would have given: its
 * own status and body when the machine answered, else an error body with the
 * reason, in the `{ error, message }` shape every caller already renders.
 */
export function relayAnswer(view: RelayedCommandView): Response {
  if (view.httpStatus !== null && view.result !== null && view.result !== undefined) return json(view.result, view.httpStatus);
  const error = view.state === "expired" ? "Expired" : view.state === "refused" ? "Refused" : "Failed";
  return json({ error, message: view.why ?? `the command ended ${view.state} without an answer` }, 503);
}

export interface RelayOptions {
  /** `GET /api/commands/:id`, scoped to the page's project. */
  read: (id: string) => Promise<Response>;
  /** Called once when the answer is a relay, before the first read. */
  onQueued?: (relay: RelayAccepted["relay"]) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const isRelay = (body: unknown): body is RelayAccepted => {
  const relay = (body as { relay?: unknown } | null)?.relay as { id?: unknown; expiresAt?: unknown } | undefined;
  return typeof relay === "object" && relay !== null && typeof relay.id === "string" && typeof relay.expiresAt === "string";
};

/**
 * A command POST's answer, settled. The remote function answers `202 { relay }`
 * when the machine has not finished within its wait; this polls the command
 * every second until it ends and answers what it ended with, so a caller
 * treats the result exactly as a local answer. Any other response, including
 * every local one, comes back untouched.
 */
export async function settleRelay(response: Response, options: RelayOptions): Promise<Response> {
  if (response.status !== 202) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isRelay(body)) return response;
  const { read, onQueued, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = options;
  onQueued?.(body.relay);
  const deadline = Date.parse(body.relay.expiresAt) + RELAY_GRACE_MS;
  while (now() < deadline) {
    await sleep(RELAY_POLL_MS);
    let answer: Response;
    try {
      answer = await read(body.relay.id);
    } catch {
      continue;
    }
    // The command is gone or was never this project's: nothing more will come.
    if (answer.status === 404) return answer;
    if (!answer.ok) continue;
    const view = (await answer.json().catch(() => null)) as RelayedCommandView | null;
    if (view !== null && TERMINAL.has(view.state)) return relayAnswer(view);
  }
  return json(
    { error: "NoAnswer", message: "the machine has not answered yet; the loop's History shows the outcome once it does" },
    504,
  );
}
