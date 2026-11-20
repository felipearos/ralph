/**
 * Jav over HTTP: `GET /api/jav` reads the routing, `POST /api/jav/save`
 * validates and writes it. A thin route over the Jav adapter — the candidate
 * is judged by `jav.ts`, and a refused one is a 400 carrying every problem,
 * with the file untouched.
 */
import type { JavAdapter } from "./jav-adapter";

export const JAV_PATH = "/api/jav";
export const JAV_SAVE_PATH = "/api/jav/save";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** The response for a Jav path, or null when the path is not Jav's. */
export async function handleJavRoute(request: Request, pathname: string, jav: JavAdapter): Promise<Response | null> {
  if (pathname === JAV_PATH) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
    return json(await jav.read());
  }
  if (pathname === JAV_SAVE_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json({ error: "JavRequestError", message: "the request body is not valid JSON" }, 400);
    }
    const config = typeof body === "object" && body !== null && "config" in body ? body.config : undefined;
    if (config === undefined) return json({ error: "JavRequestError", message: "the request body must carry 'config'" }, 400);
    const saved = await jav.save(config);
    if (saved.valid) return json(saved);
    // The refusal every write answers with (`{ error, message, problems }`),
    // so the page's command module lists the problems; the save's own fields stay.
    return json({ error: "JavInvalid", message: "the routing was refused", ...saved }, 400);
  }
  return null;
}
