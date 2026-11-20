/**
 * The operator's write path over HTTP: a thin route over the dispatch layer.
 *
 * `POST /api/control` parses and validates one command, resolves the addressed
 * loop to its checkout, calls `dispatch`, and serializes the structured result.
 * The recorded state the page shows next to it — hold, stop, recorded outcomes,
 * deferrals — is the read-only control view at `GET /api/loops/:name/control`
 * (`control-view.ts`), read back from the loop's own record rather than
 * inferred from a successful send.
 *
 * What lives here is the HTTP contract and nothing else:
 *
 *   - every request names its loop and its action; a request that does not, or
 *     names an action outside the dispatch roster, is a 400;
 *   - `stop`, `abandon` and `release` must carry `"confirm": true`. The server
 *     enforces it, so a misclick — or a hand-written `curl` — cannot end a
 *     loop or take a ticket;
 *   - `abandon` and `release` name the ticket as `issue`, and nothing else
 *     may;
 *   - a loop outside the roster is a 404, and a roster loop with no checkout to
 *     address is a 409, each distinct from a validation failure.
 *
 * Whether a command is applied, replayed, refused, deferred or refused for a
 * replaced run is dispatch's answer, returned as a 200 with that outcome. No
 * CLI, flag or environment variable is named here, and nothing signals a
 * process.
 */
import { ControlRouteError, json, parseControlRequest, readBody } from "./command-requests";
import type { ControlResult, Dashboard, Liveness } from "./contracts";
import type { ControlAdapter } from "./control-adapter";
import { DispatchRequestError, dispatch } from "./dispatch";

export const CONTROL_PATH = "/api/control";

/** The loop a command is addressed to, as the runtime read discovered it. */
export interface ControlTarget {
  loop: string;
  /** The loop's checkout: the root its control adapter is anchored at. */
  worktree: string;
  /** The supervisor's liveness as the same read saw it. */
  supervisor: Liveness;
  /**
   * The registry id of the project the loop belongs to, stamped by the
   * project's handler: a start hands it on to the loop as the key its lineup
   * and Jav blocks are under.
   */
  project?: string;
}

/** Build the adapter dispatch runs against for one loop's checkout; it owns its executor. */
export type ControlsFactory = (target: ControlTarget) => { adapter: ControlAdapter };

export interface ControlRouteOptions {
  controls: ControlsFactory;
  /** The same runtime read the observation routes serve. */
  dashboard: () => Promise<Dashboard>;
  now?: () => Date;
}

/** Resolve a roster loop to the checkout its commands are anchored at. */
export async function targetFor(dashboard: () => Promise<Dashboard>, loop: string): Promise<ControlTarget> {
  const panel = (await dashboard()).loops.find((entry) => entry.loop === loop);
  if (panel === undefined) {
    throw new ControlRouteError(404, "UnknownLoop", `no loop '${loop}' in the roster`);
  }
  if (!panel.present || panel.worktree === null) {
    throw new ControlRouteError(409, "LoopNotAddressable", `loop '${loop}' has no checkout to address`);
  }
  return { loop: panel.loop, worktree: panel.worktree, supervisor: panel.supervisor };
}

/**
 * Answer the control route, or return null when the path is not it.
 *
 * Client errors are answered here; anything else propagates to the server's
 * own error mapping, so contract drift still surfaces as a 500.
 */
export async function handleControlRoute(
  request: Request,
  pathname: string,
  options: ControlRouteOptions,
): Promise<Response | null> {
  if (pathname !== CONTROL_PATH) return null;
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  try {
    const command = parseControlRequest(await readBody(request));
    const target = await targetFor(options.dashboard, command.loop);
    const result = await dispatch(
      {
        ...options.controls(target),
        loop: target.loop,
        supervisor: target.supervisor,
        ...(options.now === undefined ? {} : { now: options.now }),
      },
      command,
    );
    // The page reads this answer through `contracts.ts`; `satisfies` keeps the two in step.
    return json(result satisfies ControlResult);
  } catch (error) {
    if (error instanceof ControlRouteError) {
      return json({ error: error.name, message: error.message }, error.status);
    }
    if (error instanceof DispatchRequestError) {
      return json({ error: "ControlRequestError", message: error.message }, 400);
    }
    throw error;
  }
}
