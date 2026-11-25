/**
 * The host's Claude accounts over HTTP: `GET /api/claude-accounts` reads the
 * accounts and which one each loop of the project runs on, `POST` changes one
 * thing and answers the view read again:
 *
 *   {"action": "add", "name": "work", "dir": "~/.claude-work"}   register an account
 *   {"action": "remove", "name": "work"}                          forget it
 *   {"action": "clear-limit", "name": "work"}                     forget its spent-limit mark
 *   {"action": "assign", "target": "*"|"<loop>", "use": ["work"], "onLimit": "wait"}
 *   {"action": "assign-env", "target": "<loop>"}                  run on the environment's account
 *   {"action": "unassign", "target": "*"|"<loop>"}                back to the project / committed config
 *
 * Assignments are this host's override, read by each loop before its next
 * iteration: no commit, no restart. A thin route over the adapter: it checks
 * the body's shape, and the CLI is the judge of the rest; a refusal is
 * answered 200 with `ok: false` and the CLI's reason, so the page shows why.
 */
import {
  CLAUDE_ACCOUNT_NAME_PATTERN,
  CLAUDE_ACCOUNTS_PROJECT_TARGET,
  CLAUDE_ON_LIMITS,
  type ClaudeAccountsAnswer,
  type ClaudeAccountsRequest,
  type ClaudeAccountsView,
  type ClaudeOnLimitView,
} from "./contracts";
import { ControlRouteError, invalid, json, readBody } from "./command-requests";
import type { ClaudeAccountsAdapter } from "./claude-accounts-adapter";

export const CLAUDE_ACCOUNTS_PATH = "/api/claude-accounts";

const ACTIONS = ["add", "remove", "clear-limit", "assign", "assign-env", "unassign"] as const;
/** A loop name as a target: one token, no flag look-alike. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DIR_MAX = 1024;

function name(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string" || !CLAUDE_ACCOUNT_NAME_PATTERN.test(value)) {
    throw invalid(`'${key}' must be an account name: lowercase letters, digits, '-' or '_', up to 40, starting with a letter or digit`);
  }
  return value;
}

function target(fields: Record<string, unknown>): string {
  const value = fields.target;
  if (typeof value !== "string" || (value !== CLAUDE_ACCOUNTS_PROJECT_TARGET && !TARGET.test(value))) {
    throw invalid(`'target' must be '${CLAUDE_ACCOUNTS_PROJECT_TARGET}' for the whole project or a loop's name`);
  }
  return value;
}

export function parseClaudeAccountsRequest(body: unknown): ClaudeAccountsRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const action = fields.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    throw invalid(`'action' must be one of ${ACTIONS.join(", ")}`);
  }
  switch (action as (typeof ACTIONS)[number]) {
    case "add": {
      const dir = typeof fields.dir === "string" ? fields.dir.trim() : "";
      if (dir === "" || dir.length > DIR_MAX || /[\r\n\0]/.test(dir)) throw invalid("'dir' must be one line naming the account's config directory");
      if (!dir.startsWith("/") && dir !== "~" && !dir.startsWith("~/")) throw invalid("'dir' must be an absolute path or start with ~/");
      return { action: "add", name: name(fields, "name"), dir };
    }
    case "remove":
      return { action: "remove", name: name(fields, "name") };
    case "clear-limit":
      return { action: "clear-limit", name: name(fields, "name") };
    case "assign": {
      if (!Array.isArray(fields.use) || fields.use.length === 0) throw invalid("'use' must be a non-empty list of account names");
      const use = fields.use.map((value: unknown, index: number) => name({ [`use[${index}]`]: value }, `use[${index}]`));
      if (new Set(use).size !== use.length) throw invalid("'use' names an account twice");
      if (!(CLAUDE_ON_LIMITS as readonly unknown[]).includes(fields.onLimit)) throw invalid(`'onLimit' must be one of ${CLAUDE_ON_LIMITS.join(", ")}`);
      return { action: "assign", target: target(fields), use, onLimit: fields.onLimit as ClaudeOnLimitView };
    }
    case "assign-env": {
      const loop = target(fields);
      if (loop === CLAUDE_ACCOUNTS_PROJECT_TARGET) throw invalid("the whole project goes back to the environment's account with 'unassign'");
      return { action: "assign-env", target: loop };
    }
    case "unassign":
      return { action: "unassign", target: target(fields) };
  }
}

/** The response for the accounts path, or null when the path is not its. */
export async function handleClaudeAccountsRoute(
  request: Request,
  pathname: string,
  accounts: ClaudeAccountsAdapter,
): Promise<Response | null> {
  if (pathname !== CLAUDE_ACCOUNTS_PATH) return null;
  if (request.method === "GET") return json((await accounts.view()) satisfies ClaudeAccountsView);
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  try {
    const parsed = parseClaudeAccountsRequest(await readBody(request));
    return json((await accounts.act(parsed)) satisfies ClaudeAccountsAnswer);
  } catch (error) {
    if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
    throw error;
  }
}
