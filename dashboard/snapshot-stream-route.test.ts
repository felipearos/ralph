/**
 * The change stream behind the local server's handler (#724), with a stub
 * adapter and a fake file watch: however many pages stream one project, a
 * change costs one adapter read. Nothing here spawns.
 */
import { describe, expect, it, vi } from "vitest";

import { coderRoster, type LocalSnapshot, type ProjectsHealthView, type RuntimeSnapshot } from "./contracts";
import { liveHealth } from "./health";
import { createHandler, type ProjectScope } from "./server";
import type { WatchDir } from "./snapshot-stream";

const PROJECT = "alpha";
const LOOP = "ralph";
// Never created: the adapter is a stub, and the watch is fake.
const WORKTREE = "/nonexistent/snapshot-stream-route/alpha";

const runtime = (stage: "iteration" | "stopped", worktree = WORKTREE): RuntimeSnapshot => ({
  roster: coderRoster(LOOP),
  loops: [
    {
      worktree,
      identity: LOOP,
      loopStatus: "running",
      worktreeStatus: "live",
      branch: "ralph/14",
      state: {
        version: 1,
        run: "run-alpha",
        owner: { loop: LOOP, pid: null, host: "test" },
        worktree,
        branch: "ralph/14",
        stage,
        iteration: { index: 1, max: 10 },
        heartbeat: "2026-10-09T00:00:00.000Z",
        lastEvent: null,
        stopReason: null,
      },
      stateProblem: null,
      supervisor: "alive",
      presence: null,
    },
  ],
  reconciliation: { orphaned: [], prunable: [] },
});

