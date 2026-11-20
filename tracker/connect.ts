/**
 * Connecting a project to Linear or Jira (felipearos/ralph#338): what the
 * dashboard's Tracker connector asks before it writes anything.
 *
 * One call per step of the form. With only a token it answers who the token
 * belongs to and which teams (Linear) or projects (Jira) it can see; with a
 * team or project named it adds that one's workflow states and, on Linear,
 * its labels, so the operator picks from lists instead of typing keys and
 * state names. Every failure is the tracker's own reason in a word the form
 * can act on, never a stack.
 *
 * The token arrives on stdin (`tracker.ts connect-test`), never in argv, so it
 * appears in no process listing and no log.
 */
import { LINEAR_ENDPOINT } from "./linear";

export type ConnectRequest =
  | { kind: "linear"; apiKey: string; team?: string }
  | { kind: "jira"; site: string; email: string; apiToken: string; project?: string };

export interface ConnectOption {
  key: string;
  name: string;
}

export type ConnectReport =
  | {
      ok: true;
      kind: "linear" | "jira";
      /** Who the token belongs to, as the tracker names them. */
      user: string;
      /** Linear's workspace URL key, which the `tracker` block records. */
      workspace?: string;
      /** Linear teams, or Jira projects, the token can see. */
      options: ConnectOption[];
      /** The named team's or project's workflow states, when one was named. */
      states?: string[];
      /** The named Linear team's labels (team and workspace); Jira's are free-form. */
      labels?: string[];
    }
  | { ok: false; reason: "refused" | "unknown" | "unreachable" | "invalid"; message: string };

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const SITE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** The request read off stdin, or why it is not one. */
export function parseConnectRequest(raw: unknown): ConnectRequest | string {
  if (typeof raw !== "object" || raw === null) return "the request must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (r.kind === "linear") {
    if (!isText(r.apiKey)) return "a Linear connection needs 'apiKey'";
    return { kind: "linear", apiKey: r.apiKey.trim(), ...(isText(r.team) ? { team: r.team.trim() } : {}) };
  }
  if (r.kind === "jira") {
    if (!(isText(r.site) && SITE.test(r.site.trim()))) return "a Jira connection needs 'site', a host name such as example.atlassian.net";
    if (!isText(r.email) || !isText(r.apiToken)) return "a Jira connection needs 'email' and 'apiToken'";
    return {
      kind: "jira",
      site: r.site.trim(),
      email: r.email.trim(),
      apiToken: r.apiToken.trim(),
      ...(isText(r.project) ? { project: r.project.trim() } : {}),
    };
  }
  return "'kind' must be 'linear' or 'jira'";
}

const unreachable = (error: unknown): ConnectReport => ({
  ok: false,
  reason: "unreachable",
  message: `the tracker could not be reached: ${error instanceof Error ? error.message : String(error)}`,
});

async function connectLinear(request: Extract<ConnectRequest, { kind: "linear" }>, doFetch: typeof fetch): Promise<ConnectReport> {
  const query = `query RalphConnect($team: String!, $named: Boolean!) {
    viewer { displayName organization { urlKey } }
    teams(first: 250) { nodes { key name } }
    named: teams(filter: { key: { eq: $team } }) @include(if: $named) { nodes { states { nodes { name } } } }
    issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }) @include(if: $named) { nodes { name } }
  }`;
  let response: Response;
  try {
    response = await doFetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: request.apiKey },
      body: JSON.stringify({ query: query.replace(/\s+/g, " "), variables: { team: request.team ?? "", named: request.team !== undefined } }),
    });
  } catch (error) {
    return unreachable(error);
  }
  const answer = (await response.json().catch(() => ({}))) as {
    data?: {
      viewer: { displayName: string; organization: { urlKey: string } };
      teams: { nodes: ConnectOption[] };
      named?: { nodes: { states: { nodes: { name: string }[] } }[] };
      issueLabels?: { nodes: { name: string }[] };
    };
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  if (response.status === 401 || answer.errors?.[0]?.extensions?.code === "AUTHENTICATION_ERROR") {
    return { ok: false, reason: "refused", message: "Linear refused the API key" };
  }
  if (answer.data === undefined || answer.errors !== undefined) {
    return { ok: false, reason: "unreachable", message: `Linear answered HTTP ${response.status}: ${answer.errors?.map((e) => e.message).join("; ") ?? "no data"}` };
  }
  const { data } = answer;
  const report: ConnectReport = {
    ok: true,
    kind: "linear",
    user: data.viewer.displayName,
    workspace: data.viewer.organization.urlKey,
    options: data.teams.nodes.map(({ key, name }) => ({ key, name })),
  };
  if (request.team === undefined) return report;
  const team = data.named?.nodes[0];
  if (team === undefined) return { ok: false, reason: "unknown", message: `the key cannot see a Linear team '${request.team}'` };
  return { ...report, states: team.states.nodes.map((state) => state.name), labels: (data.issueLabels?.nodes ?? []).map((label) => label.name) };
}

async function connectJira(request: Extract<ConnectRequest, { kind: "jira" }>, doFetch: typeof fetch): Promise<ConnectReport> {
  const auth = `Basic ${Buffer.from(`${request.email}:${request.apiToken}`).toString("base64")}`;
  const get = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
    const response = await doFetch(`https://${request.site}${path}`, { method: "GET", headers: { Authorization: auth, Accept: "application/json" } });
    return { status: response.status, body: response.ok ? ((await response.json()) as T) : null };
  };
  try {
    const me = await get<{ displayName: string }>("/rest/api/3/myself");
    if (me.status === 401 || me.status === 403) return { ok: false, reason: "refused", message: `Jira refused the credential for ${request.site}` };
    if (me.body === null) return { ok: false, reason: "unreachable", message: `Jira answered HTTP ${me.status} on ${request.site}` };
    const projects = await get<{ values: ConnectOption[] }>("/rest/api/3/project/search?maxResults=100&orderBy=key");
    const report: ConnectReport = {
      ok: true,
      kind: "jira",
      user: me.body.displayName,
      options: (projects.body?.values ?? []).map(({ key, name }) => ({ key, name })),
    };
    if (request.project === undefined) return report;
    const statuses = await get<{ statuses: { name: string }[] }[]>(`/rest/api/3/project/${encodeURIComponent(request.project)}/statuses`);
    if (statuses.status === 404) return { ok: false, reason: "unknown", message: `the credential cannot see a Jira project '${request.project}'` };
    if (statuses.body === null) return { ok: false, reason: "unreachable", message: `Jira answered HTTP ${statuses.status} reading ${request.project}'s statuses` };
    return { ...report, states: [...new Set(statuses.body.flatMap((type) => type.statuses.map((status) => status.name)))] };
  } catch (error) {
    return unreachable(error);
  }
}

export function testConnection(request: ConnectRequest, doFetch: typeof fetch = fetch): Promise<ConnectReport> {
  return request.kind === "linear" ? connectLinear(request, doFetch) : connectJira(request, doFetch);
}
