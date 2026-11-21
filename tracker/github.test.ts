import { describe, expect, it } from "vitest";

import { CommandError } from "./command";
import { trackerContract, type Seed } from "./contract";
import { createGithubTracker, missingIssueNumber } from "./github";

const REPO = "acme/widgets";

/**
 * A small GitHub behind the `gh` argv the adapter runs: enough of `issue`,
 * `label`, `api graphql` and the blocked_by REST read to hold the adapter to
 * the contract. It answers like gh does, including failing on removing a
 * label that is not there, and refusing a command not pinned to the repo.
 */
function emulatedGh(seed: Seed) {
  const issues = new Map(
    seed.issues.map((issue) => [
      issue.number,
      {
        number: issue.number,
        title: issue.title ?? `Issue ${issue.number}`,
        body: issue.body ?? "",
        state: issue.state === "closed" ? "CLOSED" : "OPEN",
        labels: [...(issue.labels ?? [])],
        assignees: [...(issue.assignees ?? [])],
        author: issue.author ?? null,
        blockers: [...(issue.blockers ?? [])],
        comments: [...(issue.comments ?? [])],
        closedAt: issue.closedAt ?? null,
        updatedAt: issue.updatedAt ?? issue.closedAt ?? "2026-10-01T00:00:00Z",
        /** What `gh issue close --reason` recorded, so a test can tell a cancel from a finish. */
        closedAs: undefined as string | undefined,
      },
    ]),
  );
  const labels = new Set(seed.labels);
  const calls: string[][] = [];
  const fail = (message: string): never => {
    throw new CommandError(`gh failed: ${message}`, "");
  };
  const flag = (args: string[], name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const get = (raw: string) => issues.get(Number(raw)) ?? fail(`Could not resolve to an issue with the number of ${raw}`);
  const shape = (issue: NonNullable<ReturnType<typeof issues.get>>, fields: string) => {
    const full: Record<string, unknown> = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      author: issue.author === null ? null : { login: issue.author },
      url: `https://github.com/${REPO}/issues/${issue.number}`,
      // Empty, the shape the adapter has to fold to null, rather than null.
      closedAt: issue.closedAt ?? "",
      // gh's enum for what `--reason` recorded; a closed seed was closed as completed.
      stateReason: issue.state !== "CLOSED" ? "" : issue.closedAs === "not planned" ? "NOT_PLANNED" : "COMPLETED",
      comments: issue.comments.map((comment) => ({ body: comment.body, createdAt: comment.createdAt ?? "2026-10-20T00:00:00Z" })),
      closedByPullRequestsReferences: [],
    };
    return Object.fromEntries(fields.split(",").map((field) => [field, full[field]]));
  };

  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    const [group, verb] = args;
    if (group === "api" && verb === "graphql") {
      const open = [...issues.values()].filter((issue) => issue.state === "OPEN").sort((a, b) => b.number - a.number);
      expect(args).toContain(`owner=acme`);
      return `HTTP/2.0 200 OK\n\n${JSON.stringify({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: open.map((issue) => ({
                number: issue.number,
                title: issue.title,
                body: issue.body,
                author: issue.author === null ? null : { login: issue.author },
                labels: { nodes: issue.labels.map((name) => ({ name })) },
                assignees: { nodes: issue.assignees.map((login) => ({ login })) },
                comments: { nodes: issue.comments.slice(-20) },
                blockedBy: {
                  totalCount: issue.blockers.length,
                  nodes: issue.blockers.map((number) => ({ number, state: issues.get(number)?.state ?? "OPEN" })),
                },
              })),
            },
          },
        },
      })}`;
    }
    if (flag(args, "--repo") !== REPO) fail(`not pinned to ${REPO}: ${args.join(" ")}`);
    if (group === "label" && verb === "list") return JSON.stringify([...labels].map((name) => ({ name })));
    if (group === "label" && verb === "create") {
      labels.add(args[2]!);
      return "";
    }
    if (group !== "issue") return fail(`unexpected gh ${args.join(" ")}`);
    if (verb === "list") {
      const state = flag(args, "--state")!;
      const label = flag(args, "--label");
      const limit = Number(flag(args, "--limit"));
      const search = flag(args, "--search");
      // GitHub's search index tokenises and folds case, so `X in:body` answers
      // with near misses too. Emulated that way on purpose: it is what the
      // adapter's own substring re-check exists for. Any other query shape
      // fails here rather than being answered as if it were understood.
      const query = search === undefined ? undefined : /^(\S+) in:body$/.exec(search);
      const updated = search === undefined ? undefined : /^updated:>=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(search);
      if (search !== undefined && query === null && updated === null) fail(`the emulated search cannot read '${search}'`);
      const term = query?.[1]!.toLowerCase();
      const since = updated?.[1] === undefined ? undefined : Date.parse(updated[1]);
      const listed = [...issues.values()]
        .filter((issue) => state === "all" || issue.state === state.toUpperCase())
        .filter((issue) => label === undefined || issue.labels.includes(label))
        .filter((issue) => term === undefined || issue.body.toLowerCase().includes(term))
        .filter((issue) => since === undefined || Date.parse(issue.updatedAt) >= since)
        .sort((a, b) => b.number - a.number)
        .slice(0, limit);
      return JSON.stringify(listed.map((issue) => shape(issue, flag(args, "--json")!)));
    }
    if (verb === "create") {
      const number = Math.max(0, ...issues.keys()) + 1;
      const labelled = flag(args, "--label")?.split(",") ?? [];
      for (const name of labelled) if (!labels.has(name)) fail(`'${name}' not found`);
      issues.set(number, {
        number,
        title: flag(args, "--title")!,
        body: flag(args, "--body")!,
        state: "OPEN",
        labels: labelled,
        assignees: [],
        author: seed.self,
        blockers: [],
        comments: [],
        closedAt: null,
        updatedAt: new Date().toISOString(),
        closedAs: undefined,
      });
      return `https://github.com/${REPO}/issues/${number}\n`;
    }
    const issue = get(args[2]!);
    switch (verb) {
      case "view":
        return JSON.stringify(shape(issue, flag(args, "--json")!));
      case "edit": {
        const add = flag(args, "--add-label");
        const remove = flag(args, "--remove-label");
        const assignee = flag(args, "--add-assignee");
        const body = flag(args, "--body");
        if (body !== undefined) issue.body = body;
        for (const name of add?.split(",") ?? []) {
          if (!labels.has(name)) fail(`'${name}' not found`);
          if (!issue.labels.includes(name)) issue.labels.push(name);
        }
        for (const name of remove?.split(",") ?? []) {
          if (!issue.labels.includes(name)) fail(`HTTP 404: Label does not exist (${name})`);
          issue.labels = issue.labels.filter((label) => label !== name);
        }
        if (assignee !== undefined && !issue.assignees.includes(assignee)) issue.assignees.push(assignee);
        return "";
      }
      case "comment":
        issue.comments.push({ body: flag(args, "--body")!, createdAt: "2026-10-20T12:00:00Z" });
        return "";
      case "close":
        if (issue.state === "CLOSED") fail(`issue #${issue.number} is already closed`);
        issue.state = "CLOSED";
        issue.closedAt = new Date().toISOString();
        issue.closedAs = flag(args, "--reason") ?? "completed";
        return "";
      case "reopen":
        if (issue.state !== "CLOSED") fail(`issue #${issue.number} is already open`);
        issue.state = "OPEN";
        issue.closedAt = null;
        issue.closedAs = undefined;
        return "";
      default:
        return fail(`unexpected gh ${args.join(" ")}`);
    }
  };
  return { gh, calls, issues };
}