/** Reads until `done` holds; true when the stream ended first. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, seen: { text: string }, done: (text: string) => boolean) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 10_000;
  while (!done(seen.text)) {
    if (Date.now() > deadline) throw new Error(`timed out; read so far: ${JSON.stringify(seen.text)}`);
    const chunk = await reader.read();
    if (chunk.done) return true;
    seen.text += decoder.decode(chunk.value, { stream: true });
  }
  return false;
}

describe("the change stream over the local handler", () => {
  it("serves two pages from one adapter read per change", async () => {
    const read = vi.fn(async () => runtime("iteration"));
    const watched = new Map<string, (filename: string | null) => void>();
    const watch: WatchDir = (dir, onChange) => {
      watched.set(dir, onChange);
      return { close: () => watched.delete(dir) };
    };
    const scope: ProjectScope = {
      project: { id: PROJECT, path: WORKTREE, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
      adapter: { read },
    };
    const handler = createHandler({
      projects: () => [scope],
      shell: "<html>shell</html>",
      clock: () => ({ nowMs: Date.parse("2026-10-09T00:00:05.000Z") }),
      // No fallback tick inside the test, so every adapter read is the baseline's or the change's.
      snapshotStream: { debounceMs: 10, minIntervalMs: 20, fallbackMs: 600_000, heartbeatMs: 600_000, watch, log: () => undefined },
    });

    const pages = [new AbortController(), new AbortController()].map((controller) => ({
      controller,
      request: new Request(`http://127.0.0.1/api/p/${PROJECT}/stream`, { signal: controller.signal }),
    }));
    const streams = await Promise.all(
      pages.map(async (page) => {
        const response = await handler(page.request);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        return { reader: response.body!.getReader(), seen: { text: "" } };
      }),
    );
    for (const stream of streams) await readUntil(stream.reader, stream.seen, (text) => text.includes("retry:"));

    // The baseline has been read and hashed once its watches are made.
    const logs = `${WORKTREE}/.ralph/logs`;
    await vi.waitFor(() => expect(watched.has(logs)).toBe(true), { timeout: 10_000, interval: 10 });
    expect(read).toHaveBeenCalledTimes(1);

    read.mockImplementation(async () => runtime("stopped"));
    watched.get(logs)!("state.json");
    for (const stream of streams) {
      await readUntil(stream.reader, stream.seen, (text) => text.includes("data: "));
      expect(stream.seen.text).toContain('data: {"key":"dashboard","version":1}\n\n');
    }
    expect(read).toHaveBeenCalledTimes(2);

    // The handler rewrites a scoped request into a new one, whose signal follows
    // ours only while that copy is reachable; in-process, nothing holds it. A
    // browser going away also cancels the body, which ends the stream for sure.
    for (const [index, page] of pages.entries()) {
      page.controller.abort();
      await streams[index]!.reader.cancel();
    }
    // The last page gone, the hub's watches close with it.
    expect(watched.size).toBe(0);
  });

  it("names the control reads a processed command moves, with no snapshot change", async () => {
    const read = vi.fn(async () => runtime("iteration"));
    const { watch, watched } = fakeWatch();
    const handler = createHandler({
      projects: () => [scopeOf(PROJECT, WORKTREE, read)],
      shell: "<html>shell</html>",
      clock: () => ({ nowMs: Date.parse("2026-10-09T00:00:05.000Z") }),
      snapshotStream: { ...TUNING, watch },
    });
    const controller = new AbortController();
    const response = await handler(new Request(`http://127.0.0.1/api/p/${PROJECT}/stream`, { signal: controller.signal }));
    const reader = response.body!.getReader();
    const seen = { text: "" };
    await readUntil(reader, seen, (text) => text.includes("retry:"));
    const processed = `${WORKTREE}/.ralph/control/processed`;
    await vi.waitFor(() => expect(watched.has(processed)).toBe(true), { timeout: 10_000, interval: 10 });

    watched.get(processed)!("cmd-1.json");
    await readUntil(reader, seen, (text) => text.includes(`"history/${LOOP}"`) && text.includes('"controls"'));
    expect(seen.text).not.toContain('"dashboard"');
    controller.abort();
    await reader.cancel();
  });

  it("forwards another project's health without its dashboard read, primes its cache, and outlives its removal", async () => {
    const BETA = "beta";
    const BETA_TREE = "/nonexistent/snapshot-stream-route/beta";
    const readAlpha = vi.fn(async () => runtime("iteration"));
    const readBeta = vi.fn(async () => runtime("iteration", BETA_TREE));
    let betaStatus: "running" | "idle" = "running";
    const localBeta = vi.fn(async (): Promise<LocalSnapshot> => {
      const snapshot = runtime("iteration", BETA_TREE);
      return { roster: snapshot.roster, loops: snapshot.loops.map((loop) => ({ ...loop, loopStatus: betaStatus })) };
    });
    const alpha = scopeOf(PROJECT, WORKTREE, readAlpha, async () => runtime("iteration"));
    const beta = scopeOf(BETA, BETA_TREE, readBeta, localBeta);
    let registered: ProjectScope[] = [alpha, beta];
    const { watch, watched } = fakeWatch();
    const handler = createHandler({
      projects: () => registered,
      shell: "<html>shell</html>",
      clock: () => ({ nowMs: Date.parse("2026-10-09T00:00:05.000Z") }),
      snapshotStream: { ...TUNING, watch },
    });
    const healthOf = async () => {
      const body = (await (await handler(new Request(`http://127.0.0.1/api/projects/health?selected=${PROJECT}`))).json()) as ProjectsHealthView;
      return body.projects.find((entry) => entry.project === BETA)!;
    };
    // Cached for 30s from here: only the stream's prime can move it sooner.
    const before = await healthOf();
    expect(before.running).toBe(1);

    const controller = new AbortController();
    const response = await handler(new Request(`http://127.0.0.1/api/p/${PROJECT}/stream`, { signal: controller.signal }));
    const reader = response.body!.getReader();
    const seen = { text: "" };
    await readUntil(reader, seen, (text) => text.includes("retry:"));
    const alphaLogs = `${WORKTREE}/.ralph/logs`;
    const betaLogs = `${BETA_TREE}/.ralph/logs`;
    await vi.waitFor(() => expect(watched.has(alphaLogs) && watched.has(betaLogs)).toBe(true), { timeout: 10_000, interval: 10 });

    betaStatus = "idle";
    watched.get(betaLogs)!("state.json");
    await readUntil(reader, seen, (text) => text.includes('"key":"_/health"'));
    expect((await healthOf()).running).toBe(0);

    // A's own change on the same wire, after B's.
    readAlpha.mockImplementation(async () => runtime("stopped"));
    watched.get(alphaLogs)!("state.json");
    await readUntil(reader, seen, (text) => text.includes('"key":"dashboard"'));

    // B gone from the registry: its hub closes, A's stream stays open.
    registered = [alpha];
    await handler(new Request("http://127.0.0.1/api/projects"));
    expect(watched.has(betaLogs)).toBe(false);
    readAlpha.mockImplementation(async () => runtime("iteration"));
    const dashboards = (text: string) => text.split('"key":"dashboard"').length - 1;
    watched.get(alphaLogs)!("state.json");
    expect(await readUntil(reader, seen, (text) => dashboards(text) >= 2)).toBe(false);

    const versions = [...seen.text.matchAll(/"version":(\d+)/g)].map((match) => Number(match[1]));
    expect(versions.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < versions.length; index += 1) expect(versions[index]).toBeGreaterThan(versions[index - 1]!);
    expect(readBeta).not.toHaveBeenCalled();
    controller.abort();
    await reader.cancel();
  });
});

// No fallback tick inside the tests, so every read is the baseline's or the change's.
const TUNING = { debounceMs: 10, minIntervalMs: 20, fallbackMs: 600_000, heartbeatMs: 600_000, log: () => undefined };

function fakeWatch() {
  const watched = new Map<string, (filename: string | null) => void>();
  const watch: WatchDir = (dir, onChange) => {
    watched.set(dir, onChange);
    return { close: () => watched.delete(dir) };
  };
  return { watch, watched };
}

/** A scope like the composition's: a stub adapter, and its health live when `local` is given. */
function scopeOf(id: string, worktree: string, read: () => Promise<RuntimeSnapshot>, local?: () => Promise<LocalSnapshot>): ProjectScope {
  const scope: ProjectScope = {
    project: { id, path: worktree, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
    adapter: { read },
  };
  if (local === undefined) return scope;
  const { health, producer } = liveHealth({
    project: id,
    local,
    controlStatus: async () => ({ kind: "unreadable", why: "no control reader in this test" }),
    // The production spacing (5s) would hold the change past the test's deadline.
    minIntervalMs: 20,
  });
  return { ...scope, health, healthProducer: producer };
}
