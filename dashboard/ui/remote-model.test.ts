import { describe, expect, it } from "vitest";

import type { BridgeStatusView, RelayedCommandView } from "../contracts";
import { bridgeBanner, controlLock, relayAnswer, settleRelay, snapshotAtOf, snapshotStamp } from "./remote-model";

const NOW = Date.parse("2026-10-09T21:05:00.000Z");
/** Wall-clock time, pinned so the sentences do not depend on the host's locale. */
const time = (at: Date): string => at.toISOString().slice(11, 16);

const bridge = (over: Partial<BridgeStatusView> = {}): BridgeStatusView => ({
  live: true,
  snapshots: "hot",
  lastSeenAt: "2026-10-09T21:04:57.000Z",
  wake: "realtime",
  local: "ok",
  controls: "enabled",
  why: null,
  schema: { bridge: 1, app: 1 },
  ...over,
});

const banner = (view: BridgeStatusView, snapshotAt: Date | null = null) => bridgeBanner(view, { nowMs: NOW, snapshotAt, time });

describe("the bridge banner", () => {
  it("is live, with the heartbeat's age, while the project is hot", () => {
    expect(banner(bridge())).toEqual([{ tone: "good", text: "Live, machine seen 3 s ago" }]);
  });

  it("says it is refreshing, and as of when, while the project is still idle", () => {
    expect(banner(bridge({ snapshots: "idle" }), new Date("2026-10-09T21:02:10.000Z"))).toEqual([
      { tone: "info", text: "Connected. Refreshing from the machine; showing its state as of 21:02." },
    ]);
    expect(banner(bridge({ snapshots: "idle" }))).toEqual([{ tone: "info", text: "Connected. Refreshing from the machine." }]);
  });

  it("adds an amber note when wake-ups are not arriving", () => {
    expect(banner(bridge({ wake: "poll-only" }))).toEqual([
      { tone: "good", text: "Live, machine seen 3 s ago" },
      { tone: "warn", text: "Commands may take up to 30 s" },
    ]);
  });

  it("is red when the machine is offline, naming when it was last seen", () => {
    const offline = bridge({ live: false, lastSeenAt: "2026-10-09T20:41:00.000Z", controls: "disabled", why: "offline" });
    expect(banner(offline)).toEqual([
      { tone: "bad", text: "Machine offline since 20:41. Everything below is the last known state." },
    ]);
    // Offline outranks every other note: nothing else about the machine is current.
    expect(banner({ ...offline, wake: "poll-only", schema: { bridge: 0, app: 1 } })).toHaveLength(1);
    expect(banner(bridge({ live: false, lastSeenAt: null }))[0]).toEqual({
      tone: "bad",
      text: "Machine offline: it has never connected. Everything below is the last known state.",
    });
  });

  it("says when the machine is up but its local dashboard is down", () => {
    expect(banner(bridge({ local: "dashboard-down", controls: "disabled", why: "down" }))).toEqual([
      { tone: "bad", text: "Machine up, local dashboard down" },
    ]);
  });

  it("says when the machine's redactor is failing", () => {
    expect(banner(bridge({ local: "redactor-degraded", controls: "disabled", why: "redactor" }))[0]).toEqual({
      tone: "warn",
      text: "Machine up, but its redactor is failing, so nothing new is relayed",
    });
  });

  it("names both schemas when the machine runs an older ralph", () => {
    expect(banner(bridge({ schema: { bridge: 1, app: 2 }, controls: "disabled", why: "older" }))).toEqual([
      { tone: "good", text: "Live, machine seen 3 s ago" },
      { tone: "warn", text: "The machine runs an older ralph (schema 1, app 2); deploy ~/ralph" },
    ]);
    expect(banner(bridge({ schema: { bridge: 3, app: 2 }, controls: "disabled", why: "newer" }))[1]).toEqual({
      tone: "warn",
      text: "The machine runs a newer ralph (schema 3, app 2); redeploy the remote dashboard",
    });
  });

  it("gives the reason when controls are off for any other reason", () => {
    expect(banner(bridge({ controls: "disabled", why: "remote control is disabled on the machine" }))).toEqual([
      { tone: "good", text: "Live, machine seen 3 s ago" },
      { tone: "warn", text: "Controls off: remote control is disabled on the machine" },
    ]);
  });

  it("never shows a negative age when the clocks disagree", () => {
    expect(banner(bridge({ lastSeenAt: "2026-10-09T21:05:04.000Z" }))[0]!.text).toBe("Live, machine seen 0 s ago");
  });
});

describe("the control lock", () => {
  it("never locks the local dashboard", () => {
    expect(controlLock(false, null)).toEqual({ disabled: false, why: null });
  });

  it("locks until the bridge has been read, then follows its controls and why", () => {
    expect(controlLock(true, null)).toEqual({ disabled: true, why: "Checking whether the machine is there…" });
    expect(controlLock(true, bridge())).toEqual({ disabled: false, why: null });
    expect(controlLock(true, bridge({ controls: "disabled", why: "the machine is offline" }))).toEqual({
      disabled: true,
      why: "the machine is offline",
    });
    expect(controlLock(true, bridge({ controls: "disabled", why: null }))).toEqual({ disabled: true, why: "Controls are disabled" });
  });
});

