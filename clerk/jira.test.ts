// @vitest-environment node
/**
 * The clerk's Jira client against a fake Jira at the HTTP seam
 * (felipearos/ralph#318): reading issues, classifying failures, and the token
 * check the supervisor runs before handing the credential to the gate. The
 * check reads the site and project from the project's config, so it is driven
 * against a copy of the clerk fixture. No network.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { INTAKE_WORKFLOW, SITE, fakeJira } from "./fakes";
import { JiraError, adfText, checkToken, jiraClient, jqlString, parseJiraToken, statusChanges } from "./jira";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function intakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-clerk-jira-"));
  roots.push(root);
  cpSync(join(__dirname, "..", "fixtures", "clerk", ".ralph"), join(root, ".ralph"), { recursive: true });
  return root;
}

const TOKEN = { RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:fake-api-token" };

describe("the token check the supervisor runs", () => {
  it("passes a credential that reads the configured project, and asks nothing else", async () => {
    const jira = fakeJira("OA");
    expect(await checkToken(TOKEN, intakeProject(), jira.fetch)).toEqual({
      code: 0,
      message: "clerk-jira: Jira credential ok, reads OA (Acme) on example.atlassian.net",
    });
    expect(jira.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /rest/api/3/project/OA"]);
  });

  it("refuses a missing credential, or one that is not '<email>:<token>', without asking Jira", async () => {
    const jira = fakeJira("OA");
    expect(await checkToken({}, intakeProject(), jira.fetch)).toEqual({ code: 1, message: "clerk-jira: no RALPH_CLERK_JIRA_TOKEN in the environment" });
    expect((await checkToken({ RALPH_CLERK_JIRA_TOKEN: "just-a-token" }, intakeProject(), jira.fetch)).message).toBe(
      "clerk-jira: RALPH_CLERK_JIRA_TOKEN is not '<email>:<API token>'",
    );
    expect(jira.calls).toEqual([]);
  });

  it("refuses an unusable credential: unauthorized, forbidden, or a project it cannot see", async () => {
    for (const [status, words] of [
      [401, "refused the clerk's credential"],
      [403, "forbade"],
      [404, "HTTP 404"],
    ] as const) {
      const jira = fakeJira("OA");
      jira.fail("/rest/api/3/project/", { status });
      const result = await checkToken(TOKEN, intakeProject(), jira.fetch);
      expect(result.code, String(status)).toBe(1);
      expect(result.message).toContain(words);
    }
    // A project key nobody configured is the same refusal, from a real 404.
    const project = intakeProject();
    const config = JSON.parse(readFileSync(join(project, ".ralph", "config.json"), "utf8"));
    config.clerk.jira.project = "XX";
    writeFileSync(join(project, ".ralph", "config.json"), JSON.stringify(config));
    expect((await checkToken(TOKEN, project, fakeJira("OA").fetch)).code).toBe(1);
  });

  it("reads the site and project from 'triage.jira' when the project has no clerk (#397)", async () => {
    const project = intakeProject();
    const path = join(project, ".ralph", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    delete config.clerk;
    config.loops = [{ name: "tria", role: "triager" }];
    writeFileSync(path, JSON.stringify(config));
    expect(await checkToken(TOKEN, project, fakeJira("OA").fetch)).toEqual({
      code: 1,
      message: "clerk-jira: the project's .ralph/config.json has no 'clerk' block and no 'triage.jira'",
    });

    config.triage = { jira: "shadow", jiraSite: SITE, jiraProject: "OA" };
    writeFileSync(path, JSON.stringify(config));
    const jira = fakeJira("OA");
    expect(await checkToken(TOKEN, project, jira.fetch)).toEqual({
      code: 0,
      message: `clerk-jira: Jira credential ok, reads OA (Acme) on ${SITE}`,
    });
    expect(jira.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /rest/api/3/project/OA"]);
  });

  it("tells Jira being unreachable from a refusal, and never prints the token", async () => {
    const jira = fakeJira("OA");
    jira.fail("/rest/api/3/project/", { network: "ECONNRESET" });
    const result = await checkToken(TOKEN, intakeProject(), jira.fetch);
    expect(result.code).toBe(2);
    expect(result.message).not.toContain("fake-api-token");
  });
});

describe("reading Jira", () => {
  it("reads issues in the clerk's shape, description flattened to text", async () => {
    const jira = fakeJira("OA");
    jira.add({ key: "OA-12", summary: "No exporta", labels: ["slack-intake"], statusCategory: "indeterminate", status: "En curso", description: "Línea uno\nLínea dos" });
    const [issue] = await jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch).search('project = "OA" AND labels = "slack-intake" AND statusCategory != Done ORDER BY created DESC', 50);
    expect(issue).toMatchObject({ key: "OA-12", summary: "No exporta", status: "En curso", statusCategory: "indeterminate", labels: ["slack-intake"], resolved: null });
    expect(issue!.description).toBe("Línea uno\nLínea dos");
    expect(adfText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, { type: "paragraph", content: [{ type: "text", text: "c" }] }] })).toBe("ab\nc");
  });

  it("classifies a 429, a 5xx and a network error, and authenticates with basic auth", async () => {
    const jira = fakeJira("OA");
    const client = jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch);
    const failure = async (): Promise<string> => {
      try {
        await client.search("project = \"OA\"", 1);
      } catch (error) {
        return (error as JiraError).failure.kind;
      }
      return "none";
    };
    jira.fail("/rest/api/3/search/jql", { status: 429, retryAfter: "7" });
    expect(await failure()).toBe("rate-limited");
    jira.fail("/rest/api/3/search/jql", { status: 502 });
    expect(await failure()).toBe("transient");
    jira.fail("/rest/api/3/search/jql", { network: "ETIMEDOUT" });
    expect(await failure()).toBe("transient");
    jira.fail("/rest/api/3/search/jql", { status: 400 });
    expect(await failure()).toBe("denied");
    expect(await failure()).toBe("none");
  });

  it("parses the credential and quotes JQL strings", () => {
    expect(parseJiraToken("clerk@example.com:abc:def")).toEqual({ email: "clerk@example.com", token: "abc:def" });
    expect(parseJiraToken("abc")).toBeNull();
    expect(parseJiraToken("nobody:abc")).toBeNull();
    expect(jqlString('dice "hola"')).toBe('"dice \\"hola\\""');
  });
});

describe("the intake board's calls (#443)", () => {
  const POINTS = "customfield_10016";
  const board = () => fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  const clientOf = (jira: ReturnType<typeof fakeJira>) => jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch);
  const NEW = { project: "OAI", type: "Error", summary: "No exporta", description: "Contexto", labels: ["slack-intake"], priority: "Medium", storyPoints: 3 };

  it("files a ticket with its story points in the configured field, waiting for confirmation", async () => {
    const jira = board();
    expect(await clientOf(jira).createIssue(NEW, { storyPointsField: POINTS })).toEqual({ key: "OAI-100", pointsWritten: true });
    expect(jira.issues[0]).toMatchObject({ key: "OAI-100", status: "Por confirmar", custom: { [POINTS]: 3 } });
    const [issue] = await clientOf(jira).search('project = "OAI"', 10, undefined, { storyPointsField: POINTS });
    expect(issue!.storyPoints).toBe(3);
    // Not asked for the field, the search does not guess at one.
    expect((await clientOf(jira).search('project = "OAI"', 10))[0]!.storyPoints).toBeNull();
  });

  it("files the ticket without its points when Jira refuses the field, and says so", async () => {
    const jira = board();
    jira.refuseField(POINTS);
    expect(await clientOf(jira).createIssue(NEW, { storyPointsField: POINTS })).toEqual({ key: "OAI-100", pointsWritten: false });
    const creates = jira.calls.filter((call) => call.path === "/rest/api/3/issue");
    expect(creates.map((call) => POINTS in (call.body as { fields: object }).fields)).toEqual([true, false]);
    expect(jira.issues).toHaveLength(1);
  });

  it("sends no points without a field or without a value, and still throws when the ticket cannot be filed", async () => {
    const jira = board();
    expect(await clientOf(jira).createIssue(NEW)).toEqual({ key: "OAI-100", pointsWritten: false });
    expect(await clientOf(jira).createIssue({ ...NEW, storyPoints: null }, { storyPointsField: POINTS })).toEqual({ key: "OAI-101", pointsWritten: false });
    expect(jira.calls.some((call) => call.path === "/rest/api/3/issue" && POINTS in (call.body as { fields: object }).fields)).toBe(false);

    // A 400 that names another field is not the points' to absorb.
    const refused = board();
    refused.refuseField("customfield_99999");
    await expect(clientOf(refused).createIssue({ ...NEW, project: "XX" }, { storyPointsField: POINTS })).rejects.toBeInstanceOf(JiraError);
    expect(refused.issues).toEqual([]);
    refused.fail("/rest/api/3/issue", { status: 503 }, { method: "POST" });
    await expect(clientOf(refused).createIssue(NEW, { storyPointsField: POINTS })).rejects.toMatchObject({ failure: { kind: "transient" } });
  });

  it("files a ticket under its parent, and without it when Jira refuses the parent", async () => {
    const jira = board();
    expect(await clientOf(jira).createIssue({ ...NEW, parent: "OAI-7" })).toEqual({ key: "OAI-100", pointsWritten: false, parentWritten: true });
    expect(jira.issues[0]!.parent).toBe("OAI-7");

    // A closed or deleted parent must not stop the ticket, nor take its points with it.
    jira.refuseField("parent");
    expect(await clientOf(jira).createIssue({ ...NEW, parent: "OAI-7", unassigned: true }, { storyPointsField: POINTS })).toEqual({
      key: "OAI-101",
      pointsWritten: true,
      parentWritten: false,
    });
    expect(jira.issues[1]!.parent).toBeUndefined();
    expect(jira.issues[1]!.custom).toEqual({ [POINTS]: 3 });
    const sent = jira.calls.filter((call) => call.path === "/rest/api/3/issue").map((call) => Object.keys((call.body as { fields: object }).fields).filter((field) => ["parent", "assignee"].includes(field)));
    expect(sent).toEqual([["parent"], ["assignee", "parent"], ["assignee"]]);
  });

  it("edits labels and points in one call, dropping a refused points field", async () => {
    const jira = board();
    jira.add({ key: "OAI-7", summary: "x", labels: ["slack-intake", "para-persona"] });
    const client = clientOf(jira);
    expect(await client.updateFields("OAI-7", { labels: { add: ["ready-for-agent"], remove: ["para-persona"] }, storyPoints: 5 }, { storyPointsField: POINTS })).toEqual({
      pointsWritten: true,
    });
    expect(jira.issues[0]).toMatchObject({ labels: ["slack-intake", "ready-for-agent"], custom: { [POINTS]: 5 } });

    jira.refuseField(POINTS);
    expect(await client.updateFields("OAI-7", { labels: { add: ["moved-to-jira"] }, storyPoints: 8 }, { storyPointsField: POINTS })).toEqual({ pointsWritten: false });
    expect(jira.issues[0]).toMatchObject({ labels: ["slack-intake", "ready-for-agent", "moved-to-jira"], custom: { [POINTS]: 5 } });

    const before = jira.calls.length;
    expect(await client.updateFields("OAI-7", {})).toEqual({ pointsWritten: false });
    expect(await client.updateFields("OAI-7", { storyPoints: 2 })).toEqual({ pointsWritten: false });
    expect(jira.calls).toHaveLength(before);
  });

  it("moves a ticket along its workflow, and leaves one already there", async () => {
    const jira = board();
    jira.add({ key: "OAI-7", summary: "x", status: "Por confirmar" });
    const client = clientOf(jira);
    expect(await client.transition("OAI-7", "Confirmado")).toEqual({ movedTo: "Confirmado", warning: null });
    expect(jira.issues[0]!.status).toBe("Confirmado");
    const writes = jira.writes().length;
    expect(await client.transition("OAI-7", "Confirmado")).toEqual({ movedTo: "Confirmado", warning: null });
    expect(jira.writes()).toHaveLength(writes);
  });

  it("warns, naming what the workflow offers, when no transition leads to the status", async () => {
    const jira = board();
    jira.add({ key: "OAI-7", summary: "x", status: "Por confirmar" });
    expect(await clientOf(jira).transition("OAI-7", "Movido")).toEqual({
      movedTo: null,
      warning: "OAI-7 has no transition to 'Movido' from 'Por confirmar' (offers: Confirmado, Descartado)",
    });
    expect(jira.writes()).toEqual([]);
    // Jira failing is a warning too: a status move never throws out of a poll.
    jira.fail("/rest/api/3/issue/OAI-7", { status: 503 });
    expect((await clientOf(jira).transition("OAI-7", "Confirmado")).warning).toContain("failed");
  });

  it("falls back to any done transition when asked, and leaves a ticket already done (felipearos/ralph#449)", async () => {
    const jira = board();
    // Movido is the first done status Confirmado offers here.
    jira.add({ key: "OAI-7", summary: "x", status: "Confirmado", statusCategory: "indeterminate" });
    const client = clientOf(jira);
    expect(await client.transition("OAI-7", "Cerrado", { orDone: true })).toEqual({ movedTo: "Movido", warning: null });
    expect(jira.issues[0]).toMatchObject({ status: "Movido", statusCategory: "done" });
    const writes = jira.writes().length;
    expect(await client.transition("OAI-7", "Cerrado", { orDone: true })).toEqual({ movedTo: "Movido", warning: null });
    expect(jira.writes()).toHaveLength(writes);
    // Without the option, the same ask is a warning, as before.
    jira.add({ key: "OAI-8", summary: "y", status: "Confirmado", statusCategory: "indeterminate" });
    expect((await client.transition("OAI-8", "Cerrado")).movedTo).toBeNull();
  });

  it("reads who moved a ticket and when off its changelog, oldest first", async () => {
    const jira = board();
    jira.add({ key: "OAI-7", summary: "x", status: "Por confirmar" });
    const client = clientOf(jira);
    jira.actor = { accountId: "712020:aaaa", displayName: "Ana" };
    await client.transition("OAI-7", "Confirmado");
    jira.actor = null;
    await client.transition("OAI-7", "Movido");
    const history = await client.statusHistory("OAI-7");
    expect(history.map(({ from, to, by }) => ({ from, to, by }))).toEqual([
      { from: "Por confirmar", to: "Confirmado", by: { accountId: "712020:aaaa", displayName: "Ana" } },
      { from: "Confirmado", to: "Movido", by: null },
    ]);
    expect(Date.parse(history[0]!.at)).not.toBeNaN();
  });

  it("parses a changelog recorded off the live site, ignoring every change that is not a status", () => {
    // `GET /rest/api/3/issue/OA-403?fields=status&expand=changelog` on
    // example.atlassian.net, 2026-10-22, names and ids replaced. The live
    // expand lists histories NEWEST first, and a status item carries ids in
    // `from`/`to` and the names in `fromString`/`toString`.
    const recorded = {
      startAt: 0,
      maxResults: 3,
      total: 3,
      histories: [
        {
          id: "277808",
          author: { accountId: "5ac3ef9e8f7ffe2e00000001", displayName: "Persona Uno", active: true, accountType: "atlassian" },
          created: "2026-10-22T09:18:39.945-0300",
          items: [{ field: "status", fieldtype: "jira", fieldId: "status", from: "11390", fromString: "LISTO PARA QA", to: "11350", toString: "QA" }],
        },
        {
          id: "277262",
          author: { accountId: "712020:00000000-0000-0000-0000-000000000002", displayName: "persona2", active: true, accountType: "atlassian" },
          created: "2026-10-20T10:06:16.315-0300",
          items: [{ field: "status", fieldtype: "jira", fieldId: "status", from: "11315", fromString: "In Progress", to: "11390", toString: "LISTO PARA QA" }],
        },
        {
          id: "277136",
          author: { accountId: "5ac3ef9e8f7ffe2e00000001", displayName: "Persona Uno", active: true, accountType: "atlassian" },
          created: "2026-10-16T10:51:44.498-0300",
          items: [{ field: "duedate", fieldtype: "jira", fieldId: "duedate", from: "2026-10-15", fromString: "2026-10-15 00:00:00.0", to: "2026-10-19", toString: "2026-10-19 00:00:00.0" }],
        },
      ],
    };
    expect(statusChanges(recorded.histories)).toEqual([
      { from: "In Progress", to: "LISTO PARA QA", at: "2026-10-20T10:06:16.315-0300", by: { accountId: "712020:00000000-0000-0000-0000-000000000002", displayName: "persona2" } },
      { from: "LISTO PARA QA", to: "QA", at: "2026-10-22T09:18:39.945-0300", by: { accountId: "5ac3ef9e8f7ffe2e00000001", displayName: "Persona Uno" } },
    ]);
  });

  it("reads a changelog longer than one page whole, from the paged endpoint", async () => {
    const jira = board();
    const history = Array.from({ length: 130 }, (_, index) => ({
      from: `S${index}`,
      to: `S${index + 1}`,
      at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      by: null,
    }));
    jira.add({ key: "OAI-7", summary: "x", history });
    const read = await clientOf(jira).statusHistory("OAI-7");
    expect(read).toHaveLength(130);
    expect(read[0]!.from).toBe("S0");
    expect(read.at(-1)!.to).toBe("S130");
  });

  it("reads the assignee, the reporter and the resolution", async () => {
    const jira = board();
    jira.add({
      key: "OAI-7",
      summary: "x",
      assignee: { accountId: "a1", displayName: "Ana" },
      reporter: { accountId: "r1", displayName: "Rodrigo" },
      resolution: "No se hará",
    });
    jira.add({ key: "OAI-8", summary: "y" });
    const [one, two] = await clientOf(jira).search('project = "OAI"', 10);
    expect(one).toMatchObject({ assignee: { accountId: "a1", displayName: "Ana" }, reporter: { accountId: "r1", displayName: "Rodrigo" }, resolution: "No se hará" });
    expect(two).toMatchObject({ assignee: null, reporter: null, resolution: null, storyPoints: null });
  });
});
