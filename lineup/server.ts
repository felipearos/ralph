/**
 * The local Bun HTTP server: a thin adapter over the runtime adapter.
 *
 * Handlers parse a request, call the adapter, and serialize. They hold no
 * lineup validation logic and invoke no subprocess — that is the adapter's job,
 * behind the process boundary. The server binds localhost only, and the one
 * write route (`POST /api/lineup/save`) reaches disk only through the adapter's
 * validate-then-atomic-write path.
 *
 * `Bun.serve` is declared locally rather than pulled in as a dependency type:
 * the tool is run by Bun and never compiled into the app, so it must not drag
 * the app's type graph in either.
 */
import {
  LineupContractError,
  LineupRefusedError,
  LineupRequestError,
  LineupUnavailableError,
  createLineupAdapter,
  type LineupAdapter,
} from "./adapter";
import { readAssets, type StaticAssets } from "./assets";
import { HARNESS_DIR, configFromEnv } from "./config";
import {
  MODEL_UPDATE_ANSWERS,
  isRecord,
  type JsonObject,
  type LineupEditOp,
  type ModelUpdateAnswer,
  type StageChange,
} from "./contracts";

interface BunServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): BunServer;
};

export interface HandlerOptions {
  adapter: LineupAdapter;
  /**
   * The project every request edits, whatever it asks for: the dashboard
   * mounts one handler per project, so a project's page can reach no other
   * project's keys. Absent, a request may name one (`project`), else the
   * adapter's default applies.
   */
  project?: string;
  /** The static page and its helper module, served on GET. Absent, only the API is served. */
  assets?: StaticAssets;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** The routes, and the one method each serves; anything else is 405 or 404. */
export const ROUTES = {
  "/api/roots": "GET",
  "/api/lineup": "GET",
  "/api/lineup/catalog": "GET",
  "/api/lineup/preview": "POST",
  "/api/lineup/edit": "POST",
  "/api/lineup/save": "POST",
  "/api/lineup/updates": "GET",
  "/api/lineup/updates/answer": "POST",
} as const;

type RoutePath = keyof typeof ROUTES;

const isRoute = (pathname: string): pathname is RoutePath => pathname in ROUTES;

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new LineupRequestError("could not read the request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LineupRequestError("the request body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new LineupRequestError("the request body must be a JSON object");
  return parsed;
}

const optionalSelector = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new LineupRequestError(`'${name}' must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const requireConfig = (value: unknown): JsonObject => {
  if (!isRecord(value)) throw new LineupRequestError("'config' must be a JSON object");
  return value;
};

/** The request's edit, by shape only: whether it is legal is the pure layer's and the CLI's call. */
const requireEdit = (value: unknown): LineupEditOp => {
  if (!isRecord(value)) throw new LineupRequestError("'edit' must be a JSON object");
  if (value.kind === "create" || value.kind === "remove") return { kind: value.kind };
  if (value.kind !== "stage") throw new LineupRequestError("'edit.kind' must be one of stage, create, remove");
  if (typeof value.stage !== "string") throw new LineupRequestError("'edit.stage' must be a string");
  if (!isRecord(value.change)) throw new LineupRequestError("'edit.change' must be a JSON object");
  const change: StageChange = {};
  for (const key of ["runner", "model"] as const) {
    const field = value.change[key];
    if (field === undefined) continue;
    if (typeof field !== "string") throw new LineupRequestError(`'edit.change.${key}' must be a string`);
    change[key] = field;
  }
  const effort = value.change.effort;
  if (effort !== undefined) {
    if (effort !== null && typeof effort !== "string") {
      throw new LineupRequestError("'edit.change.effort' must be a string or null");
    }
    change.effort = effort;
  }
  const fallbackEfforts = value.change.fallbackEfforts;
  if (fallbackEfforts !== undefined) {
    if (fallbackEfforts !== null && (!isRecord(fallbackEfforts) || Object.values(fallbackEfforts).some((entry) => typeof entry !== "string"))) {
      throw new LineupRequestError("'edit.change.fallbackEfforts' must be a string map or null");
    }
    change.fallbackEfforts = fallbackEfforts as Record<string, string> | null;
  }
  const fallback = value.change.fallback;
  if (fallback !== undefined) {
    if (fallback !== null && typeof fallback !== "string" && (!Array.isArray(fallback) || fallback.some((entry) => typeof entry !== "string"))) {
      throw new LineupRequestError("'edit.change.fallback' must be a string, an array of strings, or null");
    }
    change.fallback = typeof fallback === "string" ? [fallback] : fallback;
  }
  return { kind: "stage", stage: value.stage, change };
};

/** A role name's shape: the editor never holds the harness's role vocabulary. */
const ROLE_SHAPE = /^[a-z][a-z-]{0,23}$/;

/**
 * A role selector, judged for SHAPE here and for membership by the CLI.
 *
 * Not against a role list: this editor is extractable precisely because it
 * imports no ralph TypeScript (`boundary.test.ts`), so the vocabulary is not
 * ours to hold and a copy of it here would be one more thing to drift. What is
 * ours is refusing a value that could never be a role, so junk is a 400 here
 * rather than a CLI invocation; an unknown but well-formed role is the CLI's
 * refusal, which `readSchema` now reports as a bad request too.
 */
const roleSelector = (value: unknown): string | undefined => {
  const named = optionalSelector(value, "role");
  if (named !== undefined && !ROLE_SHAPE.test(named)) {
    throw new LineupRequestError(`'role' must be a role name, not '${named}'`);
  }
  return named;
};

/** The optional root/project/loop selectors, from query params or a request body. */
interface Selectors {
  root?: string;
  project?: string;
  loop?: string;
  /** The loop's role, when the caller knows one the resolver cannot (see `LineupSelectors.role`). */
  role?: string;
}

const selectorsFrom = (read: (name: string) => unknown, pinned?: string): Selectors => {
  const root = optionalSelector(read("root"), "root");
  const project = pinned ?? optionalSelector(read("project"), "project");
  const loop = optionalSelector(read("loop"), "loop");
  const role = roleSelector(read("role"));
  return {
    ...(root === undefined ? {} : { root }),
    ...(project === undefined ? {} : { project }),
    ...(loop === undefined ? {} : { loop }),
    ...(role === undefined ? {} : { role }),
  };
};

export function createHandler({ adapter, project, assets = {} }: HandlerOptions): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    try {
      const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : undefined;
      if (asset !== undefined) {
        if (request.method !== "GET") {
          return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        }
        return new Response(asset.body, {
          status: 200,
          headers: { "content-type": asset.contentType, "cache-control": "no-store" },
        });
      }
      if (!isRoute(pathname)) return json({ error: "LineupRequestError", message: "not found" }, 404);
      const allowed = ROUTES[pathname];
      if (request.method !== allowed) {
        return new Response("method not allowed", { status: 405, headers: { allow: allowed } });
      }

      if (pathname === "/api/roots") {
        return json({ roots: adapter.roots });
      }
      if (pathname === "/api/lineup") {
        return json(await adapter.read(selectorsFrom((name) => searchParams.get(name), project)));
      }
      if (pathname === "/api/lineup/updates") {
        const selectors = selectorsFrom((name) => searchParams.get(name), project);
        return json(await adapter.updates({ root: selectors.root, project: selectors.project }));
      }
      if (pathname === "/api/lineup/catalog") {
        // `?refresh=1` asks the harnesses again instead of serving the cached answer.
        return json(await adapter.catalog({ refresh: searchParams.get("refresh") === "1" }));
      }

      const body = await parseBody(request);
      const selectors = selectorsFrom((name) => body[name], project);
      if (pathname === "/api/lineup/updates/answer") {
        // Shape only: whether the block exists and the edit is legal is the CLI's call.
        const answer = body.answer;
        if (typeof answer !== "string" || !(MODEL_UPDATE_ANSWERS as readonly string[]).includes(answer)) {
          throw new LineupRequestError(`'answer' must be one of ${MODEL_UPDATE_ANSWERS.join(", ")}`);
        }
        if (body.fileDefault !== undefined && typeof body.fileDefault !== "boolean") {
          throw new LineupRequestError("'fileDefault' must be a boolean");
        }
        const block = optionalSelector(body.block, "block");
        return json(
          await adapter.answerUpdate({
            root: selectors.root,
            project: selectors.project,
            ...(block === undefined ? {} : { block }),
            fileDefault: body.fileDefault === true,
            answer: answer as ModelUpdateAnswer,
          }),
        );
      }
      if (pathname === "/api/lineup/preview") {
        return json(await adapter.preview({ ...selectors, config: requireConfig(body.config) }));
      }
      if (pathname === "/api/lineup/edit") {
        return json(
          await adapter.edit({ ...selectors, config: requireConfig(body.config), edit: requireEdit(body.edit) }),
        );
      }
      const saved = await adapter.save({ ...selectors, config: requireConfig(body.config) });
      // A rejected candidate is a client error carrying the resolver's complete
      // problem list; the file is untouched. It carries the `{ error, message }`
      // every refusal does, so the dashboard's command module lists the problems.
      if (saved.valid) return json(saved);
      return json({ error: "LineupInvalid", message: "the resolver refused the lineup", ...saved }, 400);
    } catch (error) {
      if (error instanceof LineupRefusedError || error instanceof LineupRequestError) {
        return json({ error: error.name, message: error.message }, 400);
      }
      if (error instanceof LineupContractError) {
        return json({ error: error.name, message: error.message }, 500);
      }
      if (error instanceof LineupUnavailableError) {
        return json({ error: error.name, message: error.message }, 500);
      }
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "error", message }, 500);
    }
  };
}

function main(): void {
  const config = configFromEnv(process.env, { cliDir: HARNESS_DIR, root: HARNESS_DIR });
  const adapter = createLineupAdapter({
    cliDir: config.cliDir,
    roots: config.roots,
    project: config.project,
    ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
  });
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createHandler({ adapter, assets: readAssets() }),
  });
  console.log(`ralph-lineup listening on http://${server.hostname}:${server.port}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`ralph-lineup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
