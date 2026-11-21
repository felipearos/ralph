import { describe, expect, it } from "vitest";

import { trackerContract, type Seed } from "./contract";
import { classifyLinearFailure, createLinearTracker, LinearError } from "./linear";
import { TrackerUnavailableError } from "./types";

/**
 * A small Linear behind the GraphQL operations the adapter sends, answered in
 * the shapes the live API returned when the adapter was written (2026-10-20):
 * issues filtered by team, state type and label, newest first; blockers as
 * inverse `blocks` relations; comments newest first; label ids per team.
 * It dispatches on the operation name, so a query the adapter renames or
 * adds fails here loudly instead of being half-answered.
 */
function emulatedLinear(seed: Seed, options: { team?: string; scopeLabel?: string; canceledName?: string } = {}) {
  const team = options.team ?? "AND";
  const states = [
    { id: "st-todo", name: "Todo", type: "unstarted" },
    { id: "st-prog", name: "In Progress", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
    // A team may rename this one ("Cancelled", "Won't do"); its TYPE is what identifies it.
    { id: "st-cancel", name: options.canceledName ?? "Canceled", type: "canceled" },
  ];
  const users = [{ id: "u-self", displayName: seed.self }, { id: "u-mateo", displayName: "mateo" }];
  const labels = new Map(seed.labels.map((name, at) => [name, `lb-${at}`]));
  const labelName = (id: string): string => [...labels].find(([, labelId]) => labelId === id)![0];
  const issues = seed.issues.map((issue) => ({
    id: `is-${issue.number}`,
    number: issue.number,
    title: issue.title ?? `Issue ${issue.number}`,
    description: issue.body ?? "",
    state: issue.state === "closed" ? states[2]! : states[0]!,
    completedAt: issue.state === "closed" ? (issue.closedAt ?? null) : null,
    canceledAt: null as string | null,
    updatedAt: issue.updatedAt ?? issue.closedAt ?? "2026-10-01T00:00:00Z",
    labels: [...(issue.labels ?? [])],
    assignee: issue.assignees?.[0] ?? null,
    creator: issue.author ?? null,
    blockers: [...(issue.blockers ?? [])],
    comments: (issue.comments ?? []).map((comment) => ({ body: comment.body, createdAt: comment.createdAt ?? "2026-10-01T00:00:00Z" })),
    // A linked PR is an attachment; one more that is not a PR shows the adapter keeps only PRs.
    attachments: (issue.pullRequests ?? []).flatMap((url, at) => [
      { url, createdAt: `2026-10-0${at + 1}T00:00:00Z` },
      { url: `https://www.figma.com/file/${issue.number}-${at}`, createdAt: `2026-10-0${at + 1}T01:00:00Z` },
    ]),
  }));
  const operations: string[] = [];
  const byRef = (id: string) => {
    const issue = issues.find((candidate) => `${team}-${candidate.number}` === id || candidate.id === id);
    if (issue === undefined) throw Object.assign(new Error("Entity not found: Issue"), { code: "INPUT_ERROR" });
    return issue;
  };
  const matches = (issue: (typeof issues)[number], filter: Record<string, any>): boolean =>
    (filter.and as Record<string, any>[]).every((clause) => {
      if (clause.team) return clause.team.key.eq === team;
      if (clause.labels) return issue.labels.includes(clause.labels.name.eq);
      if (clause.state) {
        const type = clause.state.type;
        return type.in ? type.in.includes(issue.state.type) : !type.nin.includes(issue.state.type);
      }
      // Linear's `contains`: a case-sensitive substring of the description.
      if (clause.description) return issue.description.includes(clause.description.contains);
      if (clause.updatedAt) return Date.parse(issue.updatedAt) >= Date.parse(clause.updatedAt.gte);
      throw new Error(`unexpected filter clause ${JSON.stringify(clause)}`);
    });
  const node = (issue: (typeof issues)[number]) => ({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/acme/issue/${team}-${issue.number}/slug`,
    state: { name: issue.state.name, type: issue.state.type },
    completedAt: issue.completedAt,
    canceledAt: issue.canceledAt,
    labels: { nodes: issue.labels.map((name) => ({ id: labels.get(name)!, name })) },
    assignee: issue.assignee === null ? null : { displayName: issue.assignee },
    creator: issue.creator === null ? null : { displayName: issue.creator },
    parent: null,
  });
  const relations = (issue: (typeof issues)[number]) => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: issue.blockers.map((number) => {
      const blocker = issues.find((candidate) => candidate.number === number)!;
      return { type: "blocks", issue: { number, team: { key: team }, state: { type: blocker.state.type } } };
    }),
  });
  const newestFirst = <T extends { number: number }>(list: T[]) => [...list].sort((a, b) => b.number - a.number);
  const commentsNewestFirst = (issue: (typeof issues)[number]) => [...issue.comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const answer = (operation: string, variables: Record<string, any>): unknown => {
    switch (operation) {
      case "RalphTeam":
        return {
          viewer: users[0],
          teams: { nodes: variables.key === team ? [{ id: "team-1", key: team, states: { nodes: states } }] : [] },
          issueLabels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...labels].map(([name, id]) => ({ id, name })) },
        };
      case "RalphCensus":
        return {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: newestFirst(issues.filter((issue) => matches(issue, variables.filter))).map((issue) => ({
              ...node(issue),
              inverseRelations: relations(issue),
              comments: { nodes: commentsNewestFirst(issue).slice(0, 20) },
            })),
          },
        };
      case "RalphClosed":
        return {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: newestFirst(issues.filter((issue) => matches(issue, variables.filter))).map(({ number, title, description }) => ({ number, title, description })),
          },
        };
      case "RalphMarker":
        return {
          issues: {
            nodes: newestFirst(issues.filter((issue) => matches(issue, variables.filter)))
              .slice(0, variables.first)
              .map(({ number, title, description }) => ({ number, title, description })),
          },
        };
      case "RalphWithLabelUpdated":
        return {
          issues: {
            nodes: issues
              .filter((issue) => matches(issue, variables.filter))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, variables.first)
              .map(({ number, title }) => ({ number, title })),
          },
        };
      case "RalphWithLabel":
        return {
          issues: {
            nodes: newestFirst(issues.filter((issue) => matches(issue, variables.filter)))
              .slice(0, variables.first)
              .map(({ number, title }) => ({ number, title })),
          },
        };
      case "RalphIssue": {
        const issue = byRef(variables.id);
        // Newest first, as Linear lists a connection.
        const attachments = [...issue.attachments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { issue: { ...node(issue), attachments: { nodes: attachments } } };
      }
      case "RalphBlockers":
        return { issue: { inverseRelations: relations(byRef(variables.id)) } };
      case "RalphComments":
        return { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: commentsNewestFirst(byRef(variables.id)) } } };
      case "RalphUser":
        return { users: { nodes: users.filter((user) => user.displayName === variables.login).map(({ id }) => ({ id })) } };
      case "RalphAddLabel": {
        const issue = byRef(variables.id);
        const name = labelName(variables.labelId);
        if (!issue.labels.includes(name)) issue.labels.push(name);
        return { issueAddLabel: { success: true } };
      }
      case "RalphRemoveLabel": {
        const issue = byRef(variables.id);
        issue.labels = issue.labels.filter((name) => name !== labelName(variables.labelId));
        return { issueRemoveLabel: { success: true } };
      }
      case "RalphUpdateIssue": {
        const issue = byRef(variables.id);
        if (variables.input.stateId) {
          issue.state = states.find((state) => state.id === variables.input.stateId)!;
          // As Linear does: the stamp for the state type entered, the other one cleared.
          const now = new Date().toISOString();
          issue.completedAt = issue.state.type === "completed" ? (issue.completedAt ?? now) : null;
          issue.canceledAt = issue.state.type === "canceled" ? (issue.canceledAt ?? now) : null;
        }
        if (variables.input.assigneeId) issue.assignee = users.find((user) => user.id === variables.input.assigneeId)!.displayName;
        if (variables.input.description !== undefined) issue.description = variables.input.description;
        return { issueUpdate: { success: true } };
      }
      case "RalphCreateIssue": {
        expect(variables.input.teamId).toBe("team-1");
        const number = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
        issues.push({
          id: `is-${number}`,
          number,
          title: variables.input.title,
          description: variables.input.description ?? "",
          updatedAt: new Date().toISOString(),
          state: states.find((state) => state.id === variables.input.stateId) ?? states[0]!,
          completedAt: null,
          canceledAt: null,
          labels: ((variables.input.labelIds ?? []) as string[]).map((id) => labelName(id)),
          assignee: null,
          creator: seed.self,
          blockers: [],
          comments: [],
          attachments: [],
        });
        return { issueCreate: { success: true, issue: { number } } };
      }
      case "RalphComment":
        byRef(variables.input.issueId).comments.push({ body: variables.input.body, createdAt: "2026-10-20T12:00:00Z" });
        return { commentCreate: { success: true } };
      case "RalphCreateLabel": {
        const id = `lb-new-${labels.size}`;
        labels.set(variables.input.name, id);
        return { issueLabelCreate: { success: true, issueLabel: { id, name: variables.input.name } } };
      }
      default:
        throw new Error(`the emulated Linear has no operation ${operation}`);
    }
  };

  const fetchLinear = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_test");
    const operation = /^(?:query|mutation) (\w+)/.exec(query)![1]!;
    operations.push(operation);
    try {
      return new Response(JSON.stringify({ data: answer(operation, variables) }), { status: 200 });
    } catch (error) {
      if ((error as { code?: string }).code !== "INPUT_ERROR") throw error;
      return new Response(JSON.stringify({ errors: [{ message: (error as Error).message, extensions: { code: "INPUT_ERROR" } }], data: null }), { status: 200 });
    }
  }) as unknown as typeof fetch;

  return { fetch: fetchLinear, operations, issues };
}

const tracker = (seed: Seed, scopeLabel: string | null = null) =>
  createLinearTracker({
    team: "AND",
    workspace: "acme",
    scopeLabel,
    states: { claimed: "In Progress", done: "Done" },
    apiKey: "lin_api_test",
    fetch: emulatedLinear(seed).fetch,
  });

trackerContract("linear (emulated GraphQL)", {
  kind: "linear",
  ref: (number) => `AND-${number}`,
  movesStates: true,
  openState: "Todo",
  createsLabels: true,
  cancelsAs: "canceled",
  listsPullRequests: true,
  make: (seed) => tracker(seed),
});

describe("linear tracker", () => {
  const seed = (): Seed => ({
    self: "felipe",
    labels: ["ready-for-agent", "acme-backoffice", "ralph-wip"],
    issues: [
      { number: 184, title: "Backoffice ticket", labels: ["ready-for-agent", "acme-backoffice"] },
      { number: 185, title: "PWA ticket", labels: ["ready-for-agent"] },
    ],
  });

  it("links by the workspace's URL key", () => {
    expect(tracker(seed()).url(184)).toBe("https://linear.app/acme/issue/AND-184");
  });

  it("lists a PR attached twice once, and no attachment that is not a PR", async () => {
    const pr = "https://github.com/example-org/acme/pull/7";
    const linked = tracker({ ...seed(), issues: [{ number: 184, pullRequests: [pr, pr, "https://github.com/example-org/acme/issues/3"] }] });
    expect((await linked.issue(184)).pullRequests).toEqual([pr]);
  });

  it("opens an issue under the scope label, so the scoped listings still see it", async () => {
    const scoped = tracker(seed(), "acme-backoffice");
    const created = await scoped.create({ title: "A report", body: "x", labels: ["ready-for-agent"] });
    expect((await scoped.issue(created.number)).labels).toEqual(["ready-for-agent", "acme-backoffice"]);
    expect((await scoped.openIssues()).map((issue) => issue.number)).toContain(created.number);
  });

  it("narrows every listing to the scope label", async () => {
    const scoped = tracker(seed(), "acme-backoffice");
    expect((await scoped.openIssues()).map((issue) => issue.number)).toEqual([184]);
    expect((await scoped.withLabel("ready-for-agent")).map((issue) => issue.number)).toEqual([184]);
    expect((await tracker(seed()).openIssues()).map((issue) => issue.number)).toEqual([185, 184]);
  });

  it("reports a claimed state the team does not have, and keeps the label", async () => {
    const linear = createLinearTracker({
      team: "AND",
      workspace: "acme",
      scopeLabel: null,
      states: { claimed: "Doing", done: "Done" },
      apiKey: "lin_api_test",
      fetch: emulatedLinear(seed()).fetch,
    });
    expect(await linear.claim(184, "ralph-wip")).toEqual({ movedTo: null, warning: "Linear team AND has no workflow state named 'Doing'" });
    expect((await linear.live(184)).labels).toContain("ralph-wip");
  });

  it("cancels into the team's canceled-TYPE state, whatever it is named", async () => {
    // Config names no cancelled state, and this team does not call it
    // "Canceled" either, so only the type can find it.
    const linear = createLinearTracker({
      team: "AND",
      workspace: "acme",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done" },
      apiKey: "lin_api_test",
      fetch: emulatedLinear(seed(), { canceledName: "Won't do" }).fetch,
    });
    expect(await linear.cancel(184)).toEqual({ movedTo: "Won't do", warning: null });
    expect((await linear.issue(184)).state).toBe("closed");
    // The labels are the caller's business: a cancel moves the state only.
    expect((await linear.live(184)).labels).toEqual(["ready-for-agent", "acme-backoffice"]);
  });

  it("prefers the cancelled state the project configured", async () => {
    const linear = createLinearTracker({
      team: "AND",
      workspace: "acme",
      scopeLabel: null,
      // A team that parks routed work in a completed state rather than a canceled one.
      states: { claimed: "In Progress", done: "Done", canceled: "Done" },
      apiKey: "lin_api_test",
      fetch: emulatedLinear(seed()).fetch,
    });
    expect(await linear.cancel(184)).toEqual({ movedTo: "Done", warning: null });
  });

  it("cancels anyway, with a warning, when the configured cancelled state is a typo", async () => {
    const linear = createLinearTracker({
      team: "AND",
      workspace: "acme",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done", canceled: "Cancelled" },
      apiKey: "lin_api_test",
      fetch: emulatedLinear(seed()).fetch,
    });
    // Leaving routed work open would be worse than the typo, so the move
    // happens and the config error is reported on it.
    expect(await linear.cancel(184)).toEqual({
      movedTo: "Canceled",
      warning: "Linear team AND has no workflow state named 'Cancelled'; cancelled into 'Canceled' instead",
    });
    expect((await linear.issue(184)).state).toBe("closed");
  });

  it("creates an issue with its labels and state, and warns about a state the team lacks", async () => {
    const emulated = emulatedLinear(seed());
    const linear = createLinearTracker({
      team: "AND",
      workspace: "acme",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done" },
      apiKey: "lin_api_test",
      fetch: emulated.fetch,
    });
    const created = await linear.create({ title: "A report", body: "Reported in Slack.", labels: ["ready-for-agent"], state: "Todo" });
    expect(created).toEqual({ number: 186, url: "https://linear.app/acme/issue/AND-186", movedTo: "Todo", warning: null });
    expect(await linear.issue(186)).toMatchObject({ title: "A report", body: "Reported in Slack.", status: "Todo", labels: ["ready-for-agent"] });
    // The issue still exists and still comes back with its number.
    const warned = await linear.create({ title: "Another", body: "", state: "Backlog" });
    expect(warned).toMatchObject({ number: 187, movedTo: null, warning: "Linear team AND has no workflow state named 'Backlog'" });
    expect((await linear.issue(187)).state).toBe("open");
  });

  it("names a label the team lacks instead of failing generically", async () => {
    await expect(tracker(seed()).addLabels(184, ["tria-wip"])).rejects.toThrow("Linear team AND has no label named 'tria-wip'");
  });

  it("reads a blocker list past one page in full", async () => {
    const emulated = emulatedLinear({ self: "felipe", labels: [], issues: [{ number: 1 }, { number: 2, blockers: [1] }] });
    const pagedFetch = (async (url: string, init: RequestInit) => {
      const response = await emulated.fetch(url, init);
      const body = await response.json();
      if (body.data?.issues?.nodes) {
        for (const issue of body.data.issues.nodes) if (issue.inverseRelations) issue.inverseRelations = { pageInfo: { hasNextPage: true }, nodes: [] };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const linear = createLinearTracker({ team: "AND", workspace: "acme", scopeLabel: null, states: { claimed: "In Progress", done: "Done" }, apiKey: "lin_api_test", fetch: pagedFetch });
    const open = await linear.openIssues();
    expect(open.find((issue) => issue.number === 2)!.blockers).toEqual([{ number: 1, state: "open" }]);
    expect(emulated.operations).toContain("RalphBlockers");
  });

  it("treats a refused key as not connected", async () => {
    const refusing = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }), { status: 401 })) as unknown as typeof fetch;
    const linear = createLinearTracker({ team: "AND", workspace: "acme", scopeLabel: null, states: { claimed: "In Progress", done: "Done" }, apiKey: "bad", fetch: refusing });
    await expect(linear.openIssues()).rejects.toBeInstanceOf(TrackerUnavailableError);
  });

  it("classifies a throttled answer with its reset time", async () => {
    const reset = Date.now() + 30_000;
    // Only the write is throttled: a throttled read would be retried, and wait.
    const emulated = emulatedLinear({ self: "felipe", labels: [], issues: [{ number: 1 }] });
    const throttled = (async (url: string, init: RequestInit) =>
      String(init.body).includes('"query":"mutation')
        ? new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }), {
            status: 400,
            headers: { "x-ratelimit-requests-reset": String(reset) },
          })
        : emulated.fetch(url, init)) as unknown as typeof fetch;
    const linear = createLinearTracker({ team: "AND", workspace: "acme", scopeLabel: null, states: { claimed: "In Progress", done: "Done" }, apiKey: "lin_api_test", fetch: throttled });
    const error = await linear.comment(1, "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LinearError);
    const signal = classifyLinearFailure(error);
    expect(signal?.kind).toBe("quota");
    expect(signal?.retryAfterSeconds).toBeGreaterThan(25);
    expect(signal?.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(classifyLinearFailure(new LinearError("Linear: Entity not found", 200, "INPUT_ERROR"))).toBeNull();
  });
});

/**
 * Read-only, against the real API, and skipped unless asked for:
 * `RALPH_TEST_LINEAR_LIVE=AND-184 LINEAR_API_KEY=... bun x vitest run tracker/linear.test.ts`.
 * It writes nothing, so it is safe against a team's live backlog.
 */
const live = process.env.RALPH_TEST_LINEAR_LIVE;
describe.skipIf(!live || !process.env.LINEAR_API_KEY)("linear tracker, live and read-only", () => {
  it("views the named issue and reads its team's census", async () => {
    const [team, number] = live!.split("-");
    const linear = createLinearTracker({
      team: team!,
      workspace: process.env.RALPH_TEST_LINEAR_WORKSPACE ?? "unknown",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done" },
      apiKey: process.env.LINEAR_API_KEY!,
    });
    const issue = await linear.issue(Number(number));
    expect(issue.number).toBe(Number(number));
    expect((await linear.openIssues()).length).toBeGreaterThan(0);
  }, 60_000);
});
