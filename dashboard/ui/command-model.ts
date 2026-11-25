/**
 * The page's writes as one module (spec #607, "dashboard UI — one command
 * module"): which routes the page posts, how each is addressed, whether the
 * remote page may send it, and what its answer means.
 *
 * A write hand-rolled at its call site carries its own fetch, its own error
 * shape and its own remote lock, and that lock drifts from what the remote
 * function actually relays. Here each route is declared once by method and path, and
 * everything else about it — relayed, local-only, top-level — is read off
 * `../route-table`, the table the remote function itself serves from.
 *
 * Pure: the caller hands in `fetch`, the clock and the sleep; nothing here
 * touches the DOM.
 */
import type { BridgeStatusView } from "../contracts";
import { matchRoute, routeFlags } from "../route-table";
import { apiPath } from "./project-model";
import { controlLock, LOCAL_ONLY, settleRelay } from "./remote-model";

export interface CommandError {
  kind: string;
  message: string;
  status: number | null;
  problems?: string[];
  /** A refusal's `path`: the checkout already at the clone target, on `CloneTargetExists`. */
  path?: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** What the remote page does with a route: relay it, refuse it, or send it to the function as is. */
export type RemoteBehaviour = "relay" | "local-only" | "open";

export type CommandMethod = "POST" | "DELETE";

/**
 * Every write the page sends, by method and unscoped path (`<id>` for a
 * segment, as `route-table.ts` spells it). Only this list is hand-written.
 */
const DECLARED = [
  ["POST", "/api/control"],
  ["POST", "/api/start"],
  ["POST", "/api/restart"],
  ["POST", "/api/stop-now"],
  ["POST", "/api/resume-work"],
  ["POST", "/api/agents/start"],
  ["POST", "/api/notifications/read"],
  ["POST", "/api/evals/start"],
  ["POST", "/api/evals/stop"],
  ["POST", "/api/evals/set/add"],
  ["POST", "/api/evals/set/edit"],
  ["POST", "/api/evals/set/retire"],
  ["POST", "/api/evals/set/check"],
  ["POST", "/api/evals/set/keep"],
  ["POST", "/api/evals/inbox/add"],
  ["POST", "/api/evals/inbox/start"],
  ["POST", "/api/evals/inbox/dismiss"],
  ["POST", "/api/evals/improve/propose"],
  ["POST", "/api/evals/set/calibrate"],
  ["POST", "/api/evals/proposals/open-pr"],
  ["POST", "/api/agents"],
  ["POST", "/api/agents/delete"],
  ["POST", "/api/agents/checkout"],
  ["POST", "/api/agents/setup"],
  ["POST", "/api/agents/verifier"],
  ["POST", "/api/agents/sentinel"],
  ["POST", "/api/settings/project"],
  ["POST", "/api/settings/gates/run"],
  ["POST", "/api/settings/worktrees"],
  ["POST", "/api/settings/worktrees/cleanup"],
  ["POST", "/api/doctor"],
  ["POST", "/api/lineup/preview"],
  ["POST", "/api/lineup/save"],
  ["POST", "/api/lineup/updates/answer"],
  ["POST", "/api/jav/save"],
  ["POST", "/api/sleep"],
  ["POST", "/api/claude-accounts"],
  ["POST", "/api/learnings/file"],
  ["POST", "/api/setup"],
  ["POST", "/api/setup/validate"],
  ["POST", "/api/setup/tracker/test"],
  ["POST", "/api/setup/tracker/save"],
  ["POST", "/api/projects"],
  ["POST", "/api/projects/remove"],
  ["POST", "/api/projects/pick-folder"],
  ["POST", "/api/intake/login"],
  ["POST", "/api/intake/logout"],
  ["POST", "/api/chat"],
  ["POST", "/api/chat/<id>/turn"],
  ["POST", "/api/chat/<id>/mode"],
  ["POST", "/api/chat/<id>/handback"],
  ["POST", "/api/chat/<id>/stop-and-fix"],
  ["DELETE", "/api/chat/<id>"],
] as const satisfies readonly (readonly [CommandMethod, string])[];

/** A command's identifier is its unscoped path template. */
export type CommandPath = (typeof DECLARED)[number][1];

export interface CommandRoute {
  method: CommandMethod;
  path: CommandPath;
  scope: "project" | "root";
  remote: RemoteBehaviour;
}

/**
 * A route the remote function has no command row for (chat; any DELETE, which
 * it answers with its LocalOnly 403) is served only by the machine, so it is
 * local-only.
 */
function remoteOf(method: CommandMethod, path: string): RemoteBehaviour {
  if (method === "DELETE") return "local-only";
  const flags = routeFlags(method, path);
  if (flags === null) return "local-only";
  if (flags.relays) return "relay";
  if (flags.localOnly) return "local-only";
  return "open";
}

/** Top-level when route-table serves this method on the path beside the project list. */
function scopeOf(method: CommandMethod, path: string): "project" | "root" {
  const rows = matchRoute(path, "global")?.rows ?? [];
  return rows.some((row) => row.method === method) ? "root" : "project";
}

export const COMMAND_ROUTES: Record<CommandPath, CommandRoute> = Object.fromEntries(
  DECLARED.map(([method, path]) => [path, { method, path, scope: scopeOf(method, path), remote: remoteOf(method, path) }]),
) as Record<CommandPath, CommandRoute>;

export interface CommandAddress {
  project: string | null;
  params?: { id?: string };
}

/** The URL the page posts to: `<id>` filled and encoded, then scoped to the project unless top-level. */
export function commandUrl(path: CommandPath, { project, params }: CommandAddress): string {
  const filled = path.replace("<id>", () => encodeURIComponent(params?.id ?? ""));
  if (COMMAND_ROUTES[path].scope === "root" || project === null) return filled;
  return apiPath(project, filled);
}

const fail = <T>(kind: string, message: string, status: number | null): Result<T, CommandError> => ({
  ok: false,
  error: { kind, message, status },
});

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || (error as { name?: unknown } | null)?.name === "AbortError";

const failure = <T>(error: unknown, signal?: AbortSignal): Result<T, CommandError> =>
  isAbort(error, signal)
    ? fail("Aborted", "the request was cancelled", null)
    : fail("Network", error instanceof Error ? error.message : String(error), null);

/**
 * A response as a result. 2xx is the body (null when empty); any other status
 * is the `{ error, message, problems? }` refusal every route answers with,
 * and anything that is not one is `Malformed`, so a caller never parses.
 */
export async function decodeAnswer<T>(response: Response, signal?: AbortSignal): Promise<Result<T | null, CommandError>> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return failure(error, signal);
  }
  let body: unknown;
  let parsed = false;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      // Not JSON: a proxy page or a crash, answered as Malformed below.
    }
  }
  if (response.ok) {
    if (text.trim() === "") return { ok: true, value: null };
    if (parsed) return { ok: true, value: body as T };
    return fail("Malformed", `HTTP ${response.status}: the answer is not JSON`, response.status);
  }
  const refusal = parsed && typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (refusal === null || typeof refusal.error !== "string") return fail("Malformed", `HTTP ${response.status}`, response.status);
  const error: CommandError = {
    kind: refusal.error,
    message: typeof refusal.message === "string" ? refusal.message : "",
    status: response.status,
  };
  if (Array.isArray(refusal.problems)) {
    error.problems = refusal.problems.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof refusal.path === "string") error.path = refusal.path;
  return { ok: false, error };
}

