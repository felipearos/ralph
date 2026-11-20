/**
 * Where a project's Linear or Jira credential lives (felipearos/ralph#330):
 * `$XDG_CONFIG_HOME/ralph/trackers/<project-id>.json`, else
 * `~/.config/ralph/trackers/<project-id>.json`, beside the dashboard's project
 * registry.
 *
 * On the host and never in the repo, because a team credential committed to
 * `.ralph/` would travel with every clone. Mode 0600 is required rather than
 * advised: a token any local user can read is refused, and the operator fixes
 * the mode, so a loose file cannot quietly become the norm. The executor
 * permission rails deny reading this directory; `tracker.ts` loads it itself,
 * so the model reaches the tracker only through that CLI.
 *
 * GitHub needs none: `gh` carries its own auth.
 *
 * A missing file is an answer, not a failure: the project is "not connected",
 * which the supervisor waits on the way it waits on an unreachable tracker.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TrackerCredential =
  | { kind: "linear"; apiKey: string }
  | { kind: "jira"; email: string; apiToken: string };

export type CredentialReading =
  | { status: "ok"; credential: TrackerCredential }
  | { status: "not-connected"; path: string }
  | { status: "invalid"; path: string; problem: string };

/** A project id is one path segment: it names a file, and must never climb out of the directory. */
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function credentialsDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? xdg : join(homedir(), ".config"), "ralph", "trackers");
}

export function credentialPath(projectId: string, env: Record<string, string | undefined> = process.env): string {
  if (!PROJECT_ID.test(projectId) || projectId.includes("..")) {
    throw new Error(`'${projectId}' is not a project id`);
  }
  return join(credentialsDir(env), `${projectId}.json`);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The problem with a parsed credential, or null when it is usable. */
export function credentialProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be a JSON object";
  const record = value as Record<string, unknown>;
  if (record.kind === "linear") {
    return isText(record.apiKey) ? null : "a linear credential needs 'apiKey'";
  }
  if (record.kind === "jira") {
    return isText(record.email) && isText(record.apiToken) ? null : "a jira credential needs 'email' and 'apiToken'";
  }
  return "'kind' must be 'linear' or 'jira'";
}

export function readCredential(
  projectId: string,
  env: Record<string, string | undefined> = process.env,
): CredentialReading {
  const path = credentialPath(projectId, env);
  if (!existsSync(path)) return { status: "not-connected", path };
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return { status: "invalid", path, problem: `mode ${mode.toString(8)} lets other users read it; run chmod 600 ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { status: "invalid", path, problem: `not valid JSON (${(error as Error).message})` };
  }
  const problem = credentialProblem(parsed);
  if (problem !== null) return { status: "invalid", path, problem };
  return { status: "ok", credential: parsed as TrackerCredential };
}

/**
 * Write a credential with mode 0600 from the first byte: created under a
 * temporary name with that mode, then renamed, so no reader ever sees it
 * looser or half-written.
 */
export function writeCredential(
  projectId: string,
  credential: TrackerCredential,
  env: Record<string, string | undefined> = process.env,
): string {
  const problem = credentialProblem(credential);
  if (problem !== null) throw new Error(`refusing to write the credential: ${problem}`);
  const path = credentialPath(projectId, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
  return path;
}
