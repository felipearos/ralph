/**
 * One loop's control view, read from the project's batched `/api/controls`
 * (#615).
 *
 * Every loop card asks for its loop's control view. Read per loop, N cards
 * cost N requests a tick; read through this binding they share the one
 * batched URL in the store, and each picks its own row. An older server
 * answers that URL 404, and a remote whose bridge has not pushed `controls`
 * answers 503 before it ever served it: the project then falls back to the
 * per-loop route for the rest of the session, so a missing route degrades the
 * overview instead of breaking it.
 *
 * React-free, so the sharing and the fallback are tested with the store and a
 * fake fetch.
 */
import type { ControlsView, ControlView } from "../contracts";
import { LOADING, type Read, type ReadStore } from "./query-reads";
import { controlsRead, loopControlRead } from "./reads";

/** The batched URLs found missing this session (a 404, or a first-read 503); those projects read per loop. */
export interface ControlsFallback {
  missing(url: string): boolean;
  mark(url: string): void;
}

export function createControlsFallback(): ControlsFallback {
  const urls = new Set<string>();
  return {
    missing: (url) => urls.has(url),
    mark: (url) => {
      urls.add(url);
    },
  };
}

export interface LoopControlBinding {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Read<ControlView>;
  getInFlight: () => boolean;
  refresh: () => void;
}

/** The loop's row in a batched answer; null when the answer lacks it or is not the expected shape. */
function rowOf(data: ControlsView | null, loop: string): ControlView | null {
  const loops = data?.loops;
  if (typeof loops !== "object" || loops === null) return null;
  return Object.hasOwn(loops, loop) ? (loops[loop] ?? null) : null;
}

export function bindLoopControl(
  store: () => ReadStore,
  project: string | null,
  loop: string,
  fallback: ControlsFallback,
): LoopControlBinding {
  const batched = controlsRead(project);
  const single = loopControlRead(project, loop);
  // Decided at creation and switched once, never back: the session remembers
  // the 404, so a binding made later starts on the per-loop route.
  let perLoop = fallback.missing(batched.url);
  const url = (): string => (perLoop ? single.url : batched.url);

  // The derived read is cached on the store's read object: a fresh object per
  // call would make useSyncExternalStore re-render forever.
  let lastSource: Read<ControlsView> | null = null;
  let lastDerived: Read<ControlView> = LOADING;

  function derive(source: Read<ControlsView>): Read<ControlView> {
    if (source.state === "loading") return LOADING;
    if (source.state === "error") {
      return { state: "error", message: source.message, status: source.status, data: rowOf(source.data, loop) };
    }
    const row = rowOf(source.data, loop);
    // The per-loop route answers the same for a loop the project lacks.
    if (row === null) return { state: "error", message: `no loop '${loop}'`, status: 404, data: null };
    return { state: "ready", data: row, at: source.at, snapshotAt: source.snapshotAt };
  }

  // 404 is an older local server. The remote answers 503 (`NoSnapshot`,
  // `SnapshotUnavailable`) for a key its machine has not pushed: an older
  // bridge, or a bridge whose local server predates the route, never will, and
  // the remote deploys apart from the host. A 503 counts only before the route
  // ever answered, so a later blip on a working route does not end the
  // batching; a first-read 503 for another cause costs only the batching, the
  // per-loop route still answers or fails as it did before #615.
  const isMissing = (read: Read<ControlsView>): boolean =>
    read.state === "error" && (read.status === 404 || (read.status === 503 && read.data === null));

  return {
    subscribe(listener) {
      if (!perLoop && fallback.missing(batched.url)) perLoop = true;
      if (perLoop) return store().subscribe(single.url, single.intervalMs, listener);
      let unsubscribe: () => void = () => {};
      let active = true;
      const onBatched = (): void => {
        if (!active) return;
        // Another binding may have heard the 404 first and marked it.
        if (isMissing(store().get<ControlsView>(batched.url)) || fallback.missing(batched.url)) {
          fallback.mark(batched.url);
          perLoop = true;
          unsubscribe();
          unsubscribe = store().subscribe(single.url, single.intervalMs, listener);
        }
        listener();
      };
      unsubscribe = store().subscribe(batched.url, batched.intervalMs, onBatched);
      return () => {
        active = false;
        unsubscribe();
      };
    },
    getSnapshot() {
      if (perLoop) return store().get<ControlView>(single.url);
      const source = store().get<ControlsView>(batched.url);
      if (source !== lastSource) {
        lastSource = source;
        lastDerived = derive(source);
      }
      return lastDerived;
    },
    getInFlight: () => store().inFlight(url()),
    refresh: () => store().refresh(url()),
  };
}
