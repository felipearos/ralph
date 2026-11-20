import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../tracker";
import { scratchDir } from "../test-scratch";
import { parseConnectRequest, testConnection } from "./connect";

/** Linear's answers to the connect query, in the shapes the live API gave (2026-10-20). */
const linearFetch = (options: { refuse?: boolean } = {}) =>
  (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: { team: string; named: boolean } };
    if (options.refuse) {
      return new Response(JSON.stringify({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }), { status: 401 });
    }
    const data: Record<string, unknown> = {
      viewer: { displayName: "faros", organization: { urlKey: "exampleorg" } },
      teams: { nodes: [{ key: "AND", name: "Example" }] },
    };
    if (variables.named) {
      data.named = { nodes: variables.team === "AND" ? [{ states: { nodes: [{ name: "Todo" }, { name: "In Progress" }, { name: "Done" }] } }] : [] };
      data.issueLabels = { nodes: [{ name: "ready-for-agent" }, { name: "acme-backoffice" }] };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;

/** Jira Cloud's answers to the connect reads. */
const jiraFetch = (options: { refuse?: boolean } = {}) =>
  (async (url: string) => {
    const { pathname } = new URL(url);
    if (options.refuse) return new Response("", { status: 401 });
    if (pathname === "/rest/api/3/myself") return Response.json({ displayName: "Felipe Aros" });
    if (pathname === "/rest/api/3/project/search") return Response.json({ values: [{ key: "OA", name: "Acme" }] });
    if (pathname === "/rest/api/3/project/OA/statuses") {
      return Response.json([{ statuses: [{ name: "To Do" }, { name: "In Progress" }] }, { statuses: [{ name: "Done" }, { name: "To Do" }] }]);
    }
    return new Response(JSON.stringify({ errorMessages: ["No project could be found"] }), { status: 404 });
  }) as unknown as typeof fetch;

describe("testing a tracker connection", () => {
  it("lists a Linear key's teams, then the named team's states and labels", async () => {
    expect(await testConnection({ kind: "linear", apiKey: "k" }, linearFetch())).toEqual({
      ok: true,
      kind: "linear",
      user: "faros",
      workspace: "exampleorg",
      options: [{ key: "AND", name: "Example" }],
    });
    expect(await testConnection({ kind: "linear", apiKey: "k", team: "AND" }, linearFetch())).toMatchObject({
      states: ["Todo", "In Progress", "Done"],
      labels: ["ready-for-agent", "acme-backoffice"],
    });
  });

  it("names an unknown team and a refused key", async () => {
    expect(await testConnection({ kind: "linear", apiKey: "k", team: "ZZZ" }, linearFetch())).toEqual({
      ok: false,
      reason: "unknown",
      message: "the key cannot see a Linear team 'ZZZ'",
    });
    expect(await testConnection({ kind: "linear", apiKey: "bad" }, linearFetch({ refuse: true }))).toMatchObject({ ok: false, reason: "refused" });
  });

  it("lists a Jira credential's projects, then the named project's statuses once each", async () => {
    const request = { kind: "jira" as const, site: "example.atlassian.net", email: "a@b.c", apiToken: "t" };
    expect(await testConnection(request, jiraFetch())).toEqual({
      ok: true,
      kind: "jira",
      user: "Felipe Aros",
      options: [{ key: "OA", name: "Acme" }],
    });
    expect(await testConnection({ ...request, project: "OA" }, jiraFetch())).toMatchObject({ states: ["To Do", "In Progress", "Done"] });
    expect(await testConnection({ ...request, project: "NOPE" }, jiraFetch())).toMatchObject({ ok: false, reason: "unknown" });
    expect(await testConnection(request, jiraFetch({ refuse: true }))).toMatchObject({ ok: false, reason: "refused" });
  });

  it("reports a network failure as unreachable, not as a refusal", async () => {
    const down = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await testConnection({ kind: "linear", apiKey: "k" }, down)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("refuses a request it cannot act on, saying why", () => {
    expect(parseConnectRequest({ kind: "linear" })).toBe("a Linear connection needs 'apiKey'");
    expect(parseConnectRequest({ kind: "jira", site: "https://x", email: "a", apiToken: "b" })).toMatch(/host name/);
    expect(parseConnectRequest({ kind: "trello" })).toBe("'kind' must be 'linear' or 'jira'");
  });
});

describe("tracker.ts connect-test and connect-save", () => {
  const cli = (argv: string[], stdin: string, extra: { fetch?: typeof fetch; env?: Record<string, string> } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return main(argv, { readStdin: () => stdin, out: (line) => out.push(line), err: (line) => err.push(line), ...extra }).then((status) => ({ status, out, err }));
  };

  it("prints the report as one JSON line, exiting 0 only when the connection works", async () => {
    const good = await cli(["connect-test"], JSON.stringify({ kind: "linear", apiKey: "k", team: "AND" }), { fetch: linearFetch() });
    expect(good.status).toBe(EXIT.ok);
    expect(JSON.parse(good.out[0]!)).toMatchObject({ ok: true, workspace: "exampleorg", states: ["Todo", "In Progress", "Done"] });
    const bad = await cli(["connect-test"], "not json", { fetch: linearFetch() });
    expect(bad.status).toBe(EXIT.failed);
    expect(JSON.parse(bad.out[0]!)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("writes the credential 0600 for the named project, and refuses an incomplete one", async () => {
    const env = { XDG_CONFIG_HOME: scratchDir("connect-save-") };
    const saved = await cli(["connect-save", "--project", "acme-backoffice"], JSON.stringify({ kind: "linear", apiKey: "lin_api_x" }), { env });
    expect(saved.status).toBe(EXIT.ok);
    const { path } = JSON.parse(saved.out[0]!) as { path: string };
    expect(path).toBe(`${env.XDG_CONFIG_HOME}/ralph/trackers/acme-backoffice.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ kind: "linear", apiKey: "lin_api_x" });
    // The token never comes back out.
    expect(saved.out.join("\n")).not.toContain("lin_api_x");

    const incomplete = await cli(["connect-save", "--project", "p"], JSON.stringify({ kind: "jira", email: "a@b.c" }), { env });
    expect(incomplete.status).toBe(EXIT.failed);
    expect(JSON.parse(incomplete.out[0]!)).toMatchObject({ ok: false, message: "a jira credential needs 'email' and 'apiToken'" });
    expect((await cli(["connect-save"], "{}", { env })).status).toBe(EXIT.usage);
  });
});