describe("the snapshot stamp", () => {
  const fetched = new Date(NOW);

  it("reads the push time from the response header, and nothing else", () => {
    expect(snapshotAtOf(new Headers({ "x-ralph-snapshot-at": "2026-10-09T21:04:00.000Z" }))).toEqual(new Date("2026-10-09T21:04:00.000Z"));
    expect(snapshotAtOf(new Headers())).toBeNull();
    expect(snapshotAtOf(new Headers({ "x-ralph-snapshot-at": "soon" }))).toBeNull();
  });

  it("is the fetch time locally, never stale", () => {
    expect(snapshotStamp(fetched, null, NOW + 600_000)).toEqual({ at: fetched, stale: false });
  });

  it("is the snapshot time remotely, stale past 60 s", () => {
    const pushed = new Date(NOW - 60_000);
    expect(snapshotStamp(fetched, pushed, NOW)).toEqual({ at: pushed, stale: false });
    expect(snapshotStamp(fetched, pushed, NOW + 1)).toEqual({ at: pushed, stale: true });
  });
});

/* ------------------------------------------------------------------ relay */

const command = (over: Partial<RelayedCommandView> = {}): RelayedCommandView => ({
  id: "c-1",
  kind: "control",
  state: "claimed",
  createdAt: "2026-10-09T21:05:00.000Z",
  expiresAt: "2026-10-09T21:10:00.000Z",
  finishedAt: null,
  httpStatus: null,
  result: null,
  why: null,
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const accepted = () => json({ relay: { id: "c-1", state: "queued", expiresAt: "2026-10-09T21:10:00.000Z" } }, 202);

/** A command view endpoint that answers `views` in turn, and the paths and waits it saw. */
function machine(views: Array<RelayedCommandView | Response>) {
  const reads: string[] = [];
  const waits: number[] = [];
  let clock = NOW;
  return {
    reads,
    waits,
    options: {
      read: async (id: string) => {
        reads.push(id);
        const next = views.shift() ?? command();
        return next instanceof Response ? next : json(next);
      },
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe("a relayed command", () => {
  it("passes any answer that is not a relay through untouched", async () => {
    const local = json({ outcome: "applied" });
    expect(await settleRelay(local, machine([]).options)).toBe(local);
    const other202 = json({ queued: true }, 202);
    expect(await settleRelay(other202, machine([]).options)).toBe(other202);
  });

  it("says it was sent, polls every second, and answers the machine's own reply", async () => {
    const fake = machine([command(), command({ state: "done", httpStatus: 200, result: { outcome: "applied" } })]);
    const queued: string[] = [];
    const answer = await settleRelay(accepted(), { ...fake.options, onQueued: (relay) => queued.push(relay.id) });
    expect(queued).toEqual(["c-1"]);
    expect(fake.reads).toEqual(["c-1", "c-1"]);
    expect(fake.waits).toEqual([1000, 1000]);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ outcome: "applied" });
  });

  it("answers a refusal with the local status and body, exactly as the local route would", async () => {
    const refusal = { error: "ProjectNotReady", message: "the project is not set up" };
    const fake = machine([command({ state: "refused", httpStatus: 409, result: refusal })]);
    const answer = await settleRelay(accepted(), fake.options);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual(refusal);
  });

  it("answers expired and failed commands with their why", async () => {
    const expired = relayAnswer(command({ state: "expired", why: "the machine did not pick it up within 60 s" }));
    expect(expired.ok).toBe(false);
    expect(await expired.json()).toEqual({ error: "Expired", message: "the machine did not pick it up within 60 s" });
    const failed = relayAnswer(command({ state: "failed", why: "the bridge restarted mid-command" }));
    expect(await failed.json()).toEqual({ error: "Failed", message: "the bridge restarted mid-command" });
    // The kill switch refuses without a local answer.
    const refused = relayAnswer(command({ state: "refused", why: "remote control is off" }));
    expect(await refused.json()).toEqual({ error: "Refused", message: "remote control is off" });
  });

  it("keeps polling through a failed read, and stops at an unknown command", async () => {
    const gone = json({ error: "UnknownCommand", message: "no command 'c-1' in this project" }, 404);
    const fake = machine([json({ error: "boom" }, 500), gone]);
    const answer = await settleRelay(accepted(), fake.options);
    expect(fake.reads).toHaveLength(2);
    expect(answer.status).toBe(404);
  });

  it("gives up a while after the command's expiry, saying where the outcome will show", async () => {
    const fake = machine(Array.from({ length: 1000 }, () => command()));
    const answer = await settleRelay(accepted(), fake.options);
    expect(answer.status).toBe(504);
    expect(await answer.json()).toMatchObject({ error: "NoAnswer" });
    // Five minutes to expiry plus two of grace, a read a second.
    expect(fake.reads.length).toBeGreaterThanOrEqual(400);
    expect(fake.reads.length).toBeLessThanOrEqual(421);
  });
});
