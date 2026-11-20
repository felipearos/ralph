/**
 * Filing a learning as a ticket over HTTP: `POST /api/learnings/file`.
 *
 *   {"slug": "<entry slug>", "scope": "project" | "harness"}
 *
 * Answers the `LearningFiledView` the harness printed. A CLI that refused —
 * the entry already names a ticket, lacks its evidence, or is gone — is a view
 * with a `problem`, answered 200 like any other view, so the page says why.
 * Filing is idempotent in the harness, so a double click files one ticket.
 */
import type { LearningFiledView } from "./contracts";
import { ControlRouteError, invalid, json, optionalText, readBody } from "./command-requests";
import type { LearningScopeName, LearningsFileAdapter } from "./learnings-file-adapter";

export const LEARNINGS_FILE_PATH = "/api/learnings/file";

/** The shape `<!-- learning: … -->` allows; anything else never reaches the CLI. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function parseLearningsFileRequest(body: unknown): { slug: string; scope: LearningScopeName } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const slug = optionalText(fields, "slug");
  if (slug === null || !SLUG.test(slug)) throw invalid("'slug' is required: the entry's `<!-- learning: … -->` slug");
  const scope = optionalText(fields, "scope");
  if (scope !== "project" && scope !== "harness") throw invalid("'scope' must be 'project' or 'harness'");
  return { slug, scope };
}

export async function handleLearningsFileRoute(
  request: Request,
  pathname: string,
  adapter: LearningsFileAdapter,
): Promise<Response | null> {
  if (pathname !== LEARNINGS_FILE_PATH) return null;
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  try {
    const { slug, scope } = parseLearningsFileRequest(await readBody(request));
    return json((await adapter.file(slug, scope)) satisfies LearningFiledView);
  } catch (error) {
    if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
    throw error;
  }
}
