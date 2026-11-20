/**
 * Start and restart-to-apply over HTTP: thin routes over lifecycle dispatch.
 *
 * `POST /api/start` and `POST /api/restart` parse and validate one request,
 * resolve the addressed loop to its checkout, call `start` or `restartToApply`
 * from `lifecycle.ts`, and serialize the structured result. `GET
 * /api/loops/:name/checkout` returns the read-only checkout report the page
 * shows as a warning before an operator confirms a restart.
 *
 * What lives here is the HTTP contract and nothing else, in the same shape as
 * `control-routes.ts`:
 *
 *   - every request names its loop; a request that does not is a 400;
 *   - `restart` must carry `"confirm": true`. The server enforces it, so a
 *     misclick or a hand-written `curl` cannot bounce a loop. `start` needs no
 *     confirmation: a second start is the worktree lock's "already running"
 *     no-op, never a second supervisor;
 *   - a loop outside the roster is a 404, and a roster loop with no checkout to
 *     address is a 409.
 *
 * Whether a restart started, halted on an unconfirmed or pending stop, or was
 * refused for a replaced run is lifecycle dispatch's answer, returned as a 200
 * carrying the stop confirmation, the start report and the checkout. No
 * command, flag or environment variable is named here, nothing is repaired in
 * the worktree, and nothing here signals a process.
 *
 * `POST /api/stop-now` and `POST /api/resume-work` are the emergency stop and
 * the way back from it. Stop now must carry `"confirm": true` too; whether its
 * checks passed, what was signalled and whether the loop recorded the stop is
 * `interrupt.ts`'s answer, and the signal itself is `interrupt-adapter.ts`'s.
 * Resume work needs no confirmation: like start, it is refused over a live
 * supervisor.
 */
import {
  ControlRouteError,
  json,
  parseRestartRequest,
  parseResumeWorkRequest,
  parseStartRequest,
  parseStopNowRequest,
  readBody,
} from "./command-requests";
import type {
  CheckoutReport,
  Dashboard,
  ResumeWorkResult,
  RestartResult,
  StartResult,
  StopNowResult,
} from "./contracts";
import { targetFor, type ControlTarget } from "./control-routes";
import { stopNow, type InterruptDeps } from "./interrupt";
import { readCheckout, restartToApply, resumeWork, start, type LifecycleDeps } from "./lifecycle";

export const START_PATH = "/api/start";
export const RESTART_PATH = "/api/restart";
export const STOP_NOW_PATH = "/api/stop-now";
export const RESUME_WORK_PATH = "/api/resume-work";
const CHECKOUT_PATH = /^\/api\/loops\/([^/]+)\/checkout$/;

/**
 * Build what lifecycle dispatch runs against for one loop's checkout: the
 * control and lifecycle adapters, each owning its executor, and optionally
 * the wait's timing, which tests shorten.
 */
export type LifecycleFactory = (target: ControlTarget) => Omit<LifecycleDeps, "loop" | "now">;

/** Build what Stop now runs against for one loop's checkout: the signal adapter among them. */
export type InterruptFactory = (target: ControlTarget) => Omit<InterruptDeps, "loop" | "now">;

/**
 * A start that asks first whether the loop may start: a new agent may not
 * until its name is in `loops` on the base branch (`agents.ts`'s `gatedStart`).
 */
export type GatedStart = (target: ControlTarget, deps: LifecycleDeps) => Promise<StartResult>;

export interface LifecycleRouteOptions {
  lifecycle: LifecycleFactory;
  /** Absent, every start goes ahead ungated. */
  gatedStart?: GatedStart;
  /** Absent, `/api/stop-now` is not served. */
  interrupt?: InterruptFactory;
  /** The same runtime read the observation routes serve. */
  dashboard: () => Promise<Dashboard>;
  now?: () => Date;
}

/**
 * Answer a lifecycle route, or return null when the path is not one.
 *
 * Client errors are answered here; anything else propagates to the server's
 * own error mapping, so contract drift still surfaces as a 500.
 */
export async function handleLifecycleRoute(
  request: Request,
  pathname: string,
  options: LifecycleRouteOptions,
): Promise<Response | null> {
  const checkout = CHECKOUT_PATH.exec(pathname);
  const posts = [START_PATH, RESTART_PATH, RESUME_WORK_PATH, ...(options.interrupt === undefined ? [] : [STOP_NOW_PATH])];
  if (checkout === null && !posts.includes(pathname)) return null;
  const method = checkout === null ? "POST" : "GET";
  if (request.method !== method) {
    return new Response("method not allowed", { status: 405, headers: { allow: method } });
  }
  const depsFor = (target: ControlTarget): LifecycleDeps => ({
    ...options.lifecycle(target),
    loop: target.loop,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    if (checkout !== null) {
      const target = await targetFor(options.dashboard, decodeURIComponent(checkout[1]!));
      return json({ loop: target.loop, checkout: (await readCheckout(depsFor(target))) satisfies CheckoutReport });
    }
    const body = await readBody(request);
    if (pathname === START_PATH) {
      const command = parseStartRequest(body);
      const target = await targetFor(options.dashboard, command.loop);
      const deps = depsFor(target);
      // The page reads these answers through `contracts.ts`; `satisfies` keeps them in step.
      const result = options.gatedStart === undefined ? await start(deps, command) : await options.gatedStart(target, deps);
      return json(result satisfies StartResult);
    }
    if (pathname === RESUME_WORK_PATH) {
      const command = parseResumeWorkRequest(body);
      const target = await targetFor(options.dashboard, command.loop);
      return json((await resumeWork(depsFor(target), command)) satisfies ResumeWorkResult);
    }
    if (pathname === STOP_NOW_PATH && options.interrupt !== undefined) {
      const command = parseStopNowRequest(body);
      const target = await targetFor(options.dashboard, command.loop);
      const deps: InterruptDeps = {
        ...options.interrupt(target),
        loop: target.loop,
        ...(options.now === undefined ? {} : { now: options.now }),
      };
      return json((await stopNow(deps, command)) satisfies StopNowResult);
    }
    const command = parseRestartRequest(body);
    const target = await targetFor(options.dashboard, command.loop);
    return json((await restartToApply(depsFor(target), command)) satisfies RestartResult);
  } catch (error) {
    if (error instanceof ControlRouteError) {
      return json({ error: error.name, message: error.message }, error.status);
    }
    throw error;
  }
}