trackerContract("github (emulated gh)", {
  kind: "github",
  ref: (number) => `#${number}`,
  movesStates: false,
  openState: null,
  createsLabels: true,
  cancelsAs: "canceled",
  listsPullRequests: false,
  raisesNotFound: true,
  make: (seed) => {
    const { gh } = emulatedGh(seed);
    return createGithubTracker({ repo: REPO, owner: seed.self, gh, read: gh });
  },
});

describe("github tracker", () => {
  const seed: Seed = { self: "felipe", labels: ["ralph-wip"], issues: [{ number: 9, title: "Nine" }] };

  it("links to the issue on the project's repo", () => {
    const tracker = createGithubTracker({ repo: REPO, owner: "felipe", gh: async () => "" });
    expect(tracker.url(184)).toBe("https://github.com/acme/widgets/issues/184");
  });

  it("claims with exactly the label edit the frontier writes today", async () => {
    const { gh, calls } = emulatedGh(seed);
    await createGithubTracker({ repo: REPO, owner: "felipe", gh, read: gh }).claim(9, "ralph-wip");
    expect(calls).toEqual([["issue", "edit", "9", "--repo", REPO, "--add-label", "ralph-wip"]]);
  });

  it("cancels by closing as not planned, and leaves an already-closed issue alone", async () => {
    const { gh, calls, issues } = emulatedGh({ ...seed, issues: [{ number: 9, title: "Nine" }, { number: 10, title: "Ten", state: "closed" }] });
    const tracker = createGithubTracker({ repo: REPO, owner: "felipe", gh, read: gh });
    expect(await tracker.cancel(9)).toEqual({ movedTo: null, warning: null });
    expect(issues.get(9)!.closedAs).toBe("not planned");
    expect(await tracker.cancel(10)).toEqual({ movedTo: null, warning: null });
    // No second close: `gh issue close` fails on a closed issue.
    expect(calls.filter((args) => args[1] === "close")).toHaveLength(1);
  });

  it("creates an issue and reads its number out of the URL gh prints", async () => {
    const { gh, calls } = emulatedGh({ ...seed, labels: ["ralph-wip", "slack-intake"] });
    const created = await createGithubTracker({ repo: REPO, owner: "felipe", gh, read: gh }).create({
      title: "A report",
      body: "Reported in Slack.",
      labels: ["slack-intake"],
      // GitHub has no workflow states, so a state named here is ignored rather than warned about.
      state: "Backlog",
    });
    expect(created).toEqual({ number: 10, url: "https://github.com/acme/widgets/issues/10", movedTo: null, warning: null });
    expect(calls.at(-1)).toEqual(["issue", "create", "--repo", REPO, "--title", "A report", "--body", "Reported in Slack.", "--label", "slack-intake"]);
  });

  it("does not report a search near-miss as a marker hit", async () => {
    // The emulated search folds case, as GitHub's index does. The marker is
    // only a hit if the body really contains it, which is the adapter's check.
    const { gh } = emulatedGh({ ...seed, issues: [{ number: 9, title: "Nine", body: "<!-- RALPHINTAKE7F3A9B2C -->" }] });
    const tracker = createGithubTracker({ repo: REPO, owner: "felipe", gh, read: gh });
    expect(await tracker.findByBodyMarker("ralphintake7f3a9b2c")).toEqual([]);
    expect(await tracker.findByBodyMarker("RALPHINTAKE7F3A9B2C")).toEqual([{ number: 9, title: "Nine" }]);
  });

  it("reads a truncated blocker list over REST rather than trusting the page", async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[1] === "graphql") {
        return `HTTP/2.0 200 OK\n\n${JSON.stringify({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 3,
                    title: "Many blockers",
                    body: "",
                    author: null,
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                    blockedBy: { totalCount: 101, nodes: [{ number: 1, state: "OPEN" }] },
                  },
                ],
              },
            },
          },
        })}`;
      }
      return `HTTP/2.0 200 OK\n\n${JSON.stringify([{ number: 1, state: "open" }, { number: 2, state: "closed" }])}`;
    };
    const [issue] = await createGithubTracker({ repo: REPO, owner: "felipe", gh, read: gh }).openIssues();
    expect(issue!.blockers).toEqual([
      { number: 1, state: "open" },
      { number: 2, state: "closed" },
    ]);
    expect(calls[1]).toEqual(["api", "--include", `repos/${REPO}/issues/3/dependencies/blocked_by`, "--jq", "[.[] | {number, state}]"]);
  });

  it("classifies a GitHub secondary rate limit as throttling", () => {
    const tracker = createGithubTracker({ repo: REPO, owner: "felipe", gh: async () => "" });
    const error = new CommandError("gh: You have exceeded a secondary rate limit (HTTP 403)", "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 4870\n\n{}");
    expect(tracker.classifyFailure(error)).toEqual({ kind: "secondary", retryAfterSeconds: null });
    expect(tracker.classifyFailure(new Error("gh: Not Found (HTTP 404)"))).toBeNull();
  });
});

describe("missingIssueNumber", () => {
  it("reads the number from both of gh's wordings of a missing issue", () => {
    expect(missingIssueNumber("GraphQL: Could not resolve to an issue or pull request with the number of 999.")).toBe(999);
    expect(missingIssueNumber("gh failed: Could not resolve to an issue with the number of 42")).toBe(42);
  });

  it("is null for every other failure", () => {
    expect(missingIssueNumber("HTTP 401: Bad credentials")).toBeNull();
    expect(missingIssueNumber("API rate limit exceeded")).toBeNull();
    expect(missingIssueNumber("")).toBeNull();
  });
});
