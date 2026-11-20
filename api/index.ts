/**
 * The remote dashboard's Vercel function (spec felipearos/ralph#165, §9):
 * every `/api/*` path, rewritten here by `vercel.json`, served from the hosted
 * store by `dashboard/remote/handler.ts`.
 *
 * It runs on the Bun runtime in `gru1`, next to the Supabase project in
 * `sa-east-1`, and logs in as `ralph_web` through the Supabase transaction
 * pooler (`RALPH_WEB_DATABASE_URL`, port 6543). The pooler hands each
 * statement to any backend, so prepared statements are off. One client per
 * instance, made on the first request and reused by every request after it
 * (fluid compute). No Supabase API key of any kind is read.
 *
 * `RALPH_INTAKE_METRICS_PASSWORD` opens the intake page's metrics
 * (felipearos/ralph#459); `RALPH_REMOTE_SURFACE=intake` makes a deployment
 * serve the intake page alone, with `RALPH_WEB_DATABASE_URL` then naming the
 * `ralph_intake` role instead of `ralph_web`.
 *
 * Its imports are the handler, the contracts and `postgres`, never
 * `dashboard/server.ts` or an adapter: `remote/handler.test.ts` walks the
 * graph.
 */
import postgres from "postgres";

import { SNAPSHOT_SCHEMA } from "../dashboard/contracts";
import { createRemoteHandler, createUnconfiguredHandler, DEFAULT_COMMAND_WAIT_MS, type Sql } from "../dashboard/remote/handler";
import { createIntakeGate } from "../dashboard/remote/intake-auth";

type Env = Record<string, string | undefined>;

const number = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The handler for this deployment's env. Previews get no store, so they
 * always show the machine offline; they are for UI review only.
 */
export function handlerFromEnv(env: Env): (request: Request) => Promise<Response> {
  const schema = number(env.RALPH_SNAPSHOT_SCHEMA, SNAPSHOT_SCHEMA);
  const url = env.RALPH_WEB_DATABASE_URL;
  if (url === undefined || url.trim() === "") return createUnconfiguredHandler(schema);
  // postgres.js connects lazily, on the first statement.
  const client = postgres(url, { prepare: false, max: 4, idle_timeout: 30, connect_timeout: 10 });
  const sql: Sql = async <T>(query: string, params: readonly unknown[] = []) =>
    (await client.unsafe(query, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
  return createRemoteHandler({
    sql,
    schema,
    waitMs: number(env.RALPH_COMMAND_WAIT_MS, DEFAULT_COMMAND_WAIT_MS),
    // Unset or empty, the intake metrics are locked for everyone (felipearos/ralph#459).
    intake: createIntakeGate({ password: env.RALPH_INTAKE_METRICS_PASSWORD }),
    // `intake`: the open intake deployment, logged in as `ralph_intake` (`intake.sql`).
    surface: env.RALPH_REMOTE_SURFACE?.trim() === "intake" ? "intake" : "full",
  });
}

let handler: ((request: Request) => Promise<Response>) | null = null;

export default {
  fetch(request: Request): Promise<Response> {
    handler ??= handlerFromEnv(process.env);
    return handler(request);
  },
};
