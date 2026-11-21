import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listStore } from "./park-store";

import { EXIT, main } from "./tracker";
import { createFakeTracker, type FakeTrackerOptions } from "./tracker/fake";
import { CommandError } from "./tracker/command";
import { createGithubTracker } from "./tracker/github";
import { TrackerUnavailableError } from "./tracker/types";
import { RateLimitedError } from "./frontier/github-rate-limit";
import type { RecordFields, SpeedKind } from "./speed";

function cli(options: FakeTrackerOptions = {}) {
  const tracker = createFakeTracker(options);
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    main(argv, {
      tracker: () => tracker,
      loop: () => "ralph",
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      readFile: (path) => (path === "body.md" ? "from a file\n" : ""),
    });
  return { tracker, out, err, run };
}

describe("tracker.ts", () => {
  it("views an issue with its labels and every comment", async () => {
    const { out, run } = cli({
      kind: "linear",
      key: "AND",
      issues: [{ number: 184, title: "Search module", body: "## What to build\n\nX", labels: ["ready-for-agent"], comments: [{ body: "blocked: waiting", createdAt: "2026-10-20T00:00:00Z" }] }],
    });
    expect(await run("view", "184")).toBe(EXIT.ok);
    expect(out).toEqual([
      "AND-184  Search module",
      "state: open (Todo)",
      "labels: ready-for-agent",
      "assignees: (none)",
      "author: (unknown)",
      "url: https://linear.app/fake/issue/AND-184",
      "",
      "## What to build\n\nX",
      "",
      "--- comments (1) ---",
      "[2026-10-20T00:00:00Z]",
      "blocked: waiting",
      "",
    ]);
  });

  it("views as JSON with the tracker's reference", async () => {
    const { out, run } = cli({ issues: [{ number: 7, title: "Seven" }] });
    expect(await run("view", "7", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!)).toMatchObject({ number: 7, ref: "#7", title: "Seven", state: "open" });
  });

  it("comments from --body or --body-file, never empty", async () => {
    const { tracker, run } = cli({ issues: [{ number: 7 }] });
    expect(await run("comment", "7", "--body", "Starting #7")).toBe(EXIT.ok);
    expect(await run("comment", "7", "--body-file", "body.md")).toBe(EXIT.ok);
    expect(tracker.issues.get(7)!.comments.map((c) => c.body)).toEqual(["Starting #7", "from a file\n"]);
    expect(await run("comment", "7", "--body", "  ")).toBe(EXIT.usage);
    expect(await run("comment", "7")).toBe(EXIT.usage);
  });

  it("adds and removes labels", async () => {
    const { tracker, run } = cli({ issues: [{ number: 7, labels: ["a"] }] });
    expect(await run("label", "add", "7", "b", "c")).toBe(EXIT.ok);
    expect(await run("label", "remove", "7", "a")).toBe(EXIT.ok);
    expect(tracker.issues.get(7)!.labels).toEqual(["b", "c"]);
  });

  it("lists this loop's open claims, one number per line, and nothing when it has none", async () => {
    const { out, run } = cli({
      issues: [
        { number: 3, labels: ["ralph-wip"] },
        { number: 4, labels: ["rafa-wip"] },
        { number: 5, labels: ["ralph-wip"], state: "closed" },
      ],
    });
    expect(await run("claimed")).toBe(EXIT.ok);
    expect(out).toEqual(["3"]);
    out.length = 0;
    expect(await run("claimed", "--loop", "rafa")).toBe(EXIT.ok);
    expect(out).toEqual(["4"]);
    out.length = 0;
    expect(await run("claimed", "--loop", "tria")).toBe(EXIT.ok);
    expect(out).toEqual([]);
  });

  it("finishes and parks with this loop's labels, and says where the ticket moved", async () => {
    const { tracker, out, run } = cli({ kind: "linear", key: "AND", issues: [{ number: 1, labels: ["ralph-wip"] }, { number: 2, labels: ["ralph-wip"] }] });
    expect(await run("done", "1")).toBe(EXIT.ok);
    expect(await run("blocked", "2")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-1 done, moved to Done", "AND-2 blocked"]);
    expect(tracker.issues.get(1)!.labels).toEqual(["ralph-done"]);
    expect(tracker.issues.get(2)!.labels).toEqual(["ralph-blocked"]);
  });

  it("hands a ticket to a person: open, off the queue, done on, in the review state when one is named", async () => {
    const { tracker, out, run } = cli({
      kind: "linear",
      key: "AND",
      states: { claimed: "In Progress", done: "Done", review: "For Review" },
      issues: [{ number: 1, labels: ["ralph-wip", "ready-for-agent", "acme-backoffice"] }],
    });
    expect(await run("handoff", "1")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-1 handoff, moved to For Review"]);
    const issue = tracker.issues.get(1)!;
    expect(issue.state).toBe("open");
    // `ready-for-agent` goes too: once a person merges, the open PR no longer
    // fences the ticket, and an open ticket still carrying it is READY NOW.
    expect(issue.labels.sort()).toEqual(["acme-backoffice", "ralph-done"]);
  });

  it("leaves a handed-off ticket's state alone when the project names no review state", async () => {
    const { tracker, out, err, run } = cli({ kind: "jira", key: "OAI", issues: [{ number: 32, labels: ["ralph-wip", "ready-for-agent"] }] });
    expect(await run("handoff", "32")).toBe(EXIT.ok);
    expect(out).toEqual(["OAI-32 handoff"]);
    expect(err).toEqual([]);
    expect(tracker.issues.get(32)!.labels).toEqual(["ralph-done"]);
    expect(tracker.issues.get(32)!.state).toBe("open");
  });

  it("warns, and still succeeds, when the state move fails", async () => {
    const { err, run } = cli({ kind: "jira", key: "OA", workflow: ["To Do"], issues: [{ number: 1 }] });
    expect(await run("done", "1")).toBe(EXIT.ok);
    expect(err).toEqual(["tracker: OA-1: no workflow state named 'Done'"]);
  });

  it("lists the open issues, one per line", async () => {
    const { out, run } = cli({ kind: "linear", key: "AND", issues: [{ number: 1, title: "One", labels: ["spec"] }, { number: 2, title: "Two", assignees: ["faros"] }, { number: 3, state: "closed" }] });
    expect(await run("list")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-2\tTwo\t[]  (faros)", "AND-1\tOne\t[spec]"]);
    out.length = 0;
    expect(await run("list", "--limit", "1")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-2\tTwo\t[]  (faros)"]);
  });

  it("lists only the open issues carrying every --label, by exact name", async () => {
    const { out, run } = cli({
      kind: "linear",
      key: "AND",
      issues: [
        { number: 1, title: "One", labels: ["ready-for-agent", "spec"] },
        { number: 2, title: "ready-for-agent in the title", labels: ["ready-for-agent-later"] },
        { number: 3, title: "Three", labels: ["ready-for-agent"], assignees: ["faros"] },
        { number: 4, title: "Four", labels: ["ready-for-agent"], state: "closed" },
      ],
    });
    expect(await run("list", "--label", "ready-for-agent")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-3\tThree\t[ready-for-agent]  (faros)", "AND-1\tOne\t[ready-for-agent, spec]"]);
    out.length = 0;
    expect(await run("list", "--label", "ready-for-agent", "--label", "spec")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-1\tOne\t[ready-for-agent, spec]"]);
    out.length = 0;
    expect(await run("list", "--label", "Ready-For-Agent")).toBe(EXIT.ok);
    expect(out).toEqual([]);
    expect(await run("list", "--label", "nobody-has-it")).toBe(EXIT.ok);
    expect(out).toEqual([]);
  });

  it("filters by --label before --limit, and narrows --json too", async () => {
    const { out, run } = cli({ kind: "linear", key: "AND", issues: [{ number: 1, title: "One", labels: ["x"] }, { number: 2, title: "Two", labels: ["y"] }] });
    expect(await run("list", "--limit", "1", "--label", "x")).toBe(EXIT.ok);
    expect(out).toEqual(["AND-1\tOne\t[x]"]);
    out.length = 0;
    expect(await run("list", "--json", "--label", "x")).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!)).toEqual([{ number: 1, title: "One", labels: [{ name: "x" }] }]);
  });

  it("refuses --label without a value, and never takes --json as one", async () => {
    const { out, run } = cli({ issues: [{ number: 1, labels: ["x"] }] });
    expect(await run("list", "--label")).toBe(EXIT.usage);
    expect(await run("list", "--label", "--json")).toBe(EXIT.usage);
    expect(out).toEqual([]);
  });

  it("lists the open issues as gh's JSON shape for the dashboard", async () => {
    const { out, run } = cli({ kind: "linear", key: "AND", issues: [{ number: 1, title: "One", labels: ["ralph-wip"] }] });
    expect(await run("list", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!)).toEqual([{ number: 1, title: "One", labels: [{ name: "ralph-wip" }] }]);
  });

  it("gives the PR line for the ticket: Closes on GitHub, the key and link elsewhere", async () => {
    const github = cli();
    await github.run("pr-ref", "184");
    expect(github.out).toEqual(["Closes #184"]);
    const linear = cli({ kind: "linear", key: "AND" });
    await linear.run("pr-ref", "184");
    expect(linear.out).toEqual(["Ticket: AND-184 https://linear.app/fake/issue/AND-184"]);
  });

  it("prints references and links", async () => {
    const { out, run } = cli({ kind: "jira", key: "OA" });
    await run("ref", "410");
    await run("url", "410");
    expect(out).toEqual(["OA-410", "https://fake.atlassian.net/browse/OA-410"]);
  });

  it("refuses bad usage with status 2", async () => {
    const { run, err } = cli();
    expect(await run()).toBe(EXIT.usage);
    expect(await run("frobnicate")).toBe(EXIT.usage);
    expect(await run("view", "abc")).toBe(EXIT.usage);
    expect(await run("view", "1", "2")).toBe(EXIT.usage);
    expect(await run("label", "toggle", "1", "x")).toBe(EXIT.usage);
    expect(err.at(-1)).toMatch(/usage:/);
  });

  it("exits 69 when the tracker is not connected, 75 when throttled, 1 otherwise", async () => {
    const unavailable = await main(["claimed"], {
      tracker: () => {
        throw new TrackerUnavailableError("no credential", "not-connected");
      },
      loop: () => "ralph",
      err: () => {},
    });
    expect(unavailable).toBe(EXIT.unavailable);

    const { tracker, run } = cli({ issues: [{ number: 1 }] });
    tracker.failNext("withLabel", new RateLimitedError("quota", 60, "fake"));
    expect(await run("claimed")).toBe(EXIT.throttled);
    expect(await run("view", "99")).toBe(EXIT.failed);
  });
});

describe("tracker.ts on a missing issue (#18)", () => {
  /** The CLI over the real GitHub adapter, its gh stubbed to fail every call with `failure`. */
  const failingGithub = async (argv: string[], failure: Error) => {
    const stub = async (): Promise<string> => {
      throw failure;
    };
    const tracker = createGithubTracker({ repo: "acme/widgets", owner: "felipe", gh: stub, read: stub });
    const err: string[] = [];
    const code = await main(argv, { tracker: () => tracker, loop: () => "ralph", out: () => {}, err: (line) => err.push(line) });
    return { code, err };
  };
  const missing = (number: number) =>
    new CommandError(
      `gh issue view ${number} --repo acme/widgets --json number,title failed: GraphQL: Could not resolve to an issue or pull request with the number of ${number}.`,
      "",
    );

  it("says the issue does not exist instead of gh's GraphQL text, and exits 1", async () => {
    const { code, err } = await failingGithub(["view", "999"], missing(999));
    expect(code).toBe(EXIT.failed);
    expect(err).toEqual(["tracker: no issue #999 in acme/widgets"]);
  });

  it("names a missing issue on writes too", async () => {
    for (const argv of [["comment", "999", "--body", "hi"], ["label", "add", "999", "ralph-wip"], ["label", "remove", "999", "ralph-wip"]]) {
      const { code, err } = await failingGithub(argv, missing(999));
      expect(code).toBe(EXIT.failed);
      expect(err).toEqual(["tracker: no issue #999 in acme/widgets"]);
    }
  });

  it("keeps any other failure's own message, and exits 1", async () => {
    const { code, err } = await failingGithub(["view", "999"], new CommandError("gh issue view 999 failed: HTTP 401: Bad credentials", ""));
    expect(code).toBe(EXIT.failed);
    expect(err).toEqual(["tracker: gh issue view 999 failed: HTTP 401: Bad credentials"]);
  });

  it("never reads a quoted phrase in the argv as gh's answer", async () => {
    // `run` puts the whole argv in the message: a comment quoting the phrase
    // that fails for another reason must keep that reason.
    const quoted = "GraphQL: Could not resolve to an issue or pull request with the number of 4021.";
    const failure = new CommandError(`gh issue comment 17 --repo acme/widgets --body ${quoted} failed: HTTP 502: Bad Gateway`, "");
    const { code, err } = await failingGithub(["comment", "17", "--body", quoted], failure);
    expect(code).toBe(EXIT.failed);
    expect(err).toEqual([`tracker: ${failure.message}`]);
  });

  it("names nothing when gh's missing number is not the issue asked for", async () => {
    const { code, err } = await failingGithub(["view", "17"], missing(999));
    expect(code).toBe(EXIT.failed);
    expect(err[0]).not.toContain("no issue");
  });

  it("keeps a throttle a throttle: exit 75", async () => {
    const { code } = await failingGithub(["view", "999"], new RateLimitedError("quota", 60, "gh"));
    expect(code).toBe(EXIT.throttled);
  });
});

describe("tracker.ts create (#14)", () => {
  it("opens one issue with the title, body and labels, and prints its ref and url", async () => {
    const { tracker, out, run } = cli({ issues: [{ number: 11 }] });
    expect(await run("create", "--title", "T", "--body-file", "body.md", "--label", "a", "--label", "b")).toBe(EXIT.ok);
    expect(tracker.issues.size).toBe(2);
    const created = tracker.issues.get(12)!;
    expect(created).toMatchObject({ title: "T", body: "from a file\n", labels: ["a", "b"] });
    expect(out).toEqual(["#12\thttps://github.com/fake/repo/issues/12"]);
  });

  it("asks for a repeated label once", async () => {
    const { tracker, run } = cli();
    expect(await run("create", "--title", "T", "--body", "x", "--label", "a", "--label", "a")).toBe(EXIT.ok);
    expect([...tracker.issues.values()][0]!.labels).toEqual(["a"]);
  });

  it("opens nothing when a label cannot be created, and names it", async () => {
    const { tracker, err, run } = cli({ issues: [{ number: 1 }], uncreatableLabels: ["nope"] });
    expect(await run("create", "--title", "T", "--body", "x", "--label", "ok", "--label", "nope")).toBe(EXIT.failed);
    expect(err.join("\n")).toContain("nope");
    expect(tracker.issues.size).toBe(1);
    expect(tracker.writes.filter((w) => w.startsWith("create"))).toEqual([]);
  });

  it("refuses bad usage with status 2 before touching the tracker", async () => {
    const tracker = createFakeTracker({ issues: [{ number: 1 }] });
    let built = 0;
    const run = (...argv: string[]) =>
      main(argv, {
        tracker: () => {
          built += 1;
          return tracker;
        },
        out: () => {},
        err: () => {},
        readFile: (path) => (path === "body.md" ? "from a file\n" : "  \n"),
      });
    expect(await run("create", "--body", "x")).toBe(EXIT.usage);
    expect(await run("create", "--title", "   ", "--body", "x")).toBe(EXIT.usage);
    expect(await run("create", "--title", "T", "--body", "  ")).toBe(EXIT.usage);
    expect(await run("create", "--title", "T", "--body-file", "empty.md")).toBe(EXIT.usage);
    expect(await run("create", "--title", "T", "--body", "x", "--body-file", "body.md")).toBe(EXIT.usage);
    expect(await run("create", "--title", "T")).toBe(EXIT.usage);
    expect(await run("create", "7", "--title", "T", "--body", "x")).toBe(EXIT.usage);
    expect(await run("create", "--title", "T", "--body", "x", "--label", "a,b")).toBe(EXIT.usage);
    expect(built).toBe(0);
    expect(tracker.writes).toEqual([]);
    expect(tracker.issues.size).toBe(1);
  });

  it("prints the state-move warning and still succeeds", async () => {
    const { tracker, out, err, run } = cli();
    tracker.create = async () => ({ number: 9, url: "https://github.com/fake/repo/issues/9", movedTo: null, warning: "no workflow state named 'X'" });
    expect(await run("create", "--title", "T", "--body", "x")).toBe(EXIT.ok);
    expect(out).toEqual(["#9\thttps://github.com/fake/repo/issues/9"]);
    expect(err).toEqual(["tracker: #9: no workflow state named 'X'"]);
  });
});

describe("tracker.ts speed ledger", () => {
  function speedCli(speed: (kind: SpeedKind, fields: RecordFields) => void) {
    const tracker = createFakeTracker({ issues: [{ number: 1, labels: ["ralph-wip"] }, { number: 2, labels: ["ralph-wip"] }, { number: 3, labels: ["ralph-wip", "other"] }] });
    const run = (...argv: string[]) =>
      main(argv, { tracker: () => tracker, loop: () => "ralph", out: () => {}, err: () => {}, speed });
    return { tracker, run };
  }

  it("records merged, handed-off, blocked and released after the tracker write", async () => {
    const recorded: Array<[SpeedKind, RecordFields]> = [];
    const { run } = speedCli((kind, fields) => recorded.push([kind, fields]));
    expect(await run("done", "1", "--pr", "https://github.com/x/y/pull/9")).toBe(EXIT.ok);
    expect(await run("handoff", "2")).toBe(EXIT.ok);
    expect(await run("blocked", "3")).toBe(EXIT.ok);
    expect(recorded).toEqual([
      ["merged", { ticket: "1", pr: "https://github.com/x/y/pull/9" }],
      ["handed-off", { ticket: "2", pr: null }],
      ["blocked", { ticket: "3" }],
    ]);

    recorded.length = 0;
    expect(await run("label", "remove", "3", "other")).toBe(EXIT.ok);
    expect(await run("label", "add", "3", "ralph-wip")).toBe(EXIT.ok);
    expect(await run("label", "remove", "3", "rafa-wip")).toBe(EXIT.ok);
    expect(recorded).toEqual([]);
    expect(await run("label", "remove", "3", "ralph-wip")).toBe(EXIT.ok);
    expect(recorded).toEqual([["released", { ticket: "3" }]]);
  });

  it("records nothing when the tracker write fails, or on a usage error", async () => {
    const recorded: SpeedKind[] = [];
    const { tracker, run } = speedCli((kind) => recorded.push(kind));
    tracker.failNext("done", new Error("boom"));
    expect(await run("done", "1", "--pr", "u")).toBe(EXIT.failed);
    tracker.failNext("removeLabels", new Error("boom"));
    expect(await run("label", "remove", "2", "ralph-wip")).toBe(EXIT.failed);
    expect(await run("blocked", "3", "--pr", "u")).toBe(EXIT.usage);
    expect(await run("done", "1", "2", "--pr", "u")).toBe(EXIT.usage);
    expect(recorded).toEqual([]);
  });

  it("hands off with no PR when --pr comes with no value, rather than refusing the write", async () => {
    const recorded: Array<[SpeedKind, RecordFields]> = [];
    const { run } = speedCli((kind, fields) => recorded.push([kind, fields]));
    expect(await run("handoff", "2", "--pr")).toBe(EXIT.ok);
    expect(recorded).toEqual([["handed-off", { ticket: "2", pr: null }]]);
  });

  it("a throwing recorder does not change the exit code", async () => {
    const { tracker, run } = speedCli(() => {
      throw new Error("ledger exploded");
    });
    expect(await run("done", "1", "--pr", "u")).toBe(EXIT.ok);
    expect(await run("label", "remove", "2", "ralph-wip")).toBe(EXIT.ok);
    expect(tracker.issues.get(1)!.state).toBe("closed");
  });
});

describe("tracker.ts blocked park hand-off (#776)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tracker-block-park-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function blockedCli() {
    const tracker = createFakeTracker({ issues: [{ number: 3, labels: ["ralph-wip"] }] });
    const recorded: SpeedKind[] = [];
    const pushed: string[][] = [];
    const err: string[] = [];
    const file = join(dir, "block-park.json");
    const storePath = join(dir, "ralph-parks.json");
    const run = (...argv: string[]) =>
      main(argv, {
        tracker: () => tracker,
        loop: () => "ralph",
        out: () => {},
        err: (line) => err.push(line),
        speed: (kind) => recorded.push(kind),
        blockPark: () => ({ file, storePath, now: () => "2026-11-11T10:00:00.000Z", push: (argv) => pushed.push(argv), env: {} }),
      });
    writeFileSync(file, JSON.stringify({ ticket: 3, condition: { kind: "reference", ref: "#2" }, summary: "waiting for #2" }));
    return { tracker, recorded, pushed, err, file, storePath, run };
  }

  it("swaps the labels, records the speed event, then parks the ticket", async () => {
    const { tracker, recorded, pushed, file, storePath, run } = blockedCli();
    expect(await run("blocked", "3")).toBe(EXIT.ok);
    expect(tracker.issues.get(3)!.labels).toEqual(["ralph-blocked"]);
    expect(recorded).toEqual(["blocked"]);
    expect(listStore(storePath)).toMatchObject([{ ticket: 3, label: "ralph-blocked", condition: { kind: "reference", ref: "#2" } }]);
    expect(existsSync(file)).toBe(false);
    expect(pushed).toEqual([]);
  });

  it("blocks exactly as today when the session wrote no hand-off", async () => {
    const { tracker, recorded, pushed, file, storePath, run } = blockedCli();
    rmSync(file);
    expect(await run("blocked", "3")).toBe(EXIT.ok);
    expect(tracker.issues.get(3)!.labels).toEqual(["ralph-blocked"]);
    expect(recorded).toEqual(["blocked"]);
    expect(listStore(storePath)).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("blocks, parks nothing and pages high when the hand-off is malformed", async () => {
    const { tracker, recorded, pushed, file, storePath, run } = blockedCli();
    writeFileSync(file, "{not json");
    expect(await run("blocked", "3")).toBe(EXIT.ok);
    expect(tracker.issues.get(3)!.labels).toEqual(["ralph-blocked"]);
    expect(recorded).toEqual(["blocked"]);
    expect(listStore(storePath)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("high");
  });

  it("still blocks and exits 0 when the park cannot be written, pushing high", async () => {
    const { tracker, recorded, pushed, err, storePath, run } = blockedCli();
    writeFileSync(storePath, JSON.stringify({ version: 2 }));
    expect(await run("blocked", "3")).toBe(EXIT.ok);
    expect(tracker.issues.get(3)!.labels).toEqual(["ralph-blocked"]);
    expect(recorded).toEqual(["blocked"]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("high");
    expect(err.some((line) => line.includes("could not be parked"))).toBe(true);
  });
});