export interface SendDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The page is the remote dashboard. */
  remote: boolean;
  project: string | null;
  params?: { id?: string };
  /** Called once when the remote function answered with a relay, before it is followed. */
  onQueued?: (relay: { id: string; expiresAt: string }) => void;
  signal?: AbortSignal;
}

const isRelayBody = (body: unknown): boolean => {
  const relay = (body as { relay?: unknown } | null)?.relay as { id?: unknown; expiresAt?: unknown } | null | undefined;
  return typeof relay === "object" && relay !== null && typeof relay.id === "string" && typeof relay.expiresAt === "string";
};

/** Whether a 202 carries a relay, read off a clone so the response stays readable. */
async function carriesRelay(response: Response): Promise<boolean> {
  if (response.status !== 202) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return isRelayBody(body);
}

/**
 * Send one command and settle its answer. Never throws: a refused remote
 * click, a dropped connection, an abort and a relay the machine never
 * answered all come back as a `CommandError`.
 */
export async function sendCommand<T>(path: CommandPath, body: unknown, deps: SendDeps): Promise<Result<T | null, CommandError>> {
  const route = COMMAND_ROUTES[path];
  // Refused before the network: the function would only answer a 403, or a 404 for what it never serves.
  if (deps.remote && route.remote === "local-only") return fail("LocalOnly", LOCAL_ONLY, null);
  const init: RequestInit = { method: route.method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (deps.signal !== undefined) init.signal = deps.signal;

  let response: Response;
  try {
    response = await deps.fetch(commandUrl(path, deps), init);
  } catch (error) {
    return failure(error, deps.signal);
  }

  try {
    if (await carriesRelay(response)) {
      // Only the remote function relays, and only these routes; a relay anywhere else is not an answer.
      if (route.remote !== "relay") return fail("Malformed", "HTTP 202: a relay on a route that is not relayed", 202);
      const scope = deps.project;
      const { signal } = deps;
      const pause = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const settled = await settleRelay(response, {
        // The remote function's command read: the only place the page follows a relay.
        read: (id) => {
          const read = `/api/commands/${encodeURIComponent(id)}`;
          const init: RequestInit = { cache: "no-store", credentials: "same-origin" };
          if (signal !== undefined) init.signal = signal;
          return deps.fetch(scope === null ? read : apiPath(scope, read), init);
        },
        // A caller that gave up (a closed sheet, a superseded send) stops the
        // poll at its next pause rather than waiting out the expiry; settleRelay
        // swallows a failed read, so the abort is raised from the sleep.
        sleep: async (ms) => {
          await pause(ms);
          if (signal?.aborted === true) throw new DOMException("the request was cancelled", "AbortError");
        },
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.onQueued === undefined ? {} : { onQueued: deps.onQueued }),
      });
      if (signal?.aborted === true) return fail("Aborted", "the request was cancelled", null);
      return await decodeAnswer<T>(settled, deps.signal);
    }
  } catch (error) {
    return failure(error, deps.signal);
  }
  return decodeAnswer<T>(response, deps.signal);
}

/** Whether the page offers a command, and the tooltip saying why not. */
export function availability(
  path: CommandPath,
  { remote, bridge }: { remote: boolean; bridge: BridgeStatusView | null },
): { disabled: boolean; why: string | null } {
  if (!remote) return { disabled: false, why: null };
  const behaviour = COMMAND_ROUTES[path].remote;
  if (behaviour === "local-only") return { disabled: true, why: LOCAL_ONLY };
  if (behaviour === "relay") return controlLock(true, bridge);
  return { disabled: false, why: null };
}

/**
 * A 2xx with no body on a route that always answers one: shown as a failure
 * rather than read as a pick, a report or a save that never happened.
 */
export const EMPTY_ANSWER: CommandError = { kind: "Malformed", message: "the server answered with an empty body", status: null };

/** The one line a notice shows for a failed command. */
export const noticeText = (error: CommandError): string => (error.message === "" ? error.kind : `${error.kind}: ${error.message}`);
