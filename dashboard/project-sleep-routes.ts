/**
 * A project's sleep over HTTP: `GET /api/sleep` reads it, `POST /api/sleep`
 * sets it.
 *
 *   {"asleep": true, "why"?: "<text>"}   put every loop of the project to sleep
 *   {"asleep": false}                    wake them
 *
 * Both answer the `ProjectSleepView` the harness printed afterwards. Sleeping
 * is soft: the CLI writes one marker each loop reads at its iteration
 * boundary, so a loop mid-iteration finishes it first. Both verbs are
 * idempotent in the CLI, so a double click is harmless.
 *
 * A thin route over the adapter: it validates the body's shape and nothing
 * else. A CLI that failed is a view with a `problem`, answered 200 like any
 * other view, so the page shows why rather than a bare error.
 */
import { PROJECT_SLEEP_WHY_MAX, type ProjectSleepView } from "./contracts";
import { ControlRouteError, invalid, json, optionalText, readBody } from "./command-requests";
import type { ProjectSleepAdapter } from "./project-sleep-adapter";

export const PROJECT_SLEEP_PATH = "/api/sleep";

export type ProjectSleepRequest = { asleep: true; why: string | null } | { asleep: false };

export function parseProjectSleepRequest(body: unknown): ProjectSleepRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  if (typeof fields.asleep !== "boolean") throw invalid("'asleep' is required: true to sleep the project, false to wake it");
  const why = optionalText(fields, "why");
  if (!fields.asleep) {
    if (why !== null) throw invalid("'why' applies only when putting the project to sleep");
    return { asleep: false };
  }
  if (why !== null && why.length > PROJECT_SLEEP_WHY_MAX) {
    throw invalid(`'why' is ${why.length} characters; keep it under ${PROJECT_SLEEP_WHY_MAX}`);
  }
  // One line: the marker's reason is shown in a single-line banner.
  if (why !== null && /[\r\n]/.test(why)) throw invalid("'why' must be one line");
  return { asleep: true, why };
}

/** The response for the sleep path, or null when the path is not the sleep's. */
export async function handleProjectSleepRoute(
  request: Request,
  pathname: string,
  sleep: ProjectSleepAdapter,
): Promise<Response | null> {
  if (pathname !== PROJECT_SLEEP_PATH) return null;
  if (request.method === "GET") return json((await sleep.status()) satisfies ProjectSleepView);
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  try {
    const parsed = parseProjectSleepRequest(await readBody(request));
    const view = parsed.asleep ? await sleep.sleep(parsed.why) : await sleep.wake();
    return json(view satisfies ProjectSleepView);
  } catch (error) {
    if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
    throw error;
  }
}
