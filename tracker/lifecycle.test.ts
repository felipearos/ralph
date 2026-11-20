/**
 * The lifecycle helpers on a project whose tickets live in Linear or Jira
 * (felipearos/ralph#334): which tracker they reach, the spec file the
 * executor's reviewer reads, and preflight's labels and states.
 */
import { writeFileSync, mkdirSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fetchFromTracker, renderSpec } from "../issue-spec";
import { checkTrackerLabels } from "../preflight";
import { currentProjectId } from "../project-id";
import { scratchDir } from "../test-scratch";
import { writeCredential } from "./credentials";
import { createFakeTracker } from "./fake";
import { keyedProjectTracker, projectTrackerConfig } from "./project";
import { TrackerUnavailableError } from "./types";

const FIXTURE = join(__dirname, "..", "fixtures", "loggd", ".ralph");

/** Loggd's `.ralph/` with coder loops only and `tracker` as its tracker block. */
function project(tracker?: object): string {
  const root = scratchDir("tracker-lifecycle-");
  cpSync(FIXTURE, join(root, ".ralph"), { recursive: true });
  const path = join(root, ".ralph", "config.json");
  // `sentinel` goes with the non-coder loops: loggd rosters senti and carries
  // the block since loggd#2909, and a block with no sentinel rostered is refused.
  const { ciDoctor, prMedic, sentinel, loops, ...rest } = JSON.parse(readFileSync(path, "utf8"));
  void ciDoctor;
  void prMedic;
  void sentinel;
  writeFileSync(path, JSON.stringify({ ...rest, loops: (loops as unknown[]).filter((loop) => typeof loop === "string"), ...(tracker ? { tracker } : {}) }));
  return root;
}

describe("the project's tracker, for the lifecycle helpers", () => {
  it("is GitHub's own path on a GitHub project and on a checkout with no config", () => {
    expect(keyedProjectTracker(project())).toBeNull();
    const bare = scratchDir("tracker-bare-");
    mkdirSync(join(bare, ".ralph"));
    expect(projectTrackerConfig(bare)).toBeNull();
    expect(keyedProjectTracker(bare)).toBeNull();
  });

  it("is the Linear adapter once connected, and not connected before", () => {
    const root = project({ kind: "linear", team: "AND", workspace: "acme" });
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = scratchDir("tracker-cfg-");
    try {
      expect(() => keyedProjectTracker(root)).toThrow(TrackerUnavailableError);
      writeCredential(currentProjectId(root), { kind: "linear", apiKey: "k" });
      expect(keyedProjectTracker(root)?.kind).toBe("linear");
    } finally {
      process.env.XDG_CONFIG_HOME = previous;
    }
  });

  it("is the local tracker with no credential, and preflight's labels check passes on it", async () => {
    const file = join(scratchDir("tracker-local-"), "tickets.json");
    const root = project({ kind: "local", key: "SBX", file });
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = scratchDir("tracker-cfg-");
    try {
      const tracker = keyedProjectTracker(root);
      expect(tracker?.kind).toBe("local");
      const result = await checkTrackerLabels(tracker!, ["ralph-wip", "ralph-done"], ["In Progress", "Done"]);
      expect(result.outcome).toMatchObject({ status: "ok" });
    } finally {
      process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe("the executor's spec file from a keyed tracker", () => {
  it("names the ticket as the tracker spells it, with its comments and authors", async () => {
    const tracker = createFakeTracker({
      kind: "linear",
      key: "AND",
      issues: [
        {
          number: 184,
          title: "Search module",
          body: "## Acceptance criteria\n\n- [ ] one",
          labels: ["ready-for-agent"],
          comments: [{ body: "### Operator decision\n\nShip it.", createdAt: "2026-10-20T00:00:00Z", author: "faros" }],
        },
      ],
    });
    const fetched = await fetchFromTracker(tracker, 184);
    expect(fetched.ok).toBe(true);
    const spec = renderSpec(fetched.ok ? fetched.issue : (null as never), "2026-10-20T12:00:00Z");
    expect(spec).toContain("# AND-184 — Search module");
    expect(spec).toContain("- URL: https://linear.app/fake/issue/AND-184");
    expect(spec).toContain("- State: OPEN (Todo)");
    expect(spec).toContain("- [ ] one");
    expect(spec).toContain("### 1. @faros — 2026-10-20T00:00:00Z");
    expect(spec).toContain("Ship it.");
  });

  it("reports an issue the tracker cannot read as a failed fetch", async () => {
    const fetched = await fetchFromTracker(createFakeTracker({ kind: "linear", key: "AND" }), 9);
    expect(fetched).toEqual({ ok: false, error: "no issue AND-9" });
  });
});

describe("preflight on a keyed tracker", () => {
  const labels = ["ralph-wip", "ralph-blocked", "ralph-done"];

  it("creates the loop's missing labels on Linear and says so", async () => {
    const tracker = createFakeTracker({ kind: "linear", key: "AND", labels: ["ralph-wip"] });
    const result = await checkTrackerLabels(tracker, labels, ["In Progress", "Done"]);
    expect(result.outcome).toEqual({ status: "ok", detail: "ralph-wip ralph-blocked ralph-done (created ralph-blocked, ralph-done)" });
    expect([...tracker.existingLabels].sort()).toEqual(labels.sort());
  });

  it("names a mapped workflow state the tracker does not have", async () => {
    const tracker = createFakeTracker({ kind: "jira", key: "OA", workflow: ["To Do", "Doing", "Done"] });
    const result = await checkTrackerLabels(tracker, labels, ["In Progress", "Done"]);
    expect(result.outcome).toMatchObject({
      status: "denied",
      why: "the jira tracker has no workflow state named 'In Progress' (it has To Do, Doing, Done)",
    });
  });

  it("refuses a tracker that is not connected, pointing at the dashboard", async () => {
    const result = await checkTrackerLabels(new TrackerUnavailableError("no credential at x", "not-connected"), labels, []);
    expect(result.outcome).toEqual({
      status: "denied",
      why: "no credential at x",
      remedy: "connect the project's tracker from the dashboard (Setup → Tracker)",
    });
  });

  it("is unavailable, not denied, when the tracker cannot be read", async () => {
    const tracker = createFakeTracker({ kind: "linear", key: "AND" });
    tracker.failNext("ensureLabels", new Error("socket hang up"));
    expect((await checkTrackerLabels(tracker, labels, [])).outcome).toMatchObject({ status: "unavailable" });
  });
});
