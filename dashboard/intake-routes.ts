/**
 * The intake page over HTTP on the local dashboard (felipearos/ralph#459):
 * GET only, a thin route over the intake adapter.
 *
 * The local dashboard has no login by design — the machine's user is the
 * operator — so the metrics are served as they are and the session answers
 * `local`. The password belongs to the remote dashboard, where the page is
 * open to whoever has its link (`remote/intake-auth.ts`).
 */
import type { IntakeSessionView } from "./contracts";
import type { IntakeAdapter } from "./intake-adapter";

export const INTAKE_PATH = "/api/intake";
export const INTAKE_METRICS_PATH = "/api/intake/metrics";
export const INTAKE_SESSION_PATH = "/api/intake/session";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** The response for an intake path, or null when the path is not one. */
export async function handleIntakeRoute(request: Request, pathname: string, intake: IntakeAdapter): Promise<Response | null> {
  const read = {
    [INTAKE_PATH]: () => intake.tickets(),
    [INTAKE_METRICS_PATH]: () => intake.metrics(),
    [INTAKE_SESSION_PATH]: async () => ({ access: "local" }) satisfies IntakeSessionView,
  }[pathname];
  if (read === undefined) return null;
  if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  return json(await read());
}
