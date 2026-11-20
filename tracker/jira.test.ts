import { describe, expect, it } from "vitest";

import { adfToMarkdown, markdownToAdf } from "./adf";
import { trackerContract, type Seed } from "./contract";
import { classifyJiraFailure, createJiraTracker, JiraError } from "./jira";
import { TrackerUnavailableError } from "./types";

const SITE = "acme.atlassian.net";

/**
 * A small Jira Cloud behind the REST v3 calls the adapter makes, answering in
 * the shapes `acli` read off the live site (2026-10-20): ADF bodies, status
 * categories, inward "Blocks" links, `search/jql` paged by token, and a
 * To Do → In Progress → Done workflow. A path the adapter starts using that
 * this does not know fails loudly instead of being half-answered.
 */
function emulatedJira(seed: Seed, options: { project?: string; pageSize?: number; laggingIndex?: boolean } = {}) {
  const project = options.project ?? "OA";
  const statuses = {
    todo: { name: "To Do", statusCategory: { key: "new" } },
    progress: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    done: { name: "Done", statusCategory: { key: "done" } },
  };
  const users = [
    { accountId: "acc-self", displayName: seed.self, emailAddress: `${seed.self}@acme.test` },
    { accountId: "acc-mateo", displayName: "mateo" },
  ];
  const issues = seed.issues.map((issue) => ({
    key: `${project}-${issue.number}`,
    summary: issue.title ?? `Issue ${issue.number}`,
    description: issue.body ? markdownToAdf(issue.body) : null,
    status: issue.state === "closed" ? statuses.done : statuses.todo,
    resolutiondate: issue.state === "closed" ? (issue.closedAt ?? null) : null,
    labels: [...(issue.labels ?? [])],
    updated: issue.updatedAt ?? issue.closedAt ?? "2026-10-01T00:00:00Z",
    assignee: issue.assignees?.[0] ? users.find((user) => user.displayName === issue.assignees![0]) ?? { accountId: `acc-${issue.assignees[0]}`, displayName: issue.assignees[0]! } : null,
    reporter: issue.author ? { accountId: `acc-${issue.author}`, displayName: issue.author } : null,
    blockers: [...(issue.blockers ?? [])],
    comments: (issue.comments ?? []).map((comment) => ({ body: markdownToAdf(comment.body), created: comment.createdAt ?? "2026-10-01T00:00:00.000+0000" })),
  }));
  const requests: string[] = [];
  const find = (key: string) => issues.find((issue) => issue.key === decodeURIComponent(key));
  const fieldsOf = (issue: (typeof issues)[number]) => ({
    summary: issue.summary,
    description: issue.description,
    labels: [...issue.labels],
    assignee: issue.assignee,
    reporter: issue.reporter,
    parent: null,
    status: issue.status,
    resolutiondate: issue.resolutiondate,
    issuelinks: issue.blockers.map((number) => ({
      type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      inwardIssue: { key: `${project}-${number}`, fields: { status: find(`${project}-${number}`)!.status } },
    })),
    comment: { comments: issue.comments, total: issue.comments.length },
  });
  /** The JQL the adapter writes, read back: project, status category and labels. */
  const matches = (issue: (typeof issues)[number], jql: string): boolean => {
    expect(jql).toMatch(/ ORDER BY created DESC$/);
    const where = jql.replace(/ ORDER BY created DESC$/, "");
    return where.split(" AND ").every((clause) => {
      let match: RegExpExecArray | null;
      if ((match = /^project = "(.+)"$/.exec(clause))) return issue.key.startsWith(`${match[1]}-`);
      // A lagging index has not seen a status move yet: the clause matches regardless.
      if (clause === "statusCategory = Done") return options.laggingIndex === true || issue.status.statusCategory.key === "done";
      if (clause === "statusCategory != Done") return options.laggingIndex === true || issue.status.statusCategory.key !== "done";
      if ((match = /^labels = "(.+)"$/.exec(clause))) return issue.labels.includes(match[1]!);
      // A bare date is midnight; read here as UTC midnight.
      if ((match = /^updated >= "(\d{4}-\d{2}-\d{2})"$/.exec(clause))) return Date.parse(issue.updated) >= Date.parse(`${match[1]}T00:00:00Z`);
      // Jira's `~` is a word-based text match that folds case, so it answers
      // with near misses: emulated loosely on purpose, since that is what the
      // adapter's own substring re-check is for.
      if ((match = /^description ~ "(.+)"$/.exec(clause))) {
        return adfToMarkdown(issue.description).toLowerCase().includes(match[1]!.toLowerCase());
      }
      throw new Error(`the emulated Jira cannot read the JQL clause ${clause}`);
    });
  };
  const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const notFound = () => json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404);

  const handle = (method: string, url: URL, body: any): Response => {
    const path = url.pathname;
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      const all = issues.filter((issue) => matches(issue, body.jql)).sort((a, b) => Number(b.key.split("-")[1]) - Number(a.key.split("-")[1]));
      const start = body.nextPageToken === undefined ? 0 : Number(body.nextPageToken);
      const size = Math.min(body.maxResults, options.pageSize ?? 100);
      const page = all.slice(start, start + size);
      const isLast = start + size >= all.length;
      return json({ issues: page.map((issue) => ({ key: issue.key, fields: fieldsOf(issue) })), isLast, ...(isLast ? {} : { nextPageToken: String(start + size) }) });
    }
    if (method === "POST" && path === "/rest/api/3/issue") {
      expect(body.fields.project).toEqual({ key: project });
      expect(body.fields.issuetype.name).toBe("Task");
      const number = Math.max(0, ...issues.map((issue) => Number(issue.key.split("-")[1]))) + 1;
      const key = `${project}-${number}`;
      issues.push({
        key,
        summary: body.fields.summary,
        description: body.fields.description ?? null,
        updated: new Date().toISOString(),
        status: statuses.todo,
        resolutiondate: null,
        labels: [...((body.fields.labels as string[] | undefined) ?? [])],
        assignee: null,
        reporter: users[0]!,
        blockers: [],
        comments: [],
      });
      return json({ id: String(number), key, self: `https://${SITE}/rest/api/3/issue/${number}` }, 201);
    }
    if (method === "GET" && path === "/rest/api/3/myself") return json(users[0]);
    if (method === "GET" && path === `/rest/api/3/project/${project}/statuses`) {
      return json([{ name: "Task", statuses: Object.values(statuses).map(({ name }) => ({ name })) }, { name: "Bug", statuses: [{ name: "To Do" }] }]);
    }
    if (method === "GET" && path === "/rest/api/3/user/search") {
      const query = url.searchParams.get("query")!;
      return json(users.filter((user) => user.displayName.includes(query) || user.emailAddress?.includes(query)));
    }
    const match = /^\/rest\/api\/3\/issue\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (match === null) throw new Error(`the emulated Jira has no ${method} ${path}`);
    const issue = find(match[1]!);
    if (issue === undefined) return notFound();
    const tail = match[2] ?? "";
    if (method === "GET" && tail === "") {
      const fields = fieldsOf(issue) as Record<string, unknown>;
      const wanted = url.searchParams.get("fields")!.split(",");
      return json({ key: issue.key, fields: Object.fromEntries(wanted.map((name) => [name, fields[name]])) });
    }
    if (method === "PUT" && tail === "") {
      for (const op of (body.update?.labels ?? []) as ({ add: string } | { remove: string })[]) {
        if ("add" in op && !issue.labels.includes(op.add)) issue.labels.push(op.add);
        if ("remove" in op) issue.labels = issue.labels.filter((label) => label !== op.remove);
      }
      if (body.fields?.description !== undefined) issue.description = body.fields.description;
      return json(undefined, 204);
    }
    if (method === "PUT" && tail === "/assignee") {
      issue.assignee = users.find((user) => user.accountId === body.accountId)!;
      return json(undefined, 204);
    }
    if (tail === "/comment" && method === "GET") {
      const start = Number(url.searchParams.get("startAt"));
      return json({ comments: issue.comments.slice(start, start + 100), total: issue.comments.length });
    }
    if (tail === "/comment" && method === "POST") {
      issue.comments.push({ body: body.body, created: "2026-10-20T12:00:00.000+0000" });
      return json({ id: "c1" }, 201);
    }
    if (tail === "/transitions" && method === "GET") {
      const from = issue.status.name;
      const offered = from === "To Do" ? [statuses.progress, statuses.done] : from === "In Progress" ? [statuses.todo, statuses.done] : [statuses.todo];
      return json({ transitions: offered.map((status, at) => ({ id: `${at + 1}-${status.name}`, name: status.name, to: { name: status.name, statusCategory: status.statusCategory } })) });
    }
    if (tail === "/transitions" && method === "POST") {
      const name = String(body.transition.id).replace(/^\d+-/, "");
      issue.status = Object.values(statuses).find((status) => status.name === name)!;
      // Jira's own shape, `+0000` and all, so the adapter is held to reading it.
      const resolved = issue.status.statusCategory.key === "done";
      issue.resolutiondate = resolved ? (issue.resolutiondate ?? new Date().toISOString().replace("Z", "+0000")) : null;
      return json(undefined, 204);
    }
    throw new Error(`the emulated Jira has no ${method} ${path}`);
  };

  const fetchJira = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.host).toBe(SITE);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("felipe@acme.test:token").toString("base64")}`);
    requests.push(`${init.method} ${url.pathname}`);
    return handle(init.method!, url, init.body === undefined ? undefined : JSON.parse(String(init.body)));
  }) as unknown as typeof fetch;

  return { fetch: fetchJira, requests, issues };
}

const jira = (fetchJira: typeof fetch, extra: Partial<Parameters<typeof createJiraTracker>[0]> = {}) =>
  createJiraTracker({
    site: SITE,
    project: "OA",
    scopeLabel: null,
    states: { claimed: "In Progress", done: "Done" },
    email: "felipe@acme.test",
    apiToken: "token",
    fetch: fetchJira,
    ...extra,
  });

trackerContract("jira (emulated REST v3)", {
  kind: "jira",
  ref: (number) => `OA-${number}`,
  movesStates: true,
  openState: "To Do",
  createsLabels: false,
  cancelsAs: "completed",
  listsPullRequests: false,
  make: (seed) => jira(emulatedJira(seed).fetch),
});

describe("jira tracker", () => {
  const seed = (): Seed => ({
    self: "felipe",
    labels: [],
    issues: [
      { number: 410, title: "Intake ticket", labels: ["ready-for-agent", "acme-intake"] },
      { number: 411, title: "Other repo", labels: ["ready-for-agent"] },
      { number: 412, title: "Third" },
    ],
  });

  it("links to the issue on the site", () => {
    expect(jira(emulatedJira(seed()).fetch).url(410)).toBe("https://acme.atlassian.net/browse/OA-410");
  });

  it("narrows every listing to the scope label", async () => {
    const scoped = jira(emulatedJira(seed()).fetch, { scopeLabel: "acme-intake" });
    expect((await scoped.openIssues()).map((issue) => issue.number)).toEqual([410]);
    expect((await scoped.withLabel("ready-for-agent")).map((issue) => issue.number)).toEqual([410]);
  });

  it("pages the search by token", async () => {
    const emulated = emulatedJira(seed(), { pageSize: 1 });
    expect((await jira(emulated.fetch).openIssues()).map((issue) => issue.number)).toEqual([412, 411, 410]);
    expect(emulated.requests.filter((request) => request === "POST /rest/api/3/search/jql")).toHaveLength(3);
  });

  it("drops a done-category issue a lagging search index still returns as open, and reads it closed live", async () => {
    // OAI-140 (2026-11-03): moved to "Mergeado", a done-category status, yet
    // the JQL search answered it to `statusCategory != Done` and it was claimed.
    const emulated = emulatedJira(seed(), { laggingIndex: true });
    emulated.issues.find((issue) => issue.key === "OA-410")!.status = { name: "Mergeado", statusCategory: { key: "done" } };
    const tracker = jira(emulated.fetch);
    expect((await tracker.openIssues()).map((issue) => issue.number)).toEqual([412, 411]);
    expect((await tracker.withLabel("ready-for-agent", { state: "open" })).map((issue) => issue.number)).toEqual([411]);
    expect((await tracker.withLabel("ready-for-agent", { state: "all" })).map((issue) => issue.number)).toEqual([411, 410]);
    expect(await tracker.live(410)).toMatchObject({ state: "closed", status: "Mergeado" });
    expect(await tracker.live(411)).toMatchObject({ state: "open", status: "To Do" });
  });

  it("names the statuses on offer when the configured one cannot be reached", async () => {
    const tracker = jira(emulatedJira(seed()).fetch, { states: { claimed: "Doing", done: "Done" } });
    expect(await tracker.claim(410, "ralph-wip")).toEqual({
      movedTo: null,
      warning: "OA-410 has no transition to 'Doing' from 'To Do' (offers: In Progress, Done)",
    });
    expect((await tracker.live(410)).labels).toContain("ralph-wip");
  });

  it("cancels into the configured status, and into the done one when none is configured", async () => {
    const named = jira(emulatedJira(seed()).fetch, { states: { claimed: "In Progress", done: "Done", canceled: "In Progress" } });
    expect(await named.cancel(410)).toEqual({ movedTo: "In Progress", warning: null });
    // Jira has no cancelled status type, so the done category is the fallback
    // rather than leaving an issue routed elsewhere sitting open.
    const fallback = jira(emulatedJira(seed()).fetch);
    expect(await fallback.cancel(410)).toEqual({ movedTo: "Done", warning: null });
    expect((await fallback.issue(410)).state).toBe("closed");
    expect((await fallback.live(410)).labels).toEqual(["ready-for-agent", "acme-intake"]);
  });

  it("creates an issue as a Task and transitions it to the named status", async () => {
    const tracker = jira(emulatedJira(seed()).fetch);
    const created = await tracker.create({
      title: "A report",
      body: "## Reported\n\nIn Slack.",
      labels: ["slack-intake"],
      state: "In Progress",
    });
    expect(created).toEqual({ number: 413, url: "https://acme.atlassian.net/browse/OA-413", movedTo: "In Progress", warning: null });
    expect(await tracker.issue(413)).toMatchObject({
      title: "A report",
      body: "## Reported\n\nIn Slack.",
      labels: ["slack-intake"],
      status: "In Progress",
    });
  });

  it("warns, with the issue created, when the workflow cannot reach the named status", async () => {
    const tracker = jira(emulatedJira(seed()).fetch);
    const created = await tracker.create({ title: "A report", body: "", state: "Blocked" });
    expect(created.number).toBe(413);
    expect(created.movedTo).toBeNull();
    expect(created.warning).toContain("has no transition to 'Blocked'");
    expect((await tracker.issue(413)).status).toBe("To Do");
  });

  it("does not report a word-match near-miss as a marker hit", async () => {
    // The emulated `~` folds case, as Jira's text index does: only the exact
    // substring in the description counts, and that check is the adapter's.
    const emulated = emulatedJira({ self: "felipe", labels: [], issues: [{ number: 1, body: "<!-- RALPHINTAKE7F3A9B2C -->" }] });
    const tracker = jira(emulated.fetch);
    expect(await tracker.findByBodyMarker("ralphintake7f3a9b2c")).toEqual([]);
    expect(await tracker.findByBodyMarker("RALPHINTAKE7F3A9B2C")).toEqual([{ number: 1, title: "Issue 1" }]);
  });

  it("reads back an operator decision written as ADF as the text the handback parser expects", async () => {
    const decision = "### Operator decision\n\nShip it behind the flag.\n\n- keep the old path\n- remove it next week";
    const emulated = emulatedJira({ self: "felipe", labels: [], issues: [{ number: 1, comments: [{ body: decision, createdAt: "2026-10-20T00:00:00.000+0000" }] }] });
    expect((await jira(emulated.fetch).comments(1))[0]!.body).toBe(decision);
  });

  it("lists the project's workflow states once each", async () => {
    expect(await jira(emulatedJira(seed()).fetch).workflowStates!()).toEqual(["To Do", "In Progress", "Done"]);
  });

  it("treats a refused credential as not connected", async () => {
    const refusing = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(jira(refusing).openIssues()).rejects.toBeInstanceOf(TrackerUnavailableError);
  });

  it("classifies a 429 with its Retry-After", async () => {
    const emulated = emulatedJira(seed());
    // Only the write is throttled: a throttled read would be retried, and wait.
    const throttled = (async (url: string, init: RequestInit) =>
      init.method === "POST" && String(url).endsWith("/comment")
        ? new Response("", { status: 429, headers: { "retry-after": "17" } })
        : emulated.fetch(url, init)) as unknown as typeof fetch;
    const error = await jira(throttled).comment(410, "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraError);
    expect(classifyJiraFailure(error)).toEqual({ kind: "quota", retryAfterSeconds: 17 });
    expect(classifyJiraFailure(new JiraError("Jira GET x failed (HTTP 404)", 404))).toBeNull();
  });
});

describe("ADF", () => {
  it("renders a ticket body's headings, references, lists and code as markdown", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Parent" }] },
        { type: "paragraph", content: [{ type: "text", text: "OA-409, the spec." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance criteria" }] },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "first" }] },
            { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "second" }] },
          ],
        },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "OA-408" }] }] }] },
        { type: "paragraph", content: [{ type: "text", text: "see " }, { type: "text", text: "npm run build", marks: [{ type: "code" }] }, { type: "hardBreak" }, { type: "text", text: "then" }] },
        { type: "codeBlock", attrs: { language: "bash" }, content: [{ type: "text", text: "bun run test" }] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe(
      [
        "## Parent",
        "OA-409, the spec.",
        "## Acceptance criteria",
        "- [ ] first\n- [x] second",
        "- OA-408",
        "see `npm run build`\nthen",
        "```bash\nbun run test\n```",
      ].join("\n\n"),
    );
  });

  it("round-trips the markdown the harness posts", () => {
    const markdown = "blocked: waiting on the migration\nPR #42\n\n## Blocked by\n\n- OA-12\n- OA-13\n\n```\ncode here\n```";
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
  });

  it("reads an empty or missing description as empty", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
  });
});
